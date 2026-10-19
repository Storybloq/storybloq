import {
  readdir,
  readFile,
  writeFile,
  rename,
  unlink,
  link,
  stat,
  realpath,
  lstat,
  open,
  mkdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, constants as fsConstants } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve, relative, extname, dirname, basename, sep, isAbsolute } from "node:path";
import { recordBoardTarget } from "./board-write-recorder.js";
import { syncDir } from "./durable-dir.js";
import { acquireProjectLockAsync, releaseProjectLock, verifyProjectLockOwnership, type ProjectLockHandle } from "./project-lock.js";
import { TicketSchema, type Ticket } from "../models/ticket.js";
import { IssueSchema, type Issue } from "../models/issue.js";
import { NoteSchema, type Note } from "../models/note.js";
import { LessonSchema, type Lesson } from "../models/lesson.js";
import { RoadmapSchema, type Roadmap } from "../models/roadmap.js";
import { ConfigSchema, type Config } from "../models/config.js";
import { validateOrchestratorOverlay } from "../models/federation-config.js";
import {
  TICKET_ID_REGEX, TICKET_CANONICAL_ID_REGEX,
  ISSUE_ID_REGEX, ISSUE_CANONICAL_ID_REGEX,
  NOTE_ID_REGEX, NOTE_CANONICAL_ID_REGEX,
  LESSON_ID_REGEX, LESSON_CANONICAL_ID_REGEX,
  CROCKFORD_CLASS,
  DateSchema,
} from "../models/types.js";
import { ProjectState } from "./project-state.js";
import type { PreparedContentValidation } from "./update-write-hooks.js";
import { localDateOf } from "./local-date.js";
import { touchUpdated } from "./metadata-touch.js";
import {
  ProjectLoaderError,
  MAX_SUPPORTED_SCHEMA_VERSION,
  INTEGRITY_WARNING_TYPES,
  type LoadWarning,
  type LoadWarningType,
} from "./errors.js";
import { listHandovers } from "./handover-parser.js";
import { assertTeamWriteCapabilities, isTeamModeConfig } from "./team-capabilities.js";
import { validateProject } from "./validation.js";
import { assertCheckpointWriteAllowed, priorForGuard, type CheckpointWriteAuthority } from "./checkpoint-guard.js";
import { assertVerificationWriteAllowed, type VerificationWriteAuthority } from "./setup-verification-guard.js";
import { hasOwnerCheckpoint } from "./owner-checkpoint.js";
import { applyTicketIdentityPolicy, type TicketIdentityReport } from "./ticket-counts.js";
import { assertResolutionMetadataWrite, assertTicketResolutionWrite, createResolutionWriteContext, ResolutionWriteContextError, type ResolutionWriteContext } from "./resolution-write-guard.js";
import { assertWithdrawable } from "./ticket-withdrawal.js";
import type { ZodType } from "zod";

// --- Public Types ---

export interface LoadOptions {
  /** In strict mode, integrity warnings become thrown errors. Default: false */
  strict?: boolean;
  /** Maximum schemaVersion this loader supports. Default: MAX_SUPPORTED_SCHEMA_VERSION */
  maxSchemaVersion?: number;
}

export interface DeleteOptions {
  hard?: boolean;
  actor?: string;
  force?: boolean;
}

/**
 * ISS-757: result of a delete operation. In team mode a delete of an
 * already-tombstoned item is a silent success: `alreadyDeleted: true`, no
 * write occurs, and the original deletedAt/deletedBy are preserved. A fresh
 * tombstone write (team) or a physical unlink (non-team) returns
 * `alreadyDeleted: false`.
 */
export interface DeleteResult {
  alreadyDeleted: boolean;
}

export interface LoadResult {
  readonly state: ProjectState;
  readonly warnings: readonly LoadWarning[];
  readonly fileClassifications: ReadonlyMap<string, "legacy" | "team">;
}

// --- Read Operations ---

/**
 * Loads all .story/ data and assembles a ProjectState.
 * Critical files (config, roadmap) throw on failure.
 * Best-effort files (tickets, issues) skip corrupt entries with warnings.
 */
/**
 * T-486 U2-3: a ticket file the loader left out, with whatever identity the
 * raw JSON exposed (B1). `read` is an unreadable file, `parse` invalid JSON,
 * `schema` a record the ticket schema refused.
 */
export interface OmittedTicketRecord {
  readonly file: string;
  readonly reason: "read" | "parse" | "schema";
  readonly id?: string;
  readonly parentTicket?: string;
  /**
   * T-486 U2-4 (B1): "root" when the parsed record has no parent (absent or
   * null), "ref" when parentTicket is a string (carried in `parentTicket`),
   * "unknown" when the file could not be read or parsed or parentTicket is
   * malformed, so the record could sit under any ticket.
   */
  readonly parentage: "root" | "ref" | "unknown";
}

export interface TicketRecords {
  /** Accepted records, loader defaults applied, in sorted filename order. */
  readonly records: readonly Ticket[];
  /** `files[i]` is the project-relative file `records[i]` was read from. */
  readonly files: readonly string[];
  readonly omitted: readonly OmittedTicketRecord[];
  readonly warnings: readonly LoadWarning[];
  /** The identity policy over `records` (ticket-counts.ts, B3). */
  readonly identity: TicketIdentityReport;
}

/**
 * T-486 U2-3: the ticket records exactly as `loadProject` accepts them (the
 * same `loadDirectory`, so the same parse, defaults and warnings), for a
 * reader that needs tickets alone, such as the federation scanner. `signal`
 * is checked before each file, so an abort stops the scan between files.
 */
export async function loadTicketRecords(
  storyDir: string,
  options: { signal?: AbortSignal } = {},
): Promise<TicketRecords> {
  const absStory = resolve(storyDir);
  const warnings: LoadWarning[] = [];
  const files: string[] = [];
  const omitted: OmittedTicketRecord[] = [];
  const records = await loadDirectory<Ticket>(
    join(absStory, "tickets"),
    dirname(absStory),
    TicketSchema,
    warnings,
    "ticket",
    new Map(),
    { signal: options.signal, files, omitted },
  );
  return { records, files, omitted, warnings, identity: applyTicketIdentityPolicy(records, files) };
}

export async function loadProject(
  root: string,
  options?: LoadOptions,
): Promise<LoadResult> {
  const absRoot = resolve(root);
  const wrapDir = join(absRoot, ".story");

  // 1. Check .story/ exists and is a directory
  try {
    const wrapStat = await stat(wrapDir);
    if (!wrapStat.isDirectory()) {
      throw new ProjectLoaderError(
        "not_found",
        "Missing .story/ directory.",
      );
    }
  } catch (err) {
    if (err instanceof ProjectLoaderError) throw err;
    throw new ProjectLoaderError(
      "not_found",
      "Missing .story/ directory.",
    );
  }

  // 2. Recover any incomplete transaction (under lock). ISS-942 942.1:
  // existsSync fails OPEN on any stat error (permissions, transient I/O), not
  // just ENOENT -- a non-ENOENT failure here would silently read as "no
  // journal" and skip recovery, permanently orphaning a pending transaction
  // until something else happens to notice. Probe explicitly and fail closed.
  let journalPresent: boolean;
  try {
    await stat(join(wrapDir, ".txn.json"));
    journalPresent = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      journalPresent = false;
    } else {
      throw new ProjectLoaderError(
        "io_error",
        "Failed to probe transaction journal presence; refusing to silently skip recovery",
        err,
      );
    }
  }
  if (journalPresent) {
    await withLock(wrapDir, () => doRecoverTransaction(wrapDir));
  }

  // 3. Load config.json (critical)
  await refuseWhileSetupBootstrapping(wrapDir);
  const config = await loadSingletonFile<Config>(
    "config.json",
    wrapDir,
    absRoot,
    ConfigSchema,
  );

  // 4. Check schemaVersion
  const maxVersion = options?.maxSchemaVersion ?? MAX_SUPPORTED_SCHEMA_VERSION;
  if (
    config.schemaVersion !== undefined &&
    config.schemaVersion > maxVersion
  ) {
    throw new ProjectLoaderError(
      "version_mismatch",
      `Config schemaVersion ${config.schemaVersion} exceeds max supported ${maxVersion}. Run: npm update -g @storybloq/storybloq`,
    );
  }

  // 5. Load roadmap.json (critical)
  const roadmap = await loadSingletonFile<Roadmap>(
    "roadmap.json",
    wrapDir,
    absRoot,
    RoadmapSchema,
  );

  // 5b. Validate orchestrator overlay (non-fatal)
  const warnings: LoadWarning[] = [];
  if (
    config.type === "orchestrator" &&
    config.nodes &&
    typeof config.nodes === "object" &&
    Object.keys(config.nodes).length > 0
  ) {
    const overlay = validateOrchestratorOverlay(config as Record<string, unknown>);
    for (const w of overlay.warnings) {
      warnings.push({ type: "schema_error" as LoadWarningType, file: "config.json", message: w });
    }
    for (const e of overlay.errors) {
      warnings.push({ type: "schema_error" as LoadWarningType, file: "config.json", message: e });
    }
  }

  // 6. Load tickets (best-effort)
  const fileClassifications = new Map<string, "legacy" | "team">();
  const omittedTickets: OmittedTicketRecord[] = [];
  const tickets = await loadDirectory<Ticket>(
    join(wrapDir, "tickets"),
    absRoot,
    TicketSchema,
    warnings,
    "ticket",
    fileClassifications,
    { omitted: omittedTickets },
  );

  // 7. Load issues (best-effort)
  const issues = await loadDirectory<Issue>(
    join(wrapDir, "issues"),
    absRoot,
    IssueSchema,
    warnings,
    "issue",
    fileClassifications,
  );

  // 7b. Load notes (best-effort)
  const notes = await loadDirectory<Note>(
    join(wrapDir, "notes"),
    absRoot,
    NoteSchema,
    warnings,
    "note",
    fileClassifications,
  );

  // 7c. Load lessons (best-effort -- empty array if directory absent)
  const lessons = await loadDirectory<Lesson>(
    join(wrapDir, "lessons"),
    absRoot,
    LessonSchema,
    warnings,
    "lesson",
    fileClassifications,
  );

  // 8. List handovers
  const handoversDir = join(wrapDir, "handovers");
  const handoverFilenames = await listHandovers(
    handoversDir,
    absRoot,
    warnings,
  );

  // 9. Strict mode: fail on integrity warnings
  if (options?.strict) {
    const integrityWarning = warnings.find((w) =>
      (INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type),
    );
    if (integrityWarning) {
      throw new ProjectLoaderError(
        "project_corrupt",
        `Strict mode: ${integrityWarning.file}: ${integrityWarning.message}`,
      );
    }
  }

  // 10. Construct ProjectState
  const state = new ProjectState({
    tickets,
    issues,
    notes,
    lessons,
    roadmap,
    config,
    handoverFilenames,
    omittedTickets,
  });

  // 11. ISS-730: opt-in continuous cross-reference integrity check. When
  // config.validateOnLoad is true, run the full validateProject pass and feed
  // its ERROR-level findings (dangling parentTicket/blockedBy/relatedTickets/
  // supersedes, cycles, duplicate ids, unresolved conflicts) into the load
  // warning stream as advisory "cross_reference" warnings. This is defense in
  // depth, NOT a hard gate: cross_reference is not an integrity type, so it
  // never trips strict mode (step 9) and never blocks a read -- it only catches
  // externally-introduced corruption earlier than an explicit `storybloq
  // validate`. Off by default to keep loads cheap and to avoid bricking reads on
  // a pre-existing dangling ref. The check is only as strong as validateProject
  // (see ISS-042: lesson-supersedes cycle coverage).
  if (config.validateOnLoad === true) {
    const validation = validateProject(state);
    for (const f of validation.findings) {
      if (f.level !== "error") continue;
      warnings.push({
        type: "cross_reference",
        file: f.entity ?? ".story",
        message: `[${f.code}] ${f.message}`,
      });
    }
  }

  return { state, warnings, fileClassifications };
}

