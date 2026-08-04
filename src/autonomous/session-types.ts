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
 * automatically widens both sides -- no second file to update.
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
// Claude status derivation -- exhaustive mapping
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
// Workspace ID -- shared between hook-status (reader) and guide (writer)
// ---------------------------------------------------------------------------

/**
 * Derives a stable workspace ID from the project root path.
 * Uses realpathSync to resolve symlinks -- deterministic across sessions.
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
// Session state -- minimal shape that hook-status reads from state.json
// ---------------------------------------------------------------------------

export interface SessionState {
  readonly sessionId: string;
  readonly state: WorkflowState | string;
  readonly waitingForRetry?: boolean;
  readonly lastGuideCall?: string;
  /**
   * PID of the MCP server process that made the last recorded MCP guide call
   * (T-450). Its timestamp is `mcpGuideCallAt`, NOT `lastGuideCall`: the latter
   * also advances on CLI refreshes that leave this pid alone.
   *
   * Its ONLY job is to invalidate a stale death marker. The alive sidecar is
   * spawned by the MCP server and watches `process.ppid`, so it writes its
   * death marker when the SERVER exits, which an ordinary MCP restart does
   * while the owner task lives on. If this pid is still alive, a server that
   * recently served this session is running and the marker cannot be trusted.
   *
   * PID reuse points the safe way here: a recycled pid reads as alive, which
   * SUPPRESSES the takeover offer. That is why no signature check is needed.
   */
  readonly mcpServerPid?: number | null;
  /**
   * When `mcpServerPid` was stamped. Paired with it and written in the same
   * update, because `lastGuideCall` also advances on CLI refreshes that leave
   * the pid untouched; reading the pid against `lastGuideCall` would then
   * describe two different calls as though they were one.
   */
  readonly mcpGuideCallAt?: string | null;
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
// Status payload -- written to .story/status.json by hook-status
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

/**
 * Presence-preserving snapshot of one field.
 *
 * `{ present: false }` and `{ present: true, value: "" }` are different
 * observations and produce different replay decisions. Collapsing absence to
 * `undefined` would also make "the field was absent" indistinguishable from
 * "no snapshot was recorded", which is the difference between a replayable
 * record and a legacy one.
 */
export type FieldSnapshot =
  | { readonly present: false }
  | { readonly present: true; readonly value: string };

/**
 * Who prepared a pending mutation, and against what.
 *
 * Recorded where the artifact is PREPARED rather than derived at recovery
 * time. A record without a structurally valid provenance object is legacy and
 * quarantines in every state: recovery authorizes a write, and an authority
 * reconstructed from the record it is authorizing is not an authority (L-038).
 */
export interface MutationProvenance {
  /** Creating owner task. Null when the client supplied no task identity. */
  readonly ownerTask: string | null;
  /** Session revision at prepare time. */
  readonly revision: number;
  /** Ticket id where the variant is ticket-scoped; null where it is not. */
  readonly ticket: string | null;
}

interface PendingMutationCommon {
  readonly transitionId: string;
  readonly provenance?: MutationProvenance;
}

/**
 * Ticket identities produced BY THE RESOLVER, over a real project state.
 *
 * The brand states the claim; a runtime registry enforces it, because a type
 * cannot survive a cast. Only `resolvePayloadTicketIdentities` produces a
 * registered value, so a caller cannot satisfy this by handing back the same
 * list it was asked to authenticate, which is exactly the self-confirming
 * guard the check exists to prevent (L-038).
 */
export type ResolvedTicketIdentities = readonly string[] & {
  readonly __resolvedTicketIdentities: unique symbol;
};

/**
 * A ticket identity that has been PROVEN canonical, not merely assumed to be.
 *
 * Canonical means "what the resolver returns for it", in EITHER form the ledger
 * uses: a legacy ticket's canonical id is its display-form value (`T-001`) and
 * a post-migration ticket's is a hash (`t-...`). Both are canonical, and a rule
 * that read one syntax as canonical would quarantine every create linked to the
 * other.
 *
 * So the proof is provenance, not spelling. Minted only by
 * `asCanonicalTicketIdentities`, which requires the stored set to agree with a
 * `ResolvedTicketIdentities` that a resolver actually produced. A preparer
 * writing a display ALIAS -- a spelling that resolves to something else -- gets
 * a disagreement rather than a record that replays, gets its references
 * rewritten by the create, and can then no longer recognize its own result.
 */
export type CanonicalTicketIdentity = string & {
  readonly __canonicalTicketIdentity: unique symbol;
};

/**
 * A digest produced by `issueCreateFingerprint`, and by nothing else.
 *
 * Branded so a preparer writing `satisfies PendingProjectMutation` cannot
 * store an arbitrary string, or a whole-entity digest, where the semantic
 * projection belongs. Persisted JSON loses the brand, so the classifier also
 * re-derives the value at runtime; the brand stops the mistake being written,
 * the runtime check stops it being believed.
 */
export type IssueCreateSemanticFingerprint = string & {
  readonly __issueCreateSemantic: unique symbol;
};

/**
 * The create input a replay would actually submit.
 *
 * Typed rather than `unknown`, and shared by the preparer, the classifier and
 * the eventual replay consumer, because a replay verdict is a promise that the
 * operation can be executed. An `unknown` payload lets a number, a string or an
 * array satisfy "a payload is present" while no create can be performed from
 * it. Mirrors the required arguments of `handleIssueCreate`; legacy records
 * stay representable through the OPTIONAL `content`, never through an
 * unvalidated payload.
 */
export interface PendingIssueCreatePayload {
  readonly title: string;
  readonly severity: string;
  readonly impact: string;
  readonly components: readonly string[];
  /**
   * CANONICAL ticket identities, resolved at preparation time.
   *
   * Not the spellings a caller happened to use. The create resolves ticket
   * references, so raw references and the written entity would hold different
   * representations of the same relationship and could not be compared. Storing
   * the resolved form is what makes the relationship comparable, and storing it
   * ONCE is what stops the replay input and the identity prediction disagreeing:
   * `handleIssueCreate` resolves canonical ids to themselves, so this one field
   * is both what a replay writes and what a recognition compares.
   */
  readonly relatedTickets: readonly CanonicalTicketIdentity[];
  readonly location: readonly string[];
  /**
   * REQUIRED, and the single canonical identity of an issue_create.
   *
   * It lives here rather than beside the record because a create can only be
   * identified by something the create itself writes. Stored in two places it
   * could disagree, and a replay would then produce an issue that its own
   * record could never afterwards recognize.
   */
  readonly dedupeKey: string;
  readonly phase?: string | null;
}

/**
 * A field write that can be replayed, because the value to write is stored.
 *
 * `expectedCurrent` is the legacy three-way key and is still written and still
 * read by the shipped recovery path. `preimage` / `postimage` are what the
 * outcome table reads for the named field.
 *
 * BOTH whole-entity digests are stored, and both are load-bearing.
 * `postimageFingerprint` corroborates a postimage match on targets that carry
 * no transition nonce: the field value alone proves nothing, since anyone can
 * write the same value. `preimageFingerprint` is what makes a REPLAY verdict
 * safe to give. Corroboration is whole-entity, so replay has to be too: if some
 * OTHER field drifted while the named one stayed at its preimage, replaying
 * would produce an entity whose digest can never match the stored postimage,
 * and this record would quarantine on its own result instead of clearing.
 */
