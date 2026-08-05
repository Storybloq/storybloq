import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  rmSync,
  statSync,
  lstatSync,
  type Stats,
  truncateSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import lockfile from "proper-lockfile";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  parseSessionState,
  deriveWorkspaceId,
  type FullSessionState,
  type SessionState,
  type EventEntry,
} from "./session-types.js";
import { describeSchemaIssues, summarizeZodIssues, type SchemaIssue } from "../core/zod-issues.js";
import { withStalenessNote } from "./binary-staleness.js";
import {
  isContainedSessionDir,
  probeContainment,
  SESSION_ID_REGEX,
  type IncompatibleCause,
} from "./session-selector.js";
import { toPersistedBranchStrategy } from "./branch-strategy.js";
import { currentMcpServerPid, mcpProcessRole } from "./liveness.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long an owner's lease fence lasts. Exported since T-450 step 7b: the
 * candidate takeover publishes a NEW owner and has to stamp that owner's fence
 * in the same atomic write, so it needs the one policy value rather than a
 * second copy of it.
 */
export const LEASE_DURATION_MS = 45 * 60 * 1000; // 45 minutes
const SESSIONS_DIR = "sessions";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function sessionsRoot(root: string): string {
  return join(root, ".story", SESSIONS_DIR);
}

export function sessionDir(root: string, sessionId: string): string {
  return join(sessionsRoot(root), sessionId);
}

function statePath(dir: string): string {
  return join(dir, "state.json");
}

function eventsPath(dir: string): string {
  return join(dir, "events.log");
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/** Create a new session directory and write initial state.json. */
export interface SessionConfig {
  maxTicketsPerSession?: number;
  compactThreshold?: string;
  reviewBackends?: string[];
  codexReviewBackends?: string[];
  mode?: "auto" | "review" | "plan" | "guided";
  handoverInterval?: number;
  stageOverrides?: Record<string, Record<string, unknown>>;
  /** T-328: accepted input; normalized to a canonical BranchStrategy by resolveRecipe. */
  branchStrategy?: string;
}

/** Create a new session directory and write initial state.json. */
export function createSession(
  root: string,
  recipe: string,
  workspaceId: string,
  configOverrides?: SessionConfig,
): FullSessionState {
  const id = randomUUID();
  const dir = sessionDir(root, id);
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const state: FullSessionState = {
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    sessionId: id,
    recipe,
    state: "INIT",
    revision: 0,
    status: "active",
    mode: configOverrides?.mode ?? "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    finalizedItem: null,
    git: { branch: null, mergeBase: null },
    lease: {
      workspaceId,
      lastHeartbeat: now,
      expiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString(),
    },
    contextPressure: {
      level: "low",
      guideCallCount: 0,
      ticketsCompleted: 0,
      compactionCount: 0,
      eventsLogBytes: 0,
      workItemsAtLastCompaction: 0,
      eventsLogBytesAtLastCompaction: 0,
    },
    contextRotation: null,
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    compactObservedAt: null,
    resumeBlocked: false,
    lastCheckpointWorkCount: 0,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: {
      maxTicketsPerSession: configOverrides?.maxTicketsPerSession ?? 0,
      compactThreshold: configOverrides?.compactThreshold ?? "high",
      reviewBackends: configOverrides?.reviewBackends ?? ["codex", "agent"],
      codexReviewBackends: configOverrides?.codexReviewBackends,
      handoverInterval: configOverrides?.handoverInterval ?? 3,
    },
  };

  writeSessionSync(dir, state);
  return state;
}

/**
 * Is `dir` GENUINELY absent, as opposed to present and unusable? (ISS-897)
 *
 * Exported because every layer that distinguishes not-found from broken needs
 * the SAME test. `session report` had its own `existsSync` precheck in front of
 * the reader, so fixing only the reader left the command answering not-found
 * before the reader could be consulted -- the fix was real and unreachable.
 *
 * `existsSync` follows symlinks and returns false for a dangling one, so it
 * cannot tell "no session was ever created here" from "a session directory is
 * right there and its link target is gone". That difference decides between
 * `missing` -- which every caller reports as an ordinary not-found -- and
 * `unreadable`, which is what sends an operator to look at the path. Reporting
 * a broken link as not-found is the same concealment ISS-897 closes one level
 * up for `.story/sessions` itself.
 *
 * `lstat` does not follow, so a SUCCESSFUL call proves presence -- a dangling
 * link and a plain directory alike. ENOENT may prove absence, but only after
 * the ancestor walk below establishes that the ENOENT is about this path rather
 * than an unresolvable level above it. Any other error (EACCES, EIO) proves
 * NEITHER, and folding those into "present" is what made callers claim an entry
 * exists over a probe that could not look.
 */
export type PathPresence = "absent" | "present" | "probe-failed";

export function probePath(dir: string): PathPresence {
  try {
    lstatSync(dir);
    return "present";
  } catch (err) {
    // EACCES and EIO prove nothing in either direction, and folding them into
    // "present" made every caller render "an entry exists at that path" over a
    // probe that could not look. They fail closed -- not-absent, so the reader
    // runs and reports the failure -- but they must not be described as
    // presence.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "probe-failed";
    // ENOENT still does not prove absence on its own, and this is the part that
    // is easy to get wrong: `lstat` declines to follow the FINAL component and
    // follows every component before it. So `lstat(".story/sessions/xyz")`
    // raises ENOENT when `xyz` is genuinely gone AND when `.story/sessions` is
    // itself a dangling symlink or has been removed -- the same errno for "this
    // one session is not here" and "the whole collection is unusable". Callers
    // that skip on a proven absence would skip EVERY entry, in silence, over a
    // sessions root that no longer resolves.
    //
    // So the parent has to answer too. Only a parent that is still a real
    // directory makes the child's ENOENT a statement about the child.
    return ancestorsSupportAbsence(dir) ? "absent" : "probe-failed";
  }
}

/**
 * Do this path's ANCESTORS support a claim that it is absent? (ISS-897)
 *
 * Walking up, not one step. One step is what the first version of this did, and
 * it was defeated by the same ambiguity it was written to resolve: `lstat`
 * follows every component before the last, so a dangling `.story` makes
 * `lstat(".story/sessions/<id>")` raise ENOENT AND `lstat(".story/sessions")`
 * raise ENOENT, and a check that accepts the second as proof has proven nothing
 * at all. The walk continues through ENOENT ancestors until it reaches one that
 * exists, because only an existing ancestor can say what the missing ones mean.
 *
 * The verdict at the first existing ancestor:
 *  - a DIRECTORY -> absence proven. A SYMLINK is followed once here, and only
 *    here: a symlinked `.story/sessions` is a supported layout, so refusing to
 *    resolve it would report every genuinely absent session in such a project
 *    as unreadable. Following the FINAL component of the path is what `lstat`
 *    is avoiding; following an ANCESTOR is what every read of that path does
 *    anyway. Every component below it is genuinely not
 *    there, which is what `.story/sessions` not existing yet looks like on a
 *    project that has never run a session.
 *  - anything else -> unprovable. A dangling symlink `lstat`s successfully with
 *    `isDirectory()` false, and a file cannot contain the path below it either;
 *    in both cases the ENOENT came from an unresolvable ancestor rather than
 *    from the thing being asked about.
 *  - an error that is not ENOENT -> unprovable, for the same reason a probe
 *    that cannot look never establishes anything.
 *
 * Reaching the filesystem root with every level absent counts as proven: there
 * is no ancestor left that could be hiding something.
 */
function ancestorsSupportAbsence(path: string): boolean {
  let current = path;
  for (;;) {
    const parent = dirname(current);
    // `dirname` of a root is the root itself; nothing above it to consult.
    if (parent === current) return true;
    let info: Stats;
    try {
      info = lstatSync(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      // This ancestor is missing too, which is exactly as ambiguous as the
      // child was. Keep climbing.
      current = parent;
      continue;
    }
    if (info.isDirectory()) return true;
    if (!info.isSymbolicLink()) return false;
    // A symlink, resolved in its OWN try. Folding it into the one above would
    // read a dangling link's ENOENT as "this ancestor is missing, keep
    // climbing" -- but a dangling link is present and unresolvable, which is
    // the one shape that proves nothing and the exact case this walk exists to
    // separate out.
    try {
      return statSync(parent).isDirectory();
    } catch {
      return false;
    }
  }
}

/** Fail-closed convenience: only a PROVEN absence counts as absent. */
export function pathIsAbsent(dir: string): boolean {
  return probePath(dir) === "absent";
}

/**
 * Read and validate session state, KEEPING the reason it failed (ISS-897).
 *
 * `readSession` below throws that reason away and every caller then reports the
 * constant string "corrupt or unreadable", which N-097 called the worst DX
 * moment in the product: an operator has no way to learn WHICH field failed
 * short of extracting the zod schema by hand. The failure detail zod already
 * produces is carried here so `session list`, `session show`, and
 * `session report` can name the field, the expected type, and what was there.
 *
 * STRICT, like `readSession`: it does NOT apply ISS-556's lensReviewHistory
 * recovery, because the diagnostic and admin paths that use it are exactly where
 * an operator should SEE corruption rather than have it quietly worked around.
 * "Worked around" and not "repaired": that recovery substitutes in memory and
 * writes nothing back, so the bytes on disk are exactly as wrong on the next
 * read, and a diagnostic tool that hid them would be reporting a state no file
 * is in.
 */
export function readSessionStrict(
  dir: string,
): { ok: true; state: FullSessionState } | { ok: false; failure: SessionLookupFailure } {
  const path = statePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    // ENOENT on `state.json` is ambiguous: the session directory may be absent
    // entirely, or present with the file gone. Only the second is `missing-state`
    // -- calling the first "corrupt" invents damage where the caller simply
    // asked for a session that was never created or has been cleaned up.
    const presence = probePath(dir);
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && presence === "absent") {
      return { ok: false, failure: { kind: "missing" } };
    }
    return {
      ok: false,
      failure: {
        kind: "unreadable",
        // `missing-state` claims an entry IS there, so it is reserved for a probe
        // that proved it. A probe that could not look (EACCES, EIO) proves
        // nothing in either direction and must not borrow that claim.
        reason:
          (err as NodeJS.ErrnoException).code === "ENOENT" && presence === "present"
            ? "missing-state"
            : "unreadable-file",
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, failure: { kind: "unreadable", reason: "invalid-json" } };
  }

  // The version fence runs BEFORE schema parse, exactly as in
  // `readSessionDetailed`, and it must (ISS-897). Without it a session written
  // by a newer build fails `safeParse` and arrives at every caller as ordinary
  // corruption -- so `session list` labels an UNINTERPRETED session `corrupt` and
  // `session show` offers to delete it. The remedy for a version skew is to
  // upgrade the reader; being told to delete the session is the opposite of it,
  // and it is unrecoverable.
  //
  // Fires on a writer NEWER than this reader (`version-skew`) and, separately,
  // on any PRESENT version this build does not support (`unsupported-version`).
  // Only an ABSENT `schemaVersion` still reaches the schema: that is the
  // documented legacy shape. A present-but-wrong value used to fall through and
  // be reported as a field-level `schema` failure, whose remedy is "delete it or
  // edit it by hand" -- the opposite of what the scanner says about the same
  // file, and the destructive one of the two.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const writerVersion = (parsed as Record<string, unknown>).schemaVersion;
    // PRESENT and unsupported, but not newer. Reported as its own reason rather
    // than falling through to the schema, so every surface gives the same
    // non-destructive remedy the scanner does for the same file.
    if (
      writerVersion !== undefined &&
      writerVersion !== CURRENT_SESSION_SCHEMA_VERSION &&
      !(typeof writerVersion === "number" && writerVersion > CURRENT_SESSION_SCHEMA_VERSION)
    ) {
      return {
        ok: false,
        failure: { kind: "unreadable", reason: "unsupported-version", rawVersion: writerVersion },
      };
    }
    if (typeof writerVersion === "number" && writerVersion > CURRENT_SESSION_SCHEMA_VERSION) {
      return {
        ok: false,
        failure: {
          kind: "version-skew",
          writerVersion,
          readerVersion: CURRENT_SESSION_SCHEMA_VERSION,
        },
      };
    }
  }

  const result = parseSessionState(parsed);
  if (!result.success) {
    return {
      ok: false,
      failure: {
        kind: "unreadable",
        reason: "schema",
        issues: summarizeZodIssues(result.error),
        issueCount: result.error.issues.length,
      },
    };
  }
  return { ok: true, state: result.data };
}

