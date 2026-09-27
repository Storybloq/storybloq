/**
 * T-499: `storybloq session intel` -- one call that tells an agent its
 * current context usage, the expected auto-compaction point and where that
 * number came from, plus the session facts the transcript carries.
 *
 * Works without `.story/` (transcript-only, read-only). CLI and MCP share
 * this handler so both surfaces return identical numbers.
 */

import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { LIFECYCLE_LOCK_BUDGET_MS } from "../../core/presence-enrichment.js";
import { isPresenceEnabled } from "../../presence/handler.js";
import { ensureCapture, type CaptureOutcome, type CaptureSource } from "../../core/session-intel/capture.js";
import { readSessionIntelConfig } from "../../core/session-intel/config.js";
import { claimImperativeEmission, findPresenceRecordAcrossWorktrees, newestHandoverAfter, readPresenceRecord, reconcileUnderLock, stampDerivedHandover, type ReconcileOutcome } from "../../core/session-intel/presence-bridge.js";
import { COMPACT_NEEDED_ADVICE, basisText, renderUsageAdvisory } from "../../core/session-intel/push.js";
import { sampleSession, type SessionIntelResult } from "../../core/session-intel/query.js";
import { authorizeTranscriptPath, locateTranscript } from "../../core/session-intel/transcript-locate.js";
import { scanTail } from "../../core/session-intel/transcript-scan.js";
import { classifySessionStart, type ClassifyOptions, type SubagentCompactionVerdict, type SubagentHookSignal } from "../../autonomous/subagent-compaction.js";

export interface SessionIntelOptions {
  readonly cwd?: string;
  readonly format?: "json" | "md";
  readonly sessionId?: string | null;
  readonly transcript?: string | null;
  readonly callerModel?: string | null;
  readonly full?: boolean;
  readonly clientTaskId?: string | null;
  readonly sampledBy?: "query" | "mcp-refresh";
  /** Test seams, threaded to the engine unchanged. */
  readonly projectsDir?: string;
  readonly userSettingsPath?: string;
  readonly fullBudgetBytes?: number;
}

export interface SessionIntelCommandResult {
  readonly output: string;
  readonly result: SessionIntelResult;
  readonly errorCode?: string;
}

/**
 * The same upward discovery every other command uses, so a call from a
 * project subdirectory finds the project (its capture, ledger, config and
 * handover state) instead of silently answering transcript-only. The
 * invocation cwd is kept for transcript lookup. Unreadable `.story/` reads
 * as no project.
 */
function projectRootFor(cwd: string): string | null {
  try { return discoverProjectRoot(cwd); } catch { return null; }
}

function pctText(p: number | null): string {
  return p === null ? "n/a" : `${(p * 100).toFixed(1)}%`;
}

