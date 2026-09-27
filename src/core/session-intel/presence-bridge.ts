/**
 * T-499: the presence bridge -- everything that reads or writes the
 * `sessionIntel` subtree of a presence record from the heavy path.
 *
 *   caller binding      may THIS process push or persist for a session?
 *   target provenance   which era and capture does the TARGET session have?
 *   reconciliation      apply compaction boundaries and pending files under
 *                       the record lock, returning complete | incomplete;
 *   persistence rule    accept a sample only when it provably describes the
 *                       file the record describes (era, revision, incarnation,
 *                       baseline anchor, incoming anchor, byte order);
 *   handover stamp      record a handover against the current boundary.
 *
 * Every locked section goes through `applyPresenceEnrichment` so the presence
 * hook's own lock and atomic write are the only primitives used.
 */

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ABORT_ENRICHMENT, applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS, TRY_LOCK_BUDGET_MS, type EnrichmentOutcome } from "../presence-enrichment.js";
import { currentClientTaskId, currentStorybloqClient } from "../../autonomous/client-profile.js";
import { assertNoSymlinkOnPath } from "../skill-sync-check.js";
import { presenceDirIfPresent, readBoundedNoFollow, directoryIdentity, ensureTelemetrySubdir, removeRegularFile, telemetrySubdirIfPresent } from "../../presence/io.js";
import { parsePresenceRecord } from "../../presence/record.js";
import { MAX_RECORD_BYTES, presenceFileBase, type SessionPresence } from "../../presence/types.js";
import { emptySessionIntel, type Epoch, type SessionIntelPresence, type SessionIntelSample, type TokenPressureState } from "../../presence/session-intel-fields.js";
import type { SessionIntelConfig } from "./config.js";
import { readEra, type EraEntry } from "./era-store.js";
import { processEra, type ProcessCheck, type ProcessEraResolver } from "./process-era.js";
import { anchorsStillMatch, scanBackwardForBoundary } from "./transcript-scan.js";
import type { TargetProvenance, TokenPressureSample, TranscriptBoundary } from "./types.js";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function readPresenceRecord(root: string, sessionId: string): SessionPresence | null {
  const dir = presenceDirIfPresent(root);
  if (!dir) return null;
  const text = readBoundedNoFollow(join(dir, `${presenceFileBase(sessionId)}.json`), MAX_RECORD_BYTES);
  return text === null ? null : parsePresenceRecord(text, sessionId);
}

/**
 * Provenance for the TARGET session, never the caller: the era on its
 * presence record and the capture from the era store (authoritative), or the
 * record's own copy when the store has no entry.
 */
export function resolveTargetProvenance(root: string | null, sessionId: string): TargetProvenance {
  if (!root) return { era: null, capture: null };
  const record = readPresenceRecord(root, sessionId);
  const intel = record?.sessionIntel ?? null;
  if (!intel) return { era: null, capture: null };
  const entry = intel.era ? readEra(root, intel.era) : null;
  if (entry) {
    // T-501: the source travels with the window in BOTH branches. It only
    // ever names the file the value came from; older or incomplete data
    // reports null and the advisory then names no file at all.
    return { era: intel.era, capture: { captureKind: entry.captureKind, autoCompactWindowAtStart: entry.autoCompactWindowAtStart, autoCompactWindowSource: entry.autoCompactWindowSource, capturedAt: entry.capturedAt } };
  }
  if (intel.capturedAt === null && intel.autoCompactWindowAtStart === null) return { era: intel.era, capture: null };
  return { era: intel.era, capture: { captureKind: intel.captureKind, autoCompactWindowAtStart: intel.autoCompactWindowAtStart, autoCompactWindowSource: intel.autoCompactWindowSource, capturedAt: intel.capturedAt } };
}

// ---------------------------------------------------------------------------
// Worktree fallback (ISS-1185)
//
// The MCP server's own root and the hook cwd that actually WRITES presence
// records can resolve to two different `.story` directories: a git worktree
// is the field case (the server launched from the main checkout, hooks
// running with cwd = a worktree). This walk FINDS an existing record under a
// sibling worktree; it never creates one. Strictly opt-in (the `walk`
// parameter below): every existing 2-3 arg `resolveCallerBinding` call site
// (all of query.ts's sampleSession) takes zero fallback code path, so
// sampleSession's own binding + persistence semantics are byte-identical to
// before this ticket.
// ---------------------------------------------------------------------------

export interface WorktreeWalkOptions {
  readonly deadline?: number;
  readonly clock?: () => number;
}

const GIT_TIMEOUT_MS_DEFAULT = 1000;
const WORKTREE_DISCOVERY_MAX_BUFFER = 1024 * 1024;
const WORKTREE_DISCOVERY_DEFAULT_LIMIT = 32;
/**
 * Absolute parse cap. The memo below holds up to this many roots and `limit`
 * slices what each caller sees, so one spawn serves callers asking for
 * different limits.
 */
const WORKTREE_DISCOVERY_MAX_ROOTS = 64;
/**
 * ISS-1211 gate: a FAILED discovery is remembered this long. Nothing about a
 * failure is cached permanently (a repo can be initialized, git can be
 * installed), but one short-lived hook process must never pay for git twice,
 * and a long-lived server retries within seconds.
 */
export const WORKTREE_DISCOVERY_FAILURE_TTL_MS = 10_000;

/**
 * ISS-1211 gate round 2: a SUCCESSFUL discovery expires just as fast, because
 * the worktree set is not a fixed property of a repository. The orchestrator
 * working style adds a worktree mid-session and a hook running there writes
 * its presence record under it; an MCP server that had already listed the
 * repo would otherwise never see that worktree again, and ISS-1185's whole
 * point (find the record wherever the hook wrote it) would be undone for the
 * life of the server. A hook process still pays for git exactly once; a
 * long-lived server re-lists within seconds.
 */
export const WORKTREE_DISCOVERY_SUCCESS_TTL_MS = 10_000;

/** Test seam: `git worktree list` spawns this process has actually made. */
export const worktreeDiscoveryStats = { spawns: 0 };

const discoveryCache = new Map<string, { readonly roots: string[]; readonly at: number }>();
const discoveryFailures = new Map<string, number>();

/**
 * Both memos measure elapsed time against the caller's clock. A NEGATIVE
 * elapsed means this caller's clock disagrees with the one that wrote the
 * entry (a test seam, or an injected budget clock), so the entry is treated as
 * expired and the answer is re-resolved rather than honoured against a
 * different time base.
 */
