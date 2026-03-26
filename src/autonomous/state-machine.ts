import type { WorkflowState } from "./session-types.js";

// ---------------------------------------------------------------------------
// State transition table
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<WorkflowState, readonly (WorkflowState | "*")[]> = {
  INIT:          ["PICK_TICKET"],         // start does INIT + LOAD_CONTEXT internally
  LOAD_CONTEXT:  ["PICK_TICKET"],         // internal (never seen by Claude)
  PICK_TICKET:   ["PLAN", "SESSION_END"],
  PLAN:          ["PLAN_REVIEW"],
  PLAN_REVIEW:   ["IMPLEMENT", "PLAN", "PLAN_REVIEW"],   // approve → IMPLEMENT, reject → PLAN, stay for next round
  IMPLEMENT:     ["CODE_REVIEW"],
  CODE_REVIEW:   ["FINALIZE", "IMPLEMENT", "PLAN", "CODE_REVIEW"], // approve → FINALIZE, reject → IMPLEMENT/PLAN, stay for next round
  FINALIZE:      ["COMPLETE"],
  COMPLETE:      ["PICK_TICKET", "HANDOVER", "SESSION_END"],
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