/**
 * Read and validate session state from a session directory. Returns null on any error.
 *
 * Signature preserved deliberately: roughly forty callers depend on it, and
 * widening it would be a change to all of them for the benefit of the three that
 * actually want the reason. Those three call `readSessionStrict` instead.
 */
export function readSession(dir: string): FullSessionState | null {
  const result = readSessionStrict(dir);
  return result.ok ? result.state : null;
}

/**
 * ISS-556: Like readSession but recovers from ONE specific corruption:
 * lensReviewHistory entries whose `disposition` is outside the enum.
 *
 * Rationale: before the write-side fix, a single bad disposition value on
 * disk wedged every subsequent readSession call. Historical metadata should
 * not make a live session unreachable via MCP. Callers on MCP hot paths route
 * through this helper; CLI/admin paths keep strict readSession so operators
 * see corruption in diagnostic tools.
 *
 * Strict-parse failure on ANY other field (missing required field, null
 * entry, wrong shape anywhere) still returns null. Recovery only triggers
 * when EVERY zod issue points at `lensReviewHistory[N].disposition`.
 * Does NOT mutate state.json; emits one warning line to stderr per recovery.
 */
export function readSessionResilient(dir: string): FullSessionState | null {
  const path = statePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return parseSessionResilient(parsed, dir);
}

/**
 * The parse half of readSessionResilient, split out so a caller that has
 * already decoded state.json can validate that exact snapshot.
 *
 * ISS-902: readSessionDetailed inspects schemaVersion and then validates. If
 * validation re-read the file, an atomic write landing between the two reads
 * would let the fence judge one revision and the schema another, reporting a
 * newer session as corrupt rather than as version-skewed. Both halves now see
 * the same bytes.
 */
function parseSessionResilient(parsed: unknown, dir: string): FullSessionState | null {
  const strict = parseSessionState(parsed);
  if (strict.success) return strict.data;

  // Inspect zod issues: recover only if EVERY issue is specifically an
  // "invalid enum value" at lensReviewHistory[<idx>].disposition. Any other
  // failure (missing field, null/wrong type, unrelated path) → null. This
  // prevents silent recovery when the corruption is structural rather than
  // just an out-of-vocab enum string.
  const badIndices = new Set<number>();
  for (const issue of strict.error.issues) {
    const p = issue.path;
    const isDispositionPath =
      p.length === 3 &&
      p[0] === "lensReviewHistory" &&
      typeof p[1] === "number" &&
      p[2] === "disposition";
    const isInvalidEnumValue = issue.code === "invalid_enum_value";
    if (isDispositionPath && isInvalidEnumValue) {
      badIndices.add(p[1] as number);
    } else {
      return null;
    }
  }
  if (badIndices.size === 0) return null;

  const candidate = parsed as Record<string, unknown>;
  const history = Array.isArray(candidate.lensReviewHistory)
    ? candidate.lensReviewHistory
    : [];
  const cleaned = history.filter((_, idx) => !badIndices.has(idx));
  const retry = parseSessionState({ ...candidate, lensReviewHistory: cleaned });
  if (!retry.success) return null;

  const dropped = badIndices.size;
  process.stderr.write(
    `[storybloq] readSessionResilient: dropped ${dropped} lensReviewHistory ` +
      `entr${dropped === 1 ? "y" : "ies"} with invalid disposition in ${dir}\n`,
  );
  return retry.data;
}


/**
 * ISS-902: the single ENCODE boundary, mirroring branch-strategy.ts's single
 * decode boundary.
 *
 * Only the serialized bytes are downgraded to the legacy spelling; the object
 * returned to callers stays canonical, so nothing in memory has to know that
 * disk and RAM disagree. Doing this here rather than at each assignment site
 * is what makes it total: every state.json write in the process goes through
 * writeSessionSync, so no later code path can reintroduce `"current"` on disk.
 */
function toPersistedSessionState(state: FullSessionState): Record<string, unknown> {
  const strategy = state.resolvedBranchStrategy;
  if (strategy === undefined) return state as unknown as Record<string, unknown>;
  return {
    ...(state as unknown as Record<string, unknown>),
    resolvedBranchStrategy: toPersistedBranchStrategy(strategy),
  };
}

/**
 * Crash-injection seams for the DURABLE state writer below, the same
 * discipline as candidate-recovery's `__intentTesting`: each barrier is
 * followed by an injection point so a suite can stop the world after every
 * filesystem operation and assert what survives.
 */
export const __stateWriteTesting = {
  at: (_point: string): void => undefined,
};

