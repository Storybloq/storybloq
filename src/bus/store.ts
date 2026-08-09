import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadProject } from "../core/project-loader.js";
import { displayIdOf } from "../core/resolver.js";
import type { ProjectState } from "../core/project-state.js";
import { normalizeClientTaskId } from "../autonomous/client-profile.js";
import { assertBusEnabled, isBusEnabled } from "./config.js";
import { canonicalHash, hashWithoutKey } from "./canonical.js";
import { endpointAddressees, listEndpoints, withEndpointCaller } from "./endpoints.js";
import { BusError } from "./errors.js";
import { ensureDerivedThread, foldBusThread, verifiedSuccessorState, writeDerivedThread } from "./fold.js";
import {
  BusReceiptSchema,
  readReceipt,
  removeReceipt,
  writeReceipt,
  type BusReceipt,
} from "./idempotency.js";
import {
  durableCreate,
  durableRename,
  durableUnlink,
  durableWrite,
  listRegularJsonFiles,
  readJsonNoFollow,
  syncDirectory,
} from "./io.js";
import { withHardenedLock } from "./lock.js";
import { readBusHookPolicy } from "./hooks.js";
import {
  assessBusRuntime,
  assessBusRuntimeAtPaths,
  classifyBusRuntime,
  readBusInstance,
  resolveInitializedBusPaths,
  runtimeLostError,
  type BusRuntimeAssessment,
} from "./admin.js";
import { readBusEvidence } from "./runtime-evidence.js";
import { readConsistentRefusedArtifact, validatedRefusedDir, writeRefusedArtifact } from "./refused.js";
import { ackV1, doctorV1, exportV1Thread, summarizeV1 } from "./legacy-v1.js";
import {
  assertBusLayout,
  busLayoutFindings,
  endpointMailboxPath,
  resolveBusPaths,
  validatedRedeliverMarkerDir,
  type BusPaths,
} from "./paths.js";
import {
  BUS_MAX_ENTRY_BYTES,
  BusEndpointSchema,
  BusEntrySchema,
  BusEvidenceRefSchema,
  BusMailboxCounterSchema,
  BusMailboxPointerSchema,
  BusMessageKindSchema,
  BusMessageRefsSchema,
  BusRedeliverMarkerSchema,
  BusSeveritySchema,
  BusSuccessionSchema,
  BusThreadKindSchema,
  BusThreadRecordSchema,
  derivedRole,
  type BusAckPayload,
  type BusClient,
  type BusDeliveryCapabilities,
  type BusDeliveryMode,
  type BusEndpoint,
  type BusEntry,
  type BusEvidenceRef,
  type BusMailboxPointer,
  type BusMessageKind,
  type BusMessagePayload,
  type BusMessageRefs,
  type BusParticipantSummary,
  type BusRedeliverMarker,
  type BusRole,
  type BusSetupState,
  type BusSeverity,
  type BusStatePayload,
  type BusSummary,
  type BusThreadKind,
  type BusThreadRecord,
  type FoldedBusThread,
} from "./schemas.js";
import {
  actionableFingerprint,
  assertNoHighConfidenceSecret,
  evidenceKeys,
  idempotencyKeyHash,
  normalizeBusText,
  normalizeMessageBody,
  normalizeMessageRefs,
} from "./security.js";

const ThreadIdSchema = z.string().uuid();
const EndpointIdSchema = z.string().uuid();
const MessageIdSchema = z.string().uuid();
const POINTER_FILENAME = /^(\d{12})-([0-9a-f-]{36})\.json$/;

// Test-only seam: fires inside mailboxHasPointerCandidate AFTER a directory's initial
// lstat succeeds and BEFORE its readdir, so a test can delete/swap the directory mid-scan
// and prove the probe escalates (throws) rather than reporting a false "empty".
let afterMailboxLstatHook: ((dir: string) => Promise<void>) | null = null;
let materializeFailureHook: (() => Promise<void>) | null = null;
let countFailureHook: (() => Promise<void>) | null = null;
const RECEIPT_FILENAME = /^([a-f0-9]{64})\.json$/;
const ACTIONABLE_KINDS = new Set<BusMessageKind>(["issue_notice", "question", "reply", "patch_request"]);

export interface BusSendInput {
  readonly endpointId: string;
  readonly clientTaskId: string;
  readonly threadId?: string;
  readonly threadKind?: BusThreadKind;
  readonly messageKind: BusMessageKind;
  readonly severity: BusSeverity;
  readonly body: string;
  readonly refs?: BusMessageRefs;
  readonly inReplyTo?: string | null;
  readonly idempotencyKey: string;
  readonly predecessorThreadId?: string;
  // ISS-953: names WHY predecessorThreadId is set, scoping createThread's narrow
  // hop_cap_successor exceptions (fix step 11) to exactly the redeliver operation.
  // Absent for the ordinary resolved-predecessor successor case.
  readonly predecessorRelation?: "hop_cap_successor";
  // ISS-953: for predecessorRelation === "hop_cap_successor" only -- the park entry
  // whose dropped content this send redelivers. Part of the operation's identity
  // (fix step 7), so a reused idempotencyKey against a different authorizing park
  // entry recomputes a different payloadHash and fails idempotency_conflict.
  readonly refusedEntryHash?: string;
}

export interface BusSendResult {
  readonly threadId: string;
  readonly messageId: string | null;
  readonly toEndpoint: string;
  readonly state: "open" | "parked" | "resolved";
  readonly hopCount: number;
  // Actionable sends remaining on this thread before the hop cap parks the next
  // one, from either participant's perspective: max(0, thread.maxHops - hopCount).
  // Lets a sender roll to a successor thread at a natural boundary instead of
  // discovering the cap only after tripping it (ISS-953).
  readonly hopsRemaining: number;
  // ISS-953 fix step 12: `replayed` stays backward-compatible, redefined as
  // `replaySource !== "none"` at every construction site below (never computed
  // ad hoc) -- so a caller reading only the legacy boolean sees `true` for BOTH
  // an ordinary receipt replay AND a marker replay, never mistaking either for a
  // fresh operation. `replaySource` is the orthogonal, precise field: "none"
  // creates and finalizes a new receipt for a genuinely fresh operation;
  // "receipt" returns through an already-existing verified receipt (a pure read,
  // no new receipt written); "marker" returns through a verified redeliver
  // marker with no caller receipt involved at all.
  readonly replayed: boolean;
  readonly replaySource: "none" | "receipt" | "marker";
  readonly parked: boolean;
  // ISS-953 fix step 13: trigger-specific guidance for a parked result. Present
  // only when this operation's outcome is a hop_cap park (never for
  // duplicate_fingerprint, which has no redeliver path, and never for a
  // non-parked result). A replay of an already-parked hop_cap send recomputes
  // this eligibility from the same durable park entry on every call, rather
  // than caching the original result -- it returns the same nextAction only
  // while the entry, its resolved artifact, and its linked issue all remain
  // redeliverable, and null once any of them stops being true.
  readonly nextAction: { readonly procedure: "redeliver_on_hop_cap_successor"; readonly refusedEntryHash: string; readonly predecessorThreadId: string } | null;
}

// ISS-953 fix step 12: `storybloq_bus_redeliver`'s public input. No caller-supplied
// kind/body/refs/idempotencyKey/recipient at all -- content is always resolved
// server-side from the refused artifact the predecessor's park entry names.
export interface BusRedeliverInput {
  readonly endpointId: string;
  readonly clientTaskId: string;
  readonly predecessorThreadId: string;
  readonly refusedEntryHash: string;
}

export interface BusPollEnvelope {
  readonly source: "storybloq_bus";
  readonly authority: "peer_agent";
  readonly integrity: "verified" | "quarantined";
  readonly sender: { readonly endpointId: string; readonly client: BusClient; readonly role: BusRole | null };
  readonly threadId: string;
  readonly mailboxSeq: number;
  readonly message: BusMessagePayload;
}

export interface BusPollResult {
  readonly endpointId: string;
  readonly cursor: number;
  readonly messages: readonly BusPollEnvelope[];
  readonly findings: readonly string[];
}

interface NormalizedSend {
  readonly toEndpointId: string;
  readonly messageKind: BusMessageKind;
  readonly severity: BusSeverity;
  readonly body: string;
  readonly refs: BusMessageRefs;
  readonly inReplyTo: string | null;
  readonly keyHash: string;
  readonly payloadHash: string;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function padSeq(seq: number, width = 6): string {
  return String(seq).padStart(width, "0");
}

function entryFilename(entry: BusEntry): string {
  return `${padSeq(entry.seq)}-${entry.type}-${entry.entryId}.json`;
}

function pointerFilename(pointer: BusMailboxPointer): string {
  return `${padSeq(pointer.mailboxSeq, 12)}-${pointer.messageId}.json`;
}

function participantsInclude(thread: BusThreadRecord, endpointId: string): boolean {
  return thread.participants[0] === endpointId || thread.participants[1] === endpointId;
}

// ISS-872: a pointer is canonically valid iff its thread folds verified and the entry
// it names is a message whose hash, id, and recipient match the pointer (and the
// recipient is one this endpoint may receive). Mirrors pollBus's delivery validation.
// The succession sweep uses this so a corrupt pointer (valid envelope, wrong canonical
// binding) never authorizes deleting an ancestor's only valid pointer, and a
// canonically mismatched ancestor pointer is preserved as corruption evidence.
function pointerMatchesCanonical(
  folded: FoldedBusThread | null,
  pointer: BusMailboxPointer,
  addressees: readonly string[],
): boolean {
  if (!folded || folded.integrity !== "verified") return false;
  const entry = folded.entries[pointer.entrySeq - 1];
  return !!entry && entry.type === "message" && entry.entryHash === pointer.entryHash &&
    entry.payload.messageId === pointer.messageId && addressees.includes(entry.payload.to);
}

function makeEntry<T extends BusEntry["type"]>(input: {
  type: T;
  threadId: string;
  seq: number;
  prevHash: string;
  payload: Extract<BusEntry, { type: T }>["payload"];
}): Extract<BusEntry, { type: T }> {
  const unsigned = {
    schema: "storybloq-bus-entry/v2" as const,
    entryId: randomUUID(),
    threadId: input.threadId,
    seq: input.seq,
    type: input.type,
    prevHash: input.prevHash,
    payload: input.payload,
    createdAt: new Date().toISOString(),
    entryHash: "0".repeat(64),
  };
  const signed = { ...unsigned, entryHash: hashWithoutKey(unsigned, "entryHash") };
  return BusEntrySchema.parse(signed) as Extract<BusEntry, { type: T }>;
}

async function listThreadIds(paths: BusPaths): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(paths.threads, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new BusError("io_error", "Cannot enumerate Bus threads", err);
  }
  // A dot-prefixed name is not excluded here as a special case: the ThreadIdSchema
  // filter below already drops any name that is not a valid UUID (including a
  // dot-prefixed one). A dot-renamed thread directory is surfaced as an "invalid
  // thread directory" finding by the doctor's separate threads enumeration.
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => ThreadIdSchema.safeParse(name).success)
    .sort();
}

// Highest mailbox seq the recipient endpoint has already surfaced (blocked on either
// channel) or polled. Durable evidence used as a RECOVERY floor when reallocating a
// mailbox seq after counter.json is lost while the mailbox is empty: without it, neither
// the absent counter nor the empty pointer scan remembers already-delivered sequences,
// so a reallocated seq could land at or below lastPolled/lastBlocked and be suppressed
// forever by both hook gates. A missing endpoint record yields 0 (no evidence, no floor);
// the counter and pointer floors still apply. A corrupt/symlinked record fails closed.
async function endpointCursorFloor(paths: BusPaths, endpointId: string): Promise<number> {
  try {
    const endpoint = await readJsonNoFollow(join(paths.endpoints, `${endpointId}.json`), BusEndpointSchema);
    return Math.max(
      endpoint.lastPolledMailboxSeq,
      endpoint.lastBlockedMailboxSeq,
      endpoint.lastToolBlockedMailboxSeq ?? 0,
    );
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return 0;
    throw err;
  }
}

async function allocateMailboxSeq(paths: BusPaths, endpointId: string): Promise<number> {
  const mailbox = endpointMailboxPath(paths, endpointId);
  return withHardenedLock(join(paths.locks, `mailbox-${endpointId}.lock`), async () => {
    const counterPath = join(mailbox, "counter.json");
    let nextSeq = 1;
    try {
      nextSeq = (await readJsonNoFollow(counterPath, BusMailboxCounterSchema)).nextSeq;
    } catch (err) {
      if (!(err instanceof BusError) || err.code !== "not_found") throw err;
    }
    let pointerFloor = 1;
    for (const directory of [mailbox, join(mailbox, "pending")]) {
      for (const filename of await listRegularJsonFiles(directory)) {
        const match = POINTER_FILENAME.exec(filename);
        if (match) pointerFloor = Math.max(pointerFloor, Number(match[1]) + 1);
      }
    }
    // Fold in the endpoint's delivered-cursor floor so a lost counter (empty mailbox)
    // cannot regress the sequence below what the recipient already saw.
    const cursorFloor = await endpointCursorFloor(paths, endpointId);
    nextSeq = Math.max(nextSeq, pointerFloor, cursorFloor + 1);
    await durableWrite(counterPath, serialize({
      schema: "storybloq-bus-mailbox-counter/v1",
      nextSeq: nextSeq + 1,
      updatedAt: new Date().toISOString(),
    }));
    return nextSeq;
  });
}

function makePointer(endpointId: string, mailboxSeq: number, entry: Extract<BusEntry, { type: "message" }>): BusMailboxPointer {
  return BusMailboxPointerSchema.parse({
    schema: "storybloq-bus-mailbox/v2",
    endpointId,
    mailboxSeq,
    messageId: entry.payload.messageId,
    threadId: entry.threadId,
    entrySeq: entry.seq,
    entryHash: entry.entryHash,
    createdAt: entry.createdAt,
  });
}

async function publishPointerIntent(paths: BusPaths, pointer: BusMailboxPointer): Promise<{ pending: string; active: string }> {
  const mailbox = endpointMailboxPath(paths, pointer.endpointId);
  const filename = pointerFilename(pointer);
  const pending = join(mailbox, "pending", filename);
  const active = join(mailbox, filename);
  await durableCreate(pending, serialize(pointer));
  return { pending, active };
}

async function activatePointer(intent: { pending: string; active: string }): Promise<void> {
  try {
    await durableRename(intent.pending, intent.active);
  } catch {
    // The immutable pending intent is sufficient for poll recovery.
  }
}

function normalizeRefsAgainstProject(state: ProjectState, refs: BusMessageRefs): BusMessageRefs {
  const normalized = normalizeMessageRefs(refs);
  if (normalized.issue) {
    const resolved = state.resolveIssueRef(normalized.issue);
    if (resolved.kind !== "found") throw new BusError("invalid_input", `Issue reference not found or ambiguous: ${normalized.issue}`);
    normalized.issue = resolved.item.id;
  }
  if (normalized.ticket) {
    const resolved = state.resolveTicketRef(normalized.ticket);
    if (resolved.kind !== "found") throw new BusError("invalid_input", `Ticket reference not found or ambiguous: ${normalized.ticket}`);
    normalized.ticket = resolved.item.id;
  }
  return normalized;
}

function validateIssueNotice(state: ProjectState, kind: BusMessageKind, severity: BusSeverity, refs: BusMessageRefs): void {
  if (kind !== "issue_notice") return;
  if (!refs.issue) throw new BusError("invalid_input", "An issue notice requires an issue reference");
  const issue = state.issueByID(refs.issue);
  if (!issue) throw new BusError("invalid_input", `Issue does not exist: ${refs.issue}`);
  if (issue.status === "resolved") throw new BusError("invalid_input", `${displayIdOf(issue)} is already resolved`);
  if (issue.severity !== severity) {
    throw new BusError("invalid_input", `Issue notice severity must match ${displayIdOf(issue)} (${issue.severity})`);
  }
}

function validateCriticalReference(
  state: ProjectState,
  severity: BusSeverity,
  refs: BusMessageRefs,
  required: boolean,
): void {
  if (severity !== "critical" || !required) return;
  if (!refs.issue) throw new BusError("invalid_input", "A critical Bus message requires an issue reference");
  const issue = state.issueByID(refs.issue);
  if (!issue || issue.status === "resolved" || issue.severity !== "critical") {
    throw new BusError("invalid_input", "A critical Bus message requires an unresolved critical issue");
  }
}

function normalizeSend(
  state: ProjectState,
  maxBodyBytes: number,
  requireIssueForCritical: boolean,
  endpoint: BusEndpoint,
  toEndpointId: string,
  input: BusSendInput,
): NormalizedSend {
  const messageKind = BusMessageKindSchema.parse(input.messageKind);
  const severity = BusSeveritySchema.parse(input.severity);
  const body = normalizeMessageBody(input.body, maxBodyBytes);
  const refs = normalizeRefsAgainstProject(state, BusMessageRefsSchema.parse(input.refs ?? {}));
  validateIssueNotice(state, messageKind, severity, refs);
  validateCriticalReference(state, severity, refs, requireIssueForCritical);
  const inReplyTo = input.inReplyTo ?? null;
  if (inReplyTo && !MessageIdSchema.safeParse(inReplyTo).success) throw new BusError("invalid_input", "Invalid reply message id");
  const keyHash = idempotencyKeyHash(endpoint.endpointId, input.idempotencyKey);
  // payloadHash binds the resolved operation, including the recipient (D3), so a
  // reused key after the peer was replaced recomputes a different hash and fails
  // idempotency_conflict instead of silently replaying to the retired endpoint.
  //
  // ISS-953 fix step 7: predecessorRelation/refusedEntryHash are spread in only
  // when actually present, never as always-present nulls. JCS (the canonicalize
  // package backing canonicalHash) serializes an explicit `null` property, it
  // does not omit it, so an always-present `key: value ?? null` DOES change the
  // canonical JSON -- and therefore the hash -- for every ordinary send, not only
  // hop_cap_successor ones. That would invalidate every receipt.payloadHash
  // already on disk from before these two fields existed, turning a legitimate
  // retry of an unrelated ordinary send into a false idempotency_conflict.
  // predecessorThreadId is NOT part of this fix -- it already existed as an
  // always-present `?? null` in the hash shape before ISS-953 touched this
  // function at all (verify against HEAD, not this wave's diff), so keeping it
  // unconditional here is what preserves compatibility; making it conditional
  // too, as an earlier draft of this fix did, would have been ITS OWN backward-
  // compat break in the opposite direction, changing the hash for every existing
  // reply/predecessor-linked send that predates ISS-953.
  const payloadHash = canonicalHash({
    fromEndpoint: endpoint.endpointId,
    toEndpoint: toEndpointId,
    kind: messageKind,
    severity,
    body,
    refs,
    inReplyTo,
    threadKind: input.threadKind ?? null,
    targetThreadId: input.threadId ?? null,
    predecessorThreadId: input.predecessorThreadId ?? null,
    ...(input.predecessorRelation ? { predecessorRelation: input.predecessorRelation } : {}),
    ...(input.refusedEntryHash ? { refusedEntryHash: input.refusedEntryHash } : {}),
  });
  return { toEndpointId, messageKind, severity, body, refs, inReplyTo, keyHash, payloadHash };
}

function topicRefFrom(refs: BusMessageRefs): Record<string, string> {
  const topic = {
    ...(refs.issue ? { issue: refs.issue } : {}),
    ...(refs.ticket ? { ticket: refs.ticket } : {}),
    ...(refs.commit ? { commit: refs.commit } : {}),
    ...(refs.ciRun ? { ciRun: refs.ciRun } : {}),
  };
  if (Object.keys(topic).length === 0) {
    throw new BusError("invalid_input", "A new thread requires an issue, ticket, commit, or CI run reference");
  }
  return topic;
}

// ISS-953 fix step 11: a hop_cap_successor redeliver's first message is whatever
// ACTIONABLE_KINDS content actually got dropped mid-conversation (very often a
// plain "reply", since a hop-capped issue_notice thread's later hops rarely repeat
// the "issue_notice" kind) -- but the successor's threadKind stays fixed to
// "issue_notice" regardless, to keep it anchored to the canonical issue. This is a
// narrow, relation-scoped exception, never a general loosening of the ordinary
// first-message-matches-threadKind rule.
//
// The exception REQUIRES threadKind === "issue_notice", it does not merely permit
// it: falling through to the general `threadKind === messageKind` check for any
// OTHER declared threadKind would let a caller whose dropped message happens to
// share a kind with a non-issue_notice threadKind (e.g. both "question") sail
// through validation with a successor thread that is silently NOT anchored the
// way the ship gate and resolve-gate assume every issue-linked thread is
// (createHopCapSuccessorThread hard-codes "issue_notice" server-side regardless,
// so this is defense in depth, not the only guard -- but validation accepting a
// declaration it is about to override is its own bug, independent of that).
function validateInitialKinds(threadKind: BusThreadKind, messageKind: BusMessageKind, isHopCapSuccessor = false): void {
  if (isHopCapSuccessor) {
    if (threadKind !== "issue_notice") {
      throw new BusError("invalid_input", "hop_cap_successor redelivery must declare threadKind issue_notice");
    }
    // ISS-953 Codex round 2 finding #7: this exception replaces the ordinary
    // threadKind/messageKind pairing check above with only the issue_notice
    // requirement, and previously returned without enforcing anything about
    // messageKind at all -- a direct sendBusMessage caller could declare
    // status, claim, or release for a hop_cap_successor's first message even
    // though a park only ever drops an ACTIONABLE_KINDS message (the same
    // set the `overHopCap` hop-cap park trigger itself gates on). Normal
    // park creation supplies actionable content indirectly through that
    // gate; this direct-call path has no equivalent gate of its own.
    if (!ACTIONABLE_KINDS.has(messageKind)) {
      throw new BusError("invalid_input", `hop_cap_successor redelivery messageKind must be actionable, got ${messageKind}`);
    }
    return;
  }
  const valid = threadKind === "coordination"
    ? ["status", "claim", "release"].includes(messageKind)
    : threadKind === messageKind;
  if (!valid) throw new BusError("invalid_input", `Initial ${messageKind} message does not match ${threadKind} thread`);
}

// The budget for the NEXT actionable send on this thread, from either
// participant's perspective. Shared by every BusSendResult return site, and by
// bus_thread_get's serialized output, so the formula can never drift between
// the two surfaces (ISS-953).
export function hopsRemainingFor(folded: FoldedBusThread): number {
  return Math.max(0, folded.thread.maxHops - folded.hopCount);
}

