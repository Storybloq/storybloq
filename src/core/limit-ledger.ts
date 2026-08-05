/**
 * T-424: Global usage-limit ledger -- the waker's cross-project work queue.
 *
 * Lives at ~/.claude/storybloq/limit-ledger.json. One record per Claude Code
 * session that hit a usage limit. Per-project autonomous session state stays
 * authoritative for resume correctness (and for wake permission posture); the
 * ledger only schedules and audits wake work.
 *
 * Concurrency contract:
 *   - EVERY read-modify-write holds the single ledger link-lock across
 *     read -> mutate -> tmp+rename, with a fencing re-check AFTER the temp
 *     file is fully written and immediately before the rename (see
 *     limit-lock.ts) -- a stalled ex-holder can never rename stale contents
 *     over a successor's commit.
 *   - Lock ordering is one-way: the ledger lock is never held across session
 *     locks, process spawns, git work, or notifications. The REVERSE nesting
 *     (a ledger helper called while a session lock or wake-claim lock is held)
 *     is allowed and used; since ledger helpers never take those locks
 *     themselves, no cycle exists. Callers claim under the lock, release, do
 *     the slow work, then commit under a generation/attempt CAS.
 *   - Dispatch/verify writers re-read under the lock and drop their write when
 *     `generation` (or the active attempt id) moved.
 *
 * Ledger-first intent protocol (autonomous stops): the StopFailure handler
 * writes a non-dispatchable `preparing` record FIRST, then prepares session
 * state under the session lock, then CAS-activates to `stopped`. A crash at
 * any point leaves a globally discoverable intent for reconciliation.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  captureProcessSignatureSync,
  inspectProcessIdentitySync,
  verifyLockOwnership,
  withLimitLock,
  type LimitLockHandle,
  type LimitLockOptions,
} from "./limit-lock.js";
import { readBoundedFile } from "./limit-config.js";

export const LIMIT_LEDGER_SCHEMA_VERSION = 1;

/** Same stop re-reported within this window (and not resuming) merges instead of minting a new generation. */
export const DEDUPE_WINDOW_MS = 60_000;
/** An `interactive` claim that never leaves COMPACT reverts to `stopped` after this. */
export const INTERACTIVE_DEADLINE_MS = 30 * 60_000;
/** Terminal records pruned after this. */
export const PRUNE_TERMINAL_AFTER_MS = 7 * 86_400_000;
/** `manual` (stood-down) records pruned after this. */
export const PRUNE_MANUAL_AFTER_MS = 30 * 86_400_000;
/** A `preparing` intent whose owner is gone and heartbeat older than this is reconciled. */
export const INTENT_GRACE_MS = 120_000;
/**
 * LEGACY no-claimant fallback window: the ONLY case in which elapsed time is
 * allowed to presume a null-childPid claim abandoned. It applies solely to
 * legacy attempts that recorded NO claimant identity (claimantPid == null); a
 * recorded claimant is abandoned only on a positively-confirmed dead identity,
 * NEVER on age, regardless of this threshold (see claimAbandoned). Inside this
 * window (for those legacy attempts) a child may still materialize, so a
 * null-childPid attempt counts as a possibly-live child (supervision,
 * concurrency, cancel) and its evidence must never be dropped merely because
 * `terminateConfirmed(null)` trivially reports "dead". Defined here (not in
 * waker) so the hook-path CLI cancels can share it without pulling the waker
 * module onto the fast path.
 */
export const CLAIM_SPAWN_STALE_MS = 120_000;
/**
 * A SPAWNED `resuming` attempt (concrete childPid) whose child is CONFIRMED
 * absent and that has been silent longer than this is reclaimed for re-dispatch.
 * Bare claims (childPid == null) are NOT governed by this window -- they are
 * governed exclusively by claimAbandoned (recorded claimant: confirmed-dead
 * only; legacy no-claimant: CLAIM_SPAWN_STALE_MS).
 */
export const STALE_ATTEMPT_MS = 30 * 60_000;
/** Deferral backoff ladder (waker re-checks): 5 -> 10 -> 20 -> 30min capped. */
export const DEFER_BACKOFF_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000] as const;
/**
 * ISS-944: cap on consecutive PRE-SPAWN defers (the four dispatchClaimed
 * sites -- claude-missing, telemetry-unreadable, alive-fresh, spawn-failure
 * -- all of which run before recordAttemptSpawn for the CURRENT claimed
 * attempt; the record's wakeAttempts can already be positive from an earlier
 * attempt in the same episode). Governs `preSpawnDeferCount`, a field
 * structurally distinct from `deferCount` (which drives the backoff ladder
 * above and is never touched by this cap). Fixed constant, mirroring
 * `maxAttempts`'s default of 5 -- not a config field: a knob nobody has asked
 * to tune is public surface, a migration, and a support burden bought with no
 * evidence anyone wants it.
 */
export const MAX_DEFER_COUNT = 5;

export type LimitRecordStatus =
  | "preparing"
  | "stopped"
  | "resuming"
  | "interactive"
  | "manual"
  | "resumed"
  | "notified"
  | "deferred"
  | "failed"
  | "cancelling"
  | "cancelled";

export type LimitReasonCode =
  | "finalize_stop"
  | "bypass_not_opted_in"
  | "blocked_client"
  | "attempts_exhausted"
  | "user_cancel"
  | "project_gone"
  | "resume_blocked"
  // T-450 step 7b.4: the owner heartbeat could not be read at all, so liveness
  // is unverifiable. Distinct from `blocked_client`, which asserts a live
  // terminal -- an assertion this code cannot make from evidence it failed to
  // read.
  | "telemetry_unreadable"
  | "cancellation_blocked"
  // ISS-944: a pre-spawn site (claude-missing / telemetry-unreadable /
  // alive-fresh / spawn-failure) deferred MAX_DEFER_COUNT consecutive times
  // SINCE THE LAST REAL SPAWN (recordAttemptSpawn resets preSpawnDeferCount,
  // so wakeAttempts can be positive here if an earlier spawn happened before
  // this run of pre-spawn defers began). Distinct from `attempts_exhausted`,
  // which is governed by the separate `maxAttempts` config and counts real
  // spawns, never pre-spawn deferrals.
  | "defer_exhausted";

export interface LimitStatusMeta {
  /** Due-scan may claim this record for a wake attempt. */
  dispatchable: boolean;
  /** Episode is over; record prunes after PRUNE_TERMINAL_AFTER_MS. */
  terminal: boolean;
  /** `limit-status --requeue` may return this record to `stopped`. */
  requeueable: boolean;
}

/**
 * Status/reason transition table -- drives prune, requeue eligibility,
 * reconciliation, and UI text. Single source of truth for status semantics.
 */
export const LIMIT_STATUS_META: Record<LimitRecordStatus, LimitStatusMeta> = {
  preparing: { dispatchable: false, terminal: false, requeueable: false },
  stopped: { dispatchable: true, terminal: false, requeueable: false },
  deferred: { dispatchable: true, terminal: false, requeueable: false },
  resuming: { dispatchable: false, terminal: false, requeueable: false },
  interactive: { dispatchable: false, terminal: false, requeueable: false },
  manual: { dispatchable: false, terminal: false, requeueable: true },
  cancelling: { dispatchable: false, terminal: false, requeueable: false },
  cancelled: { dispatchable: false, terminal: true, requeueable: false },
  resumed: { dispatchable: false, terminal: true, requeueable: false },
  notified: { dispatchable: false, terminal: true, requeueable: false },
  failed: { dispatchable: false, terminal: true, requeueable: true },
};

/** A new StopFailure after one of these statuses is a NEW stop episode -- wakeAttempts resets. */
const EPISODE_RESET_STATUSES: ReadonlySet<LimitRecordStatus> = new Set(["resumed", "notified", "failed", "cancelled"]);

