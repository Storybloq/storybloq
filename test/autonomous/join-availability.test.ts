/**
 * T-488 D5: join quality is DERIVED, and this file is its only owner.
 *
 * An earlier revision stored `joinAvailability` on the record. That was wrong
 * for a reason worth keeping in front of a reader: a stored summary can
 * contradict the very ids it summarizes, and the ids are the evidence. So there
 * is one derivation, and it is asserted here and nowhere else -- a second copy
 * of this rule in another file is how the rule acquires a second meaning.
 *
 * The contract these tests pin is PUBLISHED, not just implemented: it appears
 * in `storybloq reference` so an external reader of raw artifacts is not left
 * to guess what a run id is the id of.
 */
import { describe, it, expect } from "vitest";
import { deriveJoinAvailability } from "../../src/autonomous/review-identity.js";

describe("deriveJoinAvailability", () => {
  it("a codex thread id alone is session-scoped, not exact", () => {
    // A codex session id names a THREAD spanning many turns, so it attributes
    // a round to the thread and no further. This is the case the fleet audit
    // found 667 times, and calling it exact is the error being closed.
    expect(deriveJoinAvailability({ backendRunId: "sess-1", backendRunIdKind: "codex-session" }))
      .toBe("session-scoped");
  });

  it("a codex thread id WITH a turn id is exact", () => {
    expect(deriveJoinAvailability({
      backendRunId: "sess-1", backendRunIdKind: "codex-session", backendTurnId: "turn-9",
    })).toBe("exact");
  });

  it("an agent dispatch id is exact on its own, because a dispatch IS one turn", () => {
    // Round 3 was right that "session-scoped" is not a safe blanket label: a
    // dispatch id does not have a thread's scope, and reporting it as merely
    // session-scoped would understate a join that is actually precise.
    expect(deriveJoinAvailability({ backendRunId: "disp-1", backendRunIdKind: "agent-dispatch" }))
      .toBe("exact");
  });

  it("a lens review id is exact on its own, for the same reason", () => {
    expect(deriveJoinAvailability({ backendRunId: "rev-1", backendRunIdKind: "lens-review" }))
      .toBe("exact");
  });

  it("a turn id with no parent run id joins nothing", () => {
    // A turn is meaningful only under its thread. Half an address is not a
    // weaker address, it is not an address.
    expect(deriveJoinAvailability({ backendTurnId: "turn-9" })).toBe("none");
  });

  it("a legacy record carrying neither is none, and absence is never read as exact", () => {
    expect(deriveJoinAvailability({})).toBe("none");
    expect(deriveJoinAvailability({ backendRunIdKind: "codex-session" })).toBe("none");
  });

  it("a run id of an unrecognized kind is session-scoped, and exact only with a turn id", () => {
    // A future backend this build does not know about still has SOME id. The
    // conservative reading is that it names something broader than one turn
    // until a turn id proves otherwise -- never the other way round.
    const unknownKind = { backendRunId: "x" } as { backendRunId: string };
    expect(deriveJoinAvailability(unknownKind)).toBe("session-scoped");
    expect(deriveJoinAvailability({ ...unknownKind, backendTurnId: "t" })).toBe("exact");
  });

  it("every declared kind is classified, so none falls through unlabelled", () => {
    const kinds = ["codex-session", "agent-dispatch", "lens-review"] as const;
    for (const kind of kinds) {
      expect(deriveJoinAvailability({ backendRunId: "x", backendRunIdKind: kind })).not.toBe("none");
    }
  });
});
