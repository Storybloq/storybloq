/**
 * T-534 Part B: project-local normalisation of sessions the retired
 * usage-limit auto-resume wrote. Idempotent and marker-free: every entry that
 * reads a session for resume, clearing or compaction runs it first.
 *
 * Decisions come from the keys PERSISTED in state.json, never from parsed
 * values (a parse can supply defaults the file never held):
 *
 * - a session that has not ended, with a wake attempt that may still run:
 *   `failed`, nothing written, whether or not it carries a limit key;
 * - no limit key: `unchanged`, nothing written;
 * - limit keys without `interruptionKind: "limit"`, or on a session that is
 *   terminal or already running: the keys are stripped and nothing else moves;
 * - a genuine legacy park (COMPACT, compactPending, a known preCompactState,
 *   not terminal): after the surviving-attempt check, an ordinary compact
 *   park, or for FINALIZE the landed-commit rule decides between keeping
 *   FINALIZE and the IMPLEMENT recovery;
 * - an inconsistent park, an unreadable file, or git that cannot answer:
 *   `failed`, nothing written, and the caller refuses.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  findSessionById,
  sessionsRoot,
  withSessionLock,
  withoutLimitKeys,
  writeSessionSync,
  LIMIT_KEYS,
} from "./session.js";
import { WORKFLOW_STATES, type FullSessionState } from "./session-types.js";
import { classifyLandedCommit, inspectLandedCommit, itemBaseline } from "./landed-commit.js";
import { RECOVERY_MAPPING, recoveryResets } from "./recovery-state.js";
import { storybloqGlobalDir } from "../core/global-config.js";
import {
  classifyLedger,
  readOwnedFileNoFollow,
  DEFAULT_ATTEMPT_PROBES,
  type AttemptProbes,
  type ReferencedSession,
} from "../core/limit-retirement.js";

const STATE_MAX_BYTES = 16 * 1024 * 1024;
const LEDGER_MAX_BYTES = 4 * 1024 * 1024;

export type RetiredParkTransition = "stripped" | "compact-park" | "finalize-kept" | "finalize-recovered";

/**
 * What a failure is about, for the sentence a caller shows: a session with no
 * persisted limit key held only by a wake attempt the ledger records, a
 * legacy park (limit keys present), or a session that could not be read.
 */
export type RetiredParkFailureCause =
  | { readonly kind: "recorded-attempt"; readonly attemptId: string | null }
  | { readonly kind: "legacy-park" }
  | { readonly kind: "unreadable" };

export type RetiredParkResult =
  | { readonly kind: "unchanged"; readonly state: FullSessionState }
  | { readonly kind: "normalized"; readonly state: FullSessionState; readonly transition: RetiredParkTransition }
  | { readonly kind: "failed"; readonly reason: string; readonly cause: RetiredParkFailureCause };

export interface RetiredParkOptions {
  /**
   * `clear-compact --force`: a FINALIZE park whose landed commit git cannot
   * classify takes the IMPLEMENT recovery instead of failing. Nothing else
   * is bypassed.
   */
  readonly forceUnavailableGit?: boolean;
  readonly probes?: AttemptProbes;
  readonly globalDir?: string;
}

export type WakeAttemptCheck =
  | { readonly kind: "clear" }
  /** `attemptId` is null when the ledger itself could not be read. */
  | { readonly kind: "held"; readonly reason: string; readonly attemptId: string | null };

/**
 * Is a wake attempt the retired runtime started for this session still
 * possibly alive? A live or unclassifiable attempt holds the session: acting
 * on it could race a `claude --resume` child that is already running it.
 */