const AttemptSchema = z
  .object({
    id: z.string(),
    token: z.string(),
    generation: z.number().int(),
    childPid: z.number().int().nullable().default(null),
    spawnedAt: z.number().nullable().default(null),
    transcriptOffset: z.number().nullable().default(null),
    stateRevision: z.union([z.number(), z.string()]).nullable().default(null),
    lastProgressAt: z.number().nullable().default(null),
    // Identity of the process that made the claim (the waker), captured at
    // claim time. Used to decide when a still-null childPid attempt may be
    // cleared: only when the claimant is confirmed DEAD (a suspended/slow
    // claimant is still alive and may resume and spawn). Additive/nullable for
    // back-compat -- a legacy attempt with no identity falls back to age.
    claimantPid: z.number().int().nullable().default(null),
    claimantSignature: z.string().nullable().default(null),
  })
  .passthrough();

const PreparingOwnerSchema = z
  .object({
    pid: z.number().int(),
    token: z.string(),
    heartbeatAt: z.number(),
    signature: z.string().nullable().default(null),
  })
  .passthrough();

const LimitRecordSchema = z
  .object({
    key: z.string(),
    client: z.string().default("claude"),
    clientTaskId: z.string(),
    storybloqSessionId: z.string().nullable().default(null),
    projectRoot: z.string(),
    cwd: z.string().default(""),
    sessionType: z.enum(["autonomous", "plain"]),
    status: z.enum([
      "preparing", "stopped", "resuming", "interactive", "manual",
      "resumed", "notified", "deferred", "failed", "cancelling", "cancelled",
    ]),
    reasonCode: z.string().nullable().default(null),
    limitEventId: z.string(),
    generation: z.number().int().min(1),
    wakeAttempts: z.number().int().min(0).default(0),
    deferCount: z.number().int().min(0).default(0),
    // ISS-944: cap counter for the four PRE-SPAWN defer sites only, structurally
    // distinct from deferCount (which drives the backoff ladder and is never
    // touched by the cap). Additive/nullable-by-default for back-compat -- every
    // record written before this issue lacks the field and defaults to 0 here.
    preSpawnDeferCount: z.number().int().min(0).default(0),
    nextAttemptAt: z.number().default(0),
    limitType: z.enum(["session", "weekly", "unknown"]).default("unknown"),
    transcriptPath: z.string().nullable().default(null),
    detectedAt: z.number(),
    resetAt: z.number(),
    resetSource: z.enum(["absolute", "relative", "fallback"]),
    rawBanner: z.string().nullable().default(null),
    parserVersion: z.number().int().default(1),
    lastAttemptAt: z.number().nullable().default(null),
    lastError: z.string().nullable().default(null),
    attempt: AttemptSchema.nullable().default(null),
    mode: z.enum(["headless", "notify"]),
    gitHead: z.string().nullable().default(null),
    updatedAt: z.number().default(0),
    interactiveDeadlineAt: z.number().nullable().default(null),
    preparingOwner: PreparingOwnerSchema.nullable().default(null),
    /**
     * Full snapshot of the record this `preparing` intent replaced, so an
     * abort restores EVERY prior field (limitEventId, resetAt, mode, attempt,
     * ...) -- restoring only status+generation would leave a hybrid record
     * whose generation describes the old episode but whose fields describe
     * the aborted one. Validated with LimitRecordSchema at restore time.
     */
    prevRecord: z.unknown().nullable().default(null),
  })
  .passthrough();

export type LimitAttempt = z.infer<typeof AttemptSchema>;
export type LimitRecord = z.infer<typeof LimitRecordSchema>;

export interface LimitLedger {
  schemaVersion: number;
  records: Record<string, LimitRecord>;
}

// ---------------------------------------------------------------------------
// Paths + global kill switch
// ---------------------------------------------------------------------------

/** Established global state dir (see core/update-check.ts). Env override is for tests + E2E sims. */
export function storybloqGlobalDir(): string {
  return process.env.STORYBLOQ_GLOBAL_DIR || join(homedir(), ".claude", "storybloq");
}

export function limitLedgerPath(): string {
  return join(storybloqGlobalDir(), "limit-ledger.json");
}

export function limitLedgerLockPath(): string {
  return join(storybloqGlobalDir(), "limit-ledger.lock");
}

export function wakerLockPath(): string {
  return join(storybloqGlobalDir(), "waker.lock");
}

