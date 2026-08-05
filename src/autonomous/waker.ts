/**
 * T-424: The limit waker -- a transient detached process that resumes
 * limit-stopped Claude Code sessions when their usage limit resets.
 *
 * Deliberately NOT a daemon: it exits when no non-terminal ledger records
 * remain, and it survives reboot/logout only through opportunistic respawn
 * (spawnWakerIfNeeded from the StopFailure handler, CLI housekeeping, and the
 * hook handlers). It epoch-polls every 30s against the wall clock (never one
 * long timer), so laptop sleep merely delays a poll.
 *
 * Wake-vs-reopen race protocol: before spawning `claude -p --resume`, the
 * waker writes a per-session wake claim and passes STORYBLOQ_WAKE_ATTEMPT=
 * "<attemptId>.<token>" in the child env. Hooks inherit the client env, so the
 * SessionStart handler distinguishes the waker's own child (env token matches
 * the claim -> silent) from an interactive reopen (tokenless -> revoke claim,
 * mark `interactive`, async-SIGTERM the child). Feasibility caveat: env
 * propagation into hook subprocesses is undocumented; claims also record the
 * child pid so a parent-ancestry fallback is possible (verified in E2E).
 *
 * Lock hierarchy (see limit-ledger.ts): the ledger lock lives only inside the
 * limit-ledger helpers. The waker claims via CAS, releases, does slow work
 * (liveness, git, spawn), then commits via attempt-scoped CAS. The wake-claim
 * lock may wrap ledger calls; never the reverse.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  readLimitLedger,
  selectDueRecords,
  claimAttempt,
  claimAbandoned,
  recordAttemptSpawn,
  attachOrphanChildPid,
  touchAttemptProgress,
  settleAttempt,
  clearSupersededAttempt,
  clearConfirmedDeadAttempt,
  clearInteractiveAttempt,
  failProjectGoneConfirmed,
  isWakerActionable,
  markNotified,
  failRecord,
  upgradeResetTime,
  completeCancellation,
  clearCancellingAttempt,
  blockCancellation,
  reconcileLimitLedger,
  isLimitResumeGloballyDisabled,
  hasPendingLimitRecords,
  wakerLockPath,
  CLAIM_SPAWN_STALE_MS,
  LIMIT_STATUS_META,
  type LimitRecord,
  type LimitRecordStatus,
  type LimitReasonCode,
  type LimitAttempt,
  type SessionLimitSnapshot,
  type ReconcileAction,
  type SettleResult,
} from "../core/limit-ledger.js";
import {
  acquireLimitLock,
  releaseLimitLock,
  renewLimitLock,
  withLimitLock,
  inspectProcessIdentitySync,
} from "../core/limit-lock.js";
import { readLimitResumeConfig, type LimitResumeConfig } from "../core/limit-config.js";
import { sendDesktopNotification } from "../core/notify.js";
import { hasArgvSignature, probeArgvSignature, readOwnerHeartbeat } from "./liveness.js";
import {
  WAKE_ATTEMPT_ENV,
  writeWakeClaim,
  clearWakeClaim,
  wakeClaimLockPath,
  signalWakeChild,
  wakeChildMarkers,
  wakeAttemptSentinel,
} from "./wake-claim.js";
import { findSessionById, withSessionLock, downgradeLimitParkToCompact } from "./session.js";
import { detectClaudeVersion } from "./agent-view.js";
import { resolveResetAt } from "./limit-reset-parser.js";
import { scanTranscriptTailForLimit, transcriptHasTurnAfter } from "./limit-transcript.js";

export const WAKER_ARGV_SENTINEL = "--sb-waker";
export const WAKER_POLL_MS = 30_000;
/** Long-lived singleton lock; renewed every poll so a live waker is never stolen. */
export const WAKER_LOCK_LEASE_MS = 120_000;
/** An alive-file heartbeat younger than this means a client process still owns the session. */
export const ALIVE_FRESH_MS = 30_000;
/** Alive-but-blocked grace after reset before the record stands down to `manual`. */
export const BLOCKED_GRACE_MS = 60 * 60_000;
/** Absolute safety cap on a single wake child. */
export const ATTEMPT_SAFETY_CAP_MS = 24 * 3_600_000;
/** A child that exits within this window of spawn is judged on the next poll, not instantly. */
const SPAWN_SETTLE_GRACE_MS = 10_000;
// CLAIM_SPAWN_STALE_MS is the LEGACY no-claimant fallback window: elapsed time
// abandons a claimed-but-never-spawned attempt ONLY when it recorded no claimant
// identity (claimantPid == null). A recorded claimant is abandoned solely on a
// positively-confirmed dead identity, never on age (see claimAbandoned). It
// lives in limit-ledger so the hook-path CLI cancels share it without importing
// the waker; re-exported here for existing call sites/tests.
export { CLAIM_SPAWN_STALE_MS };
/** Fallback-reset records get transcript reparses inside this post-detection window. */
const FALLBACK_REPARSE_MIN_MS = 60_000;
const FALLBACK_REPARSE_MAX_MS = 600_000;

// ---------------------------------------------------------------------------
// Injectable deps (tests exercise wakerTick directly with fakes)
// ---------------------------------------------------------------------------

export interface WakerSpawnResult {
  pid: number | null;
  error?: string;
}

export interface WakerDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  spawnChild(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): WakerSpawnResult;
  detectClaude(): string | null;
  notify(message: string, title?: string): void;
  /** Is `pid` alive AND carrying EVERY marker in its argv? (probeChild === "match") */
  isChildAlive(pid: number, markers: readonly string[]): boolean;
  /**
   * Tri-state identity probe. "match" = our child; "absent" = confirmed gone
   * (dead or PID reused); "unknown" = the pid EXISTS but argv inspection
   * failed -- supervision must treat it as possibly-alive, never as dead.
   */
  probeChild(pid: number, markers: readonly string[]): "match" | "absent" | "unknown";
  /** Identity-verified signal: only fires when `pid` carries EVERY marker. */
  signalChild(pid: number | null | undefined, markers: readonly string[], signal?: NodeJS.Signals): boolean;
}

