/**
 * ISS-717: the storybloq_autonomous_guide report.findings[] MCP schema must
 * accept synthesized lens-shaped findings (which carry severity/category/
 * description but no id and no disposition) instead of rejecting them with
 * -32602 before the contradiction guard in the review stage can run. These
 * tests parse payloads through the REAL registered inputSchema (captured via a
 * mock server) rather than a reconstructed copy.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../../src/mcp/tools.js";
import { buildLensHistoryUpdate } from "../../src/autonomous/stages/types.js";
import { toolSchema } from "./tool-schema-helpers.js";

function captureGuideSchema(): z.ZodTypeAny {
  const tools = new Map<string, { inputSchema: unknown }>();
  const server = {
    registerTool: (name: string, config: { inputSchema: unknown }) => {
      tools.set(name, config);
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, "/tmp/iss717-test-root");
  const guide = tools.get("storybloq_autonomous_guide");
  if (!guide) throw new Error("storybloq_autonomous_guide was not registered");
  return toolSchema(guide.inputSchema);
}

const SCHEMA = captureGuideSchema();
const SID = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";

function parseReport(findings: unknown[], verdict = "approve"): any {
  return SCHEMA.parse({
    sessionId: SID,
    action: "report",
    report: { completedAction: "code_review_round", verdict, findings },
  });
}

describe("autonomous_guide report.findings schema (ISS-717)", () => {
  it("accepts a lens-shaped finding with no id or disposition and defaults disposition to open", () => {
    const parsed = parseReport([
      { severity: "major", category: "logic", description: "missing null check" },
    ]);
    const f = parsed.report.findings[0];
    expect(f.disposition).toBe("open");
    expect(f.id).toBeUndefined();
    expect(f.severity).toBe("major");
  });

  it("preserves the lens field (ISS-724) but strips the other lens-only fields", () => {
    const parsed = parseReport([
      {
        lens: "security",
        lensVersion: "security-v2",
        severity: "critical",
        category: "injection",
        description: "sql injection",
        recommendedImpact: "blocker",
        evidence: [{ file: "a.ts", startLine: 1, endLine: 2, code: "x" }],
        confidence: 0.9,
        issueKey: "security:a.ts:1:injection",
      },
    ], "request_changes");
    const f = parsed.report.findings[0];
    expect(f.severity).toBe("critical");
    expect(f.disposition).toBe("open");
    // ISS-724: lens now survives the boundary so lensReviewHistory records a
    // real per-lens entry instead of collapsing to lens:'unknown'.
    expect(f.lens).toBe("security");
    // The remaining lens-only fields are unused downstream and stay stripped.
    expect(f.lensVersion).toBeUndefined();
    expect(f.recommendedImpact).toBeUndefined();
    expect(f.evidence).toBeUndefined();
    expect(f.confidence).toBeUndefined();
    expect(f.issueKey).toBeUndefined();
  });

  it("accepts recommendedNextState, which used to be stripped (PLAN-redirect guard was dead)", () => {
    const parsed = parseReport([
      { severity: "major", category: "design", description: "wrong approach", recommendedNextState: "PLAN" },
    ], "revise");
    expect(parsed.report.findings[0].recommendedNextState).toBe("PLAN");
  });

  it("still honors an explicitly supplied id and disposition", () => {
    const parsed = parseReport([
      { id: "F-1", severity: "minor", category: "style", description: "nit", disposition: "addressed" },
    ]);
    const f = parsed.report.findings[0];
    expect(f.id).toBe("F-1");
    expect(f.disposition).toBe("addressed");
  });

  it("still rejects an out-of-vocabulary disposition", () => {
    expect(() =>
      parseReport([{ severity: "major", category: "x", description: "y", disposition: "bogus" }]),
    ).toThrow();
  });
});

describe("lens fidelity through the report boundary (ISS-724)", () => {
  it("a lens-shaped finding parsed through the real schema records its true lens in history", () => {
    const parsed = parseReport([
      { lens: "security", severity: "critical", category: "injection", description: "sql injection" },
      { lens: "error-handling", severity: "major", category: "swallowed-error", description: "empty catch" },
    ], "request_changes");

    const history = buildLensHistoryUpdate(parsed.report.findings, [], "T-001", "CODE_REVIEW");
    expect(history).not.toBeNull();
    expect(history!.map((e) => e.lens).sort()).toEqual(["error-handling", "security"]);
    // Distinct lenses no longer collapse onto lens:'unknown'.
    expect(history!.some((e) => e.lens === "unknown")).toBe(false);
  });

  it("a finding with no lens still falls back to 'unknown' (e.g. a non-lens reviewer)", () => {
    const parsed = parseReport([
      { severity: "major", category: "logic", description: "missing null check" },
    ]);
    const history = buildLensHistoryUpdate(parsed.report.findings, [], "T-001", "CODE_REVIEW");
    expect(history).not.toBeNull();
    expect(history![0].lens).toBe("unknown");
  });
});