interface PendingFieldWrite extends PendingMutationCommon {
  readonly target: string;
  readonly field: string;
  readonly value: string;
  readonly expectedCurrent?: string;
  readonly preimage?: FieldSnapshot;
  readonly postimage?: FieldSnapshot;
  readonly preimageFingerprint?: string | null;
  readonly postimageFingerprint?: string | null;
}

/**
 * The pending-mutation record, as it is actually written.
 *
 * Two fields on `ticket_update` are undeclared in every build before this one
 * even though the shipped recovery path reads both: `claimedBySession`, which
 * it copies onto the replayed ticket, and `postMutation`, which drives the
 * session transition after a successful replay. A union that omits what the
 * code reads is a comment, not a type.
 */
export type PendingProjectMutation =
  | (PendingFieldWrite & {
      readonly type: "ticket_update";
      readonly claimedBySession?: string;
      readonly postMutation?: {
        readonly nextSessionState?: string;
        readonly terminationReason?: string;
        readonly clearTicket?: boolean;
      };
    })
  | (PendingFieldWrite & { readonly type: "ticket_recovery_write" })
  | (PendingFieldWrite & { readonly type: "ticket_recovery_clear" })
  | (PendingFieldWrite & { readonly type: "issue_update" })
  | (PendingMutationCommon & {
      readonly type: "issue_create";
      /**
       * Where the create was expected to land. A LOCATOR and an audit record,
       * never the identity: `handleIssueCreate` allocates the next free id and
       * cannot be aimed at a chosen one, so a display id is not something any
       * replay can promise to produce. Identity is the payload's dedupe key.
       */
      readonly expectedId: string;
      /**
       * Canonical create content plus a stable dedupe key. Both are required
       * for this variant to be replayable or recognizable: a display id can be
       * occupied by unrelated content in this ledger, so identity alone would
       * accept a foreign issue as this transaction's postimage.
       *
       * `payload` is the create input itself, kept because a replay has to
       * write something and an id plus a digest is not something.
       *
       * `semanticFingerprint` is named apart from the whole-entity digests used
       * elsewhere BECAUSE it must not be one. A create cannot be aimed, so the
       * issue it produces carries an allocated id, order and dates no preparer
       * could predict; a whole-entity digest taken beforehand could never match
       * what was written, and the record would execute its own replay and then
       * fail to recognize the result. Produce it only with
       * `issueCreateFingerprint`.
       */
      readonly content?: {
        readonly payload: PendingIssueCreatePayload;
        readonly semanticFingerprint: IssueCreateSemanticFingerprint;
      };
    })
  | (PendingMutationCommon & {
      readonly type: "handover_create";
      readonly filename: string | null;
      /**
       * These two variants store a filename, never a body. They are therefore
       * recognizable or quarantined, never replayable: rewriting one would
       * have to invent the content, which fabricates a record.
       */
      readonly contentFingerprint?: string;
    })
  | (PendingMutationCommon & {
      readonly type: "snapshot_save";
      readonly filename: string | null;
      readonly contentFingerprint?: string;
    });

/**
 * A pending mutation that could not be safely replayed or confirmed applied.
 *
 * Durable, because the alternative to keeping it is dropping authorized work
 * silently. Carries the original payload verbatim so the record stays readable
 * after the schema moves on.
 */
export interface QuarantinedMutation {
  /** The record's `type`, or "unknown" when it had none. */
  readonly kind: string;
  readonly payload: unknown;
  readonly reason: string;
  readonly quarantinedAt: string;
  /** The owner task the record was prepared by, when it recorded one. */
  readonly displacedOwner: string | null;
}

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

/**
 * ISS-907: a hand-edit stores null where this build omits the field. For a
 * declared-optional SCALAR the two forms are semantically identical, so both
 * parse and reads see undefined for either -- otherwise one cosmetic null
 * fails the whole state.json parse and the session becomes unreadable (the
 * ISS-902 escalation class).
 *
 * Scalars only, and only ones declared `.optional()`:
 * - Required fields keep rejecting null. A null `startedAt` is damage, not
 *   skew, and forgiving it would conceal the difference.
 * - Fields declared `.nullable()` keep their meaningful null. Wrapping one of
 *   those here would destroy the null the field exists to carry, so the
 *   parameter is CONSTRAINED to the three scalar classes rather than left as
 *   ZodTypeAny -- a comment is not a guard. Verified: swapping any site to a
 *   nullable, array, or object inner fails tsc with TS2345. The guard has to
 *   live in the type because it cannot live in a test -- tsconfig excludes
 *   `test`, so a `@ts-expect-error` probe there would never be compiled.
 *   (The return type is also inferred rather than annotated: an annotation of
 *   `z.output<T> | undefined` re-widens to include the null that
 *   `?? undefined` just discarded, which type-checks clean and turns every
 *   downstream `=== null` branch into dead code.)
 * - Optional CONTAINERS (objects, arrays, records) stay `.optional()`: null
 *   there is a shape corruption, not a scalar-presence question, and must
 *   stay visible as one.
 *
 * Note this widens the READ only. Nothing in this build writes null to any of
 * these fields, and a parsed state re-serializes without one.
 */
const forgiveNull = <T extends z.ZodString | z.ZodNumber | z.ZodBoolean>(inner: T) =>
  // The cast is load-bearing, do not remove it. Calling `.nullish()` directly
  // on a UNION-constrained generic resolves the method against the whole
  // union, so `z.output<T>` comes back as `string | number | boolean` for
  // every field and 67 call sites across the stages stop type-checking.
  // Casting to the single-parameter `ZodType<z.output<T>>` keeps the
  // constraint (misuse is still TS2345 at the call) while restoring precise
  // per-field inference.
  (inner as z.ZodType<z.output<T>>).nullish().transform((v) => v ?? undefined);

/**
 * ISS-918: `codexUnavailable` and `codexUnavailableSince` are read as a PAIR
 * (review-depth.ts: `timestamp ? withinTTL(timestamp) : !!boolean`). The
 * timestamp carries the TTL; the boolean is a pre-ISS-110 shim that nothing
 * ever clears. So the boolean WITHOUT a usable timestamp is the one
 * combination that blocks codex forever.
 *
 * Forgiving null on the timestamp alone would let a CURRENT paired state
 * normalize into that legacy sticky shape. The shape itself is not new -- it
 * is exactly what a genuine pre-ISS-110 state looks like, and that one is
 * still honored. What is new is reaching it from a state this build wrote,
 * via the most natural hand-edit there is: clearing a stale timestamp to
 * un-stick codex would instead stick it permanently, and silently.
 *
 * This runs on the RAW object, BEFORE per-field normalization, which is what
 * makes the fix possible without touching ISS-098's semantics: at this point
 * an EXPLICIT null is still distinguishable from a legacy ABSENT field. Only
 * the explicit null clears the flag. A genuine pre-ISS-110 state (boolean
 * present, timestamp never written) keeps its sticky block exactly as before.
 *
 * It is applied by `parseSessionState` rather than by wrapping the schema in
 * `z.preprocess`, so that `SessionStateSchema` stays an exported ZodObject:
 * the raw cross-field repair is centralized at the persisted-state read
 * boundary instead of changing the schema's type. That boundary is the right
 * seam regardless -- the threat model is a hand-edited FILE, and every
 * production full-schema validation of persisted state goes through this
 * function. (Raw or minimal readers, such as health telemetry, read the file
 * without validating it and so do not pass through here.)
 *
 * The repair is deliberately NARROW. It fires only on an explicit null
 * timestamp, and it clears only a flag that is literally `true`. Anything
 * else -- false, null, or a malformed value -- is left for the schema to
 * handle, because rewriting those would conceal corruption that should stay
 * visible (a string `codexUnavailable` must still fail the parse and name
 * itself, not be quietly normalized to false).
 */
