import { z } from "zod";
import { CLIENT_TASK_ID_PATTERN } from "../autonomous/client-profile.js";

export const BUS_SCHEMA_VERSION = 2 as const;
export const DEFAULT_BUS_MAX_BODY_BYTES = 16 * 1024;
export const DEFAULT_BUS_MAX_HOPS = 8;
export const BUS_MAX_ENTRY_BYTES = 32 * 1024;
// ISS-953: a refused (parked-and-dropped) message's full payload is preserved as
// a standalone artifact rather than embedded in the immutable entry chain. This
// is a READ-side cap, deliberately independent of (and larger than) the 32KiB
// WRITE-side BUS_MAX_ENTRY_BYTES: the write path (refused.ts's
// writeRefusedArtifact, called by store.ts) can never legitimately produce
// an artifact anywhere near this size, since it only ever runs after the
// same entry-size gate that bounds an ordinary message to
// BUS_MAX_ENTRY_BYTES. This cap instead defends the READ path against a
// corrupted or hand-edited file on disk, whose size is not bounded by anything --
// it must fail the read cleanly rather than exhaust memory. Do NOT "harmonize"
// the two constants to match; they bound different things.
export const BUS_MAX_REFUSED_PAYLOAD_BYTES = 64 * 1024;

const IsoTimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UuidSchema = z.string().uuid();
const OpaqueStringSchema = z.string().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value),
  "Control characters are not allowed",
);
const GitObjectSchema = z.string().regex(/^[a-f0-9]{4,64}$/i);

// BusRole survives only as a derived display concept and for reading archived v1
// records. v2 messages are endpoint-addressed; role is never declared or enforced.
export const BusRoleSchema = z.enum(["implementer", "reviewer"]);
export type BusRole = z.infer<typeof BusRoleSchema>;

export const BusClientSchema = z.enum(["claude", "codex"]);
export type BusClient = z.infer<typeof BusClientSchema>;

export const BusSurfaceSchema = z.enum(["claude_cli", "codex_cli", "codex_desktop"]);
export type BusSurface = z.infer<typeof BusSurfaceSchema>;

export const BusThreadKindSchema = z.enum([
  "issue_notice",
  "question",
  "coordination",
  "patch_request",
]);
export type BusThreadKind = z.infer<typeof BusThreadKindSchema>;

export const BusMessageKindSchema = z.enum([
  "issue_notice",
  "question",
  "reply",
  "status",
  "patch_request",
  "claim",
  "release",
]);
export type BusMessageKind = z.infer<typeof BusMessageKindSchema>;

export const BusSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type BusSeverity = z.infer<typeof BusSeveritySchema>;

/**
 * Derived role rule (single source of truth). issue_notice/patch_request imply
 * the sender acted as reviewer; claim/release imply implementer; question/reply/
 * status are unlabeled (null). Used only for display/export/poll envelopes. No
 * enforcement: any endpoint may send any kind (that is the fluidity).
 */
export function derivedRole(kind: BusMessageKind): BusRole | null {
  if (kind === "issue_notice" || kind === "patch_request") return "reviewer";
  if (kind === "claim" || kind === "release") return "implementer";
  return null;
}

export const BusTopicRefSchema = z.object({
  issue: OpaqueStringSchema.optional(),
  ticket: OpaqueStringSchema.optional(),
  commit: GitObjectSchema.optional(),
  ciRun: OpaqueStringSchema.optional(),
}).passthrough().refine(
  (value) => value.issue !== undefined || value.ticket !== undefined ||
    value.commit !== undefined || value.ciRun !== undefined,
  "At least one topic reference is required",
);
export type BusTopicRef = z.infer<typeof BusTopicRefSchema>;

export const BusEvidenceRefSchema = z.object({
  commit: GitObjectSchema.optional(),
  ciRun: OpaqueStringSchema.optional(),
}).passthrough().refine(
  (value) => value.commit !== undefined || value.ciRun !== undefined,
  "A commit or CI run reference is required",
);
export type BusEvidenceRef = z.infer<typeof BusEvidenceRefSchema>;