const withinTtl = (recordedAt: number, now: number, ttlMs: number): boolean => {
  const elapsed = now - recordedAt;
  return elapsed >= 0 && elapsed < ttlMs;
};

/** Forgets both the successful and the failed discoveries. Tests only. */
export function resetWorktreeDiscoveryCache(): void {
  discoveryCache.clear();
  discoveryFailures.clear();
}

/**
 * The main checkout plus every worktree `git worktree list --porcelain -z`
 * reports for `root`, capped at `limit`. `-z` (NUL-delimited) avoids any
 * quoting/escaping of path bytes that line-based porcelain output applies.
 * Any git failure (absent binary, not a repository, timeout) returns `[]`:
 * this is a fallback only, never the primary path. The deadline is checked
 * with a SINGLE `clock()` call before deciding whether to invoke git at all,
 * so a deadline that expires between the check and the read can never turn
 * into a zero (unbounded) `execFileSync` timeout.
 *
 * ISS-1211 gate: the result is memoized per root, for a SHORT TTL in both
 * directions (success and failure). The worktree LIST is what is cached, never
 * a verdict about any root's contents, so every caller still re-checks safety
 * and identity at use. The memo is what lets the boundary-ledger routing and
 * the presence walk share one spawn on a path (`handleSessionIntel`) that
 * reaches both; the TTL is what keeps a worktree added after the first listing
 * from being invisible for the life of a long-lived server. A deadline that is
 * already spent still returns `[]` before the memo is consulted: the contract
 * is "no work now", and a caller that had no budget gets no answer rather than
 * a cheaper one it did not ask for.
 */
export function discoverWorktreeRoots(root: string, opts: WorktreeWalkOptions & { readonly limit?: number } = {}): string[] {
  const clock = opts.clock ?? Date.now;
  const now = clock();
  const remaining = opts.deadline !== undefined ? opts.deadline - now : GIT_TIMEOUT_MS_DEFAULT;
  if (remaining <= 0) return [];
  const limit = opts.limit ?? WORKTREE_DISCOVERY_DEFAULT_LIMIT;
  if (limit <= 0) return [];
  const cached = discoveryCache.get(root);
  if (cached !== undefined && withinTtl(cached.at, now, WORKTREE_DISCOVERY_SUCCESS_TTL_MS)) return cached.roots.slice(0, limit);
  const failedAt = discoveryFailures.get(root);
  if (failedAt !== undefined && withinTtl(failedAt, now, WORKTREE_DISCOVERY_FAILURE_TTL_MS)) return [];
  let out: string;
  worktreeDiscoveryStats.spawns++;
  try {
    out = execFileSync("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], {
      encoding: "utf-8",
      timeout: Math.min(GIT_TIMEOUT_MS_DEFAULT, remaining),
      maxBuffer: WORKTREE_DISCOVERY_MAX_BUFFER,
      // This runs on every "no record here" miss across every project, most
      // of which are not worktrees (or not git repos at all): git's own
      // "fatal: not a git repository" must never leak to the real process
      // stderr the way an ad hoc CLI git invocation's would.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    discoveryFailures.set(root, now);
    return [];
  }
  const roots: string[] = [];
  for (const field of out.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    roots.push(field.slice("worktree ".length));
    if (roots.length >= WORKTREE_DISCOVERY_MAX_ROOTS) break;
  }
  if (roots.length === 0) {
    discoveryCache.delete(root);
    discoveryFailures.set(root, now);
    return [];
  }
  discoveryCache.set(root, { roots, at: now });
  discoveryFailures.delete(root);
  return roots.slice(0, limit);
}

export interface CandidateIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface SafeRootOptions {
  /** The directory under `.story/telemetry/` the no-symlink chain is checked down to. */
  readonly subdir: string;
  /**
   * Require `.story/` to already exist. The presence walk does not (it only
   * ever reads, and an absent directory simply misses); the boundary ledger
   * does, because it WRITES and must never seed `.story/` in a checkout that
   * is not a storybloq project.
   */
  readonly requireStory?: boolean;
}

const PRESENCE_ROOT: SafeRootOptions = { subdir: "presence" };

/**
 * A candidate root is safe to read from when it is itself a real directory
 * (not a symlink -- a registered worktree path can be replaced after
 * registration) AND no component from the candidate down through
 * `.story/telemetry/<subdir>` is a symlink (reusing `assertNoSymlinkOnPath`,
 * the same no-follow chain check `scripts/sync-plugin-skill.ts` already
 * relies on). The identity captured here is the SAME `lstatSync` call used
 * for the symlink check, so capture and validation happen atomically.
 */
export function isSafeCandidateRoot(candidate: string, opts: SafeRootOptions = PRESENCE_ROOT): { ok: true; identity: CandidateIdentity } | { ok: false } {
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false };
    if (opts.requireStory === true && directoryIdentity(join(candidate, ".story")) === null) return { ok: false };
    assertNoSymlinkOnPath(candidate, join(candidate, ".story", "telemetry", opts.subdir));
    return { ok: true, identity: { dev: st.dev, ino: st.ino } };
  } catch {
    return { ok: false };
  }
}

/**
 * Identity of a root the CALLER owns, following symlinks deliberately: it is
 * the caller's own trusted argument, not a walked candidate, so this is
 * identity lookup and not the untrusted-candidate symlink walk
 * `isSafeCandidateRoot` guards. `git worktree list` reports realpaths, so a
 * root reached through a symlinked ancestor (macOS resolves its own tmpdir
 * through `/private`) would never string-match its own entry.
 */
