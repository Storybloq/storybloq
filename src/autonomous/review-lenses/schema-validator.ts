/**
 * Validates LensFinding objects returned by lens subagents.
 *
 * LLM output is inherently unreliable. This ensures downstream code
 * can trust the shape of every finding. Includes lenient field mapping
 * for common agent variations (title->description, location->file).
 */

import type { LensFinding } from "./types.js";

const VALID_SEVERITIES = new Set(["critical", "major", "minor", "suggestion"]);
const VALID_IMPACTS = new Set(["blocker", "needs-revision", "non-blocking"]);

export interface ValidationResult {
  readonly valid: LensFinding[];
  readonly invalid: { raw: unknown; reason: string }[];
}

/**
 * Map common agent field variations to canonical LensFinding fields.
 * Agents naturally produce slightly different names (title vs description,
 * location vs file). This maps them before strict validation.
 */
function normalizeFields(item: Record<string, unknown>): Record<string, unknown> {
  const out = { ...item };

  // title -> description
  if (!out.description && typeof out.title === "string") {
    out.description = out.title;
  }

  // location -> file (extract path from location string like "src/foo.ts:42")
  if (!out.file && typeof out.location === "string" && out.location.length > 0) {
    const loc = out.location;
    const colonIdx = loc.lastIndexOf(":");
    out.file = colonIdx > 0 ? loc.slice(0, colonIdx) : loc;
    if (!out.line && colonIdx > 0) {
      const lineNum = parseInt(loc.slice(colonIdx + 1), 10);
      if (!isNaN(lineNum)) out.line = lineNum;
    }
  }

  // Defaults for commonly omitted fields
  if (out.lensVersion === undefined) out.lensVersion = "unknown";
  if (out.requiresMoreContext === undefined) out.requiresMoreContext = false;
  if (out.assumptions === undefined) out.assumptions = null;
  // Normalize recommendedImpact -- agents use varied terms
  if (out.recommendedImpact === undefined) {
    out.recommendedImpact = "non-blocking";
  } else if (!VALID_IMPACTS.has(out.recommendedImpact as string)) {
    // Map common agent variations
    const val = String(out.recommendedImpact).toLowerCase();
    if (val === "important" || val === "needs-revision" || val === "revision") {
      out.recommendedImpact = "needs-revision";
    } else if (val === "blocker" || val === "blocking" || val === "critical") {
      out.recommendedImpact = "blocker";
    } else {
      out.recommendedImpact = "non-blocking";
    }
  }

  return out;
}

export function validateFindings(
  raw: unknown[] | unknown,
  lensName: string | null,
): ValidationResult {
  if (!Array.isArray(raw)) {
    return { valid: [], invalid: [{ raw, reason: "findings is not an array" }] };
  }
  const valid: LensFinding[] = [];
  const invalid: { raw: unknown; reason: string }[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      invalid.push({ raw: item, reason: "not an object" });
      continue;
    }
    const normalized = normalizeFields(item as Record<string, unknown>);
    // Inject lens from parent when finding doesn't include it (ISS-092)
    if (typeof normalized.lens !== "string" && typeof lensName === "string") {
      normalized.lens = lensName;
    }
    const reason = checkFinding(normalized, lensName);
    if (reason) {
      invalid.push({ raw: item, reason });
    } else {
      valid.push(normalized as unknown as LensFinding);
    }
  }

  return { valid, invalid };
}

function checkFinding(f: Record<string, unknown>, lensName: string | null): string | null {
  if (typeof f.lens !== "string") return "missing lens";
  if (typeof f.lensVersion !== "string") return "missing lensVersion";
  if (typeof f.severity !== "string" || !VALID_SEVERITIES.has(f.severity))
    return `invalid severity: ${f.severity}`;
  if (
    typeof f.recommendedImpact !== "string" ||
    !VALID_IMPACTS.has(f.recommendedImpact)
  )
    return `invalid recommendedImpact: ${f.recommendedImpact}`;
  if (typeof f.category !== "string" || f.category.length === 0)
    return "missing category";
  if (typeof f.description !== "string" || f.description.length === 0)
    return "missing description";
  if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1)
    return `invalid confidence: ${f.confidence}`;
  if (typeof f.requiresMoreContext !== "boolean")
    return "missing requiresMoreContext";

  // Lens name mismatch accepted -- agents sometimes report findings under a different lens name

  return null;
}