// ISS-953 fix step 13: nextAction for a parked result, derived from the SAME
// durable park entry every time (never recomputed ad hoc), so a replay of an
// already-parked send reports identical guidance to the original result
// (fix step 14 test i). null for a duplicate_fingerprint park (no redeliver path
// exists for that trigger) and for anything that isn't a hop_cap park entry.
//
// Guard shape must match createHopCapSuccessorThread's and redeliverBusMessage's
// own "does this name a hop-cap automatic park entry" checks exactly (automatic,
// trigger, AND droppedMessage, not trigger alone) -- droppedMessage is new as of
// this wave (fix step 4), so a legacy automatic hop_cap park entry written before
// that field existed has trigger "hop_cap" with no droppedMessage. Offering
// redeliver_on_hop_cap_successor for one is a dead end: the redeliver call itself
// rejects that exact entry as invalid_input for the same missing field. A
// trigger-only check would offer guidance the very next call refuses to honor.
//
// Same reasoning extends to the PREDECESSOR thread itself, not just the park
// entry: createHopCapSuccessorThread additionally requires
// predecessor.thread.kind === "issue_notice" with a topicRef.issue present
// (an issue-linked issue_notice thread, since redelivery mints its successor
// with threadKind hard-coded to "issue_notice" and needs an issue to bind it
// to). A hop-cap park can occur on ANY thread kind -- nothing about the park
// trigger itself is issue_notice-specific -- so a park on, say, a bare
// "question" thread satisfies every check above while still being ineligible
// for redelivery. Checking it here, not only at the write site, is what keeps
// this a dead-end-free guidance the same way the droppedMessage check above
// does.
//
// ISS-953 Codex round 5 finding #8: the checks above are all STRUCTURAL (the
// park entry's own shape, the thread's kind/topic) -- none of them confirm the
// refused artifact the recommendation depends on is actually still resolvable.
// createHopCapSuccessorThread requires readConsistentRefusedArtifact to
// return "resolved" before it will proceed (store.ts, order item 8's own
// content re-verification); on a later replay, that artifact can have been
// deleted or corrupted out from under an otherwise-perfectly-valid park entry,
// and this function previously kept recommending redeliver_on_hop_cap_successor
// regardless -- a live dead end, not merely a structural one, and the exact
// failure mode the droppedMessage/thread-kind checks above already exist to
// prevent for their own cases. Async now so it can ask the same question
// createHopCapSuccessorThread itself asks before committing to the recommendation.
async function nextActionForPark(
  paths: BusPaths,
  folded: FoldedBusThread,
  parkEntryHash: string,
  threadId: string,
  projectState: ProjectState,
): Promise<BusSendResult["nextAction"]> {
  const entry = folded.entries.find((candidate) => candidate.entryHash === parkEntryHash);
  if (
    !entry || entry.type !== "state" || entry.payload.action !== "park" ||
    entry.payload.automatic !== true || entry.payload.trigger !== "hop_cap" ||
    !entry.payload.droppedMessage ||
    folded.thread.kind !== "issue_notice" || !folded.thread.topicRef.issue
  ) {
    return null;
  }
  // ISS-953 Codex round 6 finding #4: this guidance is advertised on every
  // replay of a parked receipt, but createHopCapSuccessorThread -- the ONLY
  // thing that ever actually executes this procedure -- separately requires
  // the linked issue to exist and be unresolved (store.ts, the
  // `!issue || issue.status === "resolved"` check just after its own
  // thread-kind/topicRef validation), and throws BusError("conflict") when it
  // doesn't. Without this check here, a replay after the linked issue is
  // resolved or removed still recommends redeliver_on_hop_cap_successor, a
  // dead end the caller cannot see coming until the actual redeliver call
  // rejects it -- the same class of gap round 5 finding #8 fixed for a
  // missing/corrupt artifact, now closed for the issue side of eligibility.
  const issue = projectState.issueByID(folded.thread.topicRef.issue);
  if (!issue || issue.status === "resolved") return null;
  const resolvedArtifact = await readConsistentRefusedArtifact(paths, entry.payload.droppedMessage);
  if (resolvedArtifact.status !== "resolved") return null;
  return { procedure: "redeliver_on_hop_cap_successor", refusedEntryHash: parkEntryHash, predecessorThreadId: threadId };
}

async function replayFromFold(
  paths: BusPaths,
  folded: FoldedBusThread,
  receipt: BusReceipt,
  projectState: ProjectState,
): Promise<BusSendResult> {
  return {
    threadId: receipt.threadId,
    messageId: receipt.messageId ?? null,
    toEndpoint: receipt.toEndpoint,
    state: folded.state,
    hopCount: folded.hopCount,
    hopsRemaining: hopsRemainingFor(folded),
    replaySource: "receipt",
    nextAction: receipt.outcome === "parked" && receipt.stateEntryHash
      ? await nextActionForPark(paths, folded, receipt.stateEntryHash, receipt.threadId, projectState)
      : null,
    replayed: true,
    // `parked` reports whether THIS operation was an automatic park, taken solely
    // from the receipt outcome. The thread's current state (which a later park could
    // flip) is conveyed separately by `state`, so replaying a delivered message after
    // the thread was later parked still returns parked:false with its real messageId.
    parked: receipt.outcome === "parked",
  };
}

// Resolves the sole active (non-retired) peer for the caller. Self-send is
// structurally impossible: the caller is never returned as its own peer.
async function resolveActivePeer(paths: BusPaths, selfEndpointId: string): Promise<BusEndpoint | null> {
  const { endpoints, findings } = await listEndpoints(paths.projectRoot);
  if (findings.length > 0) {
    throw new BusError("corrupt", `Endpoint registry is corrupt: ${findings[0]}`);
  }
  const peers = endpoints.filter((endpoint) => !endpoint.retiredAt && endpoint.endpointId !== selfEndpointId);
  if (peers.length === 0) return null;
  if (peers.length > 1) {
    throw new BusError("conflict", "Two-endpoint invariant violated: multiple active peers");
  }
  return peers[0] ?? null;
}

async function readThreadParticipants(paths: BusPaths, threadId: string): Promise<[string, string]> {
  const thread = await readJsonNoFollow(join(paths.threads, threadId, "thread.json"), BusThreadRecordSchema);
  if (thread.threadId !== threadId) throw new BusError("corrupt", "Thread id does not match its directory");
  return thread.participants as [string, string];
}

function messagePayload(
  endpoint: BusEndpoint,
  toEndpointId: string,
  normalized: NormalizedSend,
  messageId: string,
): BusMessagePayload {
  return {
    messageId,
    from: {
      endpointId: endpoint.endpointId,
      client: endpoint.client,
      authority: "peer_agent",
    },
    to: toEndpointId,
    kind: normalized.messageKind,
    severity: normalized.severity,
    body: normalized.body,
    refs: normalized.refs,
    inReplyTo: normalized.inReplyTo,
    idempotencyKeyHash: normalized.keyHash,
    payloadHash: normalized.payloadHash,
  };
}

function pendingReceiptFor(
  endpoint: BusEndpoint,
  normalized: NormalizedSend,
  publication: { threadId: string; messageId: string; mailboxSeq: number },
): BusReceipt {
  return BusReceiptSchema.parse({
    schema: "storybloq-bus-receipt/v1",
    endpointId: endpoint.endpointId,
    keyHash: normalized.keyHash,
    payloadHash: normalized.payloadHash,
    threadId: publication.threadId,
    toEndpoint: normalized.toEndpointId,
    messageId: publication.messageId,
    mailboxSeq: publication.mailboxSeq,
    state: "pending",
    createdAt: new Date().toISOString(),
  });
}

// An automatic park has no message and no mailbox pointer, so the receipt carries
// no messageId/mailboxSeq (permitted by the schema only when outcome is "parked").
// It is bound to the park state entry by `stateEntryHash`: the pending form is
// written BEFORE the park entry and finalized after, and recovery locates that
// exact entry in the chain regardless of the thread's later state (D3/#4/#R6-A).
function parkedReceiptFor(
  endpoint: BusEndpoint,
  normalized: NormalizedSend,
  threadId: string,
  toEndpointId: string,
  state: "pending" | "final",
  stateEntryHash: string,
): BusReceipt {
  return BusReceiptSchema.parse({
    schema: "storybloq-bus-receipt/v1",
    endpointId: endpoint.endpointId,
    keyHash: normalized.keyHash,
    payloadHash: normalized.payloadHash,
    threadId,
    toEndpoint: toEndpointId,
    state,
    outcome: "parked",
    stateEntryHash,
    createdAt: new Date().toISOString(),
  });
}

