import { describe, it, expect } from "vitest";
import {
  lensFindingSchema,
  evidenceItemSchema,
  parseLensFinding,
  isLegacyBridgedEvidence,
  LEGACY_NO_CODE_PLACEHOLDER,
  LEGACY_UNLOCATED_FILE,
} from "../../../src/autonomous/review-lenses/index.js";
import type {
  LensFinding,
  EvidenceItem,
} from "../../../src/autonomous/review-lenses/types.js";

const baseFindingFields = {
  lens: "security",
  lensVersion: "security-v1",
  severity: "critical" as const,
  recommendedImpact: "blocker" as const,
  category: "injection",
  description: "SQL injection via string concatenation",
  file: "src/api/users.ts",
  line: 42,
  suggestedFix: "Use parameterized query",
  confidence: 0.9,
  assumptions: null,
  requiresMoreContext: false,
};

const validEvidenceItem: EvidenceItem = {
  file: "src/api/users.ts",
  startLine: 42,
  endLine: 42,
  code: "db.query('SELECT * FROM users WHERE id=' + req.params.id)",
};

describe("evidenceItemSchema (Zod)", () => {
  it("accepts a concrete evidence item", () => {
    const parsed = evidenceItemSchema.safeParse(validEvidenceItem);
    expect(parsed.success).toBe(true);
  });

  it("accepts a multi-line evidence item (endLine > startLine)", () => {
    const parsed = evidenceItemSchema.safeParse({
      file: "src/api/users.ts",
      startLine: 40,
      endLine: 45,
      code: "function handler() {\n  // body\n}",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an evidence item with empty file", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      file: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects whitespace-only file (CDX-5 trim().min(1))", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      file: "   \t\n",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an evidence item with empty code", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      code: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects whitespace-only code", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      code: "   ",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects non-integer startLine (CDX-5)", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      startLine: 1.5,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects NaN startLine (CDX-5 .finite())", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      startLine: NaN,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects Infinity startLine (CDX-5 .finite())", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      startLine: Infinity,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects startLine < 1 (0-indexed)", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      startLine: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects negative startLine", () => {
    const parsed = evidenceItemSchema.safeParse({
      ...validEvidenceItem,
      startLine: -1,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects endLine < startLine", () => {
    const parsed = evidenceItemSchema.safeParse({
      file: "a.ts",
      startLine: 10,
      endLine: 5,
      code: "some code",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts the sentinel file LEGACY_UNLOCATED_FILE", () => {
    const parsed = evidenceItemSchema.safeParse({
      file: LEGACY_UNLOCATED_FILE,
      startLine: 1,
      endLine: 1,
      code: "x",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the sentinel code LEGACY_NO_CODE_PLACEHOLDER", () => {
    const parsed = evidenceItemSchema.safeParse({
      file: "a.ts",
      startLine: 1,
      endLine: 1,
      code: LEGACY_NO_CODE_PLACEHOLDER,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("lensFindingSchema (Zod)", () => {
  it("accepts a valid single-site finding", () => {
    const finding: LensFinding = {
      ...baseFindingFields,
      evidence: [validEvidenceItem],
    };
    const parsed = lensFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
  });

  it("accepts a multi-site finding with multiple evidence items", () => {
    const finding: LensFinding = {
      ...baseFindingFields,
      evidence: [
        validEvidenceItem,
        {
          file: "src/api/users.ts",
          startLine: 50,
          endLine: 52,
          code: "// caller site",
        },
      ],
    };
    const parsed = lensFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
  });

  it("rejects a finding with missing evidence array", () => {
    const { ...noEvidence } = baseFindingFields;
    const parsed = lensFindingSchema.safeParse(noEvidence);
    expect(parsed.success).toBe(false);
  });

  it("rejects a finding with an empty evidence array", () => {
    const finding = {
      ...baseFindingFields,
      evidence: [],
    };
    const parsed = lensFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(false);
  });

  it("rejects a finding with a malformed evidence item", () => {
    const finding = {
      ...baseFindingFields,
      evidence: [
        {
          file: "",
          startLine: 1,
          endLine: 1,
          code: "x",
        },
      ],
    };
    const parsed = lensFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(false);
  });

  it("preserves orchestrator-enriched fields via .passthrough() (CDX-4)", () => {
    const finding = {
      ...baseFindingFields,
      evidence: [validEvidenceItem],
      issueKey: "k-X",
      blocking: true,
      origin: "introduced",
      resolvedModel: "claude-sonnet-4-6",
      mergedFrom: ["security"],
    };
    const parsed = lensFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as Record<string, unknown>;
      expect(data.issueKey).toBe("k-X");
      expect(data.blocking).toBe(true);
      expect(data.origin).toBe("introduced");
      expect(data.resolvedModel).toBe("claude-sonnet-4-6");
      expect(data.mergedFrom).toEqual(["security"]);
    }
  });

  it("accepts a finding with legacySynthesizedEvidence marker", () => {
    const finding = {
      ...baseFindingFields,
      evidence: [
        {
          file: "src/api/users.ts",
          startLine: 42,
          endLine: 42,
          code: LEGACY_NO_CODE_PLACEHOLDER,
        },
      ],
      legacySynthesizedEvidence: true,
    };
    const parsed = lensFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
  });

  it("accepts a finding with legacyUnlocated marker", () => {
    const finding = {
      ...baseFindingFields,
      file: null,
      line: null,
      evidence: [
        {
          file: LEGACY_UNLOCATED_FILE,
          startLine: 1,
          endLine: 1,
          code: "real code",
        },
      ],
      legacyUnlocated: true,
    };
    const parsed = lensFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
  });

  it("accepts a finding with both markers true", () => {
    const finding = {
      ...baseFindingFields,
      file: null,
      line: null,
      evidence: [
        {
          file: LEGACY_UNLOCATED_FILE,
          startLine: 1,
          endLine: 1,
          code: LEGACY_NO_CODE_PLACEHOLDER,
        },
      ],
      legacySynthesizedEvidence: true,
      legacyUnlocated: true,
    };
    const parsed = lensFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(true);
  });
});

describe("parseLensFinding convenience wrapper", () => {
  it("returns ok: true on valid input", () => {
    const result = parseLensFinding({
      ...baseFindingFields,
      evidence: [validEvidenceItem],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.evidence).toHaveLength(1);
    }
  });

  it("returns ok: false with an error string on invalid input", () => {
    const result = parseLensFinding({
      ...baseFindingFields,
      evidence: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe("isLegacyBridgedEvidence helper (CDX-9)", () => {
  it("returns false when neither marker is set", () => {
    const finding: LensFinding = {
      ...baseFindingFields,
      evidence: [validEvidenceItem],
    };
    expect(isLegacyBridgedEvidence(finding)).toBe(false);
  });

  it("returns true when legacySynthesizedEvidence is true", () => {
    const finding: LensFinding = {
      ...baseFindingFields,
      evidence: [validEvidenceItem],
      legacySynthesizedEvidence: true,
    };
    expect(isLegacyBridgedEvidence(finding)).toBe(true);
  });

  it("returns true when legacyUnlocated is true", () => {
    const finding: LensFinding = {
      ...baseFindingFields,
      evidence: [validEvidenceItem],
      legacyUnlocated: true,
    };
    expect(isLegacyBridgedEvidence(finding)).toBe(true);
  });

  it("returns true when both markers are true", () => {
    const finding: LensFinding = {
      ...baseFindingFields,
      evidence: [validEvidenceItem],
      legacySynthesizedEvidence: true,
      legacyUnlocated: true,
    };
    expect(isLegacyBridgedEvidence(finding)).toBe(true);
  });

  it("returns false when markers are explicitly false", () => {
    const finding = {
      ...baseFindingFields,
      evidence: [validEvidenceItem],
      legacySynthesizedEvidence: false,
      legacyUnlocated: false,
    } as LensFinding;
    expect(isLegacyBridgedEvidence(finding)).toBe(false);
  });
});

describe("CDX-R1-03 file preprocess coercion", () => {
  it("coerces file: '' to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      file: "",
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.file).toBeNull();
    }
  });

  it("coerces file: '   ' (whitespace) to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      file: "   ",
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.file).toBeNull();
    }
  });

  it("coerces file: '\\t\\n' (mixed whitespace) to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      file: "\t\n",
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.file).toBeNull();
    }
  });

  it("preserves a concrete non-empty file string", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      file: "src/api/users.ts",
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.file).toBe("src/api/users.ts");
    }
  });

  it("accepts an explicit null file", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      file: null,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.file).toBeNull();
    }
  });
});

describe("CDX-R1-04 line preprocess coercion", () => {
  it("coerces line: NaN to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      line: NaN,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBeNull();
    }
  });

  it("coerces line: Infinity to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      line: Infinity,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBeNull();
    }
  });

  it("coerces line: -Infinity to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      line: -Infinity,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBeNull();
    }
  });

  it("coerces line: 1.5 (non-integer) to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      line: 1.5,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBeNull();
    }
  });

  it("coerces line: 0 to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      line: 0,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBeNull();
    }
  });

  it("coerces line: -1 to null", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      line: -1,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBeNull();
    }
  });

  it("preserves a concrete positive integer line", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      line: 42,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBe(42);
    }
  });

  it("accepts an explicit null line", () => {
    const parsed = lensFindingSchema.safeParse({
      ...baseFindingFields,
      line: null,
      evidence: [validEvidenceItem],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBeNull();
    }
  });
});

describe("barrel exports (CDX-6)", () => {
  it("exports LEGACY_NO_CODE_PLACEHOLDER sentinel", () => {
    expect(typeof LEGACY_NO_CODE_PLACEHOLDER).toBe("string");
    expect(LEGACY_NO_CODE_PLACEHOLDER.length).toBeGreaterThan(0);
  });

  it("exports LEGACY_UNLOCATED_FILE sentinel", () => {
    expect(typeof LEGACY_UNLOCATED_FILE).toBe("string");
    expect(LEGACY_UNLOCATED_FILE.length).toBeGreaterThan(0);
  });
});
