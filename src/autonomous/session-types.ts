import { realpathSync } from "node:fs";
import { z } from "zod";

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
  | "VERIFY"
  | "FINALIZE"
  | "COMPACT"
  | "HANDOVER"
  | "COMPLETE"
  | "LESSON_CAPTURE"
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
  "VERIFY",
  "FINALIZE",
  "COMPACT",
  "LESSON_CAPTURE",
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
// Session state — minimal shape that hook-status reads from state.json
// ---------------------------------------------------------------------------

export interface SessionState {
  readonly sessionId: string;
  readonly state: WorkflowState | string;
  readonly waitingForRetry?: boolean;
  readonly lastGuideCall?: string;
  readonly ticket?: {
    readonly id: string;
    readonly title: string;
    readonly risk?: string;
  };
  readonly completedTickets?: ReadonlyArray<{ readonly id: string }>;
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
  readonly lastGuideCall: string | null;
  readonly completedThisSession: readonly string[];
  readonly contextPressure: string;
  readonly branch: string | null;
  readonly source: "hook";
}

export interface StatusPayloadInactive {
  readonly schemaVersion: typeof CURRENT_STATUS_SCHEMA_VERSION;
  readonly sessionActive: false;
  readonly source: "hook";
}

export type StatusPayload = StatusPayloadActive | StatusPayloadInactive;

// ---------------------------------------------------------------------------
// Workflow state enum values (for Zod schema)
// ---------------------------------------------------------------------------

export const WORKFLOW_STATES = [
  "INIT", "LOAD_CONTEXT", "PICK_TICKET",
  "PLAN", "PLAN_REVIEW",
  "IMPLEMENT", "WRITE_TESTS", "TEST", "CODE_REVIEW", "VERIFY",
  "FINALIZE", "COMPACT",
  "HANDOVER", "COMPLETE", "LESSON_CAPTURE", "ISSUE_SWEEP", "SESSION_END",
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
  readonly majorCount: number;
  readonly suggestionCount: number;
  readonly codexSessionId?: string;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Finding (from Claude's review report)
// ---------------------------------------------------------------------------

export interface Finding {
  readonly id: string;
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
      majorCount: z.number(),
      suggestionCount: z.number(),
      codexSessionId: z.string().optional(),
      timestamp: z.string(),
    })).default([]),
  }).default({ plan: [], code: [] }),

  // Completed tickets this session
  completedTickets: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    commitHash: z.string().optional(),
    risk: z.string().optional(),
    realizedRisk: z.string().optional(),
  })).default([]),

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

  // Context pressure
  contextPressure: z.object({
    level: z.string().default("low"),
    guideCallCount: z.number().default(0),
    ticketsCompleted: z.number().default(0),
    compactionCount: z.number().default(0),
    eventsLogBytes: z.number().default(0),
  }).default({ level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 }),

  // Pending project mutation (for crash recovery)
  pendingProjectMutation: z.any().nullable().default(null),

  // COMPACT resume
  resumeFromRevision: z.number().nullable().default(null),
  preCompactState: z.string().nullable().default(null),
  compactPending: z.boolean().default(false),
  compactPreparedAt: z.string().nullable().default(null),
  resumeBlocked: z.boolean().default(false),

  // Session termination
  terminationReason: z.enum(["normal", "cancelled", "admin_recovery"]).nullable().default(null),

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

  // Supersession tracking
  supersededBy: z.string().optional(),
  supersededSession: z.string().optional(),
  stealReason: z.string().optional(),

  // Recipe overrides (maxTicketsPerSession: 0 = no limit)
  config: z.object({
    maxTicketsPerSession: z.number().min(0).default(0),
    handoverInterval: z.number().min(0).default(5),
    compactThreshold: z.string().default("high"),
    reviewBackends: z.array(z.string()).default(["codex", "agent"]),
  }).default({ maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 5 }),

  // T-123: Issue sweep tracking
  issueSweepState: z.object({
    remaining: z.array(z.string()),
    current: z.string().nullable(),
    resolved: z.array(z.string()),
  }).nullable().default(null),
  pipelinePhase: z.enum(["ticket", "postComplete"]).default("ticket"),

  // T-124: Test stage baseline and retry tracking
  testBaseline: z.object({
    exitCode: z.number(),
    passCount: z.number(),
    failCount: z.number(),
    summary: z.string(),
  }).nullable().default(null),
  testRetryCount: z.number().default(0),
  writeTestsRetryCount: z.number().default(0),
  verifyRetryCount: z.number().default(0),
  verifyAutoDetected: z.boolean().default(false),

  // T-128: Resolved recipe (frozen at session start, survives compact/resume)
  resolvedPipeline: z.array(z.string()).optional(),
  resolvedPostComplete: z.array(z.string()).optional(),
  resolvedRecipeId: z.string().optional(),
  resolvedStages: z.record(z.record(z.unknown())).optional(),
  resolvedDirtyFileHandling: z.string().optional(),
  resolvedDefaults: z.object({
    maxTicketsPerSession: z.number(),
    compactThreshold: z.string(),
    reviewBackends: z.array(z.string()),
  }).optional(),
}).passthrough();

export type FullSessionState = z.infer<typeof SessionStateSchema>;

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
  readonly commitHash?: string;
  readonly handoverContent?: string;
  readonly verdict?: string;
  readonly findings?: readonly Finding[];
  readonly reviewerSessionId?: string;
  readonly overrideOverlap?: boolean;
  readonly notes?: string;
}

export interface GuideInput {
  readonly sessionId: string | null;
  readonly action: GuideAction;
  readonly report?: GuideReportInput;
  /** Execution mode (default: "auto"). Only used with action: "start". */
  readonly mode?: SessionMode;
  /** Ticket ID for tiered modes (review, plan, guided). */
  readonly ticketId?: string;
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