export const BusThreadRecordSchema = z.object({
  schema: z.literal("storybloq-bus-thread/v2"),
  threadId: UuidSchema,
  kind: BusThreadKindSchema,
  topicRef: BusTopicRefSchema,
  participants: z.tuple([UuidSchema, UuidSchema]).refine(
    ([first, second]) => first !== second,
    "Thread participants must be two distinct endpoints",
  ),
  maxHops: z.number().int().min(2).max(32),
  createdByEndpoint: UuidSchema,
  createdAt: IsoTimestampSchema,
  predecessorThreadId: UuidSchema.optional(),
  // ISS-953: names WHY this thread has a predecessor, distinct from the
  // ordinary resolved-predecessor successor case (predecessorRelation absent).
  // The only value today is "hop_cap_successor" -- a thread minted to carry a
  // dropped hop-cap park's content forward. Scopes the narrow createThread
  // exceptions (predecessor need not be resolved; first-message-kind check
  // widened) to exactly this relation, never generalizing to plain successors.
  predecessorRelation: z.literal("hop_cap_successor").optional(),
  // ISS-953: present only alongside predecessorRelation === "hop_cap_successor" --
  // the entryHash of the predecessor's park entry this thread was minted to
  // redeliver. Lets resolveRefusals verify a candidate successor's identity
  // self-consistently against the thread record itself, not only against the
  // redeliver marker (which lives in the PREDECESSOR's directory and could, in a
  // corruption scenario, disagree with what the successor actually is).
  predecessorEntryHash: Sha256Schema.optional(),
  threadHash: Sha256Schema,
}).passthrough().superRefine((value, ctx) => {
  // ISS-953 Codex round 2 finding #6: predecessorRelation and
  // predecessorEntryHash describe one inseparable relation together with
  // predecessorThreadId. Declaring only some of the three previously
  // core-folded as valid even though the combination is nonsensical (e.g. a
  // predecessorEntryHash with no predecessorRelation to explain what it names).
  // A record with all three absent (the ordinary, ISS-953-unrelated shape,
  // including every pre-wave record) remains valid, unaffected by this check.
  const hasRelation = value.predecessorRelation !== undefined;
  const hasEntryHash = value.predecessorEntryHash !== undefined;
  const hasThreadId = value.predecessorThreadId !== undefined;
  if ((hasRelation || hasEntryHash) && !(hasRelation && hasEntryHash && hasThreadId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["predecessorRelation"],
      // ISS-953 Codex round 3 finding #7 (order item 11): the previous wording
      // ("all three present together or all absent") misstated the contract this
      // very predicate implements. predecessorThreadId ALONE is deliberately
      // valid -- it is the ordinary, pre-ISS-953 resolved-thread-successor shape,
      // and the guard above only fires once predecessorRelation or
      // predecessorEntryHash appears. A caller hitting this error with a valid
      // predecessorThreadId was told to remove it, which is the opposite of the
      // fix. The wording below states the implemented rule exactly.
      message: "predecessorRelation and predecessorEntryHash must either both be absent, or both be present with predecessorThreadId",
    });
  }
});
export type BusThreadRecord = z.infer<typeof BusThreadRecordSchema>;

export const BusMessageRefsSchema = z.object({
  issue: OpaqueStringSchema.optional(),
  ticket: OpaqueStringSchema.optional(),
  commit: GitObjectSchema.optional(),
  ciRun: OpaqueStringSchema.optional(),
  files: z.array(z.string().min(1).max(1024)).max(64).optional(),
}).passthrough();
export type BusMessageRefs = z.infer<typeof BusMessageRefsSchema>;

export const BusMessagePayloadSchema = z.object({
  messageId: UuidSchema,
  from: z.object({
    endpointId: UuidSchema,
    client: BusClientSchema,
    authority: z.literal("peer_agent"),
  }).passthrough(),
  to: UuidSchema,
  kind: BusMessageKindSchema,
  severity: BusSeveritySchema,
  body: z.string().min(1).max(65536),
  refs: BusMessageRefsSchema,
  inReplyTo: UuidSchema.nullable(),
  idempotencyKeyHash: Sha256Schema,
  payloadHash: Sha256Schema,
}).passthrough();
export type BusMessagePayload = z.infer<typeof BusMessagePayloadSchema>;

