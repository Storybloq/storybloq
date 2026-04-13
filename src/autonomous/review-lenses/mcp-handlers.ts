/**
 * MCP tool handlers for the multi-lens review system.
 *
 * Three tools that wrap the orchestrator's programmatic logic:
 * - claudestory_review_lenses_prepare: activation, secrets, context, cache, prompts
 * - claudestory_review_lenses_synthesize: validation, blocking, origin/scope tagging
 * - claudestory_review_lenses_judge: verdict calibration, convergence
 *
 * The agent owns LLM orchestration (spawning subagents). These tools own the
 * programmatic logic that should not be reimplemented in prose instructions.
 *
 * T-189
 */

import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { prepareLensReview } from "./orchestrator.js";
import { validateFindings } from "./schema-validator.js";
import { generateIssueKey } from "./issue-key.js";
import { computeBlocking } from "./blocking-policy.js";
import { parseDiffScope, classifyOrigin } from "./diff-scope.js";
import { buildMergerPrompt, parseMergerResult } from "./merger.js";
import { buildJudgePrompt } from "./judge.js";
import {
  loadSnapshot,
  verifyLensFindingPreloaded,
  SnapshotIntegrityError,
} from "./verification.js";
import type { SnapshotContext, VerifyFail } from "./verification.js";
import { appendRejection, buildRejectionEntry } from "./verification-log.js";
import type {
  BlockingPolicy,
  LensFinding,
  LensName,
  MergerResult,
  ReviewStage,
} from "./types.js";
import {
  CORE_LENSES,
  DEFAULT_BLOCKING_POLICY,
  LENS_MAX_SEVERITY,
} from "./types.js";

const MAX_PROMPT_SIZE = 10_000;

// ── Prepare ───────────────────────────────────────────────────

export interface PrepareInput {
  readonly stage: ReviewStage;
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly ticketDescription?: string;
  readonly reviewRound?: number;
  readonly priorDeferrals?: readonly string[];
  readonly projectRoot: string;
  readonly sessionDir?: string;
}

export interface PrepareOutput {
  readonly lensPrompts: readonly {
    readonly lens: string;
    readonly model: string;
    readonly prompt: string;
    readonly promptRef: string;
    readonly promptTruncated: boolean;
    readonly cached: boolean;
    readonly cachedFindings?: readonly LensFinding[];
  }[];
  readonly artifact: string;
  readonly metadata: {
    readonly activeLenses: readonly string[];
    readonly skippedLenses: readonly string[];
    readonly secretsGateActive: boolean;
    readonly reviewRound: number;
    readonly reviewId: string;
  };
}

export function handlePrepare(input: PrepareInput): PrepareOutput {
  // Guard: CODE_REVIEW with no changed files produces no lenses
  if (input.stage === "CODE_REVIEW" && input.changedFiles.length === 0) {
    return {
      lensPrompts: [],
      artifact: input.diff,
      metadata: {
        activeLenses: [],
        skippedLenses: [],
        secretsGateActive: false,
        reviewRound: input.reviewRound ?? 1,
        reviewId: `lens-empty-${Date.now().toString(36)}`,
      },
    };
  }

  const sessionDir = input.sessionDir;
  const knownFP = (input.priorDeferrals ?? []).join("\n");

  const prepared = prepareLensReview({
    stage: input.stage,
    diff: input.diff,
    changedFiles: input.changedFiles,
    ticketDescription: input.ticketDescription ?? "Manual review",
    projectRoot: input.projectRoot,
    sessionDir,
    knownFalsePositives: knownFP || undefined,
  });

  const lensPrompts = [];

  for (const lens of prepared.activeLenses) {
    const cached = prepared.cachedFindings.get(lens);
    const subagent = prepared.subagentPrompts.get(lens);

    const ref = `references/lens-${lens}.md`;
    if (cached) {
      lensPrompts.push({
        lens,
        model: subagent?.model ?? "sonnet",
        prompt: "",
        promptRef: ref,
        promptTruncated: false,
        cached: true,
        cachedFindings: cached,
      });
    } else if (subagent) {
      const truncated = subagent.prompt.length > MAX_PROMPT_SIZE;
      lensPrompts.push({
        lens,
        model: subagent.model,
        prompt: truncated ? "" : subagent.prompt,
        promptRef: ref,
        promptTruncated: truncated,
        cached: false,
      });
    }
  }

  return {
    lensPrompts,
    artifact: input.diff,
    metadata: {
      activeLenses: [...prepared.activeLenses],
      skippedLenses: [...prepared.skippedLenses],
      secretsGateActive: prepared.secretsGateActive,
      reviewRound: input.reviewRound ?? 1,
      reviewId: prepared.reviewId,
    },
  };
}

