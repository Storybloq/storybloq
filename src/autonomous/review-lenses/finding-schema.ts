/**
 * Zod schema for LensFinding + EvidenceItem (T-253).
 *
 * The schema is the single source of truth for the shape of a finding after
 * validation. `validateFindings` in schema-validator.ts runs raw LLM output
 * through a normalizer + legacy bridge + location invariant before calling
 * `lensFindingSchema.safeParse`. `validateCachedFindings` in the same file
 * runs cached findings straight through the Zod schema with no normalization.
 *
 * Sentinel constants (LEGACY_NO_CODE_PLACEHOLDER, LEGACY_UNLOCATED_FILE) pass
 * the Zod checks cleanly so legacy-shape findings survive the bridge.
 */

import { z } from "zod";
import type { LensFinding } from "./types.js";

// Sentinel: placeholder code string when legacy producer sent null/empty
// evidence. Non-whitespace so it survives .trim().min(1).
export const LEGACY_NO_CODE_PLACEHOLDER = "[legacy finding: no code excerpt provided]";

// Sentinel: placeholder file path when legacy producer sent null file.
export const LEGACY_UNLOCATED_FILE = "(unknown)";

export const evidenceItemSchema = z
  .object({
    file: z.string().trim().min(1),
    startLine: z.number().finite().int().min(1),
    endLine: z.number().finite().int().min(1),
    code: z.string().trim().min(1),
  })
  .refine((v) => v.endLine >= v.startLine, {
    message: "endLine must be >= startLine",
  });

const severityEnum = z.enum(["critical", "major", "minor", "suggestion"]);
const impactEnum = z.enum(["blocker", "needs-revision", "non-blocking"]);

// .passthrough() (CDX-4) preserves orchestrator-enriched fields through a
// parse roundtrip. Known enrichment fields are additionally declared below
// with permissive types so their shape is at least loosely asserted.
export const lensFindingSchema = z
  .object({
    lens: z.string().min(1),
    lensVersion: z.string().min(1),
    severity: severityEnum,
    recommendedImpact: impactEnum,
    category: z.string().min(1),
    description: z.string().min(1),
    // CDX-R1-03: empty strings coerced to null so downstream null-site
    // detection (spoof-guard, restoration vacuous-pass) cannot be fooled by
    // "" as a concrete-looking location.
    file: z.preprocess(
      (v) => (typeof v === "string" && v.trim().length === 0 ? null : v),
      z.string().trim().min(1).nullable(),
    ),
    // CDX-R1-04: constrain line to finite positive integers to match
    // EvidenceItem.startLine/endLine. Invalid numerics coerced to null so
    // they never reach restoration as fractional/negative locations.
    line: z.preprocess(
      (v) =>
        typeof v === "number" &&
        (!Number.isFinite(v) || !Number.isInteger(v) || v < 1)
          ? null
          : v,
      z.number().finite().int().min(1).nullable(),
    ),
    evidence: z
      .array(evidenceItemSchema)
      .min(1, "evidence must contain at least one item"),
    suggestedFix: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    assumptions: z.string().nullable(),
    requiresMoreContext: z.boolean(),
    inputSource: z.string().nullable().optional(),
    sink: z.string().nullable().optional(),
    legacySynthesizedEvidence: z.boolean().optional(),
    legacyUnlocated: z.boolean().optional(),
    // Orchestrator-enriched (loose types; written after lens output).
    issueKey: z.string().optional(),
    blocking: z.boolean().optional(),
    origin: z.enum(["introduced", "pre-existing"]).optional(),
    resolvedModel: z.string().optional(),
    mergedFrom: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export type InferredLensFinding = z.infer<typeof lensFindingSchema>;

export function parseLensFinding(
  raw: unknown,
): { ok: true; value: LensFinding } | { ok: false; error: string } {
  const parsed = lensFindingSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, value: parsed.data as unknown as LensFinding };
  }
  return { ok: false, error: flattenZodError(parsed.error) };
}

// CDX-9 single call site: T-255's verification gate imports this helper and
// skips substring/line verification when it returns true. Co-located with the
// schema to prevent T-255 from diverging from the bridged-finding definition.
export function isLegacyBridgedEvidence(f: LensFinding): boolean {
  return f.legacySynthesizedEvidence === true || f.legacyUnlocated === true;
}

// CDX-19 flattening rule: single semicolon-separated string with
// `<path>: <message>` per issue, `<root>` literal for empty paths.
export function flattenZodError(error: z.ZodError): string {
  return error.issues
    .map(
      (i) =>
        `${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.message}`,
    )
    .join("; ");
}