// Shared tail of every fresh thread-creation outcome (ordinary new thread, ordinary
// resolved-predecessor successor, and a hop_cap_successor's fresh-or-superseded-
// pending creation): preallocate-then-bind exactly as before this was factored out.
// `threadId` is caller-supplied rather than generated here so it can be pre-bound
// into a marker or receipt BEFORE this call, not because a LATER, separate call ever
// resumes publishing with an id it did not itself generate -- ISS-953 Codex byte-
// review fix: corrected a stale claim that a hop_cap_successor creation "resumes...
// after a crash, using the SAME id" as an earlier crashed call's marker. Since the
// ISS-1002 interim remedy, it never does: every call into createHopCapSuccessorThread
// that reaches this function generates and uses its OWN fresh id, superseding
// whatever marker it finds rather than adopting the id that marker names.
async function publishNewThread(
  paths: BusPaths,
  endpoint: BusEndpoint,
  toEndpointId: string,
  normalized: NormalizedSend,
  threadId: string,
  threadFields: {
    readonly kind: BusThreadKind;
    readonly topicRef: Record<string, string>;
    readonly maxHops: number;
    readonly predecessorThreadId?: string;
    readonly predecessorRelation?: "hop_cap_successor";
    readonly predecessorEntryHash?: string;
  },
): Promise<BusSendResult> {
  const messageId = randomUUID();
  const message = messagePayload(endpoint, toEndpointId, normalized, messageId);
  const unsignedThread = {
    schema: "storybloq-bus-thread/v2" as const,
    threadId,
    kind: threadFields.kind,
    topicRef: threadFields.topicRef,
    participants: [endpoint.endpointId, toEndpointId] as [string, string],
    maxHops: threadFields.maxHops,
    createdByEndpoint: endpoint.endpointId,
    createdAt: new Date().toISOString(),
    ...(threadFields.predecessorThreadId ? { predecessorThreadId: threadFields.predecessorThreadId } : {}),
    ...(threadFields.predecessorRelation ? { predecessorRelation: threadFields.predecessorRelation } : {}),
    ...(threadFields.predecessorEntryHash ? { predecessorEntryHash: threadFields.predecessorEntryHash } : {}),
    threadHash: "0".repeat(64),
  };
  const thread: BusThreadRecord = {
    ...unsignedThread,
    threadHash: hashWithoutKey(unsignedThread, "threadHash"),
  };
  const entry = makeEntry({ type: "message", threadId, seq: 1, prevHash: thread.threadHash, payload: message });
  if (Buffer.byteLength(serialize(entry), "utf-8") > BUS_MAX_ENTRY_BYTES) {
    throw new BusError("invalid_input", `Message entry exceeds ${BUS_MAX_ENTRY_BYTES} bytes`);
  }
  const mailboxSeq = await allocateMailboxSeq(paths, toEndpointId);
  // The pending receipt carries full publication identity BEFORE any entry
  // exists, so recovery can address the exact pointer without a mailbox scan.
  await writeReceipt(paths, pendingReceiptFor(endpoint, normalized, { threadId, messageId, mailboxSeq }));
  const pointer = makePointer(toEndpointId, mailboxSeq, entry);
  const intent = await publishPointerIntent(paths, pointer);
  const tempDir = join(paths.threads, `.tmp-${threadId}-${randomUUID()}`);
  const finalDir = join(paths.threads, threadId);
  try {
    await mkdir(join(tempDir, "entries"), { recursive: true, mode: 0o700 });
    await durableCreate(join(tempDir, "thread.json"), serialize(thread));
    await durableCreate(join(tempDir, "entries", entryFilename(entry)), serialize(entry));
    await syncDirectory(join(tempDir, "entries"));
    await syncDirectory(tempDir);
    await durableRename(tempDir, finalDir);
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await activatePointer(intent);
  const folded = await foldBusThread(paths.projectRoot, threadId);
  await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
  await finalizeReceipt(paths, endpoint.endpointId, normalized.keyHash, {
    payloadHash: normalized.payloadHash,
    threadId,
    toEndpoint: toEndpointId,
    messageId,
    mailboxSeq,
  });
  return { threadId, messageId: message.messageId, toEndpoint: toEndpointId, state: folded.state, hopCount: folded.hopCount, hopsRemaining: hopsRemainingFor(folded), replayed: false, replaySource: "none", parked: false, nextAction: null };
}

// ISS-953 fix step 11: the redeliver operation's actual creation path. A MUTUALLY
// EXCLUSIVE branch from the ordinary resolved-predecessor successor case below
// (never falls through to it, never additionally runs its literal-equality
// participant check) -- called only for predecessorRelation === "hop_cap_successor",
// already inside createThread's threads.lock scope.
async function createHopCapSuccessorThread(
  paths: BusPaths,
  endpoint: BusEndpoint,
  toEndpointId: string,
  normalized: NormalizedSend,
  input: BusSendInput,
  maxHops: number,
  projectState: ProjectState,
): Promise<BusSendResult> {
  const predecessorThreadId = input.predecessorThreadId!;
  const refusedEntryHash = input.refusedEntryHash!;
  // CORE-only fold: locating the predecessor's park entry never needs ITS OWN
  // refusals (that pass is what reads the very redeliver-markers this operation is
  // about to write/verify -- pulling it in here would be the recursive-fold shape
  // fix step 8 was built specifically to rule out).
  const predecessor = await foldBusThread(paths.projectRoot, predecessorThreadId);
  if (predecessor.integrity !== "verified") {
    throw new BusError("corrupt", predecessor.finding ?? "Predecessor thread is quarantined");
  }
  const parkEntry = predecessor.entries.find((entry) => entry.entryHash === refusedEntryHash);
  if (
    !parkEntry || parkEntry.type !== "state" || parkEntry.payload.action !== "park" ||
    parkEntry.payload.automatic !== true || parkEntry.payload.trigger !== "hop_cap" ||
    !parkEntry.payload.droppedMessage
  ) {
    throw new BusError("invalid_input", "refusedEntryHash does not name a hop-cap automatic park entry on the predecessor thread");
  }
  if (predecessor.thread.kind !== "issue_notice" || !predecessor.thread.topicRef.issue) {
    throw new BusError("invalid_input", "hop_cap_successor redelivery requires an issue-linked issue_notice predecessor thread");
  }
  const issue = projectState.issueByID(predecessor.thread.topicRef.issue);
  if (!issue || issue.status === "resolved") {
    throw new BusError("conflict", "The predecessor's linked issue is resolved; redelivery no longer applies");
  }

  // Authorization via succession chain (the SAME existing endpointAddressees
  // mechanism updateBusThread's own participant check already relies on), never
  // literal equality: the caller authorizes only if its own chain reaches the
  // endpoint that actually authored the dropped message. A caller whose chain does
  // not reach it is refused, regardless of who it currently is.
  const { endpoints: allEndpoints, findings: endpointFindings } = await listEndpoints(paths.projectRoot);
  if (endpointFindings.length > 0) {
    throw new BusError("corrupt", `Endpoint registry is corrupt: ${endpointFindings[0]}`);
  }
  // ISS-953 Codex round 3 finding #9: endpointAddressees falls back to
  // self-only when a chain is corrupt -- a caller whose OWN endpoint id happens
  // to equal the target still passes an .ids-only check trivially (self is
  // always in its own chain, corrupt or not), silently masking a genuinely
  // corrupt succession record instead of surfacing it. Store the result once
  // and check .corrupt BEFORE .ids for both this and the peer check below, so
  // a corrupt chain always fails loud (`corrupt`) rather than silently
  // degrading to a self-only authorization that happens to still succeed.
  const callerAddressees = endpointAddressees(endpoint, allEndpoints);
  if (callerAddressees.corrupt) {
    throw new BusError("corrupt", `Caller's succession chain is corrupt: ${callerAddressees.corrupt}`);
  }
  if (!callerAddressees.ids.includes(parkEntry.payload.byEndpoint)) {
    throw new BusError("unauthorized", "Caller's succession chain does not reach the original sender of the dropped message");
  }
  // Recipient resolved the same way every new-thread send already resolves one
  // (resolveActivePeer, upstream in sendBusMessage) -- this is a defense-in-depth
  // check that the resolved current peer's OWN chain reaches the predecessor's
  // other original participant, never a re-derivation of the recipient itself.
  const peerEndpoint = allEndpoints.find((candidate) => candidate.endpointId === toEndpointId);
  if (!peerEndpoint) {
    throw new BusError("corrupt", "Resolved recipient endpoint is not present in the endpoint registry");
  }
  // ISS-953 Codex round 2 finding #9: toEndpointId was resolved by
  // resolveActivePeer back in sendBusMessage, well before threads.lock is ever
  // acquired -- the peer can retire (or be replaced) in that window. The chain
  // check just below verifies the resolved peer's OWN succession chain reaches
  // the predecessor's other participant, but endpointAddressees always includes
  // the starting endpoint itself regardless of ITS retirement status, so that
  // check alone does not catch toEndpointId having retired meanwhile -- only
  // that whatever it is now still descends correctly. Reject explicitly on a
  // now-retired resolved peer, this close to the actual publish.
  //
  // ISS-953 Codex round 3 finding #11 (worker-pen ruling, recorded so a later
  // reader does not misread this check's purpose): this is a COURTESY early
  // refusal that saves obvious wasted work for the common case (a peer already
  // known-retired right here) -- it is NOT what correctness depends on, and it
  // does not close the window. Multiple genuine async I/O points remain between
  // this check and the actual mailbox-pointer write inside publishNewThread
  // (readConsistentRefusedArtifact, marker directory validation/creation), so a
  // peer can still retire after this check passes. Correctness against THAT
  // survives anyway, structurally, because the mailbox pointer is a DELIVERY
  // INDEX, not the durable record: the durable record is the published thread
  // entry (durableCreate/durableRename below), and reconcileEndpointMailbox
  // rebuilds pointers from entries for every addressee in an endpoint's
  // succession chain, on every poll (pollBus calls it unconditionally). A peer
  // that retires BY REPLACEMENT after this check still passes still has its
  // successor mint a fresh pointer from the entry on its next poll
  // (reconcileEndpointMailbox's own per-entry loop: any message entry whose
  // `to` is in the polling endpoint's addressee set, unacked and not already
  // known, gets a pointer). A peer that retires by `leave` with no successor strands the mail
  // identically with or without this specific race -- that is the pre-existing,
  // already-filed ISS-873, not a new harm this window introduces. Do NOT "fix"
  // this by adding a lock or a narrower re-check: a narrower window still isn't
  // closed and would read as a guarantee it cannot make, spending a future
  // reader's trust for no actual gain over what reconcile already provides.
  if (peerEndpoint.retiredAt) {
    throw new BusError("conflict", "Resolved recipient has since retired; retry to resolve the current peer");
  }
  // ISS-953 Codex round 3 finding #10: selecting "the other participant" by
  // literal inequality with byEndpoint is correct only when byEndpoint IS one of
  // the two ORIGINAL thread participants directly. If byEndpoint were ever NOT
  // literally in `participants` (a successor authored the dropped message),
  // .find() would pick the first entry that merely differs from byEndpoint's id,
  // which can silently select the AUTHOR side instead of the intended other
  // side. Reachability note: the ordinary sendBusMessage reply path that
  // produces every genuine automatic hop-cap park requires the CALLER to be
  // LITERALLY present in thread.participants (readThreadParticipants's check has
  // no succession-chain fallback, unlike updateBusThread's ISS-872 check), and
  // participants is fixed permanently at thread creation -- so a byEndpoint this
  // divergent from participants is not reachable through any legitimate send
  // sequence found; it is reachable only via a hand-tampered/corrupted park
  // entry (see this fix's test). callerAddressees (already validated non-corrupt
  // and confirmed above to reach byEndpoint) carries the FULL unbroken ancestor
  // chain from the caller all the way back to whichever original participant
  // byEndpoint itself descends from -- reuse it rather than re-deriving a second
  // chain: intersecting it with the two original participants identifies the
  // author side directly (works uniformly whether byEndpoint IS a participant or
  // is a successor of one -- or is a hand-forged value reachable via the
  // caller's own chain), then the other participant is selected from that.
  const authorSideParticipants = predecessor.thread.participants.filter((id) => callerAddressees.ids.includes(id));
  if (authorSideParticipants.length !== 1) {
    throw new BusError("corrupt", "Dropped message's original sender does not identify exactly one predecessor participant");
  }
  const predecessorOtherParticipant = predecessor.thread.participants.find((id) => id !== authorSideParticipants[0]);
  if (!predecessorOtherParticipant) {
    throw new BusError("corrupt", "Predecessor thread has no other participant");
  }
  // ISS-953 Codex round 3 finding #9 (peer check, the uncited sibling of the
  // caller check above): same fail-loud-on-corrupt requirement.
  const peerAddressees = endpointAddressees(peerEndpoint, allEndpoints);
  if (peerAddressees.corrupt) {
    throw new BusError("corrupt", `Resolved recipient's succession chain is corrupt: ${peerAddressees.corrupt}`);
  }
  if (!peerAddressees.ids.includes(predecessorOtherParticipant)) {
    throw new BusError("unauthorized", "Resolved recipient's succession chain does not reach the predecessor's other original participant");
  }

  // Content re-verification: the message actually being created must exactly match
  // the resolved artifact this refusedEntryHash preserved -- never trust the
  // caller's own kind/severity/body/refs for this relation.
  const resolvedArtifact = await readConsistentRefusedArtifact(paths, parkEntry.payload.droppedMessage);
  if (resolvedArtifact.status !== "resolved") {
    throw new BusError("corrupt", `Refused message artifact is ${resolvedArtifact.status}`);
  }
  const artifact = resolvedArtifact.artifact;
  if (
    artifact.messageKind !== normalized.messageKind ||
    artifact.severity !== normalized.severity ||
    artifact.body !== normalized.body ||
    canonicalHash(artifact.refs) !== canonicalHash(normalized.refs)
  ) {
    throw new BusError("invalid_input", "Redelivered content does not match the resolved refused artifact");
  }

  // Uniqueness via a declared, fully-verified marker -- never a recursive fold.
  // successorThreadId is pre-generated before the write, but ONLY for THIS call's
  // own use if it publishes successfully -- it is never resumed by a LATER call.
  // ISS-953 Codex byte-review fix: this comment previously said a crash between
  // durableCreate and the successor thread landing lets a later resume "the SAME
  // id" -- that described the pre-ISS-1002 model. Since the ISS-1002 interim
  // remedy (see the "pending" branch below), a later call that finds this exact
  // marker still "pending" never adopts its recorded successorThreadId; it
  // durably supersedes the marker with a FRESH id of its own instead, precisely
  // because "pending" cannot be told apart from a forged marker. The pre-
  // generation here still matters for THIS call alone: it is bound into the
  // marker BEFORE the write so the marker and the eventually-published thread
  // agree, without a second write.
  const markerDir = (await validatedRedeliverMarkerDir(paths, predecessorThreadId, { create: true }))!;
  const markerPath = join(markerDir, `${refusedEntryHash}.json`);
  const preAssignedSuccessorThreadId = randomUUID();
  let successorThreadId: string = preAssignedSuccessorThreadId;
  const marker: BusRedeliverMarker = {
    schema: "storybloq-bus-redeliver-marker/v1",
    predecessorThreadId,
    predecessorEntryHash: refusedEntryHash,
    originalByEndpoint: parkEntry.payload.byEndpoint,
    successorThreadId: preAssignedSuccessorThreadId,
    createdAt: new Date().toISOString(),
  };
  let freshWrite = true;
  try {
    await durableCreate(markerPath, serialize(marker));
  } catch (err) {
    // durableCreate wraps a raw EEXIST as BusError("conflict", ...) -- check that
    // code, not a raw errno code durableCreate's own thrown error never carries
    // (the same fix refused.ts's writeRefusedArtifact needed for the same reason).
    if (!(err instanceof BusError) || err.code !== "conflict") throw err;
    freshWrite = false;
  }
  // ISS-999: durableCreate's own path resolution silently followed a
  // post-return swap of markerDir in the exploratory escape this fix
  // responds to -- the marker landed in an attacker directory while this
  // call still reported success. This does NOT close that race (accepted
  // by design, see paths.ts's residual note on validatedRedeliverMarkerDir;
  // a momentary swap-then-revert around the write stays theoretically
  // open). It closes the SILENCE: the practical case an attacker would
  // actually want is a PERSISTENT redirect, and that leaves markerDir's own
  // directory entry as a symlink for as long as anyone would check it.
  //
  // Deterministic, not another race: lstat on the exact `markerDir` string
  // `validatedRedeliverMarkerDir` returned -- never recomputed via
  // `dirname(markerPath)` or anything derived from a possibly-swapped
  // handle, either of which would transparently re-resolve through the
  // swap and report success -- because lstat never follows its own final
  // path component, so a symlink sitting there is reported truthfully
  // regardless of when it was planted.
  //
  // ISS-953 Codex round 5 finding #10: this used to live INSIDE the try
  // block, after a fresh durableCreate SUCCESS only -- the EEXIST-recovery
  // branch below read and trusted an existing marker without ever
  // re-validating markerDir's identity. A persistent directory swap with a
  // binding-valid forged marker pre-populated at the escape target was
  // silently trusted, and could supply the successorThreadId that
  // publishNewThread later uses. Moved to run after the create attempt
  // has either succeeded or failed-with-EEXIST, before either the
  // fresh-write read-back or the EEXIST marker read below, so neither
  // branch -- and no future third branch added upstream of it -- can reach
  // markerPath without markerDir first being proven unswapped.
  const markerDirCheck = await lstat(markerDir).catch(() => null);
  if (!markerDirCheck || markerDirCheck.isSymbolicLink() || !markerDirCheck.isDirectory()) {
    throw new BusError(
      "corrupt",
      `Redeliver marker directory for thread ${predecessorThreadId} was replaced during the write -- the marker for ${refusedEntryHash} cannot be trusted`,
    );
  }
  if (freshWrite) {
    // Only once markerDir itself is confirmed unswapped is resolving markerPath
    // THROUGH it meaningful to verify: its directory component is proven to be a
    // real, non-symlinked entry AT markerDirCheck's own moment. ISS-953 byte-
    // review fix: narrowed from an absolute "this read cannot itself be
    // redirected" -- the accepted-race note a few lines below (round 4 finding
    // #7) already documents that a swap-then-immediately-revert around this
    // exact read stays theoretically open, so the guarantee here is a
    // persistent-swap/content-verification one, not an unconditional one: the
    // read-back-and-canonical-hash-compare below catches a PERSISTENT
    // substitution (the practical case), which is what actually makes this
    // check load-bearing.
    //
    // ISS-953 Codex round 4 finding #7: the original version of this check was
    // a bare `lstat` confirming markerPath names SOME regular, non-symlink
    // file -- true, and not what the comment above it claimed ("guards against
    // the marker file itself removed or replaced"). A same-shape swap (the
    // written marker replaced by a DIFFERENT, also-genuine regular file) still
    // passes `isFile()` and was reported as success. Fixed by reading the file
    // back and comparing its CONTENT against the exact `marker` this call
    // wrote, not merely its type -- canonical-hash equality, not a field-by-
    // field diff, so any deviation (including a schema-valid but different
    // record) is caught. This is still the SAME doctrine as the directory
    // check above and ISS-999's own ruling, stated honestly rather than
    // overclaimed: it detects a PERSISTENT substitution (the practical case),
    // it does not close the underlying race (a swap-then-immediately-revert
    // around the write stays theoretically open -- no native openat operation
    // exists to close it with, per the pen's original ruling against that
    // dependency).
    const markerReadBack = await readJsonNoFollow(markerPath, BusRedeliverMarkerSchema).catch(() => null);
    if (!markerReadBack || canonicalHash(markerReadBack) !== canonicalHash(marker)) {
      throw new BusError(
        "corrupt",
        `Redeliver marker ${refusedEntryHash} did not land at its validated path after being written`,
      );
    }
  } else {
    // ISS-953 Codex round 2 finding #10: a bare `.catch(() => null)` collapsed
    // every read failure -- including a transient io_error (EACCES, EMFILE) --
    // into the same "exists but does not match its own bindings" corrupt
    // diagnosis below. Only not_found (the marker vanishing between this
    // EEXIST and the read) is swallowed to null here; any other BusError
    // (corrupt from a schema/symlink failure, or io_error from anything else)
    // propagates as-is, matching redeliverBusMessage's own lock-free marker
    // read just above.
    let existing: BusRedeliverMarker | null = null;
    try {
      existing = await readJsonNoFollow(markerPath, BusRedeliverMarkerSchema);
    } catch (readErr) {
      if (!(readErr instanceof BusError) || readErr.code !== "not_found") throw readErr;
    }
    if (
      !existing ||
      existing.predecessorThreadId !== predecessorThreadId ||
      existing.predecessorEntryHash !== refusedEntryHash ||
      existing.originalByEndpoint !== parkEntry.payload.byEndpoint
    ) {
      throw new BusError("corrupt", `Redeliver marker ${refusedEntryHash} exists but does not match its own bindings`);
    }
    // The SAME verification resolveRefusals uses for disposition, reused directly
    // rather than re-derived: "pending" (no successor exists yet to check anything
    // against) is deliberately distinct from "invalid" (a genuine mismatch or a
    // successor that fails its own checks) -- but "pending" is NOT itself a trust
    // verdict. ISS-953 Codex round 6 finding #7: an earlier version of this comment
    // described "pending" as "the legitimate marker-written-before-thread-landed
    // crash window", which states the OPPOSITE of what this function now does with
    // it. "Pending" is equally the shape of that benign crash window AND of a
    // bindings-valid forged marker (see fold.ts's verifiedSuccessorState header
    // comment) -- this function cannot tell them apart, so it durably supersedes
    // the marker below rather than resuming from its claimed successorThreadId;
    // see the ISS-1002 interim remedy comment on that branch for the corrected
    // model.
    const verifiedState = await verifiedSuccessorState(paths, existing, refusedEntryHash, artifact, parkEntry.payload.trigger, predecessor);
    if (verifiedState.status === "invalid") {
      throw new BusError("corrupt", `Redeliver marker ${refusedEntryHash} names a successor that fails its own verification`);
    }
    if (verifiedState.status === "verified") {
      // Marker-hit: answer directly from the existing, verified successor, WITHOUT
      // touching the receipt system at all. A receipt's replay verification requires
      // the indexed message's own idempotencyKeyHash to match the receipt's keyHash,
      // and that message is permanently stamped with whichever caller actually
      // authored it -- a different (or earlier) caller's receipt could never satisfy
      // that check, so finalizing one here would actively break the very next replay
      // rather than merely omit one.
      //
      // Mutant-pass note (ISS-953): a mutant that skips straight past this branch
      // (falling through to the "pending" resume-creation path below even though
      // state is genuinely "verified") IS caught by "returns the SAME successor on
      // a repeat hop_cap_successor call" -- but not by that test's own threadId/
      // messageId equality assertions, which never run. It is caught one layer
      // down, by publishNewThread's durableRename throwing on the successor
      // directory that already exists. The test still proves this branch is
      // load-bearing; it does not prove its own assertions are what does the
      // proving.
      //
      // ISS-953 Codex round 2 finding #14: construct the response from
      // verifiedState's OWN fold/message, never a fresh foldBusThread call --
      // a second, unverified fold here would reopen the exact TOCTOU finding
      // #14 named at the sibling marker-hit branch in redeliverBusMessage:
      // the successor directory could change between verification and this
      // read, and a bare integrity+entry-zero-is-message check on that second
      // read never re-confirms provenance or artifact match.
      const successorFold = verifiedState.fold;
      const successorMessage = verifiedState.message;
      return {
        threadId: successorFold.thread.threadId,
        messageId: successorMessage.messageId,
        // The successor MESSAGE's own recorded recipient, not this call's freshly
        // resolved toEndpointId: this branch answers directly from an
        // ALREADY-EXISTING successor without touching the receipt system, and that
        // successor may have been created by an earlier call under a peer that has
        // since been replaced (succession). toEndpointId is resolved fresh for
        // THIS call and can name the new peer while the message's own `to` still
        // names whoever it was actually addressed to at creation time -- reporting
        // the fresh one would describe a delivery that never happened.
        toEndpoint: successorMessage.to,
        state: successorFold.state,
        hopCount: successorFold.hopCount,
        hopsRemaining: hopsRemainingFor(successorFold),
        replayed: true,
        replaySource: "marker",
        parked: false,
        nextAction: null,
      };
    }
    // ISS-1002 interim remedy (Codex round 5 folded-in question b): "pending"
    // means no successor exists yet to check anything against -- equally true
    // of a benign crash window and a forged marker (see fold.ts's
    // verifiedSuccessorState header comment). This function cannot tell them
    // apart, so it no longer adopts `existing.successorThreadId` at all.
    // Instead it durably supersedes the untrusted marker with a fresh one
    // bound to THIS call's own pre-assigned id -- `successorThreadId` is
    // already that value here, never reassigned in this branch -- and
    // records what it discarded so the substitution is observable rather
    // than silent (`storybloq bus doctor` surfaces discardedSuccessorThreadId
    // when present). durableWrite is an atomic overwrite-via-rename, the same
    // "supersede whatever's there" tool already used elsewhere in this
    // codebase (idempotency.ts, hooks.ts, runtime-evidence.ts, fold.ts) --
    // unlike the exclusive durableCreate above, it does not care whether
    // markerPath already exists.
    //
    // Concurrency: this whole function runs inside the single threads.lock
    // critical section acquired by createThread, with no release/reacquire
    // between here and publishNewThread below (see the lock-scope comment on
    // that acquisition). A second caller cannot observe this fresh marker
    // until this call either finishes -- at which point the marker names a
    // thread that genuinely exists and verifiedSuccessorState reports
    // "verified", never "pending" -- or dies holding the lock, which is the
    // same crash window this remedy already exists to survive: the next
    // acquirer supersedes again with its own fresh id. Residual, accepted:
    // repeated crashes landing in this exact window on consecutive retries
    // would keep discarding-and-reminting rather than ever completing, since
    // this remedy no longer trusts a resume id to converge on. That trade is
    // deliberate -- see the round 5 disposition -- not an oversight.
    const supersededMarker: BusRedeliverMarker = {
      ...marker,
      discardedSuccessorThreadId: existing.successorThreadId,
    };
    await durableWrite(markerPath, serialize(supersededMarker));
    // ISS-953 Codex round 6 MAJOR #5: this branch had NO post-write
    // verification until now, recreating ISS-999's shape inside the ISS-1002
    // remedy itself. The markerDirCheck above ran before this branch's own
    // async work (the existing-marker read, verifiedSuccessorState's fold and
    // endpoint reads) -- by the time durableWrite runs, that check is stale,
    // and a persistent directory swap landing in the gap could redirect this
    // write while publishNewThread below still succeeds. Same two checks the
    // freshWrite branch above already applies to its own durableCreate,
    // applied here to durableWrite instead, so both writes converge on the
    // same guarantee: (1) a fresh directory-identity check -- lstat never
    // follows its own final component, so a symlink swap of markerDir itself
    // is reported truthfully regardless of when it landed; (2) a read-back
    // through that directory, compared by canonical hash against the exact
    // record just written, catching a same-shape substitution a bare
    // existence check would miss. As with the freshWrite checks above, this
    // is a persistent-swap/content-verification guarantee, not an
    // unconditional one -- a swap-then-immediately-revert around this exact
    // read stays theoretically open, for the same reason given there.
    // Structurally identical to the freshWrite checks otherwise, because the
    // shape of the threat (a directory swap or same-path substitution racing
    // the write) is identical for both durableCreate and durableWrite.
    const supersedeMarkerDirCheck = await lstat(markerDir).catch(() => null);
    if (!supersedeMarkerDirCheck || supersedeMarkerDirCheck.isSymbolicLink() || !supersedeMarkerDirCheck.isDirectory()) {
      throw new BusError(
        "corrupt",
        `Redeliver marker directory for thread ${predecessorThreadId} was replaced during the supersede write -- the marker for ${refusedEntryHash} cannot be trusted`,
      );
    }
    const supersedeReadBack = await readJsonNoFollow(markerPath, BusRedeliverMarkerSchema).catch(() => null);
    if (!supersedeReadBack || canonicalHash(supersedeReadBack) !== canonicalHash(supersededMarker)) {
      throw new BusError(
        "corrupt",
        `Redeliver marker ${refusedEntryHash} did not land at its validated path after being superseded`,
      );
    }
  }

  // Fresh creation, or superseding a pending marker left by the crash window
  // above -- either way this call publishes under its OWN freshly-minted
  // successorThreadId, never resuming or adopting an id another attempt left
  // behind (ISS-1002: "pending" is never trusted). This really is the
  // message being authored under the current caller's key right now, so it
  // finalizes a normal receipt for them exactly like any other fresh send.
  return publishNewThread(paths, endpoint, toEndpointId, normalized, successorThreadId, {
    // Hard-coded, never the caller's declared threadKind: validateInitialKinds
    // already requires the caller to declare "issue_notice" for this relation,
    // but this branch does not trust that declaration to construct the thread --
    // it is the authoritative write, so it states the invariant directly rather
    // than relying on a check one layer up staying correct forever.
    kind: "issue_notice",
    // Server-derived from the verified predecessor, bypassing topicRefFrom(refs)
    // entirely: the dropped message's own refs are very often empty (a plain reply
    // needs no fresh issue/ticket/commit/ciRun), and deriving topic from them would
    // either throw for that common case or, worse, silently detach the successor
    // from the canonical issue this whole mechanism exists to keep anchored to.
    topicRef: { issue: predecessor.thread.topicRef.issue! },
    maxHops,
    predecessorThreadId,
    predecessorRelation: "hop_cap_successor",
    predecessorEntryHash: refusedEntryHash,
  });
}

async function createThread(
  paths: BusPaths,
  endpoint: BusEndpoint,
  toEndpointId: string,
  normalized: NormalizedSend,
  input: BusSendInput,
  maxHops: number,
  projectState: ProjectState,
): Promise<BusSendResult> {
  const threadKind = BusThreadKindSchema.parse(input.threadKind);
  const isHopCapSuccessor = input.predecessorRelation === "hop_cap_successor";
  validateInitialKinds(threadKind, normalized.messageKind, isHopCapSuccessor);
  if (input.predecessorThreadId && !ThreadIdSchema.safeParse(input.predecessorThreadId).success) {
    throw new BusError("invalid_input", "Invalid predecessor thread id");
  }
  if (isHopCapSuccessor && (!input.predecessorThreadId || !input.refusedEntryHash)) {
    throw new BusError("invalid_input", "hop_cap_successor requires predecessorThreadId and refusedEntryHash");
  }
  // ISS-953 Codex round 2 finding #8: messagePayload sets inReplyTo straight from
  // the caller's own input, unconditionally, for every relation. A hop_cap_successor
  // send's message becomes the successor thread's very FIRST entry -- its own fold's
  // `messages` array is necessarily still empty at that point, so ANY non-null
  // inReplyTo (even one naming a real message on the PREDECESSOR thread, which a
  // caller legitimately knows) fails the core fold's "reply target does not exist in
  // the valid prefix" check the instant this thread is folded, quarantining the
  // successor this call itself just created. The predecessor relationship is already
  // carried by predecessorThreadId/predecessorEntryHash; inReplyTo has no valid use
  // here and must be rejected outright rather than accepted and self-destructed.
  if (isHopCapSuccessor && normalized.inReplyTo) {
    throw new BusError("invalid_input", "hop_cap_successor redelivery cannot declare inReplyTo");
  }
  return withHardenedLock(join(paths.locks, "threads.lock"), async () => {
    // Branches on predecessorRelation FIRST: hop_cap_successor takes the entire new
    // path above INSTEAD OF the ordinary resolved-predecessor checks below (the
    // existing predecessor.state !== "resolved" requirement and the existing
    // literal participantsInclude equality check do NOT additionally run for this
    // relation -- createHopCapSuccessorThread has its own, stronger, chain-based
    // authorization). Any other/absent predecessorRelation takes the existing,
    // completely unchanged ordinary path.
    if (isHopCapSuccessor) {
      return createHopCapSuccessorThread(paths, endpoint, toEndpointId, normalized, input, maxHops, projectState);
    }
    if (input.predecessorThreadId) {
      const predecessor = await foldBusThread(paths.projectRoot, input.predecessorThreadId);
      if (predecessor.integrity !== "verified" || predecessor.state !== "resolved") {
        throw new BusError("conflict", "A predecessor thread must be integrity-verified and resolved");
      }
      if (!participantsInclude(predecessor.thread, endpoint.endpointId) ||
          !participantsInclude(predecessor.thread, toEndpointId)) {
        throw new BusError("unauthorized", "A successor must retain the predecessor participants");
      }
    }
    return publishNewThread(paths, endpoint, toEndpointId, normalized, randomUUID(), {
      kind: threadKind,
      topicRef: topicRefFrom(normalized.refs),
      maxHops,
      ...(input.predecessorThreadId ? { predecessorThreadId: input.predecessorThreadId } : {}),
    });
  });
}

// Exported for direct unit testing of the delivered-finalization identity guard
// (the already-final ordering + the parked/endpointId/keyHash rejections), which
// is otherwise a defense-in-depth branch not reachable in a single locked scope.
export async function finalizeReceipt(
  paths: BusPaths,
  endpointId: string,
  keyHash: string,
  expected: { payloadHash: string; threadId: string; toEndpoint: string; messageId: string; mailboxSeq: number },
): Promise<void> {
  const current = await readReceipt(paths, endpointId, keyHash);
  if (!current) {
    // The pending receipt was published earlier in this same endpoint-locked
    // scope; its absence means external corruption. Fail closed rather than
    // reporting success without a durable final receipt (which would let a
    // retry republish a duplicate).
    throw new BusError("corrupt", "Cannot finalize idempotency receipt; the pending receipt is missing");
  }
  // Verify identity BEFORE honoring an already-final receipt, so a mismatched
  // or externally corrupted receipt is never silently accepted. This is the
  // DELIVERED finalization path only: a receipt bearing `outcome: "parked"`
  // (which the schema lets omit messageId/mailboxSeq) must never be finalized
  // for a published message, or a retry would treat it as a terminal park and
  // skip indexed-message verification. The internal endpointId/keyHash are also
  // checked against the path arguments so a misfiled receipt cannot be honored.
  if (
    current.outcome === "parked" ||
    current.endpointId !== endpointId ||
    current.keyHash !== keyHash ||
    current.payloadHash !== expected.payloadHash ||
    current.threadId !== expected.threadId ||
    current.toEndpoint !== expected.toEndpoint ||
    current.messageId !== expected.messageId ||
    current.mailboxSeq !== expected.mailboxSeq
  ) {
    throw new BusError("corrupt", "The pending receipt does not match the published operation");
  }
  if (current.state === "final") return;
  await writeReceipt(paths, { ...current, state: "final" });
}

function duplicateActionable(folded: FoldedBusThread, fromEndpointId: string, toEndpointId: string, normalized: NormalizedSend): boolean {
  if (!ACTIONABLE_KINDS.has(normalized.messageKind)) return false;
  const candidate = actionableFingerprint({
    fromEndpointId,
    toEndpointId,
    kind: normalized.messageKind,
    body: normalized.body,
    refs: normalized.refs,
  });
  return folded.messages.some((message) =>
    ACTIONABLE_KINDS.has(message.kind) &&
    actionableFingerprint({
      fromEndpointId: message.from.endpointId,
      toEndpointId: message.to,
      kind: message.kind,
      body: message.body,
      refs: message.refs,
    }) === candidate,
  );
}

async function appendStateEntry(
  paths: BusPaths,
  folded: FoldedBusThread,
  payload: BusStatePayload,
): Promise<FoldedBusThread> {
  const entry = makeEntry({
    type: "state",
    threadId: folded.thread.threadId,
    seq: folded.validThroughSeq + 1,
    prevHash: folded.lastHash,
    payload,
  });
  await durableCreate(join(paths.threads, folded.thread.threadId, "entries", entryFilename(entry)), serialize(entry));
  const next = await foldBusThread(paths.projectRoot, folded.thread.threadId);
  await writeDerivedThread(paths.projectRoot, next).catch(() => undefined);
  return next;
}

async function replyToThread(
  paths: BusPaths,
  endpoint: BusEndpoint,
  toEndpointId: string,
  normalized: NormalizedSend,
  threadId: string,
  projectState: ProjectState,
): Promise<BusSendResult> {
  if (!ThreadIdSchema.safeParse(threadId).success) throw new BusError("invalid_input", "Invalid Bus thread id");
  return withHardenedLock(join(paths.locks, `thread-${threadId}.lock`), async () => {
    let folded = await foldBusThread(paths.projectRoot, threadId);
    if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
    if (folded.state !== "open") throw new BusError("thread_parked", `Thread is ${folded.state}`);
    if (!participantsInclude(folded.thread, endpoint.endpointId) || !participantsInclude(folded.thread, toEndpointId)) {
      throw new BusError("unauthorized", "Endpoint is not a participant in this thread");
    }
    if (normalized.inReplyTo && !folded.messages.some((message) => message.messageId === normalized.inReplyTo)) {
      throw new BusError("invalid_input", "Reply target does not exist in this thread");
    }

    // ISS-953 fix step 5 (reject-before-park, both triggers): build the message
    // entry that WOULD be written on a direct send, and size-gate it, BEFORE
    // branching into park-vs-direct-send. Previously this check ran only on the
    // direct-send path, so an oversized duplicate-fingerprint send parked
    // successfully instead of failing invalid_input; a hop-cap-triggering send had
    // the same gap. Non-parking, non-oversized send behavior is unchanged.
    const messageId = randomUUID();
    const message = messagePayload(endpoint, toEndpointId, normalized, messageId);
    const entry = makeEntry({
      type: "message",
      threadId,
      seq: folded.validThroughSeq + 1,
      prevHash: folded.lastHash,
      payload: message,
    });
    if (Buffer.byteLength(serialize(entry), "utf-8") > BUS_MAX_ENTRY_BYTES) {
      throw new BusError("invalid_input", `Message entry exceeds ${BUS_MAX_ENTRY_BYTES} bytes`);
    }

    const overHopCap = ACTIONABLE_KINDS.has(normalized.messageKind) && folded.hopCount >= folded.thread.maxHops;
    const duplicate = duplicateActionable(folded, endpoint.endpointId, toEndpointId, normalized);
    if (overHopCap || duplicate) {
      // Crash-safe park (D3/#4/#R6-A): PREALLOCATE the park state entry so the
      // pending receipt can bind to its exact identity (`entryHash`) BEFORE the
      // entry lands. Write the pending parked receipt, durably create that exact
      // entry, then finalize the receipt. Recovery locates the entry by its hash
      // in the folded chain regardless of the thread's current state, so a later
      // resolve/reopen cannot lose the committed parked outcome and an unrelated
      // park cannot be misattributed to this receipt.
      // ISS-953 fix step 4: preserve the dropped message's full content as a
      // standalone artifact BEFORE the park entry references it, so the entry
      // never points at content that might not exist.
      const droppedMessage = await writeRefusedArtifact(paths, message);
      const parkEntry = makeEntry({
        type: "state",
        threadId,
        seq: folded.validThroughSeq + 1,
        prevHash: folded.lastHash,
        payload: {
          action: "park",
          byEndpoint: endpoint.endpointId,
          reason: overHopCap ? `Maximum hop count ${folded.thread.maxHops} reached` : "Duplicate actionable fingerprint",
          automatic: true,
          trigger: overHopCap ? "hop_cap" : "duplicate_fingerprint",
          // Bind this automatic park to the exact idempotent send that triggered it.
          // committedAutomaticPark requires both to equal the replaying receipt's
          // keyHash/payloadHash, so a tampered receipt whose stateEntryHash names a
          // DIFFERENT same-endpoint automatic park is rejected, not misattributed.
          idempotencyKeyHash: normalized.keyHash,
          payloadHash: normalized.payloadHash,
          droppedMessage,
        },
      });
      await writeReceipt(paths, parkedReceiptFor(endpoint, normalized, threadId, toEndpointId, "pending", parkEntry.entryHash));
      await durableCreate(join(paths.threads, threadId, "entries", entryFilename(parkEntry)), serialize(parkEntry));
      folded = await foldBusThread(paths.projectRoot, threadId);
      await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
      await writeReceipt(paths, parkedReceiptFor(endpoint, normalized, threadId, toEndpointId, "final", parkEntry.entryHash));
      return {
        threadId,
        messageId: null,
        toEndpoint: toEndpointId,
        state: folded.state,
        hopCount: folded.hopCount,
        hopsRemaining: hopsRemainingFor(folded),
        replayed: false,
        replaySource: "none",
        parked: true,
        nextAction: await nextActionForPark(paths, folded, parkEntry.entryHash, threadId, projectState),
      };
    }

    const mailboxSeq = await allocateMailboxSeq(paths, toEndpointId);
    await writeReceipt(paths, pendingReceiptFor(endpoint, normalized, { threadId, messageId, mailboxSeq }));
    const intent = await publishPointerIntent(paths, makePointer(toEndpointId, mailboxSeq, entry));
    await durableCreate(join(paths.threads, threadId, "entries", entryFilename(entry)), serialize(entry));
    await activatePointer(intent);
    folded = await foldBusThread(paths.projectRoot, threadId);
    await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
    await finalizeReceipt(paths, endpoint.endpointId, normalized.keyHash, {
      payloadHash: normalized.payloadHash,
      threadId,
      toEndpoint: toEndpointId,
      messageId,
      mailboxSeq,
    });
    return { threadId, messageId: message.messageId, toEndpoint: toEndpointId, state: folded.state, hopCount: folded.hopCount, hopsRemaining: hopsRemainingFor(folded), replayed: false, replaySource: "none", parked: false, nextAction: null };
  });
}

// True only when the pointer file at `path` parses and canonically equals the
// reconstructed pointer. Absent, truncated, or unreadable all return false, so
// the caller (re)creates it from the authoritative thread entry; any real IO
// error then surfaces from the subsequent durableCreate, never here.
async function pointerFileDelivered(path: string, expectedBytes: string): Promise<boolean> {
  try {
    const pointer = await readJsonNoFollow(path, BusMailboxPointerSchema);
    return serialize(pointer) === expectedBytes;
  } catch {
    return false;
  }
}

// Read a mailbox pointer without following symlinks, returning null ONLY when the
// path is provably absent. A present-but-corrupt/symlinked/unreadable pointer
// propagates its BusError (corrupt/io_error) so the caller fails closed rather than
// treating an unverifiable file as "nothing here".
async function readPointerOrNull(path: string): Promise<BusMailboxPointer | null> {
  try {
    return await readJsonNoFollow(path, BusMailboxPointerSchema);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return null;
    throw err;
  }
}

// Recover a crashed prior attempt (D3 rule 2). Returns a replay result when the
// message is durably present, or null when it is provably absent (so the caller
// proceeds with a fresh publication). Fails closed on any fold/IO error.
// A parked receipt is bound to the exact AUTOMATIC park state entry it committed
// (parkedReceiptFor sets stateEntryHash to that entry's entryHash). Recovery and
// replay match by entryHash AND park semantics: a corrupted or misfiled receipt
// whose stateEntryHash happens to name a resolve, reopen, or manual park entry must
// not be replayed as this operation's automatic parked outcome. entryHash is a
// content hash (unique per entry), so a match is exact identity; this layers the
// semantic guard on top. The park entry ALSO carries the triggering send's
// idempotencyKeyHash/payloadHash (both covered by entryHash), and the match requires
// them to equal the replaying receipt's keyHash/payloadHash: a tampered or misfiled
// receipt whose stateEntryHash names a DIFFERENT same-endpoint automatic park is
// rejected rather than misattributed, since that other park binds a different send.
// Returns the entry when present with matching automatic-park semantics AND operation
// binding; null when NO entry carries that hash (the park never committed); throws
// `corrupt` when an entry with that hash exists but is not this endpoint's automatic
// park for this exact send. The schema requires stateEntryHash on parked receipts, so
// a missing hash is external corruption and also fails closed here.
function committedAutomaticPark(
  folded: FoldedBusThread,
  receipt: BusReceipt,
): Extract<BusEntry, { type: "state" }> | null {
  if (receipt.stateEntryHash == null) {
    throw new BusError("corrupt", "A parked receipt must carry the hash of the park entry it commits");
  }
  const match = folded.entries.find((candidate) => candidate.entryHash === receipt.stateEntryHash);
  if (!match) return null;
  if (
    match.type !== "state" ||
    match.payload.action !== "park" ||
    match.payload.automatic !== true ||
    match.payload.trigger == null ||
    match.payload.byEndpoint !== receipt.endpointId ||
    match.payload.idempotencyKeyHash !== receipt.keyHash ||
    match.payload.payloadHash !== receipt.payloadHash
  ) {
    throw new BusError("corrupt", "The recorded park entry is not this endpoint's automatic park");
  }
  return match;
}

async function recoverPendingReceipt(
  paths: BusPaths,
  endpoint: BusEndpoint,
  receipt: BusReceipt,
  expectedPayloadHash: string,
  projectState: ProjectState,
): Promise<BusSendResult | null> {
  let folded: FoldedBusThread | null = null;
  try {
    folded = await foldBusThread(paths.projectRoot, receipt.threadId);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") {
      folded = null; // thread never landed; the message is provably absent
    } else {
      throw err instanceof BusError ? err : new BusError("io_error", "Cannot recover pending receipt", err);
    }
  }
  if (folded && folded.integrity !== "verified") {
    throw new BusError("corrupt", "Cannot recover idempotency; the recorded thread is quarantined");
  }
  // Pending parked receipt (D3/#4/#R6-A): an automatic park crashed between its
  // pending receipt and its finalization. The receipt is bound to the park state
  // entry by `stateEntryHash`, so we prove the park committed by locating THAT
  // exact entry (identity + automatic-park semantics) in the folded chain, NOT by
  // the thread's current state: a later resolve/reopen must still replay the
  // committed park, and an unrelated or non-automatic park must not be misattributed
  // here. Present -> finalize and replay parked; absent -> the park never committed,
  // so remove the receipt and retry; wrong semantics -> committedAutomaticPark throws.
  if (receipt.outcome === "parked") {
    const parked = folded != null ? committedAutomaticPark(folded, receipt) : null;
    if (parked) {
      if (receipt.payloadHash !== expectedPayloadHash) {
        throw new BusError("idempotency_conflict", "Idempotency key was already used with a different payload");
      }
      await writeReceipt(paths, { ...receipt, state: "final" });
      return replayFromFold(paths, folded!, { ...receipt, state: "final" }, projectState);
    }
    await removeReceipt(paths, endpoint.endpointId, receipt.keyHash);
    return null;
  }
  const entry = folded && receipt.messageId
    ? folded.entries.find((candidate) => candidate.type === "message" && candidate.payload.messageId === receipt.messageId)
    : undefined;
  if (folded && entry && entry.type === "message") {
    // A reused idempotency key that resolves to a different payload is a conflict,
    // detected BEFORE any mailbox mutation. The recorded in-flight message stays
    // recoverable on a retry with its original payload (#3).
    if (receipt.payloadHash !== expectedPayloadHash) {
      throw new BusError("idempotency_conflict", "Idempotency key was already used with a different payload");
    }
    // Verify the located entry actually matches the recorded receipt before any
    // mailbox mutation. A stale or externally corrupted receipt must never
    // finalize a different message as delivered.
    if (
      entry.threadId !== receipt.threadId ||
      entry.payload.from.endpointId !== endpoint.endpointId ||
      entry.payload.to !== receipt.toEndpoint ||
      entry.payload.idempotencyKeyHash !== receipt.keyHash ||
      entry.payload.payloadHash !== receipt.payloadHash
    ) {
      throw new BusError("corrupt", "The recovered message does not match the pending receipt");
    }
    // Ensure the recipient pointer reaches its active destination, validating
    // contents (not just the pathname) and re-verifying after activation. Run
    // under the recipient reconcile lock so a concurrent poll cannot race the
    // recreate/activate.
    const pointer = makePointer(receipt.toEndpoint, receipt.mailboxSeq ?? entry.seq, entry);
    const mailbox = endpointMailboxPath(paths, receipt.toEndpoint);
    const filename = pointerFilename(pointer);
    const active = join(mailbox, filename);
    const pending = join(mailbox, "pending", filename);
    const expectedBytes = serialize(pointer);
    await withHardenedLock(join(paths.locks, `mailbox-reconcile-${receipt.toEndpoint}.lock`), async () => {
      if (await pointerFileDelivered(active, expectedBytes)) return;
      if (!(await pointerFileDelivered(pending, expectedBytes))) {
        // The pending pointer is absent OR present-but-invalid (truncated /
        // envelope-corrupt). durableCreate is exclusive (it links onto the
        // target), so it would throw `conflict` on an existing invalid file.
        // Durably remove any such file first, then recreate it from the
        // authoritative entry. durableUnlink no-ops on ENOENT and propagates
        // any real IO error, so a failed removal is never silently ignored.
        await durableUnlink(pending);
        await durableCreate(pending, expectedBytes);
      }
      await activatePointer({ pending, active });
      if (!(await pointerFileDelivered(active, expectedBytes))) {
        throw new BusError("io_error", "Could not durably deliver the recovered mailbox pointer");
      }
    });
    await finalizeReceipt(paths, endpoint.endpointId, receipt.keyHash, {
      payloadHash: receipt.payloadHash,
      threadId: receipt.threadId,
      toEndpoint: receipt.toEndpoint,
      messageId: entry.payload.messageId,
      mailboxSeq: receipt.mailboxSeq ?? entry.seq,
    });
    return replayFromFold(paths, folded, { ...receipt, state: "final" }, projectState);
  }
  // Message provably absent: the only pointer this crashed attempt could have left is
  // its OWN pending intent. Remove it ONLY when the on-disk pointer envelope proves it
  // belongs to THIS receipt (endpointId/mailboxSeq/messageId/threadId all match). A
  // schema-valid but externally corrupted receipt for this key could otherwise name an
  // UNRELATED delivery's pointer, and a blind unlink would delete that live message. A
  // foreign pending pointer, or ANY active pointer at the recorded path (activation
  // follows the entry durableCreate, so an absent message cannot have a live pointer),
  // is anomalous: fail closed and leave it intact, never blind-unlink another delivery.
  if (receipt.messageId && receipt.mailboxSeq) {
    const mailbox = endpointMailboxPath(paths, receipt.toEndpoint);
    const filename = `${padSeq(receipt.mailboxSeq, 12)}-${receipt.messageId}.json`;
    const ownsPointer = (pointer: BusMailboxPointer): boolean =>
      pointer.endpointId === receipt.toEndpoint &&
      pointer.mailboxSeq === receipt.mailboxSeq &&
      pointer.messageId === receipt.messageId &&
      pointer.threadId === receipt.threadId;
    const pendingPointer = await readPointerOrNull(join(mailbox, "pending", filename));
    if (pendingPointer) {
      if (!ownsPointer(pendingPointer)) {
        throw new BusError("corrupt", "The pending mailbox pointer at the recorded path does not belong to this receipt");
      }
      await durableUnlink(join(mailbox, "pending", filename));
    }
    if (await readPointerOrNull(join(mailbox, filename))) {
      throw new BusError("corrupt", "An active mailbox pointer occupies the recorded path for a message with no committed entry");
    }
  }
  await removeReceipt(paths, endpoint.endpointId, receipt.keyHash);
  return null;
}