// ── Shared helpers ────────────────────────────────────────────

function buildLensMetadata(
  completed: readonly string[],
  failed: readonly string[],
  insufficientContext: readonly string[],
): { name: string; maxSeverity: "critical" | "major"; isRequired: boolean; status: "complete" | "failed" | "insufficient-context" }[] {
  const all = new Set([...completed, ...failed, ...insufficientContext]);
  return [...all].map((l) => ({
    name: l,
    maxSeverity: LENS_MAX_SEVERITY[l as LensName] ?? ("major" as const),
    isRequired: (CORE_LENSES as readonly string[]).includes(l),
    status: completed.includes(l)
      ? ("complete" as const)
      : failed.includes(l)
        ? ("failed" as const)
        : ("insufficient-context" as const),
  }));
}

// ── Verification gate helper (ISS-398) ──────────────────────

interface VerificationGateInput {
  readonly projectRoot?: string;
  readonly sessionId?: string;
  readonly reviewId: string;
  readonly sessionDir?: string;
  readonly stage: ReviewStage;
}

interface VerificationGateResult {
  verifiedFindings: LensFinding[];
  verifiedForFiling: LensFinding[];
  rejectedCount: number;
  snapshotIntegrityFailure: boolean;
  verificationSkipped: boolean;
  logWriteFailures: number;
  verificationRuntimeErrors: number;
}

function runVerificationGate(
  allFindings: LensFinding[],
  opts: VerificationGateInput,
): VerificationGateResult {
  if (!opts.projectRoot || !opts.sessionId) {
    return {
      verifiedFindings: allFindings,
      verifiedForFiling: [],
      rejectedCount: 0,
      snapshotIntegrityFailure: false,
      verificationSkipped: true,
      logWriteFailures: 0,
      verificationRuntimeErrors: 0,
    };
  }

  const ctx: SnapshotContext = {
    projectRoot: opts.projectRoot,
    sessionId: opts.sessionId,
    reviewId: opts.reviewId,
  };

  const verified: LensFinding[] = [];
  const strictlyVerified: LensFinding[] = [];
  const rejected: Array<{ finding: LensFinding; result: VerifyFail }> = [];
  let snapshotIntegrityFailure = false;
  let verificationRuntimeErrors = 0;
  let logWriteFailures = 0;

  let snapshot;
  try {
    snapshot = loadSnapshot(ctx);
  } catch (err) {
    if (err instanceof SnapshotIntegrityError) {
      snapshotIntegrityFailure = true;
    } else {
      throw err;
    }
  }

  if (!snapshotIntegrityFailure) {
    for (const finding of allFindings) {
      try {
        const result = verifyLensFindingPreloaded(finding, snapshot!);
        if (result.pass) {
          verified.push(finding);
          strictlyVerified.push(finding);
        } else {
          rejected.push({ finding, result });
        }
      } catch (err) {
        if (err instanceof SnapshotIntegrityError) {
          snapshotIntegrityFailure = true;
          break;
        }
        verified.push(finding);
        verificationRuntimeErrors++;
      }
    }
  }

  if (snapshotIntegrityFailure) {
    return {
      verifiedFindings: allFindings,
      verifiedForFiling: [],
      rejectedCount: 0,
      snapshotIntegrityFailure: true,
      verificationSkipped: false,
      logWriteFailures: 0,
      verificationRuntimeErrors,
    };
  }

  if (rejected.length > 0 && opts.sessionDir) {
    const stageLabel = opts.stage === "CODE_REVIEW" ? "code-review" : "plan-review";
    for (const { finding, result } of rejected) {
      try {
        const entry = buildRejectionEntry(finding, result, stageLabel);
        if (!appendRejection(opts.sessionDir, entry).ok) {
          logWriteFailures++;
        }
      } catch {
        logWriteFailures++;
      }
    }
  }

  return {
    verifiedFindings: verified,
    verifiedForFiling: strictlyVerified,
    rejectedCount: rejected.length,
    snapshotIntegrityFailure: false,
    verificationSkipped: false,
    logWriteFailures,
    verificationRuntimeErrors,
  };
}