/** Global kill switch: ~/.claude/storybloq/config.json { "limitResume": { "enabled": false } }. Absence = enabled. */
export function isLimitResumeGloballyDisabled(): boolean {
  try {
    // Bounded non-blocking read: this runs on hook paths, and the path is
    // user-writable -- a FIFO or huge file must not hang the hook.
    const raw = readBoundedFile(join(storybloqGlobalDir(), "config.json"));
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as { limitResume?: { enabled?: unknown } };
    return parsed?.limitResume?.enabled === false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read / write engine
// ---------------------------------------------------------------------------

function emptyLedger(): LimitLedger {
  return { schemaVersion: LIMIT_LEDGER_SCHEMA_VERSION, records: {} };
}

/**
 * Read + validate. When `quarantineCorrupt` is set (ONLY under the ledger
 * lock), corrupt files are quarantined (renamed aside) and replaced with an
 * empty ledger -- the hook path must never crash on a bad file. Lockless
 * readers are strictly non-mutating: they get an empty snapshot on corruption
 * and leave the file for the next locked writer to quarantine (a lockless
 * rename could race a writer's commit and violate the single-writer contract).
 * Individual invalid records are preserved verbatim (carried through writes)
 * but excluded from all logic.
 */
/** Ledger reads are bounded: hook paths probe this file locklessly, so a special-file or runaway replacement must not hang or balloon them. */
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;

function readLedgerRaw(opts: { quarantineCorrupt?: boolean } = {}): { ledger: LimitLedger; carried: Record<string, unknown> } {
  const path = limitLedgerPath();
  const raw = readBoundedFile(path, LEDGER_MAX_BYTES);
  if (raw === null) {
    // Absent, special file, or oversized. Oversized/special is corruption for
    // a ledger this code exclusively writes -- quarantine it under the lock so
    // writes can start fresh (an absent file quarantines to nothing).
    if (opts.quarantineCorrupt && fs.existsSync(path)) quarantine(path);
    return { ledger: emptyLedger(), carried: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (opts.quarantineCorrupt) quarantine(path);
    return { ledger: emptyLedger(), carried: {} };
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as LimitLedger).records !== "object" || (parsed as LimitLedger).records === null) {
    if (opts.quarantineCorrupt) quarantine(path);
    return { ledger: emptyLedger(), carried: {} };
  }
  const ledger = emptyLedger();
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((parsed as { records: Record<string, unknown> }).records)) {
    const rec = LimitRecordSchema.safeParse(value);
    if (rec.success) ledger.records[key] = rec.data;
    else carried[key] = value;
  }
  return { ledger, carried };
}

function quarantine(path: string): void {
  try {
    fs.renameSync(path, `${path}.corrupt.${Date.now()}`);
  } catch {
    // last resort: leave it; writes will replace it
  }
}

/**
 * Serialize + temp-write, THEN fence, THEN rename. The fence callback runs
 * after all temp-file I/O so a lease lost during that I/O is caught before
 * the commit; on fence loss the temp file is deleted and false returned (the
 * caller discards its mutation and retries from a fresh read).
 */
function writeLedgerAtomic(ledger: LimitLedger, carried: Record<string, unknown>, verifyBeforeRename: () => boolean): boolean {
  const path = limitLedgerPath();
  const records: Record<string, unknown> = { ...carried };
  for (const [key, rec] of Object.entries(ledger.records)) records[key] = rec;
  const body = JSON.stringify({ schemaVersion: ledger.schemaVersion, records }, null, 2);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(2).toString("hex")}`;
  fs.mkdirSync(storybloqGlobalDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  if (!verifyBeforeRename()) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    return false;
  }
  try {
    fs.renameSync(tmp, path);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  return true;
}

/** Sentinel: return from a mutator to skip the write-back. */
export const SKIP_WRITE: unique symbol = Symbol("skip-write");

const FENCE_RETRIES = 3;

/**
 * The single RMW engine. Holds the ledger lock across read -> mutate -> rename,
 * fencing after the temp write and immediately before the rename; on fence
 * loss the mutation is discarded and the whole RMW retried. `lockOpts` lets
 * latency-sensitive callers (the Stop hook) bound the lock wait.
 */
export function mutateLimitLedger<T>(
  fn: (ledger: LimitLedger) => T | typeof SKIP_WRITE,
  lockOpts?: LimitLockOptions,
): T | typeof SKIP_WRITE {
  for (let i = 0; i < FENCE_RETRIES; i++) {
    const result = withLimitLock<{ out: T | typeof SKIP_WRITE; fenced: boolean }>(
      limitLedgerLockPath(),
      (handle: LimitLockHandle) => {
        const { ledger, carried } = readLedgerRaw({ quarantineCorrupt: true });
        const out = fn(ledger);
        if (out === SKIP_WRITE) return { out, fenced: true };
        const fenced = writeLedgerAtomic(ledger, carried, () => verifyLockOwnership(handle));
        return { out, fenced };
      },
      lockOpts,
    );
    if (result.fenced) return result.out;
  }
  throw new Error("limit-ledger: lost lock ownership repeatedly; giving up");
}

/** Read-only snapshot (takes the lock briefly for a consistent read). */
export function readLimitLedger(): LimitLedger {
  try {
    return withLimitLock(limitLedgerLockPath(), () => readLedgerRaw({ quarantineCorrupt: true }).ledger);
  } catch {
    // Lock unavailable: fall back to a lockless (non-mutating) read.
    return readLedgerRaw().ledger;
  }
}

/**
 * Resolve the CURRENT-episode non-terminal record for a session that lost BOTH
 * owner identifiers (so its ledger key cannot be derived), keyed by
 * storybloqSessionId + limitEventId. Reads UNDER the ledger lock -- so a corrupt
 * file is quarantined and an empty result is AUTHORITATIVE -- and THROWS if the
 * lock cannot be acquired. Callers must fail closed on a throw (never clear a
 * session or emit a resume instruction on a read we could not trust): unlike
 * readLimitLedger this deliberately does NOT fall back to a lockless read, whose
 * empty result on a corrupt/contended ledger cannot be distinguished from a
 * genuine no-record state. Returns null only when there is authoritatively no
 * such record; throws on an ambiguous multi-match (limitEventId uniqueness makes
 * that a corruption signal, not a routine outcome).
 */
export function resolveOwnerlessRecord(storybloqSessionId: string, limitEventId: string | null): LimitRecord | null {
  if (!limitEventId) return null;
  const matches = withLimitLock(limitLedgerLockPath(), () =>
    Object.values(readLedgerRaw({ quarantineCorrupt: true }).ledger.records).filter(
      (r) =>
        r.storybloqSessionId === storybloqSessionId &&
        r.limitEventId === limitEventId &&
        !LIMIT_STATUS_META[r.status as LimitRecordStatus]?.terminal,
    ),
  );
  if (matches.length > 1) {
    throw new Error(
      `limit-ledger: ${matches.length} non-terminal records share session ${storybloqSessionId} + event ${limitEventId}`,
    );
  }
  return matches[0] ?? null;
}

/**
 * Does this record still need a live waker? Non-terminal records EXCEPT inert
 * `manual` stand-downs (no attempt evidence): those wait for an explicit user
 * `--requeue`/resume, and keeping a "transient" waker polling for a stood-down
 * record for up to its 30-day retention would make it a de-facto daemon.
 * A blocked cancellation (manual + attempt) IS actionable: finish-cancel
 * retries its child termination.
 */
export function isWakerActionable(rec: LimitRecord): boolean {
  if (LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.terminal) return false;
  // Blocked cancellations stay actionable (finish-cancel retries them);
  // every other stood-down manual record waits for the user.
  if (rec.status === "manual" && !rec.attempt && rec.reasonCode !== "cancellation_blocked") return false;
  return true;
}

/** Lockless existence probe for cheap respawn checks: any waker-actionable record? */
export function hasPendingLimitRecords(): boolean {
  const { ledger } = readLedgerRaw();
  return Object.values(ledger.records).some(isWakerActionable);
}

/**
 * Lockless single-record peek for latency-bounded hook paths: never waits on
 * the ledger lock. Callers must treat the result as advisory and route any
 * mutation through a CAS'd mutator (which re-reads under the lock).
 */
export function peekLimitRecord(key: string): LimitRecord | undefined {
  return readLedgerRaw().ledger.records[key];
}

// ---------------------------------------------------------------------------
// Detection-side mutators (StopFailure handler)
// ---------------------------------------------------------------------------

export interface LimitStopInput {
  client?: "claude";
  clientTaskId: string;
  storybloqSessionId: string | null;
  projectRoot: string;
  cwd: string;
  sessionType: "autonomous" | "plain";
  limitType: "session" | "weekly" | "unknown";
  transcriptPath: string | null;
  detectedAt: number;
  resetAt: number;
  resetSource: "absolute" | "relative" | "fallback";
  rawBanner: string | null;
  parserVersion?: number;
  mode: "headless" | "notify";
  reasonCode?: LimitReasonCode | null;
  gitHead: string | null;
  /**
   * Reuse an existing limitEventId instead of minting one. Only for repair
   * paths refiling a record for a session ALREADY parked under that event id
   * (reconciliation matches records to sessions by limitEventId).
   */
  limitEventId?: string;
}

export function limitRecordKey(clientTaskId: string, client = "claude"): string {
  return `${client}:${clientTaskId}`;
}

export function newLimitEventId(): string {
  return `le-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export interface UpsertResult {
  key: string;
  generation: number;
  limitEventId: string;
  deduped: boolean;
  /** Set only by writePreparingIntent; needed for activate/abort CAS. */
  ownerToken: string | null;
}

function upsertStop(
  ledger: LimitLedger,
  input: LimitStopInput,
  phase: "preparing" | "stopped",
  opts: { bypassDedupe?: boolean } = {},
): UpsertResult {
  const key = limitRecordKey(input.clientTaskId, input.client ?? "claude");
  const existing = ledger.records[key];
  const now = input.detectedAt;

  if (
    !opts.bypassDedupe &&
    existing &&
    now - existing.detectedAt < DEDUPE_WINDOW_MS &&
    (existing.status === "preparing" || existing.status === "stopped" || existing.status === "deferred")
  ) {
    // Duplicate report of the SAME stop: merge, keep generation. Upgrade the
    // reset time when the duplicate parsed real evidence over a fallback.
    if (existing.resetSource === "fallback" && input.resetSource !== "fallback" && existing.status !== "preparing") {
      existing.resetAt = input.resetAt;
      existing.resetSource = input.resetSource;
      existing.nextAttemptAt = input.resetAt;
      existing.rawBanner = input.rawBanner;
      existing.limitType = input.limitType;
    }
    existing.updatedAt = now;
    // ownerToken stays null on dedupe: only the ORIGINAL intent owner may
    // activate/abort; a duplicate handler runs its (idempotent) session prep
    // and leaves the ledger transitions to the first writer or reconciliation.
    return { key, generation: existing.generation, limitEventId: existing.limitEventId, deduped: true, ownerToken: null };
  }

  const generation = existing ? existing.generation + 1 : 1;
  const wakeAttempts = existing && !EPISODE_RESET_STATUSES.has(existing.status as LimitRecordStatus) ? existing.wakeAttempts : 0;
  const limitEventId = input.limitEventId ?? newLimitEventId();
  const ownerToken = phase === "preparing" ? randomBytes(16).toString("hex") : null;

  ledger.records[key] = {
    key,
    client: input.client ?? "claude",
    clientTaskId: input.clientTaskId,
    storybloqSessionId: input.storybloqSessionId,
    projectRoot: input.projectRoot,
    cwd: input.cwd,
    sessionType: input.sessionType,
    status: phase,
    reasonCode: input.reasonCode ?? null,
    limitEventId,
    generation,
    wakeAttempts,
    deferCount: 0,
    // ISS-944: a genuine re-limit starts a fresh episode -- the pre-spawn
    // stall budget resets exactly like deferCount does, for the same reason
    // (a new episode gets a fresh ladder/budget, not a carried-over one).
    preSpawnDeferCount: 0,
    nextAttemptAt: input.resetAt,
    limitType: input.limitType,
    transcriptPath: input.transcriptPath,
    detectedAt: now,
    resetAt: input.resetAt,
    resetSource: input.resetSource,
    rawBanner: input.rawBanner,
    parserVersion: input.parserVersion ?? 1,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
    lastError: null,
    // Keep the superseded attempt: it carries the old child pid the waker must
    // terminate. Its generation no longer matches, so CAS drops stale writes.
    attempt: existing?.attempt ?? null,
    mode: input.mode,
    gitHead: input.gitHead,
    updatedAt: now,
    interactiveDeadlineAt: null,
    preparingOwner:
      phase === "preparing"
        ? { pid: process.pid, token: ownerToken!, heartbeatAt: now, signature: captureProcessSignatureSync(process.pid) }
        : null,
    prevRecord:
      phase === "preparing" && existing
        ? (JSON.parse(JSON.stringify({ ...existing, prevRecord: null })) as unknown)
        : null,
  };
  return { key, generation, limitEventId, deduped: false, ownerToken };
}

/**
 * Phase 1 of the autonomous write protocol: a non-dispatchable intent, written
 * BEFORE session state is touched, so a crash leaves a discoverable pointer.
 */
export function writePreparingIntent(input: LimitStopInput): UpsertResult {
  const r = mutateLimitLedger((ledger) => upsertStop(ledger, input, "preparing"));
  return r as UpsertResult;
}

/** Re-verify our intent still stands (generation unchanged) before writing session state. */
export function verifyPreparingIntent(key: string, ownerToken: string, generation: number): boolean {
  const ledger = readLimitLedger();
  const rec = ledger.records[key];
  return !!rec && rec.status === "preparing" && rec.generation === generation && rec.preparingOwner?.token === ownerToken;
}

/** Phase 2: CAS-activate the intent once session state is prepared. */
export function activateIntent(key: string, ownerToken: string, generation: number): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.status !== "preparing" || rec.generation !== generation) return SKIP_WRITE;
    if (rec.preparingOwner?.token !== ownerToken) return SKIP_WRITE;
    rec.status = "stopped";
    rec.preparingOwner = null;
    rec.prevRecord = null;
    rec.updatedAt = Date.now();
    return true;
  });
  return r === true;
}