function clearExplicitlyNulledCodexBlock(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  if (!Object.hasOwn(o, "codexUnavailableSince") || o.codexUnavailableSince !== null) return raw;
  const next: Record<string, unknown> = { ...o, codexUnavailableSince: undefined };
  // Only a genuine sticky flag is cleared. Absent stays absent, false stays
  // false, and anything invalid stays invalid: this repairs one specific
  // contradiction, it does not mint state and it does not launder damage.
  if (o.codexUnavailable === true) next.codexUnavailable = false;
  return next;
}

export const SessionStateSchema = z.object({
  schemaVersion: z.literal(CURRENT_SESSION_SCHEMA_VERSION),
  sessionId: z.string().uuid(),
  recipe: z.string(),
  state: z.string(),
  previousState: forgiveNull(z.string()),
  revision: z.number().int().min(0),
  status: z.enum(["active", "completed", "superseded"]).default("active"),
  mode: z.enum(["auto", "review", "plan", "guided"]).default("auto"),

  // Ticket in progress
  ticket: z.object({
    id: z.string(),
    displayId: forgiveNull(z.string()),
    title: z.string(),
    risk: forgiveNull(z.string()),
    realizedRisk: forgiveNull(z.string()),
    claimed: z.boolean().default(false),
    lastPlanHash: forgiveNull(z.string()),
  }).optional(),

  // Review tracking
  reviews: z.object({
    plan: z.array(z.object({
      round: z.number(),
      reviewer: z.string(),
      verdict: z.string(),
      findingCount: z.number(),
      criticalCount: z.number(),
      unresolvedCriticalCount: forgiveNull(z.number()),
      majorCount: z.number(),
      suggestionCount: z.number(),
      codexSessionId: forgiveNull(z.string()),
      timestamp: z.string(),
    })).default([]),
    code: z.array(z.object({
      round: z.number(),
      reviewer: z.string(),
      verdict: z.string(),
      findingCount: z.number(),
      criticalCount: z.number(),
      unresolvedCriticalCount: forgiveNull(z.number()),
      majorCount: z.number(),
      suggestionCount: z.number(),
      codexSessionId: forgiveNull(z.string()),
      timestamp: z.string(),
    })).default([]),
  }).default({ plan: [], code: [] }),

  // T-153: Current issue being fixed (null when working on a ticket)
  currentIssue: z.object({
    id: z.string(),
    displayId: forgiveNull(z.string()),
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
    displayId: forgiveNull(z.string()),
    title: forgiveNull(z.string()),
    commitHash: forgiveNull(z.string()),
    risk: forgiveNull(z.string()),
    realizedRisk: forgiveNull(z.string()),
    startedAt: forgiveNull(z.string()),
    completedAt: forgiveNull(z.string()),
  })).default([]),

  // T-187: Per-ticket timing -- set when ticket is picked, cleared on commit
  ticketStartedAt: z.string().nullable().default(null),

  // FINALIZE checkpoint
  finalizeCheckpoint: z.enum(["staged", "staged_override", "precommit_passed", "committed"]).nullable().default(null),

  /**
   * T-450 step 7a: WHICH item the `committed` checkpoint committed.
   *
   * It exists because at that checkpoint nothing else can say. FinalizeStage
   * clears the item identity in the SAME write that records `committed` --
   * `currentIssue: null` for an issue, `ticket: undefined` for a ticket -- and
   * the advance to COMPLETE happens after, so a process death in between leaves
   * a legitimate session with neither field. Candidate takeover has to decide
   * that session's authority, and every attempt to INFER the item from the
   * surviving fields is unsound: `completedTickets[].commitHash` stores
   * `normalizedHash` while `git.itemBaseHead` stores `fullHead`, and those
   * differ whenever the accepted commit is an ancestor of HEAD rather than HEAD
   * itself, at which point a residual rule reads a ticket completion as an older
   * resolved issue. The session events cannot stand in either: they carry no
   * revision, so in the very window this answers, the last `commit` event still
   * belongs to the PREVIOUS item.
   *
   * INVARIANT: written only beside `finalizeCheckpoint: "committed"`, and nulled
   * at every site that nulls `finalizeCheckpoint`. Clearing it at COMPLETE alone
   * would not be enough -- a FINALIZE that resets its own checkpoint, or a
   * HEAD-drift recovery that routes back to IMPLEMENT, would carry a stale item
   * into later work, which is worse than having no field at all.
   */
  finalizedItem: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ticket"),
      id: z.string().min(1),
      commitHash: z.string().min(1),
    }),
    z.object({
      kind: z.literal("issue"),
      id: z.string().min(1),
      commitHash: z.string().min(1),
    }),
    // The re-entry shape: FINALIZE reached `committed` with neither a ticket
    // nor an issue to attribute. Recorded POSITIVELY rather than as null,
    // because null is also how a state written before this field appears, and
    // the legacy fallback then guesses from `completedTickets` /
    // `resolvedIssues` -- which on a no-item commit would name an OLDER item
    // and authorize a takeover against work this checkpoint is not about.
    // Every newly written `committed` checkpoint carries a non-null value; null
    // means legacy and nothing else.
    z.object({
      kind: z.literal("none"),
      commitHash: z.string().min(1),
    }),
  ]).nullable().default(null),

  // Git state.
  //
  // ISS-922: each of these four commits answers a DIFFERENT question, and
  // they are not interchangeable. Conflating two of them closed every exit
  // from FINALIZE and stranded a session with no supported recovery.
  //
  // - initHead      HEAD at session start. Never mutated.
  // - mergeBase     Diff base for the current item's review. NOT a
  //                 finalization baseline: it starts as the fork point from
  //                 main, so on a feature branch it sits behind HEAD.
  // - expectedHead  The last OBSERVED head, for resume drift detection ONLY.
  //                 Park, resume-drift and checkout all advance it, which is
  //                 correct for drift detection and wrong for anything else.
  // - itemBaseHead  The commit from which the current item must produce a
  //                 newly validated commit. Initialized at item pick, reset
  //                 when drift invalidates the work/review epoch. The only
  //                 field FINALIZE measures a work commit against.
  git: z.object({
    branch: z.string().nullable().default(null),
    initHead: forgiveNull(z.string()),
    mergeBase: z.string().nullable().default(null),
    expectedHead: forgiveNull(z.string()),
    itemBaseHead: forgiveNull(z.string()),
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
    workspaceId: forgiveNull(z.string()),
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
    workItemsAtLastCompaction: forgiveNull(z.number().int().min(0)),
    eventsLogBytesAtLastCompaction: forgiveNull(z.number().int().min(0)),
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

  // Pending mutations that recovery refused to replay or confirm. `z.any()`
  // entries for the same reason `pendingProjectMutation` is: this array is an
  // audit trail, and a strict inner schema would fail the whole state.json
  // parse over one malformed entry, destroying the record it exists to keep
  // (the ISS-902 escalation class). Shape is asserted at the write site.
  quarantinedMutations: z.array(z.any()).default([]),

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
  lastGuideCall: forgiveNull(z.string()),
  mcpServerPid: z.number().int().positive().nullish(),
  mcpGuideCallAt: forgiveNull(z.string()),
  startedAt: z.string(),
  guideCallCount: z.number().default(0),

  // ISS-098: Codex availability cache -- skip codex after failure
  // ISS-110: Changed from boolean to ISO timestamp with 10-minute TTL
  codexUnavailable: forgiveNull(z.boolean()),
  codexUnavailableSince: forgiveNull(z.string()),

  // Supersession tracking
  supersededBy: forgiveNull(z.string()),
  supersededSession: forgiveNull(z.string()),
  stealReason: forgiveNull(z.string()),

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
    dismissReason: forgiveNull(z.string()),
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
  // ISS-912: bounded rebuild-and-re-run retries when TEST/VERIFY establish
  // stale build artifacts before accepting a report. Nonnegative integers by
  // schema: a negative value would satisfy `retries < MAX` forever and turn
  // the bounded fail-open gate into a hard block, so a malformed counter
  // fails the parse loudly and names itself (ISS-907 doctrine: a repair or a
  // loose bound must not double as a corruption filter).
  testFreshnessRetryCount: z.number().int().min(0).default(0),
  verifyFreshnessRetryCount: z.number().int().min(0).default(0),
  verifyAutoDetected: z.boolean().default(false),

  // T-128: Resolved recipe (frozen at session start, survives compact/resume)
  resolvedPipeline: z.array(z.string()).optional(),
  resolvedPostComplete: z.array(z.string()).optional(),
  resolvedRecipeId: forgiveNull(z.string()),
  resolvedStages: z.record(z.record(z.unknown())).optional(),
  resolvedDirtyFileHandling: forgiveNull(z.string()),
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
    handoverInterval: forgiveNull(z.number()),
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

  // ISS-904: plan-gate rounds for the CURRENT ticket that did not approve,
  // counted across rejects. A reject clears `reviews.plan`, so round numbers
  // restart at 1 and the reject loop -- the exact shape that produced three
  // hand-recorded campaign parks -- is invisible to any counter derived from
  // review history. Reset when a ticket is picked, parked, or approved.
  planGateNonApprovals: z.number().default(0),

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
    unresolvedCriticalCount: forgiveNull(z.number()),
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

  // T-450 step 6a: the durable cancellation transition record.
  //
  // DELIBERATELY `unknown`, and it stays that way. `CancellationTransitionSchema`
  // below is the strict shape; the reader that applies it to this field arrives
  // with the behavior half of 6a.
  //
  // WHY THE BOUNDARY MUST BE TOLERANT. `readSessionDetailed` (session.ts:963)
  // runs THIS schema, and `findSessionByIdDetailed` runs it before
  // `handleCancel` is reachable at all. A strict field here would make a
  // malformed transition report a corrupt SESSION, so the fail-closed
  // fall-through the recovery path is meant to reach would be unreachable code.
  //
  // ISS-556 is the nearest precedent and the mechanism is deliberately
  // DIFFERENT. There, the schema stays strict and `parseSessionResilient`
  // (session.ts:432-462) recovers after the fact, but only from one enumerated
  // corruption (`lensReviewHistory[N].disposition` outside its enum) and only
  // by DELETING the offending entries. Neither half transfers: a transition
  // record can be malformed in ways that cannot be enumerated in advance, and
  // deleting it would destroy the very intent recovery exists to read. What
  // does transfer is the principle stated at session.ts:388-396, that
  // historical metadata must not make a live session unreachable.
  cancellationTransition: z.unknown().optional(),
  /**
   * THE TAKEOVER POSTIMAGE (T-450 6b, ruling ea611619 B5/B6): the durable
   * proof that a candidate takeover was COMMITTED, written by
   * commitCandidateTakeover atomically with the ownership fields it proves,
   * in the SAME state write. One field, not an array: retirement is the only
   * exit from `closed`, so a cycle's proof is always consumed before the next
   * cycle could overwrite it, and every archived cycle's audit link survives
   * in the archive's raw bytes.
   *
   * `z.unknown()` for the same reason as cancellationTransition above: a
   * typed-strict sub-record would brick the whole session parse on one
   * malformed field. The dedicated strict reader is
   * `CandidateTakeoverPostimageSchema`, and a value that fails it is
   * "takeover-postimage-unreadable", which is a REFUSAL, deliberately
   * distinct from absent-means-underivable.
   */
  candidateTakeover: z.unknown().optional(),

  /**
   * T-450: the heartbeat generation this session's owner is bound to, published
   * by `commitCandidateTakeoverLocked` in the same atomic write as the
   * ownership rebind. `readOwnerLiveness` resolves the telemetry directory from
   * it, so an owner's liveness evidence is scoped to the generation that owner
   * established rather than shared with every owner in turn.
   *
   * DECLARED, not merely tolerated. It has been persisted since step 6b and
   * survived a schema round-trip only because this object ends `.passthrough()`
   * -- while its two untyped neighbours above are each declared with a reason.
   * A later tightening of that passthrough would have silently dropped the one
   * field the whole generation feature rests on, and the failure would have
   * been a session reading its own liveness out of the previous owner's
   * directory.
   *
   * Declaring it now cannot break a migration, because there is nothing to
   * migrate: `candidate-recovery.ts` has ZERO importers in `src`, so nothing
   * persisted anywhere carries this field yet. That is the same safety argument
   * that made the REQUIRED `cycleNonce` acceptable under ruling ea611619, and it
   * is why this is a declaration rather than a filed schema risk.
   *
   * `z.unknown()` for the same reason as those neighbours: the strict reader is
   * `resolveTelemetryLocation`, which deliberately takes `unknown` and refuses
   * anything that is not a valid id rather than falling back to the legacy
   * directory. A typed field here would move that refusal into the whole-session
   * parse, bricking a session over one damaged value.
   */
  heartbeatGeneration: z.unknown().optional(),
}).passthrough();

