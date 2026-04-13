import { describe, it, expect, beforeEach } from "vitest";
import { parseMergerResult } from "../../../src/autonomous/review-lenses/merger.js";
import { parseJudgeResult } from "../../../src/autonomous/review-lenses/judge.js";
import { resetRestorationSkipCounts, getRestorationSkipCounts } from "../../../src/autonomous/review-lenses/schema-validator.js";
import type { LensFinding } from "../../../src/autonomous/review-lenses/types.js";

function makeRawFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lens: "security",
    lensVersion: "security-v1",
    severity: "critical",
    recommendedImpact: "blocker",
    category: "injection",
    description: "SQL injection",
    file: "src/api/users.ts",
    line: 42,
    evidence: [
      {
        file: "src/api/users.ts",
        startLine: 42,
        endLine: 42,
        code: "db.query('SELECT *')",
      },
    ],
    suggestedFix: null,
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
    ...overrides,
  };
}

describe("parseMergerResult", () => {
  it("parses valid full output", () => {
    const raw = JSON.stringify({
      findings: [makeRawFinding()],
      tensions: [
        { lensA: "security", lensB: "performance", description: "conflict", tradeoff: "tradeoff", blocking: false, file: "src/api/users.ts", line: 42 },
      ],
      mergeLog: [{ mergedFindings: ["a", "b"], resultKey: "c", reason: "same issue" }],
    });
    const result = parseMergerResult(raw, []);
    expect(result).not.toBeNull();
    expect(result!.findings).toHaveLength(1);
    expect(result!.tensions).toHaveLength(1);
    expect(result!.mergeLog).toHaveLength(1);
  });

  it("returns null on invalid JSON", () => {
    expect(parseMergerResult("not json", [])).toBeNull();
    expect(parseMergerResult("{truncated", [])).toBeNull();
  });

  it("returns null when findings is missing", () => {
    expect(parseMergerResult(JSON.stringify({ tensions: [] }), [])).toBeNull();
  });

  it("returns null when findings is not an array", () => {
    expect(parseMergerResult(JSON.stringify({ findings: "not array" }), [])).toBeNull();
    expect(parseMergerResult(JSON.stringify({ findings: {} }), [])).toBeNull();
  });

  it("defaults tensions and mergeLog to empty arrays", () => {
    const raw = JSON.stringify({ findings: [] });
    const result = parseMergerResult(raw, []);
    expect(result).not.toBeNull();
    expect(result!.tensions).toEqual([]);
    expect(result!.mergeLog).toEqual([]);
  });

  it("returns null on null input content", () => {
    expect(parseMergerResult(JSON.stringify(null), [])).toBeNull();
  });
});

// ── CDX-19 parseMergerResult error-boundary + size-cap tests ────────

describe("parseMergerResult CDX-19 error boundary", () => {
  beforeEach(() => {
    resetRestorationSkipCounts();
  });

  // Test 32 — JSON.parse SyntaxError increments parse_merger_exception
  it("32. JSON.parse SyntaxError → null + parse_merger_exception counter increments", () => {
    const result = parseMergerResult("{not valid json", []);
    expect(result).toBeNull();
    expect(
      getRestorationSkipCounts().parse_merger_exception,
    ).toBeGreaterThanOrEqual(1);
  });

  // Test 33 — exception inside defensive helpers bubbles to try/catch
  it("33. null/undefined inputs handled without throwing", () => {
    // Passing a structurally-weird but parseable JSON that trips internal paths
    // must return null rather than throw.
    const result = parseMergerResult(JSON.stringify({ findings: null }), []);
    expect(result).toBeNull();
  });

  // Test 28 — mergelog oversized array-cap breach
  it("28. oversized mergeLog drops entries beyond MERGELOG_MAX_ENTRIES", () => {
    const MAX = 256;
    const oversize = MAX + 3;
    const entries = Array.from({ length: oversize }, (_, i) => ({
      mergedFindings: ["k-src"],
      resultKey: `k-r${i}`,
      reason: "echo",
    }));
    const raw = JSON.stringify({
      findings: [makeRawFinding({ issueKey: "k-r0" })],
      mergeLog: entries,
    });
    const result = parseMergerResult(raw, []);
    expect(result).not.toBeNull();
    expect(result!.mergeLog.length).toBeLessThanOrEqual(MAX);
    // Single bounded log per oversize (not per-entry) to avoid adversarial
    // O(n) log emission that defeats the cap.
    expect(
      getRestorationSkipCounts().mergelog_oversized_entry,
    ).toBe(1);
  });
});

