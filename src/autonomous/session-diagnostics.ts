import { requiredRounds, effectiveSkipRisk, type RiskLevel } from "./review-depth.js";
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
  return value === "medium" || value === "high" ? value : "low";
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
  const risk = effectiveSkipRisk(state.ticket?.risk, state.ticket?.realizedRisk) ?? "low";
  const maxReviewRounds = effectiveCodeReviewMaxRounds(risk, state.resolvedStages);
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