export function checkSurvivingWakeAttempts(sessionId: string, opts: RetiredParkOptions = {}): WakeAttemptCheck {
  const ledgerPath = join(opts.globalDir ?? storybloqGlobalDir(), "limit-ledger.json");
  const read = readOwnedFileNoFollow(ledgerPath, LEDGER_MAX_BYTES);
  if (read.kind === "absent") return { kind: "clear" };
  const unreadable = (why: string): WakeAttemptCheck => ({
    kind: "held",
    attemptId: null,
    reason:
      `${ledgerPath} (${why}) may still track a wake attempt for session ${sessionId}. ` +
      `Delete it once \`ps\` shows no \`claude --resume\` wake child for this session, then retry.`,
  });
  if (read.kind === "refused") return unreadable(read.reason);
  const reading = classifyLedger(read.text, opts.probes ?? DEFAULT_ATTEMPT_PROBES);
  if (reading.kind === "malformed") return unreadable(reading.reason);
  const held = reading.attempts.filter((a) => a.sessionId === sessionId && a.verdict !== "gone");
  if (held.length === 0) return { kind: "clear" };
  const first = held[0]!;
  return {
    kind: "held",
    attemptId: first.attemptId ?? first.recordKey,
    reason:
      `a usage-limit wake attempt (${first.attemptId ?? first.recordKey}) for session ${sessionId} may still be ` +
      `running (${first.reason}). Retry once it has exited; nothing was changed.`,
  };
}

function readPersistedKeys(dir: string): Set<string> | string {
  const read = readOwnedFileNoFollow(join(dir, "state.json"), STATE_MAX_BYTES);
  if (read.kind === "absent") return "state.json is missing";
  if (read.kind === "refused") return read.reason;
  try {
    const raw = JSON.parse(read.text) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "state.json is not an object";
    return new Set(Object.keys(raw));
  } catch {
    return "state.json is not valid JSON";
  }
}

function isTerminal(state: FullSessionState): boolean {
  return state.status !== "active" || state.state === "SESSION_END" || state.terminalDisposition != null;
}

const RESUMABLE_STATES: readonly string[] = WORKFLOW_STATES.filter((s) => s !== "COMPACT" && s !== "SESSION_END");

function record(dir: string, written: FullSessionState, transition: RetiredParkTransition, extra: Record<string, unknown> = {}): void {
  appendEvent(dir, {
    rev: written.revision,
    type: "limit_park_retired",
    timestamp: new Date().toISOString(),
    data: { transition, ...extra },
  });
}

/**
 * The lock-held primitive. The caller holds `withSessionLock` for `root` and
 * passes the state it read under that lock; from here on it must use the
 * returned state, never its earlier read.
 */