export function formatSessionIntelMd(r: SessionIntelResult, root: string | null = null, recordRoot: string | null = null): string {
  const lines: string[] = ["# Session intel", ""];
  const p = r.pressure;
  if (!p || !r.usable) {
    lines.push(`Token pressure: unknown (${r.unusableReason ?? "no pressure available"})`);
  } else {
    const c = p.ceiling;
    lines.push(`Token pressure: ${p.state.toUpperCase()}${p.suppressedBy === "rate-limit" ? " (imperative rate-limited: shown recently)" : p.suppressedBy ? " (imperative suppressed by a recent handover)" : ""}`);
    lines.push(`- Context in use: ${p.contextTokens?.toLocaleString() ?? "n/a"} tokens (${pctText(p.pct)} of the expected auto-compact point)`);
    lines.push(`- Expected auto-compact at: ${c.ceiling === null ? "unknown" : Math.round(c.ceiling).toLocaleString()} tokens, source ${c.source}${c.confidence ? ` (${c.confidence} confidence)` : ""}`);
    lines.push(`- Basis: ${c.basis}`);
    if (c.conflict) lines.push(`- Conflict: ${c.conflict}`);
    lines.push(`- Headroom: ${p.headroom?.toLocaleString() ?? "n/a"} tokens; jump allowance ${p.jumpAllowance?.toLocaleString() ?? "n/a"} (${p.jumpAllowanceBasis})`);
    if (p.reason) lines.push(`- Why: ${p.reason}`);
    // ISS-1197 commit 2: compact-needed is checked first, so the diagnostic
    // surface never prints the handover imperative past the compact line.
    if (p.state === "compact-needed") lines.push("", COMPACT_NEEDED_ADVICE);
    else if (p.state === "imperative") lines.push("", "Write a handover now (storybloq handover create / storybloq_handover_create), then keep working in this same turn. The handover makes compaction safe: do not stop, do not defer the next step to a later turn, and do not ask the user whether to continue. Any auto-compaction that follows is expected and safe: the session continues through it, and one handover covers it.");
    else if (p.state === "advisory") lines.push("", "Plan a handover before the next large step.");
  }
  // T-501: reported on every call, whatever the pressure state, and never
  // stamped -- this surface is the diagnostic, not the push.
  if (p?.usageAdvisory) lines.push("", `Usage advisory: ${renderUsageAdvisory(p.usageAdvisory)}`);
  lines.push("");
  lines.push(`Session ${r.sessionId ?? "unknown"}: ${r.binding} (${r.bindingReason}); coverage ${r.coverage}, ${r.scannedBytes.toLocaleString()} bytes scanned${r.truncationReason ? `; ${r.truncationReason}` : ""}`);
  if (r.transcriptPath) lines.push(`Transcript: ${r.transcriptPath}`);
  const s = r.session;
  if (s) {
    const facts: string[] = [];
    if (s.startedAt) facts.push(`started ${s.startedAt}`);
    if (s.version) facts.push(`Claude Code ${s.version}`);
    if (s.entrypoint) facts.push(`entrypoint ${s.entrypoint}`);
    if (s.gitBranch) facts.push(`branch ${s.gitBranch}`);
    if (s.permissionMode) facts.push(`permissions ${s.permissionMode}`);
    if (s.effort) facts.push(`effort ${s.effort}`);
    if (s.aiTitle) facts.push(`title "${s.aiTitle}"`);
    if (s.slug) facts.push(`slug ${s.slug}`);
    if (s.bridgeSessionId) facts.push(`bridge ${s.bridgeSessionId}`);
    if (facts.length) lines.push(`Facts: ${facts.join("; ")}`);
    if (s.models.length) lines.push(`Models: ${s.models.map((m) => m.model).join(" -> ")}${p?.oneMillionFlag ? " (1M context)" : ""}`);
    if (s.turns) lines.push(`Turns observed: ${s.turns.assistant} assistant, ${s.turns.user} user (user count includes peer messages)`);
    lines.push(`Compactions observed: ${s.compactions.autoObserved} auto, ${s.compactions.manualObserved} manual${s.compactions.unknownObserved ? `, ${s.compactions.unknownObserved} unknown` : ""}${s.compactions.last ? `; last ${s.compactions.last.timestamp}` : ""}`);
  }
  if (r.callerModelMismatch) lines.push(`Caller model mismatch: caller says ${r.callerModelMismatch.caller}, transcript says ${r.callerModelMismatch.transcript ?? "unknown"}`);
  lines.push(`Provenance: era ${r.provenance.era ?? "none"}, capture ${r.provenance.capture ? `${r.provenance.capture.captureKind} (autoCompactWindow ${r.provenance.capture.autoCompactWindowAtStart ?? "absent"})` : "none"}`);
  lines.push(`Presence: ${r.presence}${r.presenceReason ? ` (${r.presenceReason})` : ""}`);
  // ISS-1211: a boundary that was scanned but not recorded is otherwise
  // invisible here, because the presence record can persist while the ledger
  // write is lock-busy or fails. Reported only when something went wrong.
  if (r.ledgerIngest === "lock-busy" || r.ledgerIngest === "failed") lines.push(`Boundary ledger: ${r.ledgerIngest}`);
  // ISS-1185: the record can live under a different root than the one
  // sampled (a git worktree). Diagnostic only -- reported when it differs.
  if (recordRoot !== null && recordRoot !== root) lines.push(`Record found under a different root: ${recordRoot} (sampled root: ${root ?? "none"})`);
  if (r.config.notes.length) lines.push(`Config notes: ${r.config.notes.join("; ")}`);
  return lines.join("\n");
}