/**
 * Write session state atomically AND durably (T-450 6b, ruling ea611619 B7).
 *
 * `writeSessionSync` below gives ORDERING, not durability: no temp fsync, no
 * directory fsync, so a power loss can drop the rename while later writes
 * survive. That is tolerable for ordinary state updates and NOT tolerable for
 * exactly two writes, which are this function's only permitted callers:
 *
 *   1. the takeover postimage (`commitCandidateTakeover`), where the proof
 *      must be inseparable from the fact it proves, and
 *   2. the cancellation write-4 barrier (`commitCandidateCancel`), because
 *      the intent CLOSE fsyncs file and directory while writes 1/3/4 do not,
 *      so power loss could otherwise keep a closed cancellation intent whose
 *      published transition evaporated: permanent foreclosure.
 *
 * Same encode as writeSessionSync (`toPersistedSessionState`, preserving the
 * ISS-902 single-encode boundary) and the same revision-plus-exactly-one
 * contract, so `committedRevision` precomputation holds identically. The 15
 * ordinary call sites are untouched on purpose; the GENERAL hardening of the
 * shared writer is ISS-958, out of this ticket.
 */
/**
 * Thrown when the rename SUCCEEDED and a later barrier did not.
 *
 * The distinction is not pedantry. Before the rename, a throw means nothing
 * was published and the caller may truthfully discard everything it staged.
 * After it, the new state is already visible to every reader in every process;
 * only its survival across power loss is unproven. A caller that treats the
 * two alike reports "nothing was published" over a state that WAS published,
 * and then discards resources the persisted state now names.
 *
 * `published` carries the state as written so a caller can name the revision
 * it must reconcile against. Durability is deliberately NOT re-attempted here:
 * a retried fsync that fails again proves nothing new, and the honest recovery
 * is the caller's crash-retry path, which re-reads the state and resumes.
 */