export type FullSessionState = z.infer<typeof SessionStateSchema>;

// ---------------------------------------------------------------------------
// T-450 step 6a: the cancellation transition record
//
// The durable answer to "what had the crashed process already done?". Every
// constraint below exists because the alternative is a FALSE durable record,
// which is worse than an absent one: an absent record leaves recovery open,
// while a false one closes it against a lie.
// ---------------------------------------------------------------------------

/**
 * What the stash pop actually did.
 *
 * `indeterminate` is the honest terminal value when a crash makes the answer
 * unknowable, and it is NOT a synonym for failure: `failed` is reserved for a
 * pop that was attempted and OBSERVED to fail. There is deliberately no fifth
 * spelling such as `unknown`; two names for one state is how audit records
 * start disagreeing with each other.
 */
export const StashPopOutcomeSchema = z.enum(["popped", "failed", "none", "indeterminate"]);
export type StashPopOutcome = z.infer<typeof StashPopOutcomeSchema>;

/**
 * What was DONE, never what was believed.
 *
 * Ruling A: a durable record names the action and its authority, because it is
 * read in isolation long after anyone remembers the context that produced it.
 * `candidate_recovery_takeover` is declared here in 6a although only 6b writes
 * it, so 6b needs no schema migration, and so an unrecognized action can be
 * refused rather than guessed at.
 *
 * ISS-967: `candidate_recovery_cancellation` was MISSING, and the cancel commit
 * therefore stamped the takeover value into the record of a session it had just
 * ENDED. `authority.kind` cannot disambiguate the two, because `candidate` is
 * correct for both operations, so the record read in isolation said the exact
 * opposite of what happened -- the failure this docstring exists to prevent.
 * Added ADDITIVELY: nothing is removed or repurposed, so every record already
 * written stays readable, and the takeover literal remains accepted wherever a
 * pre-fix cycle recorded one. The cross-field `superRefine` below needed no
 * change to its PAIRING LOGIC, which was verified rather than assumed: it
 * enforces the pairing in BOTH directions -- `ordinary_cancellation` may not
 * carry candidate authority, and either candidate action requires it -- and a
 * third non-ordinary value satisfies that on both sides. Its refusal MESSAGE
 * did need changing, because it named one action unconditionally.
 */
