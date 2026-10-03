import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { recordBoardTarget } from "../../core/board-write-recorder.js";
import { verifyDirIdentity, type DirIdentity } from "../../core/readdir-safe.js";
import { checkCapabilities, resolveHead } from "../../core/capability.js";
import { glossaryCatalog } from "../../core/glossary.js";
import { currentCliVersion } from "../../core/team-capabilities.js";
import { readBoundedFileDetailed } from "../../core/bounded-read.js";
import { ExitCode, formatError } from "../../core/output-formatter.js";
import type { OutputFormat } from "../../models/types.js";
import {
  computeDecisionsProjection,
  defaultUpwardBoard,
  hashPass,
  ledgerRevision,
  ProjectionError,
  type ProjectionDeps,
  type ProjectionMode,
} from "../../core/decisions-projection.js";
import { capabilityCatalog } from "./capability.js";
import type { CommandResult } from "../types.js";

/**
 * T-528: publishing the decisions projection.
 *
 * One file, `.story/cache/decisions-projection.json`, written whole by a
 * temporary file and one rename and nothing else, so an abort or a killed process leaves the
 * previous projection or none, never part of one. Writers serialize on their
 * own lock, `.story/cache/.projection.lock`; the ledger lock is never taken or
 * held here, so a projection write can never stall a ledger write.
 *
 * Two modes, so no call site promises a budget the checker cannot keep:
 * `full` (the explicit command and the MCP tool) runs the freshness check
 * under its own 30 s deadline and waits up to 5 s for the lock; `structural`
 * (every implicit site) skips freshness, records it `not-checked`, and skips
 * at once when another writer holds the lock.
 */

export const PROJECTION_FILE = "decisions-projection.json";
export const CACHE_GITIGNORE = "*\n";
export const FULL_LOCK_WAIT_MS = 5_000;
export const IMPLICIT_DEADLINE_MS = 3_000;
export const SESSION_START_DEADLINE_MS = 1_000;
/** Bound on reading back a stored projection's revision. */
const STORED_PROJECTION_MAX_BYTES = 64 * 1024 * 1024;

export function projectionPath(root: string): string {
  return join(resolve(root), ".story", "cache", PROJECTION_FILE);
}

/** Test seam: counts publications per root. Never set outside tests. */
export const projectionTestHooks: { onPublish?: (root: string) => void; afterTempWrite?: () => void } = {};

/**
 * A budget checked at every phase boundary. The phases are synchronous and
 * cannot be preempted, so this guarantees "no publication after the deadline",
 * not an interrupted phase; the hook's own registered timeout is the hard stop.
 */