// --- Write Operations ---

/**
 * Writes a ticket file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 * Performs Zod parse + guardPath + atomicWrite.
 */
/**
 * Validates a ticket and resolves where it goes, WITHOUT writing anything.
 *
 * T-494: `runTransactionUnlocked` takes `{ target, content }` and carries none
 * of a writer's invariants -- no schema parse, no id check, no `guardPath`. So
 * a caller that writes items through the transaction has to run them itself,
 * and the only way that cannot drift from the writer is for the writer to call
 * the same function. `writeTicketUnlocked` below is now exactly this plus the
 * write.
 *
 * The target path comes from `parsed.id`, never from a display id: this ledger
 * is permanently mixed, so a legacy item's `id` IS `T-001` while a
 * post-migration item's `id` is the hash and its display id lives in a separate
 * field. Re-deriving a filename from a display id writes a second, dark file.
 *
 * T-537: this is also the owner-checkpoint write guard. It reads the file
 * being replaced and refuses a checkpoint or evidence change the caller holds
 * no authority for (core/checkpoint-guard.ts). The caller holds the project
 * lock, so what it reads is what the write replaces.
 *
 * T-486 U2: also the withdrawal write boundary (core/resolution-write-guard.ts,
 * `assertTicketResolutionWrite`), on the same prior record and the lock
 * holder's context, with a token recorded for exactly the bytes returned.
 */
/**
 * T-481: whether a ticket or issue write stamps `updatedDate`. `true` (the
 * default) stamps today's local date when the content changed; `false` never
 * stamps; `{ date }` stamps that recorded date when the content changed, for
 * a write whose postimage was fingerprinted before it landed (the issue pick
 * and the sweep steps), so the bytes written are the bytes fingerprinted.
 */
export type TouchOption = boolean | { date: string };

/** The date a write stamps with, or null for none. A recorded date must be a real calendar date. */
function touchDate(touch: TouchOption | undefined): string | null {
  if (touch === false) return null;
  if (touch === undefined || touch === true) return localDateOf(new Date());
  if (!DateSchema.safeParse(touch.date).success) {
    throw new ProjectLoaderError("invalid_input", `Refusing the write: recorded date ${JSON.stringify(touch.date)} is not a YYYY-MM-DD calendar date`);
  }
  return touch.date;
}

/**
 * The file a ticket is read from and written to: its `id` names the file in
 * both ledger forms (`T-001.json`, or `t-<hash>.json` with the display id inside).
 */
export function ticketFilePath(root: string, id: string): string {
  return join(resolve(root, ".story"), "tickets", `${id}.json`);
}

/** The issue counterpart of `ticketFilePath`: `ISS-001.json` or `i-<hash>.json`. */
export function issueFilePath(root: string, id: string): string {
  return join(resolve(root, ".story"), "issues", `${id}.json`);
}

/**
 * ISS-1396: the `filename_id_mismatch` warning text, exported so a reader
 * that matches it (FINALIZE's misplaced-record guard) matches these bytes.
 */
export function filenameIdMismatchMessage(stem: string, id: string): string {
  return `Filename stem "${stem}" does not match content id "${id}"`;
}

export async function prepareTicketWrite(
  ticket: Ticket,
  root: string,
  options?: { authority?: CheckpointWriteAuthority; verificationAuthority?: VerificationWriteAuthority; resolutionContext?: ResolutionWriteContext; touch?: TouchOption },
): Promise<{ target: string; content: string }> {
  const date = touchDate(options?.touch);
  const unstamped = TicketSchema.parse(ticket);
  if (!TICKET_ID_REGEX.test(unstamped.id) && !TICKET_CANONICAL_ID_REGEX.test(unstamped.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid ticket ID: ${unstamped.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const target = ticketFilePath(root, unstamped.id);
  await ensureEntityDir(target, wrapDir);
  const prior = priorForGuard(await prepareTicketWriteSeams.readPrior(target), `tickets/${unstamped.id}.json`);
  const parsed = date === null ? unstamped : touchUpdated(unstamped, prior, date);
  assertCheckpointWriteAllowed(prior, parsed, options?.authority);
  assertVerificationWriteAllowed(prior, parsed, options?.verificationAuthority);
  // As for issues (Codex F1): nothing awaits between obtaining the context
  // and the decision.
  const ctx = heldResolutionContext(root, options?.resolutionContext);
  const content = serializeJSON(parsed);
  const decision = assertTicketResolutionWrite(ctx, `.story/tickets/${parsed.id}.json`, prior ?? {}, parsed);
  ctx.recordPrepared(target, content, decision.dependsOnBoard, decision.withdrawalGated);
  return { target, content };
}

/** Test seam: how `prepareTicketWrite` reads the record a write replaces. */
export const prepareTicketWriteSeams: { readPrior: (path: string) => Promise<string | null> } = {
  readPrior: (path) => readIfExists(path),
};

/**
 * Test seams (ISS-1297): what runs between the containment check and the
 * mkdir of a ticket or issue directory, and the mkdir itself.
 */
export const entityDirSeams: {
  afterGuard: (dir: string) => Promise<void>;
  mkdir: (dir: string, options: { recursive: true }) => Promise<unknown>;
} = {
  afterGuard: async () => {},
  mkdir,
};

/**
 * ISS-1297: makes a ticket or issue directory that a fresh clone lacks (git
 * keeps no empty directory) between two containment checks. The second check
 * runs on the now-existing directory, so a symlink swapped in before the
 * mkdir is refused. This holds for a stable filesystem topology: a swap after
 * the second check is still followed (no handle-relative writes).
 */
async function ensureEntityDir(target: string, wrapDir: string): Promise<void> {
  await guardPath(target, wrapDir);
  const dir = dirname(target);
  await entityDirSeams.afterGuard(dir);
  try {
    await entityDirSeams.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new ProjectLoaderError(
      "io_error",
      `Cannot create the directory ${dir} for ${basename(target)}`,
      err,
    );
  }
  await guardPath(target, wrapDir);
}

/** Test seam (T-486 Codex F1): how `prepareIssueWrite` reads the record a write replaces. */
export const prepareIssueWriteSeams: { readPrior: (path: string) => Promise<string | null> } = {
  readPrior: (path) => readIfExists(path),
};

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProjectLoaderError("io_error", `Cannot read ${path} to check the write`, err);
  }
}

export async function writeTicketUnlocked(
  ticket: Ticket,
  root: string,
  options?: { createOnly?: boolean; authority?: CheckpointWriteAuthority; touch?: TouchOption } & PreparedContentValidation,
): Promise<void> {
  const { target, content } = await prepareTicketWrite(ticket, root, { authority: options?.authority, touch: options?.touch });
  assertPreparedWritesCurrent(root, [{ target, content }]);
  await assertWithdrawalLedgerCurrent(root, [{ op: "write", target, content }]);
  await options?.validatePreparedContent?.(content);
  if (options?.createOnly) {
    await atomicCreate(target, content);
  } else {
    await atomicWrite(target, content);
  }
}

export async function writeTicket(
  ticket: Ticket,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);
    await writeTicketUnlocked(ticket, root);
  });
}

/**
 * Writes an issue file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 */
/**
 * Issue counterpart of `prepareTicketWrite`; same T-494 rationale.
 *
 * T-486 2c: also the resolution-metadata write boundary. It reads the file
 * being replaced and refuses a kind or evidence write the board cannot carry
 * (core/resolution-write-guard.ts), using the lock holder's context.
 */
