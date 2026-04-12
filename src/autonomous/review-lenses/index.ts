/**
 * Multi-Lens Review Orchestrator -- public API.
 */

export { prepareLensReview } from "./orchestrator.js";
export type {
  LensReviewOptions,
  PreparedLensReview,
  OrchestratorOutput,
  JudgeInput,
} from "./orchestrator.js";

export { determineActiveLenses } from "./activation.js";
export { computeBlocking } from "./blocking-policy.js";
export { generateIssueKey } from "./issue-key.js";
export {
  validateFindings,
  validateCachedFindings,
  bridgeLegacyEvidence,
  enforceLocationInvariant,
  restoreSourceMarkers,
  logRestorationSkip,
  getRestorationSkipCounts,
} from "./schema-validator.js";
export type { ValidationResult } from "./schema-validator.js";
export {
  lensFindingSchema,
  evidenceItemSchema,
  parseLensFinding,
  isLegacyBridgedEvidence,
  flattenZodError,
  LEGACY_NO_CODE_PLACEHOLDER,
  LEGACY_UNLOCATED_FILE,
} from "./finding-schema.js";
export { parseMergerResult, buildMergerPrompt } from "./merger.js";
export { parseJudgeResult, buildJudgePrompt } from "./judge.js";
export {
  buildCacheKey,
  getFromCache,
  writeToCache,
  clearCache,
  getCacheMetrics,
} from "./cache.js";
export { buildLensPrompt, getLensVersion } from "./lenses/index.js";
export { compareResults, formatEvaluationReport } from "./evaluation.js";
export {
  writeReviewSnapshot,
  readReviewSnapshotManifest,
  archiveReviewSnapshot,
} from "./review-snapshot.js";
export type {
  ReviewSnapshotInput,
  ReviewSnapshotManifest,
  ReviewSnapshotManifestFileEntry,
  WriteReviewSnapshotResult,
  ArchiveReviewSnapshotResult,
} from "./review-snapshot.js";
export {
  verifyLensFinding,
  normalizeForVerification,
  VERIFY_RECOVERY_WINDOW,
  SnapshotIntegrityError,
} from "./verification.js";
export type {
  VerifyResult,
  VerifyPass,
  VerifyFail,
  VerifyFailDetails,
  VerifyReasonCode,
  VerifiedEvidence,
  SnapshotContext,
  SnapshotIntegrityCode,
} from "./verification.js";

export type {
  LensFinding,
  EvidenceItem,
  LensResult,
  Tension,
  MergerResult,
  MergeEntry,
  SynthesisResult,
  LensProgressEvent,
  BlockingPolicy,
  LensConfig,
  LensMetadata,
  LensName,
  ReviewStage,
  LensPromptVariables,
} from "./types.js";

export {
  CORE_LENSES,
  SURFACE_LENSES,
  ALL_LENSES,
  LENS_MAX_SEVERITY,
  DEFAULT_BLOCKING_POLICY,
  DEFAULT_LENS_CONFIG,
} from "./types.js";