export function defaultWakerDeps(): WakerDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    spawnChild: (cmd, args, opts) => {
      try {
        const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
        return { pid: child.pid ?? null };
      } catch (err) {
        return { pid: null, error: err instanceof Error ? err.message : String(err) };
      }
    },
    detectClaude: detectClaudeVersion,
    notify: (message, title) => {
      sendDesktopNotification(message, title);
    },
    isChildAlive: (pid, markers) => probeArgvSignature(pid, markers) === "match",
    probeChild: (pid, markers) => probeArgvSignature(pid, markers),
    signalChild: (pid, markers, signal) => signalWakeChild(pid, markers, signal),
  };
}


// ---------------------------------------------------------------------------
// Session snapshot (lenient raw read; corrupt != absent)
// ---------------------------------------------------------------------------

interface WakeSessionSnapshot extends SessionLimitSnapshot {
  resumeBlocked: boolean;
  revision: number | string | null;
}

/** null = definitively absent (project or session gone); undefined = unreadable, leave alone. */
export function readSessionSnapshot(projectRoot: string, storybloqSessionId: string): WakeSessionSnapshot | null | undefined {
  const statePath = join(projectRoot, ".story", "sessions", storybloqSessionId, "state.json");
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
  try {
    const s = JSON.parse(raw) as Record<string, unknown>;
    return {
      state: typeof s.state === "string" ? s.state : "",
      compactPending: s.compactPending === true,
      interruptionKind: s.interruptionKind === "limit" ? "limit" : s.interruptionKind === "compact" ? "compact" : null,
      limitEventId: typeof s.limitEventId === "string" ? s.limitEventId : null,
      resumeBlocked: s.resumeBlocked === true,
      revision: typeof s.revision === "number" || typeof s.revision === "string" ? s.revision : null,
    };
  } catch {
    return undefined;
  }
}

function sessionStillPending(rec: LimitRecord, snap: WakeSessionSnapshot | null | undefined): boolean {
  return snap != null && snap.compactPending && snap.interruptionKind === "limit" && snap.limitEventId === rec.limitEventId;
}