/**
 * Roll back an intent whose session-state prepare failed: restore the FULL
 * previous record or drop ours. Returns whether THIS ownerToken/generation
 * actually owned and aborted the intent -- false means the intent was
 * superseded (a newer generation owns the record) and the caller must perform
 * no further ledger mutation (e.g. no fallback record).
 */
export function abortIntent(key: string, ownerToken: string, generation: number): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.status !== "preparing" || rec.generation !== generation) return SKIP_WRITE;
    if (rec.preparingOwner?.token !== ownerToken) return SKIP_WRITE;
    const prev = LimitRecordSchema.safeParse(rec.prevRecord);
    if (prev.success) {
      ledger.records[key] = { ...prev.data, updatedAt: Date.now() };
    } else {
      delete ledger.records[key];
    }
    return true;
  });
  return r === true;
}

/** Single-phase upsert for stops that need no session-state prep (plain sessions, FINALIZE notify-only). */
export function recordDirectStop(input: LimitStopInput): UpsertResult {
  const r = mutateLimitLedger((ledger) => upsertStop(ledger, input, "stopped"));
  return r as UpsertResult;
}

/**
 * Activation-race repair (caller holds the SESSION lock, so `sessionEvent` --
 * the event the session is committed-parked under -- cannot change under us).
 * Our intent's activation CAS lost to a newer ledger generation, but the ledger
 * must still name a NON-TERMINAL record for `sessionEvent` or the parked session
 * is orphaned (reconciliation, keyed on the event, would mistake a mismatched
 * record for a resumed session). If a non-terminal record already names
 * `sessionEvent` it already points here -> leave it. Otherwise install a fresh
 * `stopped` record for `sessionEvent`, BYPASSING the StopFailure dedupe window:
 * the repair reuses the intent's (older) detectedAt, so plain dedupe would merge
 * onto the newer foreign-event record and silently keep ITS event. Returns
 * whether a record was installed (false = already owned for this event).
 */
export function repairParkedSessionRecord(input: LimitStopInput, sessionEvent: string): boolean {
  const r = mutateLimitLedger((ledger) => {
    const key = limitRecordKey(input.clientTaskId, input.client ?? "claude");
    const existing = ledger.records[key];
    if (
      existing &&
      !LIMIT_STATUS_META[existing.status as LimitRecordStatus]?.terminal &&
      existing.limitEventId === sessionEvent
    ) {
      return SKIP_WRITE; // a non-terminal record already points at the parked session
    }
    upsertStop(ledger, { ...input, limitEventId: sessionEvent }, "stopped", { bypassDedupe: true });
    return true;
  });
  return r === true;
}

// ---------------------------------------------------------------------------
// Waker-side mutators (claim / spawn / settle)
// ---------------------------------------------------------------------------

/**
 * May a still-null-childPid attempt -- a claim that has NOT yet recorded a
 * spawned child -- be cleared, i.e. is it CERTAIN no child will ever
 * materialize? Only when the CLAIMANT process (the waker that made the claim)
 * is confirmed dead. A claimant that is merely slow or SUSPENDED (e.g.
 * descheduled, or paused across laptop sleep) is still "alive" and may resume
 * and spawn; clearing its attempt would strand that child untracked (its
 * recordAttemptSpawn / attachOrphanChildPid CAS fails against the missing
 * attempt, and a crash before self-termination leaves an orphan). Wall-clock
 * age is NOT proof of death, and must NEVER override a recorded claimant: when
 * a claimantPid is present but identity is "unknown" (a platform with no
 * process signature, or a transient signature/proc-inspection failure), the
 * claimant may well be alive/suspended -- abandoning it on elapsed time would
 * reopen exactly the strand-an-untracked-child race this function exists to
 * close. So a RECORDED claimant is abandoned ONLY on a positively-confirmed
 * "dead" result. The wall-clock bound is a last resort reserved for LEGACY
 * attempts that recorded no claimant identity at all (claimantPid == null), so
 * those can never wedge a record forever. (A recorded claimant does not wedge
 * either: a genuinely-dead claimant's pid is almost always free -> ESRCH ->
 * "dead"; only exact-pid reuse by a long-lived unrelated process preserves it,
 * and preserving-over-orphaning is the correct direction there.) A
 * concrete-childPid attempt is never a bare claim -> false.
 */
export function claimAbandoned(attempt: LimitAttempt, now = Date.now()): boolean {
  if (attempt.childPid != null) return false;
  if (attempt.claimantPid != null) {
    // Recorded claimant: identity is authoritative. "unknown" preserves (may be
    // alive); only a confirmed "dead" abandons. Age is NOT consulted here.
    return inspectProcessIdentitySync(attempt.claimantPid, attempt.claimantSignature ?? null) === "dead";
  }
  const claimAge = now - (attempt.lastProgressAt ?? attempt.spawnedAt ?? 0);
  return claimAge >= CLAIM_SPAWN_STALE_MS;
}

export interface AttemptClaim {
  id: string;
  token: string;
  generation: number;
}

