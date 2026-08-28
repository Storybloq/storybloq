import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeElapsedWithClockSkew } from "../../src/core/clock-skew.js";

/**
 * T-477 section 3.2's ONE clock-skew rule, and section 7's cross-language
 * requirement: this fixture is the LITERAL SAME file consumed by
 * `ClaudeStoryModels/Tests/ClaudeStoryModelsTests/MilestoneClockSkewTests.swift`
 * (see that file's `#filePath`-based resolution), proving the rule was
 * actually implemented identically twice, not just stated once. Mirrors the
 * team-features.json precedent (ISS-684).
 */
interface ClockSkewCase {
  readonly name: string;
  readonly nowMs: number;
  readonly at: string;
  readonly expectedElapsedSeconds: number;
  readonly expectedClockAnomaly: boolean;
}

const CASES: readonly ClockSkewCase[] = JSON.parse(
  readFileSync(new URL("../fixtures/clock-skew-cases.json", import.meta.url), "utf8"),
);

describe("computeElapsedWithClockSkew", () => {
  it("has at least the boundary and unparseable cases the cross-language test relies on", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(6);
  });

  for (const c of CASES) {
    it(`fixture: ${c.name}`, () => {
      const result = computeElapsedWithClockSkew(c.at, c.nowMs);
      expect(result.elapsedSeconds).toBe(c.expectedElapsedSeconds);
      expect(result.clockAnomaly).toBe(c.expectedClockAnomaly);
    });
  }

  it("never returns a negative elapsedSeconds even at the tolerance boundary", () => {
    for (const c of CASES) {
      const result = computeElapsedWithClockSkew(c.at, c.nowMs);
      expect(result.elapsedSeconds).toBeGreaterThanOrEqual(0);
    }
  });
});
