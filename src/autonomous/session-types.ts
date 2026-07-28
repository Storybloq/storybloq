import { realpathSync } from "node:fs";
import { z } from "zod";
import { CLIENT_TASK_ID_PATTERN, type OwnerTask } from "./client-profile.js";
import { CROCKFORD_CLASS } from "../models/types.js";
import type { ClaimEpoch } from "./claim-reconciliation.js";

/** Combined ticket + issue ID regex for targetWork validation (sequential + canonical). ISS-703: canonical char class derived from CROCKFORD_CLASS. */
export const TARGET_WORK_ID_REGEX = new RegExp(`^(T-\\d+[a-z]?|ISS-\\d+|t-${CROCKFORD_CLASS}{16}|i-${CROCKFORD_CLASS}{16})$`);

/**
 * ISS-556: Canonical dispositions for lens-review findings.
 * Used at the MCP input boundary AND in the persisted SessionStateSchema so
 * the write and read paths enforce the same vocabulary. Adding a value here
 * automatically widens both sides — no second file to update.
 */
export const LENS_FINDING_DISPOSITIONS = ["open", "addressed", "contested", "deferred"] as const;
export type LensFindingDisposition = typeof LENS_FINDING_DISPOSITIONS[number];

/**
 * ISS-718: Canonical review verdicts accepted by the plan-review and
 * code-review stage guards. Centralized so the two stages share one
 * vocabulary instead of duplicating bare string literals.
 *
 * NOTE: this is intentionally NOT applied to the persisted verdict fields in
 * SessionStateSchema. readSessionResilient only recovers invalid-enum values at
 * lensReviewHistory[*].disposition, so narrowing the stored verdict to an enum
 * would wedge resume on any legacy state.json carrying an out-of-vocabulary
 * verdict. The deterministic lens judge (lens-harness/judge.ts) also
 * intentionally emits a narrower set (no request_changes), so it is not
 * unified here.
 */
export const REVIEW_VERDICTS = ["approve", "revise", "request_changes", "reject"] as const;
export type ReviewVerdict = typeof REVIEW_VERDICTS[number];

/**
 * ISS-725: single source of truth for the human-readable verdict enumeration
 * used in retry-instruction prose ('"approve", "revise", "request_changes", or
 * "reject"'). Derived from REVIEW_VERDICTS so the two stage guards never drift
 * from the canonical list.
 */
export const REVIEW_VERDICTS_PROSE: string = (() => {
  const quoted = REVIEW_VERDICTS.map((v) => `"${v}"`);
  return quoted.length <= 1
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
})();

/**
 * ISS-726: canonicalize a finding's severity for the case-sensitive downstream
 * comparisons. The report.findings[] schema keeps severity as a lenient
 * z.string (so non-canonical values are accepted rather than rejected), but two
 * safety checks match it exactly: the suggestion-exemption in the deferral
 * filter (severity !== "suggestion") and the critical/major contradiction guard
 * in the review stages. Without normalization a miscased "Suggestion" would
 * bypass the exemption (auto-filing an issue) and a miscased "Critical"/"Major"
 * would silently skip the guard (letting an approve verdict through with an
 * effectively-critical finding). Normalize at the consumption point so the fix
 * holds regardless of how the report was constructed.
 *
 * ISS-823 (pen ruling R6): the @storybloq/lenses severity vocabulary tops out
 * at "blocking" instead of "critical". This function is the artifact-write
 * boundary for reported findings (per-severity counts, verdict artifact,
 * lens history), so "blocking" is projected onto the legacy display value
 * "critical" here.
 */
export function normalizeSeverity(severity: string): string {
  const s = severity.trim().toLowerCase();
  return s === "blocking" ? "critical" : s;
}

// ---------------------------------------------------------------------------
// Workflow states from N-005 v5.1 state machine
// ---------------------------------------------------------------------------

export type WorkflowState =
  | "INIT"
  | "LOAD_CONTEXT"
  | "PICK_TICKET"
  | "PLAN"
  | "PLAN_REVIEW"
  | "IMPLEMENT"
  | "WRITE_TESTS"
  | "TEST"
  | "CODE_REVIEW"
  | "BUILD"
  | "VERIFY"
  | "FINALIZE"
  | "COMPACT"
  | "HANDOVER"
  | "COMPLETE"
  | "LESSON_CAPTURE"
  | "ISSUE_FIX"
  | "ISSUE_SWEEP"
  | "SESSION_END";