export const BusAckPayloadSchema = z.object({
  messageId: UuidSchema,
  byEndpoint: UuidSchema,
  disposition: z.enum(["accepted", "rejected", "deferred"]),
  reason: z.string().min(1).max(4096).optional(),
}).passthrough().superRefine((value, ctx) => {
  if ((value.disposition === "rejected" || value.disposition === "deferred") && !value.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "A reason is required" });
  }
});
export type BusAckPayload = z.infer<typeof BusAckPayloadSchema>;

// ISS-953: the refused message's identity, small and always present on the
// entry itself (no artifact read needed to know WHAT was dropped, only to
// recover its full content). Declared, not .passthrough(): this is read by
// the ship gate's severity check, so an unrecognized extra field must not
// silently pass validation and be trusted.
//
// evidenceKeys is optional at this parse layer on purpose (same additive
// pattern as droppedMessage itself, round 5 finding b): it is populated by the
// write path for every park from here forward, but a park entry written before
// this field existed has none, and that population must keep parsing rather
// than fail.
//
// ISS-953 Codex round 4 finding #6: corrected to match fold's ACTUAL
// preference order, which is the opposite of what this comment said before --
// fold prefers keys derived FRESH from a currently RESOLVED artifact, not this
// persisted field. The artifact is content-addressed by refusedPayloadHash:
// readRefusedArtifact re-derives canonicalHash from the artifact's actual
// content and compares it against the filename on every read (refused.ts), so
// tampering its refs is DETECTABLE (the artifact fails to resolve, reported
// corrupt) rather than physically prevented -- nothing stops a write at the
// same filename with different content, only the re-hash-and-compare on read
// catches the mismatch. This is still a stronger guarantee than this
// persisted copy, which lives inside a hash-chained entry whose own hash a
// tamperer can freely recompute (Codex round 2 finding #24).
// Fold falls back to this persisted field only when the artifact does NOT
// resolve (missing or corrupt for an unrelated reason, e.g. later deleted) --
// preserving fix step 16's original resilience goal for exactly the case it
// was meant for: seen-ness must not depend on the artifact still being
// resolvable years later, only on it being trustworthy RIGHT NOW when both
// copies are available to compare. Entries from before this field existed
// keep the old artifact-only coupling; that is a known residual, not a fix,
// and the population is fixed and shrinking.
export const BusDroppedMessageSchema = z.object({
  messageKind: BusMessageKindSchema,
  severity: BusSeveritySchema,
  refusedPayloadHash: Sha256Schema,
  evidenceKeys: z.array(z.string()).optional(),
}).strict();
export type BusDroppedMessage = z.infer<typeof BusDroppedMessageSchema>;

// ISS-953: the refused message's FULL recoverable content, stored at
// refused/<refusedPayloadHash>.json, content-addressed by the canonical hash of
// this exact shape. Declared, not .passthrough(): EEXIST recovery and doctor both
// hash-verify a parsed artifact against its filename, so an unrecognized extra
// field must not silently survive validation and be trusted as part of the hash.
// Deliberately excludes inReplyTo -- fix step 12 redelivers only messageKind,
// severity, body, and refs; a reply-target id from the predecessor thread would
// dangle in the successor thread it is redelivered into.
export const BusRefusedArtifactSchema = z.object({
  schema: z.literal("storybloq-bus-refused-artifact/v1"),
  messageKind: BusMessageKindSchema,
  severity: BusSeveritySchema,
  body: z.string().min(1).max(65536),
  refs: BusMessageRefsSchema,
}).strict();
export type BusRefusedArtifact = z.infer<typeof BusRefusedArtifactSchema>;