/** CAS: dispatchable + generation match + NO lingering attempt -> `resuming` with a fresh attempt. */
export function claimAttempt(key: string, claim: AttemptClaim, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec) return SKIP_WRITE;
    if (!LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.dispatchable) return SKIP_WRITE;
    if (rec.generation !== claim.generation) return SKIP_WRITE;
    // A record still carrying attempt evidence names a child whose death is
    // not yet confirmed (superseded re-limit, interactive-deadline revert).
    // Claiming over it would orphan that child beside a second spawn: refuse
    // until the waker's termination pass confirms exit and clears it.
    if (rec.attempt) return SKIP_WRITE;
    rec.status = "resuming";
    rec.attempt = {
      id: claim.id,
      token: claim.token,
      generation: claim.generation,
      childPid: null,
      spawnedAt: null,
      transcriptOffset: null,
      stateRevision: null,
      lastProgressAt: now,
      // Record WHO is claiming (this waker), so a null-childPid attempt is
      // cleared only after this exact process is confirmed dead, never on age
      // alone (see claimAbandoned).
      claimantPid: process.pid,
      claimantSignature: captureProcessSignatureSync(process.pid),
    };
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/** After a successful spawn: record the child and count the launch (wakeAttempts increments HERE only). */
export function recordAttemptSpawn(
  key: string,
  attemptId: string,
  details: { childPid: number | null; transcriptOffset: number | null; stateRevision: number | string | null },
  now = Date.now(),
): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.status !== "resuming" || rec.attempt?.id !== attemptId) return SKIP_WRITE;
    rec.attempt.childPid = details.childPid;
    rec.attempt.spawnedAt = now;
    rec.attempt.transcriptOffset = details.transcriptOffset;
    rec.attempt.stateRevision = details.stateRevision;
    rec.attempt.lastProgressAt = now;
    rec.wakeAttempts += 1;
    // ISS-944: a REAL spawn resets the pre-spawn stall budget -- a prior
    // near-miss must not carry across a spawn that actually happened. This
    // deliberately does NOT touch deferCount (it drives the backoff ladder
    // and is a separate concern -- see settleAttempt).
    rec.preSpawnDeferCount = 0;
    rec.lastAttemptAt = now;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/**
 * Durably attach a spawned child's real PID to a LINGERING attempt after the
 * strict spawn CAS (recordAttemptSpawn) lost because the record moved between
 * claim and spawn (cancellation, interactive takeover, or a re-limit that
 * changed status away from `resuming`). Unlike recordAttemptSpawn this is
 * status- and generation-agnostic: it only requires the SAME attempt id still
 * present with no PID yet recorded. That makes the child discoverable to the
 * owning flow (superviseAttempt's superseded/dispatchable branches or
 * finishCancel), which confirm-terminates `attempt.childPid` and clears it --
 * and it is the ONLY tracking artifact a PLAIN headless record has (no per-
 * session wake claim exists there). Does NOT touch wakeAttempts (the launch was
 * already counted by the lost claim, or belongs to the superseding episode).
 * Never clobbers a PID already present. Returns true when the PID was attached.
 */
export function attachOrphanChildPid(key: string, attemptId: string, childPid: number, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.attempt?.id !== attemptId) return SKIP_WRITE;
    if (rec.attempt.childPid != null) return SKIP_WRITE;
    rec.attempt.childPid = childPid;
    rec.attempt.spawnedAt = rec.attempt.spawnedAt ?? now;
    rec.attempt.lastProgressAt = now;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

export function touchAttemptProgress(
  key: string,
  attemptId: string,
  now = Date.now(),
  baselines?: { transcriptOffset?: number | null; stateRevision?: number | string | null },
): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.attempt?.id !== attemptId) return SKIP_WRITE;
    // Stale-writer guards: progress is only meaningful for the live attempt of
    // the CURRENT generation while the record is still `resuming` -- a
    // verifier that observed a superseded attempt writes nothing.
    if (rec.status !== "resuming") return SKIP_WRITE;
    if (rec.attempt.generation !== rec.generation) return SKIP_WRITE;
    rec.attempt.lastProgressAt = now;
    // Advance the progress baselines so the NEXT silent interval is measured
    // from the latest observed activity, not from spawn time.
    if (baselines?.transcriptOffset !== undefined) rec.attempt.transcriptOffset = baselines.transcriptOffset;
    if (baselines?.stateRevision !== undefined) rec.attempt.stateRevision = baselines.stateRevision;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/** Clear an attempt whose generation was superseded by a re-limit (its child has been signalled). */
export function clearSupersededAttempt(key: string, attemptId: string, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.attempt?.id !== attemptId) return SKIP_WRITE;
    if (rec.attempt.generation === rec.generation) return SKIP_WRITE;
    rec.attempt = null;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/**
 * Clear a lingering attempt from a DISPATCHABLE record after its child's death
 * was confirmed. Covers same-generation leftovers (e.g. the interactive
 * deadline reverting a record to `stopped` with its attempt intact) that
 * clearSupersededAttempt's generation check deliberately skips. Dispatch is
 * blocked while the attempt remains (claimAttempt/selectDueRecords refuse), so
 * this is the release valve.
 */
export function clearConfirmedDeadAttempt(key: string, attemptId: string, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.attempt?.id !== attemptId) return SKIP_WRITE;
    if (!LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.dispatchable) return SKIP_WRITE;
    rec.attempt = null;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/**
 * Finalize a project-gone failure AFTER the attempt child's death is
 * confirmed. Reconciliation never terminalizes a record that still tracks a
 * possibly-live child (a terminal record stops being supervised and lets the
 * waker exit); it emits a terminate-orphan action and the waker calls this
 * once termination is confirmed.
 */
export function failProjectGoneConfirmed(
  key: string,
  attemptId: string,
  generation: number,
  now = Date.now(),
): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.attempt?.id !== attemptId) return SKIP_WRITE;
    if (LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.terminal) return SKIP_WRITE;
    if (rec.generation !== generation) {
      // A re-limit superseded this episode between the action and this call.
      // The old child is confirmed dead, so clear its superseded attempt, but
      // NEVER fail the newer generation -- it owns the record now.
      rec.attempt = null;
      rec.updatedAt = now;
      return true;
    }
    rec.status = "failed";
    rec.reasonCode = "project_gone";
    rec.attempt = null;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/** Notify-mode records settle here at reset (terminal). Generation-CAS'd. */
export function markNotified(key: string, generation: number, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.generation !== generation) return SKIP_WRITE;
    if (rec.status !== "stopped" && rec.status !== "deferred") return SKIP_WRITE;
    rec.status = "notified";
    rec.attempt = null;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/** Attempt cap reached (or other no-attempt failure): mark failed without an active attempt. */
export function failRecord(key: string, generation: number, reasonCode: LimitReasonCode, lastError: string | null = null, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.generation !== generation) return SKIP_WRITE;
    if (LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.terminal) return SKIP_WRITE;
    if (rec.status === "cancelling") return SKIP_WRITE;
    // Attempt evidence names a child whose death is unconfirmed; a terminal
    // transition would drop supervision of it. Termination must confirm and
    // clear the attempt first.
    if (rec.attempt) return SKIP_WRITE;
    rec.status = "failed";
    rec.reasonCode = reasonCode;
    rec.lastError = lastError;
    rec.attempt = null;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

export interface AttemptOutcome {
  status: "resumed" | "deferred" | "failed" | "manual" | "stopped";
  reasonCode?: LimitReasonCode | null;
  nextAttemptAt?: number;
  lastError?: string | null;
  /**
   * ISS-944: asserted ONLY by dispatchClaimed's pre-spawn `settle` wrapper
   * (the four sites: claude-missing, telemetry-unreadable, alive-fresh,
   * spawn-failure). superviseAttempt's post-spawn `settle` wrapper never sets
   * it. This is what gates the `preSpawnDeferCount` cap EXPLICITLY, at the
   * call site, rather than leaving the cap's blast radius to emerge from
   * counter arithmetic -- a cap-eligible `preSpawnDeferCount` reached by any
   * means at a post-spawn call site (corrupted state, a future code path,
   * manual ledger repair) still cannot trigger `defer_exhausted` from a call
   * that does not assert this flag.
   */
  preSpawnDefer?: boolean;
}

/** Discriminated settle result: the ACTUAL persisted mutation, not the requested outcome (they can differ when the cap converts "deferred" into "failed"/"defer_exhausted"). `null` = the CAS did not land (nothing written). */
export interface SettleResult {
  status: LimitRecordStatus;
  reasonCode: LimitReasonCode | null;
  deferCount: number;
  preSpawnDeferCount: number;
}

/**
 * Settle the active attempt. CAS on attempt id AND generation: a verifier
 * carrying evidence for a superseded generation writes nothing. Also gated to
 * `resuming` -- interactive/cancelling/blocked records own their attempt
 * through their own flows, and a waker losing the wake-claim race must not
 * clobber a fresh `interactive` takeover back to a dispatchable status.
 *
 * ISS-944: a "deferred" outcome asserting `preSpawnDefer: true` converts to a
 * terminal `"failed"`/`"defer_exhausted"` once `preSpawnDeferCount` reaches
 * `MAX_DEFER_COUNT` -- matching `failRecord`'s terminalize shape (status,
 * reasonCode, attempt=null, updatedAt; `nextAttemptAt` and `deferCount` left
 * AS-IS, `preSpawnDeferCount` left at its final value). `lastError` is
 * applied unconditionally after the branch either way, so a cap-firing call
 * never discards a real diagnostic (e.g. spawn-failure's).
 */
