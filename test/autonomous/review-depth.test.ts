/**
 * Fork hardening (T-1218/C1): strict risk readers for the review-skip gates.
 *
 * explicitRiskLevel / effectiveSkipRisk are the SKIP-safe counterparts of
 * normalizeRiskLevel: an unclassified value is null (never skip), never "low".
 * These unit-pin the boundary so a skip gate can never fire on a missing label
 * and a high seed can never be downgraded by a smaller realized risk.
 */
import { describe, it, expect } from "vitest";
import { explicitRiskLevel, effectiveSkipRisk } from "../../src/autonomous/review-depth.js";

describe("explicitRiskLevel", () => {
  it("passes through the canonical levels", () => {
    expect(explicitRiskLevel("low")).toBe("low");
    expect(explicitRiskLevel("medium")).toBe("medium");
    expect(explicitRiskLevel("high")).toBe("high");
  });

  it("returns null for anything non-canonical (never defaults to low)", () => {
    expect(explicitRiskLevel(undefined)).toBeNull();
    expect(explicitRiskLevel(null)).toBeNull();
    expect(explicitRiskLevel("")).toBeNull();
    expect(explicitRiskLevel("garbage")).toBeNull();
    expect(explicitRiskLevel("HIGH")).toBeNull();
    expect(explicitRiskLevel("lowish")).toBeNull();
  });
});

describe("effectiveSkipRisk", () => {
  it("returns null when neither seed nor realized is classified", () => {
    expect(effectiveSkipRisk(undefined, undefined)).toBeNull();
    expect(effectiveSkipRisk(null, null)).toBeNull();
    expect(effectiveSkipRisk("garbage", "")).toBeNull();
  });

  it("takes the MAX so a high seed survives a low realized risk", () => {
    expect(effectiveSkipRisk("high", "low")).toBe("high");
    expect(effectiveSkipRisk("low", "high")).toBe("high");
  });

  it("uses whichever side is classified when the other is missing", () => {
    expect(effectiveSkipRisk(undefined, "medium")).toBe("medium");
    expect(effectiveSkipRisk("medium", undefined)).toBe("medium");
    expect(effectiveSkipRisk("garbage", "low")).toBe("low");
  });

  it("returns the shared level when both agree", () => {
    expect(effectiveSkipRisk("medium", "medium")).toBe("medium");
    expect(effectiveSkipRisk("low", "low")).toBe("low");
  });
});