export async function prepareIssueWrite(
  issue: Issue,
  root: string,
  options?: { resolutionContext?: ResolutionWriteContext; touch?: TouchOption },
): Promise<{ target: string; content: string }> {
  const date = touchDate(options?.touch);
  const unstamped = IssueSchema.parse(issue);
  if (!ISSUE_ID_REGEX.test(unstamped.id) && !ISSUE_CANONICAL_ID_REGEX.test(unstamped.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid issue ID: ${unstamped.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const target = issueFilePath(root, unstamped.id);
  await ensureEntityDir(target, wrapDir);
  // Codex F1: the read comes first, and nothing awaits between obtaining the
  // context and the decision, so the lock cannot be released in between.
  const priorText = await prepareIssueWriteSeams.readPrior(target);
  const prior = priorRecord(priorText);
  // An unparseable prior is replaced, which is a content change.
  const parsed = date === null || priorText === null
    ? unstamped
    : touchUpdated(unstamped, prior === "unknown" ? {} : prior, date);
  const ctx = heldResolutionContext(root, options?.resolutionContext);
  const content = serializeJSON(parsed);
  ctx.recordPrepared(target, content, assertResolutionMetadataWrite(ctx, `.story/issues/${parsed.id}.json`, prior, parsed));
  return { target, content };
}

/**
 * T-486 Codex F2: the boundary for a writer that commits issue bytes it built
 * itself rather than through `prepareIssueWrite`: reconcile (display id and
 * rank renames) and repair (stale-reference patches) edit the raw on-disk
 * JSON, and ledger restore writes a recorded blob byte for byte. Each runs the
 * same resolution-metadata check against the record it replaces and records a
 * token for exactly `content`, so the commit check covers it like any other.
 * Needs the project lock's context, as `prepareIssueWrite` does.
 */
export function authoriseIssueBytes(
  root: string,
  target: string,
  prior: Readonly<Record<string, unknown>> | "unknown",
  content: string,
): void {
  // Codex H2: the check runs on the record these bytes ARE, never on a
  // record the caller describes them as.
  const record = priorRecord(content);
  if (record === "unknown") {
    throw new ProjectLoaderError("invalid_input", `Refusing the write to ${relative(resolve(root), resolve(target))}: its bytes are not a JSON object`);
  }
  const ctx = heldResolutionContext(root, undefined);
  const rel = relative(resolve(root), resolve(target)).split(sep).join("/");
  ctx.recordPrepared(target, content, assertResolutionMetadataWrite(ctx, rel, prior, record));
}

/**
 * T-486 U2: the ticket counterpart of `authoriseIssueBytes`, for the same
 * writers (reconcile, repair, ledger restore, the tombstone): the withdrawal
 * check against the record these bytes replace, and a token for exactly them.
 */
export function authoriseTicketBytes(
  root: string,
  target: string,
  prior: Readonly<Record<string, unknown>> | "unknown",
  content: string,
): void {
  const record = priorRecord(content);
  if (record === "unknown") {
    throw new ProjectLoaderError("invalid_input", `Refusing the write to ${relative(resolve(root), resolve(target))}: its bytes are not a JSON object`);
  }
  const ctx = heldResolutionContext(root, undefined);
  const rel = relative(resolve(root), resolve(target)).split(sep).join("/");
  const decision = assertTicketResolutionWrite(ctx, rel, prior, record);
  ctx.recordPrepared(target, content, decision.dependsOnBoard, decision.withdrawalGated);
}

/**
 * T-486 U2-6: the ledger refusals of a withdrawal, at its own commit. Called
 * right after `assertPreparedWritesCurrent` wherever ticket bytes commit
 * (writeTicketUnlocked, the ticket tombstone, runTransactionUnlocked). It
 * works only when one of the writes carries a withdrawal-gated token, so an
 * ordinary write pays one token lookup.
 *
 * The graph is the tickets directory read fresh under the lock, one record
 * per file, with this operation's own writes and deletes applied by file
 * path, never by id: two files claiming one canonical id keep their own
 * edges. Nothing prepared but not committed is counted, and a dependent
 * committed after the withdrawal was prepared is seen.
 *
 * Not covered: ticket bytes the merge driver writes (protocol 5) and journal
 * forward recovery, which replays checked content.
 */
export async function assertWithdrawalLedgerCurrent(
  root: string,
  operations: ReadonlyArray<{ op: "write"; target: string; content: string } | { op: "delete"; target: string }>,
): Promise<void> {
  const absRoot = resolve(root);
  const contexts = (resolutionContextChain.getStore() ?? []).filter((c) => c.root === absRoot);
  const gated = operations.flatMap((op) =>
    op.op === "write" && contexts.some((c) => c.preparedWithdrawal(op.target, op.content)) ? [relative(absRoot, resolve(op.target))] : []);
  if (gated.length === 0) return;
  const { records, files, omitted } = await loadTicketRecords(join(absRoot, ".story"));
  const byPath = new Map<string, Ticket>(records.map((record, i) => [files[i]!, record]));
  const touched = new Set<string>();
  const invalid: string[] = [];
  const ticketsDir = join(absRoot, ".story", "tickets") + sep;
  for (const op of operations) {
    if (!resolve(op.target).startsWith(ticketsDir)) continue;
    const file = relative(absRoot, resolve(op.target));
    touched.add(file);
    byPath.delete(file);
    if (op.op === "write") {
      const parsed = TicketSchema.safeParse(priorRecord(op.content));
      if (parsed.success) byPath.set(file, parsed.data);
      else invalid.push(file);
    }
  }
  // Codex F5: a record that fails the schema has no edges to check, so a
  // withdrawal never commits beside one. A gated target missing from the
  // graph below cannot happen today (a transaction names a ticket once and
  // every raw writer targets tickets/); it fails closed if that changes.
  if (invalid.length > 0) {
    throw new ProjectLoaderError("conflict", `Cannot commit a withdrawal beside ticket bytes that are not a valid ticket (${invalid.join(", ")}); their edges cannot be checked.`);
  }
  const graph = ProjectState.forTicketGraph([...byPath.values()], omitted.filter((o) => !touched.has(o.file)));
  for (const file of gated) {
    const ticket = byPath.get(file);
    if (!ticket) throw new ProjectLoaderError("conflict", `Cannot commit the withdrawal in ${file}: this write leaves no ticket there.`);
    assertWithdrawable(graph, ticket);
  }
}

/**
 * T-486 Codex F2: issue bytes commit only under a current token. Called at
 * every commit of issue bytes (writeIssueUnlocked, runTransactionUnlocked,
 * ledger restore), before anything is journaled or written. The bytes must be
 * exactly the bytes a context held by this operation prepared for the target,
 * and the config and git answers that decision read must still hold. A
 * missing token fails closed: bytes nobody prepared, bytes prepared under
 * another lock, or bytes other than the latest prepared for the target are
 * refused, never committed unchecked.
 */
export function assertPreparedWritesCurrent(root: string, writes: ReadonlyArray<{ target: string; content: string }>): void {
  const absRoot = resolve(root);
  const contexts = (resolutionContextChain.getStore() ?? []).filter((c) => c.root === absRoot);
  for (const { target, content } of writes) {
    const verdicts = contexts.map((c) => c.preparedVerdict(target, content));
    if (verdicts.includes("current")) continue;
    const verdict = verdicts.find((v) => v !== "missing") ?? "missing";
    const why = verdict === "released"
      ? "the lock it was prepared under was released or no longer owns .story/.lock"
      : verdict === "stale"
      ? "it was checked against config or git state that changed before it was committed"
      : verdict === "changed"
        ? "the bytes being committed are not the bytes that were prepared for it"
        : "nothing prepared it under this lock (ticket and issue writes go through prepareTicketWrite and prepareIssueWrite)";
    throw new ProjectLoaderError("conflict", `Refusing the write to ${relative(absRoot, resolve(target))}: ${why}; prepare it again`);
  }
}

/** The record a write replaces: `{}` when absent, "unknown" when unparseable. */
function priorRecord(raw: string | null): Readonly<Record<string, unknown>> | "unknown" {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * T-486 A4/B6: the resolution-write context of the lock operation holding
 * `root`. Every lock acquisition creates one after it acquires, and releases
 * it in its finally before the lock itself is released (`withLock`), so a
 * context exists exactly while its lock is held, by this async flow. Nested
 * locks (an orchestrator lock around an item lock) each have their own, found
 * by root.
 *
 * Fails closed with `ResolutionWriteContextError` when there is none, or the
 * given one is released, belongs to another project, or is not held by this
 * operation. Never loads the project and never skips the guard.
 */
export function resolutionWriteContextFor(root: string): ResolutionWriteContext {
  return heldResolutionContext(root, undefined);
}

function heldResolutionContext(root: string, given: ResolutionWriteContext | undefined): ResolutionWriteContext {
  const absRoot = resolve(root);
  const chain = resolutionContextChain.getStore() ?? [];
  if (given !== undefined) {
    if (given.released) throw new ResolutionWriteContextError("the given write context belongs to a lock that was released");
    if (given.root !== absRoot) throw new ResolutionWriteContextError(`the given write context is for ${given.root}, not ${absRoot}`);
    if (!chain.some((held) => held.token === given.token)) throw new ResolutionWriteContextError("the given write context is not held by this operation");
    return given;
  }
  const held = [...chain].reverse().find((c) => c.root === absRoot && !c.released);
  if (!held) throw new ResolutionWriteContextError(`no project lock is held for ${absRoot}`);
  return held;
}

export async function writeIssueUnlocked(
  issue: Issue,
  root: string,
  options?: { createOnly?: boolean; touch?: TouchOption } & PreparedContentValidation,
): Promise<void> {
  const { target, content } = await prepareIssueWrite(issue, root, { touch: options?.touch });
  assertPreparedWritesCurrent(root, [{ target, content }]);
  await options?.validatePreparedContent?.(content);
  if (options?.createOnly) {
    await atomicCreate(target, content);
  } else {
    await atomicWrite(target, content);
  }
}

export async function writeIssue(
  issue: Issue,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);
    await writeIssueUnlocked(issue, root);
  });
}

/**
 * Writes a roadmap file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 * Performs Zod parse + guardPath + atomicWrite.
 */
export async function writeRoadmapUnlocked(
  roadmap: Roadmap,
  root: string,
): Promise<void> {
  const { target, content } = await prepareRoadmapWrite(roadmap, root);
  await atomicWrite(target, content);
}

/**
 * T-538 S2: the roadmap write as a transaction operation, for a caller that
 * commits it with other writes in one `runTransactionUnlocked` under the lock.
 */
export async function prepareRoadmapWrite(
  roadmap: Roadmap,
  root: string,
): Promise<{ target: string; content: string }> {
  const parsed = RoadmapSchema.parse(roadmap);
  const wrapDir = resolve(root, ".story");
  const target = join(wrapDir, "roadmap.json");
  await guardPath(target, wrapDir);
  return { target, content: serializeJSON(parsed) };
}

export async function writeRoadmap(
  roadmap: Roadmap,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);
    await writeRoadmapUnlocked(roadmap, root);
  });
}

/**
 * T-538 S2: the config write as a transaction operation. A caller that
 * commits it must call `invalidateResolutionWriteContext(root)` after the
 * commit, as `writeConfigUnlocked` does.
 */
export async function prepareConfigWrite(
  config: Config,
  root: string,
): Promise<{ target: string; content: string }> {
  const parsed = ConfigSchema.parse(config);
  const wrapDir = resolve(root, ".story");
  const target = join(wrapDir, "config.json");
  await guardPath(target, wrapDir);
  return { target, content: serializeJSON(parsed) };
}

export async function writeConfigUnlocked(
  config: Config,
  root: string,
): Promise<void> {
  const { target, content } = await prepareConfigWrite(config, root);
  await atomicWrite(target, content);
  // T-486 B6: decisions derived from the old config (the fence) must not
  // outlive it within this operation.
  invalidateResolutionWriteContext(root);
}

/** T-486 B6: drops the config and git answers the held context for `root` derived, if one is held. */
export function invalidateResolutionWriteContext(root: string): void {
  const absRoot = resolve(root);
  for (const ctx of resolutionContextChain.getStore() ?? []) if (ctx.root === absRoot) ctx.invalidate();
}

export async function writeConfig(
  config: Config,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);
    await writeConfigUnlocked(config, root);
  });
}

async function assertNoConflictsFromDisk(root: string): Promise<void> {
  try {
    const { state } = await loadProjectUnlocked(resolve(root));
    assertTeamWriteCapabilities(state.config);
    const { assertNoConflicts } = await import("./conflicts.js");
    assertNoConflicts(state);
  } catch (err) {
    if (err instanceof ProjectLoaderError && err.code === "not_found") return;
    throw err;
  }
}

/**
 * The single disk-reading team-mode detector (ISS-701): reads .story/config.json
 * and returns whether team mode is enabled, reusing the in-memory predicate
 * isTeamModeConfig. Error policy is "throw on any failure" -- a missing,
 * unreadable, or malformed config all reject. Callers that need to degrade apply
 * their own documented policy on top (e.g. the soft-delete path treats any
 * failure as "cannot determine -> fail closed", while handover treats a missing
 * config as solo mode). Keeps config loading in one place instead of two
 * divergent re-implementations.
 */
export async function detectTeamModeFromDisk(root: string): Promise<boolean> {
  const raw = await readFile(join(resolve(root), ".story", "config.json"), "utf-8");
  const config = ConfigSchema.passthrough().parse(JSON.parse(raw));
  return isTeamModeConfig(config);
}

async function isTeamMode(root: string): Promise<boolean | "error"> {
  try {
    return await detectTeamModeFromDisk(root);
  } catch {
    return "error";
  }
}

export async function resolveActor(root: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  try {
    const { gitUserEmail } = await import("../autonomous/git-inspector.js");
    const email = await gitUserEmail(resolve(root));
    if (email) return email;
  } catch { /* git not available */ }
  return "unknown";
}

/**
 * Deletes a ticket file with referential integrity checks.
 * Acquires lock, reloads fresh state from disk, checks all references.
 * With force: true, skips integrity checks and state reload.
 */