export function settleAttempt(key: string, attemptId: string, outcome: AttemptOutcome, now = Date.now()): SettleResult | null {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.status !== "resuming") return SKIP_WRITE;
    if (rec.attempt?.id !== attemptId) return SKIP_WRITE;
    if (rec.attempt.generation !== rec.generation) return SKIP_WRITE;

    const capFires = outcome.status === "deferred" && outcome.preSpawnDefer === true && rec.preSpawnDeferCount >= MAX_DEFER_COUNT;

    if (capFires) {
      rec.status = "failed";
      rec.reasonCode = "defer_exhausted";
      // deferCount, preSpawnDeferCount, and nextAttemptAt deliberately left
      // AS-IS -- the terminal record's own fields show how it got here, and
      // a stale nextAttemptAt is inert (LIMIT_STATUS_META.failed.dispatchable
      // is false).
    } else {
      rec.status = outcome.status;
      rec.reasonCode = outcome.reasonCode ?? null;
      if (outcome.status === "deferred") {
        rec.deferCount += 1;
        rec.nextAttemptAt = outcome.nextAttemptAt ?? now + deferBackoffMs(rec.deferCount);
        if (outcome.preSpawnDefer) rec.preSpawnDeferCount += 1;
      } else if (outcome.nextAttemptAt != null) {
        rec.nextAttemptAt = outcome.nextAttemptAt;
      }
    }
    // Unconditional either way: the cap branch must not bypass this, or a
    // cap-firing call (e.g. spawn-failure's real diagnostic) silently
    // discards lastError at exactly the moment the terminal record needs it.
    if (outcome.lastError !== undefined) rec.lastError = outcome.lastError;
    rec.attempt = null;
    rec.updatedAt = now;
    return {
      status: rec.status as LimitRecordStatus,
      reasonCode: rec.reasonCode as LimitReasonCode | null,
      deferCount: rec.deferCount,
      preSpawnDeferCount: rec.preSpawnDeferCount,
    };
  });
  return r === SKIP_WRITE ? null : r;
}

export function deferBackoffMs(deferCount: number): number {
  const idx = Math.max(0, Math.min(deferCount - 1, DEFER_BACKOFF_MS.length - 1));
  return DEFER_BACKOFF_MS[idx]!;
}

/**
 * Mark resumed on external evidence (manual resume, hook-status seeing turns).
 * Generation-CAS'd: delayed evidence from an earlier episode must never
 * terminalize a newer generation and suppress its pending wake. `lockOpts`
 * lets hook-path callers bound the lock wait.
 */
export function markResumed(key: string, expectedGeneration: number, now = Date.now(), lockOpts?: LimitLockOptions): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.generation !== expectedGeneration) return SKIP_WRITE;
    // Whitelist, not blacklist: un-attributed external Stop evidence may only
    // resolve statuses that track NO live wake child. `resuming` is excluded --
    // it owns an active attempt (a running child), and a delayed pre-limit Stop
    // arriving after the 30s heuristic must not discard that child's tracking;
    // the waker settles resuming records via attempt-scoped evidence
    // (authoritative session-state advancement / structured turn). `preparing`
    // is a ledger-first intent mid-transaction; `cancelling`/`manual` own their
    // attempt through their own flows (a blocked cancel names a live child).
    const eligible: LimitRecordStatus[] = ["stopped", "deferred", "interactive"];
    if (!eligible.includes(rec.status as LimitRecordStatus)) return SKIP_WRITE;
    // A lingering attempt names a wake child whose death is NOT yet confirmed
    // (most acutely: an interactive takeover async-SIGTERM'd our displaced
    // child without waiting for exit, and preserved the attempt as evidence).
    // Terminalizing to `resumed` here clears that evidence and would orphan a
    // possibly-live child beside the resumed session. Stand down: supervision
    // confirms the displaced child's death and clears the attempt, and only
    // then may un-attributed Stop evidence terminalize the record.
    if (rec.attempt != null) return SKIP_WRITE;
    rec.status = "resumed";
    rec.reasonCode = null;
    rec.attempt = null;
    rec.interactiveDeadlineAt = null;
    rec.updatedAt = now;
    return true;
  }, lockOpts);
  return r === true;
}

/**
 * A tokenless (interactive) resume claimed the session. Returns the active
 * attempt (plus the status the record held before the CAS, so callers can
 * detect a superseded in-flight wake even when childPid was not yet recorded).
 * Never converts `manual`/`preparing`/`cancelling` records (their surfaces are
 * gated).
 */
export function markInteractive(key: string, now = Date.now()): { attempt: LimitAttempt | null; priorStatus: LimitRecordStatus } | null {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec) return SKIP_WRITE;
    if (rec.status !== "resuming" && rec.status !== "stopped" && rec.status !== "deferred") return SKIP_WRITE;
    const attempt = rec.attempt;
    const priorStatus = rec.status as LimitRecordStatus;
    rec.status = "interactive";
    rec.interactiveDeadlineAt = now + INTERACTIVE_DEADLINE_MS;
    rec.updatedAt = now;
    return { attempt, priorStatus };
  });
  return r === SKIP_WRITE ? null : (r as { attempt: LimitAttempt | null; priorStatus: LimitRecordStatus });
}

/**
 * Two-phase cancel, phase 1: make the record non-dispatchable BEFORE touching
 * child/session. Returns a snapshot of the record AS CANCELLING (post-CAS) --
 * callers must use ITS fields (limitEventId, generation, attempt) for every
 * subsequent identity check, never a pre-CAS read that a re-limit generation
 * may have invalidated.
 */
export function beginCancellation(key: string, now = Date.now()): { record: LimitRecord } | null {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec) return SKIP_WRITE;
    if (LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.terminal) return SKIP_WRITE;
    rec.status = "cancelling";
    rec.updatedAt = now;
    return { record: JSON.parse(JSON.stringify(rec)) as LimitRecord };
  });
  return r === SKIP_WRITE ? null : (r as { record: LimitRecord });
}

/**
 * Two-phase cancel, phase 2 (child confirmed gone + interruption cleared).
 * Also accepts a stood-down `manual`/cancellation_blocked record: that state
 * preserves a child the earlier cancel could not terminate, and reconciliation
 * finishes the cancellation here once the child is finally confirmed dead.
 */
/**
 * Two-phase cancel, phase 2 attempt clear: drop a cancelling/blocked record's
 * attempt AFTER its child's death has been CONFIRMED by the caller. Separated
 * from completeCancellation so the terminal transition cannot itself discard a
 * possibly-live child's evidence (completeCancellation refuses while an attempt
 * remains). Only fires inside the cancellation flow.
 */
export function clearCancellingAttempt(key: string, attemptId: string, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.attempt?.id !== attemptId) return SKIP_WRITE;
    const inCancelFlow =
      rec.status === "cancelling" || (rec.status === "manual" && rec.reasonCode === "cancellation_blocked");
    if (!inCancelFlow) return SKIP_WRITE;
    rec.attempt = null;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/**
 * Phase-2 clear for an interactive takeover: an interactive resume displaced
 * our wake child (its attempt was preserved as evidence), and supervision has
 * now CONFIRMED that child dead. Dropping the attempt here lets the record
 * terminalize (-> resumed) or revert (-> stopped at its deadline) without
 * orphaning a live process. Guarded to `interactive` + exact attemptId so no
 * other flow can use it to discard a still-live child's evidence.
 */
export function clearInteractiveAttempt(key: string, attemptId: string, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.attempt?.id !== attemptId) return SKIP_WRITE;
    if (rec.status !== "interactive") return SKIP_WRITE;
    rec.attempt = null;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