export const BusStatePayloadSchema = z.object({
  action: z.enum(["park", "resolve", "reopen"]),
  byEndpoint: UuidSchema,
  reason: z.string().min(1).max(4096).optional(),
  resolution: z.string().min(1).max(8192).optional(),
  evidence: BusEvidenceRefSchema.optional(),
  automatic: z.boolean().optional(),
  trigger: z.enum(["hop_cap", "duplicate_fingerprint"]).optional(),
  // For an AUTOMATIC park ONLY: bind the park state entry to the exact idempotent send
  // operation that triggered it. entryHash covers the payload, so these are tamper-
  // evident; committedAutomaticPark requires both to match the replaying receipt, so a
  // tampered receipt whose stateEntryHash names a DIFFERENT same-endpoint automatic park
  // is rejected rather than misattributed. Absent on manual park/resolve/reopen.
  idempotencyKeyHash: Sha256Schema.optional(),
  payloadHash: Sha256Schema.optional(),
  // ISS-953: identity of the message this automatic park dropped, present on
  // every NEW automatic park going forward. Kept OPTIONAL at the schema layer
  // (no refinement gating presence by action/trigger) so every historical
  // automatic park entry -- immutable, hash-chained, predating this field --
  // still parses exactly as it always has. The "always present on a new park"
  // rule is enforced only in the write path, never retroactively.
  droppedMessage: BusDroppedMessageSchema.optional(),
}).passthrough().superRefine((value, ctx) => {
  // ISS-953 Codex round 3 finding #6: droppedMessage was otherwise accepted on
  // ANY state action and without automatic === true or a valid park trigger --
  // permitting malformed shapes like a resolve/reopen record carrying refused-
  // message identity, or an "automatic" park with no trigger at all, which
  // downstream refusal logic (fold.ts's resolveRefusals, round 3 finding #2)
  // can misclassify or silently ignore. Gated on droppedMessage's PRESENCE
  // only: an entry with droppedMessage absent (every historical automatic
  // park predating this field, and every non-park entry) is untouched by this
  // check, preserving the "kept optional, no refinement gating presence"
  // backward-compat contract the comment above documents.
  if (value.droppedMessage !== undefined) {
    const validTrigger = value.trigger === "hop_cap" || value.trigger === "duplicate_fingerprint";
    if (value.action !== "park" || value.automatic !== true || !validTrigger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["droppedMessage"],
        message: "droppedMessage may only appear on an automatic park entry (action \"park\", automatic true) with a valid trigger (\"hop_cap\" or \"duplicate_fingerprint\")",
      });
    }
  }
});
export type BusStatePayload = z.infer<typeof BusStatePayloadSchema>;

export const BusWakePayloadSchema = z.object({
  wakeId: UuidSchema,
  endpointId: UuidSchema,
  attempt: z.number().int().min(1).max(3),
  batchCursor: z.number().int().nonnegative(),
  action: z.enum(["requested", "poll_observed", "failed"]),
  reason: z.string().min(1).max(1024).optional(),
}).passthrough();
export type BusWakePayload = z.infer<typeof BusWakePayloadSchema>;

const BusEntryBaseSchema = z.object({
  schema: z.literal("storybloq-bus-entry/v2"),
  entryId: UuidSchema,
  threadId: UuidSchema,
  seq: z.number().int().positive(),
  prevHash: Sha256Schema,
  createdAt: IsoTimestampSchema,
  entryHash: Sha256Schema,
});

export const BusEntrySchema = z.discriminatedUnion("type", [
  BusEntryBaseSchema.extend({ type: z.literal("message"), payload: BusMessagePayloadSchema }).passthrough(),
  BusEntryBaseSchema.extend({ type: z.literal("ack"), payload: BusAckPayloadSchema }).passthrough(),
  BusEntryBaseSchema.extend({ type: z.literal("state"), payload: BusStatePayloadSchema }).passthrough(),
  BusEntryBaseSchema.extend({ type: z.literal("wake"), payload: BusWakePayloadSchema }).passthrough(),
]);
export type BusEntry = z.infer<typeof BusEntrySchema>;

export const BusMailboxPointerSchema = z.object({
  schema: z.literal("storybloq-bus-mailbox/v2"),
  endpointId: UuidSchema,
  mailboxSeq: z.number().int().positive(),
  messageId: UuidSchema,
  threadId: UuidSchema,
  entrySeq: z.number().int().positive(),
  entryHash: Sha256Schema,
  createdAt: IsoTimestampSchema,
}).passthrough();
export type BusMailboxPointer = z.infer<typeof BusMailboxPointerSchema>;

export const BusMailboxCounterSchema = z.object({
  schema: z.literal("storybloq-bus-mailbox-counter/v1"),
  nextSeq: z.number().int().positive(),
  updatedAt: IsoTimestampSchema,
}).passthrough();
export type BusMailboxCounter = z.infer<typeof BusMailboxCounterSchema>;

