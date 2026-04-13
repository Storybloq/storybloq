import { describe, it, expect } from "vitest";
import { computeBlocking } from "../../../src/autonomous/review-lenses/blocking-policy.js";
import { DEFAULT_BLOCKING_POLICY } from "../../../src/autonomous/review-lenses/types.js";
import type { LensFinding } from "../../../src/autonomous/review-lenses/types.js";

const baseFinding: LensFinding = {
  lens: "security",
  lensVersion: "security-v1",
  severity: "critical",
  recommendedImpact: "blocker",
  category: "injection",
  description: "SQL injection",
  file: "src/api.ts",
  line: 10,
  evidence: [
    { file: "src/api.ts", startLine: 10, endLine: 10, code: "db.query(req.params.id)" },
  ],
  suggestedFix: null,
  confidence: 0.9,
  assumptions: null,
  requiresMoreContext: false,
};

describe("blocking policy", () => {
  it("blocks critical injection findings in code review", () => {
    expect(computeBlocking(baseFinding, "CODE_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(true);
  });

  it("respects neverBlock override", () => {
    const policy = { ...DEFAULT_BLOCKING_POLICY, neverBlock: ["security"] };
    expect(computeBlocking(baseFinding, "CODE_REVIEW", policy)).toBe(false);
  });

  it("respects alwaysBlock category", () => {
    const finding = { ...baseFinding, lens: "clean-code", category: "auth-bypass", recommendedImpact: "non-blocking" as const };
    expect(computeBlocking(finding, "CODE_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(true);
  });

  it("plan review only blocks security/error-handling critical+high-confidence", () => {
    expect(computeBlocking(baseFinding, "PLAN_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(true);

    const cleanCodeFinding = { ...baseFinding, lens: "clean-code", category: "srp" };
    expect(computeBlocking(cleanCodeFinding, "PLAN_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(false);
  });

  it("alwaysBlock categories override confidence threshold", () => {
    const lowConf = { ...baseFinding, confidence: 0.5 };
    // Low confidence but "injection" is in alwaysBlock -- still blocked
    expect(computeBlocking(lowConf, "CODE_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(true);
  });

  it("does not block low-confidence blocker with non-alwaysBlock category", () => {
    const lowConf = { ...baseFinding, confidence: 0.5, category: "srp" };
    expect(computeBlocking(lowConf, "CODE_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(false);
  });

  it("non-blocking recommendations are not blocking", () => {
    const nonBlocking = {
      ...baseFinding,
      recommendedImpact: "non-blocking" as const,
      category: "naming",
      severity: "minor" as const,
    };
    expect(computeBlocking(nonBlocking, "CODE_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(false);
  });

  it("alwaysBlock overrides plan review advisory behavior", () => {
    // "injection" is in alwaysBlock -- blocks even in PLAN_REVIEW regardless of lens or confidence
    const finding = { ...baseFinding, lens: "clean-code", confidence: 0.5, category: "injection" };
    expect(computeBlocking(finding, "PLAN_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(true);
  });

  it("needs-revision only blocks at critical+high-confidence", () => {
    const needsRevision = { ...baseFinding, recommendedImpact: "needs-revision" as const, category: "srp" };
    expect(computeBlocking(needsRevision, "CODE_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(true);

    const majorNeedsRevision = { ...needsRevision, severity: "major" as const };
    expect(computeBlocking(majorNeedsRevision, "CODE_REVIEW", DEFAULT_BLOCKING_POLICY)).toBe(false);
  });
});
