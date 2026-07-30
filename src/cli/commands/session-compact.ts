/**
 * CLI handlers for hook-driven compaction (ISS-032).
 *
 * - session-compact-prepare: PreCompact hook entry — prepares session for compaction
 * - session-resume-prompt: SessionStart hook entry — outputs resume instruction after compaction
 * - session-clear-compact: Admin escape hatch — clears stale compact markers
 */
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import {
  findActiveSessionFull,
  findResumableSession,
  findSessionById,
  listAllSessionsDetailed,
  prepareForCompact,
  prepareForLimitStop,
  markCompactionObserved,
  writeSessionSync,
  withSessionLock,
  appendEvent,
  refreshLease,
  isLeaseExpired,
  CLEARED_LIMIT_FIELDS,
  type ActiveSessionInfo,
} from "../../autonomous/session.js";
import { sanitizeDisplayText } from "../../core/display-text.js";
import { boundedList } from "../../core/bounded-list.js";
import {
  limitRecordKey,
  readLimitLedger,
  resolveOwnerlessRecord,
  peekLimitRecord,
  markInteractive,
  beginCancellation,
  completeCancellation,
  clearCancellingAttempt,
  blockCancellation,
  writePreparingIntent,
  verifyPreparingIntent,
  activateIntent,
  abortIntent,
  recordDirectStop,
  repairParkedSessionRecord,
  isLimitResumeGloballyDisabled,
  claimAbandoned,
  LIMIT_STATUS_META,
  type LimitRecordStatus,
  type LimitRecord,
  type LimitStopInput,
} from "../../core/limit-ledger.js";
import { readLimitResumeConfig } from "../../core/limit-config.js";
import { resolveResetAt, LIMIT_PARSER_VERSION } from "../../autonomous/limit-reset-parser.js";
import { scanTranscriptTailForLimit } from "../../autonomous/limit-transcript.js";
import { gitHead } from "../../autonomous/git-inspector.js";
import { withLimitLock } from "../../core/limit-lock.js";
import {
  WAKE_ATTEMPT_ENV,
  parseWakeAttemptEnv,
  readWakeClaim,
  clearWakeClaim,
  wakeClaimLockPath,
  signalWakeChild,
  wakeChildMarkers,
} from "../../autonomous/wake-claim.js";
import { WORKFLOW_STATES } from "../../autonomous/session-types.js";
import {
  normalizeClientTaskId,
  ownerTaskForClient,
  type StorybloqClient,
} from "../../autonomous/client-profile.js";
import { resolveSessionOwnership, callerMayAct } from "../../autonomous/session-ownership.js";
import { writeShutdownMarker, probeArgvSignature } from "../../autonomous/liveness.js";
import { loadProject } from "../../core/project-loader.js";
import { writeResumeMarker, removeResumeMarker } from "../../autonomous/resume-marker.js";
import { findLatestHandover } from "../../federation/handover-utils.js";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  busRuntimeLostAdvisory,
  consumeCompactionSuccession,
  detectClientSurface,
  findEndpointForTask,
  isBusAutoAttachEnabledFromDisk,
  isBusHookDeliveryEnabled,
  mintCompactionSuccession,
  pendingMailboxCursor,
  refreshEndpointForSessionStart,
  type BusEndpoint,
  type BusSurface,
} from "../../bus/index.js";
import { spawnAutoAttachBestEffort } from "../../bus/auto-attach-spawn.js";
import { autoAttachConvergenceNeeded } from "../../bus/auto-attach-gate.js";

// ---------------------------------------------------------------------------
// session-compact-prepare (PreCompact hook)
// ---------------------------------------------------------------------------

/**
 * PreCompact hook entry point. Prepares an active session for compaction.
 * - Discovers .story/ root from cwd
 * - Under withSessionLock (5s timeout): prepareForCompact + snapshot
 * - Silent on success / no session / no .story/
 * - Emits stderr on real failures
 * - Always exits 0 (hook must not block compaction)
 */
export interface SessionCompactPrepareOptions {
  readonly client?: StorybloqClient;
  readonly clientTaskId?: string;
  readonly cwd?: string;
  readonly transcriptPath?: string;
}

