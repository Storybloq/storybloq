import { writeFileSync } from "node:fs";
import { tryReadFile } from "../util/file-io.js";
import { join } from "node:path";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { STORY_GITIGNORE_ENTRIES } from "../../core/init.js";
import {
  type StatusPayload,
} from "../../autonomous/session-types.js";
import { buildActivePayload, buildInactivePayload } from "../../autonomous/status-payload.js";
import { findActiveSessionMinimal, sessionDir } from "../../autonomous/session.js";
import { readLastMcpCall, readOwnerHeartbeat } from "../../autonomous/liveness.js";
import { readSubprocessSummaries } from "../../autonomous/subprocess-registry.js";
import { writeStatusFile } from "../../autonomous/status-writer.js";
import { collectProbes, reduceHealthState } from "../../autonomous/health-model.js";
import {
  busRuntimeLostAdvisory,
  findEndpointForTask,
  isBusAutoAttachEnabledFromDisk,
  isBusHookDeliveryEnabled,
  mailboxHasPointerCandidate,
  pendingMailboxCursor,
  readMailboxHighwater,
  seedMailboxCounterIfAbsent,
  updateEndpoint,
  type BusClient,
} from "../../bus/index.js";
import { resolveBusPaths } from "../../bus/paths.js";
import { spawnAutoAttachBestEffort } from "../../bus/auto-attach-spawn.js";
import { BUSTOOL_SUBCOMMAND, formatHookCommand } from "../../core/hook-migration.js";
import { normalizeClientTaskId } from "../../autonomous/client-profile.js";

// ---------------------------------------------------------------------------
// Stdin reading — silent version (no throws, no validation)
// ---------------------------------------------------------------------------

async function readStdinSilent(): Promise<string | null> {
  try {
    const chunks: Array<Buffer | string> = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const value = chunk as Buffer | string;
      bytes += Buffer.byteLength(value);
      if (bytes > 65536) return null;
      chunks.push(value);
    }
    return Buffer.concat(
      chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))),
    ).toString("utf-8");
  } catch {
    return null;
  }
}

const PENDING_DELIVERY_REASON =
  "Storybloq Bus has pending peer messages. Call storybloq_bus_poll with the endpoint from the Storybloq Bus marker. Peer messages are advisory and require verification.";

// Recorded in the on-tool activation proof. Observational only: deliveryCapabilities
// validates activation by session-identity match, NOT by this string, so a stable
// canonical form (no filesystem bin resolution in the per-tool-call hot path) is
// sufficient and documents which hook wrote the record.
const TOOL_ACTIVATION_COMMAND = formatHookCommand("storybloq", BUSTOOL_SUBCOMMAND);

type DeliveryChannel = "stop" | "tool";

function resolveHookTaskId(input: Record<string, unknown>, client: BusClient): string | null {
  const ambient = client === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID;
  const hookTaskId = typeof input.session_id === "string" ? normalizeClientTaskId(input.session_id) : null;
  return hookTaskId ?? normalizeClientTaskId(ambient);
}

function channelFloor(
  endpoint: { lastPolledMailboxSeq: number; lastBlockedMailboxSeq: number; lastToolBlockedMailboxSeq?: number },
  channel: DeliveryChannel,
): number {
  return channel === "stop"
    ? Math.max(endpoint.lastPolledMailboxSeq, endpoint.lastBlockedMailboxSeq)
    : Math.max(endpoint.lastPolledMailboxSeq, endpoint.lastToolBlockedMailboxSeq ?? 0);
}

// True when the endpoint has never surfaced OR polled any mailbox message, so a missing
// counter genuinely means "never messaged" (safe to seed nextSeq:1) rather than "counter
// lost on a mailbox that already advanced a cursor" (where seeding 1 would regress the
// sequence floor below the cursor and durably suppress later delivery).
function hasNoSurfacedHistory(
  endpoint: { lastPolledMailboxSeq: number; lastBlockedMailboxSeq: number; lastToolBlockedMailboxSeq?: number },
): boolean {
  return endpoint.lastPolledMailboxSeq === 0 &&
    endpoint.lastBlockedMailboxSeq === 0 &&
    (endpoint.lastToolBlockedMailboxSeq ?? 0) === 0;
}