export function trustedRootIdentity(root: string): CandidateIdentity | null {
  try {
    const st = fs.statSync(root);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

export const sameIdentity = (a: CandidateIdentity | null, b: CandidateIdentity | null): boolean =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/**
 * Re-runs the exact same safety check and additionally requires the
 * identity to be unchanged since discovery. Mirrors the inode-swap guard
 * already established in `core/limit-lock.ts` (capture an inode, re-check
 * it immediately before a security-relevant operation, refuse on mismatch):
 * this narrows, but does not eliminate, the filesystem TOCTOU window between
 * discovery and use, which is this codebase's already-accepted posture.
 */
export function revalidateCandidateIdentity(candidate: string, expected: CandidateIdentity, opts: SafeRootOptions = PRESENCE_ROOT): boolean {
  const check = isSafeCandidateRoot(candidate, opts);
  return check.ok && sameIdentity(check.identity, expected);
}

export interface WorktreePresenceMatch {
  readonly root: string;
  readonly record: SessionPresence;
  readonly identity: CandidateIdentity;
}

/**
 * Walks `root`'s worktree candidates (skipping `root` itself) looking for a
 * presence record for `sessionId`. Self is excluded by IDENTITY (dev/ino),
 * not by string comparison: `git worktree list` reports its own realpath,
 * so a `root` reached through a symlinked ancestor (a common case -- macOS
 * resolves its own tmpdir through `/private`) would never string-match its
 * own entry and would waste a walk slot re-considering itself. `fs.statSync`
 * on `root` follows symlinks deliberately here: `root` is the caller's own
 * trusted argument, not a walked candidate, so this is identity lookup, not
 * the untrusted-candidate symlink walk `isSafeCandidateRoot` guards.
 *
 * Exact-session-id matching by construction: `readPresenceRecord` always
 * targets `presenceFileBase(sessionId)` specifically, never lists a
 * directory and grabs the first file -- so a candidate holding a DIFFERENT
 * session's record is never mistaken for a match. Returns the first match
 * with its discovery-time identity, or `null`. Find only: never creates
 * anything.
 */
export function findPresenceRecordAcrossWorktrees(root: string, sessionId: string, opts: WorktreeWalkOptions = {}): WorktreePresenceMatch | null {
  const clock = opts.clock ?? Date.now;
  const rootIdentity = trustedRootIdentity(root);
  const candidates = discoverWorktreeRoots(root, opts);
  for (const candidate of candidates) {
    if (opts.deadline !== undefined && clock() >= opts.deadline) return null;
    const safe = isSafeCandidateRoot(candidate);
    if (!safe.ok) continue;
    if (sameIdentity(safe.identity, rootIdentity)) continue;
    const record = readPresenceRecord(candidate, sessionId);
    if (record) return { root: candidate, record, identity: safe.identity };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Caller binding
// ---------------------------------------------------------------------------

export interface CallerBinding {
  readonly sessionId: string | null;
  /** True only when every binding rule holds: record exists, not ended, live non-null era equal to the record's. */
  readonly bound: boolean;
  readonly era: string | null;
  readonly check: ProcessCheck;
  readonly reason: string;
  /** The root the caller's record was actually found under: `root` itself, a worktree found by `walk`, or null when unbound/nothing found. */
  readonly recordRoot: string | null;
  /** Populated only when `recordRoot` came from the worktree walk (never for a record found directly under `root`, which is the MCP server's own pre-existing trust boundary). */
  readonly recordRootIdentity: CandidateIdentity | null;
}

/**
 * `walk` is STRICTLY OPT-IN: `undefined` (every existing 2-3 arg call site)
 * takes zero fallback code path -- behavior is byte-identical to before
 * ISS-1185. Only an explicit object (even `{}`) turns the worktree fallback
 * on, and only when the direct read under `root` misses.
 */
export function resolveCallerBinding(root: string | null, explicitTaskId?: string | null, resolver: ProcessEraResolver = processEra, walk?: WorktreeWalkOptions): CallerBinding {
  if (currentStorybloqClient() !== "claude") return { sessionId: null, bound: false, era: null, check: "unverifiable", reason: "client is not Claude", recordRoot: null, recordRootIdentity: null };
  const sessionId = currentClientTaskId(explicitTaskId);
  if (!sessionId) return { sessionId: null, bound: false, era: null, check: "unverifiable", reason: "no caller session id", recordRoot: null, recordRootIdentity: null };
  const era = resolver.current();
  if (!root) return { sessionId, bound: false, era: era?.id ?? null, check: "unverifiable", reason: "no project", recordRoot: null, recordRootIdentity: null };
  let record = readPresenceRecord(root, sessionId);
  let recordRoot: string | null = record ? root : null;
  let recordRootIdentity: CandidateIdentity | null = null;
  if (!record && walk !== undefined) {
    const match = findPresenceRecordAcrossWorktrees(root, sessionId, walk);
    if (match) {
      record = match.record;
      recordRoot = match.root;
      recordRootIdentity = match.identity;
    }
  }
  if (!record) return { sessionId, bound: false, era: era?.id ?? null, check: "unverifiable", reason: "no presence record for the caller", recordRoot: null, recordRootIdentity: null };
  if (record.endedAt !== null) return { sessionId, bound: false, era: era?.id ?? null, check: "unverifiable", reason: "caller session has ended", recordRoot, recordRootIdentity };
  if (!era) return { sessionId, bound: false, era: null, check: "unverifiable", reason: "process era unknown", recordRoot, recordRootIdentity };
  const check = resolver.revalidate();
  if (check !== "live") return { sessionId, bound: false, era: era.id, check, reason: `process era ${check}`, recordRoot, recordRootIdentity };
  if (record.sessionIntel?.era !== era.id) return { sessionId, bound: false, era: era.id, check, reason: "record era differs from the live process era", recordRoot, recordRootIdentity };
  return { sessionId, bound: true, era: era.id, check, reason: "bound", recordRoot, recordRootIdentity };
}

// ---------------------------------------------------------------------------
// Pending compaction events
// ---------------------------------------------------------------------------

export const PENDING_SUBDIR = "session-intel-pending";
export const PENDING_MAX_LISTED = 32;
export const PENDING_TMP_STALE_MS = 60_000;
const PENDING_MAX_BYTES = 4096;

export interface PendingEvent {
  readonly eventId: string;
  readonly era: string | null;
  readonly at: string;
}

function pendingDirFor(root: string, sessionId: string, create: boolean): string | null {
  const base = create ? ensureTelemetrySubdir(root, PENDING_SUBDIR) : telemetrySubdirIfPresent(root, PENDING_SUBDIR);
  if (!base) return null;
  const dir = join(base, presenceFileBase(sessionId));
  if (directoryIdentity(dir) === null) {
    if (!create) return null;
    try { fs.mkdirSync(dir); } catch { /* identity check decides */ }
    if (directoryIdentity(dir) === null) return null;
  }
  return dir;
}

/**
 * Publishes an immutable pending file atomically: write + fsync to a `.tmp`
 * name, `link` to the final name (no replace; EEXIST with identical content
 * is success), unlink the tmp. Readers never open `.tmp` names.
 */
export function markCompactPending(root: string, sessionId: string, event: PendingEvent): boolean {
  const dir = pendingDirFor(root, sessionId, true);
  if (!dir) return false;
  const safeId = event.eventId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const final = join(dir, `${event.at.replace(/[^0-9TZ.:-]/g, "")}-${safeId}.json`);
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const text = JSON.stringify(event) + "\n";
  const identity = directoryIdentity(dir);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, text, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, final);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
      return readBoundedNoFollow(final, PENDING_MAX_BYTES) === text;
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    removeRegularFile(dir, tmp, identity);
  }
}

export interface PendingListing {
  readonly complete: boolean;
  readonly files: ReadonlyArray<{ readonly name: string; readonly path: string; readonly event: PendingEvent | null; readonly mtimeMs: number }>;
}

const EMPTY_LISTING: PendingListing = { complete: true, files: [] };

/**
 * Lists the pending directory. `sweepTmp` removes stale `.tmp-*` leftovers
 * (locked callers only); a peek never mutates anything.
 */
function listPending(dir: string, now: number, identity: { dev: number; ino: number }, sweepTmp: boolean): PendingListing {
  let names: string[];
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
    for (const e of dirents) {
      if (!sweepTmp || !e.name.startsWith(".tmp-")) continue;
      try {
        const st = fs.lstatSync(join(dir, e.name));
        if (st.isFile() && now - st.mtimeMs > PENDING_TMP_STALE_MS) removeRegularFile(dir, join(dir, e.name), identity);
      } catch { /* gone */ }
    }
    names = dirents.filter((e) => e.name.endsWith(".json")).map((e) => e.name).sort();
  } catch {
    return { complete: false, files: [] };
  }
  const complete = names.length <= PENDING_MAX_LISTED;
  const files = names.slice(0, PENDING_MAX_LISTED).map((name) => {
    const path = join(dir, name);
    let mtimeMs = now;
    try { mtimeMs = fs.lstatSync(path).mtimeMs; } catch { /* keep now */ }
    const text = readBoundedNoFollow(path, PENDING_MAX_BYTES);
    let event: PendingEvent | null = null;
    if (text !== null) {
      try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        if (raw && typeof raw.at === "string" && Number.isFinite(Date.parse(raw.at)) && typeof raw.eventId === "string") {
          event = { eventId: raw.eventId, era: typeof raw.era === "string" ? raw.era : null, at: raw.at };
        }
      } catch { /* unparsable */ }
    }
    return { name, path, event, mtimeMs };
  });
  return { complete, files };
}

