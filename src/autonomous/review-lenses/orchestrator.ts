/**
 * Multi-Lens Review Orchestrator -- main entry point.
 *
 * Coordinates lens activation, context packaging, parallel subagent fan-out,
 * post-processing, merger, judge, caching, and progress events.
 *
 * Design: N-027, MULTI_LENS_REVIEW.md, lenses.md
 * Ticket: T-181
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  BlockingPolicy,
  LensConfig,
  LensFinding,
  LensMetadata,
  LensName,
  LensProgressEvent,
  LensResult,
  LensStatus,
  ReviewStage,
  SynthesisResult,
} from "./types.js";
import {
  CORE_LENSES,
  DEFAULT_BLOCKING_POLICY,
  DEFAULT_LENS_CONFIG,
  LENS_MAX_SEVERITY,
  ALL_LENSES,
} from "./types.js";
import { determineActiveLenses } from "./activation.js";
import { packageContext } from "./context-packager.js";
import { buildLensPrompt, getLensVersion } from "./lenses/index.js";
import { generateIssueKey } from "./issue-key.js";
import { computeBlocking } from "./blocking-policy.js";
import { validateFindings } from "./schema-validator.js";
import { buildCacheKey, getFromCache, writeToCache } from "./cache.js";
import { runSecretsGate } from "./secrets-gate.js";
import { buildMergerPrompt, parseMergerResult } from "./merger.js";
import { buildJudgePrompt, parseJudgeResult } from "./judge.js";

// ── Public API ─────────────────────────────────────────────────

export interface LensReviewOptions {
  readonly stage: ReviewStage;
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly ticketDescription: string;
  readonly projectRoot: string;
  readonly sessionDir?: string;
  readonly config?: Partial<LensConfig>;
  readonly repoPolicy?: Partial<BlockingPolicy>;
  readonly knownFalsePositives?: string;
  readonly requireSecretsGate?: boolean;
  readonly requireAccessibility?: boolean;
  readonly scannerFindings?: string;
  readonly onProgress?: (event: LensProgressEvent) => void;
}

/**
 * Result of preparing the lens review -- contains the subagent prompts
 * for the caller to spawn in parallel, plus the post-processing callback.
 */
export interface PreparedLensReview {
  readonly reviewId: string;
  readonly activeLenses: readonly LensName[];
  readonly skippedLenses: readonly string[];
  readonly subagentPrompts: ReadonlyMap<string, { prompt: string; model: string }>;
  readonly cachedFindings: ReadonlyMap<string, readonly LensFinding[]>;
  readonly secretsGateActive: boolean;
  readonly secretsMetaFinding: LensFinding | null;
  processResults(lensResults: ReadonlyMap<string, LensResult | null>): Promise<OrchestratorOutput>;
}

export interface OrchestratorOutput {
  readonly mergerPrompt: string;
  readonly mergerModel: string;
  processMergerResult(raw: string): JudgeInput;
}

export interface JudgeInput {
  readonly judgePrompt: string;
  readonly judgeModel: string;
  processJudgeResult(raw: string): SynthesisResult;
}

// ── Orchestrator ───────────────────────────────────────────────

