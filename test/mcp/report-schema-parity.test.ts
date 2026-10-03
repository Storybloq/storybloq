/**
 * ISS-988: field-presence coverage between the internal report types and the
 * registered MCP report schema.
 *
 * The schema is a bare z.object with no .passthrough(), so a field the stages
 * consume but the schema omits is stripped at the tool boundary. That shipped
 * three times: ISS-717 (findings[].recommendedNextState), ISS-724
 * (findings[].lens) and ISS-988 (overrideOverlap). Stages read the report
 * through GuideReportInput and Finding, so the type checker already forces
 * "consumed implies declared on the interface"; this file pins the remaining
 * link, "declared on the interface implies declared in the schema", plus the
 * findings fields consumed through casts.
 *
 * This is FIELD PRESENCE only. It does not compare optionality, types or enum
 * widths; the targeted parse tests (B7 in finalize-overlap-boundary.test.ts,
 * N3 here) cover the places where that compatibility matters today.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod";

import { registerAllTools } from "../../src/mcp/tools.js";
import { toolSchema } from "./tool-schema-helpers.js";

const SESSION_TYPES = join(import.meta.dirname, "../../src/autonomous/session-types.ts");

/** Interface fields deliberately absent from the report schema, with the reason. */
const EXEMPT_REPORT: Readonly<Record<string, string>> = {};
const EXEMPT_FINDING: Readonly<Record<string, string>> = {
  rawSeverity: "server-derived: review-identity.ts fills it from the reported severity; reporters never send it",
};

/**
 * Findings fields that Finding does not declare but a stage reads through a
 * Record<string, unknown> cast, so the type checker cannot see them.
 */
const CAST_CONSUMED_FINDING_FIELDS: Readonly<Record<string, string>> = {
  lens: "stages/types.ts buildLensHistoryUpdate (ISS-724)",
  file: "stages/plan-review.ts DriftFinding (ISS-598)",
  contributingLenses: "review-contract.ts lensIdsOf",
};

/** Property names of a top-level interface; throws on anything it cannot see completely. */
function interfaceKeys(source: string, name: string): string[] {
  const file = ts.createSourceFile("session-types.ts", source, ts.ScriptTarget.Latest, true);
  let found: ts.InterfaceDeclaration | undefined;
  file.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) found = node;
  });
  if (!found) throw new Error(`interface ${name} not found`);
  if (found.heritageClauses && found.heritageClauses.length > 0) {
    throw new Error(`interface ${name} has heritage clauses; inherited members would be missed`);
  }
  const keys: string[] = [];
  for (const member of found.members) {
    if (!ts.isPropertySignature(member)) throw new Error(`interface ${name} has a non-property member`);
    keys.push(member.name.getText(file));
  }
  return keys;
}

/** Keys of `expected` (minus exemptions) that `actual` lacks. */
function missingFromSchema(expected: readonly string[], actual: readonly string[], exempt: Readonly<Record<string, string>>): string[] {
  return expected.filter((key) => !(key in exempt) && !actual.includes(key));
}

/** Unwraps optional, default, nullable and effects wrappers down to an object or array. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
    else if (current instanceof z.ZodDefault) current = current.removeDefault();
    else if (current instanceof z.ZodEffects) current = current.innerType();
    else return current;
  }
}

function registeredReport(): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const root = mkdtempSync(join(tmpdir(), "iss988-parity-"));
  try {
    const tools = new Map<string, { inputSchema?: unknown }>();
    const server = {
      registerTool: (name: string, config: { inputSchema?: unknown }) => tools.set(name, config),
    } as unknown as Parameters<typeof registerAllTools>[0];
    registerAllTools(server, root);
    const guide = tools.get("storybloq_autonomous_guide");
    if (!guide) throw new Error("storybloq_autonomous_guide was not registered");
    const schema = toolSchema(guide.inputSchema) as z.ZodObject<Record<string, z.ZodTypeAny>>;
    const report = unwrap(schema.shape.report!);
    if (!(report instanceof z.ZodObject)) throw new Error("report is not a z.object");
    return report as z.ZodObject<Record<string, z.ZodTypeAny>>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function findingElement(report: z.ZodObject<Record<string, z.ZodTypeAny>>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const findings = unwrap(report.shape.findings!);
  if (!(findings instanceof z.ZodArray)) throw new Error("report.findings is not an array");
  const element = unwrap(findings.element);
  if (!(element instanceof z.ZodObject)) throw new Error("report.findings element is not a z.object");
  return element as z.ZodObject<Record<string, z.ZodTypeAny>>;
}

const source = readFileSync(SESSION_TYPES, "utf-8");
const reportKeys = interfaceKeys(source, "GuideReportInput");
const findingKeys = interfaceKeys(source, "Finding");
const report = registeredReport();
const schemaReportKeys = Object.keys(report.shape);
const schemaFindingKeys = Object.keys(findingElement(report).shape);

describe("ISS-988: report schema field-presence parity", () => {
  it("S1: every GuideReportInput field is declared in the registered report schema", () => {
    expect(missingFromSchema(reportKeys, schemaReportKeys, EXEMPT_REPORT)).toEqual([]);
  });

  it("S2: the extraction is real (non-empty, with known fields)", () => {
    expect(reportKeys.length).toBeGreaterThanOrEqual(20);
    expect(reportKeys).toEqual(expect.arrayContaining(["completedAction", "overrideAttribution", "overrideOverlap"]));
    expect(findingKeys).toEqual(expect.arrayContaining(["severity", "recommendedNextState"]));
  });

  it("S3: the comparator reports exactly the missing key", () => {
    expect(missingFromSchema(["completedAction", "a", "b"], ["a", "b"], {})).toEqual(["completedAction"]);
  });

  it("S4: every exemption still names a field on its interface", () => {
    for (const key of Object.keys(EXEMPT_REPORT)) expect(reportKeys).toContain(key);
    for (const key of Object.keys(EXEMPT_FINDING)) expect(findingKeys).toContain(key);
  });

  it("S5: the extractor refuses an interface with heritage clauses", () => {
    expect(() => interfaceKeys("interface X { b: string }\ninterface GuideReportInput extends X { a?: string }\n", "GuideReportInput"))
      .toThrow(/heritage/);
  });

  it("N1: every Finding field is declared in the registered findings element", () => {
    expect(missingFromSchema(findingKeys, schemaFindingKeys, EXEMPT_FINDING)).toEqual([]);
  });

  it("N2: every cast-consumed findings field is declared in the registered findings element", () => {
    expect(missingFromSchema(Object.keys(CAST_CONSUMED_FINDING_FIELDS), schemaFindingKeys, {})).toEqual([]);
  });

  it("N3: findings[].recommendedNextState parses its enum through the registered schema", () => {
    const parse = (value: string) => report.safeParse({
      completedAction: "plan_review_round",
      findings: [{ severity: "major", category: "c", description: "d", recommendedNextState: value }],
    });
    const first = (value: string) => {
      const result = parse(value);
      return result.success ? (result.data.findings as Array<Record<string, unknown>>)[0]!.recommendedNextState : undefined;
    };
    expect(first("PLAN")).toBe("PLAN");
    expect(first("IMPLEMENT")).toBe("IMPLEMENT");
    expect(parse("REPLAN").success).toBe(false);
  });
});
