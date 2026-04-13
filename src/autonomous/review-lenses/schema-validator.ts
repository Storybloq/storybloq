/**
 * Validates LensFinding objects returned by lens subagents (T-253).
 *
 * LLM output is inherently unreliable. This module is the single choke-point
 * between raw LLM findings and the rest of the subsystem. Two entry points:
 *
 *   - `validateFindings` — raw-input path (lens output, secrets-gate meta
 *     finding, merger LLM output). Strips validator-owned markers, runs the
 *     legacy evidence bridge, enforces the location invariant, then Zod.
 *
 *   - `validateCachedFindings` — cached-input path (cache.ts:getFromCache
 *     only). Runs Zod only; cached findings were produced by a prior raw-path
 *     call and their markers/evidence arrays are already validator-owned.
 *
 * `restoreSourceMarkers` is a pure helper called by `parseMergerResult` after
 * raw-path validation to overlay source-authoritative `(evidence,
 * legacySynthesizedEvidence, legacyUnlocated)` from the pre-merger source
 * set, resolved via a merge-stable identity (`mergeLog[].mergedFindings`)
 * and filtered by a site-stable `(file, line)` spoof guard with a null-site
 * null-check + an agreement-or-single-source rule for multi-source merges.
 */

import type {
  EvidenceItem,
  LensFinding,
  MergeEntry,
} from "./types.js";
import {
  LEGACY_NO_CODE_PLACEHOLDER,
  LEGACY_UNLOCATED_FILE,
  flattenZodError,
  lensFindingSchema,
} from "./finding-schema.js";

export interface ValidationResult {
  readonly valid: LensFinding[];
  readonly invalid: { raw: unknown; reason: string }[];
}

const VALID_IMPACTS = new Set(["blocker", "needs-revision", "non-blocking"]);

// ── Field normalization (lenient) ───────────────────────────────