export async function deleteTicket(
  id: string,
  root: string,
  options?: DeleteOptions,
): Promise<DeleteResult> {
  if (!TICKET_ID_REGEX.test(id) && !TICKET_CANONICAL_ID_REGEX.test(id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid ticket ID: ${id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "tickets", `${id}.json`);
  await guardPath(targetPath, wrapDir);

  return withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);

    // T-537: retirement is the only way out of an owner checkpoint. Soft,
    // hard and forced deletion are all refused, whatever the mode.
    const onDisk = priorForGuard(await readIfExists(targetPath), `tickets/${id}.json`);
    if (onDisk !== null && hasOwnerCheckpoint(onDisk)) {
      throw new ProjectLoaderError(
        "conflict",
        `Cannot delete ${id}: it is an owner checkpoint. A checkpoint is never deleted; retire it instead, which releases its dependents.`,
      );
    }

    const teamModeResult = options?.hard ? false : await isTeamMode(root);
    if (teamModeResult === "error" && !options?.hard) {
      throw new ProjectLoaderError("io_error", `Cannot determine team mode for ${id}: failed to read .story/config.json. Use --hard to force physical removal.`);
    }
    const teamMode = teamModeResult === true;

    if (!options?.force && !teamMode) {
      const { state } = await loadProjectUnlocked(resolve(root));

      const blocking = state.ticketsBlocking(id);
      if (blocking.length > 0) {
        throw new ProjectLoaderError(
          "conflict",
          `Cannot delete ${id}: referenced in blockedBy by ${blocking.join(", ")}`,
        );
      }
      const children = state.childrenOf(id);
      if (children.length > 0) {
        throw new ProjectLoaderError(
          "conflict",
          `Cannot delete ${id}: has child tickets ${children.join(", ")}`,
        );
      }
      const refs = state.issuesReferencing(id);
      if (refs.length > 0) {
        throw new ProjectLoaderError(
          "conflict",
          `Cannot delete ${id}: referenced by issues ${refs.join(", ")}`,
        );
      }
    }

    try {
      await stat(targetPath);
    } catch {
      throw new ProjectLoaderError(
        "not_found",
        `Ticket file not found: tickets/${id}.json`,
      );
    }

    if (teamMode) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>;
      } catch {
        throw new ProjectLoaderError("io_error", `Failed to parse tickets/${id}.json for tombstone write`);
      }
      // ISS-757: team-mode second delete is a silent success -- the tombstone
      // keeps the item addressable, so re-deleting returns alreadyDeleted: true
      // with NO write (original deletedAt/deletedBy preserved). Non-team second
      // delete throws not_found instead (the file is physically gone after
      // unlink). This asymmetry is deliberate.
      if (raw.lifecycle === "deleted") {
        return { alreadyDeleted: true };
      }
      const prior = { ...raw };
      raw.lifecycle = "deleted";
      raw.deletedAt = new Date().toISOString();
      raw.deletedBy = await resolveActor(root, options?.actor);
      // T-486 U2: the ticket tombstone takes the ticket boundary, as the
      // issue tombstone takes the issue one.
      const content = serializeJSON(raw);
      authoriseTicketBytes(root, targetPath, prior, content);
      assertPreparedWritesCurrent(root, [{ target: targetPath, content }]);
      await assertWithdrawalLedgerCurrent(root, [{ op: "write", target: targetPath, content }]);
      await atomicWrite(targetPath, content);
    } else {
      await fencedUnlink(targetPath);
      recordBoardTarget(targetPath, "delete");
    }
    return { alreadyDeleted: false };
  });
}

export async function deleteIssue(
  id: string,
  root: string,
  options?: DeleteOptions,
): Promise<DeleteResult> {
  if (!ISSUE_ID_REGEX.test(id) && !ISSUE_CANONICAL_ID_REGEX.test(id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid issue ID: ${id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "issues", `${id}.json`);
  await guardPath(targetPath, wrapDir);

  return withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);

    const teamModeResult = options?.hard ? false : await isTeamMode(root);
    if (teamModeResult === "error" && !options?.hard) {
      throw new ProjectLoaderError("io_error", `Cannot determine team mode for ${id}: failed to read .story/config.json. Use --hard to force physical removal.`);
    }
    const teamMode = teamModeResult === true;

    try {
      await stat(targetPath);
    } catch {
      throw new ProjectLoaderError(
        "not_found",
        `Issue file not found: issues/${id}.json`,
      );
    }
    if (teamMode) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>;
      } catch {
        throw new ProjectLoaderError("io_error", `Failed to parse issues/${id}.json for tombstone write`);
      }
      // ISS-757: team-mode second delete is a silent success -- the tombstone
      // keeps the item addressable, so re-deleting returns alreadyDeleted: true
      // with NO write (original deletedAt/deletedBy preserved). Non-team second
      // delete throws not_found instead (the file is physically gone after
      // unlink). This asymmetry is deliberate.
      if (raw.lifecycle === "deleted") {
        return { alreadyDeleted: true };
      }
      const prior = { ...raw };
      raw.lifecycle = "deleted";
      raw.deletedAt = new Date().toISOString();
      raw.deletedBy = await resolveActor(root, options?.actor);
      // T-486 Codex F2: the tombstone edits the raw record outside
      // prepareIssueWrite, so it takes the same boundary and commit check.
      const content = serializeJSON(raw);
      authoriseIssueBytes(root, targetPath, prior, content);
      assertPreparedWritesCurrent(root, [{ target: targetPath, content }]);
      await atomicWrite(targetPath, content);
    } else {
      await fencedUnlink(targetPath);
      recordBoardTarget(targetPath, "delete");
    }
    return { alreadyDeleted: false };
  });
}

/**
 * Writes a note file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 */
export async function writeNoteUnlocked(
  note: Note,
  root: string,
  options?: { createOnly?: boolean } & PreparedContentValidation,
): Promise<void> {
  const { target, content } = await prepareNoteWrite(note, root);
  await options?.validatePreparedContent?.(content);
  if (options?.createOnly) {
    await atomicCreate(target, content);
  } else {
    await atomicWrite(target, content);
  }
}

/**
 * T-538 S2: the note write as a transaction operation (the counterpart of
 * `prepareTicketWrite`), for a caller that commits it with other writes in
 * one `runTransactionUnlocked` under the lock.
 */
export async function prepareNoteWrite(
  note: Note,
  root: string,
): Promise<{ target: string; content: string }> {
  const parsed = NoteSchema.parse(note);
  if (!NOTE_ID_REGEX.test(parsed.id) && !NOTE_CANONICAL_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid note ID: ${parsed.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const target = join(wrapDir, "notes", `${parsed.id}.json`);
  await mkdir(dirname(target), { recursive: true });
  await guardPath(target, wrapDir);
  return { target, content: serializeJSON(parsed) };
}

export async function writeNote(
  note: Note,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);
    await writeNoteUnlocked(note, root);
  });
}

export async function deleteNote(
  id: string,
  root: string,
  options?: DeleteOptions,
): Promise<DeleteResult> {
  if (!NOTE_ID_REGEX.test(id) && !NOTE_CANONICAL_ID_REGEX.test(id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid note ID: ${id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "notes", `${id}.json`);
  await guardPath(targetPath, wrapDir);

  return withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);

    const teamModeResult = options?.hard ? false : await isTeamMode(root);
    if (teamModeResult === "error" && !options?.hard) {
      throw new ProjectLoaderError("io_error", `Cannot determine team mode for ${id}: failed to read .story/config.json. Use --hard to force physical removal.`);
    }
    const teamMode = teamModeResult === true;

    try {
      await stat(targetPath);
    } catch {
      throw new ProjectLoaderError(
        "not_found",
        `Note file not found: notes/${id}.json`,
      );
    }
    if (teamMode) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>;
      } catch {
        throw new ProjectLoaderError("io_error", `Failed to parse notes/${id}.json for tombstone write`);
      }
      // ISS-757: team-mode second delete is a silent success -- the tombstone
      // keeps the item addressable, so re-deleting returns alreadyDeleted: true
      // with NO write (original deletedAt/deletedBy preserved). Non-team second
      // delete throws not_found instead (the file is physically gone after
      // unlink). This asymmetry is deliberate.
      if (raw.lifecycle === "deleted") {
        return { alreadyDeleted: true };
      }
      raw.lifecycle = "deleted";
      raw.deletedAt = new Date().toISOString();
      raw.deletedBy = await resolveActor(root, options?.actor);
      await atomicWrite(targetPath, serializeJSON(raw));
    } else {
      await fencedUnlink(targetPath);
      recordBoardTarget(targetPath, "delete");
    }
    return { alreadyDeleted: false };
  });
}

/**
 * Writes a lesson file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 */
export async function writeLessonUnlocked(
  lesson: Lesson,
  root: string,
  options?: { createOnly?: boolean },
): Promise<void> {
  const parsed = LessonSchema.parse(lesson);
  if (!LESSON_ID_REGEX.test(parsed.id) && !LESSON_CANONICAL_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid lesson ID: ${parsed.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "lessons", `${parsed.id}.json`);
  await mkdir(dirname(targetPath), { recursive: true });
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  if (options?.createOnly) {
    await atomicCreate(targetPath, json);
  } else {
    await atomicWrite(targetPath, json);
  }
}

export async function writeLesson(
  lesson: Lesson,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);
    await writeLessonUnlocked(lesson, root);
  });
}

/**
 * Deletes a lesson file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 */
export async function deleteLessonUnlocked(
  id: string,
  root: string,
  options?: DeleteOptions,
): Promise<DeleteResult> {
  if (!LESSON_ID_REGEX.test(id) && !LESSON_CANONICAL_ID_REGEX.test(id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid lesson ID: ${id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "lessons", `${id}.json`);
  await guardPath(targetPath, wrapDir);

  try {
    await stat(targetPath);
  } catch {
    throw new ProjectLoaderError(
      "not_found",
      `Lesson file not found: lessons/${id}.json`,
    );
  }

  const teamModeResult = options?.hard ? false : await isTeamMode(root);
  if (teamModeResult === "error" && !options?.hard) {
    throw new ProjectLoaderError("io_error", `Cannot determine team mode for ${id}: failed to read .story/config.json. Use --hard to force physical removal.`);
  }
  const teamMode = teamModeResult === true;
  if (teamMode) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>;
    } catch {
      throw new ProjectLoaderError("io_error", `Failed to parse lessons/${id}.json for tombstone write`);
    }
    // ISS-757: team-mode second delete is a silent success -- the tombstone
    // keeps the item addressable, so re-deleting returns alreadyDeleted: true
    // with NO write (original deletedAt/deletedBy preserved). Non-team second
    // delete throws not_found instead (the file is physically gone after
    // unlink). This asymmetry is deliberate.
    if (raw.lifecycle === "deleted") {
      return { alreadyDeleted: true };
    }
    raw.lifecycle = "deleted";
    raw.deletedAt = new Date().toISOString();
    raw.deletedBy = await resolveActor(root, options?.actor);
    await atomicWrite(targetPath, serializeJSON(raw));
  } else {
    await fencedUnlink(targetPath);
    recordBoardTarget(targetPath, "delete");
  }
  return { alreadyDeleted: false };
}

export async function deleteLesson(
  id: string,
  root: string,
  options?: DeleteOptions,
): Promise<DeleteResult> {
  const wrapDir = resolve(root, ".story");
  return withLock(wrapDir, async () => {
    await assertNoConflictsFromDisk(root);
    return deleteLessonUnlocked(id, root, options);
  });
}

// --- Locked Project Operations ---

export interface WithProjectLockOptions {
  strict?: boolean;
  /** How long to wait for the lock before failing; the lock's own default when absent. */
  deadlineMs?: number;
}

interface InternalLockOptions extends WithProjectLockOptions {
  _skipConflictCheck?: boolean;
}

/**
 * Acquires the project lock, loads fresh state, optionally enforces strict mode,
 * then calls the handler. Released in finally.
 * Use for create/update operations that need atomic load→validate→write.
 */
