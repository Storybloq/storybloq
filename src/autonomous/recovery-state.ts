/**
 * Where a session resumes when the work it parked on can no longer be
 * trusted, and which of its plan/code evidence that invalidates. Used by the
 * guide's external-drift recovery and by the T-534 retirement's FINALIZE
 * normalisation, which re-targets a legacy limit park the same way.
 */
import type { FullSessionState } from "./session-types.js";

export interface RecoveryTarget {
  readonly state: string;
  readonly resetPlan: boolean;
  readonly resetCode: boolean;
}

// Exported for test completeness checks (ISS-040).
export const RECOVERY_MAPPING: Readonly<Record<string, RecoveryTarget>> = {
  PICK_TICKET:    { state: "PICK_TICKET", resetPlan: false, resetCode: false },
  COMPLETE:       { state: "PICK_TICKET", resetPlan: false, resetCode: false },
  HANDOVER:       { state: "SESSION_END", resetPlan: false, resetCode: false },
  PLAN:           { state: "PLAN",        resetPlan: true,  resetCode: false },
  IMPLEMENT:      { state: "PLAN",        resetPlan: true,  resetCode: false },
  WRITE_TESTS:    { state: "PLAN",        resetPlan: true,  resetCode: false },
  BUILD:          { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
  VERIFY:         { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
  PLAN_REVIEW:    { state: "PLAN",        resetPlan: true,  resetCode: true  },
  TEST:           { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
  CODE_REVIEW:    { state: "PLAN",        resetPlan: true,  resetCode: true  },
  FINALIZE:       { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
  // T-527: the item is committed and the review owed stays owed; a reset that
  // took the implementation commit off HEAD's history surfaces as
  // knowledge_diverged on the next report, never as a new baseline.
  KNOWLEDGE_REVIEW: { state: "KNOWLEDGE_REVIEW", resetPlan: false, resetCode: false },
  LESSON_CAPTURE: { state: "PICK_TICKET", resetPlan: false, resetCode: false },
  ISSUE_FIX:      { state: "ISSUE_FIX",   resetPlan: false, resetCode: false },  // T-208: self-recover to avoid dangling currentIssue
  ISSUE_SWEEP:    { state: "PICK_TICKET", resetPlan: false, resetCode: false },
};

/**
 * The item-level resets a recovery applies: reviews the target invalidates,
 * the ticket's derived risk and plan hash, and every finalization and landing
 * marker. A pending knowledge review is kept (T-527).
 */
export function recoveryResets(state: FullSessionState, mapping: RecoveryTarget): Partial<FullSessionState> {
  return {
    finalizeCheckpoint: null,
    finalizedItem: null,
    knowledgeReview: state.knowledgeReview?.status === "pending" ? state.knowledgeReview : null,
    landingDecision: null,
    reviews: {
      plan: mapping.resetPlan ? [] : state.reviews.plan,
      code: mapping.resetCode ? [] : state.reviews.code,
    },
    ticket: state.ticket ? { ...state.ticket, realizedRisk: undefined, lastPlanHash: undefined } : undefined,
  };
}