// ── Synthesize ────────────────────────────────────────────────

export interface SynthesizeInput {
  readonly stage?: ReviewStage;
  readonly lensResults: readonly {
    readonly lens: string;
    readonly status: string;
    readonly findings: readonly unknown[];
  }[];
  readonly metadata: {
    readonly activeLenses: readonly string[];
    readonly skippedLenses: readonly string[];
    readonly reviewRound: number;
    readonly reviewId: string;
  };
  readonly sessionDir?: string;
  readonly sessionId?: string;
  readonly projectRoot?: string;
  // T-192: Origin classification inputs
  readonly diff?: string;
  readonly changedFiles?: readonly string[];
}

export interface SynthesizeOutput {
  readonly mergerPrompt: string;
  readonly validatedFindings: readonly LensFinding[];
  readonly lensesCompleted: readonly string[];
  readonly lensesFailed: readonly string[];
  readonly lensesInsufficientContext: readonly string[];
  readonly droppedFindings: number;
  readonly droppedDetails: readonly string[];
  // T-192: Pre-existing findings identified by origin classification
  readonly preExistingFindings: readonly LensFinding[];
  readonly preExistingCount: number;
  // T-257: Verification gate outputs
  readonly verificationCounters: {
    readonly proposed: number;
    readonly verified: number;
    readonly rejected: number;
  };
  readonly snapshotIntegrityFailure: boolean;
  readonly verificationSkipped: boolean;
  readonly logWriteFailures: number;
  readonly verificationRuntimeErrors: number;
  readonly telemetryWriteFailed: boolean;
}

