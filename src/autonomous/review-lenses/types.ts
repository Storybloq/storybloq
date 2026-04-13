/**
 * Multi-Lens Review Orchestrator -- Type definitions.
 *
 * Design: N-027, MULTI_LENS_REVIEW.md, lenses.md
 * Ticket: T-181
 */

// ── Review stages ──────────────────────────────────────────────

export type ReviewStage = "CODE_REVIEW" | "PLAN_REVIEW";

// ── Evidence item (one verifiable code excerpt per site) ──────
//
// Each finding must ship at least one EvidenceItem. A lens authors it by
// quoting literal code from the reviewed snapshot. Lines are 1-indexed and
// inclusive on both ends. Multi-site findings carry one item per site so
// T-255 can verify each excerpt against the snapshot independently.
export interface EvidenceItem {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly code: string;
}

// ── Lens finding (output by each lens agent) ───────────────────

export interface LensFinding {
  // Identity
  readonly lens: string;
  readonly lensVersion: string;

  // Classification
  readonly severity: "critical" | "major" | "minor" | "suggestion";
  readonly recommendedImpact: "blocker" | "needs-revision" | "non-blocking";
  readonly category: string;

  // Content
  readonly description: string;
  /** @deprecated retained for the filing path and dedupe key through T-257; derive from evidence[0] once Sub 5 lands */
  readonly file: string | null;
  /** @deprecated retained for the filing path and dedupe key through T-257; derive from evidence[0] once Sub 5 lands */
  readonly line: number | null;
  // Runtime invariant (enforced by Zod in finding-schema.ts): non-empty array.
  readonly evidence: readonly EvidenceItem[];
  readonly suggestedFix: string | null;

  // Bridge markers (validator-owned; see finding-schema.ts + schema-validator.ts)
  readonly legacySynthesizedEvidence?: boolean;
  readonly legacyUnlocated?: boolean;

  // Confidence & assumptions
  readonly confidence: number;
  readonly assumptions: string | null;
  readonly requiresMoreContext: boolean;

  // Security-specific (optional)
  readonly inputSource?: string | null;
  readonly sink?: string | null;

  // Orchestrator-injected (not output by lenses)
  resolvedModel?: string;
  issueKey?: string;
  blocking?: boolean;
  mergedFrom?: string[] | null;
  origin?: "introduced" | "pre-existing";
}

// ── Lens result envelope ───────────────────────────────────────

export interface LensResult {
  readonly status: "complete" | "insufficient-context";
  readonly findings: readonly LensFinding[];
  readonly insufficientContextReason?: string;
}

// ── Tension (cross-lens conflict) ──────────────────────────────

export interface Tension {
  readonly lensA: string;
  readonly lensB: string;
  readonly description: string;
  readonly tradeoff: string;
  readonly blocking: boolean;
  readonly file: string | null;
  readonly line: number | null;
}

// ── Merge log entry ────────────────────────────────────────────

export interface MergeEntry {
  readonly mergedFindings: readonly string[]; // issueKeys that were merged
  readonly resultKey: string;
  readonly reason: string;
}

// ── Merger result ──────────────────────────────────────────────

export interface MergerResult {
  readonly findings: readonly LensFinding[];
  readonly tensions: readonly Tension[];
  readonly mergeLog: readonly MergeEntry[];
}

// ── Synthesis result (final output) ────────────────────────────

export interface SynthesisResult {
  readonly verdict: "approve" | "revise" | "reject";
  readonly verdictReason: string;
  readonly findings: readonly LensFinding[];
  readonly tensions: readonly Tension[];
  readonly lensesCompleted: readonly string[];
  readonly lensesInsufficientContext: readonly string[];
  readonly lensesFailed: readonly string[];
  readonly lensesSkipped: readonly string[];
  readonly isPartial: boolean;
}

// ── Progress events ────────────────────────────────────────────

export type LensStatus =
  | "queued"
  | "running"
  | "complete"
  | "insufficient-context"
  | "failed"
  | "skipped";

export interface LensProgressEvent {
  readonly reviewId: string;
  readonly lens: string;
  readonly status: LensStatus;
  readonly findingCount?: number;
  readonly duration?: number;
  readonly error?: string;
}

// ── Blocking policy ────────────────────────────────────────────

export interface BlockingPolicy {
  readonly neverBlock: readonly string[];
  readonly alwaysBlock: readonly string[];
  readonly planReviewBlockingLenses: readonly string[];
}

export const DEFAULT_BLOCKING_POLICY: BlockingPolicy = {
  neverBlock: [],
  alwaysBlock: ["injection", "auth-bypass", "hardcoded-secrets"],
  planReviewBlockingLenses: ["security", "error-handling"],
};

// ── Lens configuration (per-stage) ─────────────────────────────

export interface LensConfig {
  readonly lenses: "auto" | readonly string[];
  readonly maxLenses: number;
  readonly lensTimeout: number | { readonly default: number; readonly opus: number };
  readonly findingBudget: number;
  readonly confidenceFloor: number;
  readonly tokenBudgetPerLens: number;
  readonly hotPaths: readonly string[];
  readonly lensModels: Record<string, string>;
}

export const DEFAULT_LENS_CONFIG: LensConfig = {
  lenses: "auto",
  maxLenses: 8,
  lensTimeout: { default: 60, opus: 120 },
  findingBudget: 10,
  confidenceFloor: 0.6,
  tokenBudgetPerLens: 32_000,
  hotPaths: [],
  lensModels: {
    default: "sonnet",
    security: "opus",
    concurrency: "opus",
  },
};

// ── Lens metadata (for synthesizer) ────────────────────────────

export interface LensMetadata {
  readonly name: string;
  readonly maxSeverity: "critical" | "major";
  readonly isRequired: boolean;
  readonly status: LensStatus;
}

// ── Lens definition ────────────────────────────────────────────

export const CORE_LENSES = ["clean-code", "security", "error-handling"] as const;
export const SURFACE_LENSES = [
  "performance",
  "api-design",
  "concurrency",
  "test-quality",
  "accessibility",
] as const;
export const ALL_LENSES = [...CORE_LENSES, ...SURFACE_LENSES] as const;
export type LensName = (typeof ALL_LENSES)[number];

export const LENS_MAX_SEVERITY: Record<LensName, "critical" | "major"> = {
  "clean-code": "major",
  security: "critical",
  "error-handling": "critical",
  performance: "critical",
  "api-design": "critical",
  concurrency: "critical",
  "test-quality": "major",
  accessibility: "major",
};

// ── Context contract variables ─────────────────────────────────

export interface LensPromptVariables {
  readonly lensName: string;
  readonly lensVersion: string;
  readonly reviewStage: ReviewStage;
  readonly artifactType: "diff" | "plan";
  readonly ticketDescription: string;
  readonly projectRules: string;
  readonly fileManifest: string;
  readonly reviewArtifact: string;
  readonly knownFalsePositives: string;
  readonly activationReason: string;
  readonly findingBudget: number;
  readonly confidenceFloor: number;
  // Lens-specific
  readonly hotPaths?: string;
  readonly scannerFindings?: string;
}

// ── Test mapping config ────────────────────────────────────────

export interface TestMappingConfig {
  readonly strategy: "convention";
  readonly patterns: readonly {
    readonly source: string;
    readonly test: string;
  }[];
}