export function completeCancellation(key: string, now = Date.now(), expectedGeneration?: number): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec) return SKIP_WRITE;
    // Optional generation CAS: a re-limit that superseded the cancelling
    // record mid-cancel minted a NEW auto-resume the user has not cancelled.
    if (expectedGeneration != null && rec.generation !== expectedGeneration) return SKIP_WRITE;
    const blockedCancel = rec.status === "manual" && rec.reasonCode === "cancellation_blocked";
    if (rec.status !== "cancelling" && !blockedCancel) return SKIP_WRITE;
    // Two-phase safety: a still-present attempt names a child whose death has
    // NOT been confirmed. Terminalizing here would drop that evidence and let a
    // live child outlive the record. The caller confirms death and clears the
    // attempt (clearCancellingAttempt) FIRST; only then may the cancel complete.
    if (rec.attempt != null) return SKIP_WRITE;
    rec.status = "cancelled";
    rec.reasonCode = "user_cancel";
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/** Cancel could not complete (child unkillable / identity inconclusive): stand down, keep evidence. */
export function blockCancellation(key: string, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.status !== "cancelling") return SKIP_WRITE;
    rec.status = "manual";
    rec.reasonCode = "cancellation_blocked";
    // attempt preserved: it names the child reconciliation keeps trying to terminate.
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/** User-driven: return a stood-down/failed record to the queue as a fresh episode. */
export function requeueRecord(key: string, now = Date.now()): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || !LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.requeueable) return SKIP_WRITE;
    // A preserved attempt (cancellation_blocked) names a child that could not
    // be terminated. Requeueing would let claimAttempt overwrite that evidence
    // and spawn a second child beside it: refuse until the child's exit is
    // confirmed and the attempt cleared (waker finish-cancel does both).
    if (rec.attempt) return SKIP_WRITE;
    rec.status = "stopped";
    rec.reasonCode = null;
    rec.wakeAttempts = 0;
    rec.deferCount = 0;
    rec.preSpawnDeferCount = 0;
    rec.nextAttemptAt = now;
    rec.lastError = null;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

/** Fallback reparse upgrade: stronger reset evidence replaces a fallback estimate. Generation-CAS'd. */
export function upgradeResetTime(
  key: string,
  generation: number,
  update: { resetAt: number; resetSource: "absolute" | "relative"; rawBanner: string | null; limitType?: "session" | "weekly" | "unknown" },
  now = Date.now(),
): boolean {
  const r = mutateLimitLedger((ledger) => {
    const rec = ledger.records[key];
    if (!rec || rec.generation !== generation) return SKIP_WRITE;
    if (rec.status !== "stopped" && rec.status !== "deferred") return SKIP_WRITE;
    if (rec.resetSource !== "fallback") return SKIP_WRITE;
    if (rec.attempt) return SKIP_WRITE;
    rec.resetAt = update.resetAt;
    rec.resetSource = update.resetSource;
    rec.nextAttemptAt = update.resetAt;
    rec.rawBanner = update.rawBanner;
    if (update.limitType) rec.limitType = update.limitType;
    rec.updatedAt = now;
    return true;
  });
  return r === true;
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

/** Due for a wake attempt. Read-only; callers still claim via CAS. */
export function selectDueRecords(ledger: LimitLedger, now: number, maxAttempts: number): LimitRecord[] {
  return Object.values(ledger.records)
    .filter(
      (rec) =>
        LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.dispatchable &&
        // Lingering attempt evidence = a child whose death is unconfirmed;
        // the record stays out of dispatch until termination clears it.
        rec.attempt == null &&
        rec.nextAttemptAt <= now &&
        rec.wakeAttempts < maxAttempts,
    )
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
}

/** Compact per-record view for status surfaces (storybloq_status, limit-status). */
export interface LimitStopSummary {
  key: string;
  clientTaskId: string;
  storybloqSessionId: string | null;
  projectRoot: string;
  sessionType: "autonomous" | "plain";
  status: string;
  mode: "headless" | "notify";
  limitType: "session" | "weekly" | "unknown";
  resetAt: number;
  nextAttemptAt: number;
  wakeAttempts: number;
  generation: number;
  reasonCode: string | null;
}

function toLimitStopSummary(rec: LimitRecord): LimitStopSummary {
  return {
    key: rec.key,
    clientTaskId: rec.clientTaskId,
    storybloqSessionId: rec.storybloqSessionId,
    projectRoot: rec.projectRoot,
    sessionType: rec.sessionType,
    status: rec.status,
    mode: rec.mode,
    limitType: rec.limitType,
    resetAt: rec.resetAt,
    nextAttemptAt: rec.nextAttemptAt,
    wakeAttempts: rec.wakeAttempts,
    generation: rec.generation,
    reasonCode: rec.reasonCode,
  };
}

export interface ListLimitStopsOptions {
  /**
   * ISS-944: include terminal records (defer_exhausted, attempts_exhausted,
   * etc.) so an operator can find them without already knowing the record
   * key. Omitted/false preserves today's non-terminal-only behavior exactly.
   */
  includeTerminal?: boolean;
}

/**
 * Non-terminal records, cross-project (the `limit-status` CLI view), sorted
 * by `nextAttemptAt` ascending. With `includeTerminal: true`, terminal
 * records are appended after, sorted by `updatedAt` descending (most
 * recently terminalized first). One explicit TOTAL ORDER: every record falls
 * into exactly one group, each group has its own well-defined sort key, and
 * the boundary is fixed (active always precedes terminal) -- no comparator
 * ever compares a `nextAttemptAt` against an `updatedAt`. `key` breaks ties
 * within a group so equal timestamps still produce a deterministic order,
 * not one dependent on object property insertion order.
 */
export function listLimitStops(opts?: ListLimitStopsOptions): LimitStopSummary[] {
  const records = Object.values(readLimitLedger().records);
  const active = records
    .filter((rec) => !LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.terminal)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.key.localeCompare(b.key));
  if (!opts?.includeTerminal) return active.map(toLimitStopSummary);
  const terminal = records
    .filter((rec) => LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.terminal)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  return [...active, ...terminal].map(toLimitStopSummary);
}

