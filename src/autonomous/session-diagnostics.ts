import { normalizeRiskLevel, requiredRounds, type RiskLevel } from "./review-depth.js";
import {
  effectiveReviewEffort,
  effortCodeReviewMaxRounds,
  type ReviewEffortState,
} from "./review-effort.js";
import type { EventEntry, FullSessionState } from "./session-types.js";

export const DEFAULT_CODE_REVIEW_MAX_ROUNDS = 12;

export type SessionDiagnosticCode =
  | "code_review_non_converging"
  | "landable_uncommitted"
  | "scope_expanded";

export interface SessionDiagnostic {
  readonly code: SessionDiagnosticCode;
  readonly severity: "warning";
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export interface SessionDiagnosticSummary {
  readonly diagnostics: readonly SessionDiagnostic[];
  readonly codeReviewRounds: number;
  readonly codeReviewBacktracks: number;
  readonly maxReviewRounds: number;
  readonly lastVerdict: string | null;
  readonly lastCriticalCount: number | null;
  readonly lastUnresolvedCriticalCount: number | null;
  readonly lastMajorCount: number | null;
  readonly ticketAgeMs: number | null;
  readonly filedDeferralCount: number;
}

type StageConfigMap = Readonly<Record<string, Readonly<Record<string, unknown>>>> | null | undefined;

function riskLevel(value: string | null | undefined): RiskLevel {
  return value == null ? "low" : normalizeRiskLevel(value, "high");
}

export function configuredCodeReviewMaxRounds(stages: StageConfigMap): number {
  const raw = stages?.CODE_REVIEW?.maxReviewRounds;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_CODE_REVIEW_MAX_ROUNDS;
  if (raw === 0) return 0;
  if (raw < 0) return DEFAULT_CODE_REVIEW_MAX_ROUNDS;
  return Math.max(1, Math.floor(raw));
}

export function effectiveCodeReviewMaxRounds(
  risk: string | null | undefined,
  stages: StageConfigMap,
): number {
  const configured = configuredCodeReviewMaxRounds(stages);
  return configured === 0 ? 0 : Math.max(configured, requiredRounds(riskLevel(risk)));
}

/**
 * The CODE_REVIEW cap actually in force, dial included.
 *
 * ONE function, because there are two readers of this number and they must not
 * disagree: the stage decides routing with it, and the diagnostics derive
 * `atOrPastCap`, the non-converging gate, the landable gate, the
 * `scope_expanded` threshold, and the figure rendered to a person in the health
 * model and the session report. If only the stage became effort-aware, a light
 * session would route on 4 while every one of those still said 12.
 *
 * `explicitKnobs` comes from STATE rather than the resolved recipe on purpose.
 * Both carry it, but the recipe object is built by hand in a number of stage
 * tests without a `reviewEffort` key, and `test/` is excluded from tsconfig, so
 * reading it there would be a runtime TypeError rather than a compile error.
 * The state field is optional everywhere and absent reads as "not project-set".
 */
export function dialCodeReviewMaxRounds(
  state: ReviewEffortState & {
    readonly resolvedReviewEffort?: { readonly explicitKnobs?: { readonly codeReviewMaxRounds?: boolean } | null } | null;
  },
  stages: StageConfigMap,
  risk: string | null | undefined,
): number {
  return effortCodeReviewMaxRounds(
    effectiveReviewEffort(state, "CODE_REVIEW"),
    riskLevel(risk),
    configuredCodeReviewMaxRounds(stages),
    state.resolvedReviewEffort?.explicitKnobs?.codeReviewMaxRounds === true,
  );
}

function isActiveSession(state: FullSessionState): boolean {
  return state.status === "active" && state.state !== "SESSION_END";
}

function parseTimeMs(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, nowMs - ts);
}

function countCodeReviewBacktracks(events: readonly EventEntry[]): number {
  return events.filter((e) =>
    e.type === "transition" &&
    e.data?.from === "CODE_REVIEW" &&
    e.data?.to === "IMPLEMENT"
  ).length;
}

function hasCurrentTicketCommit(state: FullSessionState): boolean {
  const ticketId = state.ticket?.id;
  if (!ticketId) return false;
  return (state.completedTickets ?? []).some((t) => t.id === ticketId);
}