export function prepareLensReview(opts: LensReviewOptions): PreparedLensReview {
  const config: LensConfig = { ...DEFAULT_LENS_CONFIG, ...opts.config };
  const policy: BlockingPolicy = { ...DEFAULT_BLOCKING_POLICY, ...opts.repoPolicy };
  const reviewId = `lens-${Date.now().toString(36)}`;
  const knownFP = opts.knownFalsePositives ?? "";

  const emit = (lens: string, status: LensStatus, extra?: Partial<LensProgressEvent>) => {
    opts.onProgress?.({ reviewId, lens, status, ...extra });
  };

  // 1. Pre-activation: package context first to get file contents for activation signals
  const preCtx = packageContext({
    stage: opts.stage,
    diff: opts.diff,
    changedFiles: opts.changedFiles as string[],
    activeLenses: [...ALL_LENSES], // all lenses for initial file read
    ticketDescription: opts.ticketDescription,
    projectRoot: opts.projectRoot,
    config,
  });

  // 2. Activation with file contents (enables ORM import + line count detection)
  const activation = determineActiveLenses(opts.changedFiles, config, preCtx.fileContents);
  const activeLenses = activation.active;
  const allLensNames = ALL_LENSES as readonly string[];
  const skippedLenses = allLensNames.filter(
    (l) => !activeLenses.includes(l as LensName),
  );

  // 3. Secrets gate (use filtered files -- only scan what lenses will see)
  const secretsResult = runSecretsGate(
    activation.filteredFiles,
    opts.projectRoot,
    opts.requireSecretsGate ?? false,
  );

  // 4. Re-package context with activated lenses for per-lens file routing
  const ctx = packageContext({
    stage: opts.stage,
    diff: opts.diff,
    changedFiles: activation.filteredFiles,
    activeLenses,
    ticketDescription: opts.ticketDescription,
    projectRoot: opts.projectRoot,
    config,
  });

  // 5. Build prompts + check cache
  const subagentPrompts = new Map<string, { prompt: string; model: string }>();
  const cachedFindings = new Map<string, readonly LensFinding[]>();
  const redactedArtifacts = new Map<string, string>(); // lens -> redacted artifact (for cache key in processResults)

  for (const lens of activeLenses) {
    const version = getLensVersion(lens);
    let artifact = ctx.perLensArtifacts.get(lens) ?? "";

    // Redact secrets if detected -- only for code review diffs (unified diff format).
    // Plan review text doesn't have diff markers, so redaction is a no-op. The secrets
    // meta-finding still fires as a blocker, informing the reviewer.
    if (secretsResult.secretsFound && opts.stage === "CODE_REVIEW") {
      artifact = redactArtifactSecrets(artifact, secretsResult.redactedLines);
    }
    redactedArtifacts.set(lens, artifact);

    // Check cache
    const cacheKey = buildCacheKey(
      lens, version, opts.stage,
      artifact,
      opts.ticketDescription,
      ctx.projectRules,
      knownFP,
    );
    const cached = opts.sessionDir ? getFromCache(opts.sessionDir, cacheKey) : null;
    if (cached) {
      cachedFindings.set(lens, cached);
      emit(lens, "complete", { findingCount: cached.length });
      continue;
    }

    // Build prompt
    const model = config.lensModels[lens] ?? config.lensModels.default ?? "sonnet";
    const vars = {
      lensName: lens,
      lensVersion: version,
      reviewStage: opts.stage,
      artifactType: (opts.stage === "CODE_REVIEW" ? "diff" : "plan") as "diff" | "plan",
      ticketDescription: opts.ticketDescription,
      projectRules: ctx.sharedHeader,
      fileManifest: ctx.fileManifest,
      reviewArtifact: artifact,
      knownFalsePositives: knownFP,
      activationReason: activation.reasons[lens] ?? "unknown",
      findingBudget: config.findingBudget,
      confidenceFloor: config.confidenceFloor,
      hotPaths: config.hotPaths.join(", ") || undefined,
      scannerFindings: lens === "security" ? opts.scannerFindings : undefined,
    };

    const prompt = buildLensPrompt(lens, opts.stage, vars);
    subagentPrompts.set(lens, { prompt, model });
    emit(lens, "queued");
  }

  // Return prepared review with post-processing callback
  return {
    reviewId,
    activeLenses,
    skippedLenses,
    subagentPrompts,
    cachedFindings,
    secretsGateActive: secretsResult.active,
    secretsMetaFinding: secretsResult.metaFinding,

    async processResults(lensResults) {
      const allFindings: LensFinding[] = [];
      const lensesCompleted: string[] = [];
      const lensesInsufficientContext: string[] = [];
      const lensesFailed: string[] = [];
      const lensMetadata: LensMetadata[] = [];

      // Add cached findings
      for (const [lens, findings] of cachedFindings) {
        allFindings.push(...findings);
        lensesCompleted.push(lens);
        lensMetadata.push({
          name: lens,
          maxSeverity: LENS_MAX_SEVERITY[lens as LensName] ?? "major",
          isRequired: (CORE_LENSES as readonly string[]).includes(lens),
          status: "complete",
        });
      }

      // Process new results
      for (const lens of activeLenses) {
        if (cachedFindings.has(lens)) continue;

        const result = lensResults.get(lens);
        if (!result) {
          lensesFailed.push(lens);
          emit(lens, "failed", { error: "no result returned" });
          lensMetadata.push({
            name: lens,
            maxSeverity: LENS_MAX_SEVERITY[lens] ?? "major",
            isRequired: (CORE_LENSES as readonly string[]).includes(lens),
            status: "failed",
          });
          continue;
        }

        if (result.status === "insufficient-context") {
          lensesInsufficientContext.push(lens);
          emit(lens, "insufficient-context");
          lensMetadata.push({
            name: lens,
            maxSeverity: LENS_MAX_SEVERITY[lens] ?? "major",
            isRequired: (CORE_LENSES as readonly string[]).includes(lens),
            status: "insufficient-context",
          });
          continue;
        }

        // Validate findings
        const validated = validateFindings(
          result.findings as unknown[],
          lens,
        );
        if (validated.invalid.length > 0) {
          // Log invalid findings count (not one event per invalid finding)
          emit(lens, "running", {
            error: `${validated.invalid.length} invalid finding(s) dropped: ${validated.invalid.map((i) => i.reason).join("; ")}`,
          });
        }

        // Apply finding budget + confidence floor
        let findings = validated.valid
          .filter((f) => f.confidence >= config.confidenceFloor)
          .sort((a, b) => {
            const sevOrder = { critical: 0, major: 1, minor: 2, suggestion: 3 };
            const sevDiff = (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3);
            return sevDiff !== 0 ? sevDiff : b.confidence - a.confidence;
          })
          .slice(0, config.findingBudget);

        // Inject orchestrator-computed fields
        const resolvedModel = config.lensModels[lens] ?? config.lensModels.default ?? "sonnet";
        findings = findings.map((f) => ({
          ...f,
          resolvedModel,
          issueKey: generateIssueKey(f),
          blocking: computeBlocking(f, opts.stage, policy),
        }));

        // Cache for next round -- use same redacted artifact from prep for key consistency
        const writeCacheKey = buildCacheKey(
          lens, getLensVersion(lens), opts.stage,
          redactedArtifacts.get(lens) ?? "",
          opts.ticketDescription,
          ctx.projectRules,
          knownFP,
        );
        if (opts.sessionDir) {
          try { writeToCache(opts.sessionDir, writeCacheKey, findings); }
          catch { /* best-effort caching */ }
        }

        allFindings.push(...findings);
        lensesCompleted.push(lens);
        emit(lens, "complete", { findingCount: findings.length });
        lensMetadata.push({
          name: lens,
          maxSeverity: LENS_MAX_SEVERITY[lens] ?? "major",
          isRequired: (CORE_LENSES as readonly string[]).includes(lens),
          status: "complete",
        });
      }

      // Add secrets meta-finding if present
      if (secretsResult.metaFinding) {
        allFindings.unshift({
          ...secretsResult.metaFinding,
          resolvedModel: "orchestrator",
          issueKey: "orchestrator:hardcoded-secrets:gate",
          blocking: true,
        });
      }

      // Write progress to session state (pre-verdict snapshot, skipped if no sessionDir)
      const progressPath = opts.sessionDir ? join(opts.sessionDir, "review-progress.json") : null;
      if (opts.sessionDir) mkdirSync(opts.sessionDir, { recursive: true });
      // Build lensDetails for Mac dashboard (per-lens metadata)
      const lensDetails = [
        ...lensMetadata.map((m) => ({
          lens: m.name,
          status: m.status,
          findingCount: allFindings.filter((f) => f.lens === m.name).length,
          duration: null as number | null,
          model: config.lensModels[m.name] ?? config.lensModels["default"] ?? "sonnet",
          error: null as string | null,
        })),
        ...skippedLenses.map((l) => ({
          lens: l,
          status: "skipped" as const,
          findingCount: 0,
          duration: null as number | null,
          model: null as string | null,
          error: null as string | null,
        })),
      ];

      const progressData = {
        reviewId,
        stage: opts.stage,
        activeLensCount: activeLenses.length,
        lensesCompleted,
        lensesInsufficientContext,
        lensesFailed,
        lensesSkipped: skippedLenses,
        lensDetails,
        totalFindings: allFindings.length,
        timestamp: new Date().toISOString(),
        verdict: null as string | null,
        verdictReason: null as string | null,
        isPartial: null as boolean | null,
      };
      if (progressPath) try { writeFileSync(progressPath, JSON.stringify(progressData, null, 2)); } catch { /* best-effort */ }

      // Helper: write verdict back to progress file after judge completes
      const writeVerdictToProgress = (result: SynthesisResult) => {
        progressData.verdict = result.verdict;
        progressData.verdictReason = result.verdictReason;
        progressData.isPartial = result.isPartial;
        progressData.totalFindings = result.findings.length;
        if (progressPath) try { writeFileSync(progressPath, JSON.stringify(progressData, null, 2)); } catch { /* best-effort */ }
      };

      // Build merger prompt
      const mergerPrompt = buildMergerPrompt(allFindings, lensMetadata, opts.stage);
      const mergerModel = config.lensModels.default ?? "sonnet";

      return {
        mergerPrompt,
        mergerModel,
        processMergerResult(mergerRaw: string): JudgeInput {
          const mergerResult = parseMergerResult(mergerRaw, allFindings);
          if (!mergerResult) {
            // Fallback: skip merger, pass all findings directly to judge
            const fallback = {
              findings: allFindings,
              tensions: [],
              mergeLog: [],
            };
            const judgePrompt = buildJudgePrompt(
              fallback, lensMetadata, opts.stage,
              lensesCompleted, lensesInsufficientContext, lensesFailed, skippedLenses,
            );
            return {
              judgePrompt,
              judgeModel: mergerModel,
              processJudgeResult(judgeRaw: string): SynthesisResult {
                const requiredFailed = (CORE_LENSES as readonly string[]).some((l) => lensesFailed.includes(l) || lensesInsufficientContext.includes(l));
                const parsed = parseJudgeResult(judgeRaw) ?? buildFallbackResult(
                  allFindings, lensesCompleted, lensesInsufficientContext, lensesFailed, skippedLenses,
                );
                // Override LLM-reported lens lists with orchestrator's authoritative data
                const result: SynthesisResult = {
                  ...parsed,
                  lensesCompleted,
                  lensesInsufficientContext,
                  lensesFailed,
                  lensesSkipped: skippedLenses,
                  isPartial: requiredFailed,
                };
                writeVerdictToProgress(result);
                return result;
              },
            };
          }

          const judgePrompt = buildJudgePrompt(
            mergerResult, lensMetadata, opts.stage,
            lensesCompleted, lensesInsufficientContext, lensesFailed, skippedLenses,
          );

          return {
            judgePrompt,
            judgeModel: mergerModel,
            processJudgeResult(judgeRaw: string): SynthesisResult {
              const requiredFailed = (CORE_LENSES as readonly string[]).some((l) => lensesFailed.includes(l) || lensesInsufficientContext.includes(l));
              const parsed = parseJudgeResult(judgeRaw) ?? buildFallbackResult(
                mergerResult.findings as LensFinding[],
                lensesCompleted, lensesInsufficientContext, lensesFailed, skippedLenses,
              );
              // Override LLM-reported lens lists with orchestrator's authoritative data
              const result: SynthesisResult = {
                ...parsed,
                lensesCompleted,
                lensesInsufficientContext,
                lensesFailed,
                lensesSkipped: skippedLenses,
                isPartial: requiredFailed,
              };
              writeVerdictToProgress(result);
              return result;
            },
          };
        },
      };
    },
  };
}