export class WriteDeadline {
  private readonly expiresAt: number;
  constructor(budgetMs: number, private readonly now: () => number = Date.now) {
    this.expiresAt = now() + budgetMs;
  }
  check(phase: string): void {
    if (this.now() >= this.expiresAt) throw new ProjectionError(`deadline passed (${phase})`);
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Creates `.story/cache/` with its own `.gitignore`, so a project whose
 * `.story/.gitignore` predates T-528 never commits the cache. Every component
 * is lstat-checked before anything is created or written, as the spawn
 * directory is: a symlink planted at `.story`, `.story/cache` or the ignore
 * file never redirects a write outside the project.
 */
export interface CacheDir {
  readonly storyDir: string;
  readonly cacheDir: string;
  readonly storyIdentity: DirIdentity;
  readonly cacheIdentity: DirIdentity;
}

export function ensureCacheDir(root: string): CacheDir {
  const storyDir = join(resolve(root), ".story");
  const storyStat = lstatOrNull(storyDir);
  if (storyStat === null || !storyStat.isDirectory()) throw new ProjectionError(`${storyDir} is not a directory (symlinks are not followed)`);
  const cacheDir = join(storyDir, "cache");
  if (lstatOrNull(cacheDir) === null) {
    try {
      mkdirSync(cacheDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const cacheStat = lstatOrNull(cacheDir);
  if (cacheStat === null || !cacheStat.isDirectory()) throw new ProjectionError(`${cacheDir} is not a directory (symlinks are not followed)`);
  const ignorePath = join(cacheDir, ".gitignore");
  if (lstatOrNull(ignorePath) === null) {
    try {
      writeFileSync(ignorePath, CACHE_GITIGNORE, { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const ignoreStat = lstatOrNull(ignorePath);
  if (ignoreStat === null || !ignoreStat.isFile()) throw new ProjectionError(`${ignorePath} is not a regular file (symlinks are not followed)`);
  if (readFileSync(ignorePath, "utf-8") !== CACHE_GITIGNORE) writeFileSync(ignorePath, CACHE_GITIGNORE, "utf-8");
  return {
    storyDir,
    cacheDir,
    storyIdentity: { dev: storyStat.dev, ino: storyStat.ino },
    cacheIdentity: { dev: cacheStat.dev, ino: cacheStat.ino },
  };
}

/**
 * `.story` and `.story/cache` are still the directories `ensureCacheDir`
 * validated. A replacement (renamed away, a symlink to somewhere else planted
 * in its place) between validation and a write aborts the write, so the
 * projection never lands outside the project.
 */
function verifyCacheDir(dir: CacheDir, phase: string): void {
  const drift = verifyDirIdentity(dir.storyDir, dir.storyIdentity) ?? verifyDirIdentity(dir.cacheDir, dir.cacheIdentity);
  if (drift !== null) throw new ProjectionError(`cache directory replaced (${phase}): ${drift}`);
}

/**
 * The publication: a temporary file created exclusively in the validated cache
 * directory, then renamed over the projection. The deadline and the directory
 * identities are checked after the temporary write and immediately before the
 * rename, so a write that crosses the deadline or a replaced directory leaves
 * the previous projection in place. The window between that check and the
 * rename is the same checkpoint residual the capture names.
 */
function publish(dir: CacheDir, content: string, deadline: WriteDeadline): string {
  const path = join(dir.cacheDir, PROJECTION_FILE);
  verifyCacheDir(dir, "before the temporary write");
  const tempPath = join(dir.cacheDir, `.${PROJECTION_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let written = false;
  try {
    const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    written = true;
    try {
      writeFileSync(fd, content, "utf-8");
    } finally {
      closeSync(fd);
    }
    projectionTestHooks.afterTempWrite?.();
    deadline.check("publication");
    verifyCacheDir(dir, "publication");
    renameSync(tempPath, path);
    recordBoardTarget(path, "write");
    written = false;
    return path;
  } finally {
    if (written) {
      try {
        // Only from the directory that was validated; a replaced one is left alone.
        verifyCacheDir(dir, "cleanup");
        unlinkSync(tempPath);
      } catch {
        /* best effort */
      }
    }
  }
}

export interface WriteProjectionOptions {
  readonly mode: ProjectionMode;
  readonly deadlineMs: number;
  /** SessionStart records no head: it runs no git at all. */
  readonly recordHead?: boolean;
  readonly deps?: Partial<ProjectionDeps>;
  readonly now?: () => number;
  /** Test seams, forwarded to the capture. */
  readonly betweenPasses?: () => void | Promise<void>;
  readonly afterLock?: () => void | Promise<void>;
}

export interface WriteProjectionOutcome {
  readonly path: string;
  readonly ledgerRevision: string | null;
  readonly mode: ProjectionMode;
  readonly counts: { readonly rulings: number; readonly citations: number; readonly capabilities: number; readonly terms: number };
}

function defaultDeps(root: string, recordHead: boolean): ProjectionDeps {
  return {
    now: () => new Date(),
    cliVersion: currentCliVersion() ?? "unknown",
    headCommit: recordHead ? () => resolveHead(root) : async () => null,
    check: (entries, state, options) => checkCapabilities(root, entries, state, options),
    upwardBoard: defaultUpwardBoard,
  };
}

export async function writeDecisionsProjection(root: string, opts: WriteProjectionOptions): Promise<WriteProjectionOutcome> {
  const deadline = new WriteDeadline(opts.deadlineMs, opts.now);
  const cache = ensureCacheDir(root);
  const { cacheDir } = cache;
  const deps: ProjectionDeps = { ...defaultDeps(root, opts.recordHead ?? true), ...opts.deps };

  let release: (() => Promise<void>) | undefined;
  try {
    try {
      release = await lockfile.lock(cacheDir, {
        retries: opts.mode === "full" ? { retries: 10, factor: 1, minTimeout: FULL_LOCK_WAIT_MS / 10, maxTimeout: FULL_LOCK_WAIT_MS / 10 } : 0,
        stale: 30_000,
        lockfilePath: join(cacheDir, ".projection.lock"),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new ProjectionError("another writer holds the lock");
      throw error;
    }
    deadline.check("lock acquired");
    await opts.afterLock?.();

    const { projection, revision } = await computeDecisionsProjection(root, { capabilities: capabilityCatalog, glossary: glossaryCatalog }, opts.mode, deps, {
      betweenPasses: opts.betweenPasses,
      checkpoint: (phase) => deadline.check(phase),
    });

    deadline.check("serialization");
    const path = publish(cache, JSON.stringify(projection, null, 2) + "\n", deadline);
    projectionTestHooks.onPublish?.(root);
    const count = (key: string): number => (Array.isArray(projection[key]) ? (projection[key] as unknown[]).length : 0);
    return {
      path,
      ledgerRevision: revision,
      mode: opts.mode,
      counts: { rulings: count("rulings"), citations: count("citations"), capabilities: count("capabilities"), terms: count("terms") },
    };
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        /* ignore */
      }
    }
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The implicit sites (ruling, capability and term writes, CLI status): one
 * structural write, after the command's own writes, outside any held lock.
 * A failure never fails the command; it is one line on stderr.
 */
export async function refreshProjectionAfterWrite(root: string, opts: Partial<WriteProjectionOptions> = {}): Promise<boolean> {
  try {
    await writeDecisionsProjection(root, { mode: "structural", deadlineMs: IMPLICIT_DEADLINE_MS, ...opts });
    return true;
  } catch (err) {
    process.stderr.write(`projection not updated: ${reasonOf(err)}\n`);
    return false;
  }
}

/** The revision recorded in the stored projection, or null when there is none to compare. */
export function storedProjectionRevision(root: string): string | null {
  const read = readBoundedFileDetailed(projectionPath(root), STORED_PROJECTION_MAX_BYTES);
  if (read.kind !== "ok") return null;
  try {
    const parsed = JSON.parse(read.text) as { ledgerRevision?: unknown };
    return typeof parsed.ledgerRevision === "string" ? parsed.ledgerRevision : null;
  } catch {
    return null;
  }
}

/**
 * SessionStart: one hash pass computes the revision; when it equals the stored
 * projection's, nothing else happens. Otherwise a structural write with no git
 * at all (no freshness, no head) and a 1 s deadline. A null revision never
 * counts as equal: it names no ledger.
 */
export async function refreshProjectionAtSessionStart(
  root: string,
  opts: Partial<WriteProjectionOptions> = {},
): Promise<"unchanged" | "written" | "failed"> {
  try {
    const current = ledgerRevision(hashPass(root));
    if (current !== null && current === storedProjectionRevision(root)) return "unchanged";
    await writeDecisionsProjection(root, { mode: "structural", deadlineMs: SESSION_START_DEADLINE_MS, recordHead: false, ...opts });
    return "written";
  } catch (err) {
    process.stderr.write(`projection not updated: ${reasonOf(err)}\n`);
    return "failed";
  }
}

/** `storybloq projection write` and the MCP `storybloq_projection_write`: full mode. */
export async function handleProjectionWrite(format: OutputFormat, root: string, opts: Partial<WriteProjectionOptions> = {}): Promise<CommandResult> {
  try {
    const out = await writeDecisionsProjection(root, { mode: "full", deadlineMs: 60_000, ...opts });
    if (format === "json") {
      return { output: JSON.stringify({ ok: true, ...out }, null, 2) };
    }
    const c = out.counts;
    return {
      output: `Projection written: .story/cache/${PROJECTION_FILE} (revision ${out.ledgerRevision ?? "none: an input was unreadable"}; ${c.rulings} rulings, ${c.citations} citations, ${c.capabilities} capabilities, ${c.terms} terms).`,
    };
  } catch (err) {
    return {
      output: formatError("io_error", `projection not updated: ${reasonOf(err)}`, format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "io_error",
    };
  }
}