async function withProjectLockInternal(
  root: string,
  options: InternalLockOptions,
  handler: (result: LoadResult) => Promise<void>,
): Promise<void> {
  const absRoot = resolve(root);
  const wrapDir = join(absRoot, ".story");

  await withLock(wrapDir, async () => {
    await doRecoverTransaction(wrapDir);

    const result = await loadProjectUnlocked(absRoot);

    const config = result.state.config;
    if (
      config.schemaVersion !== undefined &&
      config.schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION
    ) {
      throw new ProjectLoaderError(
        "version_mismatch",
        `Config schemaVersion ${config.schemaVersion} exceeds max supported ${MAX_SUPPORTED_SCHEMA_VERSION}. Run: npm update -g @storybloq/storybloq`,
      );
    }
    assertTeamWriteCapabilities(config);
    heldResolutionContext(absRoot, undefined).bindConfig(config);

    if (options.strict) {
      const integrityWarning = result.warnings.find((w) =>
        (INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type),
      );
      if (integrityWarning) {
        throw new ProjectLoaderError(
          "project_corrupt",
          `Strict mode: ${integrityWarning.file}: ${integrityWarning.message}`,
        );
      }
    }

    if (!options._skipConflictCheck) {
      const { assertNoConflicts } = await import("./conflicts.js");
      assertNoConflicts(result.state);
    }

    await handler(result);
  }, options.deadlineMs);
}

export async function withProjectLock(
  root: string,
  options: WithProjectLockOptions,
  handler: (result: LoadResult) => Promise<void>,
): Promise<void> {
  return withProjectLockInternal(root, options, handler);
}

/**
 * T-486 U3: the lock `storybloq triage` runs under. Everything
 * `withProjectLock` does (recovery, strict loading, the schema-version and
 * team-capability checks) runs unchanged; only the board-wide conflict check
 * is replaced. A conflict on config, the roadmap, a ticket, a note or a
 * lesson still refuses, because triage reads them. A conflicted issue
 * reaches the handler, which reports it as protected and never writes it.
 */
export async function withProjectLockForIssueTriage(
  root: string,
  handler: (result: LoadResult) => Promise<void>,
): Promise<void> {
  return withProjectLockInternal(root, { strict: true, _skipConflictCheck: true }, async (result) => {
    await refuseNonIssueConflicts(result, "Cannot triage");
    await handler(result);
  });
}

/**
 * T-486 U4: the lock every issue-sweep step runs under (classification,
 * release, acquisition, recovery). Lenient loading, as every sweep lock was
 * before; the board-wide conflict check is replaced by the triage lock's
 * non-issue refusal, so a conflicted issue reaches the sweep, which lists it
 * and never writes it, instead of stopping the whole sweep.
 */
export async function withProjectLockForIssueSweep(
  root: string,
  handler: (result: LoadResult) => Promise<void>,
): Promise<void> {
  return withProjectLockInternal(root, { strict: false, _skipConflictCheck: true }, async (result) => {
    await refuseNonIssueConflicts(result, "Cannot run the issue sweep");
    await handler(result);
  });
}

/** The refusal both issue-scoped locks share: a conflict on anything but an issue. */
async function refuseNonIssueConflicts(result: LoadResult, refusal: string): Promise<void> {
  const { hasConflicts } = await import("./conflicts.js");
  const blocking = hasConflicts(result.state).items.filter((item) => item.type !== "issue");
  if (blocking.length > 0) {
    const summary = blocking.map((i) => `${i.id} (${i.conflictCount})`).join(", ");
    throw new ProjectLoaderError(
      "conflict",
      `${refusal}: ${blocking.length} item(s) other than issues have unresolved conflicts: ${summary}. ` +
      `Run \`storybloq conflicts list\` to inspect, then \`storybloq resolve <id> --use ours|theirs\`. ` +
      `For config.json/roadmap.json use \`storybloq resolve config\` or \`storybloq resolve roadmap\`.`,
    );
  }
}

export async function withConflictResolutionLock(
  root: string,
  handler: (result: LoadResult) => Promise<void>,
): Promise<void> {
  return withProjectLockInternal(root, { strict: false, _skipConflictCheck: true }, handler);
}

// --- Transaction Journal ---

interface TxnEntry {
  op: "write" | "delete";
  target: string;
  tempPath?: string;
}

/**
 * ISS-942: forensic-only owner record, additive and optional-on-read. NEVER a
 * behavioral gate -- doRecoverTransaction's authorization to recover rests
 * entirely on lock exclusivity (whoever holds the lock next), not on this
 * field. A pid-liveness gate here would self-deadlock a long-lived MCP server
 * on its own voluntarily-released journals (its pid never dies while the
 * server runs). `episodeId` is a fresh randomUUID() per runTransactionUnlocked
 * call (not derived from the lock token) so two attempts by the same
 * long-lived pid within one lock hold remain forensically distinguishable.
 */
interface TxnOwner {
  pid: number;
  processSignature: string | null;
  episodeId: string;
}

interface TxnJournal {
  entries: TxnEntry[];
  commitStarted: boolean;
  owner?: TxnOwner;
}

/**
 * T-494: a transaction that FAILED AFTER it began renaming.
 *
 * Distinct from a generic transaction failure because the correct caller
 * response is the opposite one. Nothing was written before commit starts, so a
 * retry is right; after it starts, some targets are already in place, the
 * journal is deliberately left behind, and `doRecoverTransaction` completes the
 * rest at the next lock acquisition -- so a retry writes a SECOND record beside
 * the one recovery is about to finish. Callers that mint an id before the
 * transaction must surface that id with this error, because it is the only
 * handle the operator has on what recovery is going to complete.
 */
export class TransactionRecoveryPendingError extends ProjectLoaderError {
  /**
   * ISS-1399: "marker-unconfirmed" when the commit marker's rename or its
   * directory sync failed, so `.txn.json` may hold either journal and the next
   * recovery may roll the change back or finish it; "committed" once the
   * marker is durable, so recovery finishes it.
   */
  readonly phase: "marker-unconfirmed" | "committed";

  constructor(cause: unknown, phase: "marker-unconfirmed" | "committed" = "committed") {
    // The underlying failure is carried in the MESSAGE and not only in `cause`.
    // It is what an operator needs to know ("lock ownership lost" and "EIO on a
    // rename" call for different responses), and it keeps the phase wrapper
    // from hiding a message existing callers already match on.
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      "io_error",
      phase === "committed"
        ? `Transaction failed after it began committing; forward recovery is pending: ${detail}`
        : `Transaction may or may not have been applied; the next storybloq command finishes or rolls it back: ${detail}`,
      cause,
    );
    this.phase = phase;
  }
}

/**
 * ISS-1399: every target is applied and the journal is removed, but the sync
 * of `.story` after that removal failed, so the removal may not survive a
 * power loss. Not a recovery-pending failure: the change is in place, and a
 * journal that reappears only replays what is already there. A retry would
 * apply the change a second time.
 */
export class TransactionCommittedUnconfirmedError extends ProjectLoaderError {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super("io_error", `Transaction applied, but the removal of its journal could not be confirmed durable: ${detail}`, cause);
  }
}

/**
 * Executes multiple file operations atomically with a transaction journal.
 * Forward-only recovery: if any rename succeeds, complete remaining.
 * Does NOT acquire the lock -- caller must hold it.
 *
 * The journal persists a `commitStarted` flag so recovery can distinguish
 * "prepared" (safe to roll back) from "committing" (must complete forward).
 *
 * ISS-1399: the sequence the Mac app's NativeTransaction also writes, so the
 * CLI's recovery finishes either writer's crash:
 * 1. fence; the journal with commitStarted false; sync `.story`;
 * 2. per write, fence, then its temp, exclusive;
 * 3. sync every temp's directory;
 * 4. remove a stale marker sidecar; fence; write the journal with
 *    commitStarted true to the sidecar, exclusive;
 * 5. fence; rename the sidecar over the journal; sync `.story`;
 * 6. the renames and deletes, fenced each;
 * 7. sync every target's directory;
 * 8. remove the journal; sync `.story`.
 * A torn marker write tears only the sidecar, never the journal.
 */
/**
 * Test seams for transaction atomicity: called after each temp file is
 * written (before the commit marker) and after each commit rename. Not
 * reachable through any CLI or MCP input.
 */
export const transactionSeams: { afterTemp: (target: string) => void | Promise<void>; afterCommitEntry: (target: string) => void | Promise<void> } = {
  afterTemp: () => {},
  afterCommitEntry: () => {},
};