// ---------------------------------------------------------------------------
// Claude status derivation — exhaustive mapping
// ---------------------------------------------------------------------------

export type ClaudeStatus = "working" | "idle" | "waiting" | "unknown";

const WORKING_STATES: ReadonlySet<string> = new Set([
  "PLAN",
  "PLAN_REVIEW",
  "IMPLEMENT",
  "WRITE_TESTS",
  "TEST",
  "CODE_REVIEW",
  "BUILD",
  "VERIFY",
  "FINALIZE",
  "COMPACT",
  "LESSON_CAPTURE",
  "ISSUE_FIX",
  "ISSUE_SWEEP",
]);

const IDLE_STATES: ReadonlySet<string> = new Set([
  "INIT",
  "LOAD_CONTEXT",
  "PICK_TICKET",
  "HANDOVER",
  "COMPLETE",
  "SESSION_END",
]);

/**
 * Derives Claude's operational status from workflow state.
 * Pure function, no I/O.
 */
export function deriveClaudeStatus(
  state: string | undefined,
  waitingForRetry?: boolean,
): ClaudeStatus {
  if (waitingForRetry) return "waiting";
  if (!state) return "idle";
  if (WORKING_STATES.has(state)) return "working";
  if (IDLE_STATES.has(state)) return "idle";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Workspace ID — shared between hook-status (reader) and guide (writer)
// ---------------------------------------------------------------------------

/**
 * Derives a stable workspace ID from the project root path.
 * Uses realpathSync to resolve symlinks — deterministic across sessions.
 * T-119 may extend to include branch/worktree info.
 *
 * @throws {Error} If projectRoot does not exist or is not readable (ENOENT, EACCES).
 */
export function deriveWorkspaceId(projectRoot: string): string {
  return realpathSync(projectRoot);
}

// ---------------------------------------------------------------------------
// Shared inline types (ISS-489: extract to avoid duplication)
// ---------------------------------------------------------------------------

/** Shape of currentIssue in both SessionState and StatusPayloadActive. */
export interface CurrentIssueRef {
  readonly id: string;
  readonly displayId?: string;
  readonly title: string;
  readonly severity: string;
}

// ---------------------------------------------------------------------------
// Session state — minimal shape that hook-status reads from state.json
// ---------------------------------------------------------------------------

export interface SessionState {
  readonly sessionId: string;
  readonly state: WorkflowState | string;
  readonly waitingForRetry?: boolean;
  readonly lastGuideCall?: string;
  readonly ticket?: {
    readonly id: string;
    readonly displayId?: string;
    readonly title: string;
    readonly risk?: string;
  };
  readonly currentIssue?: CurrentIssueRef | null;
  /**
   * T-442: proof of what this session actually claimed, minted at PLAN from the
   * values written to the ticket. Reconciliation compares the ledger against
   * this on every later guide call; absent means a pre-T-442 session, which
   * reconciles to a no-op rather than to a conflict.
   */
  readonly claimEpoch?: ClaimEpoch | null;
  readonly completedTickets?: ReadonlyArray<{ readonly id: string; readonly displayId?: string }>;
  readonly resolvedIssues?: ReadonlyArray<string>;
  readonly resolvedIssueDisplayIds?: Readonly<Record<string, string>>;
  readonly targetWorkDisplayIds?: Readonly<Record<string, string>>;
  readonly contextPressure?: {
    readonly level: string;
  };
  readonly git?: {
    readonly branch?: string;
  };
  readonly lease?: {
    readonly workspaceId?: string;
    readonly expiresAt: string;
  };
  // T-260: Liveness infrastructure
  readonly sidecarPid?: number | null;
  // T-259: Telemetry substrate fields
  readonly substage?: string | null;
  readonly substageStartedAt?: string | null;
  readonly pendingInstruction?: string | null;
  readonly pendingInstructionSetAt?: string | null;
  readonly claudeCodeSessionId?: string | null;
  readonly ownerTask?: OwnerTask | null;
  readonly compactPending?: boolean;
  readonly binaryFingerprint?: { readonly mtime: string; readonly sha256: string } | null;
  readonly runningSubprocesses?: ReadonlyArray<{
    readonly pid: number;
    readonly category: string;
    readonly startedAt: string;
    readonly stage: string;
  }> | null;
  readonly lastReviewVerdict?: {
    readonly stage: string;
    readonly round: number;
    readonly verdict: string;
    readonly findingCount: number;
    readonly criticalCount: number;
    readonly unresolvedCriticalCount?: number;
    readonly majorCount: number;
    readonly suggestionCount: number;
    readonly durationMs: number;
    readonly summary: string;
  } | null;
  readonly recentDeferrals?: {
    readonly total: number;
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
  } | null;
  readonly alive?: boolean | null;
  readonly lastMcpCall?: string | null;
  readonly healthState?: string | null;
  // T-271: Queue progress
  readonly targetWork?: ReadonlyArray<string> | null;
  // T-277: Session elapsed-time timer
  readonly startedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Status payload — written to .story/status.json by hook-status
// ---------------------------------------------------------------------------

export const CURRENT_STATUS_SCHEMA_VERSION = 1 as const;

export interface StatusPayloadActive {
  readonly schemaVersion: typeof CURRENT_STATUS_SCHEMA_VERSION;
  readonly sessionActive: true;
  readonly sessionId: string;
  readonly state: string;
  readonly ticket: string | null;
  readonly ticketTitle: string | null;
  readonly risk: string | null;
  readonly claudeStatus: ClaudeStatus;
  readonly observedAt: string;
  readonly startedAt?: string | null;
  readonly lastGuideCall: string | null;
  readonly completedThisSession: readonly string[];
  readonly contextPressure: string;
  readonly branch: string | null;
  readonly source: "hook";
  // T-259: Telemetry substrate fields
  readonly substage: string | null;
  readonly substageStartedAt: string | null;
  readonly pendingInstruction: string | null;
  readonly pendingInstructionSetAt: string | null;
  readonly claudeCodeSessionId: string | null;
  readonly ownerTask: OwnerTask | null;
  readonly leaseExpiresAt: string | null;
  readonly leaseState: "live" | "expired" | "missing" | "invalid";
  readonly compactPending: boolean;
  readonly binaryFingerprint: { readonly mtime: string; readonly sha256: string } | null;
  readonly runningSubprocesses: ReadonlyArray<{
    readonly pid: number;
    readonly category: string;
    readonly startedAt: string;
    readonly stage: string;
  }> | null;
  readonly lastReviewVerdict: {
    readonly stage: string;
    readonly round: number;
    readonly verdict: string;
    readonly findingCount: number;
    readonly criticalCount: number;
    readonly unresolvedCriticalCount?: number;
    readonly majorCount: number;
    readonly suggestionCount: number;
    readonly durationMs: number;
    readonly summary: string;
  } | null;
  readonly recentDeferrals: {
    readonly total: number;
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
  } | null;
  readonly alive: boolean | null;
  readonly lastMcpCall: string | null;
  readonly healthState: string | null;
  // T-271: Queue progress
  readonly targetWork: readonly string[] | null;
  readonly currentIssue: CurrentIssueRef | null;
  readonly lastWrittenBy?: "hook" | "guide";
}

export interface StatusPayloadInactive {
  readonly schemaVersion: typeof CURRENT_STATUS_SCHEMA_VERSION;
  readonly sessionActive: false;
  readonly source: "hook";
  readonly lastWrittenBy?: "hook" | "guide";
}

export type StatusPayload = StatusPayloadActive | StatusPayloadInactive;

// ---------------------------------------------------------------------------
// Workflow state enum values (for Zod schema)
// ---------------------------------------------------------------------------

export const WORKFLOW_STATES = [
  "INIT", "LOAD_CONTEXT", "PICK_TICKET",
  "PLAN", "PLAN_REVIEW",
  "IMPLEMENT", "WRITE_TESTS", "TEST", "CODE_REVIEW", "BUILD", "VERIFY",
  "FINALIZE", "COMPACT",
  "HANDOVER", "COMPLETE", "LESSON_CAPTURE", "ISSUE_FIX", "ISSUE_SWEEP", "SESSION_END",
] as const;

export const WorkflowStateSchema = z.enum(WORKFLOW_STATES);

// ---------------------------------------------------------------------------
// Session schema version
// ---------------------------------------------------------------------------

export const CURRENT_SESSION_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Finalize checkpoint
// ---------------------------------------------------------------------------

export type FinalizeCheckpoint = "staged" | "staged_override" | "precommit_passed" | "committed";

// ---------------------------------------------------------------------------
// Review record (stored in state.json reviews arrays)
// ---------------------------------------------------------------------------

export interface ReviewRecord {
  readonly round: number;
  readonly reviewer: string;
  readonly verdict: string;
  readonly findingCount: number;
  readonly criticalCount: number;
  readonly unresolvedCriticalCount?: number;
  readonly majorCount: number;
  readonly suggestionCount: number;
  readonly codexSessionId?: string;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Finding (from Claude's review report)
// ---------------------------------------------------------------------------

export interface Finding {
  // ISS-717: optional -- a synthesized lens-shaped finding has no id, and the
  // MCP report schema no longer requires one (no consumer keys off it; review
  // verdict content hashing stays stable whether id is present or absent).
  readonly id?: string;
  readonly severity: "critical" | "major" | "minor" | "suggestion";
  readonly category: string;
  readonly description: string;
  readonly disposition: "open" | "addressed" | "contested" | "deferred";
  readonly recommendedNextState?: "PLAN" | "IMPLEMENT";
}

// ---------------------------------------------------------------------------
// Git baseline (captured at INIT)
// ---------------------------------------------------------------------------

export interface GitBaseline {
  readonly head: string;
  readonly branch: string | null;
  readonly mergeBase: string | null;
  readonly porcelain: readonly string[];
  readonly dirtyTrackedFiles: Readonly<Record<string, { blobHash: string }>>;
  readonly untrackedPaths: readonly string[];
}

// ---------------------------------------------------------------------------
// Pending project mutation (cross-domain consistency)
// ---------------------------------------------------------------------------

export type PendingProjectMutation =
  | { type: "ticket_update"; target: string; field: string; value: string; transitionId: string }
  | { type: "ticket_recovery_write"; target: string; transitionId: string }
  | { type: "ticket_recovery_clear"; target: string; transitionId: string }
  | { type: "handover_create"; filename: string | null; transitionId: string }
  | { type: "issue_create"; expectedId: string; transitionId: string }
  | { type: "issue_update"; target: string; field: string; value: string; transitionId: string }
  | { type: "snapshot_save"; filename: string | null; transitionId: string };

// ---------------------------------------------------------------------------
// Event entry (append-only JSONL in events.log)
// ---------------------------------------------------------------------------

export interface EventEntry {
  readonly rev: number;
  readonly type: string;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Full session state (authoritative, written to state.json)
// ---------------------------------------------------------------------------

export const SessionStateSchema = z.object({
  schemaVersion: z.literal(CURRENT_SESSION_SCHEMA_VERSION),
  sessionId: z.string().uuid(),
  recipe: z.string(),
  state: z.string(),
  previousState: z.string().optional(),
  revision: z.number().int().min(0),
  status: z.enum(["active", "completed", "superseded"]).default("active"),
  mode: z.enum(["auto", "review", "plan", "guided"]).default("auto"),

  // Ticket in progress
  ticket: z.object({
    id: z.string(),
    displayId: z.string().optional(),
    title: z.string(),
    risk: z.string().optional(),
    realizedRisk: z.string().optional(),
    claimed: z.boolean().default(false),
    lastPlanHash: z.string().optional(),
  }).optional(),

  // Review tracking
  reviews: z.object({
    plan: z.array(z.object({
      round: z.number(),
      reviewer: z.string(),
      verdict: z.string(),
      findingCount: z.number(),
      criticalCount: z.number(),
      unresolvedCriticalCount: z.number().optional(),
      majorCount: z.number(),
      suggestionCount: z.number(),
      codexSessionId: z.string().optional(),
      timestamp: z.string(),
    })).default([]),
    code: z.array(z.object({
      round: z.number(),
      reviewer: z.string(),
      verdict: z.string(),
      findingCount: z.number(),
      criticalCount: z.number(),
      unresolvedCriticalCount: z.number().optional(),
      majorCount: z.number(),
      suggestionCount: z.number(),
      codexSessionId: z.string().optional(),
      timestamp: z.string(),
    })).default([]),
  }).default({ plan: [], code: [] }),

  // T-153: Current issue being fixed (null when working on a ticket)
  currentIssue: z.object({
    id: z.string(),
    displayId: z.string().optional(),
    title: z.string(),
    severity: z.string(),
  }).nullable().default(null),

  // T-153: Issues resolved this session
  resolvedIssues: z.array(z.string()).default([]),

  // T-382: Cached display IDs for resolved issues (canonical -> display)
  resolvedIssueDisplayIds: z.record(z.string()).default({}),

  // Completed tickets this session
  completedTickets: z.array(z.object({
    id: z.string(),
    displayId: z.string().optional(),
    title: z.string().optional(),
    commitHash: z.string().optional(),
    risk: z.string().optional(),
    realizedRisk: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
  })).default([]),

  // T-187: Per-ticket timing -- set when ticket is picked, cleared on commit
  ticketStartedAt: z.string().nullable().default(null),

  // FINALIZE checkpoint
  finalizeCheckpoint: z.enum(["staged", "staged_override", "precommit_passed", "committed"]).nullable().default(null),

  // Git state
  git: z.object({
    branch: z.string().nullable().default(null),
    initHead: z.string().optional(),
    mergeBase: z.string().nullable().default(null),
    expectedHead: z.string().optional(),
    baseline: z.object({
      porcelain: z.array(z.string()).default([]),
      dirtyTrackedFiles: z.record(z.object({ blobHash: z.string() })).default({}),
      untrackedPaths: z.array(z.string()).default([]),
    }).optional(),
    // T-125: Auto-stash tracking for dirty-file handling
    autoStash: z.object({
      ref: z.string(),
      stashedAt: z.string(),
    }).nullable().default(null),
  }).default({ branch: null, mergeBase: null }),

  // Lease
  lease: z.object({
    workspaceId: z.string().optional(),
    lastHeartbeat: z.string(),
    expiresAt: z.string(),
  }),

  ownerTask: z.object({
    client: z.enum(["claude", "codex"]),
    id: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN),
    boundAt: z.string(),
  }).nullish(),

  // Context pressure
  contextPressure: z.object({
    level: z.string().default("low"),
    guideCallCount: z.number().default(0),
    ticketsCompleted: z.number().default(0),
    compactionCount: z.number().default(0),
    eventsLogBytes: z.number().default(0),
    workItemsAtLastCompaction: z.number().int().min(0).optional(),
    eventsLogBytesAtLastCompaction: z.number().int().min(0).optional(),
  }).default({ level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 }),

  // Persist why COMPLETE must rotate instead of selecting more work. This
  // survives optional post-complete stages and crash recovery.
  contextRotation: z.object({
    level: z.enum(["low", "medium", "high", "critical"]),
    compactThreshold: z.string(),
    ticketsDone: z.number().int().min(0),
    issuesDone: z.number().int().min(0),
    remainingTargets: z.array(z.string()).max(150).default([]),
  }).nullable().default(null),

  // Pending project mutation (for crash recovery)
  pendingProjectMutation: z.any().nullable().default(null),

  // COMPACT resume
  resumeFromRevision: z.number().nullable().default(null),
  preCompactState: z.string().nullable().default(null),
  compactPending: z.boolean().default(false),
  compactPreparedAt: z.string().nullable().default(null),
  compactObservedAt: z.string().nullable().default(null),
  resumeBlocked: z.boolean().default(false),

  // T-424: Usage-limit interruption. Rides the COMPACT lane; interruptionKind
  // discriminates the two park reasons (absent = "compact" for back-compat).
  // limitPermissionMode is the AUTHORITY for wake posture (written only under
  // withSessionLock from the StopFailure hook payload, enum-validated) -- the
  // global ledger is a work queue, never a posture source.
  interruptionKind: z.enum(["compact", "limit"]).nullish(),
  limitStopPending: z.boolean().default(false),
  limitResumeAt: z.number().nullable().default(null),
  // Closed set at the SCHEMA level, not just at write time: this field is the
  // posture authority, so a hand-corrupted value must degrade to null (no
  // flag, safest posture) rather than pass through as an arbitrary string.
  // .catch(null) keeps a malformed value from bricking the whole session read.
  limitPermissionMode: z.enum(["bypassPermissions", "acceptEdits", "default", "plan"]).nullable().catch(null).default(null),
  limitEventId: z.string().nullable().default(null),

  // Last cumulative work boundary reserved for an automatic checkpoint handover.
  lastCheckpointWorkCount: z.number().int().min(0).default(0),

  // Session termination
  terminationReason: z
    .enum(["normal", "cancelled", "admin_recovery", "auto_superseded_finished_orphan"])
    .nullable()
    .default(null),

  // ISS-037: Deferred finding tracking
  filedDeferrals: z.array(z.object({
    fingerprint: z.string(),
    issueId: z.string(),
  })).default([]),
  pendingDeferrals: z.array(z.object({
    fingerprint: z.string(),
    severity: z.string(),
    category: z.string(),
    description: z.string(),
    reviewKind: z.enum(["plan", "code"]),
  })).default([]),
  deferralsUnfiled: z.boolean().default(false),

  // Session metadata
  waitingForRetry: z.boolean().default(false),
  lastGuideCall: z.string().optional(),
  startedAt: z.string(),
  guideCallCount: z.number().default(0),

  // ISS-098: Codex availability cache -- skip codex after failure
  // ISS-110: Changed from boolean to ISO timestamp with 10-minute TTL
  codexUnavailable: z.boolean().optional(),
  codexUnavailableSince: z.string().optional(),

  // Supersession tracking
  supersededBy: z.string().optional(),
  supersededSession: z.string().optional(),
  stealReason: z.string().optional(),

  // Recipe overrides (maxTicketsPerSession: 0 = no limit)
  config: z.object({
    maxTicketsPerSession: z.number().min(0).default(0),
    handoverInterval: z.number().min(0).default(3),
    compactThreshold: z.string().default("high"),
    reviewBackends: z.array(z.string()).default(["codex", "agent"]),
    codexReviewBackends: z.array(z.string()).optional(),
    // T-181: Multi-lens review config
    lensConfig: z.object({
      lenses: z.union([z.literal("auto"), z.array(z.string())]).default("auto"),
      maxLenses: z.number().min(1).max(8).default(8),
      lensTimeout: z.union([
        z.number(),
        z.object({ default: z.number(), opus: z.number() }),
      ]).default({ default: 60, opus: 120 }),
      findingBudget: z.number().min(1).default(10),
      confidenceFloor: z.number().min(0).max(1).default(0.6),
      tokenBudgetPerLens: z.number().min(1000).default(32000),
      hotPaths: z.array(z.string()).default([]),
      lensModels: z.record(z.string()).default({ default: "sonnet", security: "opus", concurrency: "opus" }),
    }).optional(),
    blockingPolicy: z.object({
      neverBlock: z.array(z.string()).default([]),
      alwaysBlock: z.array(z.string()).default(["injection", "auth-bypass", "hardcoded-secrets"]),
      planReviewBlockingLenses: z.array(z.string()).default(["security", "error-handling"]),
    }).optional(),
    requireSecretsGate: z.boolean().default(false),
    requireAccessibility: z.boolean().default(false),
    testMapping: z.object({
      strategy: z.literal("convention"),
      patterns: z.array(z.object({
        source: z.string(),
        test: z.string(),
      })),
    }).optional(),
  }).default({ maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 }),

  // T-181: Lens review findings history (for lessons feedback loop)
  lensReviewHistory: z.array(z.object({
    ticketId: z.string(),
    stage: z.enum(["CODE_REVIEW", "PLAN_REVIEW"]),
    lens: z.string(),
    category: z.string(),
    severity: z.string(),
    disposition: z.enum(LENS_FINDING_DISPOSITIONS),
    description: z.string(),
    dismissReason: z.string().optional(),
    timestamp: z.string(),
  })).default([]),

  // T-123: Issue sweep tracking
  issueSweepState: z.object({
    remaining: z.array(z.string()),
    current: z.string().nullable(),
    resolved: z.array(z.string()),
  }).nullable().default(null),
  pipelinePhase: z.enum(["ticket", "postComplete"]).default("ticket"),

  // T-188: Targeted auto mode -- constrains PICK_TICKET to specific items
  targetWork: z.array(z.string().regex(TARGET_WORK_ID_REGEX)).max(150).default([]),

  // T-382: Cached display IDs for target work items (canonical -> display)
  targetWorkDisplayIds: z.record(z.string()).default({}),

  // T-124: Test stage baseline and retry tracking
  testBaseline: z.object({
    exitCode: z.number(),
    passCount: z.number(),
    failCount: z.number(),
    summary: z.string(),
  }).nullable().default(null),
  testRetryCount: z.number().default(0),
  writeTestsRetryCount: z.number().default(0),
  buildRetryCount: z.number().default(0),
  verifyRetryCount: z.number().default(0),
  verifyAutoDetected: z.boolean().default(false),

  // T-128: Resolved recipe (frozen at session start, survives compact/resume)
  resolvedPipeline: z.array(z.string()).optional(),
  resolvedPostComplete: z.array(z.string()).optional(),
  resolvedRecipeId: z.string().optional(),
  resolvedStages: z.record(z.record(z.unknown())).optional(),
  resolvedDirtyFileHandling: z.string().optional(),
  // T-328: this gates every session read through safeParse, so it accepts the
  // full input set (including the legacy "none") and transforms to canonical.
  // An un-widened enum here would not drop the field -- it would make a session
  // that persisted a newer value unreadable.
  resolvedBranchStrategy: z.enum(["current", "per-ticket", "main", "none"])
    .default("current")
    .transform((v) => (v === "none" ? "current" : v)),

  // T-328: an open branch-mismatch episode. Persisted so the offer, its bounded
  // failure count, and any write-ahead branch attempt all survive compaction
  // and resume. Null whenever no episode is open.
  pendingMismatch: z.object({
    targetId: z.string(),
    targetKind: z.enum(["ticket", "issue"]),
    branch: z.string(),
    controlFailures: z.number().default(0),
    attempt: z.object({
      name: z.string(),
      baseOid: z.string(),
      status: z.literal("planned"),
    }).nullable().default(null),
  }).nullable().default(null),

  // T-328: items skipped at PICK_TICKET. Excluded from targeted remaining-work
  // AND from untargeted candidate generation, so a skip is not undone by the
  // next pass re-offering the same item.
  skippedTargets: z.array(z.string()).default([]),
  resolvedDefaults: z.object({
    maxTicketsPerSession: z.number(),
    compactThreshold: z.string(),
    reviewBackends: z.array(z.string()),
    codexReviewBackends: z.array(z.string()).optional(),
    handoverInterval: z.number().optional(),
  }).optional(),

  // T-257: Verification counters (accumulated from telemetry JSONL)
  verificationCounters: z.object({
    proposed: z.number().default(0),
    verified: z.number().default(0),
    rejected: z.number().default(0),
    filed: z.number().default(0),
    lastTelemetryLine: z.number().default(0),
  }).optional(),

  // Stuck-detection: consecutive retry count for cancel gate bypass
  stuckRetryCount: z.number().default(0),

  // T-260: Liveness infrastructure
  sidecarPid: z.number().nullish(),

  // T-259: Telemetry substrate fields (all nullish for wire + state compat)
  substage: z.string().nullish(),
  substageStartedAt: z.string().nullish(),
  pendingInstruction: z.string().nullish(),
  pendingInstructionSetAt: z.string().nullish(),
  claudeCodeSessionId: z.string().nullish(),
  binaryFingerprint: z.object({
    mtime: z.string(),
    sha256: z.string(),
  }).nullish(),
  runningSubprocesses: z.array(z.object({
    pid: z.number(),
    category: z.string(),
    startedAt: z.string(),
    stage: z.string(),
  })).nullish(),
  lastReviewVerdict: z.object({
    stage: z.string(),
    round: z.number(),
    verdict: z.string(),
    findingCount: z.number(),
    criticalCount: z.number(),
    unresolvedCriticalCount: z.number().optional(),
    majorCount: z.number(),
    suggestionCount: z.number(),
    durationMs: z.number(),
    summary: z.string(),
  }).nullish(),
  landingDecision: z.object({
    stage: z.string(),
    round: z.number(),
    maxReviewRounds: z.number(),
    reason: z.string(),
    findingCounts: z.object({
      critical: z.number(),
      major: z.number(),
      minor: z.number(),
      suggestion: z.number(),
    }),
    timestamp: z.string(),
  }).nullable().default(null),
  recentDeferrals: z.object({
    total: z.number(),
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
  }).nullish(),
  alive: z.boolean().nullish(),
  lastMcpCall: z.string().nullish(),
  healthState: z.string().nullish(),
  currentReviewStartedAt: z.string().nullish(),
}).passthrough();

export type FullSessionState = z.infer<typeof SessionStateSchema>;

/** ISS-400: Named type for verification counters, derived from the Zod schema. */
export type VerificationCounters = NonNullable<FullSessionState["verificationCounters"]>;

// ---------------------------------------------------------------------------
// Guide input (from MCP tool call)
// ---------------------------------------------------------------------------

export type GuideAction = "start" | "report" | "resume" | "pre_compact" | "cancel";

/** Session execution mode: auto=full autonomous, review=code review only, plan=plan+review, guided=single ticket end-to-end */
export type SessionMode = "auto" | "review" | "plan" | "guided";
export const SESSION_MODES = ["auto", "review", "plan", "guided"] as const;

export interface GuideReportInput {
  readonly completedAction: string;
  readonly ticketId?: string;
  readonly issueId?: string;  // T-153: issue pick in PICK_TICKET
  readonly commitHash?: string;
  readonly handoverContent?: string;
  readonly verdict?: string;
  readonly findings?: readonly Finding[];
  readonly reviewerSessionId?: string;
  readonly overrideOverlap?: boolean;
  readonly notes?: string;
  readonly reviewer?: string;  // ISS-102: actual reviewer backend used (overrides computed nextReviewer)
  readonly reviewId?: string;  // ISS-720: lens reviewId from prepare/synthesize; joins to verification telemetry to record the path actually taken
}

export interface GuideInput {
  readonly sessionId: string | null;
  readonly action: GuideAction;
  readonly report?: GuideReportInput;
  /** Execution mode (default: "auto"). Only used with action: "start". */
  readonly mode?: SessionMode;
  /** Ticket ID for tiered modes (review, plan, guided). */
  readonly ticketId?: string;
  /** T-188: Target work items for targeted auto mode. Array of T-XXX and ISS-XXX IDs. */
  readonly targetWork?: readonly string[];
  /** Client task/thread identity used for same-task continuation and safe recovery. */
  readonly clientTaskId?: string;
  /** Explicitly recover a COMPACT session after confirming its recorded owner is gone. */
  readonly takeover?: boolean;
}

// ---------------------------------------------------------------------------
// Guide output (returned to Claude)
// ---------------------------------------------------------------------------

export interface SessionSummary {
  readonly ticket: string;
  readonly risk: string;
  readonly completed: readonly string[];
  readonly currentStep: string;
  readonly contextPressure: string;
  readonly branch: string | null;
}

export type ContextAdvice = "ok";

export interface GuideOutput {
  readonly sessionId: string;
  readonly state: string;
  readonly transitionedFrom?: string;
  readonly instruction: string;
  readonly reminders: readonly string[];
  readonly contextAdvice: ContextAdvice;
  readonly sessionSummary: SessionSummary;
}

// ---------------------------------------------------------------------------
// Git result (discriminated union for git operations)
// ---------------------------------------------------------------------------

export type GitResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; message: string };

// ---------------------------------------------------------------------------
// Diff stats
// ---------------------------------------------------------------------------

export interface DiffStats {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly totalLines: number;
}

// ---------------------------------------------------------------------------
// Pressure level
// ---------------------------------------------------------------------------

export type PressureLevel = "low" | "medium" | "high" | "critical";

// ---------------------------------------------------------------------------
// Branch validation result
// ---------------------------------------------------------------------------

export type BranchValidation =
  | { status: "ok" }
  | { status: "head_ahead_own"; commitHash: string }
  | { status: "head_ahead_unknown"; commitHash: string }
  | { status: "head_diverged" }
  | { status: "branch_mismatch"; expected: string; actual: string };
