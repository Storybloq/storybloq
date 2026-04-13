import { describe, it, expect, beforeEach } from "vitest";
import {
  validateFindings,
  validateCachedFindings,
  restoreSourceMarkers,
  getRestorationSkipCounts,
  resetRestorationSkipCounts,
} from "../../../src/autonomous/review-lenses/schema-validator.js";
import {
  LEGACY_NO_CODE_PLACEHOLDER,
  LEGACY_UNLOCATED_FILE,
} from "../../../src/autonomous/review-lenses/finding-schema.js";
import type {
  LensFinding,
  EvidenceItem,
  MergeEntry,
} from "../../../src/autonomous/review-lenses/types.js";

// Legacy-shape raw input: mirrors what lens agents historically emit. It is
// the input to `validateFindings` (raw path). The bridge converts the
// `evidence: string` into an `EvidenceItem[]` before the row reaches the
// caller.
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

function makeEvidenceItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    file: "src/api.ts",
    startLine: 42,
    endLine: 42,
    code: "query = `SELECT * FROM users WHERE id = ${id}`",
    ...overrides,
  };
}

// Producer-array shape: a finding already in the new T-253 format.
function makeProducerArrayFinding(
  overrides: Partial<LensFinding> = {},
): LensFinding {
  return {
    lens: "security",
    lensVersion: "security-v1",
    severity: "critical",
    recommendedImpact: "blocker",
    category: "injection",
    description: "SQL injection found",
    file: "src/api.ts",
    line: 42,
    evidence: [makeEvidenceItem()],
    suggestedFix: "Use parameterized query",
    confidence: 0.95,
    assumptions: null,
    requiresMoreContext: false,
    ...overrides,
  };
}

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
    expect(result.invalid[0].reason).toContain("lens");
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

// ── T-253 bridge tests (legacy evidence → EvidenceItem[]) ─────────
//
// The bridge runs after normalizeFields and before the location invariant.
// It is the only place within the validator where markers can be set. Every
// legal legacy shape that passed the old validator must produce a valid
// EvidenceItem[] of length ≥ 1.

