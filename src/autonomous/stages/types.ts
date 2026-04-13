import type {
  FullSessionState,
  GuideReportInput,
} from "../session-types.js";
import { writeSessionSync, appendEvent } from "../session.js";
import { killSidecar, writeShutdownMarker } from "../liveness.js";
import { writeEvent, markEnded } from "../telemetry-writer.js";
import { refreshStatusForSession } from "../status-writer.js";
import { loadProject } from "../../core/project-loader.js";
import type { ProjectState } from "../../core/project-state.js";

// ---------------------------------------------------------------------------
// Stage result — returned by enter() when the stage needs Claude to act
// ---------------------------------------------------------------------------

export interface StageResult {
  readonly instruction: string;
  readonly reminders?: readonly string[];
  readonly contextAdvice?: string;
  readonly transitionedFrom?: string;
}

// ---------------------------------------------------------------------------
// Stage advance — returned by report() and optionally by enter()
// ---------------------------------------------------------------------------

export type StageAdvance =
  | { action: "advance" }
  | { action: "advance"; result: StageResult }
  | { action: "retry"; instruction: string; reminders?: readonly string[] }
  | { action: "back"; target: string; reason: string }
  | { action: "goto"; target: string }
  | { action: "goto"; target: string; result: StageResult };

// ---------------------------------------------------------------------------
// Type guard — discriminates StageResult from StageAdvance
// ---------------------------------------------------------------------------

export function isStageAdvance(value: StageResult | StageAdvance): value is StageAdvance {
  return "action" in value;
}

// ---------------------------------------------------------------------------
// Resolved recipe — frozen pipeline + config for a session
// ---------------------------------------------------------------------------