interface ResolvedPending {
  readonly dir: string | null;
  readonly identity: { dev: number; ino: number } | null;
  readonly listing: PendingListing;
}

/**
 * Resolves the pending directory AND lists it in one step. Locked callers
 * call this INSIDE the lock so a directory created (and an event published)
 * while the lock was awaited is seen; a cached "absent" from before the
 * lock is never trusted.
 */
function resolvePending(root: string, sessionId: string, now: number, sweepTmp: boolean): ResolvedPending {
  const dir = pendingDirFor(root, sessionId, false);
  const identity = dir ? directoryIdentity(dir) : null;
  return { dir, identity, listing: dir && identity ? listPending(dir, now, identity, sweepTmp) : EMPTY_LISTING };
}

/** Non-mutating view of the pending set, for read-only computation. */
export function peekPending(root: string, sessionId: string, now: number): PendingListing {
  return resolvePending(root, sessionId, now, false).listing;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type Reconciliation = "complete" | "incomplete";

export interface ReconcileInput {
  readonly root: string;
  readonly sessionId: string;
  readonly cfg: SessionIntelConfig;
  /** Boundaries the entry point's own tail scan saw (ascending). */
  readonly tailBoundaries: readonly TranscriptBoundary[];
  /** Authorized transcript path for the backward scan, if any. */
  readonly transcriptPath: string | null;
  readonly source: "compact" | "other";
  readonly now: number;
}

const tsOf = (iso: string) => Date.parse(iso);

/** Applies a boundary newer than `lastBoundaryAt`. Idempotent. Pure. */
export function applyBoundaryReset(intel: SessionIntelPresence, ts: string): SessionIntelPresence {
  if (intel.lastBoundaryAt !== null && tsOf(ts) <= tsOf(intel.lastBoundaryAt)) return intel;
  const handoverAfter = intel.handoverWrittenAt !== null && tsOf(intel.handoverWrittenAt) >= tsOf(ts);
  return {
    ...intel,
    lastBoundaryAt: ts,
    epoch: { kind: "observed", at: ts },
    revision: intel.revision + 1,
    lastSample: null,
    handoverWrittenAt: handoverAfter ? intel.handoverWrittenAt : null,
    tokensAtHandover: handoverAfter ? intel.tokensAtHandover : null,
    handoverBoundaryAt: handoverAfter ? ts : null,
    promptsSinceHandover: handoverAfter ? intel.promptsSinceHandover : 0,
    lastImperativeAt: handoverAfter ? intel.lastImperativeAt : null,
    handoverStampBinding: handoverAfter ? intel.handoverStampBinding : null,
    // ISS-1263: a new compaction is a new epoch; its first imperative is a
    // real event and may be shown.
    lastImperativeEmittedAt: null,
  };
}

/** An expired pending with its boundary out of reach: assumed identity, everything from before it cleared. */
export function applyAssumedReset(intel: SessionIntelPresence, at: string): SessionIntelPresence {
  if (intel.lastBoundaryAt !== null && tsOf(at) <= tsOf(intel.lastBoundaryAt)) return intel;
  return {
    ...intel,
    lastBoundaryAt: at,
    epoch: { kind: "assumed", at },
    revision: intel.revision + 1,
    lastSample: null,
    handoverWrittenAt: null,
    tokensAtHandover: null,
    handoverBoundaryAt: null,
    promptsSinceHandover: 0,
    lastImperativeAt: null,
    handoverStampBinding: null,
    lastImperativeEmittedAt: null,
  };
}

/**
 * The reconciliation steps, pure over an already-listed pending set and an
 * already-found newest boundary. Returns the reconciled subtree, the files
 * to unlink AFTER the record is written, and whether anything remains.
 *
 * Era isolation: a pending event may block or reset the record only when
 * its era is non-null and equals the record's era. A null-era or foreign-era
 * file (an earlier process of a resumed session, an install without
 * CLAUDE_PID) is stale cleanup: unlinked, never counted, never applied.
 */
export function reconcileIntel(
  intel: SessionIntelPresence,
  newestBoundary: TranscriptBoundary | null,
  listing: PendingListing,
  cfg: SessionIntelConfig,
  now: number,
): { intel: SessionIntelPresence; unlink: string[]; remaining: number; status: Reconciliation } {
  let next = intel;
  if (newestBoundary) next = applyBoundaryReset(next, newestBoundary.timestamp);
  const unlink: string[] = [];
  let remaining = 0;
  for (const f of listing.files) {
    if (f.event === null) {
      // Unparsable: pending while young, unlinked once past the TTL.
      if (now - f.mtimeMs > cfg.compactPendingTtlMs) unlink.push(f.path);
      else remaining++;
      continue;
    }
    if (f.event.era === null || intel.era === null || f.event.era !== intel.era) {
      unlink.push(f.path); // foreign or unattributed: cannot describe this era
      continue;
    }
    if (next.lastBoundaryAt !== null && tsOf(f.event.at) <= tsOf(next.lastBoundaryAt)) {
      unlink.push(f.path); // resolved by a boundary at or after it
      continue;
    }
    if (now - tsOf(f.event.at) > cfg.compactPendingTtlMs) {
      next = applyAssumedReset(next, f.event.at);
      unlink.push(f.path);
      continue;
    }
    remaining++;
  }
  const status: Reconciliation = listing.complete && remaining === 0 ? "complete" : "incomplete";
  return { intel: next, unlink, remaining, status };
}

export interface ReconcileOutcome {
  readonly status: Reconciliation;
  readonly enrichment: EnrichmentOutcome | null;
  readonly reason: string | null;
}

/**
 * Runs reconciliation under the presence lock. `budgetMs` is TRY (0) for
 * samplers and bounded-blocking for lifecycle hooks. Busy lock = incomplete.
 * The pending directory is RESOLVED AND LISTED INSIDE the lock (a PreCompact
 * that created the directory and published while the lock was awaited is
 * seen); the unlocked peek only decides the backward scan, which reads the
 * transcript alone. The record is written FIRST; resolved and expired files
 * are unlinked only after the write.
 */
export function reconcileUnderLock(input: ReconcileInput, budgetMs: number): ReconcileOutcome {
  const peek = peekPending(input.root, input.sessionId, input.now);

  let newest: TranscriptBoundary | null = input.tailBoundaries.length ? input.tailBoundaries[input.tailBoundaries.length - 1]! : null;
  if (newest === null && input.transcriptPath && (peek.files.length > 0 || input.source === "compact")) {
    const back = scanBackwardForBoundary({ path: input.transcriptPath, sessionId: input.sessionId, era: null, revisionSeen: null, epochSince: null });
    if (back?.boundary) newest = back.boundary;
  }

  let unlink: string[] = [];
  let status: Reconciliation = "incomplete";
  let locked: ResolvedPending = { dir: null, identity: null, listing: EMPTY_LISTING };
  const enrichment = applyPresenceEnrichment(input.root, input.sessionId, budgetMs, "session-intel", (base) => {
    const current = base.sessionIntel ?? emptySessionIntel();
    locked = resolvePending(input.root, input.sessionId, input.now, true);
    const r = reconcileIntel(current, newest, locked.listing, input.cfg, input.now);
    unlink = r.unlink;
    status = r.status;
    return r.intel !== current ? { ...base, sessionIntel: r.intel } : base;
  }, () => new Date(input.now));

  if (enrichment.status !== "written") {
    return { status: "incomplete", enrichment, reason: `presence write ${enrichment.status}` };
  }
  if (locked.dir && locked.identity) for (const path of unlink) removeRegularFile(locked.dir, path, locked.identity);
  return { status, enrichment, reason: status === "incomplete" ? "pending compaction events remain" : null };
}

// ---------------------------------------------------------------------------
// Persistence rule
// ---------------------------------------------------------------------------

export type PersistOutcome =
  /**
   * `sample` is the verdict as it was computed against the locked record.
   * ISS-1197: the caller must report THIS rather than recompute from `intel`,
   * whose re-arm latches already record that this sample fired.
   */
  | { readonly status: "accepted"; readonly intel: SessionIntelPresence; readonly sample: TokenPressureSample }
  | { readonly status: "rejected"; readonly reason: string }
  /**
   * Not persisted. `validated` is true only when the locked checks RAN and
   * passed (the write itself failed afterwards): the evidence stands. False
   * means the lock was never acquired: nothing about the sample is proven.
   */
  | { readonly status: "skipped"; readonly reason: string; readonly validated: boolean };

export interface PersistInput {
  readonly root: string;
  readonly sessionId: string;
  readonly sample: TokenPressureSample;
  readonly transcriptPath: string;
  readonly cfg: SessionIntelConfig;
  readonly now: number;
  /** Recomputes suppression against the record as it is under the lock. */
  readonly recompute: (record: SessionIntelPresence) => TokenPressureSample;
}

/** The compact form kept on the record. */
export function compactSample(s: TokenPressureSample): SessionIntelSample {
  return {
    sampledAt: s.sampledAt,
    sampledBy: s.sampledBy,
    state: s.state,
    rawState: s.rawState,
    pct: s.pct,
    contextTokens: s.contextTokens,
    ceiling: s.ceiling.ceiling,
    ceilingSource: s.ceiling.source,
    ceilingConfidence: s.ceiling.confidence,
    observation: s.observation,
    imperativeSince: s.imperativeSince,
    suppressedBy: s.suppressedBy,
    // T-501: the INPUTS, not the decision -- so a later render decides under
    // whatever `recommendedWindowMax` is configured then. Null when nothing
    // was resolved, which keeps an unresolved input off the record entirely.
    usageInput: s.usageInput.window === null && s.usageInput.source === null && s.oneMillionFlag === null
      ? null
      : { window: s.usageInput.window, source: s.usageInput.source, oneMillionFlag: s.oneMillionFlag },
  };
}

/** Pure acceptance decision given the record and the current file identity. Exported for tests. */
export function judgeSample(
  intel: SessionIntelPresence,
  sample: TokenPressureSample,
  file: { incarnation: string | null; size: number | null; baselineOk: boolean; incomingOk: boolean },
): { verdict: "accept" | "reject"; reason: string; bumpRevision: boolean } {
  const obs = sample.observation;
  if (obs.era === null || intel.era === null || obs.era !== intel.era) return { verdict: "reject", reason: "era mismatch or null", bumpRevision: false };
  if (!obs.authoritative) return { verdict: "reject", reason: "non-authoritative scan", bumpRevision: false };
  if (obs.revisionSeen !== intel.revision) return { verdict: "reject", reason: `stale revision ${obs.revisionSeen} (record ${intel.revision})`, bumpRevision: false };
  if (file.incarnation === null || file.size === null) return { verdict: "reject", reason: "transcript unreadable at persist", bumpRevision: false };
  if (obs.incarnation !== file.incarnation) return { verdict: "reject", reason: "transcript incarnation replaced", bumpRevision: false };
  // BASELINE: has the file been truncated or rewritten since the record's own anchor?
  if (intel.incarnation === file.incarnation && (file.size < intel.consumedOffset || !file.baselineOk)) {
    return { verdict: "reject", reason: "baseline anchor broken (truncated or rewritten)", bumpRevision: true };
  }
  // INCOMING: does the observation still describe the file?
  if (file.size < obs.consumedOffset || file.size < obs.sizeAtOpen || !file.incomingOk) {
    return { verdict: "reject", reason: "observation anchor broken since read", bumpRevision: true };
  }
  if (intel.incarnation === file.incarnation && obs.consumedOffset < intel.consumedOffset) {
    return { verdict: "reject", reason: "older by byte offset", bumpRevision: false };
  }
  return { verdict: "accept", reason: "accepted", bumpRevision: false };
}

export function persistSample(input: PersistInput): PersistOutcome {
  // Boxed so the closure's assignment is visible to the narrowing below.
  const box: { outcome: PersistOutcome } = { outcome: { status: "skipped", reason: "not attempted", validated: false } };
  const enrichment = applyPresenceEnrichment(input.root, input.sessionId, TRY_LOCK_BUDGET_MS, "session-intel", (base) => {
    const intel = base.sessionIntel ?? emptySessionIntel();
    const obs = input.sample.observation;
    // Binding revalidated against the LOCKED record: an ended session never persists.
    if (base.endedAt !== null) {
      box.outcome = { status: "rejected", reason: "caller session has ended" };
      return base;
    }
    // A compaction that became pending since reconciliation (or one that
    // reconciliation has not applied) means the sample may predate it. The
    // directory is resolved HERE, under the lock: it may not have existed
    // when this call began.
    const pending = resolvePending(input.root, input.sessionId, input.now, false).listing;
    const pend = reconcileIntel(intel, null, pending, input.cfg, input.now);
    if (!pending.complete || pend.remaining > 0 || pend.intel !== intel) {
      box.outcome = { status: "rejected", reason: "compaction pending: reconciliation required" };
      return base;
    }
    // Both anchors through ONE descriptor, then the pathname re-checked.
    const wantBaseline = intel.baselineAnchor !== null;
    const check = anchorsStillMatch(input.transcriptPath, wantBaseline ? [obs.anchor, intel.baselineAnchor!] : [obs.anchor]);
    const baseline = wantBaseline && intel.incarnation === check.incarnation ? check.ok[1]! : true;
    const judged = judgeSample(intel, input.sample, { incarnation: check.incarnation, size: check.size, baselineOk: baseline, incomingOk: check.ok[0]! && check.pathStillIdentifies });
    if (judged.verdict === "reject") {
      box.outcome = { status: "rejected", reason: judged.reason };
      if (!judged.bumpRevision) return base;
      return { ...base, sessionIntel: { ...intel, revision: intel.revision + 1, consumedOffset: 0, baselineAnchor: null, incarnation: check.incarnation, lastSample: null } };
    }
    // Suppression recomputed against the record as it is NOW (a handover
    // stamp that landed between compute and persist is honoured). The epoch
    // is owned by reconciliation, never by a sample.
    // ISS-1197: a prompt that arrives while a handover stands for the current
    // compaction ages the prompt gate. Counted BEFORE the recompute, so the
    // prompt that clears the gate is the one that re-arms.
    const stamped = intel.handoverWrittenAt !== null && intel.handoverBoundaryAt === intel.lastBoundaryAt;
    const counted = stamped && input.sample.sampledBy === "prompt-hook"
      ? { ...intel, promptsSinceHandover: intel.promptsSinceHandover + 1 }
      : intel;
    const recomputed = input.recompute(counted);
    // The latch is a CONSEQUENCE of this sample, so it is written to the
    // record but never fed back into the sample's own verdict: the caller
    // reads `sample`, not a recompute of a record that now says the
    // imperative just fired.
    //
    // Only the prompt hook spends the re-arm, because only its
    // additionalContext reaches the model. A Stop-hook sample that reads
    // imperative delivers nothing, so latching on it would zero the count and
    // restart the interval behind the agent's back, and the next prompt would
    // go silent: the imperative would be swallowed for another full cycle.
    const fired = recomputed.state === "imperative" && input.sample.sampledBy === "prompt-hook";
    const next: SessionIntelPresence = {
      ...counted,
      transcriptPath: input.transcriptPath,
      consumedOffset: obs.consumedOffset,
      incarnation: obs.incarnation,
      baselineAnchor: obs.anchor,
      lastSample: compactSample(recomputed),
      promptsSinceHandover: fired ? 0 : counted.promptsSinceHandover,
      lastImperativeAt: fired ? recomputed.sampledAt : counted.lastImperativeAt,
    };
    box.outcome = { status: "accepted", intel: next, sample: recomputed };
    return { ...base, sessionIntel: next };
  }, () => new Date(input.now));
  if (enrichment.status !== "written") {
    if (box.outcome.status === "rejected") return box.outcome;
    // "accepted" here means the checks passed and only the write failed.
    return { status: "skipped", reason: `presence write ${enrichment.status}`, validated: box.outcome.status === "accepted" };
  }
  return box.outcome;
}

// ---------------------------------------------------------------------------
// Handover stamp
// ---------------------------------------------------------------------------

export type HandoverStampOutcome = EnrichmentOutcome | { readonly status: "refused"; readonly reason: string };

/**
 * ISS-1197 commit 2: an out-parameter filled with the state of the sample the
 * stamp actually saw UNDER THE LOCK. The reply's continuation line depends on
 * it, and reading it from a second, unlocked read would pair a line with a
 * different sample than the one stamped -- the same hazard `tokensAtHandover`
 * is taken inside the lock to avoid.
 *
 * `null` means "say nothing new": no sample, a refusal that returned before
 * the sample was read, or a sample the gates below rejected. The caller keeps
 * its existing continuation line for null. Going neutral instead is not an
 * option -- ISS-1185 exists because agents stopped working without that line.
 */
export interface HandoverStampObservation {
  state: TokenPressureState | null;
}

/**
 * The observation and the banner prefixed to the SAME response must not
 * contradict each other: `runMcpWriteTool` runs the handler first and the
 * banner second, so the banner describes a LATER measurement than the reply
 * line beneath it.
 *
 * The gate is reconciliation, and only reconciliation. An age gate was tried
 * and was itself the defect: context grows monotonically within an epoch and
 * `computeSample` never suppresses compact-needed, so an old stored
 * compact-needed re-samples to compact-needed when the banner refreshes --
 * and refusing to report it printed "held at advisory" directly under a
 * COMPACT-NEEDED banner, the exact contradiction the line exists to prevent.
 * What actually invalidates a sample is a compaction, and a compaction
 * publishes a pending event or a boundary that `reconcileIntel` catches. The
 * config travels for that call.
 */
export interface HandoverStampObserve {
  readonly out: HandoverStampObservation;
  readonly cfg: SessionIntelConfig;
}

/**
 * Stamps a handover on the CALLER's record under the binding rule,
 * revalidated against the locked record: the session must not have ended
 * and its era must be the caller's live (non-null) era. Never creates a
 * subtree for an unbound record.
 *
 * ISS-1263: `mode` "unbound-era" skips ONLY the era-equality check, for a
 * caller whose process era could not be proven (unknown, or unverifiable
 * under load) on a live record with the same session id. Every other refusal
 * stands. The stamp's identity then rests on the session id alone; its worst
 * case is one withheld imperative, where the missing stamp produced a flood.
 */
export function stampHandover(root: string, sessionId: string, expectedEra: string | null, tokensAtHandover: number | null, now: number, observe?: HandoverStampObserve, mode: "bound" | "unbound-era" = "bound"): HandoverStampOutcome {
  let refused: string | null = null;
  const outcome = applyPresenceEnrichment(root, sessionId, LIFECYCLE_LOCK_BUDGET_MS, "session-intel", (base, nowIso) => {
    const intel = base.sessionIntel;
    if (!intel) { refused = mode === "bound" ? "record era differs from the caller's live era" : "no session intel on the record"; return base; }
    if (mode === "bound" && (expectedEra === null || intel.era === null || intel.era !== expectedEra)) { refused = "record era differs from the caller's live era"; return base; }
    if (base.endedAt !== null) { refused = "caller session has ended"; return base; }
    // The stored sample is rewritten to its suppressed form in the same
    // write: the stamp records the sample's own token count, so the step
    // rule holds by construction, and every reader (banner, guide directive,
    // status projection) drops to advisory at once instead of repeating
    // IMPERATIVE until the next Stop sample lands. Field finding 2026-09-09:
    // agents that had just written a handover kept seeing the imperative
    // banner and stopped.
    const last = intel.lastSample;
    // Applied to the record as it is HERE, so the answer belongs to the sample
    // actually being stamped. The identity clause is not redundant with the
    // status: an expired pending event of this era takes the ASSUMED reset,
    // which reports "complete" while nulling the sample, and reporting the
    // pre-reset reading would describe a compaction that has already happened.
    // A rejected sample leaves the observation null, which is the pre-existing
    // continuation line, never silence.
    if (observe && last) {
      const rec = reconcileIntel(intel, null, peekPending(root, sessionId, now), observe.cfg, now);
      if (rec.status === "complete" && rec.intel.lastSample === last) observe.out.state = last.state;
    }
    const lastSample = last && last.state === "imperative" && last.ceiling !== null && (tokensAtHandover === null || tokensAtHandover === last.contextTokens)
      ? { ...last, state: "advisory" as const, suppressedBy: "handover" as const }
      : last;
    return {
      ...base,
      sessionIntel: {
        ...intel,
        lastSample,
        handoverWrittenAt: nowIso,
        tokensAtHandover: tokensAtHandover ?? intel.lastSample?.contextTokens ?? null,
        handoverBoundaryAt: intel.lastBoundaryAt,
        // ISS-1197: the stamp starts both re-arm latches from zero.
        promptsSinceHandover: 0,
        lastImperativeAt: null,
        // ISS-1263: lastImperativeEmittedAt is deliberately untouched: the
        // rate limit is independent of the stamp.
        handoverStampBinding: mode,
      },
    };
  }, () => new Date(now));
  return refused !== null && outcome.status === "written" ? { status: "refused", reason: refused } : outcome;
}

// ---------------------------------------------------------------------------
// Derived handover stamp (ISS-1316)
// ---------------------------------------------------------------------------

/** What the prompt hook saw on the record when it went looking for a handover file. */
export interface DerivedStampSeen extends ImperativeSeen {
  readonly lastImperativeEmittedAt: string;
}

/**
 * The newest regular `.md` in `.story/handovers/` written after `afterMs` and
 * no later than `nowMs`, or null. Handover files carry no session id, so the
 * only attribution is time: written after this session was shown the
 * imperative. A peer's handover in that window counts too; its cost is one
 * re-arm cycle of quiet, where the missing stamp cost a drip for the session.
 */
export function newestHandoverAfter(root: string, afterMs: number, nowMs: number): { readonly file: string; readonly mtimeMs: number } | null {
  const dir = join(root, ".story", "handovers");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs <= afterMs || st.mtimeMs > nowMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: name, mtimeMs: st.mtimeMs };
  }
  return best;
}