export class StateWriteUndurableError extends Error {
  readonly published: FullSessionState;
  constructor(published: FullSessionState, cause: unknown) {
    super(
      `session state revision ${published.revision} was published by rename but its durability ` +
      `barriers did not complete: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "StateWriteUndurableError";
    this.published = published;
    this.cause = cause;
  }
}

export function writeSessionDurableSync(dir: string, state: FullSessionState): FullSessionState {
  const path = statePath(dir);
  const updated = { ...state, revision: state.revision + 1 };
  const content = JSON.stringify(toPersistedSessionState(updated), null, 2) + "\n";
  const tmp = `${path}.${process.pid}.durable.tmp`;
  let renamed = false;
  try {
    const fd = openSync(tmp, "w");
    try {
      const bytes = Buffer.from(content, "utf-8");
      const written = writeSync(fd, bytes);
      // Checked because this temp is renamed over the canonical state: a short
      // write here becomes a permanently malformed state.json.
      if (written !== bytes.length) {
        throw new Error(`state write was short: ${written} of ${bytes.length} bytes to ${tmp}`);
      }
      __stateWriteTesting.at("state:tmp-written");
      fsyncSync(fd);
      __stateWriteTesting.at("state:tmp-fsynced");
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    renamed = true;
    __stateWriteTesting.at("state:renamed");
    // The rename orders old-state/new-state; only this makes the ordering
    // reach the drive (as far as the device's own cache guarantees, the same
    // stated limit as the intent protocol's barriers).
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    __stateWriteTesting.at("state:dir-fsynced");
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    if (renamed) throw new StateWriteUndurableError(updated, err);
    throw err;
  }
  return updated;
}

/** Write session state atomically (write tmp, rename). Increments revision. Returns the written state. */
export function writeSessionSync(dir: string, state: FullSessionState): FullSessionState {
  const path = statePath(dir);
  const updated = { ...state, revision: state.revision + 1 };
  const content = JSON.stringify(toPersistedSessionState(updated), null, 2) + "\n";
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return updated;
}

/** Append an event to events.log (best-effort, non-authoritative). */
export function appendEvent(dir: string, event: EventEntry): void {
  try {
    const path = eventsPath(dir);
    const line = JSON.stringify(event) + "\n";
    writeFileSync(path, line, { flag: "a", encoding: "utf-8" });
  } catch {
    // Best-effort -- events.log is supplementary
  }
}

/**
 * Append an event to events.log, then write session state atomically.
 * If the state write throws, the events.log is truncated back to its
 * pre-append size so audit log and state remain consistent (all-or-nothing).
 * Throws if either step fails.
 */
export function writeSessionWithEvent(
  dir: string,
  nextState: FullSessionState,
  event: EventEntry,
): FullSessionState {
  const path = eventsPath(dir);
  let sizeBefore = 0;
  try {
    sizeBefore = statSync(path).size;
  } catch (err) {
    // Only treat missing file as size 0. Re-throw any other stat error so
    // rollback never guesses and accidentally truncates existing audit history.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const line = JSON.stringify(event) + "\n";
  writeFileSync(path, line, { flag: "a", encoding: "utf-8" });
  try {
    return writeSessionSync(dir, nextState);
  } catch (err) {
    try {
      truncateSync(path, sizeBefore);
    } catch {
      // best-effort -- events.log may have been deleted or is unwritable
    }
    throw err;
  }
}

/** Read events.log with tolerant parsing -- skips malformed lines. */
export function readEvents(dir: string): { events: EventEntry[]; malformedCount: number } {
  const path = eventsPath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { events: [], malformedCount: 0 };
  }

  const events: EventEntry[] = [];
  let malformedCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        typeof parsed === "object" && parsed !== null &&
        typeof parsed.rev === "number" &&
        typeof parsed.type === "string" &&
        typeof parsed.timestamp === "string" &&
        (!("data" in parsed) || (typeof parsed.data === "object" && parsed.data !== null))
      ) {
        events.push(parsed as EventEntry);
      } else {
        malformedCount++;
      }
    } catch {
      malformedCount++;
    }
  }
  return { events, malformedCount };
}

/** Delete a session directory. Used for cleanup on failed start. */
export function deleteSession(root: string, sessionId: string): void {
  const dir = sessionDir(root, sessionId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Lease management
// ---------------------------------------------------------------------------

/** Refresh the lease on a session (called on every guide interaction). */
export function refreshLease(state: FullSessionState): FullSessionState {
  const now = new Date().toISOString();
  const newCallCount = state.guideCallCount + 1;
  return {
    ...state,
    lease: {
      ...state.lease,
      lastHeartbeat: now,
      expiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString(),
    },
    lastGuideCall: now,
    // T-450: `mcpServerPid` is stamped beside its OWN timestamp,
    // `mcpGuideCallAt`. It is deliberately NOT paired with `lastGuideCall`,
    // which advances on CLI refreshes that leave the pid untouched. A death
    // marker is only trustworthy if the server that last served this session is
    // gone, and answering that needs both which server it was and when.
    //
    // `currentMcpServerPid()` returns null outside an MCP server, and the
    // existing value is preserved in that case. This function has CLI callers
    // (`session compact-prepare`, limit-stop) whose short-lived pids would
    // otherwise be recorded and then read as a dead server.
    //
    // The pid is written WITH its own timestamp rather than relying on
    // `lastGuideCall`, because a CLI refresh advances `lastGuideCall` while
    // leaving the pid alone; the two would then describe different calls, and
    // any evidence pairing them would be quietly wrong.
    ...(mcpProcessRole() === "mcp-registered"
      ? { mcpServerPid: currentMcpServerPid(), mcpGuideCallAt: now }
      // An MCP server that could not register is SERVING while invisible to
      // every other evaluator. Preserving the recorded pair would leave it
      // naming a dead predecessor, which is the evidence another process would
      // use to authorize taking over this very much live owner. Clear it.
      : mcpProcessRole() === "mcp-unregistered"
        ? { mcpServerPid: undefined, mcpGuideCallAt: undefined }
        // A CLI caller is not a server and leaves the pair alone.
        : {}),
    guideCallCount: newCallCount,
    contextPressure: {
      ...state.contextPressure,
      guideCallCount: newCallCount,
      // ISS-084: Include resolved issues in work count
      ticketsCompleted: (state.completedTickets?.length ?? 0) + (state.resolvedIssues?.length ?? 0),
    },
  };
}

/** Check if a session's lease has expired. */
export function isLeaseExpired(state: SessionState | FullSessionState): boolean {
  if (!state.lease?.expiresAt) return true;
  const expires = new Date(state.lease.expiresAt).getTime();
  return Number.isNaN(expires) || expires <= Date.now();
}

// ---------------------------------------------------------------------------
// Session discovery (shared between hook-status and guide)
// ---------------------------------------------------------------------------

export interface ActiveSessionInfo {
  readonly state: FullSessionState;
  readonly dir: string;
}

/**
 * Find the active session for a workspace. Returns the best match by lastGuideCall.
 * Used by both hook-status (for status.json) and guide (for session management).
 */
export function findActiveSessionFull(root: string): ActiveSessionInfo | null {
  const sessDir = sessionsRoot(root);

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(sessDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId(root);
  } catch {
    return null;
  }

  let best: ActiveSessionInfo | null = null;
  let bestGuideCall = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(sessDir, entry.name);
    // T-251: containment guard -- reject symlink escapes before any filesystem read.
    if (!isContainedSessionDir(root, dir)) continue;
    // ISS-556: hot MCP path -- tolerate historical lensReviewHistory disposition corruption.
    const session = readSessionResilient(dir);
    if (!session) continue;
    if (session.status !== "active") continue;

    // Workspace must match (missing = compatible for forward-compat)
    if (session.lease?.workspaceId && session.lease.workspaceId !== workspaceId) continue;

    // Lease must not be stale
    if (isLeaseExpired(session)) continue;

    // Pick most recent lastGuideCall, tie-break by sessionId
    const guideCall = session.lastGuideCall
      ? new Date(session.lastGuideCall).getTime()
      : 0;
    const guideCallValid = Number.isNaN(guideCall) ? 0 : guideCall;

    if (
      !best ||
      guideCallValid > bestGuideCall ||
      (guideCallValid === bestGuideCall && session.sessionId > best.state.sessionId)
    ) {
      best = { state: session, dir };
      bestGuideCall = guideCallValid;
    }
  }

  return best;
}

/**
 * Find active session returning the minimal SessionState shape.
 * Used by hook-status.ts for backward compatibility.
 */
export function findActiveSessionMinimal(root: string): SessionState | null {
  const result = findActiveSessionFull(root);
  return result?.state ?? null;
}

/**
 * Find stale (expired lease) active sessions for a workspace. Used by start to supersede them.
 */
export function findStaleSessions(root: string): ActiveSessionInfo[] {
  const sessDir = sessionsRoot(root);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(sessDir, { withFileTypes: true });
  } catch {
    return [];
  }

  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId(root);
  } catch {
    return [];
  }

  const results: ActiveSessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessDir, entry.name);
    // T-251: containment guard -- reject symlink escapes before any filesystem read.
    if (!isContainedSessionDir(root, dir)) continue;
    // ISS-556: hot MCP path (handleStart supersede loop) -- tolerate disposition corruption.
    const session = readSessionResilient(dir);
    if (!session) continue;
    if (session.status !== "active") continue;
    if (session.lease?.workspaceId && session.lease.workspaceId !== workspaceId) continue;
    if (isLeaseExpired(session)) {
      results.push({ state: session, dir });
    }
  }
  return results;
}

/**
 * ISS-902: why a session lookup failed, not just that it did.
 *
 * Collapsing "no such directory" into the same null as "the file is there but
 * this build cannot parse it" is what made the T-328 forward-compat break
 * expensive: `status` listed the session as live while every guide call said
 * `not found`, which reads as a wrong id or a cleaned-up session and sends you
 * looking in the wrong place. The state was intact the whole time and only the
 * reader was too old.
 */
export type SessionLookupFailure =
  | { readonly kind: "missing" }
  | { readonly kind: "version-skew"; readonly writerVersion: number; readonly readerVersion: number }
  | {
      readonly kind: "unreadable";
      readonly reason:
        | "missing-state"
        | "unreadable-file"
        | "invalid-json"
        | "schema"
        /**
         * A `schemaVersion` that is PRESENT and is not one this build supports:
         * a lower number, a string, null, an object (ISS-897).
         *
         * Separate from `schema` because the remedies are opposites. A `schema`
         * failure means the fields were read and are wrong, so deleting or
         * hand-editing is the fix. This means the file may be entirely
         * well-formed under a version this build does not know, and the scanner
         * never treats it as ordinary corruption: it annotates the record with
         * `schema-version-undetermined` where the record is admitted, and
         * reports it as an `unadmitted-schema-version-undetermined` OMISSION
         * where the fields this build reads would otherwise have retired it in
         * silence. Either way it warns against deleting it.
         * Folding the two together left `session report` calling the same file
         * `project_corrupt` while the guard refused to call it damaged, and one of those
         * two surfaces was telling the operator to destroy it.
         *
         * NOT for an absent version: that is the documented legacy shape and
         * still goes to the schema, which is what keeps the disagreement between
         * this reader and the scanner confined to files no writer produced.
         */
        | "unsupported-version";
      /**
       * Which fields failed validation, on `reason: "schema"` (ISS-897).
       *
       * Populated ONLY for `reason: "schema"`; the remaining reasons have no
       * field to name, and a caller constructing this type by hand predates the
       * field entirely.
       * Capped by `summarizeZodIssues`; `issueCount` is the uncapped total.
       */
      readonly issues?: readonly SchemaIssue[];
      readonly issueCount?: number;
      /** `unsupported-version` only: the raw value, which need not be a number. */
      readonly rawVersion?: unknown;
    };

/** The reasons `readSessionStrict` can fail with `kind: "unreadable"`. */
export type UnreadableReason = Extract<SessionLookupFailure, { kind: "unreadable" }>["reason"];

/**
 * An unreadable failure narrowed to specific REASONS (ISS-897).
 *
 * `Extract<SessionLookupFailure, { kind: "unreadable" }>` narrows the kind and
 * nothing else, because `reason` is a union INSIDE one object type rather than
 * a discriminant across variants. Every collection that documented a subset of
 * reasons was therefore enforcing nothing at the type level, which is how a
 * version-fenced session stayed representable in `corrupt` and `damaged` --
 * the two shapes whose remedies are repair and delete.
 */
export type UnreadableFailureOf<R extends UnreadableReason> = Extract<
  SessionLookupFailure,
  { kind: "unreadable" }
> & { readonly reason: R };

/**
 * The two reasons that READ the bytes and found them wrong.
 *
 * These are the only failures that establish damaged data, and so the only ones
 * a repair-or-delete workflow may be handed.
 */
export type CorruptFailure = UnreadableFailureOf<"schema" | "invalid-json">;

/**
 * The two reasons where the read never completed.
 *
 * `missing-state` is a session mid-creation or a dangling directory symlink;
 * `unreadable-file` is EACCES, EIO, ENOTDIR or an inconclusive probe. Neither
 * looked at the contents, so neither establishes damage OR soundness.
 */
export type UnavailableFailure = UnreadableFailureOf<"missing-state" | "unreadable-file">;

/**
 * Everything except the version fence.
 *
 * `corrupt: true` still spans these four, because each of them means the caller
 * holds no state -- but `unsupported-version` is excluded, since that file may
 * be entirely well-formed under a schema this build does not know.
 */
export type NonVersionFailure = UnreadableFailureOf<Exclude<UnreadableReason, "unsupported-version">>;

export type SessionLookup =
  | { readonly kind: "found"; readonly info: ActiveSessionInfo }
  | SessionLookupFailure;

/** Human-facing explanation naming the cause and the remedy. */
export function describeSessionLookupFailure(
  sessionId: string,
  failure: SessionLookupFailure,
): string {
  // ISS-906: every lookup-failure message carries the staleness note when a
  // stale server binary is POSITIVELY established -- a stale server misreports
  // sessions in exactly these shapes ("not found" for a session that exists),
  // so the note belongs on the whole family, appended, never replacing the
  // branch text. When staleness is not established this is the identity.
  return withStalenessNote(describeLookupFailureBase(sessionId, failure));
}

function describeLookupFailureBase(
  sessionId: string,
  failure: SessionLookupFailure,
): string {
  switch (failure.kind) {
    case "missing":
      return `Session ${sessionId} not found`;
    case "version-skew":
      // Same evidence limit as `unsupported-version` below: the newer-version
      // fence also returns before field validation, so "intact" would be a
      // claim about fields this build never interpreted or validated.
      return (
        `Session ${sessionId} was written by a newer storybloq ` +
        `(session schema v${failure.writerVersion}; this build reads v${failure.readerVersion}). ` +
        `This build did not interpret the file, so nothing here establishes that it is damaged OR that it is sound. ` +
        `Restart your AI client to reload the updated ` +
        `MCP server, or upgrade storybloq (npm install -g @storybloq/storybloq@latest), then retry.`
      );
    case "unreadable":
      // ISS-897 / N-097 operator 4: "corrupt or unreadable" without naming the
      // field turned a one-line fix into schema archaeology. When zod told us
      // which field failed, say so here.
      // "corrupt" is reserved for the two reasons that READ the bytes and found
      // them wrong. `missing-state` covers a session mid-creation; `unreadable-file`
      // covers EACCES, EIO and an inconclusive probe. Calling those corrupt sends
      // an operator hunting for damaged data that the evidence never established,
      // which is the same overclaim the remedies were just rewritten to avoid.
      return failure.reason === "schema"
        ? `Session ${sessionId} corrupt -- state.json failed validation: ` +
            `${describeSchemaIssues(failure.issues ?? [], failure.issueCount)}. ` +
            `Inspect it with 'storybloq session report ${sessionId}'.`
        : failure.reason === "missing-state"
          ? `Session ${sessionId} incomplete or unavailable -- an entry exists at that path, but no readable state.json is in it. ` +
              "A session being created looks exactly like this, as does one whose state file was deleted -- and so does a " +
              "DANGLING directory symlink, which is why this does not claim the directory itself is intact."
          : failure.reason === "unsupported-version"
          ? // NOT "intact". The version is checked BEFORE the fields are, so
            // this branch has read one number and nothing else: a truncated
            // file carrying `schemaVersion: 0` arrives here exactly as a sound
            // one under an old schema does. What IS established is that this
            // build did not interpret it, which forbids deletion without
            // vouching for the contents.
            `Session ${sessionId} could not be read -- its \`schemaVersion\` is not one this build supports. ` +
              "This build did not interpret the file, so nothing here establishes that it is damaged OR that it is sound: " +
              "inspect state.json directly, or use a storybloq that supports that schema, then retry. Do NOT delete it."
          : failure.reason === "invalid-json"
            ? // The file WAS read; it is the parse that failed. Folding this into
              // the branch below said "could not be read (invalid-json)", which
              // sends an operator to check permissions over a syntax error.
              `Session ${sessionId} corrupt -- state.json is not valid JSON. ` +
                `Inspect it with 'storybloq session report ${sessionId}'.`
            : // NOT "state.json exists but could not be read". This branch is
              // `unreadable-file`, which covers EACCES, EIO, ENOTDIR and an ENOENT
              // whose follow-up probe could not answer -- none of which observed a
              // file. Asserting existence sends an operator looking for something
              // that may never have been there, which is the same overclaim the
              // scanner's probes were rewritten to stop making.
              `Session ${sessionId} could not be read -- state.json ` +
                `(${failure.reason}). Inspect it with 'storybloq session report ${sessionId}'.`;
  }
}

/**
 * ISS-902: read a session, distinguishing the ways it can fail.
 *
 * The schemaVersion fence runs BEFORE schema parse, and deliberately fires
 * only on a writer NEWER than this reader. That ordering is the whole point:
 * once the version is checked first, a future field or enum widening surfaces
 * as "restart or upgrade" instead of failing parse into a missing session.
 * It cannot retroactively help readers already shipped without it, which is
 * exactly why the widened value is also kept off disk (see
 * toPersistedBranchStrategy) rather than relying on the fence alone.
 */
export function readSessionDetailed(dir: string): SessionLookup {
  const path = statePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    // ISS-897: "the directory survived but the file did not" is its own operator
    // story, and it is the observable shape of `createSession` between its
    // mkdir and its first write. Naming it separately from a genuine read error
    // is what lets `session list` show the row and say what is wrong with it.
    //
    // Only when the directory is actually there, though. `findSessionByIdDetailed`
    // pre-checks and is the sole caller today, so this branch is unreachable
    // through it -- but the function is exported, and a direct caller reporting
    // "corrupt" for a session that does not exist would be a worse lie than the
    // undifferentiated failure this whole type replaced.
    const presence = probePath(dir);
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && presence === "absent") {
      return { kind: "missing" };
    }
    return {
      kind: "unreadable",
      // `missing-state` claims an entry IS there, so it is reserved for a probe
        // that proved it. A probe that could not look (EACCES, EIO) proves
        // nothing in either direction and must not borrow that claim.
        reason:
          (err as NodeJS.ErrnoException).code === "ENOENT" && presence === "present"
            ? "missing-state"
            : "unreadable-file",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", reason: "invalid-json" };
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const writerVersion = (parsed as Record<string, unknown>).schemaVersion;
    // PRESENT and unsupported, but not newer. Reported as its own reason rather
    // than falling through to the schema, so every surface gives the same
    // non-destructive remedy the scanner does for the same file.
    if (
      writerVersion !== undefined &&
      writerVersion !== CURRENT_SESSION_SCHEMA_VERSION &&
      !(typeof writerVersion === "number" && writerVersion > CURRENT_SESSION_SCHEMA_VERSION)
    ) {
      return { kind: "unreadable", reason: "unsupported-version", rawVersion: writerVersion };
    }
    if (typeof writerVersion === "number" && writerVersion > CURRENT_SESSION_SCHEMA_VERSION) {
      return {
        kind: "version-skew",
        writerVersion,
        readerVersion: CURRENT_SESSION_SCHEMA_VERSION,
      };
    }
  }