export async function normalizeRetiredLimitParkLocked(
  root: string,
  dir: string,
  state: FullSessionState,
  opts: RetiredParkOptions = {},
): Promise<RetiredParkResult> {
  const keys = readPersistedKeys(dir);
  if (typeof keys === "string") return { kind: "failed", reason: `session ${state.sessionId}: ${keys}`, cause: { kind: "unreadable" } };
  const hasLimitKeys = LIMIT_KEYS.some((k) => keys.has(k));
  const failed = (reason: string): RetiredParkResult => ({ kind: "failed", reason, cause: { kind: "legacy-park" } });

  // A session that has not ended is never acted on while a wake attempt the
  // retired runtime started for it may still run, whatever its keys say: the
  // attempt can have resumed it already, and a key-free session is exactly
  // what a running wake child leaves behind. A strip would also erase the park
  // before the attempt is known to be gone.
  if (!isTerminal(state)) {
    const attempts = checkSurvivingWakeAttempts(state.sessionId, opts);
    if (attempts.kind === "held") {
      return {
        kind: "failed",
        reason: attempts.reason,
        cause: hasLimitKeys ? { kind: "legacy-park" } : { kind: "recorded-attempt", attemptId: attempts.attemptId },
      };
    }
  }

  if (!hasLimitKeys) return { kind: "unchanged", state };

  const strip = (): RetiredParkResult => {
    try {
      const written = writeSessionSync(dir, withoutLimitKeys(state));
      record(dir, written, "stripped");
      return { kind: "normalized", state: written, transition: "stripped" };
    } catch (err) {
      return failed(`session ${state.sessionId}: write failed (${(err as Error).message})`);
    }
  };

  // Inert keys from an ordinary write under the old schema, or stale limit
  // metadata on a session that ended or already resumed: strip only.
  if (state.interruptionKind !== "limit" || isTerminal(state) || state.state !== "COMPACT") return strip();

  if (!state.compactPending || !state.preCompactState || !RESUMABLE_STATES.includes(state.preCompactState)) {
    return {
      kind: "failed",
      cause: { kind: "legacy-park" },
      reason:
        `session ${state.sessionId} is an inconsistent usage-limit park (state COMPACT, compactPending ` +
        `${state.compactPending}, preCompactState ${state.preCompactState ?? "null"}); nothing was changed. ` +
        `Inspect it with "storybloq session show ${state.sessionId}".`,
    };
  }

  const now = new Date().toISOString();
  try {
    if (state.preCompactState !== "FINALIZE") {
      const written = writeSessionSync(dir, withoutLimitKeys({ ...state, compactPreparedAt: now }));
      record(dir, written, "compact-park");
      return { kind: "normalized", state: written, transition: "compact-park" };
    }

    const evidence = await inspectLandedCommit(root, state, itemBaseline(state) ?? null, { ancestry: true });
    const landed = classifyLandedCommit(evidence);
    if (landed === "committed" || landed === "verified") {
      const written = writeSessionSync(dir, withoutLimitKeys({ ...state, compactPreparedAt: now }));
      record(dir, written, "finalize-kept", { landed });
      return { kind: "normalized", state: written, transition: "finalize-kept" };
    }
    if (landed === "unavailable" && !opts.forceUnavailableGit) {
      return {
        kind: "failed",
        cause: { kind: "legacy-park" },
        reason:
          `session ${state.sessionId} stopped during FINALIZE and git could not confirm what landed ` +
          `(HEAD, the item commit or its ancestry was unreadable). Nothing was changed. Check the repository, ` +
          `then retry, or run "storybloq session clear-compact ${state.sessionId} --force" to recover to IMPLEMENT.`,
      };
    }
    // Nothing landed, an unrelated or unattributed commit, or a forced clear:
    // re-target the park to the FINALIZE recovery, as external drift would.
    const mapping = RECOVERY_MAPPING.FINALIZE!;
    const head = landed === "unavailable" ? null : evidence.head;
    const written = writeSessionSync(dir, withoutLimitKeys({
      ...state,
      ...recoveryResets(state, mapping),
      state: "COMPACT",
      compactPending: true,
      preCompactState: mapping.state,
      compactPreparedAt: now,
      compactObservedAt: null,
      ...(head !== null
        ? { git: { ...state.git, expectedHead: head, mergeBase: head, itemBaseHead: head } }
        : {}),
    } as FullSessionState));
    record(dir, written, "finalize-recovered", { landed, forced: landed === "unavailable" });
    return { kind: "normalized", state: written, transition: "finalize-recovered" };
  } catch (err) {
    return failed(`session ${state.sessionId}: write failed (${(err as Error).message})`);
  }
}

/** The acquiring wrapper: takes the session lock, re-reads, and runs the primitive. */
export async function normalizeRetiredLimitPark(
  root: string,
  sessionId: string,
  opts: RetiredParkOptions & {
    /**
     * The caller's ownership, decided on the state read under the lock. A
     * state it rejects is returned `unchanged` with nothing written, so the
     * caller routes on that fresh state instead of its earlier read.
     */
    readonly mayAct?: (state: FullSessionState) => boolean;
  } = {},
): Promise<RetiredParkResult> {
  return withSessionLock(root, async () => {
    const info = findSessionById(root, sessionId);
    if (!info) {
      return { kind: "failed", reason: `session ${sessionId} not found or unreadable`, cause: { kind: "unreadable" } } as const;
    }
    if (opts.mayAct && !opts.mayAct(info.state)) return { kind: "unchanged", state: info.state } as const;
    return normalizeRetiredLimitParkLocked(root, info.dir, info.state, opts);
  });
}

const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Every session of one project, for a caller that already holds that
 * project's session lock (the guide's `start`, which can supersede parks it
 * discovers). A session `mayAct` rejects is not touched: the caller's
 * ownership is decided on the state as found, before any write, so a session
 * another task owns is left exactly as it is. Every other session goes
 * through the primitive, with or without a limit key, so a nonterminal one a
 * wake attempt may still be running fails instead of being superseded.
 * Returns the ones that failed, by directory.
 */