function transcriptSize(path: string | null): number | null {
  if (!path) return null;
  try {
    return fs.statSync(path).size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Notifications (all texts in one place; gated per-project by config.notify)
// ---------------------------------------------------------------------------

function projectLabel(rec: LimitRecord): string {
  return basename(rec.projectRoot) || rec.projectRoot;
}

function notifyMoment(
  deps: WakerDeps,
  cfg: LimitResumeConfig,
  rec: LimitRecord,
  moment:
    | "plain-reset"
    | "finalize-reset"
    | "bypass-not-opted-in"
    | "alive-blocked"
    | "alive-blocked-manual"
    | "telemetry-unreadable"
    | "telemetry-unreadable-manual"
    | "approvals-blocked"
    | "resume-blocked"
    | "claude-missing"
    | "gave-up"
    | "resumed"
    | "cancellation-blocked"
    | "defer-exhausted",
  extra?: string,
): void {
  if (!cfg.notify) return;
  const proj = projectLabel(rec);
  const resumeCmd = `claude --resume ${rec.clientTaskId}`;
  const texts: Record<typeof moment, string> = {
    "plain-reset": `Usage limit reset -- session in ${proj} ready: ${resumeCmd}${extra ?? ""}`,
    "finalize-reset": `Usage limit reset -- session in ${proj} stopped mid-finalize. Verify commit state (git log) first, then: storybloq session clear-compact ${rec.storybloqSessionId ?? ""} --force`,
    "bypass-not-opted-in": `Session in ${proj} is ready but ran with bypassed permissions. Set limitResume.inheritBypass in .story/config.json to wake it automatically, or resume manually: ${resumeCmd}`,
    "alive-blocked": `Usage limit reset, but the session in ${proj} is still open in a terminal at the limit banner. Continue there, or close it -- auto-resume will retry.`,
    "alive-blocked-manual": `Session in ${proj} is still open in a terminal well past its limit reset. Continue there, or close it and run: storybloq limit-status --requeue ${rec.key}`,
    // Names the TELEMETRY fault and never claims a live terminal: the whole
    // point of the fail-closed arm is that we could not read the evidence.
    "telemetry-unreadable": `Usage limit reset, but the owner heartbeat for the session in ${proj} could not be read (${extra ?? "unknown"}). Not auto-resuming while ownership is unverifiable. Check it is not still running, then resume manually: ${resumeCmd}`,
    "telemetry-unreadable-manual": `The owner heartbeat for the session in ${proj} has been unreadable (${extra ?? "unknown"}) well past its limit reset. Confirm nothing is still driving it, then: ${resumeCmd} -- or requeue with: storybloq limit-status --requeue ${rec.key}`,
    "approvals-blocked": `Auto-resume of the session in ${proj} exited without progress (likely waiting on approvals). Open it: ${resumeCmd}`,
    "resume-blocked": `Auto-resume of the session in ${proj} was blocked -- check git state, then resume manually: ${resumeCmd}`,
    "claude-missing": `Usage limit reset but the claude CLI was not found on PATH. Resume manually: ${resumeCmd}`,
    "gave-up": `Gave up auto-resuming the session in ${proj} after ${rec.wakeAttempts} attempts. Resume manually: ${resumeCmd}`,
    resumed: `Auto-resumed the session in ${proj} after its usage limit reset.`,
    "cancellation-blocked": `Could not stop the auto-resume child for ${proj} (pid ${extra ?? rec.attempt?.childPid ?? "?"}). It stays tracked; terminate it manually if needed.`,
    // ISS-944: distinct from "gave-up", which names rec.wakeAttempts -- this
    // fires from preSpawnDeferCount, which counts consecutive pre-spawn
    // defers SINCE THE LAST REAL SPAWN (recordAttemptSpawn resets it), not
    // since record creation. wakeAttempts can be positive here if an earlier
    // spawn happened before this run of pre-spawn defers began.
    "defer-exhausted": `Gave up auto-resuming the session in ${proj} after ${extra ?? "several"} deferred attempts with no spawn since. Resume manually: ${resumeCmd}`,
  };
  deps.notify(texts[moment]);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const WAKE_PROMPT_AUTONOMOUS = (storybloqSessionId: string, attemptId: string): string =>
  `Your usage limit reset. Continue the autonomous session: call storybloq_autonomous_guide with {"sessionId": "${storybloqSessionId}", "action": "resume", "clientTaskId": "<your current session id>"}. The workspace may have changed while stopped -- the guide validates git state. ${wakeAttemptSentinel(attemptId)}`;

const WAKE_PROMPT_PLAIN = (attemptId: string): string =>
  `Your usage limit has reset. Continue the previous task from where it stopped. ${wakeAttemptSentinel(attemptId)}`;

function postureArgs(limitPermissionMode: string | null | undefined, cfg: LimitResumeConfig): string[] | "bypass_not_opted_in" {
  switch (limitPermissionMode) {
    case "bypassPermissions":
      return cfg.inheritBypass ? ["--dangerously-skip-permissions"] : "bypass_not_opted_in";
    case "acceptEdits":
      return ["--permission-mode", "acceptEdits"];
    case "plan":
      // Posture is preserved, never widened: a plan-mode session wakes in
      // plan mode (it will stall on writes -> deferred + notify, which is the
      // safe outcome), not in default mode.
      return ["--permission-mode", "plan"];
    default:
      // default/null: no flag -- inherits persisted project allowlists.
      return [];
  }
}

interface DispatchOutcome {
  spawned: boolean;
}

async function dispatchClaimed(
  rec: LimitRecord,
  attempt: { id: string; token: string },
  cfg: LimitResumeConfig,
  deps: WakerDeps,
): Promise<DispatchOutcome> {
  const now = deps.now();
  // ISS-944: this wrapper covers dispatchClaimed's four PRE-SPAWN sites --
  // the CURRENT claimed attempt has not spawned yet; this wrapper runs before
  // recordAttemptSpawn for it. (The record's wakeAttempts can already be
  // positive from an earlier attempt in the same episode; this makes no
  // episode-wide claim about it.) Always asserts preSpawnDefer: true so a
  // "deferred" outcome is eligible for the preSpawnDeferCount cap; harmless
  // for every other status, which the cap check ignores.
  const settle = (
    status: "resumed" | "deferred" | "failed" | "manual" | "stopped",
    reasonCode?: LimitReasonCode | null,
    lastError?: string | null,
  ): SettleResult | null =>
    settleAttempt(rec.key, attempt.id, { status, reasonCode: reasonCode ?? null, lastError, preSpawnDefer: true }, now);

  if (!fs.existsSync(join(rec.projectRoot, ".story"))) {
    settle("failed", "project_gone");
    return { spawned: false };
  }

  if (deps.detectClaude() === null) {
    const deferResult = settle("deferred");
    if (deferResult?.reasonCode === "defer_exhausted") {
      notifyMoment(deps, cfg, rec, "defer-exhausted", String(deferResult.preSpawnDeferCount));
    } else if (rec.deferCount === 0) {
      notifyMoment(deps, cfg, rec, "claude-missing");
    }
    return { spawned: false };
  }

  let args: string[];
  let env: NodeJS.ProcessEnv = { ...process.env };
  let cwd = rec.projectRoot;
  let sessionDir: string | null = null;
  let spawnBaselineRevision: number | string | null = null;

  if (rec.sessionType === "autonomous" && rec.storybloqSessionId) {
    const session = findSessionById(rec.projectRoot, rec.storybloqSessionId);
    const state = session?.state;
    const stillPending =
      state != null &&
      state.status === "active" &&
      state.state === "COMPACT" &&
      state.compactPending === true &&
      state.interruptionKind === "limit" &&
      state.limitEventId === rec.limitEventId;
    if (!session || !stillPending) {
      // User resumed manually (or the episode ended some other way).
      settle("resumed");
      return { spawned: false };
    }
    sessionDir = session.dir;

    // A live client still owns this session: never spawn a second resume and
    // never terminate the user's interactive client.
    //
    // T-450 step 7b.4: read the OWNER's heartbeat, not the legacy directory.
    // After an owner-gone takeover the session is bound to a generation and the
    // legacy directory holds the DEAD owner's leftovers, so the legacy accessor
    // judges the live REPLACEMENT owner absent and spawns a second driver.
    const heartbeat = readOwnerHeartbeat(session.dir, state as { heartbeatGeneration?: unknown });
    if (heartbeat.kind === "unusable") {
      // FAIL CLOSED. A read fault is not evidence of absence, and the two
      // outcomes are not symmetric: a resume we decline to spawn is
      // recoverable, a duplicate driver is not.
      //
      // Its OWN reason and notification, deliberately, rather than reusing the
      // live-client branch: that branch tells the operator the session is
      // "still open in a terminal", which would be an assertion of liveness
      // made from evidence that could not be read.
      if (now > rec.resetAt + BLOCKED_GRACE_MS) {
        notifyMoment(deps, cfg, rec, "telemetry-unreadable-manual", heartbeat.reason);
        settle("manual", "telemetry_unreadable");
      } else {
        const deferResult = settle("deferred");
        if (deferResult?.reasonCode === "defer_exhausted") {
          notifyMoment(deps, cfg, rec, "defer-exhausted", String(deferResult.preSpawnDeferCount));
        } else if (rec.deferCount === 0) {
          notifyMoment(deps, cfg, rec, "telemetry-unreadable", heartbeat.reason);
        }
      }
      return { spawned: false };
    }
    const aliveAt = heartbeat.kind === "alive" ? heartbeat.at : null;
    if (aliveAt != null && now - aliveAt < ALIVE_FRESH_MS) {
      if (now > rec.resetAt + BLOCKED_GRACE_MS) {
        notifyMoment(deps, cfg, rec, "alive-blocked-manual");
        settle("manual", "blocked_client");
      } else {
        const deferResult = settle("deferred");
        if (deferResult?.reasonCode === "defer_exhausted") {
          notifyMoment(deps, cfg, rec, "defer-exhausted", String(deferResult.preSpawnDeferCount));
        } else if (rec.deferCount === 0) {
          notifyMoment(deps, cfg, rec, "alive-blocked");
        }
      }
      return { spawned: false };
    }

    // Posture authority is session state (written under the session lock),
    // never the ledger. Bypass wakes require the per-project opt-in.
    const posture = postureArgs(state.limitPermissionMode, cfg);
    if (posture === "bypass_not_opted_in") {
      notifyMoment(deps, cfg, rec, "bypass-not-opted-in");
      settle("manual", "bypass_not_opted_in");
      return { spawned: false };
    }

    args = ["-p", "--resume", rec.clientTaskId, WAKE_PROMPT_AUTONOMOUS(rec.storybloqSessionId, attempt.id), ...posture];
    env = { ...process.env, [WAKE_ATTEMPT_ENV]: `${attempt.id}.${attempt.token}` };
    spawnBaselineRevision = state.revision ?? null;

    // Wake claim: recheck-and-claim under the per-session claim lock so a
    // concurrent interactive reopen cannot race the spawn window.
    let claimed = false;
    try {
      claimed = withLimitLock(wakeClaimLockPath(session.dir), () => {
        const fresh = readLimitLedger().records[rec.key];
        if (!fresh || fresh.status !== "resuming" || fresh.attempt?.id !== attempt.id) return false;
        const recheck = readSessionSnapshot(rec.projectRoot, rec.storybloqSessionId!);
        if (!sessionStillPending(rec, recheck)) return false;
        return writeWakeClaim(session.dir, {
          attemptId: attempt.id,
          token: attempt.token,
          generation: rec.generation,
          childPid: null,
          createdAt: now,
        });
      }, { deadlineMs: 1_000 });
    } catch {
      claimed = false;
    }
    if (!claimed) {
      // Interactive reopen (or supersede) won the race; requeue quietly.
      settle("stopped");
      return { spawned: false };
    }
  } else {
    // Plain headless (per-project opt-in). No session state and no posture
    // escalation ever; no per-session wake claim exists (there is no
    // SessionStart interplay), but the attempt env token + argv sentinel are
    // still set so the child is deterministically identifiable.
    args = ["-p", "--resume", rec.clientTaskId, WAKE_PROMPT_PLAIN(attempt.id)];
    env = { ...process.env, [WAKE_ATTEMPT_ENV]: `${attempt.id}.${attempt.token}` };
    cwd = fs.existsSync(rec.cwd) ? rec.cwd : rec.projectRoot;
  }

  const spawnResult = deps.spawnChild("claude", args, { cwd, env });
  if (spawnResult.pid === null) {
    if (sessionDir) clearWakeClaim(sessionDir);
    const deferResult = settle("deferred", null, spawnResult.error ?? "spawn failed");
    if (deferResult?.reasonCode === "defer_exhausted") {
      notifyMoment(deps, cfg, rec, "defer-exhausted", String(deferResult.preSpawnDeferCount));
    }
    return { spawned: false };
  }

  const recorded = recordAttemptSpawn(
    rec.key,
    attempt.id,
    { childPid: spawnResult.pid, transcriptOffset: transcriptSize(rec.transcriptPath), stateRevision: spawnBaselineRevision },
    now,
  );
  if (!recorded) {
    // The record moved between claim and spawn (interactive takeover, re-limit
    // generation, cancellation), so the resuming-attempt path no longer tracks
    // this child. Persist its real PID FIRST -- onto the lingering attempt
    // (status/generation-agnostic) so the owning flow (superviseAttempt's
    // superseded/dispatchable branches, or finishCancel) confirm-terminates and
    // clears it, and into the wake claim for autonomous records. The ledger
    // attach is the ONLY durable tracking a PLAIN record has (it carries no
    // per-session claim). Then best-effort confirm-terminate now, both for
    // promptness and to prevent a headless child driving the transcript beside
    // an interactive takeover.
    const markers = wakeChildMarkers(rec.clientTaskId, attempt.id);
    attachOrphanChildPid(rec.key, attempt.id, spawnResult.pid, now);
    if (sessionDir) {
      writeWakeClaim(sessionDir, {
        attemptId: attempt.id,
        token: attempt.token,
        generation: rec.generation,
        childPid: spawnResult.pid,
        createdAt: now,
      });
    }
    if (await terminateConfirmed(spawnResult.pid, markers, deps)) {
      // Death CONFIRMED: the lingering attempt PID self-clears on the owning
      // flow's next tick (probe absent -> confirmed -> cleared); drop the claim.
      if (sessionDir) clearWakeClaim(sessionDir);
    } else {
      // Unconfirmed even after SIGKILL (kernel anomaly): LEAVE every durable
      // artifact (attempt PID + wake claim) so the next supervision/
      // cancellation tick retries termination, and surface the orphan.
      notifyMoment(deps, cfg, rec, "cancellation-blocked", String(spawnResult.pid));
    }
    return { spawned: false };
  }
  if (sessionDir) {
    writeWakeClaim(sessionDir, {
      attemptId: attempt.id,
      token: attempt.token,
      generation: rec.generation,
      childPid: spawnResult.pid,
      createdAt: now,
    });
  }
  return { spawned: true };
}

/** Notify-mode records (plain default + FINALIZE stops) settle at reset with a notification. */
async function dispatchNotify(rec: LimitRecord, cfg: LimitResumeConfig, deps: WakerDeps): Promise<void> {
  if (rec.sessionType === "autonomous") {
    // Only finalize_stop autonomous records are notify-mode in v1.
    notifyMoment(deps, cfg, rec, rec.reasonCode === "finalize_stop" ? "finalize-reset" : "plain-reset");
  } else {
    let extra = "";
    try {
      if (rec.gitHead) {
        const { gitHead } = await import("./git-inspector.js");
        const head = await gitHead(rec.projectRoot);
        if (head.ok && head.data.hash !== rec.gitHead) extra = " (workspace has changed since the stop)";
      }
    } catch {
      // Best-effort enrichment only.
    }
    notifyMoment(deps, cfg, rec, "plain-reset", extra);
  }
  markNotified(rec.key, rec.generation, deps.now());
}

// ---------------------------------------------------------------------------
// Supervision (verify is attempt-scoped; stale-generation writes CAS-dropped)
// ---------------------------------------------------------------------------

/**
 * Confirmed termination: SIGTERM -> verify -> SIGKILL -> verify. Returns true
 * only when the child is confirmed ABSENT (dead or PID reused) -- an "unknown"
 * identity probe (pid exists, argv unreadable) is NOT confirmation, so a
 * transient ps failure can never masquerade as a confirmed death. On false the
 * caller must LEAVE the attempt tracked (non-dispatchable evidence) and retry
 * on the next poll -- one unconfirmed signal never orphans a live child.
 */
async function terminateConfirmed(pid: number | null, markers: readonly string[], deps: WakerDeps): Promise<boolean> {
  if (pid == null) return true;
  if (deps.probeChild(pid, markers) === "absent") return true;
  deps.signalChild(pid, markers, "SIGTERM");
  await deps.sleep(500);
  if (deps.probeChild(pid, markers) !== "absent") {
    deps.signalChild(pid, markers, "SIGKILL");
    await deps.sleep(500);
  }
  return deps.probeChild(pid, markers) === "absent";
}

async function superviseAttempt(rec: LimitRecord, cfg: LimitResumeConfig, deps: WakerDeps): Promise<void> {
  const attempt = rec.attempt;
  if (!attempt) return;
  const now = deps.now();
  const markers = wakeChildMarkers(rec.clientTaskId, attempt.id);

  // Claim-to-spawn window: an attempt with no recorded child (childPid null) may
  // still spawn one imminently. terminateConfirmed(null) trivially returns
  // "confirmed dead", so clearing on that basis (below) would drop the evidence
  // of a child that is about to exist and outlive its supervisor. Defer EVERY
  // clear path until the claim is ABANDONED -- the claimant process is confirmed
  // dead (not merely slow or suspended; see claimAbandoned). Only then may the
  // branches below clear it safely.
  if (attempt.childPid == null && !claimAbandoned(attempt, now)) {
    return;
  }

  // A re-limit minted a new generation: terminate the superseded child, and
  // only drop the attempt once its death is CONFIRMED (an ignored SIGTERM must
  // not become an untracked orphan beside the next spawn).
  if (attempt.generation !== rec.generation) {
    if (await terminateConfirmed(attempt.childPid, markers, deps)) {
      clearSupersededAttempt(rec.key, attempt.id, now);
    }
    return;
  }

  // A same-generation attempt lingering on a DISPATCHABLE record (e.g. the
  // interactive deadline reverted to `stopped` with the attempt intact) blocks
  // dispatch until its child's death is confirmed; this is the release valve.
  if (LIMIT_STATUS_META[rec.status as LimitRecordStatus]?.dispatchable) {
    if (await terminateConfirmed(attempt.childPid, markers, deps)) {
      clearConfirmedDeadAttempt(rec.key, attempt.id, now);
    }
    return;
  }

  // An interactive takeover displaced our wake child: the resume-prompt hook
  // async-SIGTERM'd it (hooks never block) and PRESERVED the attempt as
  // evidence of a possibly-live child. Confirm the displaced child is gone and
  // clear the attempt, so the record can terminalize (-> resumed once the user
  // advances the session) or revert (-> stopped at its deadline) without ever
  // orphaning a live process. markResumed and reconcile both refuse to
  // terminalize an interactive record while this attempt stands, so this is the
  // only path that releases it.
  if (rec.status === "interactive") {
    if (await terminateConfirmed(attempt.childPid, markers, deps)) {
      clearInteractiveAttempt(rec.key, attempt.id, now);
    }
    return;
  }

  // Current-generation attempts are only judged while `resuming`; cancelling
  // records own their attempt through their own (finish-cancel) flow.
  if (rec.status !== "resuming") return;
  if (attempt.spawnedAt == null) return; // claimed-but-not-spawned: reconcile's stale window owns it

  // ISS-944 Amendment A: this wrapper covers superviseAttempt's five
  // POST-SPAWN sites (a real spawn already counted -- wakeAttempts >= 1).
  // Never asserts preSpawnDefer, so the preSpawnDeferCount cap cannot fire
  // from any call through this wrapper, structurally -- these sites stay
  // bounded by the existing wakeAttempts/maxAttempts gate. Return type
  // changes from boolean to the discriminated result for consistency across
  // every settleAttempt caller, not because the cap can fire here.
  const settle = (
    status: "resumed" | "deferred" | "failed" | "manual" | "stopped",
    reasonCode?: LimitReasonCode | null,
    lastError?: string | null,
  ): SettleResult | null => settleAttempt(rec.key, attempt.id, { status, reasonCode: reasonCode ?? null, lastError }, now);

  // "unknown" identity (pid exists, argv unreadable) counts as ALIVE for
  // supervision: settling on it would clear a possibly-live child's evidence.
  const childProbe = attempt.childPid != null ? deps.probeChild(attempt.childPid, markers) : "absent";
  const childAlive = childProbe !== "absent";
  const size = transcriptSize(rec.transcriptPath);
  const transcriptGrew = size != null && attempt.transcriptOffset != null && size > attempt.transcriptOffset;

  if (rec.sessionType === "autonomous" && rec.storybloqSessionId) {
    const snap = readSessionSnapshot(rec.projectRoot, rec.storybloqSessionId);
    if (snap === null) {
      // Settle only after CONFIRMED death: a running child does not
      // necessarily exit because its cwd was removed, and settling would
      // drop the only evidence naming it. Unconfirmed -> retry next poll.
      if (await terminateConfirmed(attempt.childPid, markers, deps)) {
        settle("failed", "project_gone");
      }
      return;
    }
    if (snap !== undefined) {
      if (sessionStillPending(rec, snap) && snap.resumeBlocked) {
        // handleResume's git branch rejected the resume. Same rule: confirm
        // the child's death before the terminal settle clears its evidence.
        if (await terminateConfirmed(attempt.childPid, markers, deps)) {
          if (settle("failed", "resume_blocked") !== null) notifyMoment(deps, cfg, rec, "resume-blocked");
        }
        return;
      }
      if (!sessionStillPending(rec, snap)) {
        // The session moved on -- the wake worked (or the user beat us to it).
        // The child IS the resumed session; leave it running.
        if (settle("resumed") !== null) notifyMoment(deps, cfg, rec, "resumed");
        return;
      }
      // Still pending: state-revision movement counts as progress.
      const revisionMoved = snap.revision != null && attempt.stateRevision != null && snap.revision !== attempt.stateRevision;
      if (revisionMoved || transcriptGrew) {
        touchAttemptProgress(rec.key, attempt.id, now, {
          ...(transcriptGrew ? { transcriptOffset: size } : {}),
          ...(revisionMoved ? { stateRevision: snap.revision } : {}),
        });
      }
    }
  } else if (transcriptGrew) {
    if (childAlive) {
      touchAttemptProgress(rec.key, attempt.id, now, { transcriptOffset: size });
    } else {
      // Plain verify: byte growth alone is WEAK evidence (an interactive
      // writer, malformed partial data, or an unrelated entry can grow the
      // file). A fresh rate_limit entry newer than the spawn means the wake
      // immediately re-limited (the re-fired StopFailure hook mints the new
      // generation; this settle would CAS-drop against it, but classify anyway
      // in case the hook was missed): defer, never terminalize as success.
      const freshLimit = (() => {
        try {
          const entry = scanTranscriptTailForLimit(rec.transcriptPath, undefined, { sessionId: rec.clientTaskId });
          return entry?.timestampMs != null && attempt.spawnedAt != null && entry.timestampMs >= attempt.spawnedAt;
        } catch {
          return false;
        }
      })();
      if (freshLimit) {
        settle("deferred", null, "re-limited during wake");
        return;
      }
      // Require POSITIVE structured evidence: a session-attributed turn newer
      // than the spawn. Otherwise the growth is not proof the wake turn ran.
      const turnLanded = attempt.spawnedAt != null &&
        transcriptHasTurnAfter(rec.transcriptPath, attempt.spawnedAt, { sessionId: rec.clientTaskId });
      if (turnLanded) {
        if (settle("resumed") !== null) notifyMoment(deps, cfg, rec, "resumed");
      } else if (settle("deferred", null, "wake produced no attributable turn") !== null) {
        notifyMoment(deps, cfg, rec, "approvals-blocked");
      }
      return;
    }
  }

  if (!childAlive) {
    if (now - attempt.spawnedAt < SPAWN_SETTLE_GRACE_MS) return; // judge on the next poll
    // Child exited with the session still parked / no transcript movement:
    // approvals denied or posture too restrictive.
    if (settle("deferred", null, "wake child exited without progress") !== null) {
      notifyMoment(deps, cfg, rec, "approvals-blocked");
    }
    return;
  }

  const lastProgressAt = attempt.lastProgressAt ?? attempt.spawnedAt;
  if (cfg.childInactivityMs > 0 && now - lastProgressAt > cfg.childInactivityMs) {
    // Settle only on CONFIRMED death; an unkillable child stays tracked as the
    // live attempt (non-dispatchable) and termination retries next poll.
    if (await terminateConfirmed(attempt.childPid, markers, deps)) {
      settle("deferred", null, "child inactive past childInactivityMs");
    }
    return;
  }
  if (now - attempt.spawnedAt > ATTEMPT_SAFETY_CAP_MS) {
    if (await terminateConfirmed(attempt.childPid, markers, deps)) {
      settle("deferred", null, "24h safety cap");
    }
  }
}

// ---------------------------------------------------------------------------
// Cancellation completion (crash-safe half of the two-phase cancel)
// ---------------------------------------------------------------------------

async function finishCancel(action: ReconcileAction, deps: WakerDeps): Promise<void> {
  const rec = readLimitLedger().records[action.key];
  if (!rec) return;
  // `manual`/cancellation_blocked = an earlier cancel whose child could not be
  // terminated; reconciliation routes it back here to retry until confirmed.
  const blockedCancel = rec.status === "manual" && rec.reasonCode === "cancellation_blocked";
  if (rec.status !== "cancelling" && !blockedCancel) return;

  const attempt = rec.attempt;
  if (attempt) {
    if (attempt.childPid == null) {
      // Claim-to-spawn window: a child may materialize any moment while the
      // CLAIMANT is alive (possibly suspended) -- its recordAttemptSpawn CAS
      // then fails against `cancelling` and it terminates its own child.
      // Completing now could clear session state just before that spawn. Stay
      // `cancelling` until the claim is ABANDONED (claimant CONFIRMED dead, so
      // no child will ever exist -- not merely aged out; see claimAbandoned).
      if (!claimAbandoned(attempt, deps.now())) return;
      // Abandoned: no child was ever spawned, so its death is trivially
      // confirmed. Clear the attempt through the cancel-flow path so the
      // completion below can proceed.
      clearCancellingAttempt(action.key, attempt.id, deps.now());
    } else {
      const markers = wakeChildMarkers(rec.clientTaskId, attempt.id);
      if (!(await terminateConfirmed(attempt.childPid, markers, deps))) {
        // Unkillable child: stand down, PRESERVE interruption state (never
        // clear a session under a live child), keep the attempt as evidence.
        if (blockCancellation(action.key, deps.now())) {
          notifyMoment(deps, readLimitResumeConfig(rec.projectRoot), rec, "cancellation-blocked");
        }
        return;
      }
      // Death CONFIRMED: only now may the possibly-live-child evidence be
      // dropped. completeCancellation refuses while the attempt remains.
      clearCancellingAttempt(action.key, attempt.id, deps.now());
    }
  }

  if (rec.sessionType === "autonomous" && rec.storybloqSessionId) {
    try {
      await withSessionLock(rec.projectRoot, async () => {
        const session = findSessionById(rec.projectRoot, rec.storybloqSessionId!);
        if (session && session.state.interruptionKind === "limit" && session.state.limitEventId === rec.limitEventId) {
          // Downgrade to an ordinary compact park (resumable), never
          // clearInterruption (which strands it COMPACT-but-not-pending).
          downgradeLimitParkToCompact(session.dir, session.state);
        }
        if (session) clearWakeClaim(session.dir);
      });
    } catch {
      return; // session lock unavailable: retry on the next poll
    }
  }
  // Generation-fenced: `rec` was read at the top of this call. If a re-limit
  // superseded this episode (new generation) and the user cancelled THAT one to
  // an attempt-less `cancelling` state in the meantime, completing without the
  // fence would wrongly terminalize the newer cancellation before its own child
  // death is confirmed. On a generation mismatch completeCancellation refuses
  // and this stale finisher becomes a no-op.
  completeCancellation(action.key, deps.now(), rec.generation);
}

// ---------------------------------------------------------------------------
// Fallback reparse (upgrade a 5h guess to real banner evidence)
// ---------------------------------------------------------------------------

function tryUpgradeFallbackReset(rec: LimitRecord, cfg: LimitResumeConfig, deps: WakerDeps): void {
  if (rec.resetSource !== "fallback" || rec.attempt || !rec.transcriptPath) return;
  const now = deps.now();
  if (rec.nextAttemptAt <= now) return; // already due; no point rescheduling
  // Bounded window: the banner may land in the transcript shortly after the
  // hook fired. Retries are cheap tail-reads; the generation-CAS upgrade makes
  // the first success final (resetSource leaves "fallback").
  const age = now - rec.detectedAt;
  if (age < FALLBACK_REPARSE_MIN_MS || age > FALLBACK_REPARSE_MAX_MS) return;

  try {
    const banner = scanTranscriptTailForLimit(rec.transcriptPath, undefined, {
      sessionId: rec.clientTaskId,
    });
    if (!banner) return;
    const resolved = resolveResetAt(banner.bannerText, { fallbackMs: cfg.fallbackResetMs, now: new Date(now) });
    if (resolved.source === "fallback") return;
    upgradeResetTime(rec.key, rec.generation, {
      resetAt: resolved.at,
      resetSource: resolved.source,
      rawBanner: banner.bannerText,
      limitType: banner.limitType,
    }, now);
  } catch {
    // Best-effort only.
  }
}

// ---------------------------------------------------------------------------
// The tick (one poll iteration; fully injectable for tests)
// ---------------------------------------------------------------------------

export interface TickResult {
  spawnedKeys: string[];
  notifiedKeys: string[];
  /** Non-terminal records left after this tick (0 => the waker may exit). */
  remaining: number;
}

export async function wakerTick(deps: WakerDeps = defaultWakerDeps()): Promise<TickResult> {
  const now = deps.now();
  const spawnedKeys: string[] = [];
  const notifiedKeys: string[] = [];

  // 1. Supervise active attempts FIRST (attempt-scoped evidence carries the
  //    user-facing notifications; reconcile's moved-on sweep is silent and
  //    would otherwise always win the race) + fallback reparse.
  let ledger = readLimitLedger();
  for (const rec of Object.values(ledger.records)) {
    const cfg = readLimitResumeConfig(rec.projectRoot);
    if (rec.attempt) await superviseAttempt(rec, cfg, deps);
    else if (rec.status === "stopped" || rec.status === "deferred") tryUpgradeFallbackReset(rec, cfg, deps);
  }

  // 2. Cross-store reconciliation (intent activation/discard, silent moved-on
  //    detection, stale-attempt reclaim, interactive deadline, prune).
  const { actions } = reconcileLimitLedger({
    now,
    readSession: (root, sid) => readSessionSnapshot(root, sid),
    // Preserve the tri-state: match -> true, absent -> false, "unknown" (pid
    // exists, argv unreadable) -> undefined. Reconcile only reclaims/terminalizes
    // an attempt on an EXPLICIT false; undefined keeps a possibly-live child
    // tracked, so a transient ps failure never abandons or double-spawns it.
    isAttemptChildAlive: (attempt: LimitAttempt, rec: LimitRecord): boolean | undefined => {
      if (attempt.childPid == null) return false;
      const probe = deps.probeChild(attempt.childPid, wakeChildMarkers(rec.clientTaskId, attempt.id));
      return probe === "match" ? true : probe === "absent" ? false : undefined;
    },
  });

  // 3. Complete crashed/pending cancellations and confirm project-gone
  //    children before their records terminalize.
  for (const action of actions) {
    if (action.type === "finish-cancel") await finishCancel(action, deps);
    else if (action.type === "terminate-project-gone") {
      const rec = readLimitLedger().records[action.key];
      if (rec?.attempt?.id === action.attempt.id) {
        const markers = wakeChildMarkers(rec.clientTaskId, action.attempt.id);
        if (await terminateConfirmed(action.attempt.childPid, markers, deps)) {
          failProjectGoneConfirmed(action.key, action.attempt.id, action.generation, deps.now());
        }
      }
    }
  }

  // 4. Dispatch due records (per-record config recheck; maxConcurrent counts
  //    LIVE children PER PROJECT -- the knob is per-project config, and a
  //    global count would let two busy projects starve every other project's
  //    queue; stagger between spawns).
  ledger = readLimitLedger();
  const liveChildrenByProject = new Map<string, number>();
  for (const rec of Object.values(ledger.records)) {
    // Count EVERY tracked child whose death is not confirmed, regardless of the
    // record's status -- a live child occupies a slot whether the record calls
    // itself resuming, cancelling, interactive, or manual-blocked (all can name
    // a running wake child). Under-counting here lets a second child spawn
    // beside an existing one and exceed maxConcurrent.
    const attempt = rec.attempt;
    if (!attempt) continue;
    let occupies: boolean;
    if (attempt.childPid == null) {
      // A live claim (childPid still null) will spawn imminently; hold a slot
      // until it is ABANDONED (claimant confirmed dead), else a second child
      // spawns beside the one about to exist. A suspended claimant still counts.
      occupies = !claimAbandoned(attempt, now);
    } else {
      // A concrete pid holds a slot unless its death is CONFIRMED ("absent").
      // "unknown" (pid exists, argv unreadable) is possibly-live and must count.
      occupies = deps.probeChild(attempt.childPid, wakeChildMarkers(rec.clientTaskId, attempt.id)) !== "absent";
    }
    if (occupies) {
      liveChildrenByProject.set(rec.projectRoot, (liveChildrenByProject.get(rec.projectRoot) ?? 0) + 1);
    }
  }

  const due = selectDueRecords(ledger, now, Number.MAX_SAFE_INTEGER);
  for (const rec of due) {
    if (isLimitResumeGloballyDisabled()) break;
    const cfg = readLimitResumeConfig(rec.projectRoot);
    if (!cfg.enabled) continue;

    // Notify-mode delivery is NOT a wake launch: it dispatches before the
    // attempt-cap check so maxAttempts (including a valid 0 = "never
    // headless-wake") only ever bounds child spawns, not notifications.
    if (rec.mode === "notify") {
      await dispatchNotify(rec, cfg, deps);
      notifiedKeys.push(rec.key);
      continue;
    }

    if (rec.wakeAttempts >= cfg.maxAttempts) {
      if (failRecord(rec.key, rec.generation, "attempts_exhausted", null, now)) {
        notifyMoment(deps, cfg, rec, "gave-up");
      }
      continue;
    }

    if ((liveChildrenByProject.get(rec.projectRoot) ?? 0) >= cfg.maxConcurrent) continue;

    const attempt = { id: `wa-${now.toString(36)}-${randomBytes(4).toString("hex")}`, token: randomBytes(16).toString("hex") };
    if (!claimAttempt(rec.key, { ...attempt, generation: rec.generation }, now)) continue;

    const outcome = await dispatchClaimed(rec, attempt, cfg, deps);
    if (outcome.spawned) {
      liveChildrenByProject.set(rec.projectRoot, (liveChildrenByProject.get(rec.projectRoot) ?? 0) + 1);
      spawnedKeys.push(rec.key);
      const moreDue = due.indexOf(rec) < due.length - 1;
      if (moreDue && cfg.staggerMs > 0) await deps.sleep(cfg.staggerMs);
    }
  }

  // "Remaining" counts ACTIONABLE records only: inert manual stand-downs wait
  // for the user (up to 30d retention) and must not keep the transient waker
  // polling like a daemon -- a later --requeue respawns it via housekeeping.
  const remaining = Object.values(readLimitLedger().records).filter(isWakerActionable).length;
  return { spawnedKeys, notifiedKeys, remaining };
}

// ---------------------------------------------------------------------------
// The waker process (singleton loop) + opportunistic respawn
// ---------------------------------------------------------------------------

export interface RunWakerOptions {
  /** Test bound on loop iterations. */
  maxTicks?: number;
  pollMs?: number;
}

export async function runWaker(deps: WakerDeps = defaultWakerDeps(), opts: RunWakerOptions = {}): Promise<void> {
  const pollMs = opts.pollMs ?? WAKER_POLL_MS;
  // Singleton: a live identity-verified holder is never stolen; a dead one is
  // stolen immediately (see limit-lock steal policy).
  const handle = acquireLimitLock(wakerLockPath(), { deadlineMs: 1_500, leaseMs: WAKER_LOCK_LEASE_MS });
  if (!handle) return;
  try {
    let ticks = 0;
    for (;;) {
      if (isLimitResumeGloballyDisabled()) break;
      // Lost singleton ownership (lease stolen after a long stall): a
      // successor waker owns the queue now -- exit instead of running beside it.
      if (!renewLimitLock(handle)) break;
      const result = await wakerTick(deps);
      ticks += 1;
      if (result.remaining === 0) break; // transient by design
      if (opts.maxTicks != null && ticks >= opts.maxTicks) break;
      await deps.sleep(pollMs);
    }
  } finally {
    releaseLimitLock(handle);
  }
}

/** Is a live, identity-verified waker already running? Lockless read. */
export function isWakerAlive(): boolean {
  let fd: number | null = null;
  try {
    // Bounded, no-follow read of the global waker.lock: a corrupt or swapped
    // path (huge file, symlink to one) must never make this opportunistic
    // liveness check on the housekeeping path allocate unbounded memory or
    // follow a symlink out of the trusted dir.
    fd = fs.openSync(wakerLockPath(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size <= 0 || st.size > 4_096) return false;
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (uid >= 0 && st.uid !== uid) return false;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    const body = JSON.parse(buf.subarray(0, read).toString("utf-8")) as { pid?: number; processSignature?: string | null };
    if (typeof body.pid !== "number" || body.pid <= 0) return false;
    if (!hasArgvSignature(body.pid, [WAKER_ARGV_SENTINEL])) return false;
    return inspectProcessIdentitySync(body.pid, body.processSignature ?? null) !== "dead";
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Opportunistic respawn -- the reboot/crash recovery story. Called from the
 * StopFailure handler, CLI housekeeping, and hook handlers. Cheap: a lockless
 * ledger probe + one lock-file read; spawns a detached `waker-run` only when
 * non-terminal records exist with no live waker.
 */
export function spawnWakerIfNeeded(): boolean {
  try {
    // Escape hatch for tests/E2E sims (and emergencies): suppress the
    // automatic detached spawn without disabling the feature itself.
    if (process.env.STORYBLOQ_DISABLE_WAKER_SPAWN === "1") return false;
    if (isLimitResumeGloballyDisabled()) return false;
    if (!hasPendingLimitRecords()) return false;
    if (isWakerAlive()) return false;
    const bin = process.argv[1];
    if (!bin) return false;
    const child = spawn(process.execPath, [bin, "waker-run", WAKER_ARGV_SENTINEL], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