export const CancellationActionSchema = z.enum([
  "ordinary_cancellation",
  "candidate_recovery_takeover",
  "candidate_recovery_cancellation",
]);
export type CancellationAction = z.infer<typeof CancellationActionSchema>;

/**
 * The canonical `Date.prototype.toISOString()` grammar, and only that.
 *
 * Persisted timestamps here are compared for BYTE equality against session
 * state, so a merely parseable spelling (`+00:00`, no milliseconds, a space
 * separator) could never match and would strand recovery forever. The refine
 * proves the value is a real instant that round-trips to itself.
 */
export const CanonicalInstantSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "must be a canonical toISOString() instant")
  .refine((v) => {
    const parsed = new Date(v);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === v;
  }, "must round-trip through Date.toISOString()");

/**
 * The PERSISTED projection of owner-liveness evidence.
 *
 * `OwnerLivenessSignals` is a TypeScript interface, which proves nothing about
 * bytes that came off disk. 6b persists evidence inside an authority record, so
 * the durability boundary needs a real runtime schema.
 *
 * THIS MIRRORS THE ACTUAL SIGNAL UNIONS, field for field, rather than flattening
 * them into a generic `{kind, state}` list. A lossy projection would be worse
 * than none: `evidenceFingerprint` digests specific VALUES (the stored
 * timestamp, the expiry, the recorded pid), so evidence that survived a lossy
 * round trip could never re-derive the fingerprint it was stored with, and the
 * confirmation check 6b exists to perform would reject every legitimate
 * confirmation. Every arm below is `.strict()` for the same reason the source
 * unions are discriminated: an arm that quietly accepts a foreign field is an
 * arm that can carry a claim nobody validated.
 *
 * The TS type is INFERRED from the schema rather than declared beside it, so
 * the two cannot drift.
 */
const TelemetryUnusableReasonSchema = z.enum([
  "malformed-generation-id",
  "generation-escapes-telemetry",
  "generation-path-unresolvable",
]);

export const PersistedOwnerActivitySignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fresh"), at: z.string().min(1), ageMs: z.number() }).strict(),
  z.object({ kind: z.literal("stale"), at: z.string().min(1), ageMs: z.number() }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.enum(["absent", "unparseable", "future"]) }).strict(),
]);

export const PersistedLeaseSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), expiresAt: z.string().min(1), remainingMs: z.number() }).strict(),
  z.object({ kind: z.literal("expired"), expiresAt: z.string().min(1), agoMs: z.number() }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.enum(["absent", "unparseable"]) }).strict(),
]);

export const PersistedDeathMarkerSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shutdown-marker"), at: z.string().min(1).nullable() }).strict(),
  z.object({ kind: z.literal("alive-zero"), at: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("none"), aliveAt: z.number() }).strict(),
  z.object({
    kind: z.literal("unreadable"),
    reason: z.union([
      z.enum(["absent", "non-numeric", "future", "raced", "no-marker-time"]),
      TelemetryUnusableReasonSchema,
    ]),
  }).strict(),
]);

export const PersistedMarkerValiditySignalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invalidated"),
    reason: z.enum(["recorded-mcp-pid-alive", "superseded-by-owner-identity"]),
    pid: z.number().int(),
    recordedAt: z.string().min(1).nullable(),
    successorPids: z.array(z.number().int()).max(64).optional(),
  }).strict(),
  z.object({
    kind: z.literal("not-invalidated"),
    pid: z.number().int(),
    recordedAt: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    kind: z.literal("unknown"),
    reason: z.enum([
      "no-recorded-pid",
      "pid-probe-failed",
      "successors-unavailable",
      "owner-identity-unrecorded",
      "successor-identity-unknown",
    ]),
    pid: z.number().int().nullable(),
  }).strict(),
]);

export const PersistedSidecarProbeSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("match"), pid: z.number().int() }).strict(),
  z.object({ kind: z.literal("absent"), pid: z.number().int() }).strict(),
  z.object({
    kind: z.literal("unknown"),
    reason: z.union([z.enum(["no-pid", "probe-unknown"]), TelemetryUnusableReasonSchema]),
    pid: z.number().int().nullable(),
  }).strict(),
]);

/**
 * A registered server, mirroring `RegisteredServer` (mcp-registry.ts:53-80).
 *
 * `identity` is the load-bearing field, not an optional extra: an entry whose
 * identity equals the session's owner proves the owner's client is alive NOW,
 * which is the only thing that positively invalidates the death marker on
 * succession grounds. It is REQUIRED and nullable, never absent, because `null`
 * carries real meaning here (an unattributable server, which resolves to
 * undetermined rather than to either verdict) and a missing key would let that
 * distinction be lost in persistence.
 */
export const PersistedRegisteredServerSchema = z.object({
  pid: z.number().int(),
  identity: z.object({
    client: z.enum(["claude", "codex"]),
    id: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN),
    // NOT `.min(1)`. The registry normalizer (mcp-registry.ts:190) yields
    // `boundAt: ""` whenever the stored entry omits this display-only field,
    // and that identity is still fully valid for succession, which is decided
    // by client and id alone. Requiring a non-empty value here would make the
    // persisted schema reject evidence the producer legitimately emits.
    boundAt: z.string(),
  }).strict().nullable(),
  // Display and audit only per ruling C-2, but the fingerprint may legitimately
  // include it, so it round-trips exactly.
  registeredAt: z.string().min(1).nullable(),
}).strict();

export const PersistedSuccessorServersSchema = z.discriminatedUnion("kind", [
  // `unavailable` is NOT an empty `servers`: empty means the registry was read
  // and nothing else is running, while unavailable means it could not be read,
  // so nothing is confirmed or ruled out. Keeping them distinct is why this is
  // a union rather than a nullable array.
  z.object({
    kind: z.literal("observed"),
    servers: z.array(PersistedRegisteredServerSchema).max(64),
  }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: z.string().max(512) }).strict(),
]);

export const PersistedLivenessEvidenceSchema = z.object({
  activity: PersistedOwnerActivitySignalSchema,
  lease: PersistedLeaseSignalSchema,
  deathMarker: PersistedDeathMarkerSignalSchema,
  markerValidity: PersistedMarkerValiditySignalSchema,
  sidecarProbe: PersistedSidecarProbeSignalSchema,
  observedAt: z.string().min(1),
  staleThresholdMs: z.number().int().min(0),
  successors: PersistedSuccessorServersSchema,
}).strict();
export type PersistedLivenessEvidence = z.infer<typeof PersistedLivenessEvidenceSchema>;