export const BusProcessRefSchema = z.object({
  pid: z.number().int().positive(),
  signature: z.string().min(1).max(512),
  capturedAt: IsoTimestampSchema,
}).passthrough();
export type BusProcessRef = z.infer<typeof BusProcessRefSchema>;

// T-427 on-tool activation: proof the PostToolUse hook actually FIRED for this
// endpoint's currently-bound session. Recorded (once per session) by the tool-hook
// handler. Validity is by IDENTITY match, no TTL: the on-tool channel is "active"
// only while this record's taskId still equals the endpoint's bound clientTaskId,
// so a session rebind reverts the channel to inactive until the new session's hook
// fires. The realistic disable paths (`bus hooks disable`, `bus setup --delivery
// poll`) flip the hook policy, which is gated separately, so a stale activation can
// never keep the label on after delivery is turned off. `hookCommand` records the
// command that fired (observability); `updatedAt` is informational only.
export const BusHookActivationSchema = z.object({
  taskId: z.string().regex(CLIENT_TASK_ID_PATTERN),
  hookCommand: z.string().min(1).max(4096),
  updatedAt: IsoTimestampSchema,
}).passthrough();
export type BusHookActivation = z.infer<typeof BusHookActivationSchema>;

export const BusEndpointSchema = z.object({
  schema: z.literal("storybloq-bus-endpoint/v2"),
  endpointId: UuidSchema,
  client: BusClientSchema,
  surface: BusSurfaceSchema,
  clientTaskId: z.string().regex(CLIENT_TASK_ID_PATTERN),
  resumeHandle: OpaqueStringSchema.nullable(),
  projectRoot: z.string().min(1).max(4096),
  gitBranch: z.string().min(1).max(1024).nullable(),
  worktreeId: Sha256Schema,
  processRef: BusProcessRefSchema.nullable(),
  state: z.enum(["attached", "offline", "unknown"]),
  joinedAt: IsoTimestampSchema,
  lastSeenAt: IsoTimestampSchema,
  wakePolicy: z.enum(["never", "offline_only"]),
  lastPolledMailboxSeq: z.number().int().nonnegative(),
  lastBlockedMailboxSeq: z.number().int().nonnegative(),
  // T-427: PostToolUse (on-tool) delivery keeps its OWN block high-water so the
  // best-effort mid-turn channel never suppresses the reliable Stop channel at
  // turn end. A real poll advances lastPolledMailboxSeq, which clears BOTH gates.
  // Optional (not defaulted) so the parsed OUTPUT type stays equal to the INPUT
  // type -- a `.default()` here would diverge them and break the generic
  // readJsonNoFollow inference. Consumers treat an absent value as 0.
  lastToolBlockedMailboxSeq: z.number().int().nonnegative().optional(),
  // T-427: on-tool activation proof (see BusHookActivationSchema). Additive,
  // passthrough-safe; an older endpoint record simply parses this as undefined and
  // gains it on the next durable write. Consumers treat undefined/null the same
  // ("not activated"). on-stop coverage derives from hook policy, not activation.
  toolHookActivation: BusHookActivationSchema.nullable().optional(),
  // ISS-872: succession back-link. When this endpoint was minted to replace a
  // proven-offline incumbent, it carries that incumbent's id so the read/ack/
  // administer seams can redeliver the predecessor's undelivered mail to this
  // successor and accept its authority over the inherited threads. Walked as a
  // bounded predecessor CHAIN (see endpointAddressees) so authority propagates
  // transitively across repeated replacement. Additive, undefaulted, passthrough-
  // safe: an older endpoint record parses this as undefined (no predecessor).
  predecessorEndpointId: UuidSchema.optional(),
  retiredAt: IsoTimestampSchema.nullable(),
  retiredReason: z.string().min(1).max(1024).nullable(),
}).passthrough();
export type BusEndpoint = z.infer<typeof BusEndpointSchema>;

