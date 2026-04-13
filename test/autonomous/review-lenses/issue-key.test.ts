import { describe, it, expect } from "vitest";
import { generateIssueKey } from "../../../src/autonomous/review-lenses/issue-key.js";
import type { LensFinding } from "../../../src/autonomous/review-lenses/types.js";

const baseFinding: LensFinding = {
  lens: "security",
  lensVersion: "security-v1",
  severity: "critical",
  recommendedImpact: "blocker",
  category: "injection",
  description: "SQL injection via unparameterized query",
  file: "src/api/users.ts",
  line: 87,
  evidence: [
    { file: "src/api/users.ts", startLine: 87, endLine: 87, code: "db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)" },
  ],
  suggestedFix: null,
  confidence: 0.95,
  assumptions: null,
  requiresMoreContext: false,
};

describe("issue key generation", () => {
  it("generates deterministic key with file and line", () => {
    const key = generateIssueKey(baseFinding);
    expect(key).toBe("security:src/api/users.ts:87:injection");
  });

  it("same inputs produce same key", () => {
    expect(generateIssueKey(baseFinding)).toBe(generateIssueKey(baseFinding));
  });

  it("different files produce different keys", () => {
    const other = { ...baseFinding, file: "src/api/posts.ts" };
    expect(generateIssueKey(baseFinding)).not.toBe(generateIssueKey(other));
  });

  it("uses description hash for plan review findings without file/line", () => {
    const planFinding = { ...baseFinding, file: null, line: null };
    const key = generateIssueKey(planFinding);
    expect(key).toMatch(/^security:injection:[a-f0-9]+$/);
  });

  it("plan review keys are deterministic", () => {
    const planFinding = { ...baseFinding, file: null, line: null };
    expect(generateIssueKey(planFinding)).toBe(generateIssueKey(planFinding));
  });

  it("different descriptions produce different plan review keys", () => {
    const a = { ...baseFinding, file: null, line: null, description: "Missing auth on endpoint" };
    const b = { ...baseFinding, file: null, line: null, description: "No input validation strategy" };
    expect(generateIssueKey(a)).not.toBe(generateIssueKey(b));
  });
});