export async function runTransactionUnlocked(
  root: string,
  operations: Array<
    | { op: "write"; target: string; content: string }
    | { op: "delete"; target: string }
  >,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  const journalPath = join(wrapDir, ".txn.json");
  const sidecarPath = join(wrapDir, TXN_MARKER_SIDECAR);
  const entries: TxnEntry[] = [];
  // Set just before the sidecar rename: from then on `.txn.json` may be the
  // marker whatever the rename reports, so nothing is rolled back here.
  let commitStarted = false;
  // ISS-1399: the marker's rename and its `.story` sync both returned.
  let markerDurable = false;
  // Each temp from the moment its exclusive open succeeds, so a failure while
  // writing it still removes it; a failed open never names a file it did not create.
  const createdTemps: string[] = [];
  let sidecarCreated = false;
  let journalRemoved = false;
  // ISS-1107: the logical targets this commit applied, recorded only once the
  // whole transaction succeeded (an ENOENT delete applied nothing).
  const applied: Array<{ target: string; kind: "write" | "delete" }> = [];
  const lockHandle = projectLockContext.getStore();
  const owner: TxnOwner | undefined = lockHandle
    ? { pid: lockHandle.pid, processSignature: lockHandle.processSignature, episodeId: randomUUID() }
    : undefined;

  // ISS-942 942.1: journal removal routed through fencedUnlink (fencing +
  // unlink) so both the commit-success removal (step 6) and the no-commit
  // rollback removal benefit from the same ownership fencing as every other
  // destructive choke point, instead of a bare unlink. ENOENT is tolerated
  // (already gone -- fine); doRecoverTransaction's own unlinkJournalOrThrow
  // documents the identical rationale -- the commit path should match its
  // own recovery path's posture.
  async function removeJournal(): Promise<void> {
    await fencedUnlinkIfPresent(journalPath);
  }

  // ISS-1399: the cleanup of a transaction that failed before its marker. Every
  // removal is fenced, so a lost lock stops it at once and its fencing error
  // propagates: the files may now belong to the new holder. The journal goes
  // only once every temp is gone and their directories are synced; otherwise
  // it stays, so the next recovery removes what is left.
  async function cleanUpBeforeMarker(cause: unknown): Promise<never> {
    const left: string[] = [];
    for (const temp of createdTemps) {
      try {
        await fencedUnlinkIfPresent(temp);
      } catch (err) {
        if (isProjectLockFencingError(err)) throw err;
        left.push(temp);
      }
    }
    if (sidecarCreated) {
      try {
        await fencedUnlinkIfPresent(sidecarPath);
      } catch (err) {
        // Anything but a lost lock: the next transaction removes it before its own.
        if (isProjectLockFencingError(err)) throw err;
      }
    }
    let synced = left.length === 0;
    if (synced) {
      try {
        await syncParents(createdTemps);
      } catch {
        synced = false;
      }
    }
    if (!synced) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const rest = left.length > 0 ? ` and removes ${left.join(", ")}` : "";
      throw new ProjectLoaderError("io_error", `Transaction failed (${detail}); its cleanup is pending: the next storybloq command finishes it${rest}`, cause);
    }
    try {
      await removeJournal();
    } catch (err) {
      // A journal that cannot be removed is rolled back by the next recovery.
      if (isProjectLockFencingError(err)) throw err;
    }
    try {
      await syncDir(wrapDir);
    } catch {
      // Not reported: if the removal is lost, a journal whose temps are gone
      // reappears and the next recovery rolls it back with no effect.
    }
    if (cause instanceof ProjectLoaderError) throw cause;
    throw new ProjectLoaderError("io_error", "Transaction failed", cause);
  }

  // T-486 A7: each issue's boundary check compared its write against the file
  // on disk, so a batch naming the same issue twice would let the second
  // write skip a check the first one changed the basis of. Refused before
  // anything is journaled. T-486 U2: tickets carry the same boundary.
  const guardedTargets = new Set<string>();
  const guardedDirs = [join(wrapDir, "issues") + sep, join(wrapDir, "tickets") + sep];
  for (const op of operations) {
    const target = resolve(op.target);
    if (!guardedDirs.some((dir) => target.startsWith(dir))) continue;
    if (guardedTargets.has(target)) {
      throw new ProjectLoaderError("invalid_input", `Transaction names ${relative(wrapDir, target)} more than once; each ticket or issue may be written once per transaction`);
    }
    guardedTargets.add(target);
  }
  assertPreparedWritesCurrent(root, operations.flatMap((op) => op.op === "write" && guardedTargets.has(resolve(op.target)) ? [{ target: op.target, content: op.content }] : []));
  await assertWithdrawalLedgerCurrent(root, operations);

  try {
    // 1. Build entries
    for (const op of operations) {
      if (op.op === "write") {
        const tempPath = `${op.target}.${process.pid}.tmp`;
        entries.push({ op: "write", target: op.target, tempPath });
      } else {
        entries.push({ op: "delete", target: op.target });
      }
    }

    // 2. Write journal with commitStarted=false (fsync'd for durability)
    const journal: TxnJournal = { entries, commitStarted: false, owner };
    checkProjectLockFencing();
    await fsyncWrite(journalPath, JSON.stringify(journal, null, 2));
    await syncDir(wrapDir);

    // 3. Write temp files
    for (const op of operations) {
      if (op.op === "write") {
        const tempPath = `${op.target}.${process.pid}.tmp`;
        checkProjectLockFencing();
        await fsyncWrite(tempPath, op.content, true, () => createdTemps.push(tempPath));
        await transactionSeams.afterTemp(op.target);
      }
    }
    await syncParents(createdTemps);

    // 4. Mark commit started: the marker is written whole beside the journal
    // and renamed over it, so `.txn.json` is always one complete journal.
    journal.commitStarted = true;
    await fencedUnlinkIfPresent(sidecarPath);
    checkProjectLockFencing();
    await fsyncWrite(sidecarPath, JSON.stringify(journal, null, 2), true, () => {
      sidecarCreated = true;
    });
    checkProjectLockFencing();
    commitStarted = true;
    await rename(sidecarPath, journalPath);
    await syncDir(wrapDir);
    markerDurable = true;

    // 5. Commit: rename all temps, delete targets. Fenced per-entry (ISS-942):
    // on ownership loss, stop immediately -- don't attempt the current or
    // remaining entries -- and throw. Safe because the journal was already
    // durably marked commitStarted=true above, so the next holder's (hardened)
    // forward recovery completes the remainder or fails loudly rather than
    // silently losing data.
    for (const entry of entries) {
      checkProjectLockFencing();
      if (entry.op === "write" && entry.tempPath) {
        await rename(entry.tempPath, entry.target);
        applied.push({ target: entry.target, kind: "write" });
        await transactionSeams.afterCommitEntry(entry.target);
      } else if (entry.op === "delete") {
        try {
          await unlink(entry.target);
          applied.push({ target: entry.target, kind: "delete" });
        } catch (err) {
          // ISS-942 942.1: only ENOENT ("already gone") is a genuine no-op.
          // Any other failure (EPERM/EISDIR/EACCES/...) must NOT be swallowed
          // here -- step 6 would then remove the journal, the transaction
          // would report success, and the target would silently survive with
          // no journal left to replay it. Fail closed instead: the journal
          // (already durably marked commitStarted=true) is left in place for
          // the next recovery pass to retry this exact entry.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new ProjectLoaderError(
              "io_error",
              `Failed to delete ${entry.target} during transaction commit; journal preserved for retry`,
              err,
            );
          }
        }
      }
    }
    await syncParents(entries.map((entry) => entry.target));

    // 6. Remove journal
    try {
      await removeJournal();
      journalRemoved = true;
    } catch (err) {
      if (!isProjectLockFencingError(err)) throw err;
      // Every entry is already applied and durable. Keep the journal for the
      // next holder's idempotent forward recovery instead of reporting failure.
    }
    for (const { target, kind } of applied) recordBoardTarget(target, kind);
  } catch (err) {
    if (!commitStarted) await cleanUpBeforeMarker(err);
    // If commitStarted, leave journal for recovery on next load.
    //
    // T-494: the PHASE is part of the answer, not an implementation detail. A
    // pre-commit failure wrote nothing and a retry is correct; a post-commit
    // failure may have renamed some targets already, forward recovery will
    // complete the rest at the next lock acquisition, and a retry of the same
    // create would produce a DUPLICATE on top of the recovered one. A caller
    // told only "Transaction failed" cannot tell those apart and will retry.
    //
    // THE PHASE CHECK COMES FIRST, and the order is the whole point. Putting it
    // after the `ProjectLoaderError` passthrough (which is where it was) meant
    // the most reachable post-commit failure of all skipped it: mid-commit lock
    // fencing throws a `ProjectLoaderError` from inside the rename loop, so a
    // caller lost the ruling id and the do-not-retry warning in exactly the
    // case that most needs them.
    throw new TransactionRecoveryPendingError(err, markerDurable ? "committed" : "marker-unconfirmed");
  }

  // 7. ISS-1399: outside the catch above, so this outcome is never reported
  // as recovery pending. Skipped when a lost lock kept the journal.
  if (journalRemoved) {
    try {
      await syncDir(wrapDir);
    } catch (err) {
      throw new TransactionCommittedUnconfirmedError(err);
    }
  }
}

/** ISS-1399: the commit marker's sidecar, renamed over `.txn.json` (the Mac app's NativeTransaction writes the same name). */
const TXN_MARKER_SIDECAR = ".txn.json.marker.tmp";

/** fencedUnlink that treats an already-missing file as removed. */
async function fencedUnlinkIfPresent(path: string): Promise<void> {
  try {
    await fencedUnlink(path);
  } catch (err) {
    const code =
      err instanceof ProjectLoaderError
        ? (err.cause as NodeJS.ErrnoException | undefined)?.code
        : (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
}

/** ISS-1399: syncs each distinct parent directory of `paths`, in first-seen order. */
async function syncParents(paths: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  for (const path of paths) {
    const dir = dirname(path);
    if (seen.has(dir)) continue;
    seen.add(dir);
    await syncDir(dir);
  }
}

/**
 * Executes multiple file operations atomically with a transaction journal.
 * Acquires the project lock, then delegates to runTransactionUnlocked.
 */
export async function runTransaction(
  root: string,
  operations: Array<
    | { op: "write"; target: string; content: string }
    | { op: "delete"; target: string }
  >,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await runTransactionUnlocked(root, operations);
  });
}

/**
 * Forward-only transaction recovery based on filesystem truth.
 * Called during loadProject before reading data.
 */