  // ISS-556: hot MCP path (all report/resume/cancel handlers) -- must tolerate
  // historical lensReviewHistory disposition corruption or the session
  // appears "not reachable via MCP" and autonomous mode cannot progress.
  //
  // Validates the snapshot already decoded above rather than re-reading, so
  // the fence and the schema cannot disagree about which revision they saw.
  const state = parseSessionResilient(parsed, dir);
  if (!state) {
    // ISS-897: name the fields. The resilient parse already ran and failed, so
    // re-running the strict schema costs one validation of an in-memory object
    // and buys the operator the difference between "corrupt" and
    // "startedAt expected string, received null".
    const strict = parseSessionState(parsed);
    return strict.success
      ? { kind: "unreadable", reason: "schema" }
      : {
          kind: "unreadable",
          reason: "schema",
          issues: summarizeZodIssues(strict.error),
          issueCount: strict.error.issues.length,
        };
  }
  return { kind: "found", info: { state, dir } };
}

/** Find a specific session by ID, reporting why the lookup failed. */
export function findSessionByIdDetailed(root: string, sessionId: string): SessionLookup {
  const dir = sessionDir(root, sessionId);
  // Same distinction as the readers below it: a dangling session-directory
  // symlink is present-and-unusable, not absent, and must not be reported as
  // an ordinary not-found. `readSessionDetailed` then classifies it.
  if (pathIsAbsent(dir)) return { kind: "missing" };
  return readSessionDetailed(dir);
}

/**
 * Find a specific session by ID.
 *
 * Retains the null-on-any-failure contract for the many callers that only
 * branch on presence; use findSessionByIdDetailed where the reason matters.
 */
export function findSessionById(root: string, sessionId: string): ActiveSessionInfo | null {
  const lookup = findSessionByIdDetailed(root, sessionId);
  return lookup.kind === "found" ? lookup.info : null;
}

// ---------------------------------------------------------------------------
// Compact preparation (ISS-032: hook-driven compaction)
// ---------------------------------------------------------------------------

export interface CompactPrepareResult {
  sessionId: string;
  preCompactState: string;
  resumeFromRevision: number;
}

/** True only after the post-compaction SessionStart hook observed this cycle. */
export function wasCompactionObserved(state: FullSessionState): boolean {
  return state.state === "COMPACT" && state.compactPending && !!state.compactObservedAt;
}

/** Record proof that the client completed the pending compaction cycle. */
export function markCompactionObserved(
  dir: string,
  state: FullSessionState,
  observedAt = new Date().toISOString(),
): FullSessionState {
  if (state.state !== "COMPACT" || !state.compactPending) {
    throw new Error("Cannot observe compaction without a pending COMPACT session");
  }
  return writeSessionSync(dir, { ...state, compactObservedAt: observedAt });
}

/**
 * ISS-965: where a compaction/limit-park should resume this session. Ordinary
 * HANDOVER rewrites to PICK_TICKET so a session that ends normally does not
 * resume back into a stage with no work left to do -- unchanged. A HANDOVER
 * reached via ISS-965 terminal routing (completion-observed) is different: it
 * exists specifically so the session ends at that clean boundary, so resuming
 * it must land BACK at HANDOVER, never at PICK_TICKET, or a compaction/park
 * cycle would silently let the session pick another item -- the exact
 * pipeline re-entry ISS-965's terminal routing exists to close (round-3 gate
 * finding). Discriminates on the marker only, never on anything the agent
 * writes directly.
 */
function resolveCompactResumeTarget(state: FullSessionState): FullSessionState["state"] {
  if (state.state === "HANDOVER" && state.terminalDisposition?.kind === "completion-observed") {
    return "HANDOVER";
  }
  return state.state === "HANDOVER" ? "PICK_TICKET" : state.state;
}

/**
 * Prepare a session for compaction. Used by BOTH the CLI hook (session-compact-prepare)
 * and the guide's handlePreCompact action. Sets state=COMPACT with compactPending marker.
 *
 * Guards: SESSION_END → throw, FINALIZE → throw, stale COMPACT → throw.
 * Idempotent: if already pending (compactPending + COMPACT), refreshes timestamp only.
 */