/**
 * Who authorized this cancellation.
 *
 * Separate ARMS rather than a `kind` plus optional fields, so that the
 * contradictions are unrepresentable instead of merely unwritten: the shape
 * this replaced admitted `basis: "task"` with a null caller id, which asserts
 * an identity check that never happened.
 *
 * `legacy` is not a degraded `task`. It records that no task identity existed
 * at cancel time, which is the true state for pre-identity sessions, and it
 * stays recoverable precisely because refusing it would strand exactly the
 * sessions most likely to need recovery.
 */
export const CancellationAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("legacy") }).strict(),
  z.object({
    kind: z.literal("task"),
    callerTaskId: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN),
  }).strict(),
  z.object({
    kind: z.literal("candidate"),
    clientTaskId: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN),
    confirmedSessionRevision: z.number().int().min(0),
    confirmedFingerprint: z.string().min(1).max(256),
    evidence: PersistedLivenessEvidenceSchema,
  }).strict(),
]);
export type CancellationAuthority = z.infer<typeof CancellationAuthoritySchema>;

/** The persisted ticket disposition, mirroring the in-memory union. */
export const PersistedTicketDispositionSchema = z.union([
  z.object({ kind: z.literal("not-authorized") }).strict(),
  z.object({ kind: z.literal("no-ticket") }).strict(),
  z.object({ kind: z.literal("released"), ticketId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("conflict"), ticketId: z.string().min(1) }).strict(),
  // `unchanged` is split BY REASON because the reasons disagree about the
  // ticket id. `empty-id` is the case where the id itself was empty, which the
  // cancel path reaches at guide.ts:3010 with `ticketId: ""`, so a blanket
  // `.min(1)` would refuse to record a REACHABLE disposition. The other two
  // reasons always name a ticket. Separate arms also make the contradictions
  // (`empty-id` with a real id, `missing` with none) unrepresentable.
  z.object({
    kind: z.literal("unchanged"),
    ticketId: z.literal(""),
    reason: z.literal("empty-id"),
  }).strict(),
  z.object({
    kind: z.literal("unchanged"),
    ticketId: z.string().min(1),
    reason: z.enum(["missing", "not-inprogress"]),
  }).strict(),
  z.object({ kind: z.literal("failed"), ticketId: z.string().min(1) }).strict(),
]);
export type PersistedTicketDisposition = z.infer<typeof PersistedTicketDispositionSchema>;

/** The one and only shutdown-result artifact basename. See `shutdownArtifact`. */
export const CANCELLATION_SHUTDOWN_ARTIFACT = "cancellation-shutdown.json" as const;

/** What the verified shutdown actually did, and what became of the resume marker. */
export const CancellationShutdownResultSchema = z.object({
  sidecar: z.enum(["signalled", "already-absent", "declined"]),
  resumeMarker: z.enum(["removed", "absent", "preserved-foreign", "preserved-unstructured"]),
  detail: z.string().max(512).optional(),
}).strict();

/**
 * THE predicate for a transition identifier, exported so a pre-write gate can
 * apply the very schema the reader will, by reference rather than by parallel
 * construction. A second spelling of "is this a uuid" is a drift waiting to
 * happen: a gate that accepts what the reader refuses writes records that can
 * never be read again.
 */
export const TransitionIdSchema = z.string().uuid();

const transitionCommon = {
  transitionId: TransitionIdSchema,
  action: CancellationActionSchema,
  authority: CancellationAuthoritySchema,
  disposition: PersistedTicketDispositionSchema,
  // IDENTITY BINDING. `sessionStartedAt` cannot serve this role: it is
  // wall-clock and millisecond-granular, so two sessions can carry the same
  // value and a transplanted record would pass a timestamp check and apply
  // another session's disposition, authority and stash outcome here. Typed as
  // a uuid to match `SessionStateSchema.sessionId`, so a record that could
  // never name a real session fails the strict reader rather than the
  // comparison.
  sessionId: z.string().uuid(),
  // PROVENANCE only, checked in addition to the id, never instead of it.
  sessionStartedAt: CanonicalInstantSchema,
  transitionStartedRevision: z.number().int().min(0),
};

/**
 * Phases are separate ARMS because `endedAt` and `terminalRevision` do not
 * EXIST before publication. A flat record with optional fields would let a
 * writer set a termination time on a session that had not terminated, and an
 * auditor would have no way to tell that apart from a real one.
 */
export const CancellationTransitionSchema = z.discriminatedUnion("phase", [
  z.object({
    ...transitionCommon,
    phase: z.literal("stash_pending"),
    // `null` means "not yet decided", which is only ever true before
    // publication.
    stash: z.object({ outcome: StashPopOutcomeSchema.nullable() }).strict(),
  }).strict(),
  z.object({
    ...transitionCommon,
    phase: z.literal("published"),
    // Concrete by construction: publication is where the outcome becomes
    // final, and the honest terminal value for an unknowable pop is
    // `indeterminate`, never `null`.
    stash: z.object({ outcome: StashPopOutcomeSchema }).strict(),
    endedAt: CanonicalInstantSchema,
    terminalRevision: z.number().int().min(0),
    // NO shutdown result here, deliberately. Publication is write 4 and the
    // sidecar shutdown and resume-marker removal are step 5, so nothing at
    // this point can know their outcomes; a field for them could only ever be
    // fabricated, or bought by reordering the characterized tail, or by an
    // unplanned extra state write. The outcomes live in the durable
    // shutdown-result artifact, which the completion gate reads back and
    // verifies. What the transition CAN carry is a precomputable pointer to
    // that artifact, which is enough for recovery to find and classify it.
    shutdownArtifact: z.object({
      schemaVersion: z.literal(1),
      // A LITERAL, not a pattern. Commit B resolves this against the session
      // telemetry directory, so any string field here is an instruction from a
      // file the operator may have edited: separators, `..` segments, an
      // absolute path or a Windows-style prefix would each redirect a read or
      // write outside the telemetry directory. There is exactly one shutdown
      // artifact per session, so the name never needs to vary, and a literal
      // removes the traversal surface entirely rather than trying to filter it.
      filename: z.literal(CANCELLATION_SHUTDOWN_ARTIFACT),
    }).strict(),
  }).strict(),
]).superRefine((value, ctx) => {
  // THE CROSS-FIELD RULE. Each half parses alone; the PAIRING is the lie.
  // Enforced in the schema rather than at call sites because an audit record is
  // read in isolation, where no call site is around to have been careful.
  const ordinary = value.action === "ordinary_cancellation";
  const candidate = value.authority.kind === "candidate";
  if (ordinary === candidate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authority", "kind"],
      // ACTION-AWARE (ISS-967 follow-up). This branch used to name
      // `candidate_recovery_takeover` unconditionally, so a
      // `candidate_recovery_cancellation` record carrying legacy or task
      // authority was correctly rejected while the diagnostic named an action
      // the record does not contain. This schema exists for records read in
      // ISOLATION, so a message that misnames the record it is refusing is the
      // same class of defect as the record misnaming itself.
      message: ordinary
        ? "ordinary_cancellation cannot carry candidate authority"
        : `${value.action} requires candidate authority`,
    });
  }
});
export type CancellationTransition = z.infer<typeof CancellationTransitionSchema>;

// ---------------------------------------------------------------------------
// The durable candidate-cancellation intent (T-450 step 6b)
// ---------------------------------------------------------------------------