// Shared claim core for both delivery channels. Resolves the task-owned endpoint,
// reads the pending mailbox cursor (fold-verified, ownership proven under lock), and
// -- when a message is newer than THIS channel has already surfaced -- advances the
// channel's OWN block high-water and returns the advisory reason. The two channels
// keep separate high-waters (lastBlockedMailboxSeq for stop, lastToolBlockedMailboxSeq
// for tool) so the best-effort on-tool channel never suppresses the reliable Stop
// channel at turn end; a real poll advances lastPolledMailboxSeq, clearing both. The
// tool channel additionally stamps activation proof once per session (on both the
// pending AND the empty branch), but only when a write is already warranted, so the
// steady-state empty tool path does no endpoint write.
async function claimBusPendingDelivery(
  root: string,
  client: BusClient,
  clientTaskId: string,
  channel: DeliveryChannel,
): Promise<{ reason: string } | null> {
  const endpoint = await findEndpointForTask(root, client, clientTaskId);
  if (!endpoint) return null;

  const needStamp = channel === "tool" &&
    (endpoint.toolHookActivation == null || endpoint.toolHookActivation.taskId !== clientTaskId);

  let pending: { cursor: number; count: number };
  try {
    pending = await pendingMailboxCursor(root, endpoint.endpointId, clientTaskId);
  } catch {
    // Ownership could not be proven under lock (endpoint rebound/retired between
    // lookup and read); the hook fails open.
    return null;
  }

  const wouldBlock = pending.count > 0 && pending.cursor > channelFloor(endpoint, channel);
  if (!needStamp && !wouldBlock) return null; // nothing to persist

  let claimed = false;
  const now = new Date().toISOString();
  await updateEndpoint(root, endpoint.endpointId, (current) => {
    if (current.retiredAt || current.client !== client || current.clientTaskId !== clientTaskId) return current;
    let next = current;
    if (channel === "tool" &&
        (current.toolHookActivation == null || current.toolHookActivation.taskId !== clientTaskId)) {
      next = { ...next, toolHookActivation: { taskId: clientTaskId, hookCommand: TOOL_ACTIVATION_COMMAND, updatedAt: now } };
    }
    if (pending.count > 0 && pending.cursor > channelFloor(current, channel)) {
      claimed = true;
      next = channel === "stop"
        ? { ...next, lastBlockedMailboxSeq: pending.cursor, lastSeenAt: now }
        : { ...next, lastToolBlockedMailboxSeq: pending.cursor, lastSeenAt: now };
    }
    return next;
  });
  if (!claimed) return null;
  return { reason: PENDING_DELIVERY_REASON };
}

// T-430: per-turn in-session retry uses the shared convergence predicate (the same one the
// SessionStart hook uses), re-exported here under its retry-facing name. A join can commit while
// materialization or delivery convergence fails (endpoint present but session degraded), so
// gating retry only on "no endpoint" would starve the session until the next SessionStart.
// Best-effort, read-only, off the critical path; the child's try-lock is the sole concurrency
// authority. Exported for direct unit testing.
export { autoAttachConvergenceNeeded as autoAttachRetryNeeded } from "../../bus/auto-attach-gate.js";
import { autoAttachConvergenceNeeded } from "../../bus/auto-attach-gate.js";