/** Internal recovery -- must be called under lock or when no concurrent access is possible. */
async function doRecoverTransaction(wrapDir: string): Promise<void> {
  const journalPath = join(wrapDir, ".txn.json");

  // ISS-942 v4: only ENOENT means "absent, nothing to recover" or "already
  // handled". Any other error (permissions, transient I/O) is preserved and
  // thrown rather than silently treated as success -- a real error here used
  // to be misread as "already applied", discarding a genuinely-pending write.
  async function probeExists(path: string, what: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new ProjectLoaderError(
        "io_error",
        `Transaction recovery failed probing ${what}; journal and temp file(s) preserved for retry`,
        err,
      );
    }
  }

  let entries: TxnEntry[];
  let commitStarted = false;

  let raw: string;
  try {
    raw = await readFile(journalPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing to recover
    throw new ProjectLoaderError("io_error", "Transaction recovery failed reading journal; journal preserved for retry", err);
  }

  // ISS-1399: a commit marker sidecar is never read. A crash before its rename
  // left the false journal (rolled back below); after it, the true journal
  // (finished below). Removed here only beside a journal, so a load with no
  // journal does no new work; one that cannot be removed is left for the next
  // transaction, which removes it before writing its own.
  try {
    await fencedUnlinkIfPresent(join(wrapDir, TXN_MARKER_SIDECAR));
  } catch (err) {
    if (isProjectLockFencingError(err)) throw err;
  }

  // ISS-1399: a directory barrier in recovery; a failure keeps the journal.
  async function syncOrThrow(dirs: () => Promise<void>, what: string): Promise<void> {
    try {
      await dirs();
    } catch (err) {
      throw new ProjectLoaderError("io_error", `Transaction recovery failed syncing ${what}; journal preserved for retry`, err);
    }
  }
  // ISS-1399: the `.story` barrier after the journal is removed. The recovery
  // is complete; only the removal's durability is unconfirmed.
  async function syncAfterRemoval(): Promise<void> {
    try {
      await syncDir(wrapDir);
    } catch (err) {
      throw new ProjectLoaderError("io_error", "Transaction recovery completed, but the removal of its journal could not be confirmed durable; the command can be rerun", err);
    }
  }

  // ISS-942 code-review fix: a malformed-journal delete that fails for a
  // non-ENOENT reason must NOT be swallowed as success -- that would leave
  // `.txn.json` behind while the caller believes recovery is done, the exact
  // silent-discard shape this whole hardening pass exists to remove. Routed
  // through fencedUnlink so recovery's own deletes are fenced identically to
  // every other choke point (defense-in-depth once ownership is lost, e.g. to
  // manual intervention or the accepted signature-collision residual).
  async function unlinkJournalOrThrow(what: string): Promise<void> {
    try {
      await fencedUnlink(journalPath);
    } catch (err) {
      if (err instanceof ProjectLoaderError) {
        const code = (err.cause as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") return;
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ProjectLoaderError("io_error", `Transaction recovery failed removing ${what}; journal preserved for retry`, err);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Genuinely malformed (unparseable) journal -- nothing recoverable from
    // garbage; still fail closed if the cleanup delete itself errors for a
    // real reason rather than silently reporting success.
    await unlinkJournalOrThrow("malformed journal");
    return;
  }

  // Support both old format (TxnEntry[]) and new format (TxnJournal)
  if (Array.isArray(parsed)) {
    // Legacy format: array of entries, no commitStarted marker
    // Assume commit may have started (conservative -- complete forward)
    entries = parsed as TxnEntry[];
    commitStarted = true;
  } else if (
    parsed != null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).entries) &&
    typeof (parsed as Record<string, unknown>).commitStarted === "boolean"
  ) {
    const journal = parsed as TxnJournal;
    entries = journal.entries;
    commitStarted = journal.commitStarted;
  } else {
    // Malformed journal shape -- delete and return
    await unlinkJournalOrThrow("malformed-shape journal");
    return;
  }

  if (!commitStarted) {
    // Commit never started -- safe to clean up temps and remove journal.
    // Fenced throughout (ISS-942 code-review fix): these are our own
    // prepared-but-never-committed artifacts, so fencing costs nothing here
    // and keeps every destructive syscall in this function under the same
    // ownership check, not just the forward-recovery path.
    for (const entry of entries) {
      if (entry.op === "write" && entry.tempPath && (await probeExists(entry.tempPath, entry.tempPath))) {
        try {
          await fencedUnlink(entry.tempPath);
        } catch (err) {
          const code =
            err instanceof ProjectLoaderError
              ? (err.cause as NodeJS.ErrnoException | undefined)?.code
              : (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            if (err instanceof ProjectLoaderError) throw err;
            throw new ProjectLoaderError(
              "io_error",
              `Transaction recovery failed removing prepared temp ${entry.tempPath}; journal and temp file(s) preserved for retry`,
              err,
            );
          }
        }
      }
    }
    // Every temp's directory, including temps an earlier run already removed.
    await syncOrThrow(() => syncParents(entries.flatMap((entry) => (entry.op === "write" && entry.tempPath ? [entry.tempPath] : []))), "the temp directories");
    await unlinkJournalOrThrow("journal");
    await syncAfterRemoval();
    return;
  }

  // commitStarted=true -- complete the transaction forward. On any non-ENOENT
  // failure applying an entry (including lock-ownership loss, fenced below),
  // stop recovering immediately: do not unlink that temp, do not process
  // remaining entries, do not delete the journal.
  //
  // ISS-1399: the true journal may come from a marker rename whose `.story`
  // sync failed or never ran (a CLI marker-unconfirmed run, or a Mac app
  // crash). Until that rename is durable a power loss mid-replay could bring
  // back the false journal over targets already renamed, and the next
  // recovery would roll back the rest. Nothing is replayed until it is.
  await syncOrThrow(() => syncDir(wrapDir), "the commit marker");
  for (const entry of entries) {
    if (entry.op === "write" && entry.tempPath) {
      const tempExists = await probeExists(entry.tempPath, entry.tempPath);
      if (tempExists) {
        // Temp still exists -- complete the rename (whether or not target
        // exists). A successful rename moves the temp away; nothing further
        // to clean up. A failure means the write is still pending: preserve
        // both the temp and the journal and fail loudly instead of silently
        // discarding it.
        try {
          checkProjectLockFencing();
          await rename(entry.tempPath, entry.target);
        } catch (err) {
          if (err instanceof ProjectLoaderError) throw err;
          throw new ProjectLoaderError(
            "io_error",
            `Transaction recovery failed applying ${entry.target}; journal and temp file(s) preserved for retry`,
            err,
          );
        }
      }
      // tempExists === false (ENOENT): a prior attempt already applied it --
      // nothing to do.
    } else if (entry.op === "delete") {
      // Replay delete entries that didn't complete.
      try {
        await fencedUnlink(entry.target);
      } catch (err) {
        const code =
          err instanceof ProjectLoaderError
            ? (err.cause as NodeJS.ErrnoException | undefined)?.code
            : (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          if (err instanceof ProjectLoaderError) throw err;
          throw new ProjectLoaderError(
            "io_error",
            `Transaction recovery failed applying delete of ${entry.target}; journal and temp file(s) preserved for retry`,
            err,
          );
        }
        // ENOENT: target already gone -- that's fine.
      }
    }
  }

  // ISS-1399: every target's directory, not only what this run changed: an
  // earlier commit or recovery may have renamed or deleted it without its
  // directory reaching disk.
  await syncOrThrow(() => syncParents(entries.map((entry) => entry.target)), "the target directories");

  // Delete journal -- only reached once every entry above has genuinely
  // succeeded (or was already applied).
  await unlinkJournalOrThrow("journal after successful replay");
  await syncAfterRemoval();
}

/**
 * Internal load without lock acquisition or recovery -- used by deleteTicket
 * which already holds the lock.
 */
/** T-538 S2: the manifest a setup bootstrap keeps until `config.json` is published (plan v5 1b). */
export const SETUP_BOOTSTRAP_MANIFEST = ".setup-bootstrap.json";

/**
 * A `.story` holding a setup bootstrap manifest and no `config.json` is a
 * setup being bootstrapped, not a project: refuse with how to resume it.
 */
async function refuseWhileSetupBootstrapping(wrapDir: string): Promise<void> {
  if (existsSync(join(wrapDir, "config.json"))) return;
  let raw: string;
  try {
    raw = await readFile(join(wrapDir, SETUP_BOOTSTRAP_MANIFEST), "utf-8");
  } catch {
    return;
  }
  let setupId = "(unreadable manifest)";
  try {
    const parsed = JSON.parse(raw) as { setupId?: unknown };
    if (typeof parsed.setupId === "string") setupId = parsed.setupId;
  } catch { /* named below as unreadable */ }
  throw new ProjectLoaderError(
    "setup_bootstrapping",
    `Setup ${setupId} is bootstrapping this project; run storybloq setup-apply --resume --setup ${setupId}.`,
  );
}

async function loadProjectUnlocked(absRoot: string): Promise<LoadResult> {
  const wrapDir = join(absRoot, ".story");
  await refuseWhileSetupBootstrapping(wrapDir);
  const config = await loadSingletonFile<Config>("config.json", wrapDir, absRoot, ConfigSchema);
  const roadmap = await loadSingletonFile<Roadmap>("roadmap.json", wrapDir, absRoot, RoadmapSchema);
  const warnings: LoadWarning[] = [];
  const fileClassifications = new Map<string, "legacy" | "team">();
  const omittedTickets: OmittedTicketRecord[] = [];
  const tickets = await loadDirectory<Ticket>(join(wrapDir, "tickets"), absRoot, TicketSchema, warnings, "ticket", fileClassifications, { omitted: omittedTickets });
  const issues = await loadDirectory<Issue>(join(wrapDir, "issues"), absRoot, IssueSchema, warnings, "issue", fileClassifications);
  const notes = await loadDirectory<Note>(join(wrapDir, "notes"), absRoot, NoteSchema, warnings, "note", fileClassifications);
  const lessons = await loadDirectory<Lesson>(join(wrapDir, "lessons"), absRoot, LessonSchema, warnings, "lesson", fileClassifications);
  const handoverFilenames = await listHandovers(join(wrapDir, "handovers"), absRoot, warnings);
  const state = new ProjectState({ tickets, issues, notes, lessons, roadmap, config, handoverFilenames, omittedTickets });
  return { state, warnings, fileClassifications };
}

// --- Filename Classification ---

type EntityType = "ticket" | "issue" | "note" | "lesson";

const LEGACY_FILENAME_REGEXES: Record<EntityType, RegExp> = {
  ticket: /^T-\d+[a-z]?\.json$/,
  issue: /^ISS-\d+\.json$/,
  note: /^N-\d+\.json$/,
  lesson: /^L-\d+\.json$/,
};

// ISS-703: canonical-ID char class derived from the single CROCKFORD_CLASS source.
const TEAM_FILENAME_REGEXES: Record<EntityType, RegExp> = {
  ticket: new RegExp(`^t-${CROCKFORD_CLASS}{16}\\.json$`),
  issue: new RegExp(`^i-${CROCKFORD_CLASS}{16}\\.json$`),
  note: new RegExp(`^n-${CROCKFORD_CLASS}{16}\\.json$`),
  lesson: new RegExp(`^l-${CROCKFORD_CLASS}{16}\\.json$`),
};

const CANONICAL_ID_REGEXES: Record<EntityType, RegExp> = {
  ticket: TICKET_CANONICAL_ID_REGEX,
  issue: ISSUE_CANONICAL_ID_REGEX,
  note: NOTE_CANONICAL_ID_REGEX,
  lesson: LESSON_CANONICAL_ID_REGEX,
};

const LEGACY_ID_REGEXES: Record<EntityType, RegExp> = {
  ticket: TICKET_ID_REGEX,
  issue: ISSUE_ID_REGEX,
  note: NOTE_ID_REGEX,
  lesson: LESSON_ID_REGEX,
};

export function classifyFilename(
  filename: string,
  entityType: EntityType,
): "legacy" | "team" | null {
  if (LEGACY_FILENAME_REGEXES[entityType].test(filename)) return "legacy";
  if (TEAM_FILENAME_REGEXES[entityType].test(filename)) return "team";
  return null;
}

function classifyId(id: string, entityType: EntityType): "legacy" | "team" | null {
  if (LEGACY_ID_REGEXES[entityType].test(id)) return "legacy";
  if (CANONICAL_ID_REGEXES[entityType].test(id)) return "team";
  return null;
}

// --- Internal Helpers ---

async function loadSingletonFile<T>(
  filename: string,
  wrapDir: string,
  root: string,
  schema: ZodType<T>,
): Promise<T> {
  const filePath = join(wrapDir, filename);
  const relPath = relative(root, filePath);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectLoaderError("not_found", `File not found: ${relPath}`);
    }
    throw new ProjectLoaderError(
      "io_error",
      `Cannot read file: ${relPath}`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProjectLoaderError(
      "validation_failed",
      `Invalid JSON in ${relPath}`,
      err,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ProjectLoaderError(
      "validation_failed",
      `Validation failed for ${relPath}: ${result.error.issues.map((i) => i.message).join("; ")}`,
      result.error,
    );
  }
  return result.data;
}

async function loadDirectory<T>(
  dirPath: string,
  root: string,
  schema: ZodType<T>,
  warnings: LoadWarning[],
  entityType: EntityType,
  classifications: Map<string, "legacy" | "team">,
  extras: { signal?: AbortSignal; files?: string[]; omitted?: OmittedTicketRecord[] } = {},
): Promise<T[]> {
  extras.signal?.throwIfAborted();
  if (!existsSync(dirPath)) return [];

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (err) {
    throw new ProjectLoaderError(
      "io_error",
      `Cannot enumerate ${relative(root, dirPath)}`,
      err,
    );
  }

  // Sort lexicographically for deterministic collision handling
  entries.sort();

  const entityDir = basename(dirPath);
  const results: T[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (extname(entry) !== ".json") continue;
    // T-486 U2-3: outside the try, so an abort is never recorded as a parse error.
    extras.signal?.throwIfAborted();

    const filePath = join(dirPath, entry);
    const relPath = relative(root, filePath);

    let stage: "read" | "parse" = "read";
    try {
      const raw = await readFile(filePath, "utf-8");
      stage = "parse";
      const parsed = JSON.parse(raw);
      const result = schema.safeParse(parsed);
      if (!result.success) {
        warnings.push({
          file: relPath,
          message: result.error.issues.map((i) => i.message).join("; "),
          type: "schema_error",
        });
        extras.omitted?.push({ file: relPath, reason: "schema", ...recoverableIdentity(parsed) });
        continue;
      }
      const data = result.data as Record<string, unknown>;
      if (typeof data.id === "string") {
        const stem = basename(entry, ".json");
        const stemMatchesId = stem === data.id;
        if (!stemMatchesId) {
          warnings.push({
            file: relPath,
            message: filenameIdMismatchMessage(stem, data.id),
            type: "filename_id_mismatch",
          });
        }

        if (stemMatchesId) {
          const fileClass = classifyFilename(entry, entityType);
          const idClass = classifyId(data.id as string, entityType);

          if (fileClass && idClass && fileClass !== idClass) {
            warnings.push({
              file: relPath,
              message: `Filename classified as ${fileClass} but id "${data.id}" classified as ${idClass}`,
              type: "filename_classification_mismatch",
            });
          } else if (fileClass) {
            classifications.set(`${entityDir}/${entry}`, fileClass);
            if (fileClass === "legacy" && data.displayId == null) {
              (data as Record<string, unknown>).displayId = data.id;
            }
          }
        }
      }
      results.push(result.data);
      extras.files?.push(relPath);
    } catch (err) {
      warnings.push({
        file: relPath,
        message: err instanceof Error ? err.message : String(err),
        type: "parse_error",
      });
      extras.omitted?.push({ file: relPath, reason: stage, parentage: "unknown" });
    }
  }

  return results;
}

/** The id and parentTicket a refused record exposes as strings, if any, and its parentage (B1). */
function recoverableIdentity(parsed: unknown): Pick<OmittedTicketRecord, "id" | "parentTicket" | "parentage"> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { parentage: "unknown" };
  const raw = parsed as Record<string, unknown>;
  const parent = raw.parentTicket;
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof parent === "string" ? { parentTicket: parent } : {}),
    parentage: typeof parent === "string" ? "ref" : parent == null ? "root" : "unknown",
  };
}

