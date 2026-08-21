import {
  LENS_FINDING_DISPOSITIONS,
  normalizeSeverity,
  type FullSessionState,
  type GuideReportInput,
  type ContextAdvice,
  type LensFindingDisposition,
} from "../session-types.js";
import { createHash } from "node:crypto";
import { writeSessionSync, appendEvent } from "../session.js";
import { killSidecar, writeShutdownMarker } from "../liveness.js";
import { writeEvent, markEnded } from "../telemetry-writer.js";
import { refreshStatusForSession } from "../status-writer.js";
import { loadProject } from "../../core/project-loader.js";
import type { ProjectState } from "../../core/project-state.js";

// ---------------------------------------------------------------------------
// Stage result -- returned by enter() when the stage needs Claude to act
// ---------------------------------------------------------------------------

export interface StageResult {
  readonly instruction: string;
  readonly reminders?: readonly string[];
  readonly contextAdvice?: ContextAdvice;
  readonly transitionedFrom?: string;
}

// ---------------------------------------------------------------------------
// Stage advance -- returned by report() and optionally by enter()
// ---------------------------------------------------------------------------

export type StageAdvance =
  | { action: "advance" }
  | { action: "advance"; result: StageResult }
  | { action: "retry"; instruction: string; reminders?: readonly string[] }
  | { action: "back"; target: string; reason: string }
  | { action: "goto"; target: string }
  | { action: "goto"; target: string; result: StageResult };

// ---------------------------------------------------------------------------
// Type guard -- discriminates StageResult from StageAdvance
// ---------------------------------------------------------------------------

export function isStageAdvance(value: StageResult | StageAdvance): value is StageAdvance {
  return "action" in value;
}

// ---------------------------------------------------------------------------
// Resolved recipe -- frozen pipeline + config for a session
// ---------------------------------------------------------------------------

import type { BranchStrategy } from "../branch-strategy.js";

export interface ResolvedRecipe {
  readonly id: string;
  readonly pipeline: readonly string[];
  readonly postComplete: readonly string[];
  readonly stages: Readonly<Record<string, Record<string, unknown>>>;
  /**
   * T-461: the session's review-effort pin plus the provenance the dial needs.
   * `explicitKnobs` records which review knobs the PROJECT set; the dial may
   * supersede a recipe-shipped value but never a project-set one, and after
   * the merge in resolveRecipe the two are otherwise indistinguishable.
   */
  readonly reviewEffort: {
    readonly level: "off" | "light" | "standard" | "thorough" | "size-mapped";
    // Includes the not-attributable values because a recipe reconstructed from
    // a resumed session carries that session's provenance, and a legacy or
    // damaged record must be able to say so rather than borrow "default".
    readonly source: "start-call" | "project" | "default" | "legacy" | "unknown";
    readonly explicitKnobs: {
      readonly codeReviewMaxRounds: boolean;
      readonly planReviewBackends: boolean;
      readonly codeReviewBackends: boolean;
    };
  };
  readonly dirtyFileHandling: string;
  readonly branchStrategy: BranchStrategy;
  readonly defaults: {
    readonly maxTicketsPerSession: number;
    readonly compactThreshold: string;
    readonly reviewBackends: readonly string[];
    readonly codexReviewBackends?: readonly string[];
    readonly handoverInterval: number;
  };
}