/**
 * ISS-1316: stamps the caller's record from a handover file on disk, for a
 * handover a stale MCP server wrote but could not stamp. Written under the
 * lock only when the record is still exactly what the hook saw: same
 * revision, boundary and (absent) stamp, the same last delivery of the
 * imperative, not ended, and no pending compaction. The stamp is the file's
 * mtime and the sample's token count, and the stored imperative drops to
 * advisory in the same write, as `stampHandover` does. True only when the
 * write landed.
 */
export function stampDerivedHandover(root: string, sessionId: string, seen: DerivedStampSeen, writtenAtMs: number, now: number): boolean {
  let granted = false;
  const outcome = applyPresenceEnrichment(root, sessionId, TRY_LOCK_BUDGET_MS, "session-intel", (base) => {
    const intel = base.sessionIntel;
    if (!intel || base.endedAt !== null) return ABORT_ENRICHMENT;
    if (intel.revision !== seen.revision || intel.lastBoundaryAt !== seen.lastBoundaryAt) return ABORT_ENRICHMENT;
    if (intel.handoverWrittenAt !== seen.handoverWrittenAt) return ABORT_ENRICHMENT;
    if (intel.lastImperativeEmittedAt !== seen.lastImperativeEmittedAt) return ABORT_ENRICHMENT;
    const pending = peekPending(root, sessionId, now);
    if (!pending.complete || pending.files.length > 0) return ABORT_ENRICHMENT;
    const last = intel.lastSample;
    const tokensAtHandover = last?.contextTokens ?? null;
    const lastSample = last && last.state === "imperative" && last.ceiling !== null
      ? { ...last, state: "advisory" as const, suppressedBy: "handover" as const }
      : last;
    granted = true;
    return {
      ...base,
      sessionIntel: {
        ...intel,
        lastSample,
        handoverWrittenAt: new Date(writtenAtMs).toISOString(),
        tokensAtHandover,
        handoverBoundaryAt: intel.lastBoundaryAt,
        promptsSinceHandover: 0,
        lastImperativeAt: null,
        handoverStampBinding: "derived" as const,
      },
    };
  }, () => new Date(now));
  return granted && outcome.status === "written";
}

