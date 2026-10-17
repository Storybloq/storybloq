import {
  LENS_FINDING_DISPOSITIONS,
  normalizeSeverity,
  type FullSessionState,
  type GuideReportInput,
  type ContextAdvice,
  type LensFindingDisposition,
} from "../session-types.js";
import { createHash } from "node:crypto";
import { writeSessionSync, appendEvent, StateWriteUndurableError } from "../session.js";
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
 * One entry in the durable deferral queue, taken FROM the session schema
 * rather than restated, so a field added there cannot drift from what the
 * merge below reads (ISS-1113).
 */
type PendingDeferral = NonNullable<FullSessionState["pendingDeferrals"]>[number];

/** A own-data object, for reading into the passthrough `metadata` bag safely. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
   *
   * ISS-958 (policy A): on StateWriteUndurableError the state WAS published,
   * so the snapshot adopts `err.published` before the error propagates. A
   * stage that swallows the error and writes again then builds on the
   * published revision instead of reusing its number with different content.
   */
  writeState(updates: Partial<FullSessionState>, opts?: { refreshStatus?: boolean }): FullSessionState {
    const prevState = this._state.state;
    const merged = { ...this._state, ...updates } as FullSessionState;
    let written: FullSessionState;
    try {
      written = writeSessionSync(this.dir, merged);
    } catch (err) {
      if (err instanceof StateWriteUndurableError) this._state = err.published;
      throw err;
    }
    this._state = written;
    if (opts?.refreshStatus || written.state !== prevState) {
      try { refreshStatusForSession(this.root, this.dir, written, "guide"); } catch { /* best-effort */ }
    }
    return written;
  }

  /**
   * T-260: Terminal transition with sidecar cleanup.
   * Persists state first, then kills sidecar and writes shutdown marker (best-effort).
   *
   * ISS-958 (policy TC): a StateWriteUndurableError means the terminal state
   * WAS published, and nothing re-enters a terminal session to finish this
   * tail later. So the tail runs against the published state, then the error
   * propagates.
   */
  finalizeSession(updates: Partial<FullSessionState>, terminalData?: Record<string, unknown>): FullSessionState {
    const pidToKill = this._state.sidecarPid;
    let written: FullSessionState;
    let undurable: StateWriteUndurableError | null = null;
    try {
      written = this.writeState(updates);
    } catch (err) {
      if (!(err instanceof StateWriteUndurableError)) throw err;
      undurable = err;
      written = err.published;
    }
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
    if (undurable) throw undurable;
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
   * ISS-1113: how much weight one producer's classification carries.
   *
   * Three producers write into this one queue and
   * the fingerprint deliberately excludes the disposition, so the same
   * `(ticketId, reviewKind, severity, category, description)` tuple deferred
   * in one round and blocking in a later one is ONE entry and something has to
   * decide which classification it carries. Before this it was whichever
   * producer happened to run first, which at both ceiling sites is the
   * deferral call -- so a live blocker could be recorded as a deferral, the
   * exact laundering `queueFindingsAsIssues` below exists to prevent.
   *
   * The rank is over EXPLICITNESS, not actionability, and it is strict: an
   * entry is replaced only by a HIGHER rank, so a producer with nothing to say
   * can never overwrite one that did.
   */
  private static dispositionRank(disposition: string | null | undefined): number {
    if (disposition === undefined) return 0;   // nothing said (a pre-upgrade entry)
    if (disposition === null) return 2;        // explicitly actionable (the ceiling)
    if (disposition === "forced_landing") return 3; // a deliberate override, latest word
    return 1;                                  // an explicit non-actionable classification
  }

  /**
   * True when `incoming` should replace what is already queued.
   *
   * `forced_landing` outranks the ceiling's explicit-actionable claim because
   * forcing a landing is a later, deliberate decision to ship past exactly
   * that finding. The ceiling's claim outranks a plain deferral because a
   * finding a session is PARKING on is not out of scope. And absent loses to
   * everything, including to itself, so a re-queue changes nothing.
   */
  private static supersedes(
    incoming: string | null | undefined,
    existing: string | null | undefined,
  ): boolean {
    return StageContext.dispositionRank(incoming) > StageContext.dispositionRank(existing);
  }

  /**
   * Apply one producer's claim to the pending list, mutating the caller's copy.
   *
   * New fingerprint: appended. Known fingerprint: replaced only on a strictly
   * higher rank, which is where "the result does not depend on which producer
   * ran first" is actually enforced.
   */
  private static mergeDeferral(
    pending: PendingDeferral[],
    entry: PendingDeferral,
  ): void {
    const at = pending.findIndex(d => d.fingerprint === entry.fingerprint);
    if (at === -1) {
      pending.push(entry);
      return;
    }
    const existing = pending[at]!;
    if (!StageContext.supersedes(entry.disposition, existing.disposition)) return;
    // The classification and its provenance move together: a `forced_landing`
    // carrying a `reviewer-deferred` origin would be a worse record than
    // either producer wrote.
    pending[at] = {
      ...existing,
      disposition: entry.disposition,
      origin: entry.origin,
      reviewId: entry.reviewId,
    };
  }

  /**
   * ISS-1113: correct the disposition of an issue this session ALREADY filed,
   * when a later producer makes a higher-ranked claim about the same finding.
   *
   * The merge above only settles producers that are both still in the queue.
   * They frequently are not. `fileDeferredFindings` DRAINS before it returns,
   * and at both ceiling sites it is called first, so by the time
   * `queueFindingsAsIssues` runs the fingerprint is in `filedDeferrals` and
   * the old code simply skipped it -- leaving a live blocker recorded as
   * `accepted_out_of_scope` while the session parks over it.
   *
   * That is not a rare interleaving. `outstandingCeilingFindings` includes a
   * `deferred` finding when its origin still blocks, and its own comment says
   * why: the ceiling is deliberately making "a second claim on the same
   * finding by a path that calls it a blocker". This is where that second
   * claim gets to land.
   *
   * Strictly an UPGRADE, by the same rank as the queue merge, so it can only
   * ever move an issue toward the more explicit claim and can never demote one
   * a higher-ranked producer already set. Best-effort throughout: the deferral
   * queue is best-effort by contract, and a session must not fail to park
   * because a disposition could not be rewritten.
   */
  private async reconcileFiledDisposition(
    fingerprint: string,
    incoming: string | null | undefined,
    origin: string | undefined,
    reviewId: string | undefined,
  ): Promise<void> {
    const filed = (this._state.filedDeferrals ?? []).find(d => d.fingerprint === fingerprint);
    if (!filed) return;
    try {
      const { withProjectLock, writeIssueUnlocked } = await import("../../core/project-loader.js");
      await withProjectLock(this.root, { strict: false }, async ({ state }) => {
        const issue = state.issues.find(i => i.id === filed.issueId);
        if (!issue) return;
        // An issue whose disposition was never set reads as rank 0 here, the
        // same as a producer with nothing to say -- so an upgrade from absent
        // to an explicit claim happens, and nothing downgrades it.
        const current = "disposition" in issue ? issue.disposition : undefined;
        if (!StageContext.supersedes(incoming, current)) return;
        const next = { ...issue } as Record<string, unknown>;
        // `metadata` is a PASSTHROUGH bag shared with every other writer, so
        // only the `review` key this code owns may be touched. Replacing the
        // whole object would silently drop whatever else an integration put
        // there, and nothing downstream would ever report the loss.
        const existingMeta = isPlainRecord(next.metadata) ? { ...next.metadata } : undefined;
        if (incoming == null) {
          // Explicitly actionable: the FIELD goes away, so the issue is
          // indistinguishable from one that never carried a disposition. Its
          // provenance block goes with it, because that block describes a
          // classification the issue no longer carries -- but only that block.
          delete next.disposition;
          if (existingMeta) {
            delete existingMeta.review;
            // An empty bag is not the same as no bag to a reader diffing these
            // files, and this issue is meant to look like one that never had a
            // disposition, so the key goes away entirely when nothing is left.
            if (Object.keys(existingMeta).length === 0) delete next.metadata;
            else next.metadata = existingMeta;
          }
        } else {
          next.disposition = incoming;
          next.metadata = {
            ...(existingMeta ?? {}),
            review: {
              // Whatever else the previous review block recorded is kept: this
              // is a correction of the classification, not of everything a
              // reviewer wrote about the finding.
              ...(isPlainRecord(existingMeta?.review) ? existingMeta.review : {}),
              origin: origin ?? "review",
              findingDisposition: incoming,
              sessionId: this._state.sessionId,
              ...(reviewId !== undefined && { reviewId }),
            },
          };
        }
        await writeIssueUnlocked(next as typeof issue, this.root);
      });
    } catch (err) {
      // Best-effort: a failed correction leaves the issue as filed rather than
      // taking the round down with it. RECORDED rather than swallowed, though
      // -- a silent catch here makes lock contention and ledger write failures
      // undiagnosable, and the whole point of this call is that the issue on
      // disk currently says the wrong thing.
      try {
        this.appendEvent("deferral_disposition_reconcile_failed", {
          fingerprint,
          issueId: filed.issueId,
          incoming: incoming ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // The recorder is itself a write, so it can fail for exactly the
        // reasons the correction just did (a full disk, a permission change).
        // Nothing is left to report it TO at that point, and best-effort has
        // to mean best-effort: the round must not die because a diagnostic
        // about a non-fatal failure could not be written.
      }
    }
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
      if ((this._state.filedDeferrals ?? []).some(d => d.fingerprint === fp)) {
        // Already filed, by this session, almost certainly by the deferral
        // call that runs immediately before this one at both ceiling sites.
        // The issue exists; what it says about itself may now be wrong.
        await this.reconcileFiledDisposition(fp, null, "round-ceiling", undefined);
        continue;
      }
      // ISS-1113: `disposition: null` -- EXPLICITLY actionable, not "no
      // opinion". It is the claim this function was written to make, and the
      // merge is what stops a deferral that shares this fingerprint from
      // overwriting it. An entry already queued by a deferral is upgraded
      // here rather than skipped, which is the behaviour change: the skip
      // used to silently leave a blocker classified as out of scope.
      StageContext.mergeDeferral(pending, {
        fingerprint: fp,
        severity: f.severity,
        category: f.category,
        description: f.description,
        reviewKind,
        disposition: null,
        origin: "round-ceiling",
      });
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
            // ISS-1113: passed through EXACTLY as the producer wrote it, with
            // no default of any kind. `undefined` and `null` both mean "write
            // no disposition field", so a ceiling blocker and a pre-upgrade
            // entry produce the same ordinary, actionable issue -- which for
            // the pre-upgrade entry is byte-identical to what it produces
            // today. Defaulting an absent value to a non-actionable one would
            // reclassify every deferral persisted before this change AND, since
            // the ceiling shares this queue, mark a live blocker as not-work.
            ...(entry.disposition != null && { disposition: entry.disposition }),
            ...(entry.disposition != null && {
              metadata: {
                review: {
                  origin: entry.origin ?? "review",
                  findingDisposition: entry.disposition,
                  sessionId: this._state.sessionId,
                  ...(entry.reviewId !== undefined && { reviewId: entry.reviewId }),
                },
              },
            }),
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
    findings: readonly {
      severity: string;
      category: string;
      description: string;
      disposition: string;
      /**
       * ISS-1113: set by `forcedLandingFilingSet` on the findings a forced
       * landing is landing PAST. Absent means an ordinary reviewer deferral.
       * It is separate from `disposition` (which stays the REVIEW's verdict,
       * "deferred", and is what the filter below reads) because rewriting the
       * review verdict to carry a filing decision is how a critical becomes a
       * deferral.
       */
      filingDisposition?: string;
    }[],
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
      const forcedAlready = f.filingDisposition === "forced_landing";
      if ((this._state.filedDeferrals ?? []).some(d => d.fingerprint === fp)) {
        // Same seam as the ceiling's: a forced landing in a later round can
        // reach a finding an earlier round already filed as a plain deferral.
        await this.reconcileFiledDisposition(
          fp,
          forcedAlready ? "forced_landing" : "accepted_out_of_scope",
          forcedAlready ? "forced-landing" : "reviewer-deferred",
          undefined,
        );
        continue;
      }
      // ISS-1113: an EXPLICIT classification on every entry this path queues.
      // Both values are non-actionable; which one depends on why the finding
      // is being cleared, and `mergeDeferral` decides what happens when the
      // ceiling or a forced landing describes the same fingerprint.
      StageContext.mergeDeferral(pending, {
        fingerprint: fp,
        severity: f.severity,
        category: f.category,
        description: f.description,
        reviewKind,
        disposition: forcedAlready ? "forced_landing" : "accepted_out_of_scope",
        origin: forcedAlready ? "forced-landing" : "reviewer-deferred",
      });
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