/** Deep-sorts object keys recursively for deterministic JSON output. */
export function sortKeysDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);

  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeysDeep(obj[key]);
  }
  return sorted;
}

/** Serializes to pretty-printed JSON with deep-sorted keys. */
export function serializeJSON(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj), null, 2) + "\n";
}

/**
 * Atomic create: write to temp file, then link (fails if target exists).
 * Returns the device and inode of the created file, so a caller can tell it
 * apart from another file that later takes the same name.
 */
export async function atomicCreate(
  targetPath: string,
  content: string | Uint8Array,
): Promise<{ dev: number; ino: number }> {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: import("node:fs/promises").FileHandle | undefined;
  try {
    fd = await open(tempPath, "wx", 0o600);
    await fd.writeFile(content, "utf-8");
    await fd.sync();
    const { dev, ino } = await fd.stat();
    await fd.close();
    fd = undefined;
    checkProjectLockFencing();
    await link(tempPath, targetPath);
    recordBoardTarget(targetPath, "write");
    try {
      const parentFd = await open(dirname(targetPath), "r");
      try { await parentFd.sync(); } finally { await parentFd.close(); }
    } catch (syncErr) {
      // The link already committed the create. A platform that refuses to
      // open or sync a directory handle (Windows answers EPERM, some
      // filesystems EINVAL or ENOTSUP) must not turn a published create into
      // a reported failure, which a retrying caller answers with a duplicate
      // id. Any other error (EIO, ENOSPC) still surfaces: the entry may not
      // be durable and the caller must know.
      if (!DIRECTORY_SYNC_UNSUPPORTED_CODES.has((syncErr as NodeJS.ErrnoException).code ?? "")) throw syncErr;
    }
    return { dev, ino };
  } catch (err) {
    if (err instanceof ProjectLoaderError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ProjectLoaderError(
        "file_exists",
        `File already exists: ${basename(targetPath)}`,
        err,
      );
    }
    throw new ProjectLoaderError(
      "io_error",
      `Failed to create ${basename(targetPath)}`,
      err,
    );
  } finally {
    if (fd) { try { await fd.close(); } catch { /* ignore */ } }
    try { await unlink(tempPath); } catch { /* best-effort temp cleanup */ }
  }
}

/** Atomic write: write to temp file, then rename (overwrites). */
export async function atomicWrite(
  targetPath: string,
  content: string,
): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, "utf-8");
    checkProjectLockFencing();
    await rename(tempPath, targetPath);
    recordBoardTarget(targetPath, "write");
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      /* ignore cleanup errors */
    }
    if (err instanceof ProjectLoaderError) throw err;
    throw new ProjectLoaderError(
      "io_error",
      `Failed to write ${basename(targetPath)}`,
      err,
    );
  }
}

/**
 * Fenced unlink: verifies the ambient lock (if any) still owns `.story/.lock`
 * immediately before removing `targetPath`. ISS-942 v6 choke point alongside
 * atomicWrite/atomicCreate, for direct-delete paths that don't go through
 * either (hard-deletes, gc tombstone removal, transaction journal/temp-file
 * cleanup in both the commit path and recovery).
 */
export async function fencedUnlink(targetPath: string): Promise<void> {
  checkProjectLockFencing();
  await unlink(targetPath);
}

/**
 * Fenced link: verifies the ambient lock (if any) still owns `.story/.lock`
 * immediately before linking `tempPath` onto `targetPath`. ISS-942 v6 choke
 * point alongside atomicWrite/atomicCreate, for direct-link paths (team
 * handover creation) that don't go through either.
 */
export async function fencedLink(tempPath: string, targetPath: string): Promise<void> {
  checkProjectLockFencing();
  await link(tempPath, targetPath);
}

/**
 * Write with fsync for durability (used for journal files). `onOpen` runs once
 * the open succeeded and before any byte is written (ISS-1399: the caller
 * owns the file from then on, so a later failure still removes it).
 */
async function fsyncWrite(
  filePath: string,
  content: string,
  exclusive = false,
  onOpen?: () => void,
): Promise<void> {
  // Transaction staging must never follow a preplanted link or truncate a
  // preexisting file. Journal rewrites also reject links (ISS-1155 review).
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW |
    (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC);
  const fh = await open(filePath, flags);
  onOpen?.();
  try {
    await fh.writeFile(content, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Symlink protection: resolve both root and target parent via realpath,
 * verify target is under root. On existing targets, lstat to reject symlinks.
 */
/**
 * ISS-1297: the real path of `dir`, resolved from its nearest existing
 * ancestor when `dir` (or a parent) does not exist yet, with the missing
 * segments re-appended. Comparing the unresolved path instead calls a root
 * reached through a symlink an escape, and misses a symlink to an outside
 * directory above the missing part (the Mac app's rule, ISS-286, ISS-355).
 * Any other failure keeps the unresolved path, as before.
 */
async function resolveFromNearestAncestor(dir: string): Promise<string> {
  const missing: string[] = [];
  let current = dir;
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) return dir;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export async function guardPath(
  target: string,
  root: string,
): Promise<void> {
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
  } catch {
    throw new ProjectLoaderError(
      "invalid_input",
      `Cannot resolve project root: ${root}`,
    );
  }

  const resolvedDir = await resolveFromNearestAncestor(dirname(target));

  const rel = relative(resolvedRoot, resolvedDir);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Path ${target} resolves outside project root`,
    );
  }

  // If target already exists, reject symlinks
  if (existsSync(target)) {
    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        throw new ProjectLoaderError(
          "invalid_input",
          `Symlink target rejected: ${target}`,
        );
      }
    } catch (err) {
      if (err instanceof ProjectLoaderError) throw err;
      // lstat failed for other reason -- continue
    }
  }
}

// ISS-942: the ambient lock handle, propagated to atomicWrite/atomicCreate/
// fencedUnlink/fencedLink/runTransactionUnlocked via AsyncLocalStorage so they
// can fence their commit syscall without changing withLock's ~13 internal call
// sites or withProjectLock/runTransactionUnlocked's external ones.
const projectLockContext = new AsyncLocalStorage<ProjectLockHandle>();
/** T-486 A4/B6: the resolution-write contexts of the locks this async flow holds, innermost last. */
const resolutionContextChain = new AsyncLocalStorage<readonly ResolutionWriteContext[]>();
/**
 * Marker carried as the `cause` of every fencing error, so a caller can tell
 * "the lock was lost before this commit syscall" from any other io_error
 * without comparing message text.
 */
const PROJECT_LOCK_FENCING_CAUSE: unique symbol = Symbol("project-lock-fencing");

/** Error codes a platform answers when a directory handle cannot be opened or synced at all. */
const DIRECTORY_SYNC_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EINVAL", "ENOTSUP"]);

function isProjectLockFencingError(err: unknown): err is ProjectLoaderError {
  return err instanceof ProjectLoaderError && err.cause === PROJECT_LOCK_FENCING_CAUSE;
}

/**
 * Fencing check for a commit syscall: does the ambient lock (if any) still
 * verifiably own `.story/.lock`? Throws on loss so the caller's write never
 * lands. When no handle is in scope (a caller not running under withLock --
 * shouldn't happen for any real call site, but defensive), the check is
 * skipped, matching runTransactionUnlocked's existing "caller must hold the
 * lock" contract.
 */
function checkProjectLockFencing(): void {
  const handle = projectLockContext.getStore();
  if (!handle) return;
  if (!verifyProjectLockOwnership(handle)) {
    throw new ProjectLoaderError("io_error", "Lock ownership lost before commit; write was not applied", PROJECT_LOCK_FENCING_CAUSE);
  }
}

/**
 * T-538 S2: runs `fn` outside any held project lock's context, as another
 * process would, so a locked call started in it waits for the lock instead
 * of failing with nested_lock. For work started under a lock that is meant
 * to wait for it (a test standing in for a second process), never awaited
 * by the holder.
 */
export function outsideProjectLock<T>(fn: () => T): T {
  return projectLockContext.exit(() => resolutionContextChain.exit(fn));
}

/**
 * T-538 S2: holds the project lock on a folder that may not be an
 * initialized project yet (setup's bootstrap, plan v5 1b). Every write inside
 * `fn` is fenced like any other locked write; nothing is loaded.
 */
export async function withBootstrapLock<T>(root: string, fn: () => Promise<T>, options: { deadlineMs?: number } = {}): Promise<T> {
  return withLock(join(resolve(root), ".story"), fn, options.deadlineMs);
}

/** A lock path with its directory resolved through symlinks (/tmp and /private/tmp are one lock). */
function canonicalLockPath(lockPath: string): string {
  try {
    return join(realpathSync(dirname(lockPath)), basename(lockPath));
  } catch {
    return resolve(lockPath);
  }
}

/** Acquires a project lock, executes fn, releases in finally. */
async function withLock<T>(
  wrapDir: string,
  fn: () => Promise<T>,
  deadlineMs?: number,
): Promise<T> {
  const lockPath = join(wrapDir, ".lock");
  // T-538 S2: the lock is not re-entrant, so a locked handler calling another
  // one would wait out the acquisition deadline against itself. Fail at once
  // with a named error instead; the caller should use the unlocked primitive.
  const held = projectLockContext.getStore();
  if (held && canonicalLockPath(held.lockPath) === canonicalLockPath(lockPath) && verifyProjectLockOwnership(held)) {
    throw new ProjectLoaderError(
      "nested_lock",
      `This operation already holds the project lock (${lockPath}); a locked handler called another locked handler. Call its unlocked primitive instead.`,
    );
  }
  const handle = await acquireProjectLockAsync(lockPath, deadlineMs === undefined ? {} : { deadlineMs });
  // T-486 B6: the context exists only after the lock is acquired and is
  // released before the lock is, so detached work cannot outlive it.
  const ctx = createResolutionWriteContext(dirname(resolve(wrapDir)), undefined, () => verifyProjectLockOwnership(handle));
  const chain = resolutionContextChain.getStore() ?? [];
  try {
    return await projectLockContext.run(handle, () => resolutionContextChain.run([...chain, ctx], fn));
  } finally {
    ctx.release();
    releaseProjectLock(handle);
  }
}