// ---------------------------------------------------------------------------
// Imperative emission claim (ISS-1263)
// ---------------------------------------------------------------------------

/** The identity of the record a delivering surface acquired its imperative sample from. */
export interface ImperativeSeen {
  readonly revision: number;
  readonly lastBoundaryAt: string | null;
  readonly handoverWrittenAt: string | null;
}

/**
 * ISS-1263: the one right to put the imperative line in front of the model,
 * taken by every delivering surface immediately before it attaches the text.
 * Sampling never claims. True means deliver; false means degrade (or omit)
 * for this delivery, and the next delivery samples again.
 *
 * Refused, with nothing written, when the record is gone, has no subtree or
 * has ended; when the sample is obsolete (a revision bump or a boundary
 * reset since acquisition, so the new epoch's allowance is not spent on it);
 * when a handover was stamped since acquisition (the imperative was just
 * answered); when a pending compaction exists or cannot be ruled out; and
 * when the line was already delivered inside the interval. A busy lock or a
 * failed write is also false: the line fails toward quiet for one delivery.
 */
export function claimImperativeEmission(root: string, sessionId: string, seen: ImperativeSeen, now: number, intervalMs: number): boolean {
  let granted = false;
  const outcome = applyPresenceEnrichment(root, sessionId, TRY_LOCK_BUDGET_MS, "session-intel", (base, nowIso) => {
    const intel = base.sessionIntel;
    if (!intel || base.endedAt !== null) return ABORT_ENRICHMENT;
    if (intel.revision !== seen.revision || intel.lastBoundaryAt !== seen.lastBoundaryAt) return ABORT_ENRICHMENT;
    if (intel.handoverWrittenAt !== seen.handoverWrittenAt) return ABORT_ENRICHMENT;
    const pending = peekPending(root, sessionId, now);
    if (!pending.complete || pending.files.length > 0) return ABORT_ENRICHMENT;
    if (intel.lastImperativeEmittedAt !== null) {
      const elapsed = now - Date.parse(intel.lastImperativeEmittedAt);
      if (!Number.isFinite(elapsed) || elapsed < intervalMs) return ABORT_ENRICHMENT;
    }
    granted = true;
    return { ...base, sessionIntel: { ...intel, lastImperativeEmittedAt: nowIso } };
  }, () => new Date(now));
  return granted && outcome.status === "written";
}