/** Non-terminal records for one project (the storybloq_status section). Realpath-tolerant. */
export function listLimitStopsForProject(projectRoot: string): LimitStopSummary[] {
  let canonical = projectRoot;
  try {
    canonical = fs.realpathSync(projectRoot);
  } catch {
    // Compare as-given.
  }
  return listLimitStops().filter((s) => {
    if (s.projectRoot === projectRoot || s.projectRoot === canonical) return true;
    try {
      return fs.realpathSync(s.projectRoot) === canonical;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface SessionLimitSnapshot {
  state: string;
  compactPending: boolean;
  interruptionKind: "compact" | "limit" | null;
  limitEventId: string | null;
}

export interface ReconcileDeps {
  now?: number;
  /**
   * Read the autonomous session's limit-relevant fields.
   * Returns null when the session (or project) is definitively absent,
   * undefined when unreadable/unknown (record is left alone).
   */
  readSession: (projectRoot: string, storybloqSessionId: string) => SessionLimitSnapshot | null | undefined;
  /**
   * Is the recorded attempt child still alive? undefined = cannot tell.
   * Receives the owning record so implementations can require the full
   * attempt identity (clientTaskId + attempt id), not just a generic marker.
   */
  isAttemptChildAlive?: (attempt: LimitAttempt, rec: LimitRecord) => boolean | undefined;
}

export type ReconcileAction =
  | { type: "finish-cancel"; key: string; attempt: LimitAttempt | null }
  /** Project/session gone while an attempt tracks a possibly-live child: confirm termination, THEN failProjectGoneConfirmed. */
  | { type: "terminate-project-gone"; key: string; attempt: LimitAttempt; generation: number };

/**
 * Cross-store reconciliation: runs at waker startup and from housekeeping.
 * Session state wins on conflicts; deliberately non-headless outcomes are
 * never re-armed. Returns actions the caller must complete outside the ledger
 * lock (child termination + session mutation live in the autonomous layer).
 */
export function reconcileLimitLedger(deps: ReconcileDeps): { changedKeys: string[]; actions: ReconcileAction[] } {
  const now = deps.now ?? Date.now();
  const changedKeys: string[] = [];
  const actions: ReconcileAction[] = [];

  mutateLimitLedger((ledger) => {
    // The RMW engine retries on fence loss; start each attempt clean.
    changedKeys.length = 0;
    actions.length = 0;
    let changed = false;
    for (const rec of Object.values(ledger.records)) {
      const before = rec.status;

      const snap =
        rec.sessionType === "autonomous" && rec.storybloqSessionId
          ? deps.readSession(rec.projectRoot, rec.storybloqSessionId)
          : undefined;
      // Limit-pending for ANY event (not just this record's): a session parked
      // for a DIFFERENT limitEventId is mid re-limit (the handler writes the
      // new session event id, THEN upserts the ledger -- a reconcile landing in
      // that window would otherwise see a mismatch). It is NOT resume evidence.
      const sessionLimitPending =
        snap != null && snap.compactPending === true && snap.interruptionKind === "limit";
      const sessionStillPending = sessionLimitPending && snap!.limitEventId === rec.limitEventId;
      // `advanced` = the session is READABLE and NOT limit-pending for any
      // event (real resume evidence). A different-event pending session is an
      // episode conflict handled by the newer record, never a resume here.
      // `absent` = the session/project is definitively gone -- a project_gone
      // FAILURE, never a resume.
      const sessionAdvanced = rec.sessionType === "autonomous" && snap != null && !sessionLimitPending;
      const sessionAbsent = rec.sessionType === "autonomous" && snap === null;

      const failProjectGone = (): void => {
        // A tracked attempt names a child whose death is unconfirmed (a
        // process does NOT necessarily exit when its cwd is removed). A
        // terminal transition would end its supervision, so emit a
        // termination action instead and terminalize only once the waker
        // confirms the exit (failProjectGoneConfirmed).
        if (rec.attempt) {
          if (rec.attempt.childPid == null) {
            // A bare claim (no child yet): the claimant may still spawn. Keep
            // the record non-terminal until the claimant is confirmed gone --
            // terminalizing now would let a subsequent spawn create a child
            // with no ledger evidence naming it.
            if (!claimAbandoned(rec.attempt, now)) return;
            rec.attempt = null; // claimant confirmed gone -> safe to drop the claim
          } else {
            const alive = deps.isAttemptChildAlive?.(rec.attempt, rec);
            if (alive !== false) {
              actions.push({ type: "terminate-project-gone", key: rec.key, attempt: rec.attempt, generation: rec.generation });
              return;
            }
            rec.attempt = null;
          }
        }
        rec.status = "failed";
        rec.reasonCode = "project_gone";
      };

      switch (rec.status as LimitRecordStatus) {
        case "preparing": {
          const owner = rec.preparingOwner;
          const ownerAlive =
            owner != null &&
            (inspectProcessIdentitySync(owner.pid, owner.signature ?? null) === "alive" ||
              now - owner.heartbeatAt < INTENT_GRACE_MS);
          if (ownerAlive) break;
          if (rec.sessionType === "plain" || sessionStillPending) {
            // Owner died after (or without needing) session prep: activate.
            rec.status = "stopped";
            rec.preparingOwner = null;
            rec.prevRecord = null;
          } else if (snap !== undefined) {
            // Owner died before session prep: discard the intent, restoring
            // the full record it replaced (mirrors abortIntent).
            const prev = LimitRecordSchema.safeParse(rec.prevRecord);
            if (prev.success) {
              ledger.records[rec.key] = { ...prev.data, updatedAt: now };
              changed = true;
              changedKeys.push(rec.key);
              continue;
            }
            delete ledger.records[rec.key];
            changed = true;
            changedKeys.push(rec.key);
            continue;
          }
          break;
        }
        case "manual":
          // A blocked cancellation preserves an attempt naming a child that
          // could not be terminated: keep retrying termination (finish-cancel
          // confirms exit, clears the attempt, and completes the cancel).
          // Attempt-less blocked cancels also route through finish-cancel so
          // they reach `cancelled` instead of lingering as manual forever.
          if (rec.reasonCode === "cancellation_blocked") {
            actions.push({ type: "finish-cancel", key: rec.key, attempt: rec.attempt });
            break;
          }
          if (sessionAdvanced && rec.mode === "headless") {
            rec.status = "resumed";
            rec.attempt = null;
          } else if (sessionAbsent) {
            failProjectGone();
          }
          break;
        case "stopped":
        case "deferred":
          if (sessionAdvanced && rec.mode === "headless") {
            rec.status = "resumed";
            rec.attempt = null;
          } else if (sessionAbsent) {
            failProjectGone();
          }
          break;
        case "resuming": {
          const attempt = rec.attempt;
          // A BARE claim (no child yet) whose claimant may still spawn must not
          // be terminalized or reclaimed on ANY signal -- session advancement,
          // project absence, or age -- because a subsequent spawn would be
          // untracked. Hold the record until the claimant spawns (concrete pid,
          // handled below) or is confirmed gone (claimAbandoned).
          if (attempt && attempt.childPid == null && attempt.generation === rec.generation && !claimAbandoned(attempt, now)) {
            break;
          }
          if (sessionAdvanced) {
            rec.status = "resumed";
            rec.attempt = null;
            break;
          }
          if (sessionAbsent) {
            failProjectGone();
            break;
          }
          if (!attempt) {
            rec.status = "stopped";
            break;
          }
          if (attempt.generation !== rec.generation) break; // waker handles superseded children
          if (attempt.childPid == null) {
            // Bare claim, claimant confirmed gone: reclaim for re-dispatch.
            rec.status = "stopped";
            rec.attempt = null;
            break;
          }
          const childAlive = deps.isAttemptChildAlive?.(attempt, rec);
          const lastSign = attempt.lastProgressAt ?? attempt.spawnedAt ?? rec.updatedAt;
          if (childAlive === false && now - lastSign > STALE_ATTEMPT_MS) {
            rec.status = "stopped";
            rec.attempt = null;
          }
          break;
        }
        case "interactive":
          // A displaced wake child may still be alive: the resume-prompt hook
          // async-SIGTERM'd it without confirming exit and PRESERVED the
          // attempt as evidence. Never terminalize (-> resumed) or revert (->
          // stopped) while that evidence stands, even if the session advanced:
          // clearing the attempt would orphan a possibly-live child. Hold the
          // record interactive; the waker's superviseAttempt confirms the
          // child's death and clears the attempt, and a later reconcile then
          // resolves cleanly. (A superseded-generation attempt is the waker's
          // supersede path; leave it likewise untouched here.)
          if (rec.attempt != null) break;
          if (sessionAdvanced) {
            rec.status = "resumed";
            rec.interactiveDeadlineAt = null;
          } else if (sessionAbsent) {
            failProjectGone();
          } else if (rec.interactiveDeadlineAt != null && now > rec.interactiveDeadlineAt) {
            rec.status = "stopped";
            rec.interactiveDeadlineAt = null;
          }
          break;
        case "cancelling":
          actions.push({ type: "finish-cancel", key: rec.key, attempt: rec.attempt });
          break;
        case "resumed":
          // Evidence conflict: we recorded success but the session is still
          // parked. Re-arm only resumable headless records.
          if (rec.sessionType === "autonomous" && sessionStillPending && rec.mode === "headless") {
            rec.status = "stopped";
            rec.nextAttemptAt = Math.max(rec.resetAt, now);
          }
          break;
        case "notified":
        case "failed":
        case "cancelled":
          break;
      }

      if (rec.status !== before) {
        rec.updatedAt = now;
        changed = true;
        changedKeys.push(rec.key);
      }
    }

    // Prune: terminal after 7d, stood-down manual after 30d. NEVER age-prune a
    // record still carrying attempt evidence (a blocked cancellation's attempt
    // is the only sentinel naming a child termination keeps retrying) -- such
    // records leave only through confirmed termination.
    for (const [key, rec] of Object.entries(ledger.records)) {
      if (rec.attempt) continue;
      const meta = LIMIT_STATUS_META[rec.status as LimitRecordStatus];
      const age = now - (rec.updatedAt || rec.detectedAt);
      if ((meta?.terminal && age > PRUNE_TERMINAL_AFTER_MS) || (rec.status === "manual" && age > PRUNE_MANUAL_AFTER_MS)) {
        delete ledger.records[key];
        changed = true;
        changedKeys.push(key);
      }
    }

    return changed ? true : SKIP_WRITE;
  });

  return { changedKeys, actions };
}