export function handleSynthesize(input: SynthesizeInput): SynthesizeOutput {
  // Load project-level blocking policy if available
  let policy: BlockingPolicy = DEFAULT_BLOCKING_POLICY;
  let confidenceFloor = 0.6;
  let findingBudget = 10;
  if (input.projectRoot) {
    try {
      const configPath = join(input.projectRoot, ".story", "config.json");
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const overrides = raw?.recipeOverrides;
      if (overrides?.blockingPolicy) {
        policy = { ...DEFAULT_BLOCKING_POLICY, ...overrides.blockingPolicy };
      }
      if (overrides?.stages?.CODE_REVIEW?.confidenceFloor != null) {
        confidenceFloor = overrides.stages.CODE_REVIEW.confidenceFloor;
      }
      if (overrides?.stages?.CODE_REVIEW?.findingBudget != null) {
        findingBudget = overrides.stages.CODE_REVIEW.findingBudget;
      }
    } catch { /* no config or parse error -- use defaults */ }
  }
  const stage: ReviewStage = input.stage ?? "CODE_REVIEW";
  // T-192: Pre-compute diff scope for origin classification (null if inputs missing or PLAN_REVIEW)
  const diffScope = input.diff && input.changedFiles && stage === "CODE_REVIEW"
    ? parseDiffScope(input.diff) : null;
  const lensesCompleted: string[] = [];
  const lensesFailed: string[] = [];
  const lensesInsufficientContext: string[] = [];
  const allFindings: LensFinding[] = [];
  let droppedTotal = 0;
  const dropReasons: string[] = [];

  for (const lr of input.lensResults) {
    if (lr.status === "complete") {
      lensesCompleted.push(lr.lens);
      const { valid, invalid } = validateFindings(lr.findings as unknown[], lr.lens);
      if (invalid.length > 0) {
        droppedTotal += invalid.length;
        for (const inv of invalid.slice(0, 3)) {
          dropReasons.push(`${lr.lens}: ${inv.reason}`);
        }
      }
      // Apply confidence floor then per-lens finding budget (tracked separately)
      const aboveFloor = valid.filter((f) => f.confidence >= confidenceFloor);
      const belowFloor = valid.length - aboveFloor.length;
      if (belowFloor > 0) {
        droppedTotal += belowFloor;
        dropReasons.push(`${lr.lens}: ${belowFloor} below confidence floor ${confidenceFloor}`);
      }
      const filtered = aboveFloor.slice(0, findingBudget);
      const budgetExceeded = aboveFloor.length - filtered.length;
      if (budgetExceeded > 0) {
        droppedTotal += budgetExceeded;
        dropReasons.push(`${lr.lens}: ${budgetExceeded} exceeded finding budget ${findingBudget}`);
      }
      for (const f of filtered) {
        const enriched: LensFinding = {
          ...f,
          issueKey: generateIssueKey(f),
          blocking: computeBlocking(f, stage, policy),
          origin: diffScope ? classifyOrigin(f, diffScope, stage) : undefined,
        };
        allFindings.push(enriched);
      }
    } else if (lr.status === "insufficient-context") {
      lensesInsufficientContext.push(lr.lens);
    } else {
      lensesFailed.push(lr.lens);
    }
  }

  // Check for lenses that were active but not in results (failed/timed out)
  for (const lens of input.metadata.activeLenses) {
    if (
      !lensesCompleted.includes(lens) &&
      !lensesInsufficientContext.includes(lens) &&
      !lensesFailed.includes(lens)
    ) {
      lensesFailed.push(lens);
    }
  }

  // ── T-257: Verification gate (ISS-398: extracted helper) ────────
  const gate = runVerificationGate(allFindings, {
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    reviewId: input.metadata.reviewId,
    sessionDir: input.sessionDir,
    stage,
  });
  const {
    verifiedFindings,
    verifiedForFiling,
    rejectedCount,
    snapshotIntegrityFailure,
    verificationSkipped,
    logWriteFailures,
    verificationRuntimeErrors,
  } = gate;

  // T-192: Collect pre-existing findings from strictly-verified set only
  const preExistingFindings = verifiedForFiling.filter(
    f => f.origin === "pre-existing" && f.severity !== "suggestion",
  );

  const lensMetadata = buildLensMetadata(lensesCompleted, lensesFailed, lensesInsufficientContext);

  const mergerPrompt = buildMergerPrompt(verifiedFindings, lensMetadata, stage);

  // T-257: Verification counters
  const verificationCounters = {
    proposed: allFindings.length,
    verified: (snapshotIntegrityFailure || verificationSkipped)
      ? 0
      : verifiedForFiling.length,
    rejected: rejectedCount,
  };

  // T-257: Write telemetry artifact (best-effort)
  let telemetryWriteFailed = false;
  if (input.sessionDir) {
    try {
      const telemetryEntry = {
        reviewId: input.metadata.reviewId,
        proposed: verificationCounters.proposed,
        verified: verificationCounters.verified,
        rejected: verificationCounters.rejected,
        snapshotIntegrityFailure,
        verificationSkipped,
        verificationRuntimeErrors,
        logWriteFailures,
        timestamp: new Date().toISOString(),
      };
      appendFileSync(
        join(input.sessionDir, "verification-telemetry.jsonl"),
        JSON.stringify(telemetryEntry) + "\n",
      );
    } catch {
      telemetryWriteFailed = true;
    }
  }

  return {
    mergerPrompt,
    validatedFindings: verifiedFindings,
    lensesCompleted,
    lensesFailed,
    lensesInsufficientContext,
    droppedFindings: droppedTotal,
    droppedDetails: dropReasons.slice(0, 5),
    preExistingFindings,
    preExistingCount: preExistingFindings.length,
    verificationCounters,
    snapshotIntegrityFailure,
    verificationSkipped,
    logWriteFailures,
    verificationRuntimeErrors,
    telemetryWriteFailed,
  };
}