export function prepareForCompact(
  dir: string,
  state: FullSessionState,
  opts?: { expectedHead?: string },
): CompactPrepareResult {
  if (state.state === "SESSION_END") throw new Error("Session already ended");
  if (state.state === "FINALIZE") throw new Error("Cannot compact during FINALIZE -- complete the commit first");

  // Idempotent: already pending → refresh timestamp + expectedHead.
  // ISS-922: expectedHead records an OBSERVATION for resume drift detection.
  // It must never carry the finalization baseline (git.itemBaseHead): parking
  // after a work commit but before FINALIZE saw it would promote the baseline
  // onto that commit and close every exit from the stage.
  if (state.compactPending && state.state === "COMPACT") {
    const updatedGit = opts?.expectedHead
      ? { ...state.git, expectedHead: opts.expectedHead }
      : state.git;
    writeSessionSync(dir, {
      ...state,
      compactPreparedAt: new Date().toISOString(),
      compactObservedAt: null,
      resumeBlocked: false,
      git: updatedGit,
    });
    return {
      sessionId: state.sessionId,
      preCompactState: state.preCompactState ?? state.state,
      resumeFromRevision: state.resumeFromRevision ?? state.revision,
    };
  }

  // Stale manual COMPACT (state=COMPACT but compactPending=false)
  if (state.state === "COMPACT") {
    throw new Error("Session is in COMPACT state but not pending. Call resume or clear-compact.");
  }

  const resumeTarget = resolveCompactResumeTarget(state);

  const written = writeSessionSync(dir, {
    ...state,
    state: "COMPACT",
    previousState: state.state,
    preCompactState: resumeTarget,
    resumeFromRevision: state.revision,
    compactPending: true,
    compactPreparedAt: new Date().toISOString(),
    compactObservedAt: null,
    resumeBlocked: false,
    git: { ...state.git, expectedHead: opts?.expectedHead ?? state.git.expectedHead },
  });

  return {
    sessionId: written.sessionId,
    preCompactState: resumeTarget,
    resumeFromRevision: state.revision,  // pre-write value, matches what's stored in state.json
  };
}

// ---------------------------------------------------------------------------
// T-424: Usage-limit stops (ride the COMPACT lane with interruptionKind="limit")
// ---------------------------------------------------------------------------

/** The closed set Claude Code's hook payload may carry; anything else is recorded as null (no flag at wake). */
export const LIMIT_PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "default", "plan"] as const;

export type LimitPermissionMode = (typeof LIMIT_PERMISSION_MODES)[number];

export function validateLimitPermissionMode(mode: string | null | undefined): LimitPermissionMode | null {
  return mode && (LIMIT_PERMISSION_MODES as readonly string[]).includes(mode) ? (mode as LimitPermissionMode) : null;
}

/**
 * Spread into a session write to atomically clear a pending interruption --
 * the COMPACT markers plus every limit field -- so a later ordinary compaction
 * or an independent new limit stop starts clean.
 */
export const CLEARED_LIMIT_FIELDS = {
  interruptionKind: null,
  limitStopPending: false,
  limitResumeAt: null,
  limitPermissionMode: null,
  limitEventId: null,
} as const;

/**
 * Full interruption clear (COMPACT markers + limit fields). Call under
 * withSessionLock. Use this ONLY when the session has already left COMPACT (the
 * successful-resume completion path): it drops compactPending and the resume
 * target, so calling it on a still-COMPACT session would strand it as
 * COMPACT-but-not-pending -- undiscoverable by findResumableSession and rejected
 * by prepareForLimitStop. For cancellation of a still-parked session use
 * downgradeLimitParkToCompact instead.
 */
export function clearInterruption(dir: string, state: FullSessionState): FullSessionState {
  return writeSessionSync(dir, {
    ...state,
    compactPending: false,
    compactPreparedAt: null,
    compactObservedAt: null,
    preCompactState: null,
    resumeFromRevision: null,
    resumeBlocked: false,
    ...CLEARED_LIMIT_FIELDS,
  });
}

/**
 * Cancellation downgrade: convert a still-parked limit interruption back into an
 * ORDINARY compact park so the autonomous session stays recoverable. The session
 * remains on the COMPACT lane with compactPending true and its resume target
 * (preCompactState + resumeFromRevision) intact -- discoverable by
 * findResumableSession and resumable through the normal guide flow -- while every
 * limit-specific field is cleared. compactPreparedAt is refreshed so the plain
 * compact staleness window starts from the cancellation, not the original stop.
 * (clearInterruption would instead strand it as COMPACT-but-not-pending.)
 *
 * EXCEPTION -- a FINALIZE park is NOT downgraded to a clean compact park. Doing
 * so would clear interruptionKind, which is exactly the guide's "git state
 * verified" acknowledgment (see guide.ts FINALIZE gate + clear-compact --force),
 * so a cancelled FINALIZE park would then replay finalization through the
 * generic resume path with no verification (duplicate commits). Cancelling the
 * LEDGER record already stops any auto-resume; the session stays limit-kind so
 * the FINALIZE gate and the clear-compact --force requirement both survive, and
 * only the auto-resume scheduling fields are cleared.
 */
export function downgradeLimitParkToCompact(dir: string, state: FullSessionState): FullSessionState {
  if (state.preCompactState === "FINALIZE" && state.interruptionKind === "limit") {
    return writeSessionSync(dir, {
      ...state,
      state: "COMPACT",
      compactPending: true,
      compactPreparedAt: new Date().toISOString(),
      compactObservedAt: null,
      resumeBlocked: false,
      // Keep interruptionKind="limit" + preCompactState + limitEventId so the
      // FINALIZE gate holds; drop only the scheduling fields that would keep the
      // waker treating this as live auto-resume work.
      limitStopPending: false,
      limitResumeAt: null,
      limitPermissionMode: null,
    });
  }
  return writeSessionSync(dir, {
    ...state,
    state: "COMPACT",
    compactPending: true,
    compactPreparedAt: new Date().toISOString(),
    compactObservedAt: null,
    resumeBlocked: false,
    ...CLEARED_LIMIT_FIELDS,
  });
}

export interface LimitStopPrepareOptions {
  expectedHead?: string;
  /** Hook payload permission_mode; validated against LIMIT_PERMISSION_MODES. */
  permissionMode?: string | null;
  /** Parsed (or fallback) reset time, epoch ms. */
  resumeAt: number;
  /** Shared with the ledger record -- the cross-store reconciliation key. */
  limitEventId: string;
}

/**
 * Park an autonomous session for a usage-limit stop. Same lane as
 * prepareForCompact (state=COMPACT + compactPending) so every resume-path
 * consumer works unchanged, discriminated by interruptionKind="limit".
 *
 * Unlike prepareForCompact this ALLOWS FINALIZE: the session is parked so it
 * stays discoverable and explicitly recoverable, while auto-resume is disabled
 * end-to-end (ledger mode:"notify" + handleResume's FINALIZE rejection) because
 * replaying finalization is not proven idempotent (see T-425).
 *
 * Idempotent on an already-parked session (either kind): a re-limit upgrades
 * the interruption to kind="limit" with the NEW event's reset time while
 * preserving preCompactState/resumeFromRevision from the original park.
 */
export function prepareForLimitStop(
  dir: string,
  state: FullSessionState,
  opts: LimitStopPrepareOptions,
): CompactPrepareResult {
  // ISS-922: as in prepareForCompact, opts.expectedHead is an OBSERVATION for
  // drift detection only. This function deliberately allows FINALIZE, so it is
  // the likeliest promoter of all -- it must never touch git.itemBaseHead.
  if (state.state === "SESSION_END") throw new Error("Session already ended");

  const limitFields = {
    interruptionKind: "limit" as const,
    limitStopPending: true,
    limitResumeAt: opts.resumeAt,
    limitPermissionMode: validateLimitPermissionMode(opts.permissionMode),
    limitEventId: opts.limitEventId,
  };

  // Already parked (compact or limit): keep the original resume target, take
  // the new limit event's fields.
  if (state.compactPending && state.state === "COMPACT") {
    const updatedGit = opts.expectedHead
      ? { ...state.git, expectedHead: opts.expectedHead }
      : state.git;
    writeSessionSync(dir, {
      ...state,
      ...limitFields,
      compactPreparedAt: new Date().toISOString(),
      compactObservedAt: null,
      resumeBlocked: false,
      git: updatedGit,
    });
    return {
      sessionId: state.sessionId,
      preCompactState: state.preCompactState ?? state.state,
      resumeFromRevision: state.resumeFromRevision ?? state.revision,
    };
  }

  if (state.state === "COMPACT") {
    throw new Error("Session is in COMPACT state but not pending. Call resume or clear-compact.");
  }

  const resumeTarget = resolveCompactResumeTarget(state);

  const written = writeSessionSync(dir, {
    ...state,
    ...limitFields,
    state: "COMPACT",
    previousState: state.state,
    preCompactState: resumeTarget,
    resumeFromRevision: state.revision,
    compactPending: true,
    compactPreparedAt: new Date().toISOString(),
    compactObservedAt: null,
    resumeBlocked: false,
    git: { ...state.git, expectedHead: opts.expectedHead ?? state.git.expectedHead },
  });

  return {
    sessionId: written.sessionId,
    preCompactState: resumeTarget,
    resumeFromRevision: state.revision,
  };
}