function normalizeFields(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...item };

  // title -> description
  if (!out.description && typeof out.title === "string") {
    out.description = out.title;
  }

  // location -> file (extract path from "src/foo.ts:42")
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
  if (out.suggestedFix === undefined) out.suggestedFix = null;
  if (out.file === undefined) out.file = null;
  if (out.line === undefined) out.line = null;

  if (out.recommendedImpact === undefined) {
    out.recommendedImpact = "non-blocking";
  } else if (!VALID_IMPACTS.has(out.recommendedImpact as string)) {
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

// ── Legacy evidence bridge ──────────────────────────────────────

type BridgeSource = "producer-array" | "legacy-string" | "legacy-null";

interface BridgedRaw {
  readonly normalized: Record<string, unknown>;
  readonly source: BridgeSource;
}

// Pure function. Given a normalized record, produce an EvidenceItem[] of
// length >= 1 and set the two markers deterministically from the raw shape.
// Producer-array row leaves markers absent (they were stripped upstream).
export function bridgeLegacyEvidence(
  normalized: Record<string, unknown>,
): BridgedRaw {
  const rawEvidence = normalized.evidence;
  const file = normalized.file;
  const line = normalized.line;

  // Producer-array path: any non-empty array. Malformed elements (non-object
  // entries, primitives, nested arrays) are forwarded unchanged so Zod
  // surfaces a structural error on the producer rather than being silently
  // re-routed to the legacy-null synthesis path.
  //
  // CDX-R2-01: markers are NEVER re-applied on the producer-array path, even
  // when evidence[0] contains sentinel strings. A producer embedding
  // LEGACY_UNLOCATED_FILE or LEGACY_NO_CODE_PLACEHOLDER as evidence content
  // cannot forge a legacy-bridged marker. Markers only flow via
  // restoreSourceMarkers from an authoritative pre-merger source set.
  if (Array.isArray(rawEvidence) && rawEvidence.length > 0) {
    return {
      normalized: { ...normalized, evidence: rawEvidence },
      source: "producer-array",
    };
  }

  // Legacy-string path: evidence is a non-empty string.
  if (typeof rawEvidence === "string" && rawEvidence.length > 0) {
    const bridgedFile =
      typeof file === "string" && file.length > 0 ? file : LEGACY_UNLOCATED_FILE;
    const bridgedLine =
      typeof line === "number" && Number.isFinite(line) && line >= 1 ? line : 1;
    const item: EvidenceItem = {
      file: bridgedFile,
      startLine: bridgedLine,
      endLine: bridgedLine,
      code: rawEvidence,
    };
    const out: Record<string, unknown> = { ...normalized, evidence: [item] };
    // legacySynthesizedEvidence absent (real code).
    // legacyUnlocated: true iff location was defaulted.
    if (bridgedFile === LEGACY_UNLOCATED_FILE || bridgedLine !== line) {
      out.legacyUnlocated = true;
    }
    return { normalized: out, source: "legacy-string" };
  }

  // Legacy-null path: evidence is null, undefined, or empty array (the
  // producer-array path above requires length > 0; empty arrays fall through
  // here to be synthesized from file/line like a null-evidence row).
  const bridgedFile =
    typeof file === "string" && file.length > 0 ? file : LEGACY_UNLOCATED_FILE;
  const bridgedLine =
    typeof line === "number" && Number.isFinite(line) && line >= 1 ? line : 1;
  const item: EvidenceItem = {
    file: bridgedFile,
    startLine: bridgedLine,
    endLine: bridgedLine,
    code: LEGACY_NO_CODE_PLACEHOLDER,
  };
  const out: Record<string, unknown> = {
    ...normalized,
    evidence: [item],
    legacySynthesizedEvidence: true,
  };
  if (bridgedFile === LEGACY_UNLOCATED_FILE || bridgedLine !== line) {
    out.legacyUnlocated = true;
  }
  return { normalized: out, source: "legacy-null" };
}

// ── Location invariant (component-wise reject) ──────────────────

// CDX-2 + CDX-8 + CDX-10: on producer-array shape only, reject if a
// non-null file disagrees with evidence[0].file OR a non-null line disagrees
// with evidence[0].startLine. Never auto-populate either field — preserve
// whatever the producer sent. Legacy paths are skipped because the bridge
// derived evidence from file/line by construction.
export function enforceLocationInvariant(
  bridged: BridgedRaw,
): { ok: true } | { ok: false; reason: string } {
  if (bridged.source !== "producer-array") return { ok: true };
  const r = bridged.normalized;
  const evArr = r.evidence as readonly EvidenceItem[] | undefined;
  if (!evArr || evArr.length === 0) return { ok: true };
  const first = evArr[0];
  if (!first || typeof first !== "object") return { ok: true };

  // CDX-R2-03: legacy-bridged shape requires BOTH sentinels. A producer with
  // only one sentinel (e.g. real code paired with LEGACY_UNLOCATED_FILE, or a
  // real path paired with LEGACY_NO_CODE_PLACEHOLDER) is structurally
  // inconsistent and must not be exempted from the mismatch check — exempting
  // on OR lets a producer forge a partial sentinel to bypass the invariant.
  // A fully bridged legacy finding has both (file=(unknown), code=placeholder).
  if (first.file === LEGACY_UNLOCATED_FILE && first.code === LEGACY_NO_CODE_PLACEHOLDER) {
    return { ok: true };
  }

  const file = r.file;
  const line = r.line;

  if (typeof file === "string" && file !== first.file) {
    return { ok: false, reason: "file_line_evidence_mismatch" };
  }
  if (typeof line === "number" && line !== first.startLine) {
    return { ok: false, reason: "file_line_evidence_mismatch" };
  }
  return { ok: true };
}

// ── validateFindings (raw-input path) ───────────────────────────

export function validateFindings(
  raw: unknown[] | unknown,
  lensName: string | null,
): ValidationResult {
  if (!Array.isArray(raw)) {
    return {
      valid: [],
      invalid: [{ raw, reason: "findings is not an array" }],
    };
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
    // CDX-11 + CDX-13: unconditionally strip validator-owned markers on the
    // raw path. Producers (lens LLM, merger LLM, secrets-gate) cannot set
    // these — only the bridge below may re-apply them based on the raw shape.
    delete normalized.legacySynthesizedEvidence;
    delete normalized.legacyUnlocated;

    const bridged = bridgeLegacyEvidence(normalized);
    const inv = enforceLocationInvariant(bridged);
    if (!inv.ok) {
      invalid.push({ raw: item, reason: inv.reason });
      continue;
    }
    const parsed = lensFindingSchema.safeParse(bridged.normalized);
    if (!parsed.success) {
      invalid.push({ raw: item, reason: flattenZodError(parsed.error) });
      continue;
    }
    valid.push(parsed.data as unknown as LensFinding);
  }

  return { valid, invalid };
}

// ── validateCachedFindings (cached-input path) ──────────────────

export function validateCachedFindings(
  cached: unknown[] | unknown,
): ValidationResult {
  if (!Array.isArray(cached)) {
    return {
      valid: [],
      invalid: [{ raw: cached, reason: "findings is not an array" }],
    };
  }
  const valid: LensFinding[] = [];
  const invalid: { raw: unknown; reason: string }[] = [];

  for (const item of cached) {
    const parsed = lensFindingSchema.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data as unknown as LensFinding);
    } else {
      invalid.push({ raw: item, reason: flattenZodError(parsed.error) });
    }
  }

  return { valid, invalid };
}