// ── Fallback verdict when synthesis fails ──────────────────────

function buildFallbackResult(
  findings: readonly LensFinding[],
  lensesCompleted: readonly string[],
  lensesInsufficientContext: readonly string[],
  lensesFailed: readonly string[],
  lensesSkipped: readonly string[],
): SynthesisResult {
  const requiredFailed = (CORE_LENSES as readonly string[]).some((l) =>
    lensesFailed.includes(l),
  );
  const hasCritical = findings.some(
    (f) => f.severity === "critical" && f.blocking && (f.confidence ?? 0) >= 0.8,
  );
  const hasMajorBlocking = findings.some(
    (f) => f.severity === "major" && f.blocking,
  );

  let verdict: "approve" | "revise" | "reject" = "approve";
  if (hasCritical) verdict = "reject";
  else if (hasMajorBlocking || requiredFailed) verdict = "revise";

  return {
    verdict,
    verdictReason: "Fallback verdict -- synthesis failed, computed from raw findings",
    findings: findings as LensFinding[],
    tensions: [],
    lensesCompleted,
    lensesInsufficientContext,
    lensesFailed,
    lensesSkipped,
    isPartial: requiredFailed,
  };
}

/**
 * Redact secret lines directly in an artifact string (diff or plan text).
 * Scans for file path headers in unified diff format and redacts matching line numbers.
 */
function redactArtifactSecrets(
  artifact: string,
  redactedLines: ReadonlyMap<string, readonly number[]>,
): string {
  if (redactedLines.size === 0) return artifact;
  const lines = artifact.split("\n");
  let currentFile: string | null = null;
  let currentLineNum = 0;
  const linesToRedact = new Set<number>(); // indices into the lines array

  // Pre-build Sets for O(1) lookup per line
  const redactSets = new Map<string, Set<number>>();
  for (const [file, lineNums] of redactedLines) {
    redactSets.set(file, new Set(lineNums));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Detect file header in unified diff: +++ b/path/to/file
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      currentLineNum = 0;
      continue;
    }
    // Detect hunk header: @@ -a,b +c,d @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      currentLineNum = parseInt(hunkMatch[1]!, 10) - 1;
      continue;
    }
    // Track line numbers for added/context lines
    if (!line.startsWith("-")) {
      currentLineNum++;
      if (currentFile && redactSets.get(currentFile)?.has(currentLineNum)) {
        linesToRedact.add(i);
      }
    }
  }

  return lines
    .map((line, i) => linesToRedact.has(i) ? "[REDACTED -- potential secret]" : line)
    .join("\n");
}