describe("bridgeLegacyEvidence (CDX-1 + CDX-7 + CDX-9)", () => {
  it("row 1: producer-array evidence passes through unchanged, markers absent", () => {
    const result = validateFindings([makeProducerArrayFinding()], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(Array.isArray(f.evidence)).toBe(true);
    expect(f.evidence).toHaveLength(1);
    expect(f.legacySynthesizedEvidence).toBeFalsy();
    expect(f.legacyUnlocated).toBeFalsy();
  });

  it("row 2: string evidence + concrete file + concrete line → single item, no markers", () => {
    const result = validateFindings([validFinding], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence).toHaveLength(1);
    expect(f.evidence[0].file).toBe("src/api.ts");
    expect(f.evidence[0].startLine).toBe(42);
    expect(f.evidence[0].endLine).toBe(42);
    expect(f.evidence[0].code).toBe(
      "query = `SELECT * FROM users WHERE id = ${id}`",
    );
    expect(f.legacySynthesizedEvidence).toBeFalsy();
    expect(f.legacyUnlocated).toBeFalsy();
  });

  it("row 3: string evidence + concrete file + null line → legacyUnlocated marker", () => {
    const raw = { ...validFinding, line: null };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence).toHaveLength(1);
    expect(f.evidence[0].file).toBe("src/api.ts");
    expect(f.evidence[0].startLine).toBe(1);
    expect(f.evidence[0].endLine).toBe(1);
    expect(f.legacySynthesizedEvidence).toBeFalsy();
    expect(f.legacyUnlocated).toBe(true);
  });

  it("row 4: string evidence + null file + concrete line → legacyUnlocated marker, sentinel file", () => {
    const raw = { ...validFinding, file: null };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence[0].file).toBe(LEGACY_UNLOCATED_FILE);
    expect(f.evidence[0].startLine).toBe(42);
    expect(f.evidence[0].endLine).toBe(42);
    expect(f.legacySynthesizedEvidence).toBeFalsy();
    expect(f.legacyUnlocated).toBe(true);
  });

  it("row 5: string evidence + both null → sentinel file, defaulted line, legacyUnlocated", () => {
    const raw = { ...validFinding, file: null, line: null };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence[0].file).toBe(LEGACY_UNLOCATED_FILE);
    expect(f.evidence[0].startLine).toBe(1);
    expect(f.evidence[0].endLine).toBe(1);
    expect(f.legacySynthesizedEvidence).toBeFalsy();
    expect(f.legacyUnlocated).toBe(true);
  });

  it("row 6: null evidence + concrete file + concrete line → legacySynthesizedEvidence marker", () => {
    const raw = { ...validFinding, evidence: null };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence[0].file).toBe("src/api.ts");
    expect(f.evidence[0].startLine).toBe(42);
    expect(f.evidence[0].code).toBe(LEGACY_NO_CODE_PLACEHOLDER);
    expect(f.legacySynthesizedEvidence).toBe(true);
    expect(f.legacyUnlocated).toBeFalsy();
  });

  it("row 7: null evidence + concrete file + null line → both markers", () => {
    const raw = { ...validFinding, evidence: null, line: null };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence[0].file).toBe("src/api.ts");
    expect(f.evidence[0].startLine).toBe(1);
    expect(f.evidence[0].code).toBe(LEGACY_NO_CODE_PLACEHOLDER);
    expect(f.legacySynthesizedEvidence).toBe(true);
    expect(f.legacyUnlocated).toBe(true);
  });

  it("row 8: null evidence + null file + concrete line → both markers", () => {
    const raw = { ...validFinding, evidence: null, file: null };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence[0].file).toBe(LEGACY_UNLOCATED_FILE);
    expect(f.evidence[0].startLine).toBe(42);
    expect(f.evidence[0].code).toBe(LEGACY_NO_CODE_PLACEHOLDER);
    expect(f.legacySynthesizedEvidence).toBe(true);
    expect(f.legacyUnlocated).toBe(true);
  });

  it("row 9: null evidence + both null → sentinel file, sentinel code, both markers", () => {
    const raw = { ...validFinding, evidence: null, file: null, line: null };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence[0].file).toBe(LEGACY_UNLOCATED_FILE);
    expect(f.evidence[0].startLine).toBe(1);
    expect(f.evidence[0].code).toBe(LEGACY_NO_CODE_PLACEHOLDER);
    expect(f.legacySynthesizedEvidence).toBe(true);
    expect(f.legacyUnlocated).toBe(true);
  });

  it("row 10: empty array evidence routes through the null-evidence path", () => {
    const raw = { ...validFinding, evidence: [] };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    const f = result.valid[0];
    expect(f.evidence).toHaveLength(1);
    expect(f.evidence[0].code).toBe(LEGACY_NO_CODE_PLACEHOLDER);
    expect(f.legacySynthesizedEvidence).toBe(true);
  });
});

// ── CDX-11 marker-strip tests (raw-path) ──────────────────────────
//
// Markers are validator-owned for raw input. Any producer-supplied marker is
// silently dropped before the bridge runs. These tests pin the "gate-bypass
// impossible through lens output" invariant.

describe("validateFindings marker strip (CDX-11 raw-path)", () => {
  it("drops producer-supplied legacySynthesizedEvidence on producer-array input", () => {
    const raw = makeProducerArrayFinding({
      legacySynthesizedEvidence: true,
    } as LensFinding);
    const result = validateFindings([raw as unknown], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].legacySynthesizedEvidence).toBeFalsy();
  });

  it("drops producer-supplied legacyUnlocated on producer-array input", () => {
    const raw = makeProducerArrayFinding({
      legacyUnlocated: true,
    } as LensFinding);
    const result = validateFindings([raw as unknown], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].legacyUnlocated).toBeFalsy();
  });

  it("drops both producer-supplied markers on producer-array input", () => {
    const raw = makeProducerArrayFinding({
      legacySynthesizedEvidence: true,
      legacyUnlocated: true,
    } as LensFinding);
    const result = validateFindings([raw as unknown], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].legacySynthesizedEvidence).toBeFalsy();
    expect(result.valid[0].legacyUnlocated).toBeFalsy();
  });

  it("producer sends legacySynthesizedEvidence:false on a null-evidence row → bridge still sets true", () => {
    const raw = {
      ...validFinding,
      evidence: null,
      legacySynthesizedEvidence: false,
    };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].legacySynthesizedEvidence).toBe(true);
  });

  it("producer sends legacyUnlocated:false + both-null location → bridge still sets true", () => {
    const raw = {
      ...validFinding,
      file: null,
      line: null,
      legacyUnlocated: false,
    };
    const result = validateFindings([raw], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].legacyUnlocated).toBe(true);
  });
});

