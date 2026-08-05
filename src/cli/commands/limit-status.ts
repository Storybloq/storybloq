/**
 * T-424: `storybloq limit-status` -- the human surface for pending limit
 * auto-resumes across ALL projects (the ledger is global).
 *
 *   storybloq limit-status                 list non-terminal records
 *   storybloq limit-status --cancel <key>  two-phase cancel of an auto-resume
 *   storybloq limit-status --requeue <key> return a manual/failed record to the queue
 *
 * <key> accepts the full ledger key ("claude:<session-id>") or the bare
 * client session id.
 */

import {
  listLimitStops,
  readLimitLedger,
  limitRecordKey,
  beginCancellation,
  completeCancellation,
  clearCancellingAttempt,
  blockCancellation,
  requeueRecord,
  claimAbandoned,
  type LimitStopSummary,
} from "../../core/limit-ledger.js";
import { signalWakeChild, clearWakeClaim, wakeChildMarkers } from "../../autonomous/wake-claim.js";
import { findSessionById, withSessionLock, downgradeLimitParkToCompact } from "../../autonomous/session.js";
import { probeArgvSignature } from "../../autonomous/liveness.js";

/** Confirmed termination for the CLI cancel path: SIGTERM -> verify -> SIGKILL -> verify, identity-checked. */
async function terminateChildConfirmed(pid: number, markers: readonly string[]): Promise<boolean> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  if (probeArgvSignature(pid, markers) === "absent") return true;
  signalWakeChild(pid, markers, "SIGTERM");
  await sleep(500);
  if (probeArgvSignature(pid, markers) !== "absent") {
    signalWakeChild(pid, markers, "SIGKILL");
    await sleep(500);
  }
  return probeArgvSignature(pid, markers) === "absent";
}

export interface LimitStatusOptions {
  cancel?: string;
  requeue?: string;
  format?: "json" | "md";
  /** ISS-944: include terminal records (defer_exhausted, attempts_exhausted, etc.) without needing the key. */
  recent?: boolean;
}

export interface LimitStatusResult {
  output: string;
  errorCode?: string;
}

function normalizeKey(input: string): string {
  return input.includes(":") ? input : limitRecordKey(input);
}

function formatList(stops: LimitStopSummary[], format: "json" | "md"): string {
  if (format === "json") {
    return JSON.stringify({ ok: true, data: { limitStops: stops } }, null, 2);
  }
  if (stops.length === 0) {
    return "No pending limit auto-resumes.";
  }
  const lines = ["# Limit auto-resume queue", ""];
  for (const s of stops) {
    const when = new Date(s.nextAttemptAt).toLocaleString();
    const reason = s.reasonCode ? ` [${s.reasonCode}]` : "";
    // Action text follows STATUS, not just mode: a manual record is stood
    // down (nothing is scheduled) and cancelling/preparing are transitions.
    const action = s.status === "manual"
      ? (s.reasonCode === "cancellation_blocked"
          ? "cancellation blocked on a live wake child"
          : `stood down -- requeue: storybloq limit-status --requeue ${s.key}`)
      : s.status === "cancelling"
        ? "cancellation in progress"
        : s.status === "preparing"
          ? "detection in progress"
          : s.status === "resuming"
            ? "auto-resume in progress"
            : s.status === "interactive"
              ? "interactive resume in progress"
              // ISS-944: --recent surfaces terminal records too; they are not
              // scheduled for anything further. Only "failed" is requeueable
              // (LIMIT_STATUS_META) -- resumed/notified/cancelled are done.
              : s.status === "failed"
                ? `terminal -- requeue: storybloq limit-status --requeue ${s.key}`
                : s.status === "resumed" || s.status === "notified" || s.status === "cancelled"
                  ? "terminal, episode complete"
                  // Only stopped/deferred are actually SCHEDULED for a future moment.
                  : `${s.mode === "headless" ? "auto-resumes" : "notifies"} ~${when}`;
    lines.push(`- ${s.key}`);
    lines.push(`    ${s.sessionType} session in ${s.projectRoot}`);
    lines.push(
      `    ${s.status}${reason} -- ${s.limitType} limit, ${action}` +
      ` (generation ${s.generation}, attempts ${s.wakeAttempts})`,
    );
  }
  lines.push("", "Cancel: storybloq limit-status --cancel <key> | Requeue: storybloq limit-status --requeue <key>");
  return lines.join("\n");
}

/**
 * Two-phase cancel (mirrors cancelLimitAutoResume in session-compact, but
 * cross-project via the record's own projectRoot): CAS to `cancelling` first
 * so the waker cannot dispatch mid-cancel, terminate any live child, clear the
 * session interruption, then CAS to `cancelled`. A child whose death cannot be
 * confirmed after signal escalation moves the record to `manual` with reason
 * `cancellation_blocked`, PRESERVING the attempt and the session interruption
 * (never cleared under a possibly-live child); reconciliation retries
 * termination on its next poll.
 */
