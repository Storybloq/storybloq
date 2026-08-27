/**
 * ISS-598/ISS-1031: the PLAN_REVIEW hard ceiling.
 *
 * The defect it closes: `isRevise` (ISS-048) claims every revise/request_changes
 * verdict and stays in PLAN_REVIEW unconditionally, and a `reject` verdict
 * clears `reviews.plan` and returns to PLAN for a full replan -- so neither
 * loop was ever visible to a counter derived from review history, and the
 * `roundNum >= 5` cap once written into the landing check's ternary could
 * never run (isRevise already consumed the verdict first). A real incident
 * ran unbounded past round 5 as a result.
 *
 * Mirrors code-review-ceiling.test.ts's structure: the ceiling number, the
 * counter's identity invariant, and when decidePlanCeiling fires -- adapted
 * for PLAN_REVIEW's own shape (fixed, not effort-derived; fires on the
 * reject-routed PLAN continuation too, not just PLAN_REVIEW continuations;
 * no isIssueFix exemption needed).
 */
import { describe, it, expect } from "vitest";
import {
  PLAN_REVIEW_HARD_CEILING_GRACE,
  DEFAULT_PLAN_REVIEW_MAX_ROUNDS,
  planReviewHardCeiling,
  nextPlanRoundCounter,
  decidePlanCeiling,
} from "../../src/autonomous/stages/plan-review-ceiling.js";

const TICKET = "t-planceiling0001";

describe("planReviewHardCeiling", () => {
  it("is a fixed constant: base rounds plus grace", () => {
    expect(planReviewHardCeiling()).toBe(DEFAULT_PLAN_REVIEW_MAX_ROUNDS + PLAN_REVIEW_HARD_CEILING_GRACE);
  });

  it("is not zero (unlike CODE_REVIEW's cap, this ceiling is never configurable to 'unlimited')", () => {
    expect(planReviewHardCeiling()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The counter, ticket-keyed and monotonic (identical semantics to
// code-review-ceiling.ts's nextRoundCounter)
// ---------------------------------------------------------------------------

describe("nextPlanRoundCounter", () => {
  it("counts up for the same ticket", () => {
    let c = nextPlanRoundCounter(null, TICKET);
    expect(c.completedRounds).toBe(1);
    c = nextPlanRoundCounter(c, TICKET);
    c = nextPlanRoundCounter(c, TICKET);
    expect(c.completedRounds).toBe(3);
  });

  /**
   * THE INVARIANT. A newly selected ticket must never inherit a poisoned
   * count -- true across park-and-repick without anything needing to
   * remember to reset it.
   */
  it("resets to 1 for a different ticket", () => {
    const poisoned = { ticketId: "t-previous", completedRounds: 14 };
    expect(nextPlanRoundCounter(poisoned, TICKET).completedRounds).toBe(1);
  });

  it("starts at 1 with no prior counter at all", () => {
    expect(nextPlanRoundCounter(undefined, TICKET).completedRounds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// When it fires
// ---------------------------------------------------------------------------

describe("decidePlanCeiling", () => {
  const CEILING = DEFAULT_PLAN_REVIEW_MAX_ROUNDS + PLAN_REVIEW_HARD_CEILING_GRACE; // 8

  function decide(completedRounds: number, over: Partial<Parameters<typeof decidePlanCeiling>[0]> = {}) {
    return decidePlanCeiling({
      ticketId: TICKET,
      priorCounter: { ticketId: TICKET, completedRounds },
      nextAction: "PLAN_REVIEW",
      ...over,
    });
  }

  /**
   * The boundary is the whole point of counting the round IN HAND: comparing
   * the stored count fires one round late, because the round being reported
   * is not persisted until after the routing decision.
   */
  it("does not fire one round early", () => {
    expect(decide(CEILING - 2).shouldPark).toBe(false);
  });

  it("fires exactly at the ceiling", () => {
    const d = decide(CEILING - 1);
    expect(d.counter?.completedRounds).toBe(CEILING);
    expect(d.shouldPark).toBe(true);
  });

  it("still fires past the ceiling", () => {
    expect(decide(CEILING).shouldPark).toBe(true);
  });

  /**
   * The guard that makes the ceiling provably incapable of changing an
   * outcome that was already landing. It can only ever convert a would-be
   * CONTINUATION into a park.
   */
  it("never converts a landing into a park", () => {
    expect(decide(CEILING + 5, { nextAction: "IMPLEMENT" }).shouldPark).toBe(false);
  });

  /**
   * ISS-904's blind spot, closed: a reject/replan loop clears `reviews.plan`
   * every round, so nothing derived from that array ever saw it. The ceiling
   * fires on the reject-routed PLAN continuation exactly the same as an
   * ordinary PLAN_REVIEW continuation.
   */
  it("fires on a reject-routed PLAN continuation, not just a PLAN_REVIEW one", () => {
    expect(decide(CEILING - 1, { nextAction: "PLAN" }).shouldPark).toBe(true);
  });

  it("does not fire with no ticket to park", () => {
    expect(decidePlanCeiling({
      ticketId: undefined,
      priorCounter: null,
      nextAction: "PLAN_REVIEW",
    }).shouldPark).toBe(false);
  });

  /**
   * `!ticketId` is the ONLY guard `decidePlanCeiling` applies (no isIssueFix
   * exemption is needed: PLAN_REVIEW's TRANSITIONS row is never reached for
   * an issue fix at all). This pins that a no-ticket session can never reach
   * `shouldPark: true` no matter how high a stale counter claims to be --
   * the Gate-1 ratification's explicitly requested verification.
   */
  it("never reaches shouldPark true for a session with no ticket, regardless of a stale counter", () => {
    const d = decidePlanCeiling({
      ticketId: undefined,
      priorCounter: { ticketId: "t-stale", completedRounds: 999 },
      nextAction: "PLAN_REVIEW",
    });
    expect(d.shouldPark).toBe(false);
    expect(d.counter).toBeNull();
  });

  /**
   * A ticket switch resets the count, so an item that inherits a previous
   * item's rounds cannot be parked on its first review.
   */
  it("does not fire for a fresh ticket carrying a previous ticket's count", () => {
    const d = decidePlanCeiling({
      ticketId: TICKET,
      priorCounter: { ticketId: "t-previous", completedRounds: 99 },
      nextAction: "PLAN_REVIEW",
    });
    expect(d.counter?.completedRounds).toBe(1);
    expect(d.shouldPark).toBe(false);
  });

  it("reports the ceiling value on every decision, even ones that do not fire", () => {
    expect(decide(1).ceiling).toBe(CEILING);
    expect(decide(CEILING).ceiling).toBe(CEILING);
  });
});