// ── CDX-2 + CDX-8 + CDX-10 location invariant tests ─────────────────

describe("enforceLocationInvariant (CDX-2 + CDX-10)", () => {
  it("accepts a producer-array finding with matching file/line", () => {
    const result = validateFindings([makeProducerArrayFinding()], "security");
    expect(result.valid).toHaveLength(1);
  });

  it("rejects a producer-array finding where file mismatches evidence[0].file", () => {
    const f = makeProducerArrayFinding({
      file: "wrong.ts",
      evidence: [makeEvidenceItem({ file: "src/api.ts" })],
    });
    const result = validateFindings([f], "security");
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].reason).toBe("file_line_evidence_mismatch");
  });

  it("rejects a producer-array finding where line mismatches evidence[0].startLine", () => {
    const f = makeProducerArrayFinding({
      line: 10,
      evidence: [makeEvidenceItem({ file: "src/api.ts", startLine: 42 })],
    });
    const result = validateFindings([f], "security");
    expect(result.valid).toHaveLength(0);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].reason).toBe("file_line_evidence_mismatch");
  });

  it("rejects producer-array when file matches but line is concretely wrong (CDX-10 component-wise)", () => {
    const f = makeProducerArrayFinding({
      file: "src/api.ts",
      line: 99,
      evidence: [makeEvidenceItem({ file: "src/api.ts", startLine: 42 })],
    });
    const result = validateFindings([f], "security");
    expect(result.invalid).toHaveLength(1);
  });

  it("rejects producer-array when line matches but file is concretely wrong (CDX-10 component-wise)", () => {
    const f = makeProducerArrayFinding({
      file: "wrong.ts",
      line: 42,
      evidence: [makeEvidenceItem({ file: "src/api.ts", startLine: 42 })],
    });
    const result = validateFindings([f], "security");
    expect(result.invalid).toHaveLength(1);
  });

  it("passes producer-array with null legacy file and concrete line (component-wise null skips check)", () => {
    const f = makeProducerArrayFinding({
      file: null,
      line: 42,
      evidence: [makeEvidenceItem({ file: "src/api.ts", startLine: 42 })],
    });
    const result = validateFindings([f], "security");
    expect(result.valid).toHaveLength(1);
  });

  it("passes producer-array with concrete file and null legacy line", () => {
    const f = makeProducerArrayFinding({
      file: "src/api.ts",
      line: null,
      evidence: [makeEvidenceItem({ file: "src/api.ts", startLine: 42 })],
    });
    const result = validateFindings([f], "security");
    expect(result.valid).toHaveLength(1);
  });

  it("legacy-path finding with mismatched shape still passes (bridge derives evidence)", () => {
    // Legacy-string path: bridge builds evidence from file/line, so no mismatch possible.
    const result = validateFindings([validFinding], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].file).toBe("src/api.ts");
    expect(result.valid[0].line).toBe(42);
  });

  it("CDX-8: validator never mutates file/line (filing path preserved)", () => {
    const f = makeProducerArrayFinding({
      file: "src/api.ts",
      line: 42,
      evidence: [makeEvidenceItem({ file: "src/api.ts", startLine: 42 })],
    });
    const result = validateFindings([f], "security");
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].file).toBe("src/api.ts");
    expect(result.valid[0].line).toBe(42);
  });
});

// ── CDX-11 + CDX-19 cache-path tests (validateCachedFindings) ──────

describe("validateCachedFindings (CDX-11 cached-path)", () => {
  it("preserves legacySynthesizedEvidence marker on cache round-trip", () => {
    // Simulate a finding that was previously bridged and cached.
    const cached: LensFinding = makeProducerArrayFinding({
      evidence: [
        makeEvidenceItem({ code: LEGACY_NO_CODE_PLACEHOLDER }),
      ],
      legacySynthesizedEvidence: true,
    } as LensFinding);
    const result = validateCachedFindings([cached]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].legacySynthesizedEvidence).toBe(true);
  });

  it("preserves legacyUnlocated marker on cache round-trip", () => {
    const cached: LensFinding = makeProducerArrayFinding({
      file: null,
      line: null,
      evidence: [
        makeEvidenceItem({ file: LEGACY_UNLOCATED_FILE, startLine: 1, endLine: 1 }),
      ],
      legacyUnlocated: true,
    } as LensFinding);
    const result = validateCachedFindings([cached]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].legacyUnlocated).toBe(true);
  });

  it("preserves absent markers on cache round-trip (no-bridge drift)", () => {
    const cached = makeProducerArrayFinding();
    const result = validateCachedFindings([cached]);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0].legacySynthesizedEvidence).toBeFalsy();
    expect(result.valid[0].legacyUnlocated).toBeFalsy();
  });

  it("partitions Zod-invalid cached entries into invalid[] (CDX-19 contract)", () => {
    const bad = { ...makeProducerArrayFinding(), evidence: [] };
    const good = makeProducerArrayFinding();
    const result = validateCachedFindings([bad as unknown as LensFinding, good]);
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(1);
  });
});