/**
 * Find a resumable session (compactPending + active + workspace match).
 * Used by session-resume-prompt CLI (SessionStart hook).
 * Separate from findActiveSessionFull to preserve single-session invariant.
 * Read-only -- no lock needed.
 */
export function findResumableSession(root: string): { info: ActiveSessionInfo; stale: boolean } | null {
  const sessDir = sessionsRoot(root);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(sessDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId(root);
  } catch {
    return null;
  }

  const FRESHNESS_MS = 60 * 60 * 1000; // 1 hour
  // T-424: a limit-parked session legitimately waits hours-to-days for its
  // reset; the 1h compact window would flag every limit resume stale (and the
  // stale text steers users to clear-compact, destroying the pending resume).
  const LIMIT_RESUME_GRACE_MS = 24 * 60 * 60 * 1000;
  let best: { info: ActiveSessionInfo; stale: boolean } | null = null;
  let bestPreparedAt = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessDir, entry.name);
    // T-251: containment guard -- reject symlink escapes before any filesystem read.
    if (!isContainedSessionDir(root, dir)) continue;
    // ISS-556: hot MCP path (compact hook resume discovery) -- tolerate disposition corruption.
    const session = readSessionResilient(dir);
    if (!session) continue;
    if (session.status !== "active") continue;
    if (!session.compactPending) continue;
    if (session.lease?.workspaceId && session.lease.workspaceId !== workspaceId) continue;
    // No lease expiry check -- compactPreparedAt freshness handles staleness.
    // Lease expiry is for session management (findActiveSessionFull), not hook discovery.

    const preparedAt = session.compactPreparedAt
      ? new Date(session.compactPreparedAt).getTime()
      : 0;
    const preparedAtValid = Number.isNaN(preparedAt) ? 0 : preparedAt;
    const isStale = session.interruptionKind === "limit" && session.limitResumeAt != null
      ? Date.now() > session.limitResumeAt + LIMIT_RESUME_GRACE_MS
      : Date.now() - preparedAtValid > FRESHNESS_MS;

    if (preparedAtValid > bestPreparedAt) {
      best = { info: { state: session, dir }, stale: isStale };
      bestPreparedAt = preparedAtValid;
    }
  }

  return best;
}

/**
 * A contained session directory whose state could not be LOADED (ISS-897).
 *
 * DAMAGED only, and damaged means the bytes were READ and found wrong: `schema`
 * or `invalid-json`. Everything that consumes this collection treats it as
 * something to repair or remove, so nothing may be filed here that was not
 * established to be broken.
 *
 * The two failures where the read never completed are returned under
 * `unavailable` instead. A directory with no `state.json` (`missing-state`) is
 * the observable shape of `createSession` between its mkdir and its first
 * write, and of a dangling directory symlink; `unreadable-file` is EACCES, EIO
 * or an inconclusive probe. Both are still surfaced -- an operator consulting
 * `session list` needs to see them -- under a name that does not invite
 * destroying them. A session written by a newer storybloq, or carrying a
 * version this build does not support, is reported as `IncompatibleSessionInfo`
 * for the same reason.
 */
export interface DamagedSessionInfo {
  /**
   * The raw directory name.
   *
   * NOT a guaranteed CLI selector: this enumerator accepts a contained
   * directory of any name, while `resolveSessionSelector` requires a canonical
   * session UUID. A legacy or hand-created directory therefore appears here and
   * is still rejected by `session show`. Callers that print a command must
   * check the name first; `dir` is the address that always works.
   */
  readonly sourceDir: string;
  readonly dir: string;
  /**
   * Narrowed to the two reasons that READ the bytes and found them wrong
   * (ISS-897).
   *
   * `version-skew` goes to `IncompatibleSessionInfo`, `missing` is dropped, and
   * the two reasons where the read never completed go to
   * `UnavailableSessionInfo`. Narrowing only the KIND left `reason` a five-way
   * union, so this collection -- whose documented consumer treats its members
   * as repair-or-remove candidates -- still accepted a permission error and an
   * unsupported version at the type level.
   */
  readonly failure: CorruptFailure;
}

/**
 * A session this build could not OPEN, which is not the same as damaged
 * (ISS-897).
 *
 * Split out of `damaged` because the collection NAME is part of the contract:
 * `session list --format json` publishes it, and an automated consumer that
 * cleans up whatever `damaged` contains would delete a session over a creation
 * race or an EACCES. Nothing here read the bytes, so nothing here established
 * that there is anything wrong with them.
 */
export interface UnavailableSessionInfo {
  readonly sourceDir: string;
  readonly dir: string;
  readonly failure: UnavailableFailure;
}

/**
 * Is the reserved `.lock` directory actually EMPTY (ISS-897)?
 *
 * It used to ask whether `.lock/state.json` was absent, which is a different
 * question with the same answer only in the happy case. A `.lock` holding
 * anything else -- a pid file, a stray temp file, a session directory
 * half-created and not yet carrying its state write -- answered "empty" and was
 * skipped, so the one shape this exemption is NOT meant to cover was the one it
 * concealed. The exemption exists for the proper lockfile, which holds nothing.
 *
 * Enumerating is also the stricter probe: any error (EACCES, ENOTDIR, a
 * dangling link) means emptiness was not ESTABLISHED, and an unestablished
 * exemption has to fail toward reporting the directory.
 */
function lockDirIsEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * A session this build cannot read but which is NOT damaged (ISS-897).
 *
 * Its own collection, for the same reason `SessionResolution` has its own
 * `incompatible` variant: `damaged` is a name that invites repair or deletion,
 * and this is the one entry in that family where both are the wrong answer and
 * one of them is irreversible. Text output alone was not enough -- `session
 * list --format json` publishes the collection name, and an automated consumer
 * that cleans up `damaged` would destroy a session nothing established was
 * broken.
 */
export type IncompatibleSessionInfo = {
  readonly sourceDir: string;
  readonly dir: string;
  readonly readerVersion: number;
} & IncompatibleCause;

/**
 * T-251: Enumerate every session on disk, regardless of status, SPLIT by what
 * could be established about each one (ISS-897).
 *
 * Used by the `session list` CLI. Containment is applied to real DIRECTORIES;
 * a symlink is never followed and is surfaced under `unavailable` whatever it
 * points at, so an escape is refused without being concealed.
 *
 * Four collections, and the split is the contract rather than a convenience.
 * `sessions` loaded. `damaged` had its bytes READ and found wrong. `unavailable`
 * is where the read never completed, so nothing about the content was
 * established. `incompatible` carries a `schemaVersion` this build does not
 * support, which is not evidence of damage in either direction. Consumers act
 * destructively on `damaged`, so a record may only be filed there when it was
 * proven broken.
 *
 * A directory with no `state.json` is reported too, as `missing-state`. It is
 * tempting to omit it -- there is no record to show -- but this command is what
 * the ownership guard tells an operator to run when the scanner reports
 * `state-missing`, and a warning pointing at a command that shows nothing is
 * the dead end this issue exists to remove.
 *
 * THROWS when the sessions root itself cannot be enumerated. Returning empty
 * for that case reported "no sessions" over a directory that may be full of
 * them, which is the concealment this issue closes; proven absence is the only
 * outcome that still returns empty. Callers that must not fail closed -- the
 * limit-stop recorder is the one -- catch it and say so.
 */