export interface ResolvedRecipe {
  readonly id: string;
  readonly pipeline: readonly string[];
  readonly postComplete: readonly string[];
  readonly stages: Readonly<Record<string, Record<string, unknown>>>;
  readonly dirtyFileHandling: string;
  readonly defaults: {
    readonly maxTicketsPerSession: number;
    readonly compactThreshold: string;
    readonly reviewBackends: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Stage context — stateful wrapper passed to stage enter/report methods
// ---------------------------------------------------------------------------

/**
 * StageContext is a CLASS, not a plain object. `ctx.state` is a getter that
 * always returns the latest snapshot after any writeState() call.
 * This prevents the walker from writing on a stale snapshot after stages
 * do multi-write operations (FINALIZE checkpoints, CODE_REVIEW→PLAN resets).
 */
export class StageContext {
  readonly root: string;
  readonly dir: string;
  readonly recipe: ResolvedRecipe;
  private _state: FullSessionState;

  constructor(root: string, dir: string, state: FullSessionState, recipe: ResolvedRecipe) {
    this.root = root;
    this.dir = dir;
    this._state = state;
    this.recipe = recipe;
  }

  /** Current session state — always reflects the latest writeState() call. */
  get state(): FullSessionState {
    return this._state;
  }

  /**
   * Stage changes to the internal snapshot WITHOUT persisting to disk.
   * Use this for field updates that should be atomically committed with the
   * state transition in processAdvance (avoids crash-recovery windows).
   */
  updateDraft(updates: Partial<FullSessionState>): void {
    this._state = { ...this._state, ...updates } as FullSessionState;
  }

  /**
   * Write state updates atomically. Returns the written state with incremented revision.
   * Updates the internal snapshot so subsequent reads via `this.state` are consistent.
   */
  writeState(updates: Partial<FullSessionState>, opts?: { refreshStatus?: boolean }): FullSessionState {
    const merged = { ...this._state, ...updates } as FullSessionState;
    const written = writeSessionSync(this.dir, merged);
    this._state = written;
    if (opts?.refreshStatus) {
      try { refreshStatusForSession(this.root, this.dir, written, "guide"); } catch { /* best-effort */ }
    }
    return written;
  }

  /**
   * T-260: Terminal transition with sidecar cleanup.
   * Persists state first, then kills sidecar and writes shutdown marker (best-effort).
   */
  finalizeSession(updates: Partial<FullSessionState>, terminalData?: Record<string, unknown>): FullSessionState {
    const pidToKill = this._state.sidecarPid;
    const written = this.writeState(updates);
    try { killSidecar(pidToKill); } catch { /* best-effort */ }
    try { writeShutdownMarker(this.dir); } catch { /* best-effort */ }
    const reason = (updates as Record<string, unknown>).terminationReason as string ?? "normal";
    writeEvent(this.dir, {
      ts: new Date().toISOString(),
      layer: "guide",
      type: "session_end",
      data: {
        reason,
        ticketsCompleted: written.completedTickets?.length ?? 0,
        issuesResolved: (written.resolvedIssues as unknown[] | undefined)?.length ?? 0,
        ...terminalData,
      },
    });
    markEnded(this.dir, reason);
    return written;
  }

  /** Append a supplementary event to events.log and mirror to events.jsonl. */
  appendEvent(type: string, data: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    appendEvent(this.dir, {
      rev: this._state.revision,
      type,
      timestamp: ts,
      data,
    });
    if (type !== "session_end" && type !== "session_cancelled") {
      writeEvent(this.dir, { ts, layer: "guide", type, data });
    }
  }

  /** Load the .story/ project state (tickets, issues, roadmap). */
  async loadProject(): Promise<{ state: ProjectState }> {
    return loadProject(this.root);
  }

  /**
   * Drain pending deferrals — attempt to file each as an issue.
   * Updates state with filed/remaining deferrals. Returns true if all filed.
   */
  async drainDeferrals(): Promise<boolean> {
    const pending = [...(this._state.pendingDeferrals ?? [])];
    if (pending.length === 0) return true;

    const SEVERITY_MAP: Record<string, string> = { critical: "critical", major: "high", minor: "medium" };
    const filed = [...(this._state.filedDeferrals ?? [])];
    const remaining: typeof pending = [];
    let newlyFiled = 0;

    for (const entry of pending) {
      try {
        const { handleIssueCreate } = await import("../../cli/commands/issue.js");
        const severity = SEVERITY_MAP[entry.severity] ?? "medium";
        const title = `[${entry.category}] ${entry.description.slice(0, 80)}`;
        const result = await handleIssueCreate(
          { title, severity, impact: entry.description, components: ["autonomous"], relatedTickets: [], location: [] },
          "json",
          this.root,
        );
        let issueId: string | undefined;
        try {
          const parsed = JSON.parse(result.output ?? "");
          issueId = parsed?.data?.id;
        } catch {
          const match = result.output?.match(/ISS-\d+/);
          issueId = match?.[0];
        }
        if (issueId) {
          filed.push({ fingerprint: entry.fingerprint, issueId });
          newlyFiled++;
        } else {
          remaining.push(entry);
        }
      } catch {
        remaining.push(entry);
      }
    }

    const prev = this._state.verificationCounters ?? { proposed: 0, verified: 0, rejected: 0, filed: 0, lastTelemetryLine: 0 };
    this.writeState({
      filedDeferrals: filed,
      pendingDeferrals: remaining,
      verificationCounters: { ...prev, filed: prev.filed + newlyFiled },
    } as Partial<FullSessionState>);
    return remaining.length === 0;
  }

  /**
   * Queue deferred review findings for issue creation.
   * Persists to pendingDeferrals (crash-safe), then attempts to drain.
   */
  async fileDeferredFindings(
    findings: readonly { severity: string; category: string; description: string; disposition: string }[],
    reviewKind: "plan" | "code",
  ): Promise<void> {
    const deferred = findings.filter(f => f.disposition === "deferred" && f.severity !== "suggestion");
    if (deferred.length === 0) return;

    const pending = [...(this._state.pendingDeferrals ?? [])];
    for (const f of deferred) {
      const fp = djb2Hash(`${this._state.ticket?.id ?? ""}:${reviewKind}:${f.severity}:${f.category}:${f.description}`);
      if ((this._state.filedDeferrals ?? []).some(d => d.fingerprint === fp)) continue;
      if (pending.some(d => d.fingerprint === fp)) continue;
      pending.push({ fingerprint: fp, severity: f.severity, category: f.category, description: f.description, reviewKind });
    }

    this.writeState({ pendingDeferrals: pending } as Partial<FullSessionState>);
    await this.drainDeferrals();
  }
}

/** DJB2 hash — must match guide.ts simpleHash exactly for fingerprint compatibility. */
function djb2Hash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Workflow stage interface
// ---------------------------------------------------------------------------

/**
 * A pipeline stage in the autonomous workflow.
 *
 * - `enter()` is called when the stage becomes active (after a transition).
 *   Returns StageResult (instruction for Claude) or StageAdvance (auto-advance,
 *   e.g. CompleteStage immediately routes to PICK_TICKET or HANDOVER).
 *
 * - `report()` is called when Claude reports back with results.
 *   Returns StageAdvance to indicate the next action.
 *
 * - `skip()` (optional) is called by the walker during pipeline traversal.
 *   If true, the walker skips this stage and advances to the next.
 */
export interface WorkflowStage {
  readonly id: string;
  enter(ctx: StageContext): Promise<StageResult | StageAdvance>;
  report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance>;
  skip?(ctx: StageContext): boolean;
}

// ── T-181: Shared lens history accumulation ────────────────────

interface LensHistoryEntry {
  ticketId: string;
  stage: "CODE_REVIEW" | "PLAN_REVIEW";
  lens: string;
  category: string;
  severity: string;
  disposition: "open" | "addressed" | "contested" | "deferred";
  description: string;
  timestamp: string;
}

/**
 * Build lens history entries from review findings and merge with existing history.
 * Dedup key: ticketId:stage:lens:category (description excluded -- LLM rephrasing
 * across rounds would defeat dedup and inflate totals for lesson-capture thresholds).
 */
export function buildLensHistoryUpdate(
  findings: readonly { category: string; severity: string; disposition?: string; description: string; [k: string]: unknown }[],
  existing: readonly LensHistoryEntry[],
  ticketId: string,
  stage: "CODE_REVIEW" | "PLAN_REVIEW",
): LensHistoryEntry[] | null {
  const existingKeys = new Set(
    existing.map((e) => `${e.ticketId}:${e.stage}:${e.lens}:${e.category}`),
  );
  const newEntries = findings
    .map((f) => ({
      ticketId,
      stage,
      lens: typeof (f as Record<string, unknown>).lens === "string" && (f as Record<string, unknown>).lens !== "" ? (f as Record<string, unknown>).lens as string : "unknown",
      category: f.category,
      severity: f.severity,
      disposition: f.disposition ?? "open",
      description: f.description,
      timestamp: new Date().toISOString(),
    }))
    .filter((e) => !existingKeys.has(`${e.ticketId}:${e.stage}:${e.lens}:${e.category}`));
  return newEntries.length > 0 ? [...existing, ...newEntries] : null;
}