// ── CDX-19 flattenZodError output format ──────────────────────────

describe("flattenZodError rule (CDX-19)", () => {
  it("reports invalid evidence item shape as a Zod error with semicolon-separated path: message", () => {
    // Non-empty producer-array with a malformed element — bridge forwards it
    // as producer-array, Zod rejects on evidence[0] fields.
    const raw = {
      ...validFinding,
      file: null,
      line: null,
      evidence: [{ file: "", startLine: 0, endLine: 0, code: "" }],
    } as unknown;
    const result = validateFindings([raw], "security");
    expect(result.invalid).toHaveLength(1);
    const reason = result.invalid[0].reason;
    expect(typeof reason).toBe("string");
    expect(reason).toContain("evidence");
  });

  it("flattens multiple Zod issues joined by '; '", () => {
    // file/line set to null so the location invariant passes and Zod runs
    // on the evidence[0] shape, producing multiple validation errors that
    // the flattener joins with "; ".
    const raw = {
      ...validFinding,
      file: null,
      line: null,
      evidence: [
        { file: "", startLine: 0, endLine: 0, code: "" },
      ],
    } as unknown;
    const result = validateFindings([raw], "security");
    expect(result.invalid).toHaveLength(1);
    const reason = result.invalid[0].reason;
    expect(reason).toContain("; ");
  });
});

// ── CDX-13 + CDX-14 + CDX-15 + CDX-16 + CDX-17 + CDX-18 + CDX-19
//    restoreSourceMarkers strip-and-restore suite ─────────────────

