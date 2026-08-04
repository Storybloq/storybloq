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
import { existsSync } from "node:fs";
import { join, resolve, relative, extname, dirname, basename, sep, isAbsolute } from "node:path";
import lockfile from "proper-lockfile";
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
} from "../models/types.js";
import { ProjectState } from "./project-state.js";
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
  const tickets = await loadDirectory<Ticket>(
    join(wrapDir, "tickets"),
    absRoot,
    TicketSchema,
    warnings,
    "ticket",
    fileClassifications,
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
export async function writeTicketUnlocked(
  ticket: Ticket,
  root: string,
  options?: { createOnly?: boolean },
): Promise<void> {
  const parsed = TicketSchema.parse(ticket);
  if (!TICKET_ID_REGEX.test(parsed.id) && !TICKET_CANONICAL_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid ticket ID: ${parsed.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "tickets", `${parsed.id}.json`);
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  if (options?.createOnly) {
    await atomicCreate(targetPath, json);
  } else {
    await atomicWrite(targetPath, json);
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
export async function writeIssueUnlocked(
  issue: Issue,
  root: string,
  options?: { createOnly?: boolean },
): Promise<void> {
  const parsed = IssueSchema.parse(issue);
  if (!ISSUE_ID_REGEX.test(parsed.id) && !ISSUE_CANONICAL_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError(
      "invalid_input",
      `Invalid issue ID: ${parsed.id}`,
    );
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "issues", `${parsed.id}.json`);
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  if (options?.createOnly) {
    await atomicCreate(targetPath, json);
  } else {
    await atomicWrite(targetPath, json);
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
    await assertNoConflictsFromDisk(root);
    await writeRoadmapUnlocked(roadmap, root);
  });
}

export async function writeConfigUnlocked(
  config: Config,
  root: string,
): Promise<void> {
  const parsed = ConfigSchema.parse(config);
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "config.json");
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  await atomicWrite(targetPath, json);
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
      raw.lifecycle = "deleted";
      raw.deletedAt = new Date().toISOString();
      raw.deletedBy = await resolveActor(root, options?.actor);
      await atomicWrite(targetPath, serializeJSON(raw));
    } else {
      await unlink(targetPath);
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
      raw.lifecycle = "deleted";
      raw.deletedAt = new Date().toISOString();
      raw.deletedBy = await resolveActor(root, options?.actor);
      await atomicWrite(targetPath, serializeJSON(raw));
    } else {
      await unlink(targetPath);
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
  options?: { createOnly?: boolean },
): Promise<void> {
  const parsed = NoteSchema.parse(note);
  if (!NOTE_ID_REGEX.test(parsed.id) && !NOTE_CANONICAL_ID_REGEX.test(parsed.id)) {
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
  if (options?.createOnly) {
    await atomicCreate(targetPath, json);
  } else {
    await atomicWrite(targetPath, json);
  }
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
      await unlink(targetPath);
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
    await unlink(targetPath);
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
  });
}

export async function withProjectLock(
  root: string,
  options: WithProjectLockOptions,
  handler: (result: LoadResult) => Promise<void>,
): Promise<void> {
  return withProjectLockInternal(root, options, handler);
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

interface TxnJournal {
  entries: TxnEntry[];
  commitStarted: boolean;
}

/**
 * Executes multiple file operations atomically with a transaction journal.
 * Forward-only recovery: if any rename succeeds, complete remaining.
 * Does NOT acquire the lock -- caller must hold it.
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
      // Safe to clean up -- no renames have happened
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
/** Internal recovery -- must be called under lock or when no concurrent access is possible. */
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
      // Malformed journal -- delete and return
      try {
        await unlink(journalPath);
      } catch {
        /* ignore */
      }
      return;
    }
  } catch {
    // Invalid journal -- just delete it
    try {
      await unlink(journalPath);
    } catch {
      /* ignore */
    }
    return;
  }

  if (!commitStarted) {
    // Commit never started -- safe to clean up temps and remove journal
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

  // commitStarted=true -- complete the transaction forward
  for (const entry of entries) {
    if (entry.op === "write" && entry.tempPath) {
      const tempExists = existsSync(entry.tempPath);

      if (tempExists) {
        // Temp exists -- complete the rename (whether or not target exists)
        try {
          await rename(entry.tempPath, entry.target);
        } catch {
          /* ignore -- clean up below */
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
        // Target may already be gone -- that's fine
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
 * Internal load without lock acquisition or recovery -- used by deleteTicket
 * which already holds the lock.
 */
async function loadProjectUnlocked(absRoot: string): Promise<LoadResult> {
  const wrapDir = join(absRoot, ".story");
  const config = await loadSingletonFile<Config>("config.json", wrapDir, absRoot, ConfigSchema);
  const roadmap = await loadSingletonFile<Roadmap>("roadmap.json", wrapDir, absRoot, RoadmapSchema);
  const warnings: LoadWarning[] = [];
  const fileClassifications = new Map<string, "legacy" | "team">();
  const tickets = await loadDirectory<Ticket>(join(wrapDir, "tickets"), absRoot, TicketSchema, warnings, "ticket", fileClassifications);
  const issues = await loadDirectory<Issue>(join(wrapDir, "issues"), absRoot, IssueSchema, warnings, "issue", fileClassifications);
  const notes = await loadDirectory<Note>(join(wrapDir, "notes"), absRoot, NoteSchema, warnings, "note", fileClassifications);
  const lessons = await loadDirectory<Lesson>(join(wrapDir, "lessons"), absRoot, LessonSchema, warnings, "lesson", fileClassifications);
  const handoverFilenames = await listHandovers(join(wrapDir, "handovers"), absRoot, warnings);
  const state = new ProjectState({ tickets, issues, notes, lessons, roadmap, config, handoverFilenames });
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

  const entityDir = basename(dirPath);
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
      const data = result.data as Record<string, unknown>;
      if (typeof data.id === "string") {
        const stem = basename(entry, ".json");
        const stemMatchesId = stem === data.id;
        if (!stemMatchesId) {
          warnings.push({
            file: relPath,
            message: `Filename stem "${stem}" does not match content id "${data.id}"`,
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

/** Atomic create: write to temp file, then link (fails if target exists). */
export async function atomicCreate(
  targetPath: string,
  content: string,
): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: import("node:fs/promises").FileHandle | undefined;
  try {
    fd = await open(tempPath, "wx", 0o600);
    await fd.writeFile(content, "utf-8");
    await fd.sync();
    await fd.close();
    fd = undefined;
    await link(tempPath, targetPath);
    const parentFd = await open(dirname(targetPath), "r");
    try { await parentFd.sync(); } finally { await parentFd.close(); }
  } catch (err) {
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
    // Parent dir doesn't exist -- check that the grandparent resolves under root
    resolvedDir = targetDir;
  }

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
