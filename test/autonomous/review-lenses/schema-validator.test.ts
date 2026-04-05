import { describe, it, expect } from "vitest";
import { validateFindings } from "../../../src/autonomous/review-lenses/schema-validator.js";

const validFinding = {
  lens: "security",
  lensVersion: "security-v1",
  severity: "critical",
  recommendedImpact: "blocker",
  category: "injection",
  description: "SQL injection found",
  file: "src/api.ts",
  line: 42,
  evidence: "query = `SELECT * FROM users WHERE id = ${id}`",
  suggestedFix: "Use parameterized query",
  confidence: 0.95,
  assumptions: null,
  requiresMoreContext: false,
  inputSource: "req.params.id",
  sink: "db.query()",
};

describe("schema validator", () => {
  it("accepts valid findings", () => {
    const result = validateFindings([validFinding], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(0);
  });

  it("rejects non-objects", () => {
    const result = validateFindings(["string", 42, null], "security");
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(3);
  });

  it("rejects missing severity", () => {
    const { severity: _, ...noSeverity } = validFinding;
    const result = validateFindings([noSeverity], "security");
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].reason).toContain("severity");
  });

  it("rejects invalid severity value", () => {
    const result = validateFindings([{ ...validFinding, severity: "urgent" }], "security");
    expect(result.invalid).toHaveLength(1);
  });

  it("normalizes unknown recommendedImpact to non-blocking", () => {
    const result = validateFindings([{ ...validFinding, recommendedImpact: "maybe" }], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].recommendedImpact).toBe("non-blocking");
  });

  it("normalizes 'important' recommendedImpact to needs-revision", () => {
    const result = validateFindings([{ ...validFinding, recommendedImpact: "important" }], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].recommendedImpact).toBe("needs-revision");
  });

  it("rejects missing description", () => {
    const result = validateFindings([{ ...validFinding, description: "" }], "security");
    expect(result.invalid).toHaveLength(1);
  });

  it("rejects confidence out of range", () => {
    const result = validateFindings([{ ...validFinding, confidence: 1.5 }], "security");
    expect(result.invalid).toHaveLength(1);
  });

  it("accepts lens name mismatch (lenient -- agents sometimes get this wrong)", () => {
    const result = validateFindings([{ ...validFinding, lens: "clean-code" }], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(0);
  });

  it("defaults missing requiresMoreContext to false (lenient)", () => {
    const { requiresMoreContext: _, ...noField } = validFinding;
    const result = validateFindings([noField], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].requiresMoreContext).toBe(false);
  });

  it("maps title to description when description missing", () => {
    const { description: _, ...noDesc } = validFinding;
    const withTitle = { ...noDesc, title: "SQL injection in user endpoint" };
    const result = validateFindings([withTitle], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].description).toBe("SQL injection in user endpoint");
  });

  it("maps location to file when file missing", () => {
    const { file: _, line: __, ...noFile } = validFinding;
    const withLocation = { ...noFile, location: "src/api/users.ts:87" };
    const result = validateFindings([withLocation], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].file).toBe("src/api/users.ts");
    expect(result.valid[0].line).toBe(87);
  });

  it("handles mixed valid and invalid", () => {
    const result = validateFindings(
      [validFinding, { broken: true }, validFinding],
      "security",
    );
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(1);
  });

  // normalizeFields edge cases
  it("maps location without colon as file path (no line number)", () => {
    const { file: _, line: __, ...noFile } = validFinding;
    const withLocation = { ...noFile, location: "src/utils/helpers.ts" };
    const result = validateFindings([withLocation], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].file).toBe("src/utils/helpers.ts");
    expect(result.valid[0].line).toBeFalsy(); // undefined or null, both acceptable
  });

  it("handles location with non-numeric line suffix", () => {
    const { file: _, line: __, ...noFile } = validFinding;
    const withLocation = { ...noFile, location: "src/api.ts:abc" };
    const result = validateFindings([withLocation], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].file).toBe("src/api.ts");
    // NaN line number should not be set
  });

  it("preserves description when both title and description exist", () => {
    const withBoth = { ...validFinding, title: "Short title" };
    const result = validateFindings([withBoth], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].description).toBe("SQL injection found"); // original, not title
  });

  it("preserves file when both file and location exist", () => {
    const withBoth = { ...validFinding, location: "other/path.ts:99" };
    const result = validateFindings([withBoth], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].file).toBe("src/api.ts"); // original, not location
  });

  it("defaults all optional fields when missing", () => {
    const minimal = {
      lens: "security",
      severity: "major",
      category: "injection",
      description: "Found a bug",
      confidence: 0.8,
      file: null,
      line: null,
      evidence: null,
      suggestedFix: null,
    };
    const result = validateFindings([minimal], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].lensVersion).toBe("unknown");
    expect(result.valid[0].requiresMoreContext).toBe(false);
    expect(result.valid[0].assumptions).toBeNull();
    expect(result.valid[0].recommendedImpact).toBe("non-blocking");
  });

  it("injects lens from parent lensName when finding lacks lens field (ISS-092)", () => {
    const { lens: _, ...noLens } = validFinding;
    const result = validateFindings([noLens], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].lens).toBe("security");
  });

  it("does not inject lens when lensName is null and finding lacks lens field", () => {
    const { lens: _, ...noLens } = validFinding;
    const result = validateFindings([noLens], null);
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].reason).toBe("missing lens");
  });

  it("preserves finding's own lens even when lensName differs", () => {
    const result = validateFindings([{ ...validFinding, lens: "clean-code" }], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].lens).toBe("clean-code");
  });

  it("handles empty location string", () => {
    const { file: _, line: __, ...noFile } = validFinding;
    const withEmpty = { ...noFile, location: "" };
    const result = validateFindings([withEmpty], "security");
    // Empty location should not map to file
    expect(result.valid).toHaveLength(1);
  });
});