describe("restoreSourceMarkers (CDX-13..CDX-19)", () => {
  beforeEach(() => {
    resetRestorationSkipCounts();
  });

  function mkSource(overrides: Partial<LensFinding>): LensFinding {
    return {
      ...makeProducerArrayFinding(),
      ...overrides,
    } as LensFinding;
  }

  function mkMergerFinding(overrides: Partial<LensFinding>): LensFinding {
    return {
      ...makeProducerArrayFinding(),
      ...overrides,
    } as LensFinding;
  }

  // Test 1 — baseline: legacy-bridged source echoed verbatim → markers restored
  it("1. baseline legacy-bridged source echoed verbatim → markers restored", () => {
    const source = mkSource({
      issueKey: "k-A",
      file: "a.ts",
      line: 10,
      category: "sql",
      evidence: [
        {
          file: "a.ts",
          startLine: 1,
          endLine: 1,
          code: LEGACY_NO_CODE_PLACEHOLDER,
        },
      ],
      legacySynthesizedEvidence: true,
    } as LensFinding);
    const mergerOut = mkMergerFinding({
      issueKey: "k-A",
      file: "a.ts",
      line: 10,
      category: "sql",
      evidence: source.evidence,
    } as LensFinding);
    const result = restoreSourceMarkers([mergerOut], [source], []);
    expect(result).toHaveLength(1);
    expect(result[0].legacySynthesizedEvidence).toBe(true);
  });

  // Test 2 — CRITICAL CDX-11 via merger
  it("2. merger-invented legacySynthesizedEvidence on concrete source → absent", () => {
    const source = mkSource({
      issueKey: "k-B",
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "real" })],
    } as LensFinding);
    // Simulate the validator already stripped producer-supplied markers.
    const validated = mkMergerFinding({
      issueKey: "k-B",
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "real" })],
    } as LensFinding);
    const result = restoreSourceMarkers([validated], [source], []);
    expect(result[0].legacySynthesizedEvidence).toBeFalsy();
  });

  // Test 3 — CDX-11 symmetric
  it("3. merger-invented legacyUnlocated on concrete source → absent", () => {
    const source = mkSource({
      issueKey: "k-C",
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "real" })],
    } as LensFinding);
    const validated = mkMergerFinding({
      issueKey: "k-C",
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "real" })],
    } as LensFinding);
    const result = restoreSourceMarkers([validated], [source], []);
    expect(result[0].legacyUnlocated).toBeFalsy();
  });

  // Test 5 — novel issueKey
  it("5. novel issueKey → no restoration", () => {
    const source = mkSource({
      issueKey: "k-src",
      file: "a.ts",
      line: 10,
      legacySynthesizedEvidence: true,
      evidence: [makeEvidenceItem({ code: LEGACY_NO_CODE_PLACEHOLDER })],
    } as LensFinding);
    const merged = mkMergerFinding({
      issueKey: "k-novel",
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "real" })],
    } as LensFinding);
    const result = restoreSourceMarkers([merged], [source], []);
    expect(result[0].legacySynthesizedEvidence).toBeFalsy();
  });

  // Test 6 — dropped issueKey
  it("6. dropped issueKey on merger output → no restoration", () => {
    const source = mkSource({
      issueKey: "k-D",
      file: "a.ts",
      line: 10,
      legacyUnlocated: true,
      evidence: [
        makeEvidenceItem({ file: LEGACY_UNLOCATED_FILE, startLine: 1, endLine: 1, code: "x" }),
      ],
    } as LensFinding);
    const merged = mkMergerFinding({
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "real" })],
    } as LensFinding);
    delete (merged as Partial<LensFinding>).issueKey;
    const result = restoreSourceMarkers([merged], [source], []);
    expect(result[0].legacyUnlocated).toBeFalsy();
  });

  // Test 7 — CDX-14 downgrade attack
  it("7. merger emits evidence: null on source-verifiable finding → source evidence restored, markers absent", () => {
    const realCode = "db.query('real SQL')";
    const source = mkSource({
      issueKey: "k-G",
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: realCode })],
    } as LensFinding);
    // What the raw-path validator would produce for merger {evidence: null}:
    const bridged = mkMergerFinding({
      issueKey: "k-G",
      file: "a.ts",
      line: 10,
      evidence: [
        makeEvidenceItem({
          file: "a.ts",
          startLine: 10,
          endLine: 10,
          code: LEGACY_NO_CODE_PLACEHOLDER,
        }),
      ],
      legacySynthesizedEvidence: true,
    } as LensFinding);
    const result = restoreSourceMarkers([bridged], [source], []);
    expect(result[0].evidence).toHaveLength(1);
    expect(result[0].evidence[0].code).toBe(realCode);
    expect(result[0].legacySynthesizedEvidence).toBeFalsy();
  });

  // Test 11 — CDX-12 baseline: legacy-string source marker restored
  it("11. CDX-12 baseline: bridged-string source marker restored", () => {
    const source = mkSource({
      issueKey: "k-E",
      file: null,
      line: 10,
      evidence: [
        makeEvidenceItem({
          file: LEGACY_UNLOCATED_FILE,
          startLine: 10,
          endLine: 10,
          code: "real SQL",
        }),
      ],
      legacyUnlocated: true,
    } as LensFinding);
    const validated = mkMergerFinding({
      issueKey: "k-E",
      file: null,
      line: 10,
      evidence: source.evidence,
    } as LensFinding);
    const result = restoreSourceMarkers([validated], [source], []);
    expect(result[0].legacyUnlocated).toBe(true);
  });

  // Test 12 — CDX-15 file-spoof
  it("12. merger copies issueKey onto different file → no restoration (CDX-15)", () => {
    const source = mkSource({
      issueKey: "k-F",
      file: "a.ts",
      line: 10,
      legacyUnlocated: true,
      evidence: [
        makeEvidenceItem({ file: LEGACY_UNLOCATED_FILE, startLine: 10, code: "real" }),
      ],
    } as LensFinding);
    const spoof = mkMergerFinding({
      issueKey: "k-F",
      file: "unrelated.ts",
      line: 10,
      evidence: [
        makeEvidenceItem({
          file: "unrelated.ts",
          startLine: 10,
          endLine: 10,
          code: "something",
        }),
      ],
    } as LensFinding);
    const result = restoreSourceMarkers([spoof], [source], []);
    expect(result[0].legacyUnlocated).toBeFalsy();
    expect(getRestorationSkipCounts().site_mismatch).toBeGreaterThanOrEqual(1);
  });

  // Test 13 — CDX-15 line-spoof
  it("13. merger copies issueKey onto different line → no restoration (CDX-15)", () => {
    const source = mkSource({
      issueKey: "k-line",
      file: "a.ts",
      line: 10,
      legacyUnlocated: true,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "x" })],
    } as LensFinding);
    const spoof = mkMergerFinding({
      issueKey: "k-line",
      file: "a.ts",
      line: 42,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 42, code: "y" })],
    } as LensFinding);
    const result = restoreSourceMarkers([spoof], [source], []);
    expect(result[0].legacyUnlocated).toBeFalsy();
  });

  // Test 14 — CDX-16 cross-category
  it("14. cross-category normalization same site → restoration applies", () => {
    const source = mkSource({
      issueKey: "k-Y",
      file: "a.ts",
      line: 10,
      category: "sql",
      legacyUnlocated: true,
      evidence: [
        makeEvidenceItem({
          file: LEGACY_UNLOCATED_FILE,
          startLine: 10,
          endLine: 10,
          code: "SELECT",
        }),
      ],
    } as LensFinding);
    const merged = mkMergerFinding({
      issueKey: "k-Y",
      file: "a.ts",
      line: 10,
      category: "sql-injection",
      evidence: source.evidence,
    } as LensFinding);
    const result = restoreSourceMarkers([merged], [source], []);
    expect(result[0].legacyUnlocated).toBe(true);
    expect(result[0].category).toBe("sql-injection");
  });

  // Test 15 — CDX-16 cross-lens
  it("15. cross-lens pass-through same site → restoration applies, merger's lens kept", () => {
    const source = mkSource({
      issueKey: "k-Z",
      lens: "error-handling",
      file: "a.ts",
      line: 10,
      category: "missing-validation",
      legacyUnlocated: true,
      evidence: [
        makeEvidenceItem({
          file: LEGACY_UNLOCATED_FILE,
          startLine: 10,
          endLine: 10,
          code: "x",
        }),
      ],
    } as LensFinding);
    const merged = mkMergerFinding({
      issueKey: "k-Z",
      lens: "security",
      file: "a.ts",
      line: 10,
      category: "missing-validation",
      evidence: source.evidence,
    } as LensFinding);
    const result = restoreSourceMarkers([merged], [source], []);
    expect(result[0].legacyUnlocated).toBe(true);
    expect(result[0].lens).toBe("security");
  });

  // Test 16 — CDX-18 unordered multiset agreement
  it("16. unordered multi-source evidence multiset → restoration applies", () => {
    const evA1 = makeEvidenceItem({ file: "a.ts", startLine: 10, endLine: 10, code: "SELECT" });
    const evA2 = makeEvidenceItem({ file: "a.ts", startLine: 12, endLine: 12, code: "WHERE id=?" });
    const sourceP = mkSource({
      issueKey: "k-P",
      lens: "security",
      file: "a.ts",
      line: 10,
      category: "sql",
      evidence: [evA1, evA2],
    } as LensFinding);
    const sourceQ = mkSource({
      issueKey: "k-Q",
      lens: "error-handling",
      file: "a.ts",
      line: 10,
      category: "missing-input-validation",
      evidence: [evA2, evA1],
    } as LensFinding);
    const merged = mkMergerFinding({
      issueKey: "k-merged",
      lens: "security",
      file: "a.ts",
      line: 10,
      category: "sql",
      evidence: [evA1, evA2],
    } as LensFinding);
    const mergeLog: MergeEntry[] = [
      {
        mergedFindings: ["k-P", "k-Q"],
        resultKey: "k-merged",
        reason: "same SQL injection site",
      },
    ];
    const result = restoreSourceMarkers([merged], [sourceP, sourceQ], mergeLog);
    expect(result[0].evidence).toHaveLength(2);
    expect(result[0].legacySynthesizedEvidence).toBeFalsy();
  });

  // Test 17 — overlapping-window rejection
  it("17. overlapping-but-unequal evidence windows → no restoration", () => {
    const sourceA = mkSource({
      issueKey: "k-A",
      file: "a.ts",
      line: 10,
      evidence: [
        makeEvidenceItem({ file: "a.ts", startLine: 10, endLine: 10, code: "SELECT" }),
      ],
    } as LensFinding);
    const sourceB = mkSource({
      issueKey: "k-B",
      file: "a.ts",
      line: 10,
      evidence: [
        makeEvidenceItem({
          file: "a.ts",
          startLine: 8,
          endLine: 12,
          code: "function wrap() { SELECT }",
        }),
      ],
    } as LensFinding);
    const merged = mkMergerFinding({
      issueKey: "k-merged",
      file: "a.ts",
      line: 10,
      evidence: sourceA.evidence,
    } as LensFinding);
    const mergeLog: MergeEntry[] = [
      { mergedFindings: ["k-A", "k-B"], resultKey: "k-merged", reason: "overlap" },
    ];
    const result = restoreSourceMarkers([merged], [sourceA, sourceB], mergeLog);
    expect(
      getRestorationSkipCounts().multi_source_disagreement,
    ).toBeGreaterThanOrEqual(1);
    // Result echoes whatever was passed in unchanged
    expect(result[0].issueKey).toBe("k-merged");
  });

  // Test 18 — CRITICAL CDX-17 laundering blocked
  it("18. same-site topically-distinct disagreement → no restoration, laundering blocked", () => {
    const kSql = mkSource({
      issueKey: "k-sql",
      lens: "security",
      file: "a.ts",
      line: 10,
      category: "sql-injection",
      description: "Query built by string concatenation",
      evidence: [
        makeEvidenceItem({
          file: "a.ts",
          startLine: 10,
          endLine: 10,
          code: "db.query('SELECT *' + req.params.id)",
        }),
      ],
    } as LensFinding);
    const kAuth = mkSource({
      issueKey: "k-auth",
      lens: "security",
      file: "a.ts",
      line: 10,
      category: "auth-bypass",
      description: "Missing auth check",
      legacyUnlocated: true,
      evidence: [
        makeEvidenceItem({
          file: LEGACY_UNLOCATED_FILE,
          startLine: 10,
          endLine: 10,
          code: LEGACY_NO_CODE_PLACEHOLDER,
        }),
      ],
    } as LensFinding);
    const merged = mkMergerFinding({
      issueKey: "k-merged-bad",
      lens: "security",
      file: "a.ts",
      line: 10,
      category: "auth-bypass",
      description: "Missing auth check",
      evidence: [
        makeEvidenceItem({
          file: "a.ts",
          startLine: 10,
          endLine: 10,
          code: LEGACY_NO_CODE_PLACEHOLDER,
        }),
      ],
      legacySynthesizedEvidence: true,
    } as LensFinding);
    const mergeLog: MergeEntry[] = [
      {
        mergedFindings: ["k-sql", "k-auth"],
        resultKey: "k-merged-bad",
        reason: "spurious",
      },
    ];
    const result = restoreSourceMarkers([merged], [kSql, kAuth], mergeLog);
    // CDX-R2-02 strict invariant: on non-overlay return (multi-source
    // disagreement here), any markers present on the merged finding are
    // stripped by stripMarkers. Markers may only flow via source overlay.
    expect(result[0].legacySynthesizedEvidence).toBeUndefined();
    expect(result[0].legacyUnlocated).toBeUndefined();
    // Evidence is NOT overlaid on non-overlay returns; merged's evidence is
    // preserved (the strip helper only touches markers).
    expect(result[0].evidence[0].code).toBe(LEGACY_NO_CODE_PLACEHOLDER);
  });

  // Test 21 — issueKey missing short-circuit
  it("21. merger finding without issueKey stays unchanged", () => {
    const source = mkSource({
      issueKey: "k-S",
      file: "a.ts",
      line: 10,
      legacyUnlocated: true,
      evidence: [
        makeEvidenceItem({ file: LEGACY_UNLOCATED_FILE, startLine: 10, code: "x" }),
      ],
    } as LensFinding);
    const merged = mkMergerFinding({
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "real" })],
    } as LensFinding);
    delete (merged as Partial<LensFinding>).issueKey;
    const result = restoreSourceMarkers([merged], [source], []);
    expect(result[0].legacyUnlocated).toBeFalsy();
  });

  // Test 23 — empty source set
  it("23. empty sourceFindings → no restoration runs", () => {
    const merged = mkMergerFinding({
      issueKey: "k-X",
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "x" })],
    } as LensFinding);
    const result = restoreSourceMarkers([merged], [], []);
    expect(result).toHaveLength(1);
  });

  // Test 25 — CDX-19 CRITICAL null-site vacuous-pass regression
  it("25. null-site vacuous pass blocked → no restoration, site_unlocated counter increments", () => {
    const source = mkSource({
      issueKey: "k-null",
      lens: "orchestrator",
      file: null,
      line: null,
      category: "hardcoded-secrets",
      evidence: [
        makeEvidenceItem({
          file: "src/config.ts",
          startLine: 1,
          endLine: 1,
          code: "[REDACTED — potential secret]",
        }),
      ],
      legacyUnlocated: true,
    } as LensFinding);
    const merged = mkMergerFinding({
      issueKey: "k-null",
      lens: "security",
      file: null,
      line: null,
      category: "hardcoded-secrets",
      evidence: [
        makeEvidenceItem({
          file: "src/config.ts",
          startLine: 1,
          endLine: 1,
          code: LEGACY_NO_CODE_PLACEHOLDER,
        }),
      ],
      legacySynthesizedEvidence: true,
    } as LensFinding);
    const result = restoreSourceMarkers([merged], [source], []);
    // CDX-R2-02 strict invariant: vacuous-pass guard causes no_contributing_sources
    // return, which strips ALL markers from the merged finding. Any marker the
    // merger directly set is removed; markers may only flow via overlay.
    expect(result[0].legacyUnlocated).toBeUndefined();
    expect(result[0].legacySynthesizedEvidence).toBeUndefined();
    expect(getRestorationSkipCounts().site_unlocated).toBe(1);
  });

  // Test 26 — CDX-19 no_issue_key observability
  it("26. no_issue_key observability branch logs once", () => {
    const source = mkSource({
      issueKey: "k-Q",
      file: "a.ts",
      line: 10,
      legacyUnlocated: true,
      evidence: [
        makeEvidenceItem({ file: LEGACY_UNLOCATED_FILE, startLine: 10, code: "x" }),
      ],
    } as LensFinding);
    const merged = mkMergerFinding({
      file: "a.ts",
      line: 10,
      evidence: [makeEvidenceItem({ file: "a.ts", startLine: 10, code: "real" })],
    } as LensFinding);
    delete (merged as Partial<LensFinding>).issueKey;
    restoreSourceMarkers([merged], [source], []);
    expect(getRestorationSkipCounts().no_issue_key).toBe(1);
  });

  // Test 27 — CDX-19 multi_source_disagreement observability
  it("27. multi_source_disagreement branch logs once on disagreement", () => {
    const kSql = mkSource({
      issueKey: "k-sql2",
      file: "a.ts",
      line: 10,
      evidence: [
        makeEvidenceItem({ file: "a.ts", startLine: 10, code: "SELECT" }),
      ],
    } as LensFinding);
    const kAuth = mkSource({
      issueKey: "k-auth2",
      file: "a.ts",
      line: 10,
      evidence: [
        makeEvidenceItem({ file: "a.ts", startLine: 10, code: "INSERT" }),
      ],
    } as LensFinding);
    const merged = mkMergerFinding({
      issueKey: "k-M",
      file: "a.ts",
      line: 10,
      evidence: [
        makeEvidenceItem({ file: "a.ts", startLine: 10, code: "SELECT" }),
      ],
    } as LensFinding);
    const mergeLog: MergeEntry[] = [
      {
        mergedFindings: ["k-sql2", "k-auth2"],
        resultKey: "k-M",
        reason: "spurious",
      },
    ];
    restoreSourceMarkers([merged], [kSql, kAuth], mergeLog);
    expect(getRestorationSkipCounts().multi_source_disagreement).toBe(1);
  });

  // Test 34 — flattenZodError exact-format pin (approximated by structural expectations)
  it("34. flattenZodError format: path-joined: message; semicolon-space separator", () => {
    const raw = {
      ...validFinding,
      file: null,
      line: null,
      evidence: [
        { file: "", startLine: 0, endLine: -1, code: "" },
      ],
    } as unknown;
    const result = validateFindings([raw], "security");
    expect(result.invalid).toHaveLength(1);
    const reason = result.invalid[0].reason;
    // The reason must include either a top-level "evidence" path segment or a
    // nested "evidence.0.*" path segment — both shapes are valid dot-joined
    // Zod paths produced by the helper.
    expect(/evidence(\.|\b)/.test(reason)).toBe(true);
  });
});