export interface FailedPark {
  readonly dir: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly cause: RetiredParkFailureCause;
}

/**
 * The one sentence a caller shows for a failure, naming which fact applies:
 * a wake attempt still recorded for a session with no limit key, or a park
 * the retired auto-resume wrote. The reason follows as the detail.
 */
export function describeRetiredParkFailure(sessionId: string, failure: { readonly reason: string; readonly cause: RetiredParkFailureCause }): string {
  switch (failure.cause.kind) {
    case "recorded-attempt":
      return failure.cause.attemptId === null
        ? `a legacy usage-limit wake attempt may still be recorded for session ${sessionId} (limit-ledger.json is unreadable): ${failure.reason}`
        : `a legacy usage-limit wake attempt ${failure.cause.attemptId} is still recorded for session ${sessionId} (limit-ledger.json): ${failure.reason}`;
    case "legacy-park":
      return `session ${sessionId} was stopped by the retired usage-limit auto-resume and could not be normalised: ${failure.reason}`;
    case "unreadable":
      return `session ${sessionId} could not be read to check for the retired usage-limit auto-resume: ${failure.reason}`;
  }
}

export async function normalizeProjectParksLocked(
  root: string,
  mayAct: (state: FullSessionState) => boolean,
  opts: RetiredParkOptions = {},
): Promise<FailedPark[]> {
  const sessionsDir = sessionsRoot(root);
  let ids: string[];
  try {
    const st = lstatSync(sessionsDir);
    if (!st.isDirectory() || st.isSymbolicLink()) return [];
    ids = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const failed: FailedPark[] = [];
  for (const id of ids) {
    if (!SESSION_ID_SHAPE.test(id) || !existsSync(join(sessionsDir, id, "state.json"))) continue;
    const info = findSessionById(root, id);
    if (!info) continue;
    if (!mayAct(info.state)) continue;
    const result = await normalizeRetiredLimitParkLocked(root, info.dir, info.state, opts);
    if (result.kind === "failed") failed.push({ dir: info.dir, sessionId: info.state.sessionId, reason: result.reason, cause: result.cause });
  }
  return failed;
}

/**
 * Part A step 4: best effort over the sessions the ledger names plus every
 * session of the current project. A repo that is missing, not a real
 * directory or has no sessions directory is skipped and named; nothing is
 * created in it. Returns what was skipped or failed.
 */
export async function normalizeRetiredParksBestEffort(
  referenced: readonly ReferencedSession[],
  currentProjectRoot: string | null,
  opts: RetiredParkOptions = {},
): Promise<string[]> {
  const byRoot = new Map<string, Set<string> | "all">();
  for (const s of referenced) {
    let ids = byRoot.get(s.projectRoot);
    if (ids === undefined) {
      ids = new Set();
      byRoot.set(s.projectRoot, ids);
    }
    if (ids !== "all") ids.add(s.sessionId);
  }
  if (currentProjectRoot) byRoot.set(currentProjectRoot, "all");

  const skipped: string[] = [];
  for (const [root, wanted] of byRoot) {
    const sessionsDir = sessionsRoot(root);
    try {
      const st = lstatSync(sessionsDir);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        skipped.push(`${root}: sessions directory is not a real directory`);
        continue;
      }
    } catch {
      if (existsSync(root)) continue; // No sessions yet: nothing to normalise.
      skipped.push(`${root}: missing`);
      continue;
    }
    let ids: string[];
    try {
      ids = wanted === "all" ? readdirSync(sessionsDir) : [...wanted];
    } catch (err) {
      skipped.push(`${root}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`);
      continue;
    }
    for (const id of ids) {
      if (!SESSION_ID_SHAPE.test(id)) continue;
      // A whole-project pass visits only entries that hold a session.
      if (wanted === "all" && !existsSync(join(sessionsDir, id, "state.json"))) continue;
      try {
        const result = await normalizeRetiredLimitPark(root, id, opts);
        if (result.kind === "failed") skipped.push(`${root}: ${result.reason}`);
      } catch (err) {
        skipped.push(`${root}/${id}: ${(err as Error).message}`);
      }
    }
  }
  return skipped;
}