export function listAllSessionsDetailed(root: string): {
  sessions: ActiveSessionInfo[];
  /** Bytes READ and found wrong: `schema` or `invalid-json` only (ISS-897). */
  damaged: DamagedSessionInfo[];
  /**
   * Present but not readable, with NO damage established: `missing-state` (a
   * creation race or a dangling link) and `unreadable-file` (EACCES, EIO, or an
   * inconclusive probe). Split out of `damaged` because that name is what an
   * automated consumer cleans up, and cleaning either of these up destroys a
   * session over a transient fault.
   */
  unavailable: UnavailableSessionInfo[];
  incompatible: IncompatibleSessionInfo[];
} {
  const sessDir = sessionsRoot(root);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(sessDir, { withFileTypes: true });
  } catch (err) {
    // ENOENT from `readdirSync` does NOT establish that `.story/sessions` is
    // absent (ISS-897). A DANGLING SYMLINK at that path raises the same code,
    // and so does one whose target was removed -- in both cases something is
    // there and this build cannot enumerate it. Returning four empty arrays
    // for that says "this project has no sessions", which is the concealment
    // this whole API exists to remove, arriving at the very command the guard's
    // rationale tells an operator to run. The scanner already reports it as
    // `sessions-dir-unreadable`, so the two surfaces would flatly disagree.
    //
    // So probe before claiming. Only proven absence is an empty project.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && probePath(sessDir) === "absent") {
      return { sessions: [], damaged: [], unavailable: [], incompatible: [] };
    }
    throw err;
  }

  const sessions: ActiveSessionInfo[] = [];
  const damaged: DamagedSessionInfo[] = [];
  const unavailable: UnavailableSessionInfo[] = [];
  const incompatible: IncompatibleSessionInfo[] = [];
  for (const entry of entries) {
    const dir = join(sessDir, entry.name);
    // `.lock` is exempt only when it is EMPTY, matching `scanSessionSummaries`
    // (ISS-897). This enumerator admits a contained directory under any name, so
    // `.lock` is a name a real session can have -- and the two must not
    // disagree: the guard reporting a session that `storybloq session list`
    // cannot show is the exact dead end this work exists to close, with the
    // concealment moved from the scanner to the command it sends you to.
    //
    // The `isDirectory()` guard is load-bearing ONLY because this test runs
    // BEFORE the non-directory branch below, matching the scanner's order.
    // `readdirSync` reports link types without following them, so a `.lock`
    // SYMLINK is not the reserved lockfile shape; skipping it by NAME would
    // drop a link that may point at a live session, before anything could say
    // so. Reordering these two tests silently re-opens that.
    if (entry.name === ".lock" && entry.isDirectory() && lockDirIsEmpty(dir)) continue;

    if (!entry.isDirectory()) {
      // The scanner does NOT drop these silently, and this command is where its
      // warnings send the operator, so dropping them here would move the
      // concealment one surface downstream instead of removing it. The
      // predicate is deliberately the same one `scanSessionSummaries` uses for
      // `entry-not-a-directory`: a symlink of any name, which readdir never
      // follows and which may point at a live session, or a session-SHAPED name
      // on something that cannot be a session. Everything else really is noise
      // -- reporting every `.DS_Store` would bury the two shapes that matter.
      if (entry.isSymbolicLink() || SESSION_ID_REGEX.test(entry.name)) {
        // `unreadable-file`, never `missing-state`: that reason claims an entry
        // IS there in readable form, and nothing here opened anything. This is
        // the collection whose contract is "present, not read, no damage
        // established", which is exactly what a dropped link is.
        unavailable.push({
          sourceDir: String(entry.name),
          dir,
          failure: { kind: "unreadable", reason: "unreadable-file" },
        });
      }
      continue;
    }

    // Containment, AFTER the non-directory branch and deliberately so. The
    // scanner classifies shape first and containment second, and the order is
    // observable: a symlink whose target resolves outside the sessions root is
    // `escaped` here and `entry-not-a-directory` there. Running containment
    // first dropped it in silence, so the guard -- which tells an operator to
    // run `storybloq session list` precisely because that command surfaces
    // every symlink -- sent them to a command that showed nothing. The two
    // surfaces have to agree about one path, and this is the order that makes
    // `SESSION_LIST_BLIND_KINDS` excluding `entry-not-a-directory` true.
    //
    // Three answers, not two. A PROVEN escape is dropped in silence and that is
    // correct for a DIRECTORY -- the guard worked and nothing was concealed. A
    // probe that could not look establishes nothing, and dropping it would
    // remove a directory that may hold a live session from a listing this
    // command presents as the whole inventory. It goes to `unavailable`, whose
    // contract is exactly "present, not read, no damage established".
    const containment = probeContainment(root, dir);
    if (containment === "escaped") continue;
    if (containment === "probe-failed") {
      unavailable.push({
        sourceDir: String(entry.name),
        dir,
        // `unreadable-file`, not `missing-state`: nothing here opened anything,
        // and the failure is in resolving the PATH rather than in reading a
        // state file that may not even exist.
        failure: { kind: "unreadable", reason: "unreadable-file" },
      });
      continue;
    }

    const result = readSessionStrict(dir);
    if (result.ok) sessions.push({ state: result.state, dir });
    else if (result.failure.kind === "version-skew") {
      incompatible.push({
        sourceDir: String(entry.name),
        dir,
        cause: "newer",
        writerVersion: result.failure.writerVersion,
        readerVersion: result.failure.readerVersion,
      });
    } else if (result.failure.kind === "missing") {
      // The directory was enumerated a moment ago and is gone now: an ordinary
      // deletion race, not damage. Publishing it under `damaged` would invite a
      // consumer to repair something that no longer exists, and would report a
      // problem to an operator who has none.
      continue;
    } else {
      // `String(...)`: the surrounding `readdirSync` results are mistyped as
      // Dirent<NonSharedBuffer> in this build (ISS-670's pre-existing tsc
      // baseline), so the name needs coercing to satisfy the field's type.
      // SPLIT BY EVIDENCE, not by the `unreadable` kind (ISS-897). This
      // collection's NAME is part of its contract -- the doc above says
      // consumers treat it as repair-or-remove candidates, and `session list
      // --format json` publishes the key. `missing-state` is a creation race or
      // a dangling link; `unreadable-file` is EACCES, EIO, or a probe that could
      // not answer. Neither read the bytes, so neither may be filed under a name
      // that invites destroying them.
      const failure = result.failure;
      const sourceDir = String(entry.name);
      // A `switch` on `reason`, and each branch RESTATES it. `failure` is one
      // object type whose `reason` is a union, not a union of object types, so
      // narrowing the switch subject narrows `failure.reason` and leaves
      // `failure` itself wide -- which is exactly how a shared `row` local used
      // to carry the full five-way union into all three collections and defeat
      // the types that were meant to keep them apart.
      switch (failure.reason) {
        case "schema":
        case "invalid-json":
          damaged.push({ sourceDir, dir, failure: { ...failure, reason: failure.reason } });
          break;
        case "unsupported-version":
          incompatible.push({
            sourceDir,
            dir,
            cause: "unsupported",
            rawVersion: failure.rawVersion,
            readerVersion: CURRENT_SESSION_SCHEMA_VERSION,
          });
          break;
        case "missing-state":
        case "unreadable-file":
          unavailable.push({ sourceDir, dir, failure: { ...failure, reason: failure.reason } });
          break;
        default: {
          // Not decoration: a new reason added to `SessionLookupFailure` must
          // be routed deliberately, because the DEFAULT it would otherwise fall
          // into decides whether an operator is offered a delete.
          const exhaustive: never = failure.reason;
          throw new Error(`unhandled unreadable reason: ${String(exhaustive)}`);
        }
      }
    }
  }
  damaged.sort((a, b) => a.sourceDir.localeCompare(b.sourceDir));
  unavailable.sort((a, b) => a.sourceDir.localeCompare(b.sourceDir));
  incompatible.sort((a, b) => a.sourceDir.localeCompare(b.sourceDir));
  return { sessions, damaged, unavailable, incompatible };
}

/**
 * The readable sessions only, with the other three collections dropped.
 *
 * The SHAPE is preserved exactly (ISS-897) -- same signature, same
 * readable-only filtering -- and that is the part callers depend on: `session
 * repair` and the others want only the readable sessions, and widening this
 * would change every one of them for the benefit of the one that does not.
 *
 * Two behaviours did change, because they were wrong in the shared enumerator
 * and fixing them there fixes them here: an unreadable or dangling sessions
 * root now THROWS rather than returning an empty list (returning empty reported
 * "no sessions" over a directory that may be full of them), and a `.lock`
 * directory that actually holds a valid session is no longer skipped
 * unconditionally. So unreadable
 * entries are skipped SILENTLY here -- `session show` and `session repair`
 * surface them individually when called with an explicit selector, and
 * `session list` calls `listAllSessionsDetailed` to see all four.
 */
export function listAllSessions(root: string): ActiveSessionInfo[] {
  return listAllSessionsDetailed(root).sessions;
}

/**
 * T-251: Remove a session directory. Belt + suspenders: the caller has
 * already validated via resolveSessionSelector, but this asserts containment
 * a second time so an attacker who slipped past the resolver still cannot
 * delete arbitrary directories.
 */
export function deleteSessionDir(root: string, sessionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error(`deleteSessionDir: invalid session ID "${sessionId}"`);
  }
  const dir = sessionDir(root, sessionId);
  if (!isContainedSessionDir(root, dir)) {
    throw new Error(`deleteSessionDir: ${sessionId} resolves outside sessionsRoot`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Session lock (filesystem-level, cross-process)
// ---------------------------------------------------------------------------

/**
 * Execute a function while holding the session filesystem lock.
 * Uses proper-lockfile on .story/sessions/.lock.
 */
export async function withSessionLock<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const sessDir = sessionsRoot(root);
  mkdirSync(sessDir, { recursive: true });

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(sessDir, {
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
      stale: 30000,
      lockfilePath: join(sessDir, ".lock"),
    });
    return await fn();
  } finally {
    if (release) {
      try { await release(); } catch { /* ignore */ }
    }
  }
}