export async function sendBusMessage(root: string, input: BusSendInput): Promise<BusSendResult> {
  if (!EndpointIdSchema.safeParse(input.endpointId).success) throw new BusError("invalid_input", "Invalid endpoint id");
  if (input.threadId && (input.threadKind || input.predecessorThreadId)) {
    throw new BusError("invalid_input", "Replies cannot set threadKind or predecessorThreadId");
  }
  if (!input.threadId && !input.threadKind) {
    throw new BusError("invalid_input", "A new Bus thread requires threadKind");
  }
  // ISS-953 Codex round 3 finding #8: predecessorRelation and refusedEntryHash
  // are independently optional, and before this check were incorporated into
  // normalizeSend's payloadHash whenever present without validating the
  // operation SHAPE is coherent -- an ordinary reply or an ordinary new-thread
  // create could carry a meaningless predecessorRelation and/or refusedEntryHash
  // value (neither is ever consulted by the ordinary dispatch path), silently
  // changing that operation's payloadHash for no operation-relevant reason and
  // producing a false idempotency_conflict on a retry that supplies a different
  // stray value for either field. Validate the shape BEFORE normalizeSend ever
  // computes a hash, not after: predecessorRelation, refusedEntryHash, and
  // predecessorThreadId travel together as a trio (the hop_cap_successor
  // redeliver operation) or not at all -- neither redelivery-only field is
  // valid alone. predecessorThreadId ALONE (no predecessorRelation, no
  // refusedEntryHash) remains valid unchanged: the ordinary resolved-thread
  // successor case, unrelated to hop_cap_successor, already handled by the
  // existing check above and by createOrReply's own predecessorThreadId
  // branch below. The trio is incompatible with threadId (a reply) too, but
  // that incompatibility needs no separate throw here: the trio requires
  // predecessorThreadId, and the check directly above already rejects
  // threadId combined with predecessorThreadId, so threadId+trio is already
  // unreachable past this point -- an explicit second throw for it would be
  // dead code.
  //
  // Precision note on the inner condition's three clauses, so a future L-055
  // pass does not read two of them as dead and delete them: only the first
  // clause (predecessorRelation !== "hop_cap_successor") closes a previously
  // OPEN correctness gap -- when relation is absent, createThread's own
  // isHopCapSuccessor-gated required-field check (the
  // `isHopCapSuccessor && (!input.predecessorThreadId || !input.refusedEntryHash)`
  // throw, guarded by `isHopCapSuccessor`'s own assignment just above it)
  // never runs at all, so a stray refusedEntryHash alone previously reached a
  // SUCCESSFUL ordinary create with a contaminated payloadHash. The other two
  // clauses (!refusedEntryHash, !predecessorThreadId) are deliberately
  // redundant with that same check for the case where relation IS exactly
  // "hop_cap_successor" --
  // reverting either one in isolation flips no test, confirmed directly.
  // They are kept anyway: their value is failing HERE, before loadProject,
  // config resolution, and path work, and before payloadHash is ever even
  // transiently computed -- not closing a gap that was otherwise open.
  // Failing earlier on the same input is a different property from failing
  // at all, and independent reachability of a gap they alone would close was
  // investigated and not found.
  if (input.predecessorRelation || input.refusedEntryHash) {
    if (input.predecessorRelation !== "hop_cap_successor" || !input.refusedEntryHash || !input.predecessorThreadId) {
      throw new BusError(
        "invalid_input",
        "predecessorRelation, refusedEntryHash, and predecessorThreadId must be supplied together for a hop_cap_successor redelivery",
      );
    }
  }
  const loaded = await loadProject(root);
  const config = assertBusEnabled(loaded.state.config);
  const paths = await resolveInitializedBusPaths(root);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) => {
    // Resolve the recipient. For a reply, the recipient is the thread's other
    // participant (which fails closed if retired); for a new thread it is the
    // sole active peer.
    let toEndpointId: string;
    // A reply into a thread whose peer has retired is only refused for a genuinely
    // NEW publication. A reply's recipient is the thread's fixed participant, so the
    // keyHash/payloadHash are stable regardless of the peer's liveness; a committed
    // reply must therefore still replay/recover after the peer retires (idempotent
    // replay cannot depend on current peer liveness, or a crash + retry after the
    // peer's task ends would be permanently unreplayable). Defer the throw until
    // after the receipt-replay path below.
    let replyPeerRetired = false;
    // A new-thread send resolves its recipient from the sole active peer. If that
    // peer has retired, a COMMITTED send must still replay its receipt (idempotent
    // replay must not depend on current peer liveness -- the same principle as the
    // reply path), so defer the no_peer refusal past the receipt-replay block.
    let newThreadNoPeer = false;
    if (input.threadId) {
      if (!ThreadIdSchema.safeParse(input.threadId).success) throw new BusError("invalid_input", "Invalid Bus thread id");
      const participants = await readThreadParticipants(paths, input.threadId);
      if (!participants.includes(endpoint.endpointId)) {
        throw new BusError("unauthorized", "Endpoint is not a participant in this thread");
      }
      toEndpointId = participants[0] === endpoint.endpointId ? participants[1] : participants[0];
      const { endpoints, findings } = await listEndpoints(paths.projectRoot);
      if (findings.length > 0) {
        throw new BusError("corrupt", `Endpoint registry is corrupt: ${findings[0]}`);
      }
      const other = endpoints.find((candidate) => candidate.endpointId === toEndpointId);
      replyPeerRetired = !other || !!other.retiredAt;
    } else {
      const peer = await resolveActivePeer(paths, endpoint.endpointId);
      if (peer) {
        toEndpointId = peer.endpointId;
      } else {
        // No active peer. The idempotency key (and thus the receipt path) does NOT
        // depend on the recipient, so read the prior receipt directly: a committed
        // send replays against its recorded toEndpoint even after the peer retires.
        // A genuinely fresh send (no prior receipt) still fails closed with no_peer,
        // deferred to after the replay path so a committed send is never masked.
        const priorKeyHash = idempotencyKeyHash(endpoint.endpointId, input.idempotencyKey);
        const prior = await readReceipt(paths, endpoint.endpointId, priorKeyHash);
        if (!prior) {
          throw new BusError("no_peer", "The Bus has no active peer endpoint (waiting_for_peer). Run `storybloq bus setup` in the other task.");
        }
        toEndpointId = prior.toEndpoint;
        newThreadNoPeer = true;
      }
    }

    const normalized = normalizeSend(
      loaded.state,
      config.maxBodyBytes,
      config.requireIssueForCritical,
      endpoint,
      toEndpointId,
      input,
    );

    // Durable idempotency index (D3): O(1) replay, no full-runtime fold.
    const receipt = await readReceipt(paths, endpoint.endpointId, normalized.keyHash);
    if (receipt) {
      // The receipt is loaded by (endpointId, keyHash) PATH, so a receipt whose
      // INTERNAL endpointId/keyHash disagrees with the path is misfiled or
      // corrupted. Reject before either the final-replay or recovery branch, since
      // a final parked receipt skips entry verification entirely and a delivered
      // replay never re-checks endpointId; a misfiled receipt must never replay.
      if (receipt.endpointId !== endpoint.endpointId || receipt.keyHash !== normalized.keyHash) {
        throw new BusError("corrupt", "The recorded receipt does not match the requesting endpoint or key");
      }
      if (receipt.state === "final") {
        if (receipt.payloadHash !== normalized.payloadHash) {
          throw new BusError("idempotency_conflict", "Idempotency key was already used with a different payload");
        }
        const folded = await foldBusThread(paths.projectRoot, receipt.threadId);
        if (folded.integrity !== "verified") {
          throw new BusError("corrupt", "Cannot replay; the recorded thread is quarantined");
        }
        // A delivered receipt must still index its message entry before we replay;
        // a parked receipt must still index its bound automatic-park state entry (by
        // stateEntryHash AND park semantics), so a final parked receipt is verified
        // against the chain exactly like the pending recovery path rather than trusted
        // blindly. A final parked receipt whose park entry is absent or carries wrong
        // semantics is corruption (the park was finalized, so the entry must exist).
        if (receipt.outcome !== "parked") {
          const indexed = receipt.messageId
            ? folded.entries.find((candidate) => candidate.type === "message" && candidate.payload.messageId === receipt.messageId)
            : undefined;
          if (
            !indexed || indexed.type !== "message" ||
            indexed.threadId !== receipt.threadId ||
            indexed.payload.from.endpointId !== endpoint.endpointId ||
            indexed.payload.to !== receipt.toEndpoint ||
            indexed.payload.idempotencyKeyHash !== receipt.keyHash ||
            indexed.payload.payloadHash !== receipt.payloadHash
          ) {
            throw new BusError("corrupt", "Cannot replay; the recorded message is missing or does not match its receipt");
          }
        } else if (committedAutomaticPark(folded, receipt) == null) {
          throw new BusError("corrupt", "Cannot replay; the recorded park entry is missing or does not match its receipt");
        }
        return replayFromFold(paths, folded, receipt, loaded.state);
      }
      // Recovery detects an idempotency_conflict (reused key, different payload)
      // before any mailbox mutation and returns a replay only when the payload
      // matches; a null return means the crashed attempt never committed and was
      // superseded, so we continue with a fresh send.
      const recovered = await recoverPendingReceipt(paths, endpoint, receipt, normalized.payloadHash, loaded.state);
      if (recovered) return recovered;
    }

    // No committed operation to replay: this is a fresh publication. A fresh reply
    // into a thread whose peer has retired is refused here (the deferred check above),
    // AFTER the replay path so a committed reply still replays post-retirement.
    if (input.threadId && replyPeerRetired) {
      throw new BusError("participant_retired", "The thread's peer participant is retired; resolve the thread");
    }
    // A committed new-thread send already replayed above. Reaching here with
    // newThreadNoPeer means the prior receipt was pending-but-never-committed
    // (recovery returned null), so refuse rather than createThread to a retired peer.
    if (!input.threadId && newThreadNoPeer) {
      throw new BusError("no_peer", "The Bus has no active peer endpoint (waiting_for_peer). Run `storybloq bus setup` in the other task.");
    }

    return input.threadId
      ? replyToThread(paths, endpoint, toEndpointId, normalized, input.threadId, loaded.state)
      : createThread(paths, endpoint, toEndpointId, normalized, input, config.maxHops, loaded.state);
  });
}

// ISS-953 fix step 12: derived deterministically from refusedEntryHash alone, never
// caller-supplied -- every legitimate caller redelivering the SAME park entry lands
// on the SAME key, so "does the current caller already hold their own receipt for
// this exact redelivery" (the gate in redeliverBusMessage below that decides between
// answering from the marker directly vs. deferring to sendBusMessage's own receipt
// replay) is well-defined regardless of who is calling.
function redeliverIdempotencyKey(refusedEntryHash: string): string {
  return `bus-redeliver:${refusedEntryHash}`;
}