// ── Restoration observability (CDX-19) ─────────────────────────

type RestorationSkipReason =
  | "no_issue_key"
  | "source_missing"
  | "site_unlocated"
  | "site_mismatch"
  | "no_contributing_sources"
  | "multi_source_disagreement"
  | "mergelog_malformed_entry"
  | "mergelog_oversized_entry"
  | "parse_merger_exception";

const restorationSkipCounts: Record<string, number> = {};

export function logRestorationSkip(
  reason: RestorationSkipReason,
  issueKey: string | undefined,
  details: Record<string, unknown>,
): void {
  restorationSkipCounts[reason] = (restorationSkipCounts[reason] ?? 0) + 1;
  try {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "restore_skip",
        reason,
        issueKey,
        details,
      }),
    );
  } catch {
    // Swallow logger errors — data path must stay correct even if stderr is
    // broken. The counter increment has already run, which is the observable
    // signal the regression tests rely on.
  }
}

export function getRestorationSkipCounts(): Readonly<Record<string, number>> {
  return { ...restorationSkipCounts };
}

// Test-only reset hook (CDX-19.a). Production code MUST NOT call this.
export function resetRestorationSkipCounts(): void {
  for (const key of Object.keys(restorationSkipCounts)) {
    delete restorationSkipCounts[key];
  }
}

// ── restoreSourceMarkers (merger path only) ─────────────────────

// CDX-R2-02: defense-in-depth marker strip. Called on every non-overlay
// return path in `restoreSourceMarkers` so a finding that fails the spoof
// guard never keeps a marker that survived raw-path stripping via some future
// regression. Markers must only flow through the source-authoritative overlay.
function stripMarkers(f: LensFinding): LensFinding {
  if (
    f.legacySynthesizedEvidence === undefined &&
    f.legacyUnlocated === undefined
  ) {
    return f;
  }
  const out = { ...f };
  delete (out as { legacySynthesizedEvidence?: boolean }).legacySynthesizedEvidence;
  delete (out as { legacyUnlocated?: boolean }).legacyUnlocated;
  return out;
}

// Unordered multiset equality on evidence arrays, keyed on the identity
// tuple (file, startLine, endLine, code). Private to restoreSourceMarkers.
function evidenceMultisetsEqual(
  a: readonly EvidenceItem[],
  b: readonly EvidenceItem[],
): boolean {
  if (a.length !== b.length) return false;
  const keyOf = (x: EvidenceItem): string =>
    JSON.stringify([x.file, x.startLine, x.endLine, x.code]);
  const counts = new Map<string, number>();
  for (const x of a) {
    const k = keyOf(x);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const x of b) {
    const k = keyOf(x);
    const c = counts.get(k) ?? 0;
    if (c === 0) return false;
    counts.set(k, c - 1);
  }
  return true;
}