// ---------------------------------------------------------------------------
// Usage-cost advisory stamp (T-501)
// ---------------------------------------------------------------------------

export interface UsageAdvisoryConsumeResult {
  readonly stamped: boolean;
  readonly reason: string;
}

/**
 * Consumes the once-per-session right to show the usage-cost advisory.
 *
 * Every precondition is re-checked INSIDE the lock callback against the
 * record as it is there -- same era as the caller's binding, the revision the
 * caller saw, the same `lastSample` by identity, and no stamp yet -- because
 * a check made before the lock cannot keep two callers from both deciding
 * they may show it. A failed precondition aborts (`ABORT_ENRICHMENT`): no
 * serialization, no write, and a record that does not exist is not created.
 *
 * `stamped: false` means NO advisory may be shown; a later priming call
 * retries. The stamp is cleared with the capture transfer on a new era, so
 * the advisory returns once per process era.
 */
export function consumeUsageAdvisory(
  root: string,
  binding: { readonly sessionId: string; readonly era: string | null },
  sample: SessionIntelSample,
  revisionSeen: number,
  now: number = Date.now(),
): UsageAdvisoryConsumeResult {
  let reason = "not attempted";
  const outcome = applyPresenceEnrichment(root, binding.sessionId, TRY_LOCK_BUDGET_MS, "session-intel", (base, nowIso) => {
    const intel = base.sessionIntel;
    if (!intel) { reason = "no session intel on the record"; return ABORT_ENRICHMENT; }
    if (base.endedAt !== null) { reason = "session has ended"; return ABORT_ENRICHMENT; }
    if (binding.era === null || intel.era === null || intel.era !== binding.era) { reason = "era changed since the sample"; return ABORT_ENRICHMENT; }
    if (intel.revision !== revisionSeen) { reason = "stale revision"; return ABORT_ENRICHMENT; }
    const last = intel.lastSample;
    if (!last || last.sampledAt !== sample.sampledAt || last.observation.consumedOffset !== sample.observation.consumedOffset) {
      reason = "sample replaced since it was read";
      return ABORT_ENRICHMENT;
    }
    if (intel.usageAdvisoryShownAt !== null) { reason = "already shown"; return ABORT_ENRICHMENT; }
    reason = "stamped";
    return { ...base, sessionIntel: { ...intel, usageAdvisoryShownAt: nowIso } };
  }, () => new Date(now));
  if (reason !== "stamped") return { stamped: false, reason };
  return outcome.status === "written"
    ? { stamped: true, reason: "stamped" }
    : { stamped: false, reason: `presence write ${outcome.status}` };
}

/** Whether a boundary timestamp lies inside an era entry's proven interval. */
export function boundaryInsideEra(entry: EraEntry | null, ts: string, now: number): boolean {
  if (!entry) return false;
  const t = tsOf(ts);
  const start = tsOf(entry.capturedAt);
  const end = entry.endedAt ? tsOf(entry.endedAt) : now;
  return Number.isFinite(t) && t >= start && t <= end;
}

export const UNOBSERVED: Epoch = { kind: "unobserved" };