// ---------------------------------------------------------------------------
// Stage context -- stateful wrapper passed to stage enter/report methods
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

  /** Current session state -- always reflects the latest writeState() call. */
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
    const prevState = this._state.state;
    const merged = { ...this._state, ...updates } as FullSessionState;
    const written = writeSessionSync(this.dir, merged);
    this._state = written;
    if (opts?.refreshStatus || written.state !== prevState) {
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
   * The identity of one finding, for dedup and for the ceiling's park gate.
   *
   * A method rather than a free function so both call sites are forced through
   * the same field list: they were two hand-written template literals that had
   * to stay byte-identical, and only a comment said so.
   */
  private findingFingerprint(
    f: { severity: string; category: string; description: string },
    reviewKind: "plan" | "code",
  ): string {
    return hashFindingTuple([
      this._state.ticket?.id ?? "",
      reviewKind,
      f.severity,
      f.category,
      f.description,
    ]);
  }

  /**
   * Queue findings as issues WITHOUT requiring a `deferred` disposition
   * (T-470).
   *
   * `fileDeferredFindings` filters on `disposition === "deferred"`, which is
   * right for its own callers and wrong for the round ceiling: a session that
   * stops because blocking findings will not resolve has to file those
   * findings AS blockers. Reaching that filter would mean rewriting a
   * critical's disposition to get past it, and a critical rewritten into a
   * deferral is a blocker laundered into a note.
   *
   * So this shares the durable queue and the drain -- fingerprints, the
   * severity map, idempotency via `filedDeferrals` -- and skips only the
   * disposition filter. The caller decides what is outstanding; the
   * suggestion exemption still applies, since a suggestion is not a defect.
   */
  async queueFindingsAsIssues(
    findings: readonly { severity: string; category: string; description: string }[],
    reviewKind: "plan" | "code",
  ): Promise<string[]> {
    const relevant = findings.filter(f => normalizeSeverity(f.severity) !== "suggestion");
    if (relevant.length === 0) return [];

    const pending = [...(this._state.pendingDeferrals ?? [])];
    // EVERY relevant finding's fingerprint is returned, including ones already
    // queued or filed, because the caller uses this to say which issues belong
    // to THIS escalation. A finding this ceiling is stopping over does not stop
    // belonging to it because an earlier deferral happened to file it first.
    const fingerprints: string[] = [];
    for (const f of relevant) {
      // The SAME fingerprint shape as fileDeferredFindings, so a finding
      // already filed as a deferral is not filed twice under the ceiling.
      const fp = this.findingFingerprint(f, reviewKind);
      if (!fingerprints.includes(fp)) fingerprints.push(fp);
      if ((this._state.filedDeferrals ?? []).some(d => d.fingerprint === fp)) continue;
      if (pending.some(d => d.fingerprint === fp)) continue;
      pending.push({ fingerprint: fp, severity: f.severity, category: f.category, description: f.description, reviewKind });
    }

    this.writeState({ pendingDeferrals: pending } as Partial<FullSessionState>);
    return fingerprints;
  }

  /**
   * Drain pending deferrals -- attempt to file each as an issue.
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
          {
            title, severity, impact: entry.description,
            components: ["autonomous"], relatedTickets: [], location: [],
            // T-470: the fingerprint as a DURABLE dedupe key, scoped to THIS
            // session.
            //
            // `filedDeferrals` is session state, and it is written AFTER the
            // issue is created. A stop in that window used to leave the issue
            // in the ledger with nothing recording it, so the retry filed a
            // second copy of the same finding. `handleIssueCreate` returns the
            // existing issue for a matching key instead of creating another,
            // which closes the window with the mechanism already built for it.
            //
            // The SESSION ID is what bounds it, and it is not decoration. The
            // dedupe lookup scans `activeIssues`, which filters on `lifecycle`
            // and NOT on status -- a RESOLVED issue is still there. A global
            // key would therefore mean that a finding recurring months later,
            // after its original issue was fixed and closed, silently resolved
            // to that closed issue: the queue would mark it filed and a ceiling
            // session could end with a live blocker having no open issue
            // anywhere. Scoped, the crash-retry window this exists for is still
            // closed (a retry is always the same session) and a later session
            // files the recurrence as the new problem it is.
            //
            // Namespaced, because the key space is shared with every other
            // caller and a bare hash could collide with one of theirs.
            dedupeKey: `deferral:${this._state.sessionId}:${entry.fingerprint}`,
          },
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
    // ISS-726: normalize severity here too so the suggestion-exemption holds
    // even if a caller passes findings that did not pass through a stage's
    // entry normalization.
    const deferred = findings.filter(f => f.disposition === "deferred" && normalizeSeverity(f.severity) !== "suggestion");
    if (deferred.length === 0) return;

    const pending = [...(this._state.pendingDeferrals ?? [])];
    for (const f of deferred) {
      const fp = this.findingFingerprint(f, reviewKind);
      if ((this._state.filedDeferrals ?? []).some(d => d.fingerprint === fp)) continue;
      if (pending.some(d => d.fingerprint === fp)) continue;
      pending.push({ fingerprint: fp, severity: f.severity, category: f.category, description: f.description, reviewKind });
    }

    this.writeState({ pendingDeferrals: pending } as Partial<FullSessionState>);
    await this.drainDeferrals();
  }
}

/**
 * The deferral fingerprint: SHA-256 of the finding tuple, truncated to 32 hex
 * characters (T-470).
 *
 * It was a 32-bit DJB2 hash. Even for its original job -- deduplicating
 * filings within one session -- a collision was already a loss: two DISTINCT
 * findings sharing a hash meant the second one's follow-up issue was silently
 * skipped. It was tolerable because the cost stopped there, at one deferred
 * finding that never became a ticket.
 *
 * The round ceiling raises that cost. It changed what the number decides. The park is gated on every
 * fingerprint belonging to that escalation appearing in `filedDeferrals`, so a
 * collision with any unrelated finding already filed in the session now makes
 * the queue SKIP the real blocker and makes the gate agree it was filed. The
 * session then ends, having told the user in its own report that a critical
 * reached the ledger, with no issue anywhere. 32 bits is not enough to hang a
 * data-integrity decision on, whatever it was enough for before.
 *
 * 128 bits of the digest is: a collision needs work no accident performs, and
 * the value stays short enough to read in a state file and to carry as an issue
 * `dedupeKey` (bounded at 512 characters).
 *
 * Sessions that upgrade mid-flight will not match their previously recorded
 * fingerprints and may file one already-filed deferral a second time. That is a
 * one-off duplicate follow-up issue in an active session, which is the cheapest
 * failure available here and strictly cheaper than the one it removes.
 *
 * The plan-fingerprint hash in `stages/plan.ts` is a SEPARATE algorithm with a
 * separate job (ISS-035) and is deliberately left alone; the comment there
 * claiming they are the same algorithm no longer holds and says so.
 */
function hashFindingTuple(parts: readonly string[]): string {
  // JSON-encoded, not colon-joined. A delimiter that can appear INSIDE a field
  // makes distinct findings share an input: category `security:auth` with
  // description `Token leak` produced the same string as category `security`
  // with description `auth:Token leak`, so the second was skipped as already
  // queued and the ceiling could park with it unfiled. No hash function fixes
  // an ambiguous input; the encoding has to be unambiguous first.
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 32);
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
      // ISS-556: normalize unknown/undefined dispositions to "open" so a
      // non-MCP caller (test, future CLI path) cannot produce a state.json
      // that fails strict SessionStateSchema parsing.
      disposition: (LENS_FINDING_DISPOSITIONS as readonly string[]).includes(f.disposition ?? "")
        ? (f.disposition as LensFindingDisposition)
        : ("open" as LensFindingDisposition),
      description: f.description,
      timestamp: new Date().toISOString(),
    }))
    .filter((e) => !existingKeys.has(`${e.ticketId}:${e.stage}:${e.lens}:${e.category}`));
  return newEntries.length > 0 ? [...existing, ...newEntries] : null;
}