export function restoreSourceMarkers(
  valid: readonly LensFinding[],
  sourceFindings: readonly LensFinding[],
  mergeLog: readonly MergeEntry[],
): readonly LensFinding[] {
  // Map source issueKey → source finding. First-wins on collision.
  const sourceByKey = new Map<string, LensFinding>();
  for (const s of sourceFindings) {
    if (s.issueKey && !sourceByKey.has(s.issueKey)) {
      sourceByKey.set(s.issueKey, s);
    }
  }

  // Map result issueKey → contributing source issueKeys (CDX-16).
  const resultToSources = new Map<string, readonly string[]>();
  for (const entry of mergeLog) {
    if (
      entry.resultKey &&
      Array.isArray(entry.mergedFindings) &&
      entry.mergedFindings.length > 0
    ) {
      resultToSources.set(entry.resultKey, entry.mergedFindings);
    }
  }

  return valid.map((f) => {
    if (!f.issueKey) {
      logRestorationSkip("no_issue_key", undefined, {});
      return stripMarkers(f);
    }

    const sourceKeys = resultToSources.get(f.issueKey) ?? [f.issueKey];

    const contributingSources: LensFinding[] = [];
    for (const key of sourceKeys) {
      const src = sourceByKey.get(key);
      if (!src) {
        logRestorationSkip("source_missing", f.issueKey, { sourceKey: key });
        continue;
      }
      // CDX-15: component-wise site equality. null == null is accepted per
      // component so legacy-unlocated findings with partial null sites can
      // restore; any non-null inequality or null/non-null asymmetry is a
      // spoof candidate and skipped.
      if (f.file !== src.file) {
        logRestorationSkip("site_mismatch", f.issueKey, { sourceKey: key });
        continue;
      }
      if (f.line !== src.line) {
        logRestorationSkip("site_mismatch", f.issueKey, { sourceKey: key });
        continue;
      }
      // CDX-19 vacuous-pass guard: if the entire site pair is null on both
      // sides there is nothing concrete to verify, so skip restoration.
      if (
        f.file === null &&
        f.line === null &&
        src.file === null &&
        src.line === null
      ) {
        logRestorationSkip("site_unlocated", f.issueKey, { sourceKey: key });
        continue;
      }
      contributingSources.push(src);
    }

    if (contributingSources.length === 0) {
      logRestorationSkip("no_contributing_sources", f.issueKey, {});
      return stripMarkers(f);
    }

    // CDX-17 + CDX-18: multi-source agreement on the verification triple.
    if (contributingSources.length > 1) {
      const first = contributingSources[0];
      const allAgree = contributingSources.every(
        (s) =>
          s.legacySynthesizedEvidence === first.legacySynthesizedEvidence &&
          s.legacyUnlocated === first.legacyUnlocated &&
          evidenceMultisetsEqual(s.evidence, first.evidence),
      );
      if (!allAgree) {
        logRestorationSkip("multi_source_disagreement", f.issueKey, {
          contributingCount: contributingSources.length,
        });
        return stripMarkers(f);
      }
    }

    const authoritative = contributingSources[0];

    // CDX-14: source-authoritative overlay of evidence + markers.
    const restored: LensFinding = {
      ...f,
      evidence: authoritative.evidence,
    };
    if (authoritative.legacySynthesizedEvidence === true) {
      (restored as { legacySynthesizedEvidence?: boolean }).legacySynthesizedEvidence = true;
    } else {
      delete (restored as { legacySynthesizedEvidence?: boolean }).legacySynthesizedEvidence;
    }
    if (authoritative.legacyUnlocated === true) {
      (restored as { legacyUnlocated?: boolean }).legacyUnlocated = true;
    } else {
      delete (restored as { legacyUnlocated?: boolean }).legacyUnlocated;
    }
    return restored;
  });
}