export function handleSessionIntel(options: SessionIntelOptions = {}): SessionIntelCommandResult {
  const cwd = options.cwd ?? process.cwd();
  const root = projectRootFor(cwd);
  const result = sampleSession({
    root,
    cwd,
    sampledBy: options.sampledBy ?? "query",
    sessionId: options.sessionId ?? null,
    transcriptPath: options.transcript ?? null,
    callerModel: options.callerModel ?? null,
    full: options.full ?? false,
    explicitTaskId: options.clientTaskId ?? null,
    allowGlob: true,
    projectsDir: options.projectsDir,
    userSettingsPath: options.userSettingsPath,
    fullBudgetBytes: options.fullBudgetBytes,
  });
  // ISS-1185: a purely additive, read-only diagnostic. Never feeds back into
  // `sampleSession`'s own binding/persistence logic (untouched above): a
  // direct miss under `root` only probes the worktree candidates to REPORT
  // where the record actually lives, exactly the way `session intel` is
  // scoped on the ticket (find only, report only).
  let recordRoot: string | null = null;
  if (root && result.sessionId && !readPresenceRecord(root, result.sessionId)) {
    const match = findPresenceRecordAcrossWorktrees(root, result.sessionId);
    if (match) recordRoot = match.root;
  }
  const format = options.format ?? "md";
  const output = format === "json"
    ? JSON.stringify({ ok: true, data: { ...result, root, recordRoot } }, null, 2)
    : formatSessionIntelMd(result, root, recordRoot);
  // A Codex client short-circuits to "unknown" by design: an answer, not a
  // lookup failure. For Claude, no identity or no authorized transcript is.
  const notFound = result.client === "claude" && (result.sessionId === null || result.transcriptPath === null);
  return { output, result, errorCode: notFound ? "not_found" : undefined };
}

// ---------------------------------------------------------------------------
// session intel-start (SessionStart hook: startup | resume | clear | compact)
// ---------------------------------------------------------------------------

export interface SessionIntelStartOptions {
  readonly source?: string;
  readonly sessionId?: string | null;
  readonly cwd?: string;
  readonly transcriptPath?: string;
  readonly client?: "claude" | "codex";
  readonly now?: number;
  /** ISS-1307: explicit subagent signals from hook stdin; a subagent's start is not this session's. */
  readonly subagent?: SubagentHookSignal;
  /** Test seams. */
  readonly projectsDir?: string;
  readonly userSettingsPath?: string;
  readonly classify?: ClassifyOptions;
}

export interface SessionIntelStartOutcome {
  readonly status: "done" | "skipped";
  readonly reason: string | null;
  readonly capture: CaptureOutcome | null;
  readonly reconcile: ReconcileOutcome | null;
}

const CAPTURE_SOURCES: ReadonlySet<string> = new Set(["startup", "resume", "clear", "compact"]);

/**
 * Per-source capture at SessionStart. `startup` and `resume` are a new
 * process: capture the setting as `startup`. `clear` is the same process
 * with a new session id: transfer the era's entry with its ORIGINAL kind.
 * `compact` is the same process: preserve the capture, never re-read
 * settings, and reconcile with the backward boundary scan enabled. Silent
 * on every failure; the hook always exits 0.
 */