// ── Judge ─────────────────────────────────────────────────────

export interface JudgeInput {
  readonly mergerResultRaw: string;
  readonly stage?: ReviewStage;
  readonly convergenceHistory?: readonly {
    readonly round: number;
    readonly verdict: string;
    readonly blocking: number;
    readonly important: number;
    readonly newCode: string;
  }[];
  readonly lensesCompleted: readonly string[];
  readonly lensesFailed: readonly string[];
  readonly lensesInsufficientContext: readonly string[];
  readonly lensesSkipped: readonly string[];
  // CDX-13: pre-merger source set for source-authoritative marker restoration
  // inside `parseMergerResult`. Callers pass the `validatedFindings` field
  // returned from `handleSynthesize`.
  readonly sourceFindings?: readonly LensFinding[];
}

export interface JudgeOutput {
  readonly judgePrompt: string;
  readonly isPartial: boolean;
  readonly mergerResult: ReturnType<typeof parseMergerResult>;
}

export function handleJudge(input: JudgeInput): JudgeOutput {
  const mergerResult = parseMergerResult(
    input.mergerResultRaw,
    input.sourceFindings ?? [],
  );
  // isPartial: true if any core lens failed OR returned insufficient-context
  const isPartial = CORE_LENSES.some((l) =>
    input.lensesFailed.includes(l) || input.lensesInsufficientContext.includes(l),
  );

  const lensMetadata = buildLensMetadata(
    [...input.lensesCompleted],
    [...input.lensesFailed],
    [...input.lensesInsufficientContext],
  );

  const stage: ReviewStage = input.stage ?? "CODE_REVIEW";
  const fallbackMergerResult: MergerResult = { findings: [], tensions: [], mergeLog: [] };

  let judgePrompt = buildJudgePrompt(
    mergerResult ?? fallbackMergerResult,
    lensMetadata,
    stage,
    [...input.lensesCompleted],
    [...input.lensesInsufficientContext],
    [...input.lensesFailed],
    [...input.lensesSkipped],
  );

  // Inject convergence history if provided
  if (input.convergenceHistory && input.convergenceHistory.length > 0) {
    // Sanitize user-controlled strings to prevent prompt injection via markdown table
    const sanitize = (s: string) => s.replace(/[|\n\r#>`*_~\[\]]/g, " ").slice(0, 50);
    const historyTable = input.convergenceHistory
      .map((h) => `| R${h.round} | ${sanitize(h.verdict)} | ${h.blocking} | ${h.important} | ${sanitize(h.newCode)} |`)
      .join("\n");
    judgePrompt += `\n\n## Convergence History\n\n| Round | Verdict | Blocking | Important | New Code |\n|-------|---------|----------|-----------|----------|\n${historyTable}\n\nUse this history to determine recommendNextRound. Stop reviewing when: blocking = 0 for 2 consecutive rounds AND important count stable or decreasing AND no regressions.`;
  }

  // Inject partial review warning
  if (isPartial) {
    judgePrompt += `\n\nCRITICAL: This is a PARTIAL review -- required lens(es) failed: ${CORE_LENSES.filter((l) => input.lensesFailed.includes(l)).join(", ")}. You MUST NOT output "approve". Maximum verdict is "revise".`;
  }

  return { judgePrompt, isPartial, mergerResult: mergerResult ?? fallbackMergerResult };
}
