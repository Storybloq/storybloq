/**
 * ISS-965 T5: the five HANDOVER edges state-machine.ts gained for terminal
 * routing (IMPLEMENT, WRITE_TESTS, TEST, VERIFY, BUILD -> HANDOVER).
 *
 * Positives prove the edges terminalizeCompletedSession's assertTransition
 * call actually needs are present. Negatives pin that the table was widened
 * ADDITIVELY, not by loosening validation generally -- a table that accepted
 * every target from every source would make these five assertions pass for
 * the wrong reason.
 */
import { describe, it, expect } from "vitest";
import { isValidTransition } from "../../src/autonomous/state-machine.js";

describe("state-machine transitions (ISS-965 T5)", () => {
  it("allows HANDOVER from the five states terminal routing needs", () => {
    for (const from of ["IMPLEMENT", "WRITE_TESTS", "TEST", "VERIFY", "BUILD"] as const) {
      expect(isValidTransition(from, "HANDOVER"), `${from} -> HANDOVER`).toBe(true);
    }
  });

  it("still allows HANDOVER from the three states that already listed it", () => {
    for (const from of ["PLAN", "PLAN_REVIEW", "CODE_REVIEW"] as const) {
      expect(isValidTransition(from, "HANDOVER"), `${from} -> HANDOVER`).toBe(true);
    }
  });

  it("negative: does not widen TEST -> COMPLETE", () => {
    expect(isValidTransition("TEST", "COMPLETE")).toBe(false);
  });

  it("negative: does not widen VERIFY -> PICK_TICKET", () => {
    expect(isValidTransition("VERIFY", "PICK_TICKET")).toBe(false);
  });

  it("negative: does not widen BUILD -> SESSION_END", () => {
    expect(isValidTransition("BUILD", "SESSION_END")).toBe(false);
  });
});