// ISS-953 fix step 12: the redeliver operation's own entry point, NOT routed through
// sendBusMessage's top-level peer resolution. A lock-free marker check runs FIRST,
// before any peer resolution, with a three-way branch that fails closed on
// corruption rather than falling through to it:
//   - Absent (ENOENT) or present-but-pending (bindings valid, successor not landed
//     yet): falls through to the ordinary pipeline below.
//   - Invalid (schema/symlink failure, a mismatched binding, or a named successor
//     that fails its own verification): throws `corrupt` immediately, before
//     anything else runs -- including before any receipt lookup -- so a caller who
//     already holds a valid receipt from an earlier, separate creation can never
//     have that receipt mask a corrupted marker (fix step 14 test viii-c). A
//     genuine non-corruption I/O failure on the read (EACCES, EMFILE, transient) is
//     neither: readJsonNoFollow already reports that as its own `io_error`, which
//     propagates as-is rather than being reinterpreted as "try again" or misreported
//     as a proven integrity failure.
//   - Verified: answered directly from the marker, replaySource: "marker", UNLESS
//     the current caller already holds their own receipt for this exact
//     redelivery's deterministic key -- a same-caller repeat (fix step 14 test viii)
//     always defers to sendBusMessage's own receipt lookup instead, so the two
//     idempotency mechanisms never trade places. Only a caller who does NOT already
//     hold that receipt (e.g. a successor endpoint redelivering after the original
//     sender's compaction, test v) is ever answered by the marker fast-path, which
//     never calls resolveActivePeer, sendBusMessage, or acquires threads.lock.
// The fallthrough pipeline constructs a normal BusSendInput from the resolved
// refused artifact and calls the EXISTING, unchanged sendBusMessage, whose OWN
// in-lock marker check inside createHopCapSuccessorThread (fix step 11) remains the
// authoritative source of truth for the race window between this fast-path read and
// lock acquisition.
export async function redeliverBusMessage(root: string, input: BusRedeliverInput): Promise<BusSendResult> {
  if (!EndpointIdSchema.safeParse(input.endpointId).success) throw new BusError("invalid_input", "Invalid endpoint id");
  if (!ThreadIdSchema.safeParse(input.predecessorThreadId).success) throw new BusError("invalid_input", "Invalid Bus thread id");
  // ISS-953 Codex round 2 finding #12: every other entry point into Bus runtime
  // state (sendBusMessage, foldBusThread's own callers, etc.) loads project
  // configuration and calls assertBusEnabled before touching anything. This
  // function resolved the runtime directly and never did -- a disabled Bus
  // project whose runtime remains on disk (bus disable does not delete it)
  // could still answer a verified-marker fast path successfully here, while
  // the SAME call falling through to sendBusMessage correctly fails closed
  // with bus_disabled. Gate identically, before any runtime read.
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveInitializedBusPaths(root);

  // Lock-free ownership check, mirroring withEndpointCaller's own guard without
  // acquiring endpoint-<id>.lock. This preflight never mutates the endpoint record,
  // so the lock stays reserved for sendBusMessage's own internal withEndpointCaller
  // call in the fallthrough pipeline below -- acquiring it twice for the same
  // endpointId within one call stack would risk a reentrant self-deadlock/timeout.
  // The marker-hit path below never reaches sendBusMessage/withEndpointCaller at
  // all, so this check is the ONLY ownership gate it ever passes through: it is
  // authoritative for that path, not a courtesy.
  const taskId = normalizeClientTaskId(input.clientTaskId);
  if (!taskId) throw new BusError("unauthorized", "A valid client task id is required");
  const { endpoints: allEndpoints, findings: endpointFindings } = await listEndpoints(paths.projectRoot);
  if (endpointFindings.length > 0) {
    throw new BusError("corrupt", `Endpoint registry is corrupt: ${endpointFindings[0]}`);
  }
  const callerEndpoint = allEndpoints.find((candidate) => candidate.endpointId === input.endpointId);
  if (!callerEndpoint || callerEndpoint.retiredAt || callerEndpoint.clientTaskId !== taskId) {
    throw new BusError("unauthorized", "Endpoint ownership does not match this task");
  }

  // CORE-only fold, same reasoning as fix step 11: locating the predecessor's park
  // entry never needs its own refusals (the very pass that reads redeliver markers).
  const predecessor = await foldBusThread(paths.projectRoot, input.predecessorThreadId);
  if (predecessor.integrity !== "verified") {
    throw new BusError("corrupt", predecessor.finding ?? "Predecessor thread is quarantined");
  }
  const parkEntry = predecessor.entries.find((entry) => entry.entryHash === input.refusedEntryHash);
  if (
    !parkEntry || parkEntry.type !== "state" || parkEntry.payload.action !== "park" ||
    parkEntry.payload.automatic !== true || parkEntry.payload.trigger !== "hop_cap" ||
    !parkEntry.payload.droppedMessage
  ) {
    throw new BusError("invalid_input", "refusedEntryHash does not name a hop-cap automatic park entry on the predecessor thread");
  }

  // Succession-chain authorization via the SAME endpointAddressees mechanism fix
  // step 11 uses inside the lock -- the AUTHORITATIVE check for the marker-hit path
  // below, and a fast, redundant early-exit for the fallthrough pipeline, whose own
  // authoritative check re-runs inside createHopCapSuccessorThread under lock.
  // ISS-953 Codex round 3 finding #12: same fail-loud-on-corrupt requirement as
  // finding #9's caller/peer checks above -- a corrupt chain must never silently
  // degrade to a self-only authorization that happens to still succeed.
  const initialCallerAddressees = endpointAddressees(callerEndpoint, allEndpoints);
  if (initialCallerAddressees.corrupt) {
    throw new BusError("corrupt", `Caller's succession chain is corrupt: ${initialCallerAddressees.corrupt}`);
  }
  if (!initialCallerAddressees.ids.includes(parkEntry.payload.byEndpoint)) {
    throw new BusError("unauthorized", "Caller's succession chain does not reach the original sender of the dropped message");
  }

  const resolvedArtifact = await readConsistentRefusedArtifact(paths, parkEntry.payload.droppedMessage);
  if (resolvedArtifact.status !== "resolved") {
    throw new BusError("corrupt", `Refused message artifact is ${resolvedArtifact.status}`);
  }
  const artifact = resolvedArtifact.artifact;

  // Lock-free marker read, outside any lock and before any peer resolution.
  // readJsonNoFollow only guards the leaf <hash>.json component against being a
  // symlink -- path resolution still traverses redeliver-markers/ itself first,
  // so validating THAT directory (not just adding nofollow on the leaf, which
  // would leave the actual gap open) is what closes a symlinked-directory escape.
  let marker: BusRedeliverMarker | null = null;
  const markerDir = await validatedRedeliverMarkerDir(paths, input.predecessorThreadId, { create: false });
  if (markerDir) {
    const markerPath = join(markerDir, `${input.refusedEntryHash}.json`);
    try {
      marker = await readJsonNoFollow(markerPath, BusRedeliverMarkerSchema);
    } catch (err) {
      // not_found -> absent, falls through below. Any other BusError (corrupt from a
      // schema/symlink failure, or io_error from anything else) propagates as-is.
      if (!(err instanceof BusError) || err.code !== "not_found") throw err;
    }
  }

  if (marker) {
    if (
      marker.predecessorThreadId !== input.predecessorThreadId ||
      marker.predecessorEntryHash !== input.refusedEntryHash ||
      marker.originalByEndpoint !== parkEntry.payload.byEndpoint
    ) {
      throw new BusError("corrupt", `Redeliver marker ${input.refusedEntryHash} exists but does not match its own bindings`);
    }
    // The SAME verification resolveRefusals/createHopCapSuccessorThread use for
    // disposition, reused directly rather than re-derived.
    const verifiedState = await verifiedSuccessorState(paths, marker, input.refusedEntryHash, artifact, parkEntry.payload.trigger, predecessor);
    if (verifiedState.status === "invalid") {
      throw new BusError("corrupt", `Redeliver marker ${input.refusedEntryHash} names a successor that fails its own verification`);
    }
    if (verifiedState.status === "verified") {
      const ownKeyHash = idempotencyKeyHash(input.endpointId, redeliverIdempotencyKey(input.refusedEntryHash));
      const ownReceipt = await readReceipt(paths, input.endpointId, ownKeyHash);
      // redeliverIdempotencyKey's "bus-redeliver:" string is not a reserved
      // namespace: an earlier draft of this fix rejected any ordinary send whose
      // caller-chosen idempotencyKey happened to start with it, which broke
      // retries for any pre-existing send that legitimately used that literal
      // string before this derivation existed. A receipt found at this derived
      // key is therefore only genuinely "this caller's own prior redelivery
      // attempt" if it actually names the successor thread THIS verified marker
      // names -- a cheap, precise, purpose-built check: a genuine own-redelivery
      // receipt was written by an earlier call's createHopCapSuccessorThread
      // using exactly marker.successorThreadId, so any receipt naming a
      // different thread is an unrelated collision (accidental, or a caller
      // pre-registering a receipt at a refusedEntryHash they predicted), not
      // evidence of a real prior redelivery -- treat it the same as no receipt
      // at all rather than deferring to sendBusMessage's replay, which would
      // otherwise report a false idempotency_conflict against that unrelated
      // receipt's own payloadHash instead of answering from the verified marker.
      //
      // ISS-953 Codex round 3 finding #13: threadId alone under-specifies "this
      // caller's own prior redelivery" -- the derived key namespace is NOT
      // reserved (see immediately above), so an ORDINARY later send on the
      // SUCCESSOR thread itself can legitimately occupy this exact derived key
      // (an unusual but on-disk-constructible caller choice, or a coincidence),
      // producing a receipt whose threadId matches marker.successorThreadId but
      // whose messageId is that ordinary message's, never the original
      // redelivery's. That receipt would then misclassify as a genuine
      // own-redelivery receipt, fall through to sendBusMessage's replay, and
      // throw a false idempotency_conflict there (payloadHash mismatch against
      // the artifact) instead of answering from the already-verified marker.
      // Require BOTH threadId AND messageId to match verifiedState's own
      // message (the actual first entry the marker's successor thread verified
      // to), and require the receipt to be "final" (never "pending" -- a
      // pending receipt has not committed a publication identity at all, per
      // idempotency.ts's own invariant, so it cannot be evidence of a prior
      // redelivery either).
      //
      // Reachability note (traced the same way as finding #10's): an ordinary
      // reply requires LITERAL thread-participant membership with no succession
      // fallback (readThreadParticipants), and a thread's participants are fixed
      // permanently to whichever two identities existed at its creation. The
      // caller eligible for THIS branch (no receipt of its own yet) is, by
      // definition, a successor of whoever created the marker's successor
      // thread -- a different literal identity than either fixed participant --
      // so it cannot itself send the colliding ordinary reply there, and the
      // endpoint that DID create the thread already holds the correct, matching
      // receipt (reusing its own key can only replay identically, never diverge
      // to a different messageId). The scenario this guards is therefore not
      // reachable via legitimate succession either; it hardens against a
      // hand-forged or otherwise corrupted receipt file (see this fix's test).
      if (
        !ownReceipt || ownReceipt.state !== "final" ||
        ownReceipt.threadId !== marker.successorThreadId ||
        ownReceipt.messageId !== verifiedState.message.messageId
      ) {
        // A caller who does NOT already hold their own receipt for this exact
        // redelivery (the succession case, test v): answer directly from the
        // verified marker, without ever calling resolveActivePeer/sendBusMessage.
        // This path never acquires threads.lock -- the successor thread already
        // exists, nothing is published here -- but it DOES need endpoint-<id>.lock:
        // the ownership and succession-chain checks above (this function's own
        // lock-free endpoint-ownership and initialCallerAddressees checks) ran
        // lock-free, before this branch was even known to be reachable, so a
        // TOCTOU window separates that snapshot from this return. The fallthrough
        // pipeline below closes the equivalent window by revalidating both under
        // lock inside sendBusMessage's own withEndpointCaller call; this fast path
        // must do the same rather than trust the earlier snapshot. That concern is
        // about the CALLER's ownership/succession chain specifically (re-checked
        // fresh, under lock, in the callback below) -- it is orthogonal to the
        // SUCCESSOR thread's own provenance, which is what the verifiedState
        // snapshot just above already established.
        //
        // ISS-953 Codex round 2 finding #14: use verifiedState's OWN fold/message
        // here, never a fresh foldBusThread call -- a second, unverified fold
        // reopens exactly the TOCTOU this finding named: the successor directory
        // could change between verifiedSuccessorState's read and a second one, and
        // a bare integrity+entry-zero-is-message check on that second read never
        // re-confirms the provenance/artifact-match verifiedSuccessorState just
        // proved. Reusing the verified snapshot removes the second read entirely.
        const successorFold = verifiedState.fold;
        const successorMessage = verifiedState.message;
        return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (freshEndpoint) => {
          // withEndpointCaller itself re-checks retiredAt/clientTaskId under
          // endpoint-<id>.lock -- that alone catches the caller's own endpoint
          // having been retired since the lock-free snapshot. Re-run the
          // succession-chain check too: a retirement can be paired with a
          // successor endpoint taking over input.endpointId's identity, which
          // withEndpointCaller's ownership check alone would not catch.
          const { endpoints: freshEndpoints, findings: freshFindings } = await listEndpoints(paths.projectRoot);
          if (freshFindings.length > 0) {
            throw new BusError("corrupt", `Endpoint registry is corrupt: ${freshFindings[0]}`);
          }
          // ISS-953 Codex round 3 finding #12 (under-lock recheck, the uncited
          // sibling of the initial authorization above): same requirement.
          const freshAddressees = endpointAddressees(freshEndpoint, freshEndpoints);
          if (freshAddressees.corrupt) {
            throw new BusError("corrupt", `Caller's succession chain is corrupt: ${freshAddressees.corrupt}`);
          }
          if (!freshAddressees.ids.includes(parkEntry.payload.byEndpoint)) {
            throw new BusError("unauthorized", "Caller's succession chain does not reach the original sender of the dropped message");
          }
          return {
            threadId: successorFold.thread.threadId,
            messageId: successorMessage.messageId,
            toEndpoint: successorMessage.to,
            state: successorFold.state,
            hopCount: successorFold.hopCount,
            hopsRemaining: hopsRemainingFor(successorFold),
            replayed: true,
            replaySource: "marker",
            parked: false,
            nextAction: null,
          };
        });
      }
      // The caller already holds their own receipt for this exact redelivery (a
      // same-caller repeat, fix step 14 test viii): fall through below so
      // sendBusMessage's OWN receipt lookup answers it, replaySource: "receipt".
      // The marker read above already ran unconditionally, so a corrupted marker is
      // still caught regardless (test viii-c) -- only the ANSWER differs here.
      //
      // Peer-liveness qualification for this fallthrough: sendBusMessage's own
      // no-peer handling (the newThreadNoPeer deferred-check block above) replays a
      // receipt directly by keyHash whenever resolveActivePeer returns null,
      // independent of current peer liveness -- that covers this fallthrough
      // whenever a succession is in flight, because succession retires the
      // predecessor FIRST and creates the successor SECOND (endpoints.ts), so the
      // window this fallthrough runs in never presents MORE than one endpoint
      // missing at once. It does NOT cover the two cases where resolveActivePeer
      // THROWS instead of returning null -- a genuine two-active-peer conflict or a
      // corrupt endpoint registry -- neither of which succession can produce; those
      // reach here only via an unrelated fault outside this operation, in which case
      // this fallthrough surfaces that fault's own error rather than a corruption
      // this branch masks (the marker was already validated above).
    }
    // state === "pending": unverifiable -- equally the shape of a legitimate
    // marker-written-before-thread-landed crash window and of a bindings-valid
    // forged marker (see fold.ts's verifiedSuccessorState header comment).
    // ISS-953 Codex byte-review fix: this comment previously said the fallthrough
    // "resumes creation using the marker's own pre-assigned successorThreadId" --
    // that described the pre-ISS-1002 model. Since the ISS-1002 interim remedy,
    // it does not: falling through below reaches createHopCapSuccessorThread's own
    // "pending" branch, which durably supersedes this marker with a FRESH id
    // rather than adopting the one it names.
  }

  // Absent, pending, or verified-but-caller-already-has-a-receipt: defer to the
  // existing, unchanged send pipeline for its own peer resolution, receipt lookup,
  // and dispatch to createThread's hop_cap_successor branch.
  return sendBusMessage(root, {
    endpointId: input.endpointId,
    clientTaskId: input.clientTaskId,
    threadKind: "issue_notice",
    messageKind: artifact.messageKind,
    severity: artifact.severity,
    body: artifact.body,
    refs: artifact.refs,
    idempotencyKey: redeliverIdempotencyKey(input.refusedEntryHash),
    predecessorThreadId: input.predecessorThreadId,
    predecessorRelation: "hop_cap_successor",
    refusedEntryHash: input.refusedEntryHash,
  });
}