// T-430 in-session retry -- deliberately Stop-only AND Claude-only:
//  - Stop-only: it must never run on the PostToolUse path, which fires on EVERY tool call;
//    adding a retry probe there would double that hook's per-call I/O. Only claimBusStopDelivery
//    invokes it.
//  - Claude-only: Claude's hook surface is always claude_cli, so no process-ancestry (ps) probe
//    is ever needed. A Codex retry would have to run detectClientSurface (ps) on every Stop,
//    blocking the hook; Codex instead heals at the next SessionStart, where the surface is
//    resolved once from intact ancestry. This keeps the Stop path free of any subprocess.
// Best-effort, read-only, off the critical path; never throws.
async function maybeSpawnAutoAttachRetry(
  root: string,
  input: Record<string, unknown>,
  client: BusClient,
): Promise<void> {
  if (client !== "claude") return;
  try {
    if (!await isBusAutoAttachEnabledFromDisk(root)) return;
    const clientTaskId = resolveHookTaskId(input, client);
    if (!clientTaskId) return;
    if (!await autoAttachConvergenceNeeded(root, client, clientTaskId)) return;
    await spawnAutoAttachBestEffort({ root, client, clientTaskId, surface: "claude_cli", nowMs: Date.now() });
  } catch {
    // Retry is best-effort; it must never affect the delivery hook's outcome.
  }
}

export async function claimBusStopDelivery(
  root: string,
  input: Record<string, unknown>,
  client: BusClient,
): Promise<{ decision: "block"; reason: string } | null> {
  // The Stop re-entrancy guard runs FIRST: when Claude re-fires the Stop hook with
  // stop_hook_active, we must return immediately and do no retry work (a re-entrant Stop is
  // not a fresh turn boundary).
  if (input.stop_hook_active === true) return null;
  await maybeSpawnAutoAttachRetry(root, input, client);
  if (!await isBusHookDeliveryEnabled(root, client)) return null;
  const clientTaskId = resolveHookTaskId(input, client);
  if (!clientTaskId) return null;
  const claim = await claimBusPendingDelivery(root, client, clientTaskId, "stop");
  return claim ? { decision: "block", reason: claim.reason } : null;
}

// PostToolUse is a Claude-only hook surface. It fires on EVERY tool call, so the
// cheap gate runs first: a lock-free readMailboxHighwater compared against the tool
// channel's high-water (from the unlocked endpoint read). When nothing is newer AND
// activation is already recorded for this session, skip entirely -- no fold, no lock,
// no write. Otherwise escalate to the shared claim core (which folds, blocks, and
// stamps activation as warranted).
//
// A missing counter.json (`known:false`) is NOT silently treated as "nothing new":
// that would let a counter deleted while a pointer survives suppress on-tool delivery
// forever (a false negative the reliable Stop channel would still catch, but the gate
// must not manufacture). Instead a lock-free mailboxHasPointerCandidate scan
// disambiguates -- a present-and-empty mailbox short-circuits (still no lock), while a
// surviving pointer, or a missing/symlinked/unreadable mailbox (which throws), escalates
// to the authoritative claim. To keep this off the per-tool-call hot path, a
// present-and-empty first check seeds counter.json (create-if-absent) so every later
// tool call reads a known high-water instead of re-scanning the directory.
export async function claimBusToolDelivery(
  root: string,
  input: Record<string, unknown>,
): Promise<{ reason: string } | null> {
  const client: BusClient = "claude";
  // NOTE: the auto-attach retry is deliberately NOT invoked here. PostToolUse fires on every
  // tool call; the retry lives only on the Stop path (see maybeSpawnAutoAttachRetry) so this
  // hot path stays a single lock-free high-water compare.
  if (!await isBusHookDeliveryEnabled(root, client)) return null;
  const clientTaskId = resolveHookTaskId(input, client);
  if (!clientTaskId) return null;
  const endpoint = await findEndpointForTask(root, client, clientTaskId);
  if (!endpoint) return null;

  const activated = endpoint.toolHookActivation != null && endpoint.toolHookActivation.taskId === clientTaskId;
  let newer: boolean;
  try {
    const paths = await resolveBusPaths(root, false);
    const highwater = await readMailboxHighwater(paths, endpoint.endpointId);
    if (highwater.known) {
      newer = highwater.highwater > channelFloor(endpoint, "tool");
    } else {
      // No counter.json. Disambiguate lock-free via the pointer scan.
      newer = await mailboxHasPointerCandidate(paths, endpoint.endpointId);
      // Seed counter.json (-> single-read fast path) ONLY for a genuinely never-surfaced
      // endpoint: present-and-empty mailbox AND every delivery cursor still zero. A
      // missing counter on an endpoint that already advanced a cursor is counter LOSS on
      // an established mailbox, not a never-messaged one; seeding nextSeq:1 there would
      // let the next send allocate a seq BELOW the old cursor and be suppressed forever by
      // both hook channels. In that case leave the counter unknown and escalate (the
      // scan runs each call until the counter is legitimately reconstructed by a send).
      if (!newer && hasNoSurfacedHistory(endpoint)) {
        await seedMailboxCounterIfAbsent(paths, endpoint.endpointId);
      }
    }
  } catch {
    newer = true; // unsure (unreadable counter / missing mailbox) -> escalate toward surfacing
  }
  if (activated && !newer) return null; // steady-state fast path: no fold, no lock, no write

  // PostToolUse must NEVER use the Stop block contract, so this path returns a
  // reason-only advisory; the envelope (continue:true + additionalContext) is built
  // exclusively in handleBusToolHook.
  const claim = await claimBusPendingDelivery(root, client, clientTaskId, "tool");
  return claim ? { reason: claim.reason } : null;
}