export function analyzeSessionDiagnostics(
  state: FullSessionState,
  events: { events: readonly EventEntry[] },
  nowMs = Date.now(),
): SessionDiagnosticSummary {
  const diagnostics: SessionDiagnostic[] = [];
  const codeReviews = state.reviews?.code ?? [];
  const lastCodeReview = codeReviews[codeReviews.length - 1] ?? null;
  const lastReviewVerdict = state.lastReviewVerdict?.stage === "code"
    ? state.lastReviewVerdict
    : null;
  const lastVerdict = lastReviewVerdict?.verdict ?? lastCodeReview?.verdict ?? null;
  const lastCriticalCount = lastReviewVerdict?.criticalCount ?? lastCodeReview?.criticalCount ?? null;
  const lastUnresolvedCriticalCount = lastReviewVerdict?.unresolvedCriticalCount
    ?? lastCodeReview?.unresolvedCriticalCount
    ?? null;
  const lastMajorCount = lastReviewVerdict?.majorCount ?? lastCodeReview?.majorCount ?? null;
  const risk = state.ticket?.realizedRisk ?? state.ticket?.risk ?? "low";
  const maxReviewRounds = dialCodeReviewMaxRounds(state, state.resolvedStages, risk);
  const codeReviewRounds = codeReviews.length;
  const codeReviewBacktracks = countCodeReviewBacktracks(events.events);
  const ticketAgeMs = parseTimeMs(state.ticketStartedAt, nowMs);
  const filedDeferralCount = (state.filedDeferrals?.length ?? 0) + (state.pendingDeferrals?.length ?? 0);
  const totalCodeFindings = codeReviews.reduce((sum, r) => sum + r.findingCount, 0);
  const active = isActiveSession(state);
  const ticketActive = active && !!state.ticket && !hasCurrentTicketCommit(state);
  const legacyBlockingCriticalCount = lastUnresolvedCriticalCount ?? lastCriticalCount;
  const reviewLoopState = state.state === "IMPLEMENT" || state.state === "CODE_REVIEW";
  const nonRejectVerdict = lastVerdict !== null && lastVerdict !== "reject";
  const atOrPastCap = maxReviewRounds > 0 && codeReviewRounds >= maxReviewRounds;
  const landingDecision = state.landingDecision ?? null;
  const trustedNoBlockingLanding = landingDecision?.stage === "CODE_REVIEW" &&
    landingDecision.reason === "max_review_rounds_no_blocking";
  const noBlockingLatest = trustedNoBlockingLanding || legacyBlockingCriticalCount === 0;

  if (ticketActive && reviewLoopState && atOrPastCap && noBlockingLatest && nonRejectVerdict) {
    diagnostics.push({
      code: "code_review_non_converging",
      severity: "warning",
      message: `Code review has ${codeReviewRounds} round(s) with no latest blocking findings but remains in ${state.state}.`,
      details: {
        codeReviewRounds,
        maxReviewRounds,
        lastVerdict,
        lastCriticalCount,
        lastUnresolvedCriticalCount,
        codeReviewBacktracks,
      },
    });
  }

  if (
    ticketActive &&
    noBlockingLatest &&
    nonRejectVerdict &&
    (trustedNoBlockingLanding || (reviewLoopState && atOrPastCap))
  ) {
    diagnostics.push({
      code: "landable_uncommitted",
      severity: "warning",
      message: `Ticket ${state.ticket?.displayId ?? state.ticket?.id ?? "unknown"} is landable but uncommitted after ${codeReviewRounds} code-review round(s).`,
      details: {
        state: state.state,
        codeReviewRounds,
        maxReviewRounds,
        lastVerdict,
        lastCriticalCount,
        lastUnresolvedCriticalCount,
        landingDecision,
      },
    });
  }

  const reviewRoundScopeThreshold = maxReviewRounds > 0 ? maxReviewRounds + 3 : Number.POSITIVE_INFINITY;
  if (ticketActive && (codeReviewRounds >= reviewRoundScopeThreshold || totalCodeFindings >= 50)) {
    diagnostics.push({
      code: "scope_expanded",
      severity: "warning",
      message: `Ticket scope appears expanded: ${codeReviewRounds} review round(s), ${totalCodeFindings} code-review finding(s).`,
      details: {
        filedDeferralCount,
        codeReviewRounds,
        maxReviewRounds,
        totalCodeFindings,
      },
    });
  }

  return {
    diagnostics,
    codeReviewRounds,
    codeReviewBacktracks,
    maxReviewRounds,
    lastVerdict,
    lastCriticalCount,
    lastUnresolvedCriticalCount,
    lastMajorCount,
    ticketAgeMs,
    filedDeferralCount,
  };
}
