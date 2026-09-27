/**
 * CLI handlers for hook-driven compaction (ISS-032).
 *
 * - session-compact-prepare: PreCompact hook entry -- prepares session for compaction
 * - session-resume-prompt: SessionStart hook entry -- outputs resume instruction after compaction
 * - session-clear-compact: Admin escape hatch -- clears stale compact markers
 */
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import {
  findActiveSessionFull,
  findResumableSession,
  findSessionById,
  prepareForCompact,
  markCompactionObserved,
  writeSessionSync,
  withSessionLock,
  appendEvent,
  refreshLease,
  isLeaseExpired,
  withoutLimitKeys,
  isCompactParkStale,
  LIMIT_KEYS,
  type ActiveSessionInfo,
} from "../../autonomous/session.js";
import { WORKFLOW_STATES } from "../../autonomous/session-types.js";
import {
  checkSurvivingWakeAttempts,
  normalizeRetiredLimitPark,
  normalizeRetiredLimitParkLocked,
} from "../../autonomous/retired-limit-park.js";
import {
  normalizeClientTaskId,
  ownerTaskForClient,
  type StorybloqClient,
} from "../../autonomous/client-profile.js";
import { resolveSessionOwnership, callerMayAct } from "../../autonomous/session-ownership.js";
import { writeShutdownMarker } from "../../autonomous/liveness.js";
import { loadProject } from "../../core/project-loader.js";
import { writeResumeMarker, removeResumeMarker } from "../../autonomous/resume-marker.js";
import { findLatestHandover } from "../../federation/handover-utils.js";
import { join } from "node:path";
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
import {
  classifyPreCompact,
  classifySessionStart,
  isSubagentTranscriptPath,
  type ClassifyOptions,
  type SubagentCompactionVerdict,
  type SubagentHookSignal,
} from "../../autonomous/subagent-compaction.js";

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
  /** ISS-1307: PreCompact `trigger` ("auto" | "manual"). */
  readonly trigger?: string;
  /** ISS-1307: explicit subagent signals from hook stdin. */
  readonly subagent?: SubagentHookSignal;
  /** ISS-1307 test seams for the subagent classification. */
  readonly classify?: ClassifyOptions;
}