async function cancelRecord(key: string): Promise<LimitStatusResult> {
  const preview = readLimitLedger().records[key];
  if (!preview) {
    return { output: `No limit record found for ${key}.`, errorCode: "not_found" };
  }
  const begun = beginCancellation(key);
  if (begun === null) {
    return { output: `Record ${key} is already terminal (${preview.status}); nothing to cancel.`, errorCode: "invalid_input" };
  }
  // Everything below uses the POST-CAS snapshot: a re-limit generation can
  // land between the preview read and beginCancellation, and clearing session
  // state keyed by the stale limitEventId would leave the new episode's
  // session limit-pending behind a cancelled record.
  const rec = begun.record;

  const attempt = rec.attempt;
  if (attempt) {
    if (attempt.childPid == null && !claimAbandoned(attempt)) {
      // A live claim (childPid still null): the claimant is alive (possibly
      // suspended) and a child may materialize any moment -- its
      // recordAttemptSpawn CAS then fails against `cancelling` and it
      // terminates its own child. This transient case genuinely needs the
      // background waker to finish; best-effort spawn one and have the user
      // retry. The record stays `cancelling`; session state is untouched.
      try {
        const { spawnWakerIfNeeded } = await import("../../autonomous/waker.js");
        spawnWakerIfNeeded();
      } catch {
        // The next CLI invocation respawns the waker.
      }
      return {
        output:
          `Cancellation started for ${key}. A wake attempt is mid-spawn; the background waker stops the ` +
          "child and finishes clearing the parked state. Retry limit-status in a moment.",
      };
    }
    if (attempt.childPid == null) {
      // ABANDONED claim: the claimant process is CONFIRMED dead (not merely
      // slow/suspended), so no child will ever materialize. Drop the attempt
      // through the cancel-flow clear and fall through to the synchronous
      // session downgrade + completion below -- never rely on a waker that the
      // global kill switch may keep from ever starting, which would strand this
      // record in `cancelling` forever.
      clearCancellingAttempt(key, attempt.id);
    } else {
      // A concrete child pid: CONFIRM termination synchronously HERE (SIGTERM ->
      // verify -> SIGKILL -> verify) rather than delegating to a waker that may
      // never start -- the global kill switch makes spawnWakerIfNeeded a no-op,
      // which would otherwise strand this record in `cancelling` forever.
      const markers = wakeChildMarkers(rec.clientTaskId, attempt.id);
      if (!(await terminateChildConfirmed(attempt.childPid, markers))) {
        // Unkillable or identity-unconfirmed child: stand down to a blocked
        // cancellation, PRESERVE the attempt + session state (never clear under
        // a possibly-live child), and let reconciliation retry termination.
        blockCancellation(key);
        try {
          const { spawnWakerIfNeeded } = await import("../../autonomous/waker.js");
          spawnWakerIfNeeded();
        } catch {
          // The next CLI invocation respawns the waker to retry termination.
        }
        return {
          output:
            `Cancellation of ${key} is stood down, but a wake child (pid ${attempt.childPid}) could not be ` +
            "confirmed terminated. The parked session was left intact; check \"storybloq limit-status\" and " +
            "retry once the child exits.",
          errorCode: "invalid_input",
        };
      }
      // Death CONFIRMED: drop the possibly-live-child evidence through the
      // cancel-flow path so the synchronous session downgrade + generation-CAS
      // completion below can terminalize the stand-down.
      clearCancellingAttempt(key, attempt.id);
    }
  }

  if (rec.sessionType === "autonomous" && rec.storybloqSessionId) {
    try {
      await withSessionLock(rec.projectRoot, async () => {
        const session = findSessionById(rec.projectRoot, rec.storybloqSessionId!);
        if (session && session.state.interruptionKind === "limit" && session.state.limitEventId === rec.limitEventId) {
          // Downgrade to an ordinary compact park (keeps the session resumable),
          // never clearInterruption (which would strand it COMPACT-but-not-pending).
          downgradeLimitParkToCompact(session.dir, session.state);
        }
        if (session) clearWakeClaim(session.dir);
      });
    } catch (err) {
      return {
        output:
          `Cancellation started for ${key} but the session could not be cleared ` +
          `(${err instanceof Error ? err.message : String(err)}). The waker retries on its next poll.`,
      };
    }
  }

  // Generation-CAS'd completion: a re-limit that superseded the record
  // mid-cancel minted a NEW auto-resume this cancel does not cover.
  if (!completeCancellation(key, Date.now(), rec.generation)) {
    return {
      output:
        `Cancellation of ${key} was superseded by a new usage-limit stop mid-cancel. ` +
        "The new auto-resume is still pending; run limit-status and cancel again if intended.",
      errorCode: "invalid_input",
    };
  }
  return { output: `Cancelled the pending auto-resume for ${key}.` };
}

async function requeue(key: string): Promise<LimitStatusResult> {
  const rec = readLimitLedger().records[key];
  if (!rec) {
    return { output: `No limit record found for ${key}.`, errorCode: "not_found" };
  }
  if (!requeueRecord(key)) {
    const blockedByAttempt = rec.attempt != null;
    return {
      output: blockedByAttempt
        ? `Record ${key} still tracks a wake child (pid ${rec.attempt?.childPid ?? "?"}) from a blocked ` +
          "cancellation; requeue is refused until the waker confirms it exited. Check again shortly."
        : `Record ${key} is ${rec.status}; only manual or failed records can be requeued.`,
      errorCode: "invalid_input",
    };
  }
  try {
    const { spawnWakerIfNeeded } = await import("../../autonomous/waker.js");
    spawnWakerIfNeeded();
  } catch {
    // The next CLI invocation respawns the waker.
  }
  return { output: `Requeued ${key}; the waker will retry immediately.` };
}

export async function handleLimitStatus(options: LimitStatusOptions = {}): Promise<LimitStatusResult> {
  if (options.cancel && options.requeue) {
    return { output: "Pass either --cancel or --requeue, not both.", errorCode: "invalid_input" };
  }
  if (options.cancel) return cancelRecord(normalizeKey(options.cancel));
  if (options.requeue) return requeue(normalizeKey(options.requeue));
  return {
    output: formatList(listLimitStops(options.recent ? { includeTerminal: true } : undefined), options.format ?? "md"),
  };
}