describe("parseMergerResult CDX-12..CDX-18 source marker restoration", () => {
  beforeEach(() => {
    resetRestorationSkipCounts();
  });

  // Realistic legacy-bridged source shape: file/line are null and evidence[0]
  // holds BOTH sentinels (file=LEGACY_UNLOCATED_FILE, code=LEGACY_NO_CODE_PLACEHOLDER).
  // CDX-R2-03 requires both sentinels for the enforceLocationInvariant legacy
  // exemption; this matches the shape bridgeLegacyEvidence produces on the
  // legacy-null path.
  function sourceWithMarker(): LensFinding {
    return {
      lens: "security",
      lensVersion: "security-v1",
      severity: "critical",
      recommendedImpact: "blocker",
      category: "sql",
      description: "SQL injection",
      file: null,
      line: null,
      evidence: [
        {
          file: "(unknown)",
          startLine: 1,
          endLine: 1,
          code: "[legacy finding: no code excerpt provided]",
        },
      ],
      suggestedFix: null,
      confidence: 0.9,
      assumptions: null,
      requiresMoreContext: false,
      issueKey: "k-SRC",
      legacySynthesizedEvidence: true,
      legacyUnlocated: true,
    };
  }

  it("null-site legacy echo: vacuous-pass blocks marker restoration", () => {
    // A legacy-bridged source with null file/line cannot have its markers
    // restored across parseMergerResult because the CDX-19 vacuous-pass guard
    // fires (no concrete site to verify) and the CDX-R2-02 stripMarkers helper
    // then removes any markers from the result. The issueKey alone is not
    // sufficient identity when both sides lack location.
    const source = sourceWithMarker();
    const raw = JSON.stringify({
      findings: [
        makeRawFinding({
          category: "sql",
          description: "SQL injection",
          file: null,
          line: null,
          evidence: source.evidence,
          issueKey: "k-SRC",
        }),
      ],
    });
    const result = parseMergerResult(raw, [source]);
    expect(result).not.toBeNull();
    expect(result!.findings[0].legacyUnlocated).toBeFalsy();
    expect(result!.findings[0].legacySynthesizedEvidence).toBeFalsy();
  });

  it("blocks CDX-11 bypass: merger-invented marker on concrete source", () => {
    // Concrete source: no legacy markers, site is real.
    const source: LensFinding = {
      lens: "security",
      lensVersion: "security-v1",
      severity: "critical",
      recommendedImpact: "blocker",
      category: "sql",
      description: "SQL injection",
      file: "a.ts",
      line: 10,
      evidence: [
        {
          file: "a.ts",
          startLine: 10,
          endLine: 10,
          code: "db.query('real')",
        },
      ],
      suggestedFix: null,
      confidence: 0.9,
      assumptions: null,
      requiresMoreContext: false,
      issueKey: "k-BYP",
    };
    const raw = JSON.stringify({
      findings: [
        makeRawFinding({
          description: "SQL injection",
          file: "a.ts",
          line: 10,
          evidence: source.evidence,
          issueKey: "k-BYP",
          legacyUnlocated: true, // invented by merger
        }),
      ],
    });
    const result = parseMergerResult(raw, [source]);
    expect(result).not.toBeNull();
    expect(result!.findings[0].legacyUnlocated).toBeFalsy();
  });
});

describe("parseJudgeResult", () => {
  it("parses valid full output", () => {
    const raw = JSON.stringify({
      verdict: "revise",
      verdictReason: "major finding unresolved",
      findings: [{ severity: "major" }],
      tensions: [],
      lensesCompleted: ["security"],
      lensesInsufficientContext: [],
      lensesFailed: [],
      lensesSkipped: ["accessibility"],
      isPartial: false,
    });
    const result = parseJudgeResult(raw);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("revise");
    expect(result!.verdictReason).toBe("major finding unresolved");
    expect(result!.isPartial).toBe(false);
    expect(result!.lensesSkipped).toEqual(["accessibility"]);
  });

  it("returns null on invalid JSON", () => {
    expect(parseJudgeResult("not json")).toBeNull();
  });

  it("returns null when verdict is missing", () => {
    expect(parseJudgeResult(JSON.stringify({ findings: [] }))).toBeNull();
    expect(parseJudgeResult(JSON.stringify({}))).toBeNull();
  });

  it("returns null on null input content", () => {
    expect(parseJudgeResult(JSON.stringify(null))).toBeNull();
  });

  it("defaults optional fields to empty/false", () => {
    const raw = JSON.stringify({ verdict: "approve" });
    const result = parseJudgeResult(raw);
    expect(result).not.toBeNull();
    expect(result!.verdictReason).toBe("");
    expect(result!.findings).toEqual([]);
    expect(result!.tensions).toEqual([]);
    expect(result!.lensesCompleted).toEqual([]);
    expect(result!.lensesFailed).toEqual([]);
    expect(result!.lensesSkipped).toEqual([]);
    expect(result!.isPartial).toBe(false);
  });

  it("rejects invalid verdict values", () => {
    expect(parseJudgeResult(JSON.stringify({ verdict: "request_changes" }))).toBeNull();
    expect(parseJudgeResult(JSON.stringify({ verdict: "approve with concerns" }))).toBeNull();
    expect(parseJudgeResult(JSON.stringify({ verdict: "" }))).toBeNull();
  });

  it("ignores LLM isPartial -- always false (orchestrator overrides)", () => {
    const raw = JSON.stringify({ verdict: "revise", isPartial: true });
    const result = parseJudgeResult(raw);
    expect(result!.isPartial).toBe(false); // Orchestrator computes from lensesFailed
  });
});