export const BusSuccessionSchema = z.object({
  schema: z.literal("storybloq-bus-succession/v1"),
  successionId: UuidSchema,
  endpointId: UuidSchema,
  client: BusClientSchema,
  fromTaskId: z.string().regex(CLIENT_TASK_ID_PATTERN),
  toTaskId: z.string().regex(CLIENT_TASK_ID_PATTERN).optional(),
  transcriptHash: Sha256Schema,
  kind: z.enum(["compact", "wake"]),
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  consumedAt: IsoTimestampSchema.nullable(),
}).passthrough();
export type BusSuccession = z.infer<typeof BusSuccessionSchema>;

export interface FoldedBusThread {
  readonly thread: BusThreadRecord;
  readonly entries: readonly BusEntry[];
  readonly validThroughSeq: number;
  readonly lastHash: string;
  readonly state: "open" | "parked" | "resolved";
  readonly hopCount: number;
  readonly acknowledgments: ReadonlyMap<string, BusAckPayload>;
  readonly messages: readonly BusMessagePayload[];
  readonly seenEvidence: ReadonlySet<string>;
  readonly integrity: "verified" | "quarantined";
  readonly finding?: string;
  // ISS-953: this thread's entire automatic-park refusal history, chronological.
  // Populated ONLY when the caller opts in (foldBusThread's includeRefusals),
  // since resolving it means artifact/marker reads beyond the core hash-chain
  // walk. Empty for every fold that does not opt in -- never undefined, so
  // every consumer can treat it uniformly. See BusRefusal below for field detail.
  readonly refusals: readonly BusRefusal[];
}

// ISS-953: a durable, permanent record binding one dropped park entry to (at
// most) exactly one redeliver successor thread. Declared, not .passthrough():
// EEXIST recovery schema-validates this file before trusting any field on it,
// so an unrecognized extra field must not silently survive validation.
export const BusRedeliverMarkerSchema = z.object({
  schema: z.literal("storybloq-bus-redeliver-marker/v1"),
  predecessorThreadId: UuidSchema,
  predecessorEntryHash: Sha256Schema,
  originalByEndpoint: UuidSchema,
  successorThreadId: UuidSchema,
  createdAt: IsoTimestampSchema,
  // ISS-1002 interim remedy (ISS-953 Codex round 5 finding #10): set only when
  // this marker's own record claims it durably superseded an EARLIER marker
  // at the same path whose successorThreadId named no existing thread ("pending" per
  // verifiedSuccessorState) -- createHopCapSuccessorThread no longer adopts
  // that id, since a "pending" verdict cannot distinguish a benign crash
  // window from a forged claim (see fold.ts's verifiedSuccessorState header
  // comment). Additive and optional so every pre-ISS-1002 marker on disk
  // still parses unchanged. Observability only, per the pen's ruling: the
  // discarded id must be visible to an operator (surfaced by the doctor via
  // BusRefusal below), not silently dropped.
  discardedSuccessorThreadId: UuidSchema.optional(),
}).strict();
export type BusRedeliverMarker = z.infer<typeof BusRedeliverMarkerSchema>;

// ISS-953: one automatic park's dropped message, resolved independently for a
// thread's entire refusal history (not only its currently-terminal park).
// Computed by an OPT-IN pass (resolveRefusals) that runs after foldBusThread's
// core hash-chain walk, invoked directly by foldBusThread itself when called
// with `{ includeRefusals: true }` -- ISS-953 Codex round 5 finding #8
// corrected the earlier claim that this never happens as part of
// foldBusThread; it does, when opted in. Opts-less folds skip it entirely,
// and it is never invoked by resolving another thread's OWN refusals (marker
// verification uses only that thread's CORE fold), so verifying one thread's
// refusals is always exactly one hop deep regardless of how long a rollover
// chain runs.
export interface BusRefusal {
  readonly entryHash: string;
  readonly byEndpoint: string;
  // ISS-953 Codex round 4 finding #2: widened to include "invalid" -- an
  // absent or malformed payload.trigger must be represented honestly rather
  // than normalized to "hop_cap" for consumers reading this field directly
  // (store.ts's markdown thread export, the field's only consumer). "invalid"
  // is a fold-time classification of malformed data; it is never a value a
  // park entry's own payload.trigger legitimately carries (BusStatePayloadSchema,
  // above, restricts that field to "hop_cap" | "duplicate_fingerprint").
  readonly trigger: "hop_cap" | "duplicate_fingerprint" | "invalid";
  readonly droppedMessage: BusDroppedMessage;
  readonly artifactStatus: "resolved" | "missing" | "corrupt";
  readonly disposition: "redelivered" | "unresolved";
  readonly markerState: "none" | "pending" | "verified" | "invalid";
  readonly successorThreadId?: string;
  // ISS-1002 interim remedy: present only when the CURRENT on-disk marker is
  // BOUND to this exact refusal (markerState "pending" or "verified") and its
  // own record claims it durably superseded an earlier "pending" claim (see
  // BusRedeliverMarkerSchema.discardedSuccessorThreadId). Never populated for
  // markerState "none" or "invalid" -- resolveRefusals (fold.ts) gates on
  // markerState itself, not merely on whether a marker file was present and
  // schema-parseable, per ISS-953 Codex round 6 finding #2/#3: a present but
  // unbound (or malformed-trigger) marker previously slipped past a weaker
  // gate and populated this field despite markerState being "invalid".
  readonly discardedSuccessorThreadId?: string;
}

