import {
  readdir,
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
  realpath,
  lstat,
  open,
  mkdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, extname, dirname, basename } from "node:path";
import lockfile from "proper-lockfile";
import { TicketSchema, type Ticket } from "../models/ticket.js";
import { IssueSchema, type Issue } from "../models/issue.js";
import { NoteSchema, type Note } from "../models/note.js";
import { RoadmapSchema, type Roadmap } from "../models/roadmap.js";
import { ConfigSchema, type Config } from "../models/config.js";
import { TICKET_ID_REGEX, ISSUE_ID_REGEX, NOTE_ID_REGEX } from "../models/types.js";
import { ProjectState } from "./project-state.js";
import {
  ProjectLoaderError,
  CURRENT_SCHEMA_VERSION,
  INTEGRITY_WARNING_TYPES,
  type LoadWarning,
  type LoadWarningType,
} from "./errors.js";
import { listHandovers } from "./handover-parser.js";
import type { ZodType } from "zod";

// --- Public Types ---

export interface LoadOptions {
  /** In strict mode, integrity warnings become thrown errors. Default: false */
  strict?: boolean;
  /** Maximum schemaVersion this loader supports. Default: CURRENT_SCHEMA_VERSION */
  maxSchemaVersion?: number;
}

export interface LoadResult {
  readonly state: ProjectState;
  readonly warnings: readonly LoadWarning[];
}

// --- Read Operations ---

/**
 * Loads all .story/ data and assembles a ProjectState.
 * Critical files (config, roadmap) throw on failure.
 * Best-effort files (tickets, issues) skip corrupt entries with warnings.
 */
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

  // 2. Recover any incomplete transaction (under lock)
  if (existsSync(join(wrapDir, ".txn.json"))) {
    await withLock(wrapDir, () => doRecoverTransaction(wrapDir));
  }

  // 3. Load config.json (critical)
  const config = await loadSingletonFile<Config>(
    "config.json",
    wrapDir,
    absRoot,
    ConfigSchema,
  );

  // 4. Check schemaVersion
  const maxVersion = options?.maxSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  if (
    config.schemaVersion !== undefined &&
    config.schemaVersion > maxVersion
  ) {
    throw new ProjectLoaderError(
      "version_mismatch",
      `Config schemaVersion ${config.schemaVersion} exceeds max supported ${maxVersion}.`,
    );
  }

  // 5. Load roadmap.json (critical)
  const roadmap = await loadSingletonFile<Roadmap>(
    "roadmap.json",
    wrapDir,
    absRoot,
    RoadmapSchema,
  );

  // 6. Load tickets (best-effort)
  const warnings: LoadWarning[] = [];
  const tickets = await loadDirectory<Ticket>(
    join(wrapDir, "tickets"),
    absRoot,
    TicketSchema,
    warnings,
  );

  // 7. Load issues (best-effort)
  const issues = await loadDirectory<Issue>(
    join(wrapDir, "issues"),
    absRoot,
    IssueSchema,
    warnings,
  );

  // 7b. Load notes (best-effort)
  // NoteSchema uses preprocess for optional title/tags defaults — cast needed
  // because ZodEffects input type differs from output type.
  const notes = await loadDirectory<Note>(
    join(wrapDir, "notes"),
    absRoot,
    NoteSchema as unknown as ZodType<Note>,
    warnings,
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
    roadmap,
    config,
    handoverFilenames,
  });

  return { state, warnings };
}

// --- Write Operations ---

/**
 * Writes a ticket file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 * Performs Zod parse + guardPath + atomicWrite.
 */
export async function writeTicketUnlocked(
  ticket: Ticket,
  root: string,
): Promise<void> {
  const parsed = TicketSchema.parse(ticket);
  if (!TICKET_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid ticket ID: ${parsed.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "tickets", `${parsed.id}.json`);
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  await atomicWrite(targetPath, json);
}

export async function writeTicket(
  ticket: Ticket,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await writeTicketUnlocked(ticket, root);
  });
}

