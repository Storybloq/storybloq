import { describe, it, expect } from "vitest";
import { GateAckSchema, computeGateAckId, type GateAckPin } from "../../src/models/gate-ack.js";

const PLAN_PIN: GateAckPin = { kind: "plan-hash", sha256: "a".repeat(64) };
const TREE_PIN: GateAckPin = { kind: "tree-digest", parentSha: "b".repeat(40), treeId: "c".repeat(40) };

function baseAck(overrides: Record<string, unknown> = {}) {
  return {
    id: computeGateAckId("a-0123456789abcdef", "plan-ack", "t-0123456789abcdef", PLAN_PIN),
    arrangementId: "a-0123456789abcdef",
    gateName: "plan-ack",
    ackRole: "pen",
    ticketRef: "t-0123456789abcdef",
    pin: PLAN_PIN,
    decidedAt: "2026-08-28T00:00:00.000Z",
    reviewTrail: { present: false },
    contested: false,
    ...overrides,
  };
}

describe("GateAckSchema", () => {
  it("parses a well-formed plan-hash ack", () => {
    const result = GateAckSchema.safeParse(baseAck());
    expect(result.success).toBe(true);
  });

  it("parses a well-formed tree-digest ack", () => {
    const id = computeGateAckId("a-0123456789abcdef", "pre-commit-ack", "t-0123456789abcdef", TREE_PIN);
    const result = GateAckSchema.safeParse(
      baseAck({ id, gateName: "pre-commit-ack", ackRole: "pen", pin: TREE_PIN }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a plan-hash pin with a malformed sha256", () => {
    const result = GateAckSchema.safeParse(baseAck({ pin: { kind: "plan-hash", sha256: "not-hex" } }));
    expect(result.success).toBe(false);
  });

  it("rejects a tree-digest pin with a short (non-sha1-length) parentSha", () => {
    const result = GateAckSchema.safeParse(
      baseAck({ pin: { kind: "tree-digest", parentSha: "abc", treeId: "c".repeat(40) } }),
    );
    expect(result.success).toBe(false);
  });

  describe("reviewTrail correlation", () => {
    it("rejects present=true with no verdict", () => {
      const result = GateAckSchema.safeParse(baseAck({ reviewTrail: { present: true } }));
      expect(result.success).toBe(false);
    });

    it("accepts present=true with a verdict", () => {
      const result = GateAckSchema.safeParse(
        baseAck({ reviewTrail: { present: true, verdict: "approve", codexSessionId: "sess-1", rounds: 2 } }),
      );
      expect(result.success).toBe(true);
    });

    it("rejects present=false carrying evidence fields", () => {
      const result = GateAckSchema.safeParse(baseAck({ reviewTrail: { present: false, verdict: "approve" } }));
      expect(result.success).toBe(false);
    });

    it("accepts present=false with no evidence fields", () => {
      const result = GateAckSchema.safeParse(baseAck({ reviewTrail: { present: false } }));
      expect(result.success).toBe(true);
    });
  });

  describe("contested correlation", () => {
    it("rejects contested=true with no contestedReason", () => {
      const result = GateAckSchema.safeParse(baseAck({ contested: true }));
      expect(result.success).toBe(false);
    });

    it("rejects contested=true with a blank contestedReason", () => {
      const result = GateAckSchema.safeParse(baseAck({ contested: true, contestedReason: "   " }));
      expect(result.success).toBe(false);
    });

    it("accepts contested=true with a real contestedReason", () => {
      const result = GateAckSchema.safeParse(baseAck({ contested: true, contestedReason: "pin was wrong" }));
      expect(result.success).toBe(true);
    });

    it("rejects contested=false carrying a contestedReason", () => {
      const result = GateAckSchema.safeParse(baseAck({ contested: false, contestedReason: "leftover" }));
      expect(result.success).toBe(false);
    });
  });
});

describe("computeGateAckId", () => {
  const args = ["a-0123456789abcdef", "plan-ack", "t-0123456789abcdef", PLAN_PIN] as const;

  it("is deterministic for identical inputs", () => {
    expect(computeGateAckId(...args)).toBe(computeGateAckId(...args));
  });

  it("matches the g-<16 hex> canonical shape", () => {
    expect(computeGateAckId(...args)).toMatch(/^g-[0-9a-f]{16}$/);
  });

  it("changes when arrangementId changes", () => {
    expect(computeGateAckId("a-fedcba9876543210", "plan-ack", "t-0123456789abcdef", PLAN_PIN)).not.toBe(
      computeGateAckId(...args),
    );
  });

  it("changes when gateName changes", () => {
    expect(computeGateAckId("a-0123456789abcdef", "pre-commit-ack", "t-0123456789abcdef", PLAN_PIN)).not.toBe(
      computeGateAckId(...args),
    );
  });

  it("changes when ticketRef changes", () => {
    expect(computeGateAckId("a-0123456789abcdef", "plan-ack", "t-fedcba9876543210", PLAN_PIN)).not.toBe(
      computeGateAckId(...args),
    );
  });

  it("changes when the pin changes", () => {
    expect(computeGateAckId("a-0123456789abcdef", "plan-ack", "t-0123456789abcdef", TREE_PIN)).not.toBe(
      computeGateAckId(...args),
    );
  });

  it("does NOT change when only deltas would differ (deltas is not an id input at all)", () => {
    // computeGateAckId takes no deltas parameter -- this test documents that
    // omission is deliberate (see the function's doc comment) rather than an
    // oversight: two conceptually-different-deltas acks for the same
    // (arrangementId, gateName, ticketRef, pin) always compute the SAME id.
    expect(computeGateAckId(...args)).toBe(computeGateAckId(...args));
  });
});