export type BusSetupState =
  | "disabled"
  | "not_initialized"
  | "invalid"
  | "runtime_lost"
  | "disconnected"
  | "waiting_for_peer"
  | "ready";

export type BusDeliveryMode = "live" | "partial" | "poll";

// T-427 honest delivery labels. Structured, per-channel coverage that never
// oversells the model: `onStop` is the turn-boundary channel (both clients have a
// Stop hook, so it is tri-state over participants); `onTool` is the mid-turn
// PostToolUse channel, which is Claude-only (Codex has no PostToolUse). onTool is
// computed per ACTIVE ENDPOINT, not per distinct client, so it can never overstate
// coverage: `all` only when every active endpoint is a tool-active Claude, `partial`
// when some (but not all) active Claude endpoints are tool-active, `claude_only` when
// every active Claude endpoint is tool-active but a Codex peer (no PostToolUse) is
// also present, and `none` otherwise. A channel counts an endpoint only when its hook
// is enabled by policy AND activation evidence proves the hook fired in that
// endpoint's currently-bound session.
export interface BusDeliveryCapabilities {
  readonly onStop: "none" | "partial" | "all";
  readonly onTool: "none" | "partial" | "claude_only" | "all";
}

// T-427 honest label (single source of truth; reused by both the core status
// formatter and the `bus` CLI so the wording never drifts). Describes the actual
// enabled delivery TIERS and deliberately never emits the word "live": the on-tool
// tier notifies at the next tool boundary and the on-stop tier at turn end, and
// neither is a real-time push. A `partial`/`claude_only` channel is annotated so a
// two-client Bus where only one side is wired does not read as fully covered.
export function describeDeliveryTiers(caps: BusDeliveryCapabilities): string {
  const tiers: string[] = [];
  if (caps.onStop !== "none") tiers.push(caps.onStop === "partial" ? "on-stop (partial)" : "on-stop");
  if (caps.onTool !== "none") {
    tiers.push(
      caps.onTool === "claude_only" ? "on-tool (Claude only)"
        : caps.onTool === "partial" ? "on-tool (partial)"
          : "on-tool",
    );
  }
  return tiers.length === 0 ? "poll" : tiers.join(" + ");
}

export interface BusParticipantSummary {
  readonly client: BusClient;
  readonly surface: BusSurface;
  readonly state: "attached" | "offline" | "unknown";
}

export interface BusSummary {
  readonly enabled: boolean;
  readonly initialized: boolean;
  readonly daemonState: "stopped";
  readonly setupState: BusSetupState;
  readonly deliveryMode: BusDeliveryMode;
  readonly participants: readonly BusParticipantSummary[];
  readonly nextActions: readonly string[];
  readonly endpoints: number;
  readonly pendingMessages: number;
  readonly unacknowledgedCritical: number;
  readonly openThreads: number;
  readonly parkedThreads: number;
  readonly undeliverable: number;
  readonly quarantined: number;
  readonly hookDelivery: {
    readonly claude: boolean;
    readonly codex: boolean;
  };
  readonly deliveryCapabilities: BusDeliveryCapabilities;
}