export async function handleSessionCompactPrepare(
  options: SessionCompactPrepareOptions = {},
): Promise<void> {
  const root = discoverProjectRoot(options.cwd);
  if (!root) return; // No .story/ -- silent no-op

  const client = options.client ?? "claude";
  const environmentTaskId = client === "codex"
    ? process.env.CODEX_THREAD_ID
    : process.env.CLAUDE_CODE_SESSION_ID;
  const clientTaskId = normalizeClientTaskId(options.clientTaskId)
    ?? normalizeClientTaskId(environmentTaskId);

  // ISS-1307: a subagent's compaction arrives with the parent's session id.
  // Decide it before anything records a compaction (intel pending mark, Bus
  // succession, session transition); on any doubt this is the parent's own.
  let verdict: SubagentCompactionVerdict | null = null;
  try {
    verdict = classifyPreCompact({
      client,
      trigger: options.trigger,
      subagent: options.subagent,
      transcriptPath: options.transcriptPath,
      sessionId: clientTaskId ?? undefined,
    }, options.classify);
  } catch {
    verdict = null;
  }
  if (verdict) {
    await recordSubagentCompactionIgnored(root, client, clientTaskId, verdict, {
      hook: "pre_compact",
      trigger: options.trigger ?? null,
    });
    return;
  }

  // T-499: mark the compaction pending for session intel BEFORE anything
  // that can stall. Reconciliation at the next entry point resolves it
  // against the transcript's own boundary record. Claude only: Codex has no
  // transcript to reconcile against.
  if (client === "claude" && clientTaskId) {
    try {
      const { publishCompactPending } = await import("../../core/session-intel/capture.js");
      publishCompactPending(root, clientTaskId, Date.now());
    } catch {
      // Best-effort; the boundary-driven path still catches the compaction.
    }
  }

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
      const found = findActiveSessionFull(root);
      if (!found) return; // No active session -- silent no-op

      // ISS-899: was one of five hand-rolled copies of the ownership
      // precedence. Behaviour is unchanged -- callerMayAct is exactly the old
      // `sameOwner || legacySameOwner || fullyUnownedLegacy`, including its
      // fail-closed treatment of a caller with no identity in BOTH via cases.
      const callerTask = ownerTaskForClient(client, clientTaskId);
      const ownership = resolveSessionOwnership(found.state, callerTask);

      if (!callerMayAct(ownership)) {
        process.stderr.write(
          `[storybloq] compact-prepare skipped: active session ${found.state.sessionId} ` +
          `is not owned by this ${client} task.\n`,
        );
        return;
      }

      // T-534: a legacy usage-limit park is normalised before this hook acts
      // on it; a failure refuses rather than compacting an unnormalised park.
      const retired = await normalizeRetiredLimitParkLocked(root, found.dir, found.state);
      if (retired.kind === "failed") {
        process.stderr.write(`[storybloq] compact-prepare skipped: ${retired.reason}\n`);
        return;
      }
      const active: ActiveSessionInfo = { ...found, state: retired.state };

      // prepareForCompact FIRST (fast state.json write -- ensures compactPending persisted)
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

      // THEN snapshot (slower, can fail -- compactPending is already set)
      try {
        const loadResult = await loadProject(root);
        const { saveSnapshot } = await import("../../core/snapshot.js");
        await saveSnapshot(root, loadResult);
      } catch {
        // Snapshot failure is recoverable -- compactPending is set, resume will work
      }
    });
  } catch (err) {
    // Lock acquisition or other failure -- emit stderr, exit 0
    process.stderr.write(`[storybloq] compact-prepare failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

}

/**
 * ISS-1307: the diagnostic trace of an ignored subagent compaction. Appended
 * only to the caller's own active session, with no state write. One lock
 * attempt, no wait: a subagent hook must not queue on the parent's lock, and
 * a busy lock drops the event with one stderr line. Never throws.
 */
async function recordSubagentCompactionIgnored(
  root: string,
  client: StorybloqClient,
  clientTaskId: string | null | undefined,
  verdict: SubagentCompactionVerdict,
  detail: { hook: "pre_compact"; trigger: string | null } | { hook: "session_start"; source: string | null },
): Promise<void> {
  try {
    // Nothing to record without an active session; take no lock for it.
    if (!findActiveSessionFull(root)) return;
    await withSessionLock(root, async () => {
      const active = findActiveSessionFull(root);
      if (!active) return;
      const ownership = resolveSessionOwnership(active.state, ownerTaskForClient(client, clientTaskId));
      if (!callerMayAct(ownership)) return;
      appendEvent(active.dir, {
        rev: active.state.revision,
        type: "subagent_compaction_ignored",
        timestamp: new Date().toISOString(),
        data: {
          ...detail,
          signal: verdict.signal,
          agentId: verdict.agentId === null ? null : sanitizeForContext(verdict.agentId, 128) || null,
          fill: verdict.fill,
        },
      });
    }, { retries: 0 });
  } catch (err) {
    process.stderr.write(
      `[storybloq] subagent compaction ignored; event not recorded: ${err instanceof Error ? err.message : String(err)}\n`,
    );
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
  readonly hookEventName?: string;
  // ISS-1307: subagent signals (additive). `agent_type` is deliberately not
  // read: a `claude --agent X` main session carries it on every hook.
  readonly agentId?: string;
  readonly trigger?: string;
  readonly subagent?: SubagentHookSignal;
}

export const HOOK_STDIN_DEFAULT_MAX_BYTES = 65536;

export async function readHookStdinContext(
  stream: NodeJS.ReadableStream & { isTTY?: boolean },
  timeoutMs = 200,
  opts: {
    /**
     * T-499: a UserPromptSubmit payload carries the whole prompt, so that
     * hook raises the cap to 1 MiB. The prompt field itself is never parsed.
     */
    readonly maxBytes?: number;
  } = {},
): Promise<SessionStartHookContext> {
  if (stream.isTTY) return {};
  const maxBytes = opts.maxBytes ?? HOOK_STDIN_DEFAULT_MAX_BYTES;
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
      if (bytes > maxBytes) {
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
      hook_event_name?: unknown;
      agent_id?: unknown;
      trigger?: unknown;
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
    const hookEventName = typeof parsed.hook_event_name === "string" && parsed.hook_event_name.length <= 64
      ? parsed.hook_event_name
      : undefined;
    const agentId = typeof parsed.agent_id === "string" && parsed.agent_id.length > 0 && parsed.agent_id.length <= 256
      ? parsed.agent_id
      : undefined;
    const trigger = typeof parsed.trigger === "string" && parsed.trigger.length > 0 && parsed.trigger.length <= 32
      ? parsed.trigger
      : undefined;
    const viaTranscriptPath = transcriptPath !== undefined && isSubagentTranscriptPath(transcriptPath);
    const subagent: SubagentHookSignal | undefined = agentId || viaTranscriptPath
      ? { ...(agentId ? { agentId } : {}), viaTranscriptPath }
      : undefined;
    return {
      ...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(hookEventName ? { hookEventName } : {}),
      ...(agentId ? { agentId } : {}),
      ...(trigger ? { trigger } : {}),
      ...(subagent ? { subagent } : {}),
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
    /** ISS-1307: explicit subagent signals from hook stdin. */
    subagent?: SubagentHookSignal;
    /** ISS-1307 test seams for the subagent classification. */
    classify?: ClassifyOptions;
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
    const client: StorybloqClient = options.codexHookJson ? "codex" : "claude";

    // ISS-1307: a subagent's compaction start is not the parent's. Decided
    // before the Bus succession is consumed and before any observed mark,
    // breadcrumb or resume message; on any doubt this is the parent's own.
    let verdict: SubagentCompactionVerdict | null = null;
    try {
      verdict = classifySessionStart({
        root,
        client,
        source: options.source,
        subagent: options.subagent,
        transcriptPath: options.transcriptPath,
        sessionId: clientTaskId,
      }, options.classify);
    } catch {
      verdict = null;
    }
    if (verdict) {
      await recordSubagentCompactionIgnored(root, client, clientTaskId, verdict, {
        hook: "session_start",
        source: options.source ?? null,
      });
      return;
    }

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
    let { stale } = match;
    const sessionId = info.state.sessionId;
    const callerTask = ownerTaskForClient(
      client,
      clientTaskId,
    );
    // ISS-899: the fourth copy of the precedence, and the one that gates a
    // STATE WRITE (markCompactionObserved below). Behaviour is unchanged:
    // verifiedSameOwner is exactly callerMayAct, and hasRecordedOwner is
    // "the resolver found an owner of either kind".
    let ownership = resolveSessionOwnership(info.state, callerTask);
    let hasRecordedOwner = ownership.kind !== "unowned";
    let verifiedSameOwner = callerMayAct(ownership);
    let leaseExpired = isLeaseExpired(info.state);
    const ticketLabel = (state: typeof info.state): string => sanitizeForContext(
      state.ticket?.displayId ?? state.ticket?.id ?? "The autonomous ticket",
      40,
    );
    let ticket = ticketLabel(info.state);

    // T-534: every park a verified owner would mark or be told to resume goes
    // through the normaliser first, with or without limit keys: a key-free park
    // can still have a retired wake attempt running it, and the normaliser
    // refuses that. Ownership is decided again on the state read under the
    // lock. A failure names why and gives no resume instruction, so nothing
    // resumes an unnormalised park or one a wake child may be running.
    if (verifiedSameOwner) {
      const retired = await normalizeRetiredLimitPark(root, sessionId, {
        mayAct: (state) => callerMayAct(resolveSessionOwnership(state, callerTask)),
      });
      if (retired.kind === "failed") {
        // One sentence per fact: a wake attempt still recorded for a session
        // with no limit key is not a park the retired auto-resume wrote.
        const cause = retired.cause;
        const fact =
          cause.kind === "recorded-attempt"
            ? cause.attemptId === null
              ? "a legacy usage-limit wake attempt may still be recorded for this session (limit-ledger.json is unreadable)"
              : `a legacy usage-limit wake attempt ${sanitizeForContext(cause.attemptId, 80)} is still recorded for this session (limit-ledger.json)`
            : cause.kind === "legacy-park"
              ? "it was stopped by the retired usage-limit auto-resume"
              : "it could not be read to check for the retired usage-limit auto-resume";
        writeResumeMessage(
          `Autonomous session ${sessionId} cannot resume yet: ${fact}. ${sanitizeForContext(retired.reason, 400)}\n`,
        );
        return;
      }
      // Adopt the returned state for either success kind: "unchanged" can mean
      // a concurrent normalisation (or resume) already rewrote the session, so
      // the discovery read above is stale. Everything below is recomputed.
      info = { ...info, state: retired.state };
      if (info.state.status !== "active" || info.state.state !== "COMPACT" || !info.state.compactPending) {
        // No longer a resumable park (resumed or ended meanwhile): no instruction.
        if ((options.codexHookJson && clientTaskId) || busMarker) writeResumeMessage("");
        return;
      }
      ownership = resolveSessionOwnership(info.state, callerTask);
      hasRecordedOwner = ownership.kind !== "unowned";
      verifiedSameOwner = callerMayAct(ownership);
      leaseExpired = isLeaseExpired(info.state);
      ticket = ticketLabel(info.state);
      // A park that still carries limit keys was not ours to normalise; keep
      // discovery's verdict for it. A normalised one follows the ordinary rule.
      stale = LIMIT_KEYS.some((k) => k in info.state) ? stale : isCompactParkStale(info.state);
    }

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

/**
 * Admin command to clear stale compact markers.
 * - Valid preCompactState: repairs compactPending, clears resumeBlocked, and refreshes compactPreparedAt.
 *   User must call resume for actual state restoration (HEAD validation runs there).
 * - Invalid preCompactState: ends session (SESSION_END + admin_recovery).
 * - T-534: a legacy usage-limit park is normalised first and refuses while a
 *   wake attempt may still run it. --force bypasses only a FINALIZE park whose
 *   landed commit git cannot classify, which recovers to IMPLEMENT.
 */
export async function handleSessionClearCompact(
  root: string,
  sessionId?: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  return withSessionLock(root, async () => {
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

    // T-534: a legacy usage-limit park is normalised first, refusing while a
    // wake attempt may still run it. --force bypasses only a FINALIZE park
    // whose landed commit git cannot classify, recovering it to IMPLEMENT.
    const retired = await normalizeRetiredLimitParkLocked(root, info.dir, info.state, { forceUnavailableGit: opts.force === true });
    if (retired.kind === "failed") throw new Error(retired.reason);
    const wasLimitPark = retired.kind === "normalized" && retired.transition !== "stripped";
    info = { ...info, state: retired.state };

    const preCompactState = info.state.preCompactState;
    const SAFE_RESUME_STATES = WORKFLOW_STATES.filter(s => s !== "COMPACT" && s !== "SESSION_END");
    const isValidState = preCompactState && SAFE_RESUME_STATES.includes(preCompactState as typeof SAFE_RESUME_STATES[number]);

    if (isValidState) {
      // Valid: repair the marker and keep the session discoverable for resume.
      writeSessionSync(info.dir, withoutLimitKeys({
        ...info.state,
        compactPending: true,
        resumeBlocked: false,
        compactPreparedAt: new Date().toISOString(),
        compactObservedAt: null,
      }));
      // T-534: say which way a retired FINALIZE park was normalised.
      const finalizeNote = !wasLimitPark || retired.kind !== "normalized"
        ? ""
        : retired.transition === "finalize-kept"
          ? "\nNote: this session stopped during FINALIZE and its item commit is in place; resume re-enters " +
            "FINALIZE at its recorded checkpoint and does not repeat the commit."
          : retired.transition === "finalize-recovered"
            ? "\nNote: this session stopped during FINALIZE and no item commit was confirmed; resume recovers " +
              "to IMPLEMENT with the code checkpoint reset."
            : "";
      const hasKnownLiveOwner = !isLeaseExpired(info.state) &&
        (!!info.state.ownerTask || !!info.state.claudeCodeSessionId);
      if (hasKnownLiveOwner) {
        return `Compact markers cleared for session ${info.state.sessionId}. Ownership was not changed. ` +
          "Resume from the recorded owner task. Recovery elsewhere must use the client's " +
          "explicit owner-gone-candidate confirmation flow." + finalizeNote;
      }
      return `Compact markers cleared for session ${info.state.sessionId}. Resume with:\n` +
        `storybloq_autonomous_guide {"sessionId": "${info.state.sessionId}", "action": "resume"}` + finalizeNote;
    }

    // Invalid: end session
    const written = writeSessionSync(info.dir, withoutLimitKeys({
      ...info.state,
      state: "SESSION_END",
      previousState: info.state.state,
      status: "completed" as const,
      terminationReason: "admin_recovery",
      compactPending: false,
      compactPreparedAt: null,
      compactObservedAt: null,
      resumeBlocked: false,
    }));
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

    return `Session ${info.state.sessionId} ended (unrecoverable -- invalid preCompactState: ${preCompactState ?? "null"}). Run "start" for a new session.`;
  });
}

// ---------------------------------------------------------------------------
// session stop (ISS-036: admin stop for wedged sessions)
// ---------------------------------------------------------------------------

/**
 * Admin command to cleanly stop an active session. Releases ticket claim,
 * clears compact metadata, writes SESSION_END with admin_recovery.
 * CLI-only (not MCP) -- autonomous agent cannot invoke.
 */
export async function handleSessionStop(root: string, sessionId?: string): Promise<string> {
  return withSessionLock(root, async () => {
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

    // T-534: SESSION_END is never written under a usage-limit wake attempt
    // the retired runtime may still be running for this session. Checked
    // before the ticket release so a refusal leaves everything untouched.
    // Keyed on the ledger, never on interruptionKind (a strip can remove the
    // key while an attempt still runs).
    {
      const attempts = checkSurvivingWakeAttempts(info.state.sessionId);
      if (attempts.kind === "held") throw new Error(attempts.reason);
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

    // Flag unfiled deferrals -- drain is in guide.ts (not importable from CLI)
    // The deferralsUnfiled flag signals that manual issue filing is needed
    const hasUnfiledDeferrals = (info.state.pendingDeferrals ?? []).length > 0;

    // Write SESSION_END
    const written = writeSessionSync(info.dir, withoutLimitKeys({
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
      ticket: undefined,
    }));
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
}

// ---------------------------------------------------------------------------
// session limit-stop (retired StopFailure hook)  [T-534 tombstone]
// ---------------------------------------------------------------------------

/**
 * T-534 tombstone. Installs that still carry the StopFailure hook land here:
 * the usage-limit auto-resume is retired, so this only runs the retirement
 * (which removes the hook itself), writes nothing to stdout and never fails.
 * No park, ledger record or waker is created.
 */
export async function handleSessionLimitStop(): Promise<void> {
  try {
    const { retireLimitAutoResumeBestEffort } = await import("../limit-retirement-entry.js");
    await retireLimitAutoResumeBestEffort(process.env.STORYBLOQ_VERSION ?? "0.0.0-dev");
  } catch {
    // Never throw, never exit non-zero: the session is already stopped.
  }
}
