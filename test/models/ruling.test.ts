import { describe, it, expect } from "vitest";
import { RulingSchema } from "../../src/models/ruling.js";

function baseRuling(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-0123456789abcdef",
    text: "The lens-cache evidence stands; the total is 337.",
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "claude-session-abc" },
    date: "2026-08-27",
    supersedes: null,
    ...overrides,
  };
}

describe("RulingSchema", () => {
  it("parses a well-formed ruling", () => {
    const result = RulingSchema.safeParse(baseRuling());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attribution).toBe("owner-direct");
      expect(result.data.supersedes).toBeNull();
      expect(result.data.scopeTags).toEqual([]);
    }
  });

  it("accepts all three attribution values", () => {
    for (const attribution of ["owner-direct", "owner-via-manager-with-owner-veto", "manager-delegated"]) {
      const result = RulingSchema.safeParse(baseRuling({ attribution }));
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown attribution value", () => {
    const result = RulingSchema.safeParse(baseRuling({ attribution: "owner-implied" }));
    expect(result.success).toBe(false);
  });

  it("rejects empty text (verbatim means never blank)", () => {
    const result = RulingSchema.safeParse(baseRuling({ text: "" }));
    expect(result.success).toBe(false);
  });

  it("does not trim or transform text -- verbatim is byte-verbatim", () => {
    const withWhitespace = baseRuling({ text: "  leading and trailing spaces preserved  \n" });
    const result = RulingSchema.safeParse(withWhitespace);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe("  leading and trailing spaces preserved  \n");
    }
  });

  it("rejects an invalid ID format", () => {
    const result = RulingSchema.safeParse(baseRuling({ id: "RUL-001" }));
    expect(result.success).toBe(false);
  });

  it("accepts a supersedes pointer to another canonical ruling id", () => {
    const result = RulingSchema.safeParse(baseRuling({ supersedes: "r-9876543210abcdef" }));
    expect(result.success).toBe(true);
  });

  it("rejects a malformed recordedBy (missing client)", () => {
    const result = RulingSchema.safeParse(baseRuling({ recordedBy: { id: "claude-session-abc" } }));
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported recordedBy.client", () => {
    const result = RulingSchema.safeParse(
      baseRuling({ recordedBy: { client: "gemini", id: "claude-session-abc" } }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts explicit scopeTags", () => {
    const result = RulingSchema.safeParse(baseRuling({ scopeTags: ["duet-mode", "N-108"] }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopeTags).toEqual(["duet-mode", "N-108"]);
    }
  });

  it("preserves unknown extra keys through parse and serialize (passthrough)", () => {
    const data = baseRuling({ someFutureField: "preserved" });
    const result = RulingSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).someFutureField).toBe("preserved");
      const roundTripped = RulingSchema.safeParse(JSON.parse(JSON.stringify(result.data)));
      expect(roundTripped.success).toBe(true);
      if (roundTripped.success) {
        expect((roundTripped.data as Record<string, unknown>).someFutureField).toBe("preserved");
      }
    }
  });
});
