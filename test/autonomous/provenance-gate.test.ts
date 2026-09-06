/**
 * ISS-1115 3.3a/3.3b: the provenance gate.
 *
 * FOUR OUTCOMES, NOT A BOOLEAN, and the distinctions are the content. "This
 * round did not label its findings" is a process failure a reviewer can fix by
 * relabelling. "This label could not be read" is a condition of one finding.
 * "This backend cannot express the label at all" is a compatibility fact about
 * lenses. Collapsing any pair sends someone to fix the wrong thing, and
 * collapsing the last one loops a lens round forever.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateProvenanceGate,
  backendCanCarryProvenance,
  PROVENANCE_REPAIR_INSTRUCTION,
} from "../../src/autonomous/review-identity.js";

const f = (over: Record<string, unknown> = {}) => ({
  severity: "major", category: "correctness", description: "d", disposition: "open", ...over,
});
const gate = (over: Partial<Parameters<typeof evaluateProvenanceGate>[0]> = {}) =>
  evaluateProvenanceGate({
    roundNum: 2, backend: "codex", findings: [f({ originClass: "new" })], repairSpent: false, ...over,
  });

describe("ISS-1115: round 1 asks for no label", () => {
  it("passes an unlabelled round 1", () => {
    expect(gate({ roundNum: 1, findings: [f()] }).kind).toBe("ok");
  });

  it("still rejects an UNREADABLE label on round 1", () => {
    // A reporter that wrote something unreadable made a claim. That is not the
    // same as not labelling, and a round number must not excuse it.
    const g = gate({ roundNum: 1, findings: [f({ originClass: "re-introduced" })] });
    expect(g.kind).toBe("unresolved");
  });
});

describe("ISS-1115 3.3a: metadata repair on round 2+", () => {
  it("asks for a repair when a finding is unlabelled", () => {
    const g = gate({ findings: [f(), f({ originClass: "new" })] });
    expect(g.kind).toBe("repair");
    if (g.kind === "repair") {
      expect(g.unlabelled).toBe(1);
      expect(g.instruction).toBe(PROVENANCE_REPAIR_INSTRUCTION);
      // The instruction must not invite a fresh review, or the repair becomes a
      // way to relitigate findings rather than to label them.
      expect(g.instruction).toMatch(/Do not drop, add or reword any finding/);
    }
  });

  it("passes when every finding IS labelled (the positive control)", () => {
    expect(gate({ findings: [f({ originClass: "new" }), f({ originClass: "unchanged" })] }).kind)
      .toBe("ok");
  });

  it("is BOUNDED: after one repair it resolves rather than asking again", () => {
    // Unbounded rejection stalls a round with no round consumed and no exit,
    // which is worse than the missing label it is chasing.
    const g = gate({ findings: [f()], repairSpent: true });
    expect(g.kind).toBe("unresolved");
    if (g.kind === "unresolved") {
      expect(g.reasons.join(" ")).toMatch(/still unlabelled after a metadata repair/);
    }
  });

  it("NEVER discards the finding, whatever the outcome", () => {
    // The gate returns a verdict about the round; it does not filter findings.
    // An unlabelled finding is still an evidenced defect, and dropping one over
    // a metadata problem is the quiet failure this whole item exists to stop.
    for (const repairSpent of [false, true]) {
      const g = gate({ findings: [f()], repairSpent });
      expect(g).not.toHaveProperty("findings");
      expect(["repair", "unresolved"]).toContain(g.kind);
    }
  });
});

describe("ISS-1115 3.3b: the lens exemption", () => {
  it("exempts lenses, which CANNOT express the label", () => {
    // LensFindingSchema and MergedFindingSchema are `.strict()` with zero
    // `originClass`. Without this, every lens round enters a repair loop the
    // backend has no way to exit: a fleet stop, not a degradation.
    const g = gate({ backend: "lenses", findings: [f(), f()] });
    expect(g.kind).toBe("exempt");
  });

  it("RECORDS the exemption instead of applying it silently", () => {
    // A silent exemption and a check that failed to run look identical from
    // outside, and telling them apart is the whole reason this is reported.
    const g = gate({ backend: "lenses", findings: [f()] });
    if (g.kind === "exempt") {
      expect(g.reason).toContain("lenses");
      expect(g.reason).toMatch(/cannot express originClass/);
    }
  });

  it("exempts NOBODY else", () => {
    for (const backend of ["codex", "agent", "codex-native", "anything"]) {
      expect(backendCanCarryProvenance(backend)).toBe(true);
      expect(gate({ backend, findings: [f()] }).kind).toBe("repair");
    }
    expect(backendCanCarryProvenance("lenses")).toBe(false);
  });

  it("does not let the exemption swallow an UNREADABLE label", () => {
    // Exemption covers "cannot produce the label". It does not cover a payload
    // that produced something unreadable, whatever backend it came from.
    const g = gate({ backend: "lenses", findings: [f({ originClass: "garbage" })] });
    expect(g.kind).toBe("unresolved");
  });
});