export function handleSessionIntelStart(options: SessionIntelStartOptions = {}): SessionIntelStartOutcome {
  const skipped = (reason: string): SessionIntelStartOutcome => ({ status: "skipped", reason, capture: null, reconcile: null });
  try {
    if ((options.client ?? "claude") !== "claude") return skipped("client is not Claude");
    if (options.subagent && (options.subagent.agentId || options.subagent.viaTranscriptPath)) return skipped("subagent hook");
    const source = options.source ?? "startup";
    if (!CAPTURE_SOURCES.has(source)) return skipped(`unknown source ${source}`);
    const sessionId = options.sessionId ?? null;
    if (!sessionId) return skipped("no session id");
    const root = projectRootFor(options.cwd ?? process.cwd());
    if (!root) return skipped("no project");
    if (!isPresenceEnabled(root)) return skipped("presence disabled");
    const cfg = readSessionIntelConfig(root);
    if (!cfg.enabled) return skipped("sessionIntel disabled");
    const now = options.now ?? Date.now();

    // ISS-1310: a subagent's compaction fires the parent's SessionStart(compact)
    // with the parent's ids. The ISS-1307 classifier decides; on any doubt,
    // including a throw, this is the parent's own compaction and is recorded.
    if (source === "compact") {
      let verdict: SubagentCompactionVerdict | null = null;
      try {
        verdict = classifySessionStart(
          { root, client: "claude", source, subagent: options.subagent, transcriptPath: options.transcriptPath, sessionId },
          { projectsDir: options.projectsDir, ...options.classify },
        );
      } catch {
        verdict = null;
      }
      if (verdict) return skipped(`subagent compaction (${verdict.signal})`);
    }

    const capture = ensureCapture({ root, sessionId, source: source as CaptureSource, now, userSettingsPath: options.userSettingsPath });
    if (source !== "compact") return { status: "done", reason: null, capture, reconcile: null };

    // The compaction just happened: the boundary may sit beyond the tail,
    // so reconciliation runs with the backward scan and the lifecycle budget.
    const record = readPresenceRecord(root, sessionId);
    const transcriptPath = authorizeTranscriptPath(options.transcriptPath, sessionId, options.projectsDir)
      ?? locateTranscript({ sessionId, cwd: options.cwd ?? process.cwd(), hint: record?.sessionIntel?.transcriptPath ?? null, allowGlob: false, projectsDir: options.projectsDir })?.path
      ?? null;
    const tail = transcriptPath ? scanTail({ path: transcriptPath, sessionId, era: null, revisionSeen: null, epochSince: null }) : null;
    const reconcile = reconcileUnderLock({ root, sessionId, cfg, tailBoundaries: tail?.boundaries ?? [], transcriptPath, source: "compact", now }, LIFECYCLE_LOCK_BUDGET_MS);
    return { status: "done", reason: null, capture, reconcile };
  } catch (err) {
    return skipped(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Stop-hook sample
// ---------------------------------------------------------------------------

export const STOP_SAMPLE_SOFT_BUDGET_MS = 2000;

export interface StopSampleOptions {
  readonly root: string;
  readonly sessionId: string | null;
  readonly cwd: string;
  readonly transcriptPath?: string | null;
  readonly now?: number;
  readonly softBudgetMs?: number;
  /** Test seams. */
  readonly projectsDir?: string;
  readonly userSettingsPath?: string;
}

export interface StopSampleOutcome {
  readonly status: "sampled" | "skipped";
  readonly reason: string | null;
  readonly capture: CaptureOutcome | null;
  readonly result: SessionIntelResult | null;
}

/**
 * The Stop hook's bounded sample: a late capture when the record has none
 * for the live era, then one lifecycle-bound tail sample persisted under the
 * ordering rule, with boundaries ingested into the ledger. Best-effort and
 * budgeted; the caller writes status.json regardless of what happens here.
 */
export function handleStopHookSample(options: StopSampleOptions): StopSampleOutcome {
  const skipped = (reason: string, capture: CaptureOutcome | null = null): StopSampleOutcome => ({ status: "skipped", reason, capture, result: null });
  try {
    if (!options.sessionId) return skipped("no session id");
    const { root, sessionId } = options;
    if (!isPresenceEnabled(root)) return skipped("presence disabled");
    if (!readSessionIntelConfig(root).enabled) return skipped("sessionIntel disabled");
    const startedAt = Date.now();
    const now = options.now ?? startedAt;
    const softMs = options.softBudgetMs ?? STOP_SAMPLE_SOFT_BUDGET_MS;
    const capture = ensureCapture({ root, sessionId, source: "stop", now, userSettingsPath: options.userSettingsPath });
    if (Date.now() - startedAt > softMs) return skipped("soft budget exceeded after capture", capture);
    const result = sampleSession({
      root,
      cwd: options.cwd,
      sampledBy: "stop-hook",
      explicitTaskId: sessionId,
      transcriptHint: options.transcriptPath ?? null,
      allowGlob: true,
      now,
      projectsDir: options.projectsDir,
      userSettingsPath: options.userSettingsPath,
      budget: { startedAt, softMs },
    });
    return { status: "sampled", reason: null, capture, result };
  } catch (err) {
    return skipped(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// session intel-prompt (UserPromptSubmit hook, synchronous)
// ---------------------------------------------------------------------------

export const PROMPT_SAMPLE_SOFT_BUDGET_MS = 500;
export const PROMPT_HOOK_EVENT_NAME = "UserPromptSubmit";

export interface SessionIntelPromptOptions {
  readonly sessionId?: string | null;
  readonly cwd?: string;
  readonly transcriptPath?: string;
  readonly client?: "claude" | "codex";
  readonly now?: number;
  readonly softBudgetMs?: number;
  /** Test seams. */
  readonly projectsDir?: string;
  readonly userSettingsPath?: string;
}

export interface SessionIntelPromptOutcome {
  readonly status: "emitted" | "silent" | "skipped";
  readonly reason: string | null;
  readonly capture: CaptureOutcome | null;
  readonly result: SessionIntelResult | null;
  /** The hook's stdout, or null when nothing is emitted. */
  readonly output: string | null;
}

/** The line the model reads on its next turn. Imperative and compact-needed only. */
export function renderPromptDirective(p: NonNullable<SessionIntelResult["pressure"]>): string {
  const pct = p.pct === null ? "n/a" : `${Math.round(p.pct * 100)}%`;
  const conf = p.ceiling.confidence ? `, ${p.ceiling.confidence} confidence` : "";
  const head = `[storybloq] Context pressure ${p.state.toUpperCase()}: ${pct} of the expected auto-compact point (${p.contextTokens?.toLocaleString() ?? "n/a"} tokens; source ${p.ceiling.source}${conf}).`;
  // ISS-1197 commit 2: this hook fires on EVERY prompt, so it is the surface
  // that would nag for handovers forever past the compact line.
  if (p.state === "compact-needed") return `${head} ${COMPACT_NEEDED_ADVICE}`;
  return `${head}${basisText(p.reason)} Write a handover now via storybloq_handover_create (or \`storybloq handover create\`), then keep working in this same turn. The handover makes compaction safe: do not stop, do not defer the next step to a later turn, and do not ask the user whether to continue. Any auto-compaction that follows is expected and safe: the session continues through it, and one handover covers it.`;
}

/**
 * ISS-1316: the one line the prompt hook shows in place of the imperative when
 * it stamps a handover the MCP server could not. After it the record is
 * stamped, so the ordinary re-arm gates keep the hook quiet.
 */
export function renderStampNotLanded(file: string): string {
  return `[storybloq] A handover was written (${file}) but its stamp did not land, most likely because the MCP server predates the build on disk: restart the client. Pressure is held at advisory; do not write another handover.`;
}

/**
 * The synchronous UserPromptSubmit sample: one bounded, lifecycle-bound tail
 * sample for the caller's own session (no glob, 500 ms soft budget), persisted
 * under the ordering rule. Emits `additionalContext` ONLY when the sample is
 * usable and imperative; every other outcome, including every failure, is
 * silent. The prompt text is never read.
 */
export function handleSessionIntelPrompt(options: SessionIntelPromptOptions = {}): SessionIntelPromptOutcome {
  const skipped = (reason: string, capture: CaptureOutcome | null = null): SessionIntelPromptOutcome => ({ status: "skipped", reason, capture, result: null, output: null });
  try {
    if ((options.client ?? "claude") !== "claude") return skipped("client is not Claude");
    const sessionId = options.sessionId ?? null;
    if (!sessionId) return skipped("no session id");
    const cwd = options.cwd ?? process.cwd();
    const root = projectRootFor(cwd);
    if (!root) return skipped("no project");
    if (!isPresenceEnabled(root)) return skipped("presence disabled");
    const cfg = readSessionIntelConfig(root);
    if (!cfg.enabled) return skipped("sessionIntel disabled");
    if (!cfg.promptHook) return skipped("promptHook disabled");
    const startedAt = Date.now();
    const now = options.now ?? startedAt;
    const softMs = options.softBudgetMs ?? PROMPT_SAMPLE_SOFT_BUDGET_MS;
    const capture = ensureCapture({ root, sessionId, source: "stop", now, userSettingsPath: options.userSettingsPath });
    if (Date.now() - startedAt > softMs) return skipped("soft budget exceeded after capture", capture);
    const result = sampleSession({
      root,
      cwd,
      sampledBy: "prompt-hook",
      explicitTaskId: sessionId,
      transcriptHint: options.transcriptPath ?? null,
      allowGlob: false,
      now,
      projectsDir: options.projectsDir,
      userSettingsPath: options.userSettingsPath,
      budget: { startedAt, softMs },
    });
    const pressure = result.pressure;
    // A push surface: only a BOUND caller (record exists, not ended, live era
    // equal to the record's) may reach the model. A read-only sample of the
    // same transcript (null era, ended id, era mismatch) can still be usable
    // and imperative, and stays silent.
    if (result.binding !== "bound") {
      return { status: "silent", reason: `unbound caller: ${result.bindingReason}`, capture, result, output: null };
    }
    if (!result.usable || !pressure || (pressure.state !== "imperative" && pressure.state !== "compact-needed")) {
      const quiet = pressure?.suppressedBy === "rate-limit" ? "state advisory (imperative rate-limited)" : `state ${pressure?.state ?? "unknown"}`;
      return { status: "silent", reason: result.usable ? quiet : (result.unusableReason ?? "unusable"), capture, result, output: null };
    }
    // ISS-1263: the imperative line is delivered at most once per re-arm
    // interval, claimed under the lock against the record this sample was
    // persisted into. The record must still hold THIS sample (a newer sample,
    // reset or handover since means the claim is not ours to take); a refusal
    // of any kind is silent for this prompt, and the next prompt samples again.
    if (pressure.state === "imperative") {
      const intel = readPresenceRecord(root, sessionId)?.sessionIntel ?? null;
      const ours = intel !== null && intel.lastSample?.sampledAt === pressure.sampledAt && intel.lastSample?.state === "imperative";
      // ISS-1316: a handover written after this session was last shown the
      // imperative, with no stamp on the record for this compaction, is a
      // stamp that did not land: an MCP server older than the build on disk
      // cannot stamp. Stamp it from the file and say so once, instead of
      // asking for another handover every re-arm interval.
      if (ours && intel.lastImperativeEmittedAt !== null && (intel.handoverWrittenAt === null || intel.handoverBoundaryAt !== intel.lastBoundaryAt)) {
        const emittedMs = Date.parse(intel.lastImperativeEmittedAt);
        const boundaryMs = intel.lastBoundaryAt === null ? -Infinity : Date.parse(intel.lastBoundaryAt);
        const found = Number.isFinite(emittedMs) ? newestHandoverAfter(root, Math.max(emittedMs, boundaryMs), now) : null;
        if (found) {
          const seen = { revision: intel.revision, lastBoundaryAt: intel.lastBoundaryAt, handoverWrittenAt: intel.handoverWrittenAt, lastImperativeEmittedAt: intel.lastImperativeEmittedAt };
          if (!stampDerivedHandover(root, sessionId, seen, found.mtimeMs, now)) {
            return { status: "silent", reason: "derived handover stamp not written", capture, result, output: null };
          }
          const output = JSON.stringify({ hookSpecificOutput: { hookEventName: PROMPT_HOOK_EVENT_NAME, additionalContext: renderStampNotLanded(found.file) } });
          return { status: "emitted", reason: "derived handover stamp", capture, result, output };
        }
      }
      if (!ours || !claimImperativeEmission(root, sessionId, { revision: intel.revision, lastBoundaryAt: intel.lastBoundaryAt, handoverWrittenAt: intel.handoverWrittenAt }, now, cfg.handoverRearmIntervalMs)) {
        return { status: "silent", reason: "imperative not claimed (rate-limited or superseded)", capture, result, output: null };
      }
    }
    const output = JSON.stringify({ hookSpecificOutput: { hookEventName: PROMPT_HOOK_EVENT_NAME, additionalContext: renderPromptDirective(pressure) } });
    return { status: "emitted", reason: null, capture, result, output };
  } catch (err) {
    return skipped(err instanceof Error ? err.message : String(err));
  }
}