/** The one and only intent basename. Lives in the session directory, NOT in
 * `state.json`: the candidate invariant `transitionStartedRevision ===
 * confirmedSessionRevision + 1` requires that nothing increments the session
 * revision between authorize and write 1, so the pre-publication phases must
 * be durable without a session write. */
export const CANCELLATION_INTENT_FILE = "cancellation-intent.json" as const;

/**
 * `Field<T>` in its persisted spelling, exactly the in-memory shape
 * (claim-reconciliation.ts): presence and value are SEPARATE facts, and
 * `value` is REQUIRED and nullable rather than optional. `claim` deleted
 * versus `claim: null` are different ledger states (ISS-759 gates on key
 * presence, not truthiness): the first persists `{present: false, value:
 * null}`, the second `{present: true, value: null}`, and a schema that could
 * not carry the explicit null would collapse a release into a null write.
 */
const PersistedFieldSchema = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ present: z.boolean(), value: inner.nullable() }).strict();

const PersistedClaimSchema = z.object({
  user: z.string().nullable(),
  branch: z.string().nullable(),
  since: z.string().nullable(),
}).strict();

export const PersistedClaimEpochSchema = z.object({
  ticketId: z.string().min(1),
  sessionId: z.string(),
  user: z.string().nullable(),
  branch: z.string().nullable(),
  since: z.string().nullable(),
  establishedAt: z.string(),
}).strict();

/** The claim-bearing slice of a ticket at a moment in time, exactly the shape
 * `recoverClaimTransaction` compares against. */
export const PersistedTicketSnapshotSchema = z.object({
  ticketId: z.string().min(1),
  lifecycle: PersistedFieldSchema(z.string()),
  status: PersistedFieldSchema(z.string()),
  completedDate: PersistedFieldSchema(z.string()),
  claim: PersistedFieldSchema(PersistedClaimSchema),
  claimedBySession: PersistedFieldSchema(z.string()),
}).strict();
export type PersistedTicketSnapshot = z.infer<typeof PersistedTicketSnapshotSchema>;

/** A `ClaimTxn` in its persisted spelling, nested INSIDE the intent so the
 * claim transaction and the cancellation it serves cannot be orphaned from
 * one another by a crash between two files. */
const persistedClaimTxnCore = {
  kind: z.enum(["acquire", "release", "complete"]),
  ticketId: z.string().min(1),
  transitionId: z.string().uuid(),
  fromEpoch: PersistedClaimEpochSchema.nullable(),
  toEpoch: PersistedClaimEpochSchema.nullable(),
  fromBusiness: PersistedTicketSnapshotSchema,
  toBusiness: PersistedTicketSnapshotSchema,
  startedAt: z.string().min(1),
};
export const PersistedClaimTxnSchema = z.discriminatedUnion("phase", [
  z.object({ ...persistedClaimTxnCore, phase: z.literal("prepared") }).strict(),
  z.object({ ...persistedClaimTxnCore, phase: z.literal("ticket_applied") }).strict(),
]);
export type PersistedClaimTxn = z.infer<typeof PersistedClaimTxnSchema>;

/**
 * The takeover's evidence bundle: what the auditor reads, and what the
 * derivability proof deliberately does NOT. `argvProof` lives here per
 * liveness.ts's sidecar-termination contract (a degraded-unknown acceptance
 * must be visible to an auditor), and the proof never reads it: a
 * degraded-unknown takeover retires on identical proof to a proven one,
 * because derivability asks whether the record exists and names this cycle,
 * not how strongly the takeover was authorized.
 */
export const CandidateRecoveryEvidenceSchema = z.object({
  /** How the sidecar-termination authorization was proven, per liveness.ts. */
  argvProof: z.enum(["proven", "degraded-unknown"]),
  /** The liveness picture the human confirmed, persisted verbatim. */
  liveness: PersistedLivenessEvidenceSchema,
}).strict();

export type CandidateRecoveryEvidence = z.infer<typeof CandidateRecoveryEvidenceSchema>;

/**
 * The DEDICATED STRICT READER for `state.candidateTakeover` (ruling ea611619
 * B5/B6). Proof fields are strict; `evidence` is opaque (`z.unknown()`) to
 * the PROOF, though writers validate it against
 * CandidateRecoveryEvidenceSchema before writing, because no writer may
 * produce a record its own reader refuses.
 *
 * `takeoverKind`, not `disposition`: the name deliberately avoids colliding
 * with PersistedTicketDispositionSchema's `disposition`, whose values mean
 * something else entirely. `confirmationEpoch` is AUDIT ONLY and is never
 * compared by any proof: adoption is legal after the postimage is written,
 * so the closed intent may legitimately sit at a higher epoch than the
 * postimage captured, and comparing would make exactly those recovery
 * histories permanently unretirable. NO revision field, so nothing here can
 * disagree with `committedRevision`.
 */
export const CandidateTakeoverPostimageSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("candidate_takeover_committed"),
  /** DECISIVE for the proof: equality with the closed intent's cycleNonce. */
  cycleNonce: z.string().uuid(),
  takeoverKind: z.literal("owner_gone_candidate_takeover"),
  /** Corroboration, by reference so writer and reader share one predicate. */
  intentTransitionId: TransitionIdSchema,
  clientTaskId: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN),
  confirmationEpoch: z.number().int().min(0),
  evidence: z.unknown(),
}).strict();

export type CandidateTakeoverPostimage = z.infer<typeof CandidateTakeoverPostimageSchema>;

const intentCommon = {
  schemaVersion: z.literal(1),
  /** Pre-minted at authorize; write 1 carries it verbatim. Superseded only
   * while ticket work has not begun (the R2 adoption rule). */
  transitionId: z.string().uuid(),
  /**
   * THE CYCLE'S OWN IDENTITY, minted internally by the writer that births the
   * cycle (create, supersession's replacement, retirement's replacement) and
   * NEVER accepted from a caller. It exists because nothing else can serve:
   * a revision counter is satisfied by any later write, a transitionId can be
   * copied off an archived record, and an epoch legally drifts under R2
   * adoption. The takeover postimage records this nonce, and retirement's
   * derivability proof matches on it DECISIVELY, so a doctored copy of an old
   * cycle's record can never make a new cycle's takeover look committed.
   *
   * REQUIRED, not optional, and that is safe: candidate-recovery has zero
   * production callers on origin/main, so no nonce-less persisted intent
   * exists anywhere. Collision-negligible randomUUID entropy is load-bearing,
   * since it is what lets the postimage omit sessionId/sessionStartedAt
   * (incarnation provenance is subsumed by nonce freshness: createSession
   * always mints a fresh uuid directory and fresh state).
   */
  cycleNonce: z.string().uuid(),
  /** Monotonic, bumped on EVERY re-authorization including
   * transitionId-preserving ones, so two confirmations can never collide on
   * the archive pathname their supersession writes. */
  confirmationEpoch: z.number().int().min(0),
  clientTaskId: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN),
  // IDENTITY + PROVENANCE, the same pair the transition record binds: session
  // directories are reused, so an intent left by an earlier incarnation
  // carries the right id and the wrong start time.
  sessionId: z.string().uuid(),
  sessionStartedAt: CanonicalInstantSchema,
  confirmedSessionRevision: z.number().int().min(0),
  confirmedFingerprint: z.string().min(1).max(256),
  evidence: PersistedLivenessEvidenceSchema,
  /** The ticket exactly as authorize read it, BEFORE anything touched it, so
   * recovery at any pre-publication boundary reconstructs the release
   * transaction deterministically. Null when the session held no ticket. */
  ticketPreimage: PersistedTicketSnapshotSchema.nullable(),
  /** Present only on an intent that superseded another; validated on
   * acceptance against the named archive's existence and content, so the
   * audit chain holds even when supersession changes the id. */
  predecessor: z.object({
    predecessorTransitionId: z.string().uuid(),
    predecessorEpoch: z.number().int().min(0),
    predecessorFingerprint: z.string().min(1).max(256),
  }).strict().optional(),
  /**
   * THE RECEIPT that an adoption ran, and the only thing that distinguishes a
   * completed adoption from the state it started in.
   *
   * Adoption replaces the confirmation pair in place under the SAME
   * transitionId, so after it lands the record is `epoch N+1, triple T`. A
   * caller retrying that exact adoption presents `epoch N+1, triple T` and
   * must be told "already done". A caller making a FIRST adoption request
   * that merely happens to carry the canonical epoch presents `epoch N,
   * triple T` against a record at `epoch N, triple T` -- identical equality,
   * completely different situation, and it must be refused, because two
   * distinct re-authorizations may never collapse onto one epoch and evidence
   * cannot separate them (the fingerprint is time-independent by design).
   *
   * Recording the epoch adopted FROM separates them: a record that was
   * created rather than adopted carries no receipt at all, so the equal-epoch
   * first request cannot be mistaken for a retry.
   */
  adoptedFromEpoch: z.number().int().min(0).optional(),
};