// Resolve once the write is flushed to the OS so `process.exit` never truncates the
// hook envelope (a malformed additionalContext JSON would break the client's parse).
function writeStdoutFlushed(text: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

/**
 * PostToolUse (on-tool) hook handler -- T-427. Fires after EVERY tool call, so it is
 * deliberately minimal: read stdin, discover the project, run the cheap-gated
 * on-tool claim, and, only when peer mail is pending, inject the advisory prompt via
 * the documented PostToolUse envelope (`continue:true` +
 * `hookSpecificOutput.additionalContext`) at exit 0. It NEVER blocks or stops the
 * turn (no exit 2, no decision:block) and NEVER throws -- a broken Bus must not
 * interfere with tool calls. Standalone: does NOT load ProjectState or write status.
 */
export async function handleBusToolHook(): Promise<void> {
  try {
    // TTY -- manual invocation with no piped hook payload; nothing to do.
    if (process.stdin.isTTY) {
      process.exit(0);
    }
    const raw = await readStdinSilent();
    if (raw !== null && raw !== "") {
      let input: Record<string, unknown> | null = null;
      try {
        input = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        input = null;
      }
      const cwd = input?.cwd;
      if (input && typeof cwd === "string" && cwd) {
        const root = discoverProjectRoot(cwd);
        if (root) {
          const decision = await claimBusToolDelivery(root, input);
          if (decision) {
            await writeStdoutFlushed(JSON.stringify({
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: decision.reason,
              },
            }) + "\n");
          }
        }
      }
    }
  } catch {
    // Never crash a tool call.
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Status payloads
// ---------------------------------------------------------------------------

function inactivePayload(): StatusPayload {
  return buildInactivePayload();
}

/**
 * EXPORTED for test. This is the fourth consumer of the step-7b heartbeat
 * migration and was the only one with no test that could have failed: a revert
 * to the pre-migration shape compiled cleanly and broke nothing, because
 * `readAliveTimestamp` is still exported and `collectProbes`'s extra parameter
 * is optional. It reads the heartbeat, last-MCP-call and subprocess artifacts
 * from disk, so it is not pure, but it IS deterministic over the supplied
 * snapshot plus that on-disk fixture. That is what makes it testable, and
 * exporting it is the difference between the migration being pinned and merely
 * being present.
 */
export function activePayload(session: Parameters<typeof buildActivePayload>[0], root: string): StatusPayload {
  const sDir = sessionDir(root, session.sessionId);
  const lastMcpCall = readLastMcpCall(sDir);
  // T-450 step 7b.4: same posture as status-writer -- the OWNER's heartbeat,
  // with `unusable` surfaced as an explicit unknown rather than folded into
  // absence. The generation comes from the session state this payload is being
  // BUILT FROM, not from a second read of state.json: a takeover landing
  // between the lookup and here would otherwise have the heartbeat describing a
  // different owner than the rest of the payload.
  const heartbeat = readOwnerHeartbeat(sDir, session as { heartbeatGeneration?: unknown });
  const subprocesses = readSubprocessSummaries(sDir);
  // The SAME snapshot, for the same reason: a takeover landing between the
  // lookup and here would otherwise leave `alive` describing one owner and
  // `healthState` describing another, inside one payload.
  const probes = collectProbes(sDir, undefined, session as unknown as Record<string, unknown>);
  const healthState = reduceHealthState(probes);
  return buildActivePayload(session, {
    lastMcpCall,
    alive: heartbeat.kind === "unusable" ? null : heartbeat.kind === "alive",
    runningSubprocesses: subprocesses.length > 0 ? subprocesses : null,
    healthState,
  });
}

// ---------------------------------------------------------------------------
// Gitignore — ensure ephemeral entries are gitignored
// ---------------------------------------------------------------------------

function ensureGitignore(root: string): void {
  const gitignorePath = join(root, ".story", ".gitignore");

  const readResult = tryReadFile(gitignorePath);
  let existing = readResult.ok ? readResult.content : "";

  const lines = existing.split("\n").map((l) => l.trim());
  const missing = STORY_GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;

  let content = existing;
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  content += missing.join("\n") + "\n";
  try {
    writeFileSync(gitignorePath, content, "utf-8");
  } catch {
    // Best-effort — don't block status writing
  }
}

// ---------------------------------------------------------------------------
// T-424: limit auto-resume evidence + opportunistic waker respawn
// ---------------------------------------------------------------------------

/**
 * A Stop hook firing means this session just completed a successful turn --
 * external evidence that its usage limit is no longer blocking. Best-effort
 * marks the matching ledger record `resumed` and respawns the waker if other
 * records still pend (the reboot/crash recovery path). Gated on a lockless
 * ledger probe so the hot path stays fast when no limit records exist.
 *
 * The 30s detection grace protects against a queued Stop event from the
 * session's LAST successful turn landing after the StopFailure record: for
 * autonomous records reconciliation would re-arm, but plain `resumed` is
 * terminal and the notify would be silently lost.
 */
async function markLimitEvidenceAndRespawn(clientTaskId: string | null): Promise<void> {
  try {
    const { hasPendingLimitRecords, peekLimitRecord, markResumed, limitRecordKey } =
      await import("../../core/limit-ledger.js");
    if (!hasPendingLimitRecords()) return;
    if (clientTaskId) {
      const key = limitRecordKey(clientTaskId);
      // Lockless peek: the Stop hook must never wait on the ledger lock for a
      // read (markResumed below is the CAS'd authority, and IT is bounded).
      const rec = peekLimitRecord(key);
      // Status whitelist mirrors markResumed's: NEVER touch a `preparing`
      // intent (during ledger-first detection the intent exists BEFORE the
      // session is parked, and marking it resumed would destroy the
      // detector's activation), nor cancelling/manual/terminal/resuming
      // records. AND never while an attempt lingers: a preserved attempt names
      // a wake child whose death is unconfirmed (an interactive takeover
      // async-SIGTERM'd our displaced child without waiting), so terminalizing
      // here would orphan a possibly-live child -- markResumed refuses this
      // too, but skipping the call avoids the lock entirely.
      const eligible =
        (rec?.status === "stopped" || rec?.status === "deferred" || rec?.status === "interactive") &&
        rec.attempt == null;
      if (rec && eligible && Date.now() - rec.detectedAt > 30_000) {
        // For autonomous records the ONLY authoritative resume evidence is the
        // matching session leaving its limit-pending COMPACT state: a Stop
        // event from a turn that never touched the guide (or a delayed
        // pre-limit Stop) must not terminalize the record. Plain records have
        // no session state; the completed turn plus the 30s detection grace is
        // the evidence. Both paths CAS on the generation this read observed,
        // so a concurrent StopFailure's new episode is never marked by us.
        let sessionEvidence = true;
        if (rec.sessionType === "autonomous" && rec.storybloqSessionId) {
          const { readSessionSnapshot } = await import("../../autonomous/waker.js");
          const snap = readSessionSnapshot(rec.projectRoot, rec.storybloqSessionId);
          // undefined (unreadable) or null (gone) => leave for reconciliation.
          // ANY limit-pending park blocks the mark -- even under a different
          // limitEventId, which just means a newer episode is mid-detection
          // (its record transition belongs to that handler/reconciliation,
          // not to this delayed Stop event).
          sessionEvidence =
            snap != null &&
            !(snap.compactPending && snap.interruptionKind === "limit");
        }
        if (sessionEvidence) {
          // Short lock deadline: the Stop hook must never stall behind ledger
          // contention; a missed mark is healed by reconciliation.
          markResumed(key, rec.generation, Date.now(), { deadlineMs: 250 });
        }
      }
    }
    const { spawnWakerIfNeeded } = await import("../../autonomous/waker.js");
    spawnWakerIfNeeded();
  } catch {
    // Best-effort — never delay or fail the Stop hook.
  }
}

// ---------------------------------------------------------------------------
// Write status.json
// ---------------------------------------------------------------------------

function writeStatus(root: string, payload: StatusPayload): void {
  ensureGitignore(root);
  const withWriter = { ...payload, lastWrittenBy: "hook" as const };
  writeStatusFile(root, withWriter as StatusPayload);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Stop hook handler — writes .story/status.json with current session state.
 *
 * Fast, standalone. Does NOT load ProjectState. Target <50ms (excluding Node startup).
 * Never exits non-zero. Never throws.
 */
export async function handleHookStatus(options: { client?: BusClient } = {}): Promise<void> {
  try {
    // TTY — manual invocation (no pipe). Scan for active session same as piped path.
    if (process.stdin.isTTY) {
      const root = discoverProjectRoot();
      if (root) {
        const session = findActiveSessionMinimal(root);
        const payload = session ? activePayload(session, root) : inactivePayload();
        writeStatus(root, payload);
      }
      process.exit(0);
    }

    // Read stdin (null = error reading, empty = no data)
    const raw = await readStdinSilent();
    if (raw === null || raw === "") {
      // Can't determine project — preserve last good status
      process.exit(0);
    }

    // Parse
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Unparsable — preserve last good status
      process.exit(0);
    }

    // Guard: stop_hook_active
    if (input!.stop_hook_active === true) {
      process.exit(0);
    }

    // Must have cwd
    const cwd = input!.cwd;
    if (typeof cwd !== "string" || !cwd) {
      process.exit(0);
    }

    // Discover project root
    const root = discoverProjectRoot(cwd);
    if (!root) {
      process.exit(0);
    }

    // Scan for active session
    const session = findActiveSessionMinimal(root);
    const payload = session ? activePayload(session, root) : inactivePayload();
    writeStatus(root, payload);

    // T-424: turns are evidence a limit stop cleared; also the waker respawn hook.
    const hookTaskId = typeof input!.session_id === "string" ? normalizeClientTaskId(input!.session_id) : null;
    await markLimitEvidenceAndRespawn(hookTaskId);

    // T-428: advise (STDERR only, never bare stdout) when this checkout's Bus
    // runtime was deleted. The delivery claim's own gate closes after a wipe (the
    // hook-policy file lived under the deleted `.story/bus/`), so this runs first.
    // Fail-open + cheap: the advisory returns null for a healthy or never-set-up Bus.
    try {
      const advisory = await busRuntimeLostAdvisory(root);
      if (advisory) process.stderr.write(advisory + "\n");
    } catch {
      // Best-effort; the Stop hook must never fail on the advisory.
    }

    const decision = await claimBusStopDelivery(root, input, options.client ?? "claude");
    if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
  } catch {
    // Catch-all — never crash
  }

  process.exit(0);
}