export async function handleSessionCompactPrepare(
  options: SessionCompactPrepareOptions = {},
): Promise<void> {
  const root = discoverProjectRoot(options.cwd);
  if (!root) return; // No .story/ — silent no-op

  const client = options.client ?? "claude";
  const environmentTaskId = client === "codex"
    ? process.env.CODEX_THREAD_ID
    : process.env.CLAUDE_CODE_SESSION_ID;
  const clientTaskId = normalizeClientTaskId(options.clientTaskId)
    ?? normalizeClientTaskId(environmentTaskId);

  if (clientTaskId && options.transcriptPath) {
    try {
      await mintCompactionSuccession({
        root,
        client,
        clientTaskId,
        transcriptPath: options.transcriptPath,
      });
    } catch {
      // Bus succession is best-effort; manual polling remains available.
    }
  }

  try {
    await withSessionLock(root, async () => {
      const active = findActiveSessionFull(root);
      if (!active) return; // No active session — silent no-op

      // ISS-899: was one of five hand-rolled copies of the ownership
      // precedence. Behaviour is unchanged -- callerMayAct is exactly the old
      // `sameOwner || legacySameOwner || fullyUnownedLegacy`, including its
      // fail-closed treatment of a caller with no identity in BOTH via cases.
      const callerTask = ownerTaskForClient(client, clientTaskId);
      const ownership = resolveSessionOwnership(active.state, callerTask);

      if (!callerMayAct(ownership)) {
        process.stderr.write(
          `[storybloq] compact-prepare skipped: active session ${active.state.sessionId} ` +
          `is not owned by this ${client} task.\n`,
        );
        return;
      }

      // prepareForCompact FIRST (fast state.json write — ensures compactPending persisted)
      try {
        prepareForCompact(active.dir, refreshLease(active.state));
      } catch (err) {
        process.stderr.write(`[storybloq] compact-prepare: ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }

      // T-183: Write resume marker for 100% compaction survival
      writeResumeMarker(root, active.state.sessionId, {
        ticket: active.state.ticket,
        completedTickets: active.state.completedTickets,
        resolvedIssues: active.state.resolvedIssues,
        preCompactState: active.state.preCompactState ?? active.state.state,
      });

      // THEN snapshot (slower, can fail — compactPending is already set)
      try {
        const loadResult = await loadProject(root);
        const { saveSnapshot } = await import("../../core/snapshot.js");
        await saveSnapshot(root, loadResult);
      } catch {
        // Snapshot failure is recoverable — compactPending is set, resume will work
      }
    });
  } catch (err) {
    // Lock acquisition or other failure — emit stderr, exit 0
    process.stderr.write(`[storybloq] compact-prepare failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

}

// ---------------------------------------------------------------------------
// session-resume-prompt (SessionStart hook)
// ---------------------------------------------------------------------------

/**
 * Sanitize a repository-controlled string before it is written into model
 * context (SessionStart hook output). Handover filenames/dates can carry
 * control characters; strip C0 controls + DEL + C1 controls (incl. NEL, which
 * JS `\s` does not cover), collapse whitespace, trim, and length-bound so an
 * injected value cannot break out of the breadcrumb framing.
 */
function sanitizeForContext(s: string, max = 200): string {
  const stripped = Array.from(s)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      // drop C0 (0x00-0x1f), DEL (0x7f), and C1 (0x80-0x9f) control ranges
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    })
    .join("");
  return stripped.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Build a lightweight post-compaction continuity breadcrumb for the case where
 * there is NO active autonomous session (the /story orchestrate pen-driving
 * case). Points the resumed session at the latest handover + `storybloq recap`
 * so project context is not lost. Informational, not imperative. Never throws.
 */
async function buildCompactionBreadcrumb(root: string): Promise<string | null> {
  try {
    let latest: Awaited<ReturnType<typeof findLatestHandover>> = null;
    try {
      latest = await findLatestHandover(join(root, ".story", "handovers"));
    } catch {
      latest = null; // handovers dir missing or unreadable
    }
    const lines = ["Storybloq project context was compacted."];
    if (latest) {
      const file = sanitizeForContext(latest.filename);
      const date = latest.date ? ` (${sanitizeForContext(latest.date, 20)})` : "";
      const heading = latest.heading ? ` -- ${sanitizeForContext(latest.heading)}` : "";
      lines.push(`Latest handover file: ${file}${date}${heading}`);
    }
    lines.push("To reload full project state, run: storybloq recap");
    return lines.join("\n") + "\n";
  } catch {
    return null; // never throw -- hook must exit 0
  }
}

/**
 * Read the SessionStart hook JSON from a stream and return its `source`
 * (e.g. "startup" | "resume" | "compact"), or undefined. Read at the CLI
 * boundary so the handler stays a pure unit. Never hangs (hard timeout) and
 * never throws, both required so the hook always exits 0.
 */
export interface SessionStartHookContext {
  readonly source?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly transcriptPath?: string;
  // T-424: StopFailure payload fields (additive; absent on other hook events).
  readonly errorType?: string;
  readonly permissionMode?: string;
  readonly hookEventName?: string;
}

export async function readHookStdinContext(
  stream: NodeJS.ReadableStream & { isTTY?: boolean },
  timeoutMs = 200,
): Promise<SessionStartHookContext> {
  if (stream.isTTY) return {};
  const raw = await new Promise<string>((resolve) => {
    let data = "";
    let bytes = 0;
    let oversized = false;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(data);
    };
    const onData = (chunk: Buffer | string): void => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) {
        oversized = true;
        data = "";
        finish();
        return;
      }
      data += chunk.toString();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", finish);
      stream.removeListener("error", finish);
      if (typeof stream.pause === "function") {
        try {
          stream.pause();
        } catch {
          // noop: releasing the stream is best-effort
        }
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.on("data", onData);
    stream.once("end", finish);
    stream.once("error", finish);
    if (typeof stream.resume === "function") {
      try {
        stream.resume();
      } catch {
        finish();
      }
    }
  });
  try {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed) as {
      source?: unknown;
      session_id?: unknown;
      cwd?: unknown;
      transcript_path?: unknown;
      error_type?: unknown;
      error?: unknown;
      permission_mode?: unknown;
      hook_event_name?: unknown;
    };
    const sessionId = typeof parsed.session_id === "string"
      ? normalizeClientTaskId(parsed.session_id)
      : null;
    const cwd = typeof parsed.cwd === "string" && parsed.cwd.length > 0 && parsed.cwd.length <= 4096
      ? parsed.cwd
      : undefined;
    const transcriptPath = typeof parsed.transcript_path === "string" &&
      parsed.transcript_path.length > 0 && parsed.transcript_path.length <= 4096
      ? parsed.transcript_path
      : undefined;
    // T-424: the StopFailure error field is semi-documented; accept both spellings.
    const errorType = typeof parsed.error_type === "string"
      ? parsed.error_type
      : typeof parsed.error === "string"
        ? parsed.error
        : undefined;
    const permissionMode = typeof parsed.permission_mode === "string" && parsed.permission_mode.length <= 64
      ? parsed.permission_mode
      : undefined;
    const hookEventName = typeof parsed.hook_event_name === "string" && parsed.hook_event_name.length <= 64
      ? parsed.hook_event_name
      : undefined;
    return {
      ...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(errorType ? { errorType } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(hookEventName ? { hookEventName } : {}),
    };
  } catch {
    return {};
  }
}

/** Backward-compatible source-only reader used by existing callers and tests. */
export async function readHookStdinSource(
  stream: NodeJS.ReadableStream & { isTTY?: boolean },
  timeoutMs = 200,
): Promise<string | undefined> {
  return (await readHookStdinContext(stream, timeoutMs)).source;
}

function codexTaskMarker(clientTaskId: string | undefined, surface: BusSurface | null): string {
  const normalized = normalizeClientTaskId(clientTaskId);
  if (!normalized) return "";
  // D8: validated surface hint so `bus setup` can distinguish codex_cli from
  // codex_desktop, which process ancestry cannot always determine.
  const surfaceLine = surface === "codex_cli" || surface === "codex_desktop"
    ? `surface=${surface}\n`
    : "";
  return `[storybloq-client-task]\nclient=codex\nid=${normalized}\n${surfaceLine}[/storybloq-client-task]\n`;
}

// D8: role-free marker. Roles are per-message now, so the marker carries the
// stable surface and declares role_mode instead of a fixed role.
function busEndpointMarker(endpoint: BusEndpoint, pending: { cursor: number; count: number }): string {
  return [
    "[storybloq-bus-endpoint]",
    `endpoint=${endpoint.endpointId}`,
    `surface=${endpoint.surface}`,
    `role_mode=per_message`,
    `pending=${pending.count}`,
    `cursor=${pending.cursor}`,
    "[/storybloq-bus-endpoint]",
    "",
  ].join("\n");
}

/**
 * T-424: SessionStart handling for a limit-parked session. Distinguishes the
 * waker's own headless child (env token matches the active wake claim; stays
 * silent -- its wake prompt already carries the resume instruction) from an
 * interactive reopen (revokes the claim, marks the ledger record
 * `interactive`, async-terminates the waker's child) and gates the emitted
 * instruction by the record's mode/reasonCode. Never throws, never blocks.
 */
function emitLimitResumePrompt(args: {
  info: ActiveSessionInfo;
  sessionId: string;
  taskArg: string;
  stale: boolean;
  writeResumeMessage: (message: string) => void;
}): void {
  const { info, sessionId, taskArg, stale, writeResumeMessage } = args;
  const state = info.state;
  const resumeAtText = state.limitResumeAt
    ? new Date(state.limitResumeAt).toLocaleString()
    : "the limit reset";
  const clientTaskId = state.ownerTask?.client === "claude"
    ? state.ownerTask.id
    : state.claudeCodeSessionId ?? null;

  // Resolve the ledger key. Normally the session's own owner identity seeds it.
  // If the session lost BOTH owner identifiers, fall back to the CURRENT-episode
  // record located by storybloqSessionId + limitEventId (mirrors
  // cancelLimitAutoResume) so a tokenless reopen still stands a live headless
  // wake down instead of racing it. `recordClientTaskId` (the record's own
  // clientTaskId) drives wake-child markers, since the session no longer carries
  // that identity.
  let key: string | null = clientTaskId ? limitRecordKey(clientTaskId) : null;
  let recordClientTaskId: string | null = clientTaskId;
  let ownerlessResolveFailed = false;
  if (!key) {
    try {
      // Locked, fail-closed resolution: a throw (lock unavailable / ambiguous)
      // means we CANNOT prove no live wake child owns this session, so we must
      // NOT emit a bare guide instruction. A null result IS authoritative (no
      // current-episode record) -> a genuine ownerless park, safe to instruct.
      const found = resolveOwnerlessRecord(state.sessionId, state.limitEventId);
      if (found) {
        key = found.key;
        recordClientTaskId = found.clientTaskId;
      }
    } catch {
      ownerlessResolveFailed = true;
    }
  }

  // Self-wake recognition: a process carrying STORYBLOQ_WAKE_ATTEMPT is
  // definitively one of OUR spawned wake children -- the token is a per-attempt
  // secret an interactive reopen never has. Identify it against the LEDGER
  // (authoritative), not the claim FILE: a transient readWakeClaim failure must
  // never make our own child fall through to the interactive-takeover path and
  // SIGTERM itself. Stay silent only while the ledger confirms it is the LIVE
  // `resuming` attempt; a superseded/cancelled one (or an unconfirmable one)
  // stands down instead of racing the interactive session.
  const claim = readWakeClaim(info.dir);
  const envAttempt = parseWakeAttemptEnv(process.env[WAKE_ATTEMPT_ENV]);
  if (envAttempt) {
    let live = false;
    if (key) {
      try {
        const rec = peekLimitRecord(key);
        live =
          rec?.status === "resuming" &&
          rec.attempt?.id === envAttempt.attemptId &&
          rec.attempt.token === envAttempt.token;
      } catch {
        // FAIL CLOSED: ledger unreadable -> cannot prove this is our current
        // live child -> stand down (a genuine live child is re-dispatched by
        // the waker on its next poll).
        live = false;
      }
    }
    if (live) return; // the waker's own live child: stay silent
    writeResumeMessage(
      "This headless wake attempt was superseded (another resume owns the session). " +
      "Do NOT call the autonomous guide; end this run without further action.\n",
    );
    return;
  }

  // FINALIZE stops are manual-recovery only (see handleResume's enforcement).
  if (state.preCompactState === "FINALIZE") {
    writeResumeMessage(
      `Session ${sessionId} was stopped by a usage limit during FINALIZE. ` +
      "Do NOT resume it blindly: replaying finalization can duplicate commits. " +
      "Verify what landed with `git log` (commit, push, ticket updates), then run " +
      `"storybloq session clear-compact ${sessionId} --force" and resume.\n`,
    );
    return;
  }

  // Tokenless reopen: this is an interactive resume. Under the wake-claim lock,
  // stand the waker down (mark `interactive`, revoke the claim) so two
  // processes never drive one transcript.
  let record: LimitRecord | undefined;
  let supersededResuming = false;
  let supersededChildPid: number | null = null;
  let supersededAttemptId: string | null = null;
  let takeoverContested = false;
  if (key) {
    try {
      record = readLimitLedger().records[key];
      if (record && record.mode === "headless" &&
          (record.status === "resuming" || record.status === "stopped" || record.status === "deferred")) {
        const outcome = withLimitLock(
          wakeClaimLockPath(info.dir),
          (): { marked: ReturnType<typeof markInteractive>; fresh?: LimitRecord } => {
            const m = markInteractive(key);
            if (m) {
              clearWakeClaim(info.dir); // revoke the claim ONLY on a successful takeover CAS
              return { marked: m };
            }
            // CAS lost: cancellation or a new generation won between the
            // pre-lock read and here. Do NOT clear the claim; re-read the
            // record so messaging reflects real state, not the stale snapshot.
            return { marked: null, fresh: readLimitLedger().records[key] };
          },
          { deadlineMs: 750 },
        );
        if (outcome.marked) {
          // A `resuming` record is superseded even when childPid is still null:
          // the waker may be BETWEEN claim and spawn, and emitting the normal
          // resume instruction here would let the interactive and headless
          // clients drive one transcript concurrently. (The waker's own
          // recordAttemptSpawn CAS fails against `interactive` and terminates
          // the just-spawned child.)
          supersededResuming = outcome.marked.priorStatus === "resuming";
          supersededChildPid = outcome.marked.attempt?.childPid ?? claim?.childPid ?? null;
          supersededAttemptId = outcome.marked.attempt?.id ?? claim?.attemptId ?? null;
        } else {
          // Takeover CAS contested: never authorize the normal resume prompt
          // from the stale snapshot -- the record may now be cancelling or a
          // newer episode. Emit a stand-down and reflect the current record.
          takeoverContested = true;
          record = outcome.fresh;
        }
      }
    } catch {
      // Ledger/wake-claim lock unavailable: we CANNOT prove that no headless
      // attempt owns this session, so FAIL CLOSED. Emitting the normal resume
      // instruction here could let this interactive client drive the transcript
      // beside a live wake child. Stand down and have the user retry.
      takeoverContested = true;
    }
  }

  if (takeoverContested && key) {
    writeResumeMessage(
      `Session ${sessionId}'s usage-limit auto-resume state could not be confirmed right now (it may be ` +
      "cancelling, re-limited, or the ledger was briefly locked). Do NOT call the autonomous guide now; " +
      "retry /story in a moment.\n",
    );
    return;
  }

  if ((supersededResuming || supersededChildPid) && key && recordClientTaskId) {
    if (supersededChildPid && supersededAttemptId) {
      signalWakeChild(supersededChildPid, wakeChildMarkers(recordClientTaskId, supersededAttemptId));
    }
    writeResumeMessage(
      `A headless auto-resume of session ${sessionId} is being stopped in favor of this interactive session. ` +
      "Retry /story in a moment to continue it here.\n",
    );
    return;
  }

  if (record?.status === "manual") {
    if (record.reasonCode === "bypass_not_opted_in") {
      writeResumeMessage(
        `Session ${sessionId} hit a usage limit while running with bypassed permissions. ` +
        "Automatic wake needs a one-time opt-in: set limitResume.inheritBypass=true in .story/config.json. " +
        `To continue here now, call storybloq_autonomous_guide with:\n` +
        `{"sessionId": "${sessionId}", "action": "resume"${taskArg}}\n`,
      );
      return;
    }
    if (record.reasonCode === "cancellation_blocked") {
      writeResumeMessage(
        `Session ${sessionId} has a limit auto-resume in a blocked cancellation (a wake child could not be terminated). ` +
        `Check "storybloq limit-status" before resuming.\n`,
      );
      return;
    }
    writeResumeMessage(
      `Session ${sessionId} was stopped by a usage limit; automatic resume stood down` +
      `${record.reasonCode ? ` (${record.reasonCode})` : ""}. ` +
      `To continue here, call storybloq_autonomous_guide with:\n` +
      `{"sessionId": "${sessionId}", "action": "resume"${taskArg}}\n`,
    );
    return;
  }

  // Any remaining NON-terminal record we did not convert to an interactive
  // takeover is mid-transition: `cancelling` (a stand-down in progress), a
  // `preparing` intent the StopFailure handler has not activated, or an
  // `interactive` claim already held by a different client. Resuming over it
  // would race in-flight work (a wake child still terminating, session
  // cancellation completing). Fail closed -- never emit the guide instruction.
  // A `stopped`/`deferred` record we DID mark interactive falls through to the
  // normal instruction below (there is no in-flight child to race).
  if (
    record &&
    !LIMIT_STATUS_META[record.status as LimitRecordStatus]?.terminal &&
    record.status !== "stopped" &&
    record.status !== "deferred"
  ) {
    writeResumeMessage(
      `Session ${sessionId}'s usage-limit auto-resume is mid-transition (status: ${record.status}); ` +
      "it may be cancelling, still being set up, or already claimed by another resume. " +
      "Do NOT call the autonomous guide now; retry /story in a moment.\n",
    );
    return;
  }

  if (ownerlessResolveFailed) {
    // Ownerless session + the ledger could not be read under its lock: we cannot
    // rule out a live headless wake child, so fail closed (no guide instruction).
    writeResumeMessage(
      `Session ${sessionId}'s usage-limit auto-resume state could not be confirmed right now ` +
      "(the ledger was briefly locked). Do NOT call the autonomous guide now; retry /story in a moment.\n",
    );
    return;
  }

  if (record?.status === "failed" || stale) {
    writeResumeMessage(
      `Session ${sessionId} was stopped by a usage limit and automatic resume ` +
      `${record?.status === "failed" ? `gave up after ${record.wakeAttempts} attempt(s)` : "did not complete"}. ` +
      `To continue here, call storybloq_autonomous_guide with:\n` +
      `{"sessionId": "${sessionId}", "action": "resume"${taskArg}}\n`,
    );
    return;
  }

  writeResumeMessage(
    `Session ${sessionId} is paused at a usage limit (auto-resume scheduled around ${resumeAtText}). ` +
    `To continue in THIS session instead, call storybloq_autonomous_guide with:\n` +
    `{"sessionId": "${sessionId}", "action": "resume"${taskArg}}\n` +
    "The guide validates git state; the pending auto-resume stands down automatically.\n",
  );
}

/**
 * SessionStart hook entry point. Outputs resume instruction for compacted sessions.
 * - Resolves project root + workspace from cwd
 * - Finds resumable session (compactPending + active + workspace match)
 * - Fresh: outputs normal resume instruction
 * - Fresh + resumeBlocked: outputs blocked-resume instruction
 * - Stale (>1hr): outputs stale recovery message
 * - No match: injects a lightweight compaction continuity breadcrumb (the
 *   /story orchestrate pen-driving case) on a post-compaction start, else silent
 * - Never throws; always exits 0 (hook must not block compaction)
 */
export async function handleSessionResumePrompt(
  options: {
    codexHookJson?: boolean;
    source?: string;
    clientTaskId?: string;
    cwd?: string;
    transcriptPath?: string;
  } = {},
): Promise<void> {
  try {
    const environmentTaskId = options.codexHookJson
      ? process.env.CODEX_THREAD_ID
      : process.env.CLAUDE_CODE_SESSION_ID;
    const explicitTaskId = normalizeClientTaskId(options.clientTaskId);
    const inheritedTaskId = normalizeClientTaskId(environmentTaskId);
    const clientTaskId = explicitTaskId ?? inheritedTaskId ?? undefined;
    const root = discoverProjectRoot(options.cwd);
    if (!root) return; // No .story/ -- silent

    // T-424: opportunistic waker respawn (reboot/crash recovery). Cheap
    // lockless probe inside; must never affect the resume prompt.
    await spawnWakerBestEffort();

    const client: StorybloqClient = options.codexHookJson ? "codex" : "claude";
    let busMarker = "";
    let codexSurface: BusSurface | null = null;
    if (clientTaskId) {
      try {
        let endpoint = options.source === "compact" && options.transcriptPath
          ? await consumeCompactionSuccession({
              root,
              client,
              clientTaskId,
              transcriptPath: options.transcriptPath,
            })
          : null;
        endpoint ??= await findEndpointForTask(root, client, clientTaskId);
        if (endpoint) {
          endpoint = await refreshEndpointForSessionStart(root, endpoint.endpointId, clientTaskId);
          codexSurface = endpoint.surface;
          if (await isBusHookDeliveryEnabled(root, client)) {
            busMarker = busEndpointMarker(endpoint, await pendingMailboxCursor(root, endpoint.endpointId, clientTaskId));
          }
        }
      } catch {
        // Session continuity must not depend on Bus endpoint refresh.
      }
      // T-428: if this checkout's Bus runtime was deleted (evidence names an
      // instance but the runtime is gone), advise the returning session via STDERR
      // only -- never bare stdout, which would corrupt the SessionStart protocol.
      // Fail-open: any error is swallowed, and a healthy/never-set-up Bus is silent.
      if (!busMarker) {
        try {
          const advisory = await busRuntimeLostAdvisory(root);
          if (advisory) process.stderr.write(advisory + "\n");
        } catch {
          // Advisory is best-effort; it must never affect session continuity.
        }
      }
    }
    if (options.codexHookJson && !codexSurface) {
      codexSurface = await detectClientSurface("codex").catch(() => null);
    }

    // T-430: auto-attach this session's Bus endpoint OFF the critical path. Fires when the
    // project has opted in, this is not a compaction continuation (a compact start resumes the
    // same task's endpoint via the marker path), AND the session's delivery is not fully
    // converged. The gate is the SHARED convergence predicate -- NOT `!busMarker` -- because a
    // marker is emitted whenever an endpoint exists with delivery enabled, even for an endpoint
    // carrying an unresolved materialization-degraded outcome. Using the marker would leave such
    // an endpoint stuck (Codex has no Stop retry, so SessionStart is its only recovery). The
    // predicate covers no-endpoint OR delivery-off OR degraded-matching-active-endpoint.
    // Constant-time: a bounded no-follow config read + read-only endpoint/outcome reads + a
    // read-only spawn-suppression hint, then a detached spawn that writes nothing to stdout.
    // Fail-open: any error is swallowed and never blocks the resume prompt.
    if (clientTaskId && options.source !== "compact") {
      try {
        if (await isBusAutoAttachEnabledFromDisk(root)
          && await autoAttachConvergenceNeeded(root, client, clientTaskId)) {
          const surface: BusSurface | null = client === "claude" ? "claude_cli" : codexSurface;
          if (surface) {
            await spawnAutoAttachBestEffort({ root, client, clientTaskId, surface, nowMs: Date.now() });
          }
        }
      } catch {
        // Auto-attach spawn is best-effort; it must never affect session continuity.
      }
    }

    const writeResumeMessage = (message: string): void => {
      if (options.codexHookJson) {
        const additionalContext = codexTaskMarker(clientTaskId, codexSurface) + busMarker + message;
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext,
          },
        }) + "\n");
        return;
      }
      process.stdout.write(busMarker + message);
    };

    const match = findResumableSession(root);
    if (!match) {
      // T-183: Clean orphaned marker if no compactPending session exists at all
      removeResumeMarker(root);
      // No autonomous session to resume. On a post-compaction start, inject a
      // lightweight continuity breadcrumb so an orchestrate/pen session (which
      // has no autonomous session) does not lose project context. `source` is
      // the primary gate; the `undefined && !codexHookJson` clause is an
      // intentional fail-open for the Claude plaintext path (matcher already
      // "compact") and legacy installed hooks that predate the stdin read.
      const shouldEmitBreadcrumb =
        options.source === "compact" ||
        (options.source === undefined && !options.codexHookJson);
      if (shouldEmitBreadcrumb) {
        const breadcrumb = await buildCompactionBreadcrumb(root);
        if (breadcrumb) writeResumeMessage(breadcrumb);
      } else if ((options.codexHookJson && clientTaskId) || busMarker) {
        writeResumeMessage("");
      }
      return;
    }

    let { info } = match;
    const { stale } = match;
    const sessionId = info.state.sessionId;
    const callerTask = ownerTaskForClient(
      client,
      clientTaskId,
    );
    // ISS-899: the fourth copy of the precedence, and the one that gates a
    // STATE WRITE (markCompactionObserved below). Behaviour is unchanged:
    // verifiedSameOwner is exactly callerMayAct, and hasRecordedOwner is
    // "the resolver found an owner of either kind".
    const ownership = resolveSessionOwnership(info.state, callerTask);
    const hasRecordedOwner = ownership.kind !== "unowned";
    const verifiedSameOwner = callerMayAct(ownership);
    const leaseExpired = isLeaseExpired(info.state);
    const ticket = sanitizeForContext(
      info.state.ticket?.displayId ?? info.state.ticket?.id ?? "The autonomous ticket",
      40,
    );

    // The SessionStart hook is the proof that client context actually changed.
    // A guide-level pre_compact call only prepares state and must not reset
    // pressure by itself. Mark only a verified owner on source=compact.
    if (options.source === "compact" && verifiedSameOwner) {
      try {
        const observed = await withSessionLock(root, async () => {
          const current = findSessionById(root, sessionId);
          if (!current || current.state.state !== "COMPACT" || !current.state.compactPending) {
            return null;
          }
          const written = markCompactionObserved(current.dir, current.state);
          appendEvent(current.dir, {
            rev: written.revision,
            type: "client_compaction_observed",
            timestamp: written.compactObservedAt!,
            data: { source: options.source, client: callerTask?.client ?? null },
          });
          return { ...current, state: written };
        });
        if (observed) info = observed;
      } catch {
        // Best-effort hook metadata. Resume remains safe because pressure is
        // preserved when this marker cannot be written.
      }
    }

    if (!callerTask && hasRecordedOwner) {
      const command = options.codexHookJson ? "$story" : "/story";
      writeResumeMessage(
        `${ticket} has a compacted session with a recorded owner, but this task's identity is unavailable. ` +
        `Run ${command} to verify ownership before recovery.\n`,
      );
      return;
    }

    if (!verifiedSameOwner) {
      if (leaseExpired) {
        const command = options.codexHookJson ? "$story" : "/story";
        writeResumeMessage(
          `${ticket} has an expired compacted session. Run ${command} and choose Resume here, End session, or Back.\n`,
        );
      } else if (info.state.ownerTask) {
        const ownerClient = info.state.ownerTask.client === "codex" ? "Codex" : "Claude Code";
        const command = options.codexHookJson ? "$story" : "/story";
        writeResumeMessage(
          `${ticket} is compacted in another live ${ownerClient} task. ` +
          `Run ${command} to open or monitor the owner. Recover here only after confirming that task is gone.\n`,
        );
      } else {
        const command = options.codexHookJson ? "$story" : "/story";
        writeResumeMessage(
          `${ticket} is compacted in another live legacy Claude Code task. ` +
          `Continue from the original task, or run ${command} to monitor it. ` +
          `Recover here only after confirming that task is gone.\n`,
        );
      }
      return;
    }

    const taskArg = callerTask ? `, "clientTaskId": "${callerTask.id}"` : "";

    // T-424: limit-parked sessions get limit-aware handling (self-wake
    // recognition, interactive-reopen supersede, gated instructions).
    if (info.state.interruptionKind === "limit") {
      emitLimitResumePrompt({ info, sessionId, taskArg, stale, writeResumeMessage });
      return;
    }

    // Stale check first -- stale sessions get stale message regardless of resumeBlocked
    if (stale) {
      // Stale session -- output recovery message (not silence)
      writeResumeMessage(
        `Stale compacted session ${sessionId} found (never resumed).\n` +
        `Run "storybloq session clear-compact ${sessionId}" to recover, ` +
        `or call storybloq_autonomous_guide with:\n` +
        `{"sessionId": "${sessionId}", "action": "resume"${taskArg}}\n`,
      );
      return;
    }

    if (info.state.resumeBlocked) {
      // Blocked resume -- output recovery instructions
      writeResumeMessage(
        `Autonomous session ${sessionId} has a blocked resume (git validation failed).\n` +
        `Run "storybloq session clear-compact ${sessionId}" to recover, ` +
        `or check git status and call storybloq_autonomous_guide with:\n` +
        `{"sessionId": "${sessionId}", "action": "resume"${taskArg}}\n`,
      );
      return;
    }

    // Fresh session -- output normal resume instruction
    writeResumeMessage(
      `Continue the autonomous coding session. Call \`storybloq_autonomous_guide\` with:\n` +
      `{"sessionId": "${sessionId}", "action": "resume"${taskArg}}\n`,
    );
  } catch (err) {
    // Never throw -- the hook must exit 0. Best-effort stderr log only.
    process.stderr.write(
      `[storybloq] resume-prompt failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// session-clear-compact (admin escape hatch)
// ---------------------------------------------------------------------------

/** Phase-1 result of the admin stand-down: the caller completes the cancel AFTER its own session write. */
interface CancelStandDown {
  key: string;
  generation: number;
}

/**
 * T-424: ledger stand-down when an admin command destroys a pending limit
 * auto-resume. Order matters: the ledger record is CAS'd to `cancelling`
 * (non-dispatchable) FIRST, and only then is the wake claim revoked -- the
 * reverse order leaves a window where a waker passes its ledger recheck,
 * writes a fresh claim, and spawns a child mid-cancel.
 *
 * The caller may mutate session state ONLY when this returns (returning means
 * no wake child exists or its death was CONFIRMED), and must call
 * completeCancellation with the returned key/generation AFTER its session
 * write -- so a crash at any point leaves a `cancelling` record that
 * reconciliation finishes, never a `cancelled` record beside a still-parked
 * session.
 *
 * THROWS (leaving the record non-dispatchable and session state UNTOUCHED)
 * when:
 *  - the ledger lock is unavailable (a dispatchable record must not outlive
 *    a cleared session as untracked work);
 *  - a wake attempt is mid-spawn (claimed, childPid not yet recorded) -- the
 *    waker's spawn CAS fails against `cancelling`, terminates the child, and
 *    finish-cancel completes the stand-down;
 *  - a live wake child could not be CONFIRMED terminated -- the record stands
 *    down to manual/cancellation_blocked with the attempt preserved, and
 *    session state is never cleared under a live child.
 */
async function cancelLimitAutoResume(info: ActiveSessionInfo): Promise<CancelStandDown | null> {
  const clientTaskId = info.state.ownerTask?.client === "claude"
    ? info.state.ownerTask.id
    : info.state.claudeCodeSessionId ?? null;
  let key: string;
  if (clientTaskId) {
    key = limitRecordKey(clientTaskId);
  } else {
    // The session lost both owner identifiers, so we cannot derive the ledger
    // key. A non-terminal record (possibly tracking a live child) may still
    // exist -- locate it by storybloqSessionId + the session's CURRENT episode
    // (limitEventId) and cancel THAT. resolveOwnerlessRecord reads UNDER the
    // ledger lock and THROWS on lock-unavailable/ambiguous, so we fail CLOSED
    // (leave the session untouched) rather than clearing it off a lockless empty
    // read that merely could not see the live record. A manually-resumed session
    // keeps its storybloqSessionId but is re-parked under a new clientTaskId, so
    // the limitEventId match avoids cancelling a stale episode while the current
    // record stays dispatchable.
    let found: LimitRecord | null;
    try {
      found = resolveOwnerlessRecord(info.state.sessionId, info.state.limitEventId);
    } catch (err) {
      throw new Error(
        "Could not stand down the pending limit auto-resume (ledger unavailable or ambiguous: " +
        `${err instanceof Error ? err.message : String(err)}). Retry in a moment.`,
      );
    }
    if (!found) {
      clearWakeClaim(info.dir);
      return null;
    }
    key = found.key;
  }
  let begun: ReturnType<typeof beginCancellation>;
  try {
    begun = beginCancellation(key);
  } catch (err) {
    throw new Error(
      "Could not stand down the pending limit auto-resume (ledger busy: " +
      `${err instanceof Error ? err.message : String(err)}). Retry in a moment.`,
    );
  }
  clearWakeClaim(info.dir);
  if (!begun) return null; // no record / already terminal: nothing to stand down
  const attempt = begun.record.attempt;
  if (attempt && attempt.childPid == null) {
    if (!claimAbandoned(attempt)) {
      // LIVE claim: the claimant is alive (possibly suspended) and a wake child
      // may materialize immediately after this check. The record is now
      // `cancelling`, so the waker's spawn CAS fails and it terminates its own
      // child; finish-cancel then completes the stand-down (including the
      // session-side clear).
      throw new Error(
        "A limit auto-resume attempt is mid-spawn for this session. It has been stood down; " +
        "the background waker will stop the child and finish clearing the parked state shortly. " +
        "Retry this command in a moment.",
      );
    }
    // ABANDONED claim: the claimant process is CONFIRMED dead (not merely
    // slow/suspended), so no child exists. Drop the attempt via the cancel-flow
    // clear and return the stand-down so the caller's completeCancellation
    // terminalizes it SYNCHRONOUSLY -- never rely on a waker that the kill
    // switch may keep from ever starting (which would strand it `cancelling`).
    clearCancellingAttempt(key, attempt.id);
    return { key, generation: begun.record.generation };
  }
  if (attempt) {
    const markers = wakeChildMarkers(begun.record.clientTaskId, attempt.id);
    const confirmed = await terminateWakeChildConfirmed(attempt.childPid!, markers);
    if (!confirmed) {
      try {
        blockCancellation(key);
      } catch {
        // Record stays `cancelling`; reconciliation retries the termination.
      }
      throw new Error(
        `Could not stop the running wake child (pid ${attempt.childPid}). The auto-resume is stood ` +
        "down and the parked session state was left intact (never cleared under a live child). " +
        'Check "storybloq limit-status" and retry once the child exits.',
      );
    }
    // Death CONFIRMED: drop the possibly-live-child evidence through the
    // cancel-flow path so the caller's completeCancellation (which refuses
    // while an attempt remains) can terminalize the stand-down.
    clearCancellingAttempt(key, attempt.id);
  }
  return { key, generation: begun.record.generation };
}

/** Confirmed termination for the CLI cancel path: SIGTERM -> verify -> SIGKILL -> verify, identity-checked. */
async function terminateWakeChildConfirmed(pid: number, markers: readonly string[]): Promise<boolean> {
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

/**
 * Admin command to clear stale compact markers.
 * - Valid preCompactState: repairs compactPending, clears resumeBlocked, and refreshes compactPreparedAt.
 *   User must call resume for actual state restoration (HEAD validation runs there).
 * - Invalid preCompactState: ends session (SESSION_END + admin_recovery).
 * - Limit-parked sessions (interruptionKind="limit") require --force and stand
 *   down the pending auto-resume (ledger cancel + limit fields cleared).
 */
export async function handleSessionClearCompact(
  root: string,
  sessionId?: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  // Deferred cancel completion: written AFTER the session mutation commits so
  // a crash in between leaves `cancelling` (reconciliation finishes it), never
  // `cancelled` beside a still-parked session. Held in an object so the value
  // assigned inside the locked callback survives to the post-lock completion
  // (a bare `let` reassigned only in a closure is narrowed away by TS).
  const cancelHolder: { pending: CancelStandDown | null } = { pending: null };
  const message = await withSessionLock(root, async () => {
    let info: ActiveSessionInfo | null = null;

    if (sessionId) {
      info = findSessionById(root, sessionId);
      if (!info) throw new Error(`Session ${sessionId} not found`);
    } else {
      // Scan for any compactPending session (findResumableSession has no lease filter)
      const match = findResumableSession(root);
      if (match) {
        info = match.info;
      }
      if (!info) throw new Error("No compactPending session found. Specify the session ID manually.");
    }

    if (!info.state.compactPending && info.state.state !== "COMPACT") {
      throw new Error(`Session ${info.state.sessionId} is not in compact-pending state`);
    }

    // T-424: a limit-parked session has a PENDING AUTO-RESUME that this
    // command destroys. Require an explicit --force.
    const isLimitKind = info.state.interruptionKind === "limit";
    if (isLimitKind && !opts.force) {
      const resumeAtText = info.state.limitResumeAt
        ? ` (scheduled around ${new Date(info.state.limitResumeAt).toLocaleString()})`
        : "";
      throw new Error(
        `Session ${info.state.sessionId} is limit-stopped with a pending auto-resume${resumeAtText}. ` +
        "Clearing it destroys that auto-resume. Re-run with --force to proceed.",
      );
    }
    if (isLimitKind) cancelHolder.pending = await cancelLimitAutoResume(info);

    const preCompactState = info.state.preCompactState;
    const SAFE_RESUME_STATES = WORKFLOW_STATES.filter(s => s !== "COMPACT" && s !== "SESSION_END");
    const isValidState = preCompactState && SAFE_RESUME_STATES.includes(preCompactState as typeof SAFE_RESUME_STATES[number]);

    if (isValidState) {
      // Valid: repair the marker and keep the session discoverable for resume.
      // For a forced limit clear this also converts the interruption to plain
      // compact kind, so resume no longer routes through the limit gates.
      writeSessionSync(info.dir, {
        ...info.state,
        compactPending: true,
        resumeBlocked: false,
        compactPreparedAt: new Date().toISOString(),
        compactObservedAt: null,
        ...CLEARED_LIMIT_FIELDS,
      });
      // Accurate recovery expectation for the FINALIZE manual-recovery path:
      // preCompactState stays FINALIZE. A clean-HEAD resume re-enters FINALIZE
      // at its recorded finalizeCheckpoint (already-landed commits detected,
      // not repeated); only external HEAD drift routes RECOVERY_MAPPING to
      // IMPLEMENT with the code checkpoint reset.
      const finalizeNote = isLimitKind && preCompactState === "FINALIZE"
        ? "\nNote: this session stopped during FINALIZE; resume re-enters FINALIZE at its recorded checkpoint " +
          "and skips finalization steps that already landed (an existing commit is detected, not repeated). " +
          "If git HEAD moved externally while stopped, resume instead recovers to IMPLEMENT with the code " +
          "checkpoint reset. You confirmed commit state -- remove or amend any duplicates first."
        : "";
      const hasKnownLiveOwner = !isLeaseExpired(info.state) &&
        (!!info.state.ownerTask || !!info.state.claudeCodeSessionId);
      if (hasKnownLiveOwner) {
        return `Compact markers cleared for session ${info.state.sessionId}. Ownership was not changed. ` +
          "Resume from the recorded owner task. Recovery elsewhere must use the client's " +
          "explicit owner-gone confirmation flow." + finalizeNote;
      }
      return `Compact markers cleared for session ${info.state.sessionId}. Resume with:\n` +
        `storybloq_autonomous_guide {"sessionId": "${info.state.sessionId}", "action": "resume"}` + finalizeNote;
    }

    // Invalid: end session
    const written = writeSessionSync(info.dir, {
      ...info.state,
      state: "SESSION_END",
      previousState: info.state.state,
      status: "completed" as const,
      terminationReason: "admin_recovery",
      compactPending: false,
      compactPreparedAt: null,
      compactObservedAt: null,
      resumeBlocked: false,
      ...CLEARED_LIMIT_FIELDS,
    });
    writeShutdownMarker(info.dir);

    appendEvent(info.dir, {
      rev: written.revision,
      type: "admin_recovery",
      timestamp: new Date().toISOString(),
      data: {
        reason: "invalid_preCompactState",
        preCompactState: preCompactState ?? null,
        ticketId: info.state.ticket?.id ?? null,
      },
    });

    // T-183: Clean resume marker (session is terminal)
    removeResumeMarker(root);

    return `Session ${info.state.sessionId} ended (unrecoverable — invalid preCompactState: ${preCompactState ?? "null"}). Run "start" for a new session.`;
  });

  const pendingCancel = cancelHolder.pending;
  if (pendingCancel) {
    const done = completeCancellation(pendingCancel.key, Date.now(), pendingCancel.generation);
    if (!done) {
      return message +
        "\nNote: a new usage-limit stop superseded the cancelled auto-resume while this command ran. " +
        'Run "storybloq limit-status" to inspect it.';
    }
  }
  return message;
}

// ---------------------------------------------------------------------------
// session stop (ISS-036: admin stop for wedged sessions)
// ---------------------------------------------------------------------------

/**
 * Admin command to cleanly stop an active session. Releases ticket claim,
 * clears compact metadata, writes SESSION_END with admin_recovery.
 * CLI-only (not MCP) — autonomous agent cannot invoke.
 */
export async function handleSessionStop(root: string, sessionId?: string): Promise<string> {
  // Same deferred completion protocol as clear-compact: complete the ledger
  // cancel only AFTER SESSION_END commits (object holder so the closure
  // assignment survives TS narrowing to the post-lock completion).
  const cancelHolder: { pending: CancelStandDown | null } = { pending: null };
  const message = await withSessionLock(root, async () => {
    let info: ActiveSessionInfo | null = null;

    if (sessionId) {
      info = findSessionById(root, sessionId);
      if (!info) throw new Error(`Session ${sessionId} not found`);
    } else {
      info = findActiveSessionFull(root);
      if (!info) throw new Error("No active session found");
    }

    if (info.state.status !== "active") {
      throw new Error(`Session ${info.state.sessionId} is not active (status: ${info.state.status})`);
    }

    // Release ticket claim (best-effort, same as cancel)
    const ticketId = info.state.ticket?.id;
    let ticketReleased = false;
    if (ticketId) {
      try {
        const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");
        await withProjectLock(root, { strict: false }, async ({ state: projectState }) => {
          const ticket = projectState.ticketByID(ticketId);
          if (ticket && ticket.status === "inprogress") {
            const claim = (ticket as Record<string, unknown>).claimedBySession;
            const claimBlock = (ticket as Record<string, unknown>).claim;
            // ISS-778: strict ownership. Release only when this session owns the
            // claimedBySession stamp, or when the ticket carries no claim material
            // at all. The old `!claimedBySession` escape hatch released FOREIGN
            // CLI claims, which write claim{user,branch,since} but never set
            // claimedBySession.
            if (claim === info!.state.sessionId || (!claim && claimBlock == null)) {
              // ISS-759/ISS-652: delete the claim keys rather than writing
              // explicit nulls, so a released ticket carries no residual state.
              const { claimedBySession: _cb, claim: _cl, ...rest } = ticket as Record<string, unknown>;
              await writeTicketUnlocked({ ...rest, status: "open" as const } as typeof ticket, root);
              ticketReleased = true;
            }
          }
        });
      } catch { /* best-effort */ }
    }

    // Flag unfiled deferrals — drain is in guide.ts (not importable from CLI)
    // The deferralsUnfiled flag signals that manual issue filing is needed
    const hasUnfiledDeferrals = (info.state.pendingDeferrals ?? []).length > 0;

    // T-424: an admin stop also stands down any pending limit auto-resume.
    // Throws (leaving the session untouched) while a wake child is mid-spawn
    // or could not be confirmed terminated -- SESSION_END must never be
    // written under a live child.
    if (info.state.interruptionKind === "limit") cancelHolder.pending = await cancelLimitAutoResume(info);

    // Write SESSION_END
    const written = writeSessionSync(info.dir, {
      ...info.state,
      state: "SESSION_END",
      previousState: info.state.state,
      status: "completed" as const,
      terminationReason: "admin_recovery",
      deferralsUnfiled: hasUnfiledDeferrals,
      compactPending: false,
      compactPreparedAt: null,
      compactObservedAt: null,
      resumeBlocked: false,
      preCompactState: null,
      resumeFromRevision: null,
      ...CLEARED_LIMIT_FIELDS,
      ticket: undefined,
    });
    // T-260: Cross-process finalization (marker only, no PID kill)
    writeShutdownMarker(info.dir);

    appendEvent(info.dir, {
      rev: written.revision,
      type: "admin_stop",
      timestamp: new Date().toISOString(),
      data: { previousState: info.state.state, ticketId: ticketId ?? null, ticketReleased },
    });

    // T-183: Clean resume marker
    removeResumeMarker(root);

    return `Session ${info.state.sessionId} stopped.${ticketReleased ? ` Ticket ${ticketId} released to open.` : ticketId ? ` Ticket ${ticketId} may need manual cleanup.` : ""}`;
  });

  const pendingCancel = cancelHolder.pending;
  if (pendingCancel) {
    const done = completeCancellation(pendingCancel.key, Date.now(), pendingCancel.generation);
    if (!done) {
      return message +
        "\nNote: a new usage-limit stop superseded the cancelled auto-resume while this command ran. " +
        'Run "storybloq limit-status" to inspect it.';
    }
  }
  return message;
}

// ---------------------------------------------------------------------------
// session-limit-stop (StopFailure hook)  [T-424]
// ---------------------------------------------------------------------------

/** Best-effort waker spawn; module lands with the waker (dynamic import so the hook never hard-depends on it). */
async function spawnWakerBestEffort(): Promise<void> {
  try {
    const { spawnWakerIfNeeded } = await import("../../autonomous/waker.js");
    spawnWakerIfNeeded();
  } catch {
    // Waker respawn is opportunistic; housekeeping retries on the next CLI run.
  }
}

export interface SessionLimitStopOptions {
  readonly clientTaskId?: string;
  readonly cwd?: string;
  readonly transcriptPath?: string;
  readonly errorType?: string;
  readonly permissionMode?: string;
  /** Injected clock for tests. */
  readonly now?: number;
}

/**
 * StopFailure hook entry point. Records a usage-limit stop so the waker can
 * auto-resume at reset. Mirrors handleSessionCompactPrepare's contract:
 * silent no-op without .story/, stderr on real failures, ALWAYS exits 0
 * (a hook failure must never worsen an already-stopped session).
 *
 * Ledger-first intent protocol for autonomous sessions: a non-dispatchable
 * `preparing` record lands BEFORE session state is touched, then session prep
 * happens under the session lock, then the record CAS-activates to `stopped`.
 * A crash at any point leaves a globally discoverable intent for
 * reconcileLimitLedger. Lock hierarchy: the ledger lock is held only inside
 * the limit-ledger helpers, never across the session lock (intent -> release
 * -> session lock -> release -> activate).
 */
export async function handleSessionLimitStop(options: SessionLimitStopOptions = {}): Promise<void> {
  try {
    // The registered matcher is "rate_limit", so errorType is normally either
    // that or absent (older client not forwarding the field). Anything else
    // reached us through a hand-edited matcher: not our event.
    if (options.errorType !== undefined && options.errorType !== "rate_limit") return;

    const clientTaskId = normalizeClientTaskId(options.clientTaskId)
      ?? normalizeClientTaskId(process.env.CLAUDE_CODE_SESSION_ID);
    if (!clientTaskId) return; // No client session id => nothing to --resume later.

    const discovered = discoverProjectRoot(options.cwd);
    if (!discovered) return; // No .story/ -- silent no-op
    let root = discovered;
    try {
      root = realpathSync(discovered);
    } catch {
      // Canonicalization is best-effort; the discovered path still works.
    }

    if (isLimitResumeGloballyDisabled()) return;
    const config = readLimitResumeConfig(root);
    if (!config.enabled) return;

    const now = options.now ?? Date.now();

    // Reset time from the transcript tail. The format is undocumented, so this
    // is best-effort: no entry or unparseable banner => configured fallback.
    // Identity-filtered: the transcript path arrives from user-writable hook
    // stdin, so an entry naming ANOTHER session or project must not supply
    // this stop's reset schedule.
    let banner: ReturnType<typeof scanTranscriptTailForLimit> = null;
    try {
      // sessionId is the discriminating identity (unique per session); cwd is
      // deliberately not constrained here -- sessions legitimately run from
      // subdirectories of the project root.
      banner = scanTranscriptTailForLimit(options.transcriptPath, undefined, {
        sessionId: clientTaskId,
      });
    } catch {
      banner = null;
    }
    const reset = resolveResetAt(banner?.bannerText ?? null, {
      fallbackMs: config.fallbackResetMs,
      now: new Date(now),
    });

    // Classify autonomous-vs-plain: ANY active session owned by this client
    // task, INCLUDING expired-lease and already-COMPACT sessions (a re-limit
    // during a pending resume must stay autonomous, so findActiveSessionFull's
    // lease filter is wrong here).
    // `listAllSessionsDetailed`, not `listAllSessions` (ISS-897). The plain
    // one drops every session it cannot parse with a bare `continue`, and this
    // is an OWNERSHIP decision: a single bad field -- `startedAt: null` is
    // enough (post-ISS-907, optional scalars forgive null but required fields
    // still reject it) -- makes this task's own autonomous session vanish from
    // the list, `owned` comes back empty, and the limit stop is recorded as a
    // PLAIN session. That is the concealment this issue exists to close,
    // reached through a classifier rather than through a display.
    //
    // And it can THROW here, which needs stating precisely rather than as "the
    // old one could not". The old enumerator already rethrew every non-ENOENT
    // error, EACCES included -- so that case reached this command as an
    // uncaught throw and produced NO limit-stop record at all. What changed is
    // the ENOENT family: a dangling or removed sessions root used to answer
    // "empty project", which was the concealment, and now throws as well.
    //
    // So this catch is doing two different jobs. For the ENOENT family it keeps
    // the new fix from turning a concealed classification into no record; for
    // EACCES it repairs a pre-existing silent loss. Both matter because this
    // runs on a usage-limit stop: losing the record means the session is never
    // parked, the waker never spawns, and nothing anywhere says why. Recording
    // it as plain is wrong in a recoverable way; recording nothing is not.
    //
    // So: enumerate defensively, say so loudly, and continue to the same plain
    // path the old code reached silently.
    let all: ReturnType<typeof listAllSessionsDetailed>;
    try {
      all = listAllSessionsDetailed(root);
    } catch (err) {
      // Sanitized: the message carries the PATH, which is workspace-controlled
      // and can hold an ESC or a newline. The per-directory warning below
      // already does this; a raw interpolation here would let a project path
      // redraw the line reporting the limit stop.
      const detail = sanitizeDisplayText(err instanceof Error ? err.message : String(err));
      process.stderr.write(
        `[storybloq] limit stop: \`.story/sessions\` could not be enumerated ` +
          `(${detail}), so ownership could not be determined. ` +
          `Recording this stop as a PLAIN session. If an autonomous session is running it will not be parked; ` +
          `run \`storybloq session list\` to see why the directory could not be read.\n`,
      );
      all = { sessions: [], damaged: [], unavailable: [], incompatible: [] };
    }
    // ISS-899: a FIFTH copy of the ownership precedence lived here, found by the
    // architecture pin rather than by reading. Exactly equivalent: clientTaskId
    // is non-empty by the guard at the top of this function, so the caller task
    // always resolves and "same" means what the two hand-rolled branches meant.
    const limitStopCaller = ownerTaskForClient("claude", clientTaskId);
    const owned = all.sessions.filter((s) => {
      if (s.state.status !== "active") return false;
      return resolveSessionOwnership(s.state, limitStopCaller).kind === "same";
    });
    owned.sort((a, b) => (b.state.startedAt ?? "").localeCompare(a.state.startedAt ?? ""));
    const session = owned[0];

    // Be exact about what this can and cannot fix. An unreadable session may be
    // this task's, and there is no way to find out: the owner is recorded INSIDE
    // the file that will not parse. So the classification cannot be corrected
    // here, and parking such a session is impossible anyway -- this build can
    // neither read nor write its state.
    //
    // What was wrong was that it happened in SILENCE. A limit stop recorded as
    // `plain` over a damaged autonomous session leaves that session unparked
    // with nothing anywhere saying so, and the next session finds a stale
    // record it cannot explain. Naming the entries turns an invisible
    // misclassification into a visible one, which is the difference between a
    // bug an operator can act on and one they cannot see.
    if (!session) {
      const unreadable = [
        ...all.damaged.map((d) => d.sourceDir),
        ...all.unavailable.map((d) => d.sourceDir),
        ...all.incompatible.map((d) => d.sourceDir),
      ];
      if (unreadable.length > 0) {
        process.stderr.write(
          `[storybloq] limit stop: no readable autonomous session for this task, but ` +
            `${unreadable.length} session director${unreadable.length === 1 ? "y" : "ies"} could not be read ` +
            `(${boundedList(unreadable.map((u) => sanitizeDisplayText(u)), { noun: "directories" })}). ` +
            `Recording this stop as a PLAIN session. If one of those is this task's session it will not be parked; ` +
            `run \`storybloq session list\` to see why they could not be read.\n`,
        );
      }
    }

    let headHash: string | null = null;
    try {
      const head = await gitHead(root);
      if (head.ok) headHash = head.data.hash;
    } catch {
      headHash = null;
    }

    const baseInput = {
      clientTaskId,
      projectRoot: root,
      cwd: options.cwd ?? root,
      limitType: banner?.limitType ?? "unknown",
      transcriptPath: options.transcriptPath ?? null,
      detectedAt: now,
      resetAt: reset.at,
      resetSource: reset.source,
      rawBanner: banner?.bannerText ?? null,
      parserVersion: LIMIT_PARSER_VERSION,
      gitHead: headHash,
    } satisfies Partial<LimitStopInput>;

    if (!session) {
      // Plain session: single-phase ledger record, no session state to prepare.
      recordDirectStop({
        ...baseInput,
        storybloqSessionId: null,
        sessionType: "plain",
        mode: config.plainMode === "headless" ? "headless" : "notify",
      });
      await spawnWakerBestEffort();
      return;
    }

    // Autonomous session. FINALIZE stops are recorded notify-only (replaying
    // finalization is not proven idempotent; see T-425) -- the session is
    // still parked so it stays discoverable and explicitly recoverable.
    const resumeTarget = session.state.state === "COMPACT"
      ? session.state.preCompactState ?? session.state.state
      : session.state.state === "HANDOVER" ? "PICK_TICKET" : session.state.state;
    const isFinalize = resumeTarget === "FINALIZE";

    const intent = writePreparingIntent({
      ...baseInput,
      storybloqSessionId: session.state.sessionId,
      sessionType: "autonomous",
      mode: isFinalize ? "notify" : "headless",
      reasonCode: isFinalize ? "finalize_stop" : null,
    });

    // Deduplicated onto an existing intent/record (no owner token): its owner
    // (or reconciliation) owns session preparation. A NON-OWNER must not mutate
    // session state -- if it parked the session and the real owner then aborted
    // its intent, the parked session would have no ledger pointer (orphan). The
    // existing record already covers this stop episode; just ensure a waker.
    if (intent.ownerToken === null) {
      await spawnWakerBestEffort();
      return;
    }

    // Tracks whether prepareForLimitStop COMMITTED session state: past that
    // point the session is parked with this limitEventId, so any failure must
    // activate (never abort) the intent -- aborting would strand a parked
    // session with no ledger pointer, and a plain fallback would misfile it.
    let prepared = false;

    // Activate the intent to `stopped`; if the CAS is lost, REPAIR. This runs
    // UNDER the session lock, immediately after the session is committed-parked
    // under intent.limitEventId: holding the lock guarantees no concurrent
    // handler can re-park the session between the park and this repair, so
    // intent.limitEventId IS the session's current event. A newer ledger
    // generation may still have bumped past our CAS (writePreparingIntent needs
    // only the ledger lock, not the session lock), so activateIntent can lose
    // even here -- repairParkedSessionRecord then ensures a non-terminal record
    // names our event (bypassing the dedupe window, which would otherwise merge
    // onto the newer foreign-event record and keep ITS event, orphaning the
    // parked session).
    const ownerToken = intent.ownerToken; // non-null past the dedupe guard above
    const activateOrRepair = (): void => {
      if (activateIntent(intent.key, ownerToken, intent.generation)) return;
      const installed = repairParkedSessionRecord(
        {
          ...baseInput,
          storybloqSessionId: session.state.sessionId,
          sessionType: "autonomous",
          mode: isFinalize ? "notify" : "headless",
          reasonCode: isFinalize ? "finalize_stop" : null,
        },
        intent.limitEventId,
      );
      process.stderr.write(
        installed
          ? "[storybloq] limit-stop: refiled a fresh record for the parked session (activation CAS lost)\n"
          : "[storybloq] limit-stop: intent activation superseded; another handler owns this event's record\n",
      );
    };
    try {
      await withSessionLock(root, async () => {
        const current = findSessionById(root, session.state.sessionId);
        if (!current || current.state.status !== "active") {
          throw new Error(`session ${session.state.sessionId} no longer active`);
        }
        // Re-verify our intent immediately before writing session state: a
        // superseding generation (concurrent handler) must not be clobbered.
        // (Deduped non-owner handlers already returned above, so we always own
        // a token here and must prove it still owns the record before parking.)
        if (!verifyPreparingIntent(intent.key, ownerToken, intent.generation)) {
          throw new Error("limit-stop intent superseded before session prep");
        }
        prepareForLimitStop(current.dir, refreshLease(current.state), {
          expectedHead: headHash ?? undefined,
          permissionMode: options.permissionMode ?? null,
          resumeAt: reset.at,
          limitEventId: intent.limitEventId,
        });
        prepared = true;
        // The resume marker is a UX aid for /story recovery, not correctness:
        // best-effort AFTER the state commit, never a reason to abort it.
        try {
          writeResumeMarker(root, current.state.sessionId, {
            ticket: current.state.ticket,
            completedTickets: current.state.completedTickets,
            resolvedIssues: current.state.resolvedIssues,
            preCompactState: current.state.preCompactState ?? current.state.state,
          });
        } catch {
          // ignore
        }
        // Activate/repair the ledger while STILL holding the session lock, so
        // the ledger record and the just-parked session commit to the same
        // event atomically w.r.t. any concurrent re-park.
        activateOrRepair();
      });
    } catch (err) {
      if (prepared) {
        // Session state IS parked but the lock body threw after commit (e.g. the
        // lock release itself). This re-acquires a FRESH lock, so unlike the
        // in-lock primary path we can no longer assume the session is still
        // parked under intent.limitEventId: between the failed scope and this
        // re-acquisition another StopFailure may have re-parked it under a newer
        // event. Repair ONLY while the session is still limit-pending under OUR
        // event -- otherwise a newer handler (or reconciliation) owns it, and
        // installing our stale event would orphan the newer park. A failure to
        // re-acquire is swallowed (reconciliation is the final backstop).
        try {
          await withSessionLock(root, () => {
            const cur = findSessionById(root, session.state.sessionId);
            const stillOurs =
              cur != null &&
              cur.state.interruptionKind === "limit" &&
              cur.state.limitStopPending === true &&
              cur.state.limitEventId === intent.limitEventId;
            if (stillOurs) activateOrRepair();
          });
        } catch {
          // ignore -- reconciliation will repair from the persisted intent
        }
      } else {
        const aborted = abortIntent(intent.key, ownerToken, intent.generation);
        // Fall back to a notify-only plain record ONLY when we still owned
        // the intent: if the abort lost its CAS, a newer generation owns the
        // record and overwriting it would reclassify the newer autonomous
        // episode as a plain stop.
        if (aborted) {
          recordDirectStop({
            ...baseInput,
            storybloqSessionId: null,
            sessionType: "plain",
            mode: "notify",
          });
        }
      }
      process.stderr.write(
        `[storybloq] limit-stop: session prep failed (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }

    await spawnWakerBestEffort();
  } catch (err) {
    // Never throw, never exit non-zero: the session is already stopped and a
    // hook failure must not add noise or block the client.
    process.stderr.write(
      `[storybloq] limit-stop failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