/**
 * Phases are separate ARMS for the same reason the transition record's are:
 * `claimTxn` does not EXIST outside prepared/ticket_applied, and the closed
 * outcome pointer does not exist before closure. A flat record with optional
 * fields would let a writer claim a phase whose obligations it never wrote.
 */
export const CancellationIntentSchema = z.discriminatedUnion("phase", [
  z.object({ ...intentCommon, phase: z.literal("authorized") }).strict(),
  // The nested transaction's phase is BOUND to the enclosing intent's, so an
  // intent cannot claim `prepared` while carrying a transaction that says the
  // ticket was already applied: that contradiction is exactly the ambiguity
  // recoverClaimTransaction persists the phase to rule out.
  z.object({
    ...intentCommon,
    phase: z.literal("prepared"),
    claimTxn: z.object({ ...persistedClaimTxnCore, phase: z.literal("prepared") }).strict(),
  }).strict(),
  z.object({
    ...intentCommon,
    phase: z.literal("ticket_applied"),
    claimTxn: z.object({ ...persistedClaimTxnCore, phase: z.literal("ticket_applied") }).strict(),
  }).strict(),
  z.object({ ...intentCommon, phase: z.literal("claim_cleared") }).strict(),
  z.object({
    ...intentCommon,
    phase: z.literal("closed"),
    /** Derivable evidence, not authority: closed-ness is confirmed from the
     * record this points at, never from this pointer alone. */
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("cancellation"), transitionId: z.string().uuid() }).strict(),
      z.object({ kind: z.literal("takeover"), committedRevision: z.number().int().min(0) }).strict(),
    ]),
  }).strict(),
]);
export type CancellationIntent = z.infer<typeof CancellationIntentSchema>;

/**
 * The single parse seam for persisted session state.
 *
 * Every production full `SessionStateSchema` validation of a state.json ends
 * here, so cross-field repairs that must see the RAW shape (ISS-918) live in
 * this function rather than in the schema. Call this instead of
 * `SessionStateSchema.safeParse` on anything that came off disk; parsing the
 * schema directly skips those repairs.
 */
export function parseSessionState(raw: unknown): z.SafeParseReturnType<unknown, FullSessionState> {
  return SessionStateSchema.safeParse(clearExplicitlyNulledCodexBlock(raw));
}

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

/**
 * ONE schema, used at BOTH boundaries (the MCP tool definition and the direct
 * guide path).
 *
 * Validating in only one of them is a hole rather than an inconvenience: an
 * earlier revision checked the fingerprint at the guide and left
 * `sessionRevision` to the MCP schema alone, so a non-MCP caller could pass a
 * negative, fractional or non-finite revision straight into a compare-and-swap.
 *
 * The digest shape is not decoration. `evidenceFingerprint` is a
 * `createHash("sha256").digest("hex")`, so 64 lowercase hex characters is the
 * only thing a real confirmation can be.
 */
export const OwnerGoneCandidateTakeoverSchema = z.object({
  sessionRevision: z.number().int().nonnegative().finite(),
  evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type OwnerGoneCandidateTakeover = z.infer<typeof OwnerGoneCandidateTakeoverSchema>;

/**
 * The CANCEL door's confirmation (T-450 step 8), same two fields for the same
 * reasons, and deliberately its OWN schema rather than a reuse of the takeover
 * one.
 *
 * The fields match today because the confirmed picture is the same artifact.
 * They are not the same CONTRACT: sharing one object would make any later
 * divergence (cancel gaining a disposition hint, say) a silent change to the
 * takeover door's published input. Each door's schema is named after its door,
 * so a change to one cannot reach the other by accident.
 *
 * Both doors validate at BOTH boundaries for the reason given above: the MCP
 * schema alone would let a non-MCP caller push a negative, fractional or
 * non-finite revision into a compare-and-swap.
 */
export const OwnerGoneCandidateCancelSchema = z.object({
  sessionRevision: z.number().int().nonnegative().finite(),
  evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type OwnerGoneCandidateCancel = z.infer<typeof OwnerGoneCandidateCancelSchema>;

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
  /**
   * T-450 step 7b: the confirmed picture behind an owner-gone candidate
   * TAKEOVER of a LIVE, non-COMPACT session.
   *
   * Its own field rather than a widening of `takeover`, for the same reason
   * `ownerGoneCandidateCancel` is its own field: `takeover` is a SHIPPED
   * published boolean, and changing its type changes what an already-advertised
   * field means. A carrier is unavoidable in any case, because the handshake
   * decides on two values only the CLIENT can know -- the revision a human was
   * shown, and the digest of the picture they were shown -- so symmetry with
   * cancel is the only defensible shape.
   */
  readonly ownerGoneCandidateTakeover?: OwnerGoneCandidateTakeover;
  /**
   * T-450 step 8. The confirmed owner-gone picture authorizing a CANCELLATION
   * of a session whose recorded owner is gone: the door that ENDS such a
   * session rather than adopting it.
   *
   * NO SECOND FLAG accompanies this one, and the asymmetry with the takeover
   * field is deliberate rather than an oversight. `takeover: true` is a real
   * second decision on `resume` ("adopt rather than refuse"), and it is
   * refused outright on any action but `resume`, so cancel could not require
   * it without relaxing a shipped rule. On `cancel` the ACTION is already the
   * destructive intent, so this field's presence plus the two values it
   * carries is the whole request.
   *
   * Supplying it REQUIRES an explicit `sessionId`. `handleCancel` otherwise
   * auto-selects an active session, and this object names a revision and a
   * fingerprint but no session, so a human who confirmed a picture for one
   * session could end another with nothing downstream able to notice.
   */
  readonly ownerGoneCandidateCancel?: OwnerGoneCandidateCancel;
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
