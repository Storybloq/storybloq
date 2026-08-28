import { describe, it, expect } from "vitest";
import { ArrangementSchema } from "../../src/models/arrangement.js";

function baseArrangement(overrides: Record<string, unknown> = {}) {
  return {
    id: "a-0123456789abcdef",
    lifecycle: "active",
    bounds: ["T-473"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
      { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-08-27",
    ...overrides,
  };
}

describe("ArrangementSchema", () => {
  describe("valid arrangements", () => {
    it("parses a well-formed two-party arrangement", () => {
      const result = ArrangementSchema.safeParse(baseArrangement());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parties).toHaveLength(2);
        expect(result.data.unreachability.onIrreversibleWork).toBe("hold");
      }
    });

    it("accepts a display-form bound ref", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["T-473"] }));
      expect(result.success).toBe(true);
    });

    it("accepts a canonical bound ref (binding item 1: mixed ledger is permanent)", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: ["t-0123456789abcdef"] }));
      expect(result.success).toBe(true);
    });

    it("accepts a mix of display-form and canonical bounds", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({ bounds: ["T-473", "i-0123456789abcdef"] }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts onIrreversibleWork: escalate", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({ unreachability: { onIrreversibleWork: "escalate" } }),
      );
      expect(result.success).toBe(true);
    });

    it("preserves unknown extra keys through parse and serialize (passthrough)", () => {
      const data = baseArrangement({ someFutureField: "preserved" });
      const result = ArrangementSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).someFutureField).toBe("preserved");
        const roundTripped = ArrangementSchema.safeParse(JSON.parse(JSON.stringify(result.data)));
        expect(roundTripped.success).toBe(true);
        if (roundTripped.success) {
          expect((roundTripped.data as Record<string, unknown>).someFutureField).toBe("preserved");
        }
      }
    });

    it("reserves a per-party provenanceLogRef field without requiring it (acceptance 5)", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "claude-session-abc", provenanceLogRef: "bus://thread/1" },
            { role: "worker", client: "codex", identityAnchor: "codex-thread-def" },
          ],
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parties[0]?.provenanceLogRef).toBe("bus://thread/1");
      }
    });
  });

  describe("party topology invariant", () => {
    it("rejects two workers and no pen", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "worker", client: "claude", identityAnchor: "claude-session-abc" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects two pens and no worker", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
            { role: "pen", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects duplicate identity (same client + identityAnchor) even across roles", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "same-anchor" },
            { role: "worker", client: "claude", identityAnchor: "same-anchor" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a single-party arrangement (array min length)", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({ parties: [{ role: "pen", client: "claude", identityAnchor: "claude-session-abc" }] }),
      );
      expect(result.success).toBe(false);
    });

    it("accepts the same identityAnchor across different clients", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "shared-name" },
            { role: "worker", client: "codex", identityAnchor: "shared-name" },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("unreachability.onIrreversibleWork (binding item 4)", () => {
    it("rejects 'continue' as structurally unrepresentable", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({ unreachability: { onIrreversibleWork: "continue" } }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a missing onIrreversibleWork", () => {
      const candidate = baseArrangement();
      delete (candidate as { unreachability?: unknown }).unreachability;
      const result = ArrangementSchema.safeParse({ ...candidate, unreachability: {} });
      expect(result.success).toBe(false);
    });
  });

  describe("identityAnchor format", () => {
    it("rejects an identityAnchor that does not match CLIENT_TASK_ID_PATTERN", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "has a space" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects an empty identityAnchor", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "claude", identityAnchor: "" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe("invalid arrangements", () => {
    it("rejects invalid ID format", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ id: "ARR-001" }));
      expect(result.success).toBe(false);
    });

    it("rejects an empty bounds array", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ bounds: [] }));
      expect(result.success).toBe(false);
    });

    it("rejects an invalid lifecycle", () => {
      const result = ArrangementSchema.safeParse(baseArrangement({ lifecycle: "archived" }));
      expect(result.success).toBe(false);
    });

    it("rejects an invalid client", () => {
      const result = ArrangementSchema.safeParse(
        baseArrangement({
          parties: [
            { role: "pen", client: "gemini", identityAnchor: "claude-session-abc" },
            { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });
  });
});