/**
 * Writes an issue file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 */
export async function writeIssueUnlocked(
  issue: Issue,
  root: string,
): Promise<void> {
  const parsed = IssueSchema.parse(issue);
  if (!ISSUE_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid issue ID: ${parsed.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "issues", `${parsed.id}.json`);
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  await atomicWrite(targetPath, json);
}

export async function writeIssue(
  issue: Issue,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
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
  const parsed = RoadmapSchema.parse(roadmap);
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "roadmap.json");
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  await atomicWrite(targetPath, json);
}

export async function writeRoadmap(
  roadmap: Roadmap,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await writeRoadmapUnlocked(roadmap, root);
  });
}

export async function writeConfig(
  config: Config,
  root: string,
): Promise<void> {
  const parsed = ConfigSchema.parse(config);
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "config.json");
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  await withLock(wrapDir, async () => {
    await atomicWrite(targetPath, json);
  });
}

/**
 * Deletes a ticket file with referential integrity checks.
 * Acquires lock, reloads fresh state from disk, checks all references.
 * With force: true, skips integrity checks and state reload.
 */
export async function deleteTicket(
  id: string,
  root: string,
  options?: { force?: boolean },
): Promise<void> {
  if (!TICKET_ID_REGEX.test(id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid ticket ID: ${id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "tickets", `${id}.json`);
  await guardPath(targetPath, wrapDir);

  await withLock(wrapDir, async () => {
    if (!options?.force) {
      // Reload fresh state under lock for safety checks (bypass loadProject to avoid nested lock)
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

    await unlink(targetPath);
  });
}

export async function deleteIssue(
  id: string,
  root: string,
): Promise<void> {
  if (!ISSUE_ID_REGEX.test(id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid issue ID: ${id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "issues", `${id}.json`);
  await guardPath(targetPath, wrapDir);

  await withLock(wrapDir, async () => {
    try {
      await stat(targetPath);
    } catch {
      throw new ProjectLoaderError(
        "not_found",
        `Issue file not found: issues/${id}.json`,
      );
    }
    await unlink(targetPath);
  });
}

/**
 * Writes a note file WITHOUT acquiring the project lock.
 * Use inside withProjectLock when the lock is already held.
 */
export async function writeNoteUnlocked(
  note: Note,
  root: string,
): Promise<void> {
  const parsed = NoteSchema.parse(note);
  if (!NOTE_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid note ID: ${parsed.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "notes", `${parsed.id}.json`);
  await mkdir(dirname(targetPath), { recursive: true });
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  await atomicWrite(targetPath, json);
}

export async function writeNote(
  note: Note,
  root: string,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  await withLock(wrapDir, async () => {
    await writeNoteUnlocked(note, root);
  });
}

export async function deleteNote(
  id: string,
  root: string,
): Promise<void> {
  if (!NOTE_ID_REGEX.test(id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid note ID: ${id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "notes", `${id}.json`);
  await guardPath(targetPath, wrapDir);

  await withLock(wrapDir, async () => {
    try {
      await stat(targetPath);
    } catch {
      throw new ProjectLoaderError(
        "not_found",
        `Note file not found: notes/${id}.json`,
      );
    }
    await unlink(targetPath);
  });
}

// --- Locked Project Operations ---

export interface WithProjectLockOptions {
  strict?: boolean;
}

/**
 * Acquires the project lock, loads fresh state, optionally enforces strict mode,
 * then calls the handler. Released in finally.
 * Use for create/update operations that need atomic load→validate→write.
 */
export async function withProjectLock(
  root: string,
  options: WithProjectLockOptions,
  handler: (result: LoadResult) => Promise<void>,
): Promise<void> {
  const absRoot = resolve(root);
  const wrapDir = join(absRoot, ".story");

  await withLock(wrapDir, async () => {
    // Run transaction recovery before reading (same as loadProject)
    await doRecoverTransaction(wrapDir);

    const result = await loadProjectUnlocked(absRoot);

    // Check schemaVersion (same guard as loadProject)
    const config = result.state.config;
    if (
      config.schemaVersion !== undefined &&
      config.schemaVersion > CURRENT_SCHEMA_VERSION
    ) {
      throw new ProjectLoaderError(
        "version_mismatch",
        `Config schemaVersion ${config.schemaVersion} exceeds max supported ${CURRENT_SCHEMA_VERSION}.`,
      );
    }

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

    await handler(result);
  });
}

// --- Transaction Journal ---

interface TxnEntry {
  op: "write" | "delete";
  target: string;
  tempPath?: string;
}

interface TxnJournal {
  entries: TxnEntry[];
  commitStarted: boolean;
}

/**
 * Executes multiple file operations atomically with a transaction journal.
 * Forward-only recovery: if any rename succeeds, complete remaining.
 * Does NOT acquire the lock — caller must hold it.
 *
 * The journal persists a `commitStarted` flag so recovery can distinguish
 * "prepared" (safe to roll back) from "committing" (must complete forward).
 */
export async function runTransactionUnlocked(
  root: string,
  operations: Array<
    | { op: "write"; target: string; content: string }
    | { op: "delete"; target: string }
  >,
): Promise<void> {
  const wrapDir = resolve(root, ".story");
  const journalPath = join(wrapDir, ".txn.json");
  const entries: TxnEntry[] = [];
  let commitStarted = false;

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
    const journal: TxnJournal = { entries, commitStarted: false };
    await fsyncWrite(journalPath, JSON.stringify(journal, null, 2));

    // 3. Write temp files
    for (const op of operations) {
      if (op.op === "write") {
        const tempPath = `${op.target}.${process.pid}.tmp`;
        await fsyncWrite(tempPath, op.content);
      }
    }

    // 4. Mark commit started in journal (durable marker for recovery)
    journal.commitStarted = true;
    await fsyncWrite(journalPath, JSON.stringify(journal, null, 2));
    commitStarted = true;

    // 5. Commit: rename all temps, delete targets
    for (const entry of entries) {
      if (entry.op === "write" && entry.tempPath) {
        await rename(entry.tempPath, entry.target);
      } else if (entry.op === "delete") {
        try {
          await unlink(entry.target);
        } catch {
          // Target may already be gone
        }
      }
    }

    // 6. Remove journal
    await unlink(journalPath);
  } catch (err) {
    if (!commitStarted) {
      // Safe to clean up — no renames have happened
      for (const entry of entries) {
        if (entry.tempPath) {
          try {
            await unlink(entry.tempPath);
          } catch {
            /* ignore */
          }
        }
      }
      try {
        await unlink(journalPath);
      } catch {
        /* ignore */
      }
    }
    // If commitStarted, leave journal for recovery on next load
    if (err instanceof ProjectLoaderError) throw err;
    throw new ProjectLoaderError("io_error", "Transaction failed", err);
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
/** Internal recovery — must be called under lock or when no concurrent access is possible. */
async function doRecoverTransaction(wrapDir: string): Promise<void> {
  const journalPath = join(wrapDir, ".txn.json");

  let entries: TxnEntry[];
  let commitStarted = false;
  try {
    const raw = await readFile(journalPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    // Support both old format (TxnEntry[]) and new format (TxnJournal)
    if (Array.isArray(parsed)) {
      // Legacy format: array of entries, no commitStarted marker
      // Assume commit may have started (conservative — complete forward)
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
      // Malformed journal — delete and return
      try {
        await unlink(journalPath);
      } catch {
        /* ignore */
      }
      return;
    }
  } catch {
    // Invalid journal — just delete it
    try {
      await unlink(journalPath);
    } catch {
      /* ignore */
    }
    return;
  }

  if (!commitStarted) {
    // Commit never started — safe to clean up temps and remove journal
    for (const entry of entries) {
      if (entry.op === "write" && entry.tempPath && existsSync(entry.tempPath)) {
        try {
          await unlink(entry.tempPath);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      await unlink(journalPath);
    } catch {
      /* ignore */
    }
    return;
  }

  // commitStarted=true — complete the transaction forward
  for (const entry of entries) {
    if (entry.op === "write" && entry.tempPath) {
      const tempExists = existsSync(entry.tempPath);

      if (tempExists) {
        // Temp exists — complete the rename (whether or not target exists)
        try {
          await rename(entry.tempPath, entry.target);
        } catch {
          /* ignore — clean up below */
        }
        // Clean up any leftover temp
        try {
          await unlink(entry.tempPath);
        } catch {
          /* ignore */
        }
      }
    } else if (entry.op === "delete") {
      // Replay delete entries that didn't complete
      try {
        await unlink(entry.target);
      } catch {
        // Target may already be gone — that's fine
      }
    }
  }

  // Delete journal
  try {
    await unlink(journalPath);
  } catch {
    /* ignore */
  }
}

/**
 * Internal load without lock acquisition or recovery — used by deleteTicket
 * which already holds the lock.
 */
async function loadProjectUnlocked(absRoot: string): Promise<LoadResult> {
  const wrapDir = join(absRoot, ".story");
  const config = await loadSingletonFile<Config>("config.json", wrapDir, absRoot, ConfigSchema);
  const roadmap = await loadSingletonFile<Roadmap>("roadmap.json", wrapDir, absRoot, RoadmapSchema);
  const warnings: LoadWarning[] = [];
  const tickets = await loadDirectory<Ticket>(join(wrapDir, "tickets"), absRoot, TicketSchema, warnings);
  const issues = await loadDirectory<Issue>(join(wrapDir, "issues"), absRoot, IssueSchema, warnings);
  const notes = await loadDirectory<Note>(join(wrapDir, "notes"), absRoot, NoteSchema as unknown as ZodType<Note>, warnings);
  const handoverFilenames = await listHandovers(join(wrapDir, "handovers"), absRoot, warnings);
  const state = new ProjectState({ tickets, issues, notes, roadmap, config, handoverFilenames });
  return { state, warnings };
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
): Promise<T[]> {
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

  const results: T[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (extname(entry) !== ".json") continue;

    const filePath = join(dirPath, entry);
    const relPath = relative(root, filePath);

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      const result = schema.safeParse(parsed);
      if (!result.success) {
        warnings.push({
          file: relPath,
          message: result.error.issues.map((i) => i.message).join("; "),
          type: "schema_error",
        });
        continue;
      }
      results.push(result.data);
    } catch (err) {
      warnings.push({
        file: relPath,
        message: err instanceof Error ? err.message : String(err),
        type: "parse_error",
      });
    }
  }

  return results;
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

/** Atomic write: write to temp file, then rename. */
export async function atomicWrite(
  targetPath: string,
  content: string,
): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, targetPath);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      /* ignore cleanup errors */
    }
    throw new ProjectLoaderError(
      "io_error",
      `Failed to write ${basename(targetPath)}`,
      err,
    );
  }
}

/** Write with fsync for durability (used for journal files). */
async function fsyncWrite(
  filePath: string,
  content: string,
): Promise<void> {
  const fh = await open(filePath, "w");
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

  const targetDir = dirname(target);
  let resolvedDir: string;
  try {
    resolvedDir = await realpath(targetDir);
  } catch {
    // Parent dir doesn't exist — check that the grandparent resolves under root
    resolvedDir = targetDir;
  }

  if (!resolvedDir.startsWith(resolvedRoot)) {
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
      // lstat failed for other reason — continue
    }
  }
}

/** Acquires a project lock, executes fn, releases in finally. */
async function withLock<T>(
  wrapDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(wrapDir, {
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
      stale: 10000,
      lockfilePath: join(wrapDir, ".lock"),
    });
  } catch (err) {
    if (err instanceof ProjectLoaderError) throw err;
    throw new ProjectLoaderError(
      "io_error",
      `Lock acquisition failed for ${wrapDir}`,
      err,
    );
  }
  try {
    return await fn();
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        /* ignore unlock errors */
      }
    }
  }
}