async function mailboxPointers(paths: BusPaths, endpointId: string): Promise<{ pointers: BusMailboxPointer[]; findings: string[] }> {
  const mailbox = endpointMailboxPath(paths, endpointId);
  const pointers: BusMailboxPointer[] = [];
  const findings: string[] = [];
  for (const directory of [mailbox, join(mailbox, "pending")]) {
    for (const filename of await listRegularJsonFiles(directory)) {
      // A dot-prefixed `.json` entry is unexpected where only pointers (and
      // counter.json) belong: durable-write temp files are never dot-prefixed, so a
      // pointer renamed `<pointer>.json` -> `.<pointer>.json` would otherwise be
      // silently dropped by the POINTER_FILENAME skip and hidden from delivery.
      if (filename.startsWith(".")) {
        findings.push(`${filename}: unexpected dot-prefixed entry`);
        continue;
      }
      if (!POINTER_FILENAME.test(filename)) continue;
      try {
        const pointer = await readJsonNoFollow(join(directory, filename), BusMailboxPointerSchema);
        if (pointer.endpointId !== endpointId || pointerFilename(pointer) !== filename) {
          throw new BusError("corrupt", "Mailbox pointer envelope does not match its endpoint or filename");
        }
        pointers.push(pointer);
      } catch (err) {
        findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const unique = new Map<string, BusMailboxPointer>();
  for (const pointer of pointers) unique.set(pointer.messageId, pointer);
  return { pointers: [...unique.values()].sort((a, b) => a.mailboxSeq - b.mailboxSeq), findings };
}

// T-427 cheap tool-hook gate. Lock-free, fold-free discriminated high-water read:
// counter.json's `nextSeq` is the NEXT seq to hand out, so the highest seq already
// allocated to this mailbox is `nextSeq - 1`. A mailbox that never allocated has no
// counter.json (readJsonNoFollow -> BusError "not_found") -> `known: false`. Any
// OTHER failure (corrupt/symlinked/unreadable counter) propagates so an unreadable
// counter is never silently treated as "unknown". Lock-free is sound: a concurrent
// allocateMailboxSeq only ever RAISES nextSeq, so a torn read under-reports by at
// most one and never over-reports, and the tool gate treats "unknown" as "escalate".
export type MailboxHighwater =
  | { readonly known: true; readonly highwater: number }
  | { readonly known: false };

export async function readMailboxHighwater(paths: BusPaths, endpointId: string): Promise<MailboxHighwater> {
  const counterPath = join(endpointMailboxPath(paths, endpointId), "counter.json");
  try {
    const counter = await readJsonNoFollow(counterPath, BusMailboxCounterSchema);
    return { known: true, highwater: counter.nextSeq - 1 };
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return { known: false };
    throw err;
  }
}

// T-427 hot-path seed. A never-messaged endpoint has no counter.json, so its PostToolUse
// gate would fall to the mailboxHasPointerCandidate directory scan on EVERY tool call
// (readMailboxHighwater returns `known:false` until the first send allocates a seq).
// After the gate confirms the mailbox is present-and-empty AND the endpoint has no
// surfaced history (all delivery cursors zero -- the caller's precondition), it seeds
// counter.json with `nextSeq:1`, so subsequent tool calls take the single-read
// known-highwater fast path (highwater 0, not newer -> skip) instead of re-scanning.
//
// The seed runs under the SAME per-mailbox lock allocateMailboxSeq uses and re-reads the
// counter while holding it, seeding only if still absent. This serializes with a racing
// first send: durableCreate exposes the final pathname before its write completes, so
// seeding OUTSIDE the lock could hand a concurrent allocateMailboxSeq a partially-written
// counter (a transient corrupt read). Under the lock, either the send already allocated
// (counter present -> skip) or it has not (counter absent -> we write nextSeq:1, which is
// exactly the send's own starting floor). One-time per never-messaged endpoint.
export async function seedMailboxCounterIfAbsent(paths: BusPaths, endpointId: string): Promise<void> {
  const mailbox = endpointMailboxPath(paths, endpointId);
  const counterPath = join(mailbox, "counter.json");
  await withHardenedLock(join(paths.locks, `mailbox-${endpointId}.lock`), async () => {
    try {
      await readJsonNoFollow(counterPath, BusMailboxCounterSchema);
      return; // already allocated/seeded by a racing send -> nothing to do
    } catch (err) {
      if (!(err instanceof BusError) || err.code !== "not_found") throw err;
    }
    await durableCreate(counterPath, serialize({
      schema: "storybloq-bus-mailbox-counter/v1",
      nextSeq: 1,
      updatedAt: new Date().toISOString(),
    }));
  });
}

// T-427 fold-free existence probe used by the rendezvous long-poll interval tick:
// does the endpoint's mailbox hold ANY pointer-shaped file (active or pending)?
// Mirrors mailboxPointers' directory walk + POINTER_FILENAME filter but never
// reads, schema-validates, dedups, or folds a thread. counter.json never matches
// POINTER_FILENAME so it is ignored.
//
// This is a fail-toward-escalation detector, NOT a silent emptiness oracle: a
// present-and-readable mailbox with no pointer-named entry is the only "definitely
// nothing" answer (returns false). A MISSING, symlinked, or unreadable mailbox
// directory is corruption/deletion, not emptiness, so it THROWS -- the wait loop's
// interval tick catches the throw and escalates to the authoritative pollBus, which
// surfaces the real runtime_lost/corrupt cause instead of waiting to the deadline. A
// pointer-NAMED entry that is not a plain regular file (a symlink swap, FIFO, or dir)
// is also treated as a candidate so the authoritative poll inspects/quarantines it.
export async function mailboxHasPointerCandidate(paths: BusPaths, endpointId: string): Promise<boolean> {
  const mailbox = endpointMailboxPath(paths, endpointId);
  // The mailbox is required; its `pending` child is created lazily, so only its absence
  // is benign. Each directory is lstat'd no-follow BEFORE and AFTER enumeration: a
  // symlinked directory (an attack that would redirect the scan outside the runtime) is
  // rejected, and a swap to a different inode during readdir is caught by the dev/ino
  // revalidation -- both escalate to the authoritative poll rather than trusting a
  // possibly-redirected listing.
  const targets: ReadonlyArray<{ readonly dir: string; readonly optional: boolean }> = [
    { dir: mailbox, optional: false },
    { dir: join(mailbox, "pending"), optional: true },
  ];
  for (const { dir, optional } of targets) {
    let before;
    try {
      before = await lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // ONLY absence at this INITIAL lstat is benign, and only for the optional pending
        // child (lazily created). The required mailbox being absent is deletion.
        if (optional) continue;
        throw new BusError("corrupt", `Mailbox directory is missing for endpoint ${endpointId}`, err);
      }
      throw new BusError("corrupt", `Mailbox directory is unreadable for endpoint ${endpointId}`, err);
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new BusError("corrupt", `Mailbox path for endpoint ${endpointId} is a symlink or not a directory`);
    }
    // The directory PROVABLY existed as of `before`. Any ENOENT from here on is a mid-scan
    // DELETION, not lazy absence, so it escalates regardless of `optional` -- otherwise a
    // pending dir removed after readdir could discard already-enumerated pointer entries
    // and report a false "empty".
    if (afterMailboxLstatHook) await afterMailboxLstatHook(dir); // test seam: mutate mid-scan
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new BusError("corrupt", `Mailbox directory vanished or became unreadable mid-scan for endpoint ${endpointId}`, err);
    }
    let after;
    try {
      after = await lstat(dir);
    } catch (err) {
      throw new BusError("corrupt", `Mailbox directory vanished during scan for endpoint ${endpointId}`, err);
    }
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new BusError("corrupt", `Mailbox directory identity changed during scan for endpoint ${endpointId}`);
    }
    for (const entry of entries) {
      if (POINTER_FILENAME.test(entry.name)) return true;
    }
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function recoverPendingIntent(
  paths: BusPaths,
  pointer: BusMailboxPointer,
): Promise<string | null> {
  const mailbox = endpointMailboxPath(paths, pointer.endpointId);
  const filename = pointerFilename(pointer);
  const pending = join(mailbox, "pending", filename);
  const lockPath = await pathExists(join(paths.threads, pointer.threadId, "thread.json"))
    ? join(paths.locks, `thread-${pointer.threadId}.lock`)
    : join(paths.locks, "threads.lock");

  return withHardenedLock(lockPath, async () => {
    let folded: FoldedBusThread;
    try {
      folded = await foldBusThread(paths.projectRoot, pointer.threadId);
    } catch (err) {
      if (err instanceof BusError && err.code === "not_found") {
        await durableUnlink(pending);
        return null;
      }
      return `${filename}: ${err instanceof Error ? err.message : String(err)}`;
    }
    const entry = folded.entries[pointer.entrySeq - 1];
    if (entry?.type === "message" && entry.entryHash === pointer.entryHash &&
        entry.payload.messageId === pointer.messageId && entry.payload.to === pointer.endpointId) {
      await activatePointer({ pending, active: join(mailbox, filename) });
      return null;
    }
    if (folded.integrity === "verified" || pointer.entrySeq > folded.validThroughSeq) {
      await durableUnlink(pending);
      return null;
    }
    return `${filename}: pending intent does not match the verified thread prefix`;
  });
}

async function reconcileEndpointMailbox(
  paths: BusPaths,
  endpoint: BusEndpoint,
  allEndpoints: readonly BusEndpoint[],
): Promise<{ pointers: BusMailboxPointer[]; findings: string[] }> {
  const endpointId = endpoint.endpointId;
  return withHardenedLock(join(paths.locks, `mailbox-reconcile-${endpointId}.lock`), async () => {
    const mailbox = endpointMailboxPath(paths, endpointId);
    const findings: string[] = [];
    // ISS-872: this endpoint redelivers mail addressed to itself OR to any ancestor in
    // its bounded predecessor chain (a successor inherits its lineage's undelivered
    // mail). A corrupt chain fails closed to self-only and surfaces a finding.
    const { ids: addressees, corrupt: chainCorrupt } = endpointAddressees(endpoint, allEndpoints);
    if (chainCorrupt) findings.push(`succession chain: ${chainCorrupt}`);
    for (const filename of await listRegularJsonFiles(join(mailbox, "pending"))) {
      // A dot-prefixed pending intent is unexpected (temp files are never
      // dot-prefixed); report it rather than let the POINTER_FILENAME skip hide it.
      if (filename.startsWith(".")) {
        findings.push(`${filename}: unexpected dot-prefixed entry`);
        continue;
      }
      if (!POINTER_FILENAME.test(filename)) continue;
      try {
        const pointer = await readJsonNoFollow(join(mailbox, "pending", filename), BusMailboxPointerSchema);
        if (pointer.endpointId !== endpointId || pointerFilename(pointer) !== filename) {
          throw new BusError("corrupt", "Mailbox pointer envelope does not match its endpoint or filename");
        }
        const finding = await recoverPendingIntent(paths, pointer);
        if (finding) findings.push(finding);
      } catch (err) {
        findings.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let current = await mailboxPointers(paths, endpointId);
    findings.push(...current.findings);
    const known = new Set(current.pointers.map((pointer) => pointer.messageId));
    for (const threadId of await listThreadIds(paths)) {
      let folded: FoldedBusThread;
      try {
        folded = await foldBusThread(paths.projectRoot, threadId);
      } catch (err) {
        findings.push(`${threadId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // A resolved thread is terminal: its messages need no delivery (checkBusShip exempts
      // them and the ship gate is already clear), so never recreate pointers for it.
      if (folded.state === "resolved") continue;
      for (const entry of folded.entries) {
        if (entry.type !== "message" || !addressees.includes(entry.payload.to) ||
            folded.acknowledgments.has(entry.payload.messageId) || known.has(entry.payload.messageId)) continue;
        const latest = await mailboxPointers(paths, endpointId);
        findings.push(...latest.findings);
        if (latest.pointers.some((pointer) => pointer.messageId === entry.payload.messageId)) {
          known.add(entry.payload.messageId);
          continue;
        }
        const mailboxSeq = await allocateMailboxSeq(paths, endpointId);
        // The pointer is stamped with THIS endpoint's id (it lives in this mailbox) even
        // when the thread entry's `to` is an ancestor; the read seams accept it because
        // the ancestor's `to` is in this endpoint's addressee set.
        const pointer = makePointer(endpointId, mailboxSeq, entry);
        try {
          await durableCreate(join(mailbox, pointerFilename(pointer)), serialize(pointer));
          known.add(entry.payload.messageId);
        } catch (err) {
          if (!(err instanceof BusError) || err.code !== "conflict") throw err;
        }
      }
    }

    // ISS-872 succession sweep. After redelivery, reclaim retired ancestors' now-
    // redundant pointer files so doctor stops flagging them -- but ONLY files that
    // parse, match their own envelope+filename, AND whose message is already
    // redelivered to this successor or already acked. Anything else (unparseable,
    // mismatched, or not-yet-redelivered) is PRESERVED as corruption/loss evidence
    // with a finding (mirrors mailboxPointers' fail-closed policy). Never unlink by
    // filename alone. Runs LAST so every unacked message keeps >=1 pointer throughout.
    const ancestors = addressees.filter((id) => id !== endpointId);
    if (ancestors.length > 0) {
      const foldCache = new Map<string, FoldedBusThread | null>();
      const foldFor = async (threadId: string): Promise<FoldedBusThread | null> => {
        if (!foldCache.has(threadId)) {
          try {
            foldCache.set(threadId, await foldBusThread(paths.projectRoot, threadId));
          } catch {
            foldCache.set(threadId, null);
          }
        }
        return foldCache.get(threadId) ?? null;
      };
      // Canonically-verified redelivered ids: a corrupt successor pointer (valid
      // envelope, wrong canonical binding) must NOT authorize deleting an ancestor's
      // only valid pointer, so require each successor pointer to match its canonical entry.
      const afterScan = await mailboxPointers(paths, endpointId);
      const delivered = new Set<string>();
      for (const pointer of afterScan.pointers) {
        if (pointerMatchesCanonical(await foldFor(pointer.threadId), pointer, addressees)) {
          delivered.add(pointer.messageId);
        }
      }
      for (const ancestorId of ancestors) {
        const ancestorMailbox = endpointMailboxPath(paths, ancestorId);
        for (const directory of [ancestorMailbox, join(ancestorMailbox, "pending")]) {
          for (const filename of await listRegularJsonFiles(directory)) {
            if (filename.startsWith(".")) {
              findings.push(`${ancestorId} mailbox: ${filename}: unexpected dot-prefixed entry`);
              continue;
            }
            if (!POINTER_FILENAME.test(filename)) continue;
            let pointer: BusMailboxPointer;
            try {
              pointer = await readJsonNoFollow(join(directory, filename), BusMailboxPointerSchema);
            } catch (err) {
              findings.push(`${ancestorId} mailbox: ${filename}: ${err instanceof Error ? err.message : String(err)}`);
              continue;
            }
            if (pointer.endpointId !== ancestorId || pointerFilename(pointer) !== filename) {
              findings.push(`${ancestorId} mailbox: ${filename}: pointer envelope does not match its endpoint or filename`);
              continue;
            }
            // Never unlink a pointer that does not match a VERIFIED canonical entry
            // (preserve corruption evidence, mirroring mailboxPointers' fail-closed policy).
            const folded = await foldFor(pointer.threadId);
            if (!pointerMatchesCanonical(folded, pointer, addressees)) {
              findings.push(`${ancestorId} mailbox: ${filename}: retained; pointer does not match a verified thread entry`);
              continue;
            }
            // Reclaimable when redelivered, already acked, or in a resolved (terminal)
            // thread -- none of which need a live pointer.
            const redundant = delivered.has(pointer.messageId) ||
              (folded?.acknowledgments.has(pointer.messageId) ?? false) ||
              folded?.state === "resolved";
            if (redundant) {
              await durableUnlink(join(directory, filename)).catch(() => undefined);
            } else {
              findings.push(`${ancestorId} mailbox: ${filename}: retained; message ${pointer.messageId} not yet redelivered to successor ${endpointId}`);
            }
          }
        }
      }
    }

    current = await mailboxPointers(paths, endpointId);
    return { pointers: current.pointers, findings: [...new Set([...findings, ...current.findings])] };
  });
}

// ISS-872: eager successor materialization. Runs reconcile's pointer-creation pass
// so a fresh successor's PHYSICAL mailbox holds its inherited pointers immediately
// after `setup --replace`, before any explicit poll. The live delivery hooks gate on
// the physical mailbox (readMailboxHighwater / mailboxHasPointerCandidate), so without
// this the inherited mail would stay invisible to the on-stop/on-tool tiers until the
// user happened to poll. reconcile advances NO delivery cursor (pollBus does that), so
// this does not mark the inherited mail as surfaced. Best-effort by contract: the
// caller treats a throw as a degraded-delivery signal and the next real poll's reconcile
// materializes idempotently, so mail is never lost, only deferred.
export type MaterializeStatus = "materialized" | "endpoint_inactive";

export async function materializeSuccessorMailbox(
  root: string,
  endpoint: BusEndpoint,
): Promise<{ status: MaterializeStatus; pointers: BusMailboxPointer[]; findings: string[] }> {
  if (materializeFailureHook) await materializeFailureHook();
  const paths = await resolveInitializedBusPaths(root);
  const { endpoints } = await listEndpoints(paths.projectRoot);
  // Trust the REGISTRY, not the caller-supplied object: a stale/forged record (or a
  // concurrent retire/replace between join and materialization) must never supply a
  // different predecessor chain than the current canonical endpoint. Look the endpoint up
  // by id and reconcile against that record only. A missing or retired record means there
  // is nothing to materialize for this endpoint -- reported as `endpoint_inactive` (not a
  // silent success) so the caller does not claim materialization completed.
  const canonical = endpoints.find((candidate) => candidate.endpointId === endpoint.endpointId);
  if (!canonical || canonical.retiredAt) return { status: "endpoint_inactive", pointers: [], findings: [] };
  const result = await reconcileEndpointMailbox(paths, canonical, endpoints);
  return { status: "materialized", ...result };
}

// ISS-872: read-only count of the distinct DELIVERABLE messages physically present in an
// endpoint's mailbox (canonically verified, unacknowledged, in an unresolved thread), so
// `setup --replace` reports only mail the successor will actually surface -- never
// acked/resolved/corrupt residue. Chain-aware: a message counts when its canonical
// recipient is any endpoint in this endpoint's bounded predecessor chain, so inherited
// mail (addressed to a retired predecessor) counts when read from the SUCCESSOR's mailbox
// after materialization has swept it across. A peer's chain is just itself, so a
// wrong-mailbox pointer addressed to someone outside the chain is still excluded. Counted
// AFTER replacement + materialization, so a message that arrived at the incumbent during
// the replacement window is included -- never a pre-mutation snapshot.
export async function countUndeliveredMessages(root: string, endpointId: string): Promise<number> {
  if (countFailureHook) await countFailureHook();
  const paths = await resolveInitializedBusPaths(root);
  const { endpoints } = await listEndpoints(paths.projectRoot);
  const canonical = endpoints.find((candidate) => candidate.endpointId === endpointId);
  const addressees = new Set(canonical ? endpointAddressees(canonical, endpoints).ids : [endpointId]);
  const { pointers } = await mailboxPointers(paths, endpointId);
  const foldCache = new Map<string, FoldedBusThread | null>();
  const counted = new Set<string>();
  for (const pointer of pointers) {
    if (!foldCache.has(pointer.threadId)) {
      try {
        foldCache.set(pointer.threadId, await foldBusThread(paths.projectRoot, pointer.threadId));
      } catch {
        foldCache.set(pointer.threadId, null);
      }
    }
    const folded = foldCache.get(pointer.threadId) ?? null;
    const entry = folded?.entries[pointer.entrySeq - 1];
    if (!folded || folded.integrity !== "verified" || folded.state === "resolved" ||
        !entry || entry.type !== "message" || entry.entryHash !== pointer.entryHash ||
        entry.payload.messageId !== pointer.messageId || !addressees.has(entry.payload.to) ||
        folded.acknowledgments.has(pointer.messageId)) continue;
    counted.add(entry.payload.messageId);
  }
  return counted.size;
}

async function pointerPaths(paths: BusPaths, pointer: BusMailboxPointer): Promise<string[]> {
  const mailbox = endpointMailboxPath(paths, pointer.endpointId);
  const filename = pointerFilename(pointer);
  return [join(mailbox, filename), join(mailbox, "pending", filename)];
}

async function removePointer(paths: BusPaths, pointer: BusMailboxPointer): Promise<void> {
  for (const path of await pointerPaths(paths, pointer)) await durableUnlink(path).catch(() => undefined);
}

export async function pollBus(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  limit?: number;
}): Promise<BusPollResult> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveInitializedBusPaths(root);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint, persist) => {
    const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit!) : 20;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    // ISS-872: load the endpoint list once so reconcile can redeliver inherited mail and
    // entry validation can accept any addressee in this endpoint's predecessor chain.
    const { endpoints: allEndpoints } = await listEndpoints(paths.projectRoot);
    const addressees = endpointAddressees(endpoint, allEndpoints).ids;
    const mailbox = await reconcileEndpointMailbox(paths, endpoint, allEndpoints);
    const messages: BusPollEnvelope[] = [];
    let cursor = endpoint.lastPolledMailboxSeq;

    for (const pointer of mailbox.pointers) {
      if (messages.length >= limit) break;
      let folded: FoldedBusThread;
      try {
        folded = await foldBusThread(paths.projectRoot, pointer.threadId);
      } catch (err) {
        mailbox.findings.push(`${pointer.threadId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const entry = folded.entries[pointer.entrySeq - 1];
      if (!entry || entry.type !== "message" || entry.entryHash !== pointer.entryHash ||
          entry.payload.messageId !== pointer.messageId || !addressees.includes(entry.payload.to)) {
        mailbox.findings.push(`${pointer.messageId}: mailbox pointer does not match the valid thread prefix`);
        continue;
      }
      await ensureDerivedThread(paths.projectRoot, folded).catch(() => undefined);
      // Terminal: an acked message, or ANY message in a resolved thread, is not surfaced.
      // The pointer is reclaimed so it stops lingering (mirrors the reconcile sweep).
      if (folded.acknowledgments.has(pointer.messageId) || folded.state === "resolved") {
        await removePointer(paths, pointer);
        continue;
      }
      messages.push({
        source: "storybloq_bus",
        authority: "peer_agent",
        integrity: folded.integrity,
        sender: {
          endpointId: entry.payload.from.endpointId,
          client: entry.payload.from.client,
          role: derivedRole(entry.payload.kind),
        },
        threadId: pointer.threadId,
        mailboxSeq: pointer.mailboxSeq,
        message: entry.payload,
      });
      cursor = Math.max(cursor, pointer.mailboxSeq);
    }

    if (cursor !== endpoint.lastPolledMailboxSeq || messages.length > 0) {
      await persist((current) => ({
        ...current,
        lastPolledMailboxSeq: Math.max(current.lastPolledMailboxSeq, cursor),
        lastSeenAt: new Date().toISOString(),
      }));
    }
    return { endpointId: endpoint.endpointId, cursor, messages, findings: mailbox.findings };
  });
}

async function findMessageThread(paths: BusPaths, endpointId: string, messageId: string): Promise<string | null> {
  const mailbox = await mailboxPointers(paths, endpointId);
  const pointer = mailbox.pointers.find((candidate) => candidate.messageId === messageId);
  if (pointer) return pointer.threadId;
  for (const threadId of await listThreadIds(paths)) {
    const folded = await foldBusThread(paths.projectRoot, threadId);
    if (folded.messages.some((message) => message.messageId === messageId)) return threadId;
  }
  return null;
}

function validateAckTransition(previous: BusAckPayload | undefined, next: BusAckPayload): "new" | "replay" {
  if (!previous) return "new";
  if (previous.disposition === next.disposition && previous.reason === next.reason) return "replay";
  if (previous.disposition === "deferred" && ["accepted", "rejected"].includes(next.disposition)) return "new";
  throw new BusError("conflict", `Cannot change ${previous.disposition} acknowledgment to ${next.disposition}`);
}

export async function acknowledgeBusMessage(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  messageId: string;
  disposition: "accepted" | "rejected" | "deferred";
  reason?: string;
}): Promise<{ threadId: string; replayed: boolean }> {
  if (!MessageIdSchema.safeParse(input.messageId).success) throw new BusError("invalid_input", "Invalid message id");
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  // D5 legacy-drain: ack a pending v1 message so the migration drain gate can clear.
  if (await classifyBusRuntime(root) === "v1") return ackV1(root, input);
  const paths = await resolveInitializedBusPaths(root);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) => {
    // ISS-872: a successor may ack mail addressed to any ancestor in its predecessor chain.
    const { endpoints: allEndpoints } = await listEndpoints(paths.projectRoot);
    const addressees = endpointAddressees(endpoint, allEndpoints).ids;
    const threadId = await findMessageThread(paths, endpoint.endpointId, input.messageId);
    if (!threadId) throw new BusError("not_found", "Bus message not found");
    return withHardenedLock(join(paths.locks, `thread-${threadId}.lock`), async () => {
      let folded = await foldBusThread(paths.projectRoot, threadId);
      if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
      const message = folded.messages.find((candidate) => candidate.messageId === input.messageId);
      if (!message || !addressees.includes(message.to)) throw new BusError("unauthorized", "Message is not addressed to this endpoint");
      const reasonText = input.reason?.trim();
      if ((input.disposition === "rejected" || input.disposition === "deferred") && !reasonText) {
        throw new BusError("invalid_input", `A reason is required for ${input.disposition} acknowledgment`);
      }
      const reason = reasonText
        ? normalizeBusText(input.reason!, "Acknowledgment reason", 4096)
        : undefined;
      const payload: BusAckPayload = {
        messageId: input.messageId,
        byEndpoint: endpoint.endpointId,
        disposition: input.disposition,
        ...(reason ? { reason } : {}),
      };
      const transition = validateAckTransition(folded.acknowledgments.get(input.messageId), payload);
      if (transition === "replay") return { threadId, replayed: true };
      const entry = makeEntry({
        type: "ack",
        threadId,
        seq: folded.validThroughSeq + 1,
        prevHash: folded.lastHash,
        payload,
      });
      await durableCreate(join(paths.threads, threadId, "entries", entryFilename(entry)), serialize(entry));
      const pointers = await mailboxPointers(paths, endpoint.endpointId);
      for (const pointer of pointers.pointers.filter((candidate) => candidate.messageId === input.messageId)) {
        await removePointer(paths, pointer);
      }
      folded = await foldBusThread(paths.projectRoot, threadId);
      await writeDerivedThread(paths.projectRoot, folded).catch(() => undefined);
      return { threadId, replayed: false };
    });
  });
}

export async function getBusThread(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  threadId: string;
}): Promise<FoldedBusThread> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  return withEndpointCaller(root, input.endpointId, input.clientTaskId, async (endpoint) => {
    // ISS-953: bus_thread_get is a top-level caller (fix step 8) -- render the full
    // refusal history, not just the core fold.
    const folded = await foldBusThread(root, input.threadId, { includeRefusals: true });
    // ISS-872: a successor inherits participation in its predecessor chain's threads.
    const { endpoints: allEndpoints } = await listEndpoints(root);
    const addressees = endpointAddressees(endpoint, allEndpoints).ids;
    if (!addressees.some((id) => participantsInclude(folded.thread, id))) {
      throw new BusError("unauthorized", "Endpoint is not a participant in this thread");
    }
    return folded;
  });
}

async function validateCommitEvidence(root: string, evidence: BusEvidenceRef): Promise<void> {
  if (!evidence.commit) return;
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["rev-parse", "--verify", `${evidence.commit}^{commit}`], { cwd: root, timeout: 3000 }, (err) => {
      if (err) reject(new BusError("invalid_input", `Commit evidence does not resolve: ${evidence.commit}`));
      else resolve();
    });
  });
}

export async function updateBusThread(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  threadId: string;
  action: "park" | "resolve" | "reopen";
  reason?: string;
  resolution?: string;
  evidence?: BusEvidenceRef;
}): Promise<FoldedBusThread> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveInitializedBusPaths(root);
  return withEndpointCaller(paths.projectRoot, input.endpointId, input.clientTaskId, async (endpoint) =>
    withHardenedLock(join(paths.locks, `thread-${input.threadId}.lock`), async () => {
    let folded = await foldBusThread(paths.projectRoot, input.threadId);
    if (folded.integrity !== "verified") throw new BusError("corrupt", folded.finding ?? "Thread is quarantined");
    // ISS-872: a successor inherits participation in its predecessor chain's threads.
    const { endpoints: allEndpoints } = await listEndpoints(paths.projectRoot);
    if (!endpointAddressees(endpoint, allEndpoints).ids.some((id) => participantsInclude(folded.thread, id))) {
      throw new BusError("unauthorized", "Endpoint is not a thread participant");
    }
    const reason = input.reason?.trim()
      ? normalizeBusText(input.reason, "Thread-state reason", 4096)
      : undefined;
    const resolution = input.resolution?.trim()
      ? normalizeBusText(input.resolution, "Thread resolution", 8192)
      : undefined;
    let evidence: BusEvidenceRef | undefined;
    if (input.evidence) {
      const parsed = BusEvidenceRefSchema.safeParse(input.evidence);
      if (!parsed.success) throw new BusError("invalid_input", "Invalid thread-state evidence");
      const ciRun = parsed.data.ciRun?.trim();
      if (parsed.data.ciRun && !ciRun) throw new BusError("invalid_input", "CI evidence cannot be empty");
      if (ciRun) assertNoHighConfidenceSecret(ciRun, "Thread-state evidence");
      evidence = {
        ...(parsed.data.commit ? { commit: parsed.data.commit.toLowerCase() } : {}),
        ...(ciRun ? { ciRun } : {}),
      };
    }
    if (input.action === "park" && (folded.state !== "open" || !reason)) {
      throw new BusError("invalid_input", "Parking an open thread requires a reason");
    }
    if (input.action === "resolve") {
      if (folded.state === "resolved" || !resolution || !evidence) {
        throw new BusError("invalid_input", "Resolving a thread requires resolution text and evidence");
      }
      if (folded.thread.kind === "issue_notice" && folded.thread.topicRef.issue) {
        const issue = loaded.state.issueByID(folded.thread.topicRef.issue);
        if (!issue || issue.status !== "resolved") {
          throw new BusError("conflict", "The canonical issue must be resolved before its Bus thread");
        }
      }
    }
    if (input.action === "reopen") {
      if (folded.state !== "parked" || !reason || !evidence) {
        throw new BusError("invalid_input", "Reopening a parked thread requires a reason and new evidence");
      }
      if (evidenceKeys(evidence).every((key) => folded.seenEvidence.has(key))) {
        throw new BusError("conflict", "Reopen evidence was already present before the park");
      }
    }
    if (evidence) await validateCommitEvidence(paths.projectRoot, evidence);
    const payload: BusStatePayload = {
      action: input.action,
      byEndpoint: endpoint.endpointId,
      ...(reason ? { reason } : {}),
      ...(resolution ? { resolution } : {}),
      ...(evidence ? { evidence } : {}),
    };
    folded = await appendStateEntry(paths, folded, payload);
    return folded;
    }),
  );
}

export interface BusDoctorResult {
  readonly healthy: boolean;
  readonly summary: BusSummary;
  readonly findings: readonly string[];
  // ISS-1002 follow-up: a non-gating channel, deliberately separate from
  // findings. `healthy` is derived from `findings` alone -- a notice never
  // flips it. Exists because ISS-993 means nothing ever removes a redeliver
  // marker, so a signal tied to permanent on-disk state (like a supersede
  // that already self-healed) would otherwise fail `storybloq bus doctor`
  // for the life of the project after one benign crash-window resume.
  readonly notices: readonly string[];
}

