import type { WorkflowState } from "./session-types.js";

// ---------------------------------------------------------------------------
// State transition table
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<WorkflowState, readonly (WorkflowState | "*")[]> = {
  INIT:          ["PICK_TICKET"],         // start does INIT + LOAD_CONTEXT internally
  LOAD_CONTEXT:  ["PICK_TICKET"],         // internal (never seen by Claude)
  PICK_TICKET:   ["PLAN", "ISSUE_FIX", "COMPLETE", "SESSION_END"],  // COMPLETE for ISS-075 (nothing left to do)
  PLAN:          ["PLAN_REVIEW"],
  PLAN_REVIEW:   ["IMPLEMENT", "WRITE_TESTS", "PLAN", "PLAN_REVIEW", "SESSION_END"],   // approve → IMPLEMENT/WRITE_TESTS, reject → PLAN, stay for next round; SESSION_END for tiered exit
  IMPLEMENT:     ["CODE_REVIEW", "TEST", "COMPLETE"],  // TEST when test stage enabled, COMPLETE for no-op tickets (ISS-069)
  WRITE_TESTS:   ["IMPLEMENT", "WRITE_TESTS", "PLAN", "COMPLETE"],  // advance → IMPLEMENT, retry stays, exhaustion → PLAN, no-op → COMPLETE (ISS-069)
  TEST:          ["CODE_REVIEW", "IMPLEMENT", "TEST"],  // pass → CODE_REVIEW, fail → IMPLEMENT, retry
  CODE_REVIEW:   ["VERIFY", "FINALIZE", "IMPLEMENT", "PLAN", "CODE_REVIEW", "SESSION_END", "ISSUE_FIX"], // approve → VERIFY/FINALIZE, reject → IMPLEMENT/PLAN, stay for next round; SESSION_END for tiered exit; T-208: ISSUE_FIX for issue-fix reviews
  VERIFY:        ["FINALIZE", "IMPLEMENT", "VERIFY"],  // pass → FINALIZE, fail → IMPLEMENT, retry
  FINALIZE:      ["COMPLETE", "PICK_TICKET"],  // ISS-084: issues now route through COMPLETE too; PICK_TICKET kept for in-flight session compat
  COMPLETE:      ["PICK_TICKET", "HANDOVER", "ISSUE_SWEEP", "SESSION_END"],
  ISSUE_FIX:     ["FINALIZE", "PICK_TICKET", "ISSUE_FIX", "CODE_REVIEW"],  // T-153: fix done → FINALIZE, cancel → PICK_TICKET, retry self; T-208: optional code review
  LESSON_CAPTURE: ["ISSUE_SWEEP", "HANDOVER", "LESSON_CAPTURE"],  // advance → ISSUE_SWEEP, retry self, done → HANDOVER
  ISSUE_SWEEP:   ["ISSUE_SWEEP", "HANDOVER", "PICK_TICKET"],  // retry (next issue), done → HANDOVER, loop → PICK_TICKET
  HANDOVER:      ["COMPACT", "SESSION_END", "PICK_TICKET"],
  COMPACT:       ["*"],                   // resume restores pre-compact state
  SESSION_END:   [],                      // terminal
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check if a state transition is valid.
 */
export function isValidTransition(from: WorkflowState, to: WorkflowState): boolean {
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to) || allowed.includes("*");
}

/**
 * Assert a state transition is valid. Throws if not.
 */
export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
}

/**
 * Get all valid target states from a given state.
 */
export function validTargets(from: WorkflowState): readonly WorkflowState[] {
  const allowed = TRANSITIONS[from];
  if (!allowed) return [];
  if (allowed.includes("*")) {
    // COMPACT can go anywhere — return all states except itself
    return Object.keys(TRANSITIONS).filter((s) => s !== from) as WorkflowState[];
  }
  return allowed as readonly WorkflowState[];
}

/**
 * Check if a state is terminal.
 */
export function isTerminal(state: WorkflowState): boolean {
  const allowed = TRANSITIONS[state];
  return !allowed || allowed.length === 0;
}