function emptyBusSummary(setupState: BusSetupState = "not_initialized"): BusSummary {
  const nextActions = setupState === "runtime_lost"
    ? ["The Bus runtime is absent or no longer matches this checkout's deletion-evidence; run: storybloq bus setup to re-establish it"]
    : ["run: storybloq bus setup"];
  return {
    enabled: setupState !== "disabled",
    initialized: false,
    daemonState: "stopped",
    setupState,
    deliveryMode: "poll",
    participants: [],
    nextActions,
    endpoints: 0,
    pendingMessages: 0,
    unacknowledgedCritical: 0,
    openThreads: 0,
    parkedThreads: 0,
    undeliverable: 0,
    quarantined: 0,
    hookDelivery: { claude: false, codex: false },
    deliveryCapabilities: { onStop: "none", onTool: "none" },
  };
}

async function receiptEndpointDirs(paths: BusPaths): Promise<{ dirs: string[]; findings: string[] }> {
  let entries;
  try {
    entries = await readdir(paths.idempotency, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { dirs: [], findings: [] };
    // A non-ENOENT enumeration failure (EACCES, EIO, ...) must be reported as a doctor
    // finding rather than thrown: busDoctor calls this outside a catch, so throwing here
    // aborts the whole health report instead of returning healthy:false with a reason.
    return { dirs: [], findings: [`idempotency: cannot enumerate: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const dirs: string[] = [];
  const findings: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && EndpointIdSchema.safeParse(entry.name).success) {
      dirs.push(entry.name);
    } else {
      findings.push(`idempotency: unexpected entry ${entry.name}`);
    }
  }
  return { dirs, findings };
}

export async function busDoctor(root: string): Promise<BusDoctorResult> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  // D5 legacy-drain: report v1 content read-only, without migrating.
  if (await classifyBusRuntime(root) === "v1") return doctorV1(root);
  const paths = await resolveBusPaths(root, false);
  // T-428: loss/evidence classification. A present runtime's validation throw is
  // surfaced as a finding (today's behavior), never downgraded.
  let assessment: BusRuntimeAssessment;
  try {
    assessment = await assessBusRuntimeAtPaths(paths);
  } catch (err) {
    return { healthy: false, summary: emptyBusSummary("invalid"), findings: [`instance: ${err instanceof Error ? err.message : String(err)}`], notices: [] };
  }
  if (assessment.kind === "lost") {
    return { healthy: false, summary: emptyBusSummary("runtime_lost"), findings: [runtimeLostError(assessment).message], notices: [] };
  }
  if (assessment.kind === "evidence_corrupt") {
    // `bus setup` fails CLOSED on corrupt evidence (it refuses to overwrite loss
    // history), so the guidance must match: inspect or remove the file first.
    return { healthy: false, summary: emptyBusSummary("invalid"), findings: [`deletion-evidence: unreadable (${assessment.detail}); inspect or remove \`.story/.bus-evidence.json\`, then run \`storybloq bus setup\``], notices: [] };
  }
  if (assessment.kind === "fresh") {
    return { healthy: true, summary: emptyBusSummary(), findings: [], notices: [] };
  }
  const findings = await busLayoutFindings(paths);
  if (findings.length > 0) {
    return { healthy: false, summary: emptyBusSummary("invalid"), findings, notices: [] };
  }
  // ISS-1002 follow-up: non-gating signals, reported alongside findings but
  // never counted toward `healthy`. See the BusDoctorResult.notices comment.
  const notices: string[] = [];
  try {
    await readBusInstance(paths.projectRoot);
  } catch (err) {
    findings.push(`instance: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    for (const entry of await readdir(paths.locks, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".reap")) {
        findings.push(`lock recovery guard requires explicit owner inspection: ${entry.name}`);
      }
    }
  } catch (err) {
    findings.push(`locks: ${err instanceof Error ? err.message : String(err)}`);
  }
  const endpoints = await listEndpoints(paths.projectRoot);
  findings.push(...endpoints.findings.map((finding) => `endpoint: ${finding}`));
  const activeEndpoints = endpoints.endpoints.filter((candidate) => !candidate.retiredAt);
  if (activeEndpoints.length > 2) {
    findings.push(`two-endpoint invariant violated: ${activeEndpoints.length} active endpoints`);
  }
  const retiredIds = new Set(endpoints.endpoints.filter((candidate) => candidate.retiredAt).map((candidate) => candidate.endpointId));

  const folds: FoldedBusThread[] = [];
  try {
    for (const entry of await readdir(paths.threads, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) findings.push(`thread staging directory was not published: ${entry.name}`);
      else if (entry.isDirectory() && !ThreadIdSchema.safeParse(entry.name).success) {
        findings.push(`invalid thread directory: ${entry.name}`);
      }
    }
  } catch (err) {
    findings.push(`threads: ${err instanceof Error ? err.message : String(err)}`);
  }
  const liveThreadIds = new Set<string>();
  // ISS-953 fix step 10: every refused-artifact hash any live thread's park entry
  // actually references, gathered while folding so the orphan scan below (which
  // runs after every thread has been visited) can tell "unreferenced" from "not
  // yet observed".
  const referencedArtifactHashes = new Set<string>();
  // ISS-953 Codex round 2 finding #16: a thread fold that throws entirely
  // (not merely quarantined -- foldBusThread never returns anything at all)
  // leaves NO way to know what that thread's park entries might have
  // referenced. Any apparent orphan below could actually belong to the
  // thread that failed to fold, so orphan classification is suppressed
  // wholesale rather than risk a false "orphan" on a live reference.
  let orphanAnalysisIncomplete = false;
  for (const threadId of await listThreadIds(paths)) {
    liveThreadIds.add(threadId);
    try {
      // ISS-953 fix step 10: includeRefusals so doctor can diagnose refused-
      // artifact and redeliver-marker problems per thread.
      const folded = await foldBusThread(paths.projectRoot, threadId, { includeRefusals: true });
      folds.push(folded);
      if (folded.integrity !== "verified") findings.push(`thread ${threadId}: ${folded.finding ?? "quarantined"}`);
      // ISS-953 Codex round 2 finding #16: collected from folded.entries
      // directly, not folded.refusals -- foldBusThread deliberately returns
      // an EMPTY refusals list whenever integrity is not "verified" (see
      // fold.ts), so a thread quarantined by LATER corruption would
      // otherwise lose the reference an EARLIER, successfully-parsed park
      // entry still legitimately holds. entries only ever contains the
      // valid prefix parsed before any quarantining failure, so this is
      // safe to do unconditionally, independent of core integrity.
      for (const entry of folded.entries) {
        if (
          entry.type === "state" && entry.payload.action === "park" &&
          entry.payload.automatic === true && entry.payload.droppedMessage
        ) {
          referencedArtifactHashes.add(entry.payload.droppedMessage.refusedPayloadHash);
        }
      }
      for (const refusal of folded.refusals) {
        referencedArtifactHashes.add(refusal.droppedMessage.refusedPayloadHash);
        if (refusal.artifactStatus === "missing") {
          findings.push(
            `thread ${threadId}: refused message artifact is missing (entry ${refusal.entryHash}, hash ${refusal.droppedMessage.refusedPayloadHash})`,
          );
        } else if (refusal.artifactStatus === "corrupt") {
          findings.push(
            `thread ${threadId}: refused message artifact is corrupt (entry ${refusal.entryHash}, hash ${refusal.droppedMessage.refusedPayloadHash})`,
          );
        }
        // Marker diagnostics are deliberately worded distinctly and never
        // conflated: "invalid" is a genuine data-integrity finding, covering
        // several distinct causes worded classification-neutral at its own
        // branch below (round 5 finding #11) rather than named specifically
        // here. "pending" used to be described as categorically benign here
        // -- ISS-953 Codex round 5 finding #10 /
        // ISS-1002 showed that framing was never true: "pending" means no
        // successor exists yet to check anything against, which is equally
        // the shape of a recently-crashed in-flight redeliver AND of a
        // bindings-valid forged marker, and this doctor pass cannot tell
        // them apart any more than createHopCapSuccessorThread's own
        // verification can (see fold.ts's verifiedSuccessorState header
        // comment). The write path no longer trusts a "pending" marker's
        // successorThreadId either way (see store.ts's ISS-1002 interim
        // remedy) -- it durably supersedes it on the next redeliver attempt,
        // so this finding reports that a retry will make forward progress,
        // not that the existing marker was safe to trust. Doctor never
        // deletes a marker either way; if the current marker already carries
        // a discardedSuccessorThreadId, surface it so an operator can see the
        // marker's own claim that a supersede already happened here.
        if (refusal.markerState === "pending") {
          const discarded = refusal.discardedSuccessorThreadId
            ? ` (claims it superseded a prior claim, discarded successor ${refusal.discardedSuccessorThreadId})`
            : "";
          findings.push(
            `thread ${threadId}: redelivery pending for refusal ${refusal.entryHash}; the existing marker's successor is not trusted and will be superseded on the next \`storybloq_bus_redeliver\` retry${discarded}`,
          );
        } else if (refusal.markerState === "invalid") {
          // ISS-953 Codex round 5 finding #11: "schema failure or binding
          // mismatch" named only two of resolveRefusals's several distinct
          // "invalid" causes (it also covers a malformed trigger, a symlink
          // or read failure on the marker itself, corrupt endpoint
          // succession, and a claimed successor failing integrity,
          // provenance, artifact-content, kind/topic, sender, or recipient
          // verification) -- naming the wrong two could send an operator
          // toward the wrong repair target. Worded classification-neutral
          // instead; BusRefusal carries no structured reason to be more
          // specific than this without a schema change out of scope here.
          findings.push(
            `thread ${threadId}: redeliver marker for refusal ${refusal.entryHash} or its claimed successor failed integrity/binding verification`,
          );
        } else if (refusal.markerState === "verified" && refusal.discardedSuccessorThreadId) {
          // The common outcome of a completed supersede: the fresh marker's own
          // successor landed, so classification is "verified", not "pending" --
          // but discardedSuccessorThreadId is still present, meaning an earlier
          // claim WAS discarded to get here. Reported as a NOTICE, not a
          // finding: unlike "pending" (genuinely unresolved), this state is
          // permanent on-disk history of an already-completed self-heal, and
          // nothing ever removes a redeliver marker (ISS-993). A findings-based
          // signal here would fail `storybloq bus doctor` for the life of the
          // project after a single benign crash-window resume -- worth
          // surfacing to an operator, but never worth gating CI on.
          //
          // ISS-953 Codex round 6 finding #9: "verified" here means
          // verifiedSuccessorState validated the marker's successorThreadId
          // binding -- it never inspects discardedSuccessorThreadId, which is
          // not itself bound to any successor-thread state (by construction,
          // a discarded id was never published, so there is no successor
          // thread to fold and check it against). A "verified" marker's
          // discardedSuccessorThreadId is therefore the on-disk marker's own
          // claim, not independently verified history -- worded accordingly
          // rather than asserted as fact.
          notices.push(
            `thread ${threadId}: redeliver marker for refusal ${refusal.entryHash} claims it superseded a prior claim ` +
              `(discarded successor ${refusal.discardedSuccessorThreadId}, not independently verified)`,
          );
        }
      }
    } catch (err) {
      findings.push(`thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
      orphanAnalysisIncomplete = true;
    }
  }
  // ISS-953 fix step 10: orphan refused-artifact detection. This codebase has no
  // separate repair/cleanup command to extend with the plan's per-thread-lock-
  // before-delete guidance -- doctor here is, and stays, read-only; it reports an
  // orphan, it never deletes one. Read AFTER every thread has been folded so
  // referencedArtifactHashes is complete. A legitimate, narrow false-positive
  // window exists between an artifact's write and its park entry landing
  // (preallocate-then-bind, same as everywhere else in this codebase) -- since
  // nothing here deletes, a transient report in that window is display noise,
  // not a safety concern, and clears on the next `bus doctor` run.
  //
  // ISS-953 Codex round 6 MAJOR #8: resolveBusPaths's symlink check on `refused`
  // ran once, before every thread fold above -- by the time this scan runs, that
  // check is stale, and a persistent directory swap in the gap would previously
  // have made a direct `readdir(paths.refused)` follow it and enumerate outside
  // the Bus root. Route through validatedRefusedDir, which re-validates busRoot
  // and refused at this exact use, same as every other refused-directory read in
  // this codebase; it returns null only for a genuinely absent directory (report
  // nothing, there is nothing to scan) and throws BusError("corrupt") on a swap,
  // which the catch below reports as a finding (fail closed) since BusError's own
  // `code` is never "ENOENT".
  try {
    const refusedDir = await validatedRefusedDir(paths, { create: false });
    if (refusedDir) {
      for (const entry of await readdir(refusedDir, { withFileTypes: true })) {
        // ISS-953 Codex round 2 finding #15: a non-regular entry (symlink,
        // nested directory, socket, ...) named to LOOK like a valid
        // <hash>.json artifact previously vanished here silently -- the same
        // malformed-filename case just below it IS reported, so an entry that
        // fails the "is this even a regular file" check first must be too,
        // not skipped ahead of ever reaching the filename check.
        if (!entry.isFile()) {
          findings.push(`refused: ${entry.name} is not a regular <hash>.json artifact`);
          continue;
        }
        const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
        if (!match) {
          findings.push(`refused: ${entry.name} is not a regular <hash>.json artifact`);
          continue;
        }
        // ISS-953 Codex round 2 finding #16: orphan classification is
        // definitive only when every thread's fold contributed its full
        // reference set; suppress it entirely when any thread failed to fold
        // completely (see orphanAnalysisIncomplete above) rather than risk
        // reporting a live reference as orphaned.
        if (!referencedArtifactHashes.has(match[1]!) && !orphanAnalysisIncomplete) {
          findings.push(`refused: orphan artifact ${match[1]} is not referenced by any live thread's park entry`);
        }
      }
      if (orphanAnalysisIncomplete) {
        findings.push(
          "refused: orphan analysis is incomplete because at least one thread failed to fold entirely; " +
            "no artifact is classified as orphaned until that thread is repaired",
        );
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      findings.push(`refused: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // ISS-872: threadId -> folded index so a retired mailbox's pointers can be validated
  // and classified per-pointer against their canonical entry (a broken chain can leave
  // one retired mailbox holding a mix of redeliverable, resolvable, and stranded pointers).
  const foldByThread = new Map<string, FoldedBusThread>();
  for (const folded of folds) foldByThread.set(folded.thread.threadId, folded);
  for (const endpoint of endpoints.endpoints) {
    const mailbox = await mailboxPointers(paths, endpoint.endpointId);
    findings.push(...mailbox.findings.map((finding) => `${endpoint.endpointId} mailbox: ${finding}`));
    // ISS-872: a corrupt predecessor chain on an ACTIVE endpoint never grants authority
    // (it fails closed to self-only at the read seams); surface it here deterministically.
    if (!endpoint.retiredAt) {
      const chainCorrupt = endpointAddressees(endpoint, endpoints.endpoints).corrupt;
      if (chainCorrupt) findings.push(`${endpoint.endpointId} succession chain: ${chainCorrupt}`);
    }
    if (retiredIds.has(endpoint.endpointId) && mailbox.pointers.length > 0) {
      // Per-pointer, chain- and participant-aware classification (three tiers):
      //  1. REDELIVERABLE -- an active endpoint whose chain covers BOTH this retired
      //     mailbox owner (so it actually sweeps this mailbox) AND the pointer's canonical
      //     recipient; it surfaces the mail on its next poll.
      //  2. RESOLVABLE -- not redeliverable, but an active endpoint is authorized over the
      //     thread (its addressees include a thread participant), so that participant can
      //     resolve the thread with evidence to clear the ship gate.
      //  3. STRANDED -- neither: every participant AND lineage successor has retired, the
      //     pre-existing all-participants-retired defect (see ISS-873). Content is
      //     recoverable read-only via `bus export`, but the gate cannot be cleared.
      // A pointer that does not match a VERIFIED canonical entry (quarantined thread,
      // wrong hash/id/entrySeq, or a missing message) is unclassifiable: reconcile and
      // poll can neither validate nor deliver it, so it is counted as corruption, never
      // given a false recovery instruction.
      // A pointer's stale residue is reclaimed by an active chain-successor's reconcile
      // sweep; when NO active endpoint's chain covers this retired mailbox, nothing sweeps
      // it, so the wording must not promise a poll-based cleanup that can never run.
      const hasActiveSuccessor = activeEndpoints.some((active) =>
        endpointAddressees(active, endpoints.endpoints).ids.includes(endpoint.endpointId));
      // Mail may legitimately sit in THIS retired mailbox only if it is addressed to the
      // owner or one of the owner's own predecessors (mail the owner inherited). The set is
      // constant per endpoint, so compute it once. A canonically valid pointer addressed
      // OUTSIDE this set is misfiled -- no active successor's reconcile sweep will ever
      // reclaim it (reconcile only accepts recipients in ITS chain), so it must be counted
      // as corruption, never as routine stale state that falsely promises a poll cleanup.
      const ownerAddressees = endpointAddressees(endpoint, endpoints.endpoints).ids;
      let redeliverable = 0;
      let corruptPointers = 0;
      let stalePointers = 0;
      const resolvableThreads = new Set<string>();
      const strandedThreads = new Set<string>();
      let successorId: string | undefined;
      for (const pointer of mailbox.pointers) {
        const folded = foldByThread.get(pointer.threadId);
        const entry = folded?.entries[pointer.entrySeq - 1];
        if (!folded || folded.integrity !== "verified" || !entry || entry.type !== "message" ||
            entry.entryHash !== pointer.entryHash || entry.payload.messageId !== pointer.messageId) {
          corruptPointers += 1;
          continue;
        }
        // A canonically bound but MISFILED pointer (recipient outside the owner's own chain)
        // is corruption regardless of acked/resolved state: no sweep reclaims it, so it must
        // never be reported as routine stale cleanup with a false successor-poll promise.
        if (!ownerAddressees.includes(entry.payload.to)) {
          corruptPointers += 1;
          continue;
        }
        // A pointer whose message is already acked, or whose thread is already resolved,
        // needs NO recovery: the ship gate is already clear and the next reconcile sweep
        // reclaims it. Classify as routine stale cleanup, never redeliverable/resolvable/
        // stranded (which would imply an unnecessary or impossible action).
        if (folded.acknowledgments.has(pointer.messageId) || folded.state === "resolved") {
          stalePointers += 1;
          continue;
        }
        const recipient = entry.payload.to;
        const successor = activeEndpoints.find((active) => {
          const ids = endpointAddressees(active, endpoints.endpoints).ids;
          return ids.includes(endpoint.endpointId) && ids.includes(recipient);
        });
        if (successor) {
          redeliverable += 1;
          successorId = successor.endpointId;
          continue;
        }
        // RESOLVABLE requires a VERIFIED thread (updateBusThread rejects every transition
        // on a quarantined thread) with an active authorized participant.
        const resolvable = activeEndpoints.some((active) =>
          endpointAddressees(active, endpoints.endpoints).ids.some((id) => participantsInclude(folded.thread, id)));
        if (resolvable) resolvableThreads.add(pointer.threadId);
        else strandedThreads.add(pointer.threadId);
      }
      if (redeliverable > 0) {
        findings.push(`${endpoint.endpointId} mailbox: ${redeliverable} undelivered pointer(s) pending redelivery to successor ${successorId}; poll that endpoint to surface them`);
      }
      if (resolvableThreads.size > 0) {
        findings.push(`${endpoint.endpointId} mailbox: ${resolvableThreads.size} undelivered thread(s) to a retired recipient; the thread's active participant can resolve it with evidence to clear the ship gate`);
      }
      if (strandedThreads.size > 0) {
        findings.push(`${endpoint.endpointId} mailbox: ${strandedThreads.size} stranded succession thread(s) with no active participant or successor; recover the content read-only with \`storybloq bus export <thread-id>\`; the thread cannot be acked or resolved until an active participant exists.`);
      }
      if (stalePointers > 0) {
        findings.push(hasActiveSuccessor
          ? `${endpoint.endpointId} mailbox: ${stalePointers} acknowledged/resolved pointer(s) pending routine sweep; no action needed (a poll of the owning successor reclaims them).`
          : `${endpoint.endpointId} mailbox: ${stalePointers} acknowledged/resolved pointer(s) are non-blocking stale state with no active successor to reclaim them; the ship gate is already clear.`);
      }
      if (corruptPointers > 0) {
        findings.push(`${endpoint.endpointId} mailbox: ${corruptPointers} pointer(s) that do not match a verified thread entry addressed to this mailbox; run \`storybloq bus doctor\` on the affected thread and recover content with \`storybloq bus export <thread-id>\`.`);
      }
    }
    const pendingCount = (await listRegularJsonFiles(join(endpointMailboxPath(paths, endpoint.endpointId), "pending")))
      .filter((filename) => POINTER_FILENAME.test(filename)).length;
    if (pendingCount > 0) findings.push(`${endpoint.endpointId} mailbox: ${pendingCount} pending intent(s) require poll recovery`);
    const maxSeq = mailbox.pointers.reduce((maximum, pointer) => Math.max(maximum, pointer.mailboxSeq), 0);
    try {
      const counter = await readJsonNoFollow(
        join(endpointMailboxPath(paths, endpoint.endpointId), "counter.json"),
        BusMailboxCounterSchema,
      );
      if (counter.nextSeq <= maxSeq) findings.push(`${endpoint.endpointId} mailbox counter is behind sequence ${maxSeq}`);
    } catch (err) {
      if (!(err instanceof BusError) || err.code !== "not_found" || maxSeq > 0) {
        findings.push(`${endpoint.endpointId} mailbox counter: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // Orphan mailboxes: a UUID-named mailbox dir left after its endpoint record was
  // deleted is never reached by the per-endpoint loop above, so it (and any unread
  // pointers it still holds) would go unseen. Enumerate the mailboxes dir and report
  // any UUID-named directory with no matching endpoint record as an orphan finding.
  const registeredEndpointIds = new Set(endpoints.endpoints.map((endpoint) => endpoint.endpointId));
  try {
    for (const entry of await readdir(paths.mailboxes, { withFileTypes: true })) {
      if (entry.name === "." || entry.name === "..") continue;
      // A dot-prefixed entry is unexpected where only `<uuid>` mailbox dirs belong
      // (temp files are never dot-prefixed): report it rather than silently skip a
      // mailbox renamed `<uuid>` -> `.<uuid>` to hide it from the orphan scan.
      if (entry.name.startsWith(".")) {
        findings.push(`mailboxes: unexpected dot-prefixed entry ${entry.name}`);
        continue;
      }
      if (registeredEndpointIds.has(entry.name)) continue;
      // A non-directory, symlink, or non-UUID entry where only `<uuid>` mailbox dirs
      // belong is unexpected: report it rather than silently skip a file or symlink
      // named like an endpoint. Registered endpoints are skipped first because
      // busLayoutFindings already enforced their directory shape and short-circuits
      // doctor before this scan (mirrors the top-level idempotency scan's else-branch).
      if (!entry.isDirectory() || entry.isSymbolicLink() ||
          !EndpointIdSchema.safeParse(entry.name).success) {
        findings.push(`mailboxes: unexpected entry ${entry.name} is not a regular <uuid> mailbox directory`);
        continue;
      }
      const orphanDir = join(paths.mailboxes, entry.name);
      const pointerCount = (await listRegularJsonFiles(orphanDir)).filter((name) => POINTER_FILENAME.test(name)).length;
      // The orphan ROOT was validated above as a real non-symlink directory, but its
      // `pending` CHILD was not. A preserved orphan whose `pending` is a symlink would
      // otherwise make listRegularJsonFiles follow it and enumerate an arbitrary external
      // directory. lstat it (no-follow) and report a finding instead of traversing; a
      // missing pending is a benign zero, any other stat error is surfaced fail-closed.
      const pendingDir = join(orphanDir, "pending");
      let pendingDescription: string;
      try {
        const pendingStat = await lstat(pendingDir);
        if (pendingStat.isSymbolicLink() || !pendingStat.isDirectory()) {
          pendingDescription = "pending is not a regular directory";
        } else {
          const pendingCount = (await listRegularJsonFiles(pendingDir)).filter((name) => POINTER_FILENAME.test(name)).length;
          pendingDescription = `${pendingCount} pending intent(s)`;
        }
      } catch (err) {
        pendingDescription = (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "0 pending intent(s)"
          : `pending unreadable: ${err instanceof Error ? err.message : String(err)}`;
      }
      findings.push(`orphan mailbox ${entry.name}: ${pointerCount} pointer(s), ${pendingDescription} with no endpoint record`);
    }
  } catch (err) {
    findings.push(`mailboxes: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Orphaned receipts (thread gone) + receipt integrity.
  const receiptDirs = await receiptEndpointDirs(paths);
  findings.push(...receiptDirs.findings);
  for (const endpointId of receiptDirs.dirs) {
    const receiptDir = join(paths.idempotency, endpointId);
    let receiptEntries;
    try {
      receiptEntries = await readdir(receiptDir, { withFileTypes: true });
    } catch (err) {
      findings.push(`receipt ${endpointId}: cannot enumerate: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const dirent of receiptEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      // A dot-prefixed name is NOT skipped: temp files are never dot-prefixed, so a
      // receipt renamed `<keyHash>.json` -> `.<keyHash>.json` is unexpected and falls
      // through to the finding below rather than being silently hidden, which would
      // otherwise let a retry republish a duplicate.
      if (dirent.name === "." || dirent.name === "..") continue;
      const filename = dirent.name;
      // A symlink, a non-regular file, or a name that is not `<keyHash>.json` is an
      // unexpected entry where only receipts belong. Enumerating (rather than
      // listRegularJsonFiles, which silently drops these) makes a receipt renamed
      // away from `.json` visible; otherwise a retry republishes a duplicate silently.
      if (!dirent.isFile() || dirent.isSymbolicLink() || !RECEIPT_FILENAME.test(filename)) {
        findings.push(`receipt ${endpointId}/${filename}: not a regular <keyHash>.json file`);
        continue;
      }
      try {
        const receipt = await readJsonNoFollow(join(receiptDir, filename), BusReceiptSchema);
        if (receipt.endpointId !== endpointId) {
          findings.push(`receipt ${endpointId}/${filename}: endpointId ${receipt.endpointId} does not match its directory`);
        }
        if (filename !== `${receipt.keyHash}.json`) {
          findings.push(`receipt ${endpointId}/${filename}: does not match its key hash`);
        }
        if (!liveThreadIds.has(receipt.threadId)) {
          findings.push(`receipt ${endpointId}/${filename}: references missing thread ${receipt.threadId}`);
        }
      } catch (err) {
        findings.push(`receipt ${endpointId}/${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const filename of await listRegularJsonFiles(paths.succession)) {
    try {
      const record = await readJsonNoFollow(join(paths.succession, filename), BusSuccessionSchema);
      if (filename !== `${record.successionId}.json`) {
        findings.push(`succession: ${filename} does not match its record id`);
      }
    } catch (err) {
      findings.push(`succession ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await readBusHookPolicy(paths.projectRoot);
  } catch (err) {
    findings.push(`hook policy: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = await summarizeFrom(paths, loaded.state, endpoints.endpoints, endpoints.findings, folds);
  return { healthy: findings.length === 0, summary, findings, notices };
}

function deriveSetupState(activeCount: number): BusSetupState {
  if (activeCount > 2) return "invalid";
  if (activeCount === 2) return "ready";
  if (activeCount === 1) return "waiting_for_peer";
  return "disconnected";
}

function deriveDeliveryMode(
  participants: readonly BusParticipantSummary[],
  hookDelivery: { claude: boolean; codex: boolean },
): BusDeliveryMode {
  const clients = [...new Set(participants.map((participant) => participant.client))];
  if (clients.length === 0) return "poll";
  const on = clients.filter((client) => hookDelivery[client]);
  if (on.length === clients.length) return "live";
  if (on.length === 0) return "poll";
  return "partial";
}

// T-427: an active claude endpoint is on-tool active only when its project opted
// its client into hook delivery AND the PostToolUse hook has proven it fired in
// this endpoint's CURRENTLY-BOUND session (activation identity match). A session
// rebind leaves a stale activation whose taskId no longer matches, so it correctly
// reverts to inactive until the new session's hook fires.
function endpointToolActive(
  endpoint: BusEndpoint,
  hookDelivery: { claude: boolean; codex: boolean },
): boolean {
  if (endpoint.client !== "claude" || !hookDelivery.claude) return false;
  const activation = endpoint.toolHookActivation;
  return activation != null && activation.taskId === endpoint.clientTaskId;
}

// T-427 honest, structured coverage over the ACTIVE endpoints. onStop is the
// reliable turn-boundary channel (both clients have a Stop hook), so it is a
// tri-state over the distinct participant clients keyed on hook policy. onTool is
// the mid-turn PostToolUse channel, which is Claude-only, and is computed per ACTIVE
// ENDPOINT (never per distinct client) so it cannot overstate coverage: with two
// active Claude sessions, one fired hook does NOT read as "all". This never asserts
// guaranteed mid-turn ingestion; it reports only that the hook is enabled (policy)
// and proven firing (activation).
function deriveDeliveryCapabilities(
  active: readonly BusEndpoint[],
  hookDelivery: { claude: boolean; codex: boolean },
): BusDeliveryCapabilities {
  const clients = [...new Set(active.map((endpoint) => endpoint.client))];
  if (clients.length === 0) return { onStop: "none", onTool: "none" };
  const stopOn = clients.filter((client) => hookDelivery[client]);
  const onStop = stopOn.length === 0 ? "none" : stopOn.length === clients.length ? "all" : "partial";
  const claudeEndpoints = active.filter((endpoint) => endpoint.client === "claude");
  const hasCodex = active.some((endpoint) => endpoint.client === "codex");
  const claudeToolActive = claudeEndpoints.filter((endpoint) => endpointToolActive(endpoint, hookDelivery)).length;
  let onTool: BusDeliveryCapabilities["onTool"];
  if (claudeToolActive === 0) {
    onTool = "none";
  } else if (claudeToolActive < claudeEndpoints.length) {
    // Some but not all active Claude sessions have fired the hook.
    onTool = "partial";
  } else if (hasCodex) {
    // Every active Claude session is tool-active, but a Codex peer has no PostToolUse.
    onTool = "claude_only";
  } else {
    onTool = "all";
  }
  return { onStop, onTool };
}

function deriveNextActions(setupState: BusSetupState, deliveryMode: BusDeliveryMode): string[] {
  if (setupState === "disconnected" || setupState === "not_initialized" || setupState === "disabled") {
    return ["run: storybloq bus setup"];
  }
  if (setupState === "invalid") return ["run: storybloq bus doctor"];
  if (setupState === "waiting_for_peer") return ["run: storybloq bus setup (in the peer task)"];
  if (deliveryMode !== "live") return ["run: storybloq bus setup --delivery live (in each task)"];
  return [];
}

async function summarizeFrom(
  paths: BusPaths,
  state: ProjectState,
  endpoints: readonly BusEndpoint[],
  registryFindings: readonly string[],
  suppliedFolds?: readonly FoldedBusThread[],
): Promise<BusSummary> {
  const folds = suppliedFolds ? [...suppliedFolds] : await Promise.all(
    (await listThreadIds(paths)).map((threadId) => foldBusThread(paths.projectRoot, threadId)),
  );
  const pendingIds = new Set<string>();
  let unacknowledgedCritical = 0;
  for (const folded of folds) {
    for (const message of folded.messages) {
      if (!folded.acknowledgments.has(message.messageId)) {
        pendingIds.add(message.messageId);
        if (message.severity === "critical") unacknowledgedCritical += 1;
      }
    }
  }
  let hookDelivery = { claude: false, codex: false };
  try {
    const policy = await readBusHookPolicy(paths.projectRoot);
    hookDelivery = { claude: policy.claude, codex: policy.codex };
  } catch {
    // Doctor reports policy corruption; status remains available.
  }
  const active = endpoints.filter((endpoint) => !endpoint.retiredAt);
  const participants: BusParticipantSummary[] = active.map((endpoint) => ({
    client: endpoint.client,
    surface: endpoint.surface,
    state: endpoint.state,
  }));
  // A corrupt endpoint registry (a malformed record dropped from the parsed set)
  // makes readiness `invalid`, matching the v1 summary and the send path, which
  // fails closed on registry findings. Reporting `ready` off only the count of
  // successfully parsed endpoints would mask that corruption.
  const setupState = registryFindings.length > 0 ? "invalid" : deriveSetupState(active.length);
  const deliveryMode = deriveDeliveryMode(participants, hookDelivery);
  return {
    enabled: true,
    initialized: true,
    daemonState: "stopped",
    setupState,
    deliveryMode,
    participants,
    nextActions: deriveNextActions(setupState, deliveryMode),
    endpoints: active.length,
    pendingMessages: pendingIds.size,
    unacknowledgedCritical,
    openThreads: folds.filter((folded) => folded.state === "open").length,
    parkedThreads: folds.filter((folded) => folded.state === "parked").length,
    undeliverable: 0,
    quarantined: folds.filter((folded) => folded.integrity !== "verified").length,
    hookDelivery,
    deliveryCapabilities: deriveDeliveryCapabilities(active, hookDelivery),
  };
}

// T-428: the config-revert diagnostic (doctor / status only). When features.bus
// is off but this checkout carries evidence of an instance it stood up, the
// config was likely reverted; surface it loudly. Ops still fail closed with
// bus_disabled unchanged.
export async function busConfigRevertNote(root: string, paths?: BusPaths): Promise<string | null> {
  const p = paths ?? await resolveBusPaths(root, false).catch(() => null);
  if (!p) return null;
  const ev = await readBusEvidence(p);
  if (ev.kind === "present" && ev.evidence.instanceId) {
    return `This checkout initialized Bus instance ${ev.evidence.instanceId} but config.features.bus is no longer set (config may have been reverted); run \`storybloq bus setup\`.`;
  }
  return null;
}

// Advisory for a pre-T-428 runtime that has no deletion-evidence yet. Setup adopts
// it (writes evidence); until then a deletion cannot be detected.
const BUS_LEGACY_UNMIRRORED_ADVISORY =
  "run: storybloq bus setup (to enable deletion-evidence for this pre-existing runtime)";

// T-428: a one-line advisory for the guarded hooks (SessionStart / Stop) when this
// checkout's Bus runtime was deleted (evidence names an instance but the runtime is
// gone or was swapped). Returns null when the runtime is fine, never set up, or on
// ANY error -- hooks are fail-open and this must never throw. Callers emit it via a
// structured context field or STDERR only, never bare stdout.
export async function busRuntimeLostAdvisory(root: string): Promise<string | null> {
  try {
    // Gate on features.bus: a checkout that never enabled the Bus (or deliberately
    // disabled it) must not receive a runtime-lost advisory from these fail-open
    // hooks. The disabled-but-evidence-present case is surfaced by
    // busConfigRevertNote in status/doctor instead.
    const { state } = await loadProject(root);
    if (!isBusEnabled(state.config)) return null;
    const assessment = await assessBusRuntime(root);
    if (assessment.kind !== "lost") return null;
    // `lost` covers both an ABSENT runtime and a PRESENT runtime whose instance no
    // longer matches this checkout's evidence (a swap); diagnose each accurately.
    const detail = assessment.reason === "absent"
      ? `the .story/bus/ runtime (instance ${assessment.expectedInstanceId}) was deleted from this checkout`
      : `the .story/bus/ runtime no longer matches this checkout (expected instance ${assessment.expectedInstanceId}, found ${assessment.foundInstanceId})`;
    return `[storybloq-bus] runtime lost: ${detail}. Prior peer coordination is gone; run \`storybloq bus setup\` to re-establish the Bus.`;
  } catch {
    return null;
  }
}

export async function busSummary(root: string, state?: ProjectState): Promise<BusSummary> {
  const loadedState = state ?? (await loadProject(root)).state;
  if (!isBusEnabled(loadedState.config)) {
    // A disabled project must not depend on resolving the (possibly absent or
    // tampered) bus paths; busConfigRevertNote resolves them defensively (catch->
    // null), so a symlinked `.story/bus` yields no note instead of throwing here.
    const summary = emptyBusSummary("disabled");
    const note = await busConfigRevertNote(root);
    return note ? { ...summary, nextActions: [note, ...summary.nextActions] } : summary;
  }
  const paths = await resolveBusPaths(root, false);
  // D5 legacy-drain: surface v1 status read-only, without migrating.
  if (await classifyBusRuntime(root) === "v1") return summarizeV1(root);
  // T-428: classify loss/evidence before the happy path.
  const assessment = await assessBusRuntimeAtPaths(paths);
  if (assessment.kind === "lost") return emptyBusSummary("runtime_lost");
  if (assessment.kind === "evidence_corrupt") return emptyBusSummary("invalid");
  if (assessment.kind === "fresh") return emptyBusSummary();
  await assertBusLayout(paths);
  const scan = await listEndpoints(paths.projectRoot);
  const summary = await summarizeFrom(paths, loadedState, scan.endpoints, scan.findings);
  if (assessment.kind === "legacy_unmirrored") {
    return { ...summary, nextActions: [BUS_LEGACY_UNMIRRORED_ADVISORY, ...summary.nextActions] };
  }
  return summary;
}

export interface BusShipCheck {
  readonly clear: boolean;
  readonly blockers: readonly string[];
}

export async function checkBusShip(root: string): Promise<BusShipCheck> {
  const loaded = await loadProject(root);
  assertBusEnabled(loaded.state.config);
  const paths = await resolveBusPaths(root, false);
  // T-428: a lost or evidence-corrupt runtime blocks the ship gate.
  const assessment = await assessBusRuntimeAtPaths(paths);
  if (assessment.kind === "lost") return { clear: false, blockers: [runtimeLostError(assessment).message] };
  if (assessment.kind === "evidence_corrupt") {
    return { clear: false, blockers: [`Bus deletion-evidence is unreadable (${assessment.detail}); run \`storybloq bus doctor\``] };
  }
  if (assessment.kind === "fresh") return { clear: true, blockers: [] };
  await assertBusLayout(paths);
  await readBusInstance(paths.projectRoot);
  const blockers: string[] = [];
  for (const threadId of await listThreadIds(paths)) {
    // ISS-953 fix step 9: includeRefusals so the refusal scan below sees the
    // thread's full drop history, independent of the `critical` gate that governs
    // only the PRE-EXISTING message/ack checks below (a dropped message's severity
    // never appears in folded.messages, so that gate is blind to it).
    const folded = await foldBusThread(paths.projectRoot, threadId, { includeRefusals: true });
    const issue = folded.thread.topicRef.issue
      ? loaded.state.issueByID(folded.thread.topicRef.issue)
      : undefined;
    const label = issue ? displayIdOf(issue) : `Bus thread ${threadId}`;
    const critical = issue?.severity === "critical" || folded.messages.some((message) => message.severity === "critical");
    // Unconditional, never gated behind `critical`: a quarantined thread's refusal
    // history is unreadable (fold.ts's core-fold short-circuit means
    // resolveRefusals never runs past a corrupted chain, so folded.refusals is
    // always empty here too), so this can never confirm the thread held no
    // unresolved critical drop. `critical` is derived from folded.messages and the
    // issue's own severity -- both blind to a message that was critical severity
    // but got DROPPED (parked+refused) rather than delivered, which never appears
    // in folded.messages. Gating the quarantine blocker behind `critical` would
    // let exactly that thread ship silently: a critical message dropped before
    // the thread later became corrupted would trip neither this check (critical
    // false, since the drop is invisible to folded.messages) nor the refusal scan
    // below (also empty for a quarantined thread).
    if (folded.integrity !== "verified") blockers.push(`${label}: quarantined Bus thread ${threadId}`);
    if (critical) {
      // A resolved thread has concluded through the state machine's `resolve` action,
      // which requires resolution text AND evidence (commit/CI ref) from a participant.
      // That evidenced terminal state supersedes a per-message ack, so it clears the
      // unacked-critical blocker. This is also the ONLY recovery for a critical message
      // whose addressed recipient has retired: that endpoint can never ack it, so
      // without this exemption the blocker would be permanent. A quarantined thread is
      // NOT exempted above (a tampered thread cannot be trusted to be "resolved").
      if (folded.state !== "resolved" &&
          folded.messages.some((message) => message.severity === "critical" && !folded.acknowledgments.has(message.messageId))) {
        blockers.push(`${label}: unacknowledged critical Bus message`);
      }
      if (folded.state === "parked" && (!issue || issue.status !== "resolved")) {
        blockers.push(`${label}: parked Bus thread with unresolved critical issue`);
      }
    }
    // ISS-953 fix step 9: every refusal on every thread, independent of the
    // `critical` gate above and of the thread's current state (a thread that was
    // reopened past its park entry, or never parked-critical by the checks above,
    // can still carry an earlier dropped critical message). Two independent rules:
    for (const refusal of folded.refusals) {
      // Unconditional, regardless of severity or state: an artifact that cannot be
      // resolved is a data-integrity finding on its own, not merely a disposition
      // question -- the never-drop guarantee is void if the content is gone.
      if (refusal.artifactStatus !== "resolved") {
        blockers.push(`${label}: refused message artifact is ${refusal.artifactStatus} (entry ${refusal.entryHash})`);
        continue;
      }
      // A critical drop that is still unresolved blocks UNLESS either independent
      // closure path applies: redelivery (disposition flips to "redelivered" once
      // resolveRefusals verifies a real successor -- never reaches this branch) or
      // the SAME "evidenced resolution supersedes" exemptions the unacked-critical
      // and parked-critical blockers above already use (issue resolved, or the
      // thread itself resolved directly from parked with genuine evidence).
      if (
        refusal.droppedMessage.severity === "critical" &&
        refusal.disposition === "unresolved" &&
        !(issue && issue.status === "resolved") &&
        folded.state !== "resolved"
      ) {
        blockers.push(`${label}: unresolved critical Bus refusal (entry ${refusal.entryHash})`);
      }
    }
  }
  return { clear: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function exportBusThread(root: string, threadId: string, format: "json" | "md"): Promise<string> {
  // D5 legacy-drain: read a live v1 thread pre-migration; post-migration a v2 fold
  // that misses falls back to the archived v1 tree (archive/v1/threads).
  if (await classifyBusRuntime(root) === "v1") return exportV1Thread(root, threadId, format);
  // T-428: classify exhaustively BEFORE folding so the v1-archive fallback is
  // reserved for a valid present v2 genuine thread miss. A lost / evidence-corrupt
  // / fresh runtime must surface its own error, never be masked by the archive.
  const paths = await resolveBusPaths(root, false);
  const assessment = await assessBusRuntimeAtPaths(paths);
  if (assessment.kind === "lost") throw runtimeLostError(assessment);
  if (assessment.kind === "evidence_corrupt") {
    throw new BusError("corrupt", `Bus deletion-evidence is unreadable (${assessment.detail}). Run \`storybloq bus doctor\`.`);
  }
  if (assessment.kind === "fresh") {
    throw new BusError("not_found", "Bus is not initialized in this checkout. Run `storybloq bus setup` first.");
  }
  // ok | legacy_unmirrored: assert the full v2 layout BEFORE folding so a PARTIAL or
  // corrupt runtime surfaces as `corrupt` here, matching busSummary/checkBusShip. A
  // genuine thread miss on a valid layout is the only case that reaches the archive
  // fallback below; a missing structural dir must never be masked by it.
  await assertBusLayout(paths);
  let folded: FoldedBusThread;
  try {
    // ISS-953: export is a top-level caller (fix step 8) -- render the full
    // refusal history, not just the core fold.
    folded = await foldBusThread(root, threadId, { includeRefusals: true });
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") {
      return exportV1Thread(root, threadId, format, "archive");
    }
    throw err;
  }
  if (format === "json") {
    return JSON.stringify({
      thread: folded.thread,
      entries: folded.entries,
      state: folded.state,
      hopCount: folded.hopCount,
      integrity: folded.integrity,
      finding: folded.finding ?? null,
      refusals: folded.refusals,
    }, null, 2);
  }
  const lines = [
    `# Storybloq Bus thread ${threadId}`,
    "",
    `Kind: ${folded.thread.kind} | State: ${folded.state} | Integrity: ${folded.integrity}`,
    `Topic: ${JSON.stringify(folded.thread.topicRef)}`,
    "",
  ];
  for (const entry of folded.entries) {
    if (entry.type === "message") {
      const role = derivedRole(entry.payload.kind);
      const label = role ? `${role} (${entry.payload.kind})` : entry.payload.kind;
      lines.push(`## ${entry.seq}. ${label}`, "", entry.payload.body, "");
    } else {
      lines.push(`## ${entry.seq}. ${entry.type}`, "", "```json", JSON.stringify(entry.payload, null, 2), "```", "");
    }
  }
  if (folded.refusals.length > 0) {
    lines.push("## Refusals", "");
    for (const refusal of folded.refusals) {
      lines.push(
        `- ${refusal.trigger} by ${refusal.byEndpoint}: ${refusal.droppedMessage.severity} ` +
        `${refusal.droppedMessage.messageKind}, artifact ${refusal.artifactStatus}, ${refusal.disposition}` +
        (refusal.successorThreadId ? ` (successor ${refusal.successorThreadId})` : ""),
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function pendingMailboxCursor(
  root: string,
  endpointId: string,
  clientTaskId: string,
): Promise<{ cursor: number; count: number }> {
  const paths = await resolveBusPaths(root, false);
  // Endpoint-scoped read: prove caller ownership under the endpoint lock (D2),
  // so a forged endpoint hint cannot inspect another endpoint's pending cursor.
  return withEndpointCaller(paths.projectRoot, endpointId, clientTaskId, async () => {
    const mailbox = await mailboxPointers(paths, endpointId);
    let cursor = 0;
    let count = 0;
    for (const pointer of mailbox.pointers) {
      try {
        const folded = await foldBusThread(paths.projectRoot, pointer.threadId);
        const entry = folded.entries[pointer.entrySeq - 1];
        if (entry?.type === "message" && entry.payload.messageId === pointer.messageId &&
            !folded.acknowledgments.has(pointer.messageId)) {
          cursor = Math.max(cursor, pointer.mailboxSeq);
          count += 1;
        }
      } catch {
        // Hook delivery fails open; doctor provides the durable diagnostic.
      }
    }
    return { cursor, count };
  });
}

export const __storeTesting = {
  setAfterMailboxLstatHook: (fn: ((dir: string) => Promise<void>) | null) => { afterMailboxLstatHook = fn; },
  // ISS-872: force the best-effort eager materialization to fail so tests can exercise
  // the degraded-delivery (needs-explicit-poll) path without racing a real I/O fault.
  setMaterializeFailureHook: (fn: (() => Promise<void>) | null) => { materializeFailureHook = fn; },
  // ISS-872: force the post-mutation undelivered-count read to fail so tests can prove
  // setup still returns a resumable result (never throws) after joinEndpoint has mutated.
  setCountFailureHook: (fn: (() => Promise<void>) | null) => { countFailureHook = fn; },
};
