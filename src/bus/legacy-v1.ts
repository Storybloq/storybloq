import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { z } from "zod";
import { CLIENT_TASK_ID_PATTERN, normalizeClientTaskId } from "../autonomous/client-profile.js";
import { hashWithoutKey } from "./canonical.js";
import { BusError } from "./errors.js";
import { BUS_MAX_ENTRY_BYTES, DEFAULT_BUS_MAX_HOPS, type BusSummary } from "./schemas.js";
import { durableCreate, durableUnlink, durableWrite, listRegularJsonFiles, readJsonNoFollow } from "./io.js";
import { acquireHardenedLock, inspectProcessIdentity, releaseHardenedLock, withHardenedLock, type HardenedLockHandle } from "./lock.js";
import { busRuntimeExists, resolveBusPaths } from "./paths.js";
import { evidenceKeys, normalizeBusText } from "./security.js";

// Legacy v1 record surface (D5). 1.8.0 never writes NEW v1 coordination state
// (send/join/hook enablement are frozen with `upgrade_required`), and the fold,
// export, status, doctor, and drain-gate evaluation here are strictly read-only.
// The narrowly scoped legacy-drain operations DO perform guarded v1 mutations so a
// pre-upgrade runtime can be emptied before archiving: pollV1 removes delivered
// mailbox pointers and advances the endpoint cursor, ackV1 appends an ack entry,
// and updateV1Thread appends a park/resolve state entry. Each re-reads the live
// instance under its locks and refuses if it is absent or already v2. v1 hash
// chains are appended to only through these drain ops and are never rewritten.

const IsoTimestampSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UuidSchema = z.string().uuid();
const V1_ROLES = ["implementer", "reviewer"] as const;
const RoleSchema = z.enum(V1_ROLES);
const ProcessRefSchema = z.object({
  pid: z.number().int().positive(),
  signature: z.string().min(1).max(512),
  capturedAt: IsoTimestampSchema,
}).passthrough();

export const V1InstanceSchema = z.object({
  schema: z.literal("storybloq-bus-instance/v1"),
  instanceId: UuidSchema,
  projectRootHash: Sha256Schema,
  createdAt: IsoTimestampSchema,
}).passthrough();
export type V1Instance = z.infer<typeof V1InstanceSchema>;

export const V1EndpointSchema = z.object({
  schema: z.literal("storybloq-bus-endpoint/v1"),
  endpointId: UuidSchema,
  role: RoleSchema,
  client: z.enum(["claude", "codex"]),
  surface: z.enum(["claude_cli", "codex_cli", "codex_desktop"]),
  clientTaskId: z.string().regex(CLIENT_TASK_ID_PATTERN),
  processRef: ProcessRefSchema.nullable(),
  // Optional-but-present on real 1.7.0 runtimes; typed here so the drain surface
  // can read the poll cursor and refresh liveness while passthrough preserves the
  // remaining v1 fields untouched (v1 records are never rewritten wholesale).
  state: z.enum(["attached", "offline", "unknown"]).optional(),
  lastSeenAt: IsoTimestampSchema.optional(),
  lastPolledMailboxSeq: z.number().int().nonnegative().optional(),
  lastBlockedMailboxSeq: z.number().int().nonnegative().optional(),
  retiredAt: IsoTimestampSchema.nullable(),
}).passthrough();
export type V1Endpoint = z.infer<typeof V1EndpointSchema>;

const V1ThreadSchema = z.object({
  schema: z.literal("storybloq-bus-thread/v1"),
  threadId: UuidSchema,
  kind: z.enum(["issue_notice", "question", "coordination", "patch_request"]),
  topicRef: z.record(z.string(), z.unknown()),
  participantRoles: z.tuple([RoleSchema, RoleSchema]),
  maxHops: z.number().int().min(2).max(32),
  threadHash: Sha256Schema,
}).passthrough();

const V1MessagePayloadSchema = z.object({
  messageId: UuidSchema,
  from: z.object({ endpointId: UuidSchema, role: RoleSchema, client: z.enum(["claude", "codex"]) }).passthrough(),
  toRole: RoleSchema,
  kind: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  body: z.string(),
}).passthrough();

// v1 evidence, ack, and state payload schemas. These mirror the shipped v1
// write semantics (see ackV1 / updateV1Thread below) and the v2 ack/state
// validation (schemas.ts BusAckPayloadSchema / BusStatePayloadSchema, fold.ts
// ackTransitionAllowed + state machine). The fold validates every ack/state
// payload against these so a hash-valid but semantically bogus ack/state entry
// quarantines the thread instead of being counted or silently ignored.
const V1EvidenceSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{4,64}$/i).optional(),
  ciRun: z.string().min(1).max(256).refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value),
    "Control characters are not allowed",
  ).optional(),
}).passthrough().refine(
  (value) => value.commit !== undefined || value.ciRun !== undefined,
  "A commit or CI run reference is required",
);

const V1AckPayloadSchema = z.object({
  messageId: UuidSchema,
  byEndpoint: UuidSchema,
  disposition: z.enum(["accepted", "rejected", "deferred"]),
  reason: z.string().min(1).max(4096).optional(),
}).passthrough().superRefine((value, ctx) => {
  if ((value.disposition === "rejected" || value.disposition === "deferred") && !value.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "A reason is required" });
  }
});
type V1AckPayload = z.infer<typeof V1AckPayloadSchema>;

const V1StatePayloadSchema = z.object({
  action: z.enum(["park", "resolve", "reopen"]),
  byEndpoint: UuidSchema,
  reason: z.string().min(1).max(4096).optional(),
  resolution: z.string().min(1).max(8192).optional(),
  evidence: V1EvidenceSchema.optional(),
}).passthrough();

// Mirrors fold.ts ackTransitionAllowed: an ack may repeat an identical
// disposition/reason (idempotent replay) or promote a deferred ack to
// accepted/rejected; any other disposition change on a message is invalid.
function v1AckTransitionAllowed(previous: V1AckPayload | undefined, next: V1AckPayload): boolean {
  if (!previous) return true;
  if (previous.disposition === next.disposition && previous.reason === next.reason) return true;
  return previous.disposition === "deferred" &&
    (next.disposition === "accepted" || next.disposition === "rejected");
}

const V1EntrySchema = z.object({
  schema: z.literal("storybloq-bus-entry/v1"),
  entryId: UuidSchema,
  threadId: UuidSchema,
  seq: z.number().int().positive(),
  type: z.enum(["message", "ack", "state", "wake"]),
  prevHash: Sha256Schema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: IsoTimestampSchema,
  entryHash: Sha256Schema,
}).passthrough();

export const V1MailboxPointerSchema = z.object({
  schema: z.literal("storybloq-bus-mailbox/v1"),
  role: RoleSchema,
  mailboxSeq: z.number().int().positive(),
  messageId: UuidSchema,
  threadId: UuidSchema,
  entrySeq: z.number().int().positive(),
  entryHash: Sha256Schema,
}).passthrough();

const ENTRY_FILENAME = /^(\d{6})-(message|ack|state|wake)-([0-9a-f-]{36})\.json$/;
// A durable-write temp file: `<target>.tmp.<pid>.<uuid>` (see io.ts writeDurableTemp).
const DURABLE_TEMP_SUFFIX = /\.tmp\.\d+\.[0-9a-f-]{36}$/;
const POINTER_FILENAME = /^(\d{12})-([0-9a-f-]{36})\.json$/;
const ENDPOINT_FILENAME = /^([0-9a-f-]{36})\.json$/i;

export interface V1Paths {
  readonly busRoot: string;
  readonly threads: string;
  readonly endpoints: string;
  readonly mailboxes: string;
}

export function v1PathsFrom(busRoot: string): V1Paths {
  return {
    busRoot,
    threads: join(busRoot, "threads"),
    endpoints: join(busRoot, "endpoints"),
    mailboxes: join(busRoot, "mailboxes"),
  };
}

export interface V1FoldedThread {
  readonly threadId: string;
  readonly kind: string;
  readonly topicRef: Record<string, unknown>;
  readonly participantRoles: [string, string];
  readonly state: "open" | "parked" | "resolved";
  readonly integrity: "verified" | "quarantined";
  readonly messages: Array<{ messageId: string; toRole: string; severity: string; body: string; kind: string; fromRole: string }>;
  readonly acknowledgedIds: Set<string>;
  // The latest acknowledgment payload per message id (disposition + reason),
  // exposed so drain acks can distinguish an identical replay from a supported
  // deferred-to-terminal promotion instead of treating any acknowledged id as a
  // no-op replay.
  readonly acknowledgments: ReadonlyMap<string, V1AckPayload>;
  readonly seenEvidence: Set<string>;
  // The verified-prefix cursor used when appending drain entries (ack/park/resolve).
  readonly lastHash: string;
  readonly validThroughSeq: number;
}

/**
 * Read-only v1 fold. Verifies the immutable hash chain; never mutates.
 *
 * `strictTemps` controls durable-write temp handling in the entries scan. Lock-free
 * live reads (poll/export/status/doctor) tolerate a transient `<entry>.tmp.<pid>.<uuid>`
 * so a concurrent ack/update `durableCreate` does not spuriously quarantine a healthy
 * thread. The MIGRATION drain fold runs under the v1 locks with writers quiesced, so it
 * passes `strictTemps: true`: no legitimate temp exists there, and tolerating one would
 * let a committed TAIL entry renamed to a temp-shaped name vanish from the fold with no
 * seq gap and be archived as verified, truncated history.
 */
export async function foldV1Thread(
  paths: V1Paths,
  threadId: string,
  opts: { strictTemps?: boolean } = {},
): Promise<V1FoldedThread> {
  const threadDir = join(paths.threads, threadId);
  const thread = await readJsonNoFollow(join(threadDir, "thread.json"), V1ThreadSchema);
  let integrity: "verified" | "quarantined" = "verified";
  // A hash-valid thread copied under a DIFFERENT UUID directory (its stored
  // threadId disagrees with the directory it lives in) is misfiled or tampered and
  // must quarantine rather than fold verified and pass the migration gate. Same
  // fail-closed style as the threadHash check just below.
  if (thread.threadId !== threadId) integrity = "quarantined";
  let state: "open" | "parked" | "resolved" = "open";
  let lastHash = thread.threadHash;
  let validThroughSeq = 0;
  const messages: V1FoldedThread["messages"] = [];
  const acknowledgedIds = new Set<string>();
  const seenEvidence = new Set<string>();
  // Per-message metadata (sender endpoint + roles) and the latest ack disposition,
  // used to authorize ack actors and validate disposition transitions during the
  // fold. Local to the fold; the exposed acknowledgedIds stays a Set.
  const messageMeta = new Map<string, { fromEndpointId: string; fromRole: string; toRole: string }>();
  const ackDispositions = new Map<string, V1AckPayload>();

  // Validated endpointId -> role map for actor authorization of ack/state
  // entries. A recomputed, hash-valid ack/state from an arbitrary UUID must not
  // be honored: an ack must come from a known v1 endpoint holding the recipient
  // role, and a state action must come from a known v1 endpoint whose role is a
  // thread participant. The map is sourced once per fold from the v1 endpoint
  // registry (drain is not a hot path). Retired endpoints are kept in the map:
  // a historical ack/state written while an endpoint was active stays valid even
  // if the endpoint was later retired, because authorization is about role
  // identity, not current liveness.
  //
  // The map is built from the VALID endpoint records only. A scan finding on some
  // OTHER endpoint record does NOT quarantine this thread: tolerant reads must
  // still fold a well-formed thread whose own actors resolve. Endpoint-registry
  // corruption is surfaced separately and fails the drain gate closed (the
  // migration path, `doctorV1`, and `summarizeV1` all report listV1Endpoints
  // findings). An endpointId that resolves to two different roles is ambiguous and
  // removed from the map, so any ack/state actor referencing it (or any actor
  // missing entirely) fails the per-actor authorization below and quarantines
  // exactly the thread that relied on it.
  const endpointRoles = new Map<string, (typeof V1_ROLES)[number]>();
  const ambiguousEndpointIds = new Set<string>();
  const { endpoints: v1Endpoints } = await listV1Endpoints(paths);
  for (const endpoint of v1Endpoints) {
    const existing = endpointRoles.get(endpoint.endpointId);
    if (existing !== undefined && existing !== endpoint.role) {
      ambiguousEndpointIds.add(endpoint.endpointId);
      continue;
    }
    endpointRoles.set(endpoint.endpointId, endpoint.role);
  }
  for (const id of ambiguousEndpointIds) endpointRoles.delete(id);

  if (integrity === "verified" &&
      hashWithoutKey(thread as unknown as Record<string, unknown>, "threadHash") !== thread.threadHash) {
    integrity = "quarantined";
  }
  let filenames: string[] = [];
  if (integrity !== "quarantined") {
    // Hardened enumeration: any unexpected entry (symlink, non-.json, hidden, or a
    // name outside the `NNNNNN-<type>-<uuid>.json` shape) fails the fold closed rather
    // than being silently dropped, so a tampered tail entry cannot slip the drain gate.
    const scan = await listV1ThreadEntryFiles(join(threadDir, "entries"), opts.strictTemps === true);
    if (scan.findings.length > 0) integrity = "quarantined";
    else filenames = scan.filenames;
  }
  for (let index = 0; integrity === "verified" && index < filenames.length; index++) {
    const filename = filenames[index]!;
    const match = ENTRY_FILENAME.exec(filename);
    const expectedSeq = index + 1;
    if (!match || Number(match[1]) !== expectedSeq) { integrity = "quarantined"; break; }
    let entry: z.infer<typeof V1EntrySchema>;
    try {
      entry = await readJsonNoFollow(join(threadDir, "entries", filename), V1EntrySchema, BUS_MAX_ENTRY_BYTES);
    } catch { integrity = "quarantined"; break; }
    // Cross-check the envelope against the filename and thread (mirrors the v2 fold):
    // a record whose stored threadId/seq/type/entryId disagrees with where it lives
    // is tampered or misfiled and must quarantine the fold, not fold silently.
    if (entry.threadId !== thread.threadId || entry.seq !== expectedSeq ||
        entry.type !== match[2] || entry.entryId !== match[3]) {
      integrity = "quarantined"; break;
    }
    if (entry.prevHash !== lastHash ||
        hashWithoutKey(entry as unknown as Record<string, unknown>, "entryHash") !== entry.entryHash) {
      integrity = "quarantined"; break;
    }
    if (entry.type === "message") {
      if (state !== "open") { integrity = "quarantined"; break; }
      // A message whose payload fails validation must quarantine the fold rather
      // than be dropped from folded.messages: a silent skip lets a corrupt or
      // tampered message slip the drain ship-gate.
      const parsed = V1MessagePayloadSchema.safeParse(entry.payload);
      if (!parsed.success) { integrity = "quarantined"; break; }
      const fromRole = parsed.data.from.role;
      const toRole = parsed.data.toRole;
      // Participant membership: both roles must be the thread's two declared
      // participants and a message cannot be self-addressed (mirrors the v2 fold
      // direction check adapted to v1's role-addressed envelopes).
      if (fromRole === toRole ||
          !thread.participantRoles.includes(fromRole) ||
          !thread.participantRoles.includes(toRole)) {
        integrity = "quarantined"; break;
      }
      // A duplicate messageId within a thread must quarantine the fold: acknowledgement
      // is tracked by messageId (in a Set), so a single ack of a repeated id would mark
      // BOTH messages acknowledged and could clear an earlier unacked critical message
      // from the drain ship-gate. Fail closed rather than conflate identities.
      if (messageMeta.has(parsed.data.messageId)) { integrity = "quarantined"; break; }
      messageMeta.set(parsed.data.messageId, { fromEndpointId: parsed.data.from.endpointId, fromRole, toRole });
      messages.push({
        messageId: parsed.data.messageId,
        toRole,
        severity: parsed.data.severity,
        body: parsed.data.body,
        kind: parsed.data.kind,
        fromRole,
      });
    } else if (entry.type === "ack") {
      // A hash-valid ack with an arbitrary/untyped payload must quarantine the
      // fold rather than be counted as acknowledgement. The referenced message
      // must exist in the verified prefix, the acknowledger must be a KNOWN valid
      // v1 endpoint whose role equals the acknowledged message's recipient role
      // (toRole) and never the message's own sender, and the disposition
      // transition must be allowed (mirrors the v2 fold ack validation). An ack
      // from an endpoint not in the validated registry, or from an endpoint whose
      // role is not the recipient side, is unauthorized and fails closed.
      const parsed = V1AckPayloadSchema.safeParse(entry.payload);
      if (!parsed.success) { integrity = "quarantined"; break; }
      const meta = messageMeta.get(parsed.data.messageId);
      const ackByRole = endpointRoles.get(parsed.data.byEndpoint);
      if (!meta ||
          ackByRole === undefined ||
          ackByRole !== meta.toRole ||
          parsed.data.byEndpoint === meta.fromEndpointId ||
          !v1AckTransitionAllowed(ackDispositions.get(parsed.data.messageId), parsed.data)) {
        integrity = "quarantined"; break;
      }
      ackDispositions.set(parsed.data.messageId, parsed.data);
      acknowledgedIds.add(parsed.data.messageId);
    } else if (entry.type === "state") {
      // A malformed/untyped state payload or a disallowed transition must
      // quarantine the fold rather than be silently ignored while the chain stays
      // "verified" (mirrors the v2 fold state machine). The actor must also be a
      // KNOWN valid v1 endpoint whose role is one of the thread's participant
      // roles: an arbitrary UUID (or an endpoint that is not a participant) must
      // not be able to park, resolve, or reopen the thread, so it fails closed.
      const parsed = V1StatePayloadSchema.safeParse(entry.payload);
      if (!parsed.success) { integrity = "quarantined"; break; }
      const transition = parsed.data;
      const stateByRole = endpointRoles.get(transition.byEndpoint);
      if (stateByRole === undefined || !thread.participantRoles.includes(stateByRole)) {
        integrity = "quarantined"; break;
      }
      if (transition.action === "park") {
        if (state !== "open" || !transition.reason) { integrity = "quarantined"; break; }
        state = "parked";
      } else if (transition.action === "resolve") {
        if (state === "resolved" || !transition.resolution || !transition.evidence) { integrity = "quarantined"; break; }
        state = "resolved";
      } else {
        // reopen: only from a parked thread, with a reason and NEW evidence.
        if (state !== "parked" || !transition.reason || !transition.evidence) { integrity = "quarantined"; break; }
        const keys = evidenceKeys(transition.evidence);
        if (keys.every((key) => seenEvidence.has(key))) { integrity = "quarantined"; break; }
        state = "open";
      }
      if (transition.evidence) {
        for (const key of evidenceKeys(transition.evidence)) seenEvidence.add(key);
      }
    }
    lastHash = entry.entryHash;
    validThroughSeq = index + 1;
  }
  // A verified fold with zero entries is corrupt: a v1 thread is created with its
  // first message entry, so an entry-less entries/ dir is a crash or tamper artifact
  // (mirrors the v2 fold's empty-thread guard). Fail closed rather than drain-clean.
  if (integrity === "verified" && validThroughSeq === 0) integrity = "quarantined";
  return {
    threadId,
    kind: thread.kind,
    topicRef: thread.topicRef,
    participantRoles: thread.participantRoles as [string, string],
    state,
    integrity,
    messages,
    acknowledgedIds,
    acknowledgments: ackDispositions,
    seenEvidence,
    lastHash,
    validThroughSeq,
  };
}

export interface V1ThreadIdScan {
  readonly threadIds: string[];
  // Names of unexpected/malformed thread directory entries and non-ENOENT IO
  // errors reading the threads dir. Read-only consumers ignore these (tolerant);
  // the migration drain gate fails closed on any, because a hidden or unreadable
  // thread would let the gate wrongly conclude there is nothing to drain.
  readonly findings: string[];
}

export async function listV1ThreadIds(paths: V1Paths): Promise<V1ThreadIdScan> {
  const threadIds: string[] = [];
  const findings: string[] = [];
  let entries;
  try {
    entries = await readdir(paths.threads, { withFileTypes: true });
  } catch (err) {
    // ENOENT is benign (no threads dir yet -> empty, no finding). Any other IO
    // error (permissions, etc.) could mask pending threads, so it is a finding
    // that fails the drain gate closed rather than an empty "nothing to drain".
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { threadIds, findings };
    findings.push(`threads directory: ${err instanceof Error ? err.message : String(err)}`);
    return { threadIds, findings };
  }
  for (const entry of entries) {
    // A dot-prefixed name is NOT skipped: durable-write temp files are never
    // dot-prefixed, so a dot-prefixed entry where a thread directory belongs is
    // always unexpected. Skipping it would hide a renamed thread from the drain gate.
    if (entry.name === "." || entry.name === "..") continue;
    // A symlink, a non-directory, or a directory whose name is not a UUID is an
    // unexpected entry where a thread directory belongs. Record a finding so the
    // drain gate fails closed instead of silently skipping potential pending work.
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      findings.push(`threads entry ${entry.name}: not a thread directory`);
      continue;
    }
    if (!UuidSchema.safeParse(entry.name).success) {
      findings.push(`threads entry ${entry.name}: malformed thread directory name`);
      continue;
    }
    threadIds.push(entry.name);
  }
  threadIds.sort();
  return { threadIds, findings };
}

// Hardened entries lister for the v1 fold. Unlike listRegularJsonFiles (which silently
// drops symlinks, non-.json, and unexpected names), this surfaces a finding for any
// entry in a thread's entries/ dir that is not a regular `NNNNNN-<type>-<uuid>.json`
// file, so a hidden/symlinked/renamed entry at the chain tail (or an all-hidden entries
// dir) can no longer be dropped and let the drain gate wrongly conclude a thread is
// empty. The ONE tolerated exception is a durable-write temp (see the loop below): the
// fold is also called lock-free (poll/export/status/doctor), so a transient in-progress
// temp must not be misread as corruption.
async function listV1ThreadEntryFiles(entriesDir: string, strictTemps = false): Promise<{ filenames: string[]; findings: string[] }> {
  const filenames: string[] = [];
  const findings: string[] = [];
  let entries;
  try {
    entries = await readdir(entriesDir, { withFileTypes: true });
  } catch (err) {
    // ENOENT (no entries dir) is benign -> empty, no finding; the empty-thread guard
    // in foldV1Thread quarantines a thread that folds zero entries. Any other IO
    // error could mask pending entries, so it is a fail-closed finding.
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { filenames, findings };
    findings.push(`entries directory: ${err instanceof Error ? err.message : String(err)}`);
    return { filenames, findings };
  }
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    // Tolerate a durable-write temp (a REGULAR non-symlink file matching the temp
    // suffix) for LOCK-FREE live reads ONLY: foldV1Thread runs lock-free (poll/export/
    // status/doctor) concurrently with an ack/update `durableCreate`, so a transient
    // in-progress temp must not spuriously quarantine a healthy thread. A tolerated temp
    // is never folded, so mid-write it can neither inject nor hide committed content (the
    // contiguity + chain checks still enforce that). Under `strictTemps` (the migration
    // drain fold, running with writers quiesced under the v1 locks) NO legitimate temp
    // exists, so a temp is treated as a finding: otherwise a committed TAIL entry renamed
    // to a temp-shaped name would vanish with no seq gap and be archived as verified.
    // A SYMLINK matching the temp shape is NEVER tolerated (not a real durable write).
    if (!strictTemps && entry.isFile() && !entry.isSymbolicLink() && DURABLE_TEMP_SUFFIX.test(entry.name)) continue;
    // A symlink, a non-regular file, or a name that is not `NNNNNN-<type>-<uuid>.json`
    // is unexpected where only immutable log entries belong. Record a finding so the
    // fold quarantines instead of silently dropping a tail entry.
    if (!entry.isFile() || entry.isSymbolicLink() || !ENTRY_FILENAME.test(entry.name)) {
      findings.push(`entries entry ${entry.name}: not a regular log entry file`);
      continue;
    }
    filenames.push(entry.name);
  }
  filenames.sort();
  return { filenames, findings };
}

export interface V1EndpointScan {
  readonly endpoints: V1Endpoint[];
  // Filenames of endpoint records that failed to parse. Read-only consumers
  // ignore these (tolerant); the migration drain gate fails closed on any.
  readonly findings: string[];
}

export async function listV1Endpoints(paths: V1Paths): Promise<V1EndpointScan> {
  const endpoints: V1Endpoint[] = [];
  const findings: string[] = [];
  let entries;
  try {
    entries = await readdir(paths.endpoints, { withFileTypes: true });
  } catch (err) {
    // ENOENT (no endpoints dir yet) is benign and yields no finding. Any other IO
    // error could mask a live endpoint from the offline proof, so it is a finding
    // that fails the drain gate closed.
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { endpoints, findings };
    findings.push(`endpoints directory: ${err instanceof Error ? err.message : String(err)}`);
    return { endpoints, findings };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // A dot-prefixed name is NOT skipped: durable-write temp files are never
    // dot-prefixed, so a dot-prefixed entry where an endpoint record belongs is
    // always unexpected. Skipping it would hide a renamed live endpoint from the scan.
    if (entry.name === "." || entry.name === "..") continue;
    // A symlink, a non-regular file, or a name that is not `<uuid>.json` is an
    // unexpected entry where an active endpoint record belongs. Enumerating (rather
    // than listRegularJsonFiles, which silently drops these) makes a symlinked or
    // renamed live endpoint visible to the migration offline-proof loop and the
    // endpoint-lock enumeration instead of vanishing from the scan.
    const match = ENDPOINT_FILENAME.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !match) {
      findings.push(`endpoint ${entry.name}: not a regular <uuid>.json file`);
      continue;
    }
    let endpoint: V1Endpoint;
    try {
      endpoint = await readJsonNoFollow(join(paths.endpoints, entry.name), V1EndpointSchema);
    } catch (err) {
      findings.push(`endpoint ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    // A record whose stored endpointId disagrees with its filename stem is misfiled
    // or tampered; fail closed so a copied/renamed endpoint record cannot escape the
    // per-endpoint authorization the fold and drain gate build from this registry.
    if (endpoint.endpointId !== match[1]) {
      findings.push(`endpoint ${entry.name}: endpoint id does not match filename`);
      continue;
    }
    endpoints.push(endpoint);
  }
  return { endpoints, findings };
}

export async function v1EndpointLiveness(endpoint: V1Endpoint): Promise<"attached" | "offline" | "unknown"> {
  if (endpoint.surface === "codex_desktop" || !endpoint.processRef) return "unknown";
  const state = await inspectProcessIdentity(endpoint.processRef.pid, endpoint.processRef.signature);
  return state === "alive" ? "attached" : state === "dead" ? "offline" : "unknown";
}

export type V1MailboxPointer = z.infer<typeof V1MailboxPointerSchema>;

export interface V1PointerScan {
  readonly pointers: V1MailboxPointer[];
  // Filenames of pointer records that failed to parse. A corrupt pending pointer
  // is otherwise indistinguishable from empty, so the drain gate fails closed on
  // any of these; read-only consumers stay tolerant and simply ignore them.
  readonly findings: string[];
}

// Read the raw message entry at a given seq for pointer envelope cross-checks.
// Best-effort: returns null when the entry is unavailable or unreadable, in which
// case the pointer's thread corruption is caught by the thread fold / quarantine
// path rather than double-reported here.
async function readV1MessageEntryAtSeq(
  paths: V1Paths,
  threadId: string,
  seq: number,
): Promise<z.infer<typeof V1EntrySchema> | null> {
  const entriesDir = join(paths.threads, threadId, "entries");
  let filenames: string[];
  try {
    filenames = await listRegularJsonFiles(entriesDir);
  } catch {
    return null;
  }
  for (const filename of filenames) {
    const match = ENTRY_FILENAME.exec(filename);
    if (!match || Number(match[1]) !== seq) continue;
    try {
      return await readJsonNoFollow(join(entriesDir, filename), V1EntrySchema, BUS_MAX_ENTRY_BYTES);
    } catch {
      return null;
    }
  }
  return null;
}

export async function v1MailboxPointers(paths: V1Paths, role: (typeof V1_ROLES)[number]): Promise<V1PointerScan> {
  const mailbox = join(paths.mailboxes, role);
  const pointers: V1MailboxPointer[] = [];
  const findings: string[] = [];
  for (const directory of [mailbox, join(mailbox, "pending")]) {
    // Validate the mailbox root and its pending directory explicitly before
    // scanning. `listRegularJsonFiles` treats a missing directory as empty, so a
    // deleted role-mailbox tree (or its pending dir) is otherwise
    // indistinguishable from "no pending mail" and would hide pending delivery
    // state from the drain gate. ENOENT, symlinks, non-directories, and other IO
    // failures are all drain-blocking findings; tolerant readers ignore them.
    let dirStat;
    try {
      dirStat = await lstat(directory);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      findings.push(code === "ENOENT"
        ? `${role} mailbox: missing directory ${directory}`
        : `${role} mailbox: cannot stat directory ${directory}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (dirStat.isSymbolicLink()) {
      findings.push(`${role} mailbox: ${directory} is a symlink`);
      continue;
    }
    if (!dirStat.isDirectory()) {
      findings.push(`${role} mailbox: ${directory} is not a directory`);
      continue;
    }
    let dirEntries;
    try {
      dirEntries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      findings.push(`${role} mailbox: cannot enumerate ${directory}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const isRoot = directory === mailbox;
    for (const dirent of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      // A dot-prefixed name is NOT skipped: durable-write temp files are never
      // dot-prefixed, so a dot-prefixed entry where only pointer files (and the
      // `pending` dir) belong is always unexpected. Skipping it would hide a renamed
      // unread pointer from the drain gate.
      if (dirent.name === "." || dirent.name === "..") continue;
      // The `pending` child is a structural part of the role mailbox root and is
      // validated as its own iteration of this loop; it is not an unexpected entry.
      if (isRoot && dirent.name === "pending" && dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      const filename = dirent.name;
      const nameMatch = POINTER_FILENAME.exec(filename);
      // A symlink, a non-regular file, or a name that is not a pointer filename is
      // an unexpected entry where only pointer files belong. Enumerating (rather
      // than listRegularJsonFiles, which silently drops symlinks/dirs/non-.json)
      // makes a tampered or renamed unread delivery record a drain-blocking finding
      // instead of letting the gate treat it as empty.
      if (!dirent.isFile() || dirent.isSymbolicLink() || !nameMatch) {
        findings.push(`${role} mailbox: unexpected non-pointer entry ${filename}`);
        continue;
      }
      let pointer: V1MailboxPointer;
      try {
        pointer = await readJsonNoFollow(join(directory, filename), V1MailboxPointerSchema);
      } catch (err) {
        findings.push(`${role} mailbox pointer ${filename}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // The envelope must agree with the mailbox it lives in and its filename. A
      // misfiled or mislabelled unread pointer is otherwise indistinguishable from
      // absent to the drain gate, so any disagreement is a fail-closed finding.
      if (pointer.role !== role ||
          pointer.mailboxSeq !== Number(nameMatch[1]) ||
          pointer.messageId !== nameMatch[2]) {
        findings.push(`${role} mailbox pointer ${filename}: envelope does not match its mailbox or filename`);
        continue;
      }
      // Every pointer must resolve to an integrity-verified message entry. An
      // unresolved reference (missing thread, missing entry seq, or unreadable
      // entry) is NOT benign: it lets a pointer to nonexistent/unreadable work
      // pass as valid and the drain gate archive unread mail over it, so a null
      // referenced entry is a fail-closed finding.
      const entry = await readV1MessageEntryAtSeq(paths, pointer.threadId, pointer.entrySeq);
      if (!entry) {
        findings.push(`${role} mailbox pointer ${filename}: references an unavailable or unreadable thread entry`);
        continue;
      }
      // The resolved entry must self-verify its own entryHash, be a message, and
      // match the pointer's seq, entryHash, messageId, recipient role, and
      // threadId exactly; any disagreement is a fail-closed finding.
      const payload = entry.type === "message" ? V1MessagePayloadSchema.safeParse(entry.payload) : null;
      if (entry.type !== "message" ||
          payload === null || !payload.success ||
          entry.threadId !== pointer.threadId ||
          entry.seq !== pointer.entrySeq ||
          entry.entryHash !== pointer.entryHash ||
          hashWithoutKey(entry as unknown as Record<string, unknown>, "entryHash") !== entry.entryHash ||
          payload.data.messageId !== pointer.messageId ||
          payload.data.toRole !== pointer.role) {
        findings.push(`${role} mailbox pointer ${filename}: envelope does not match its thread entry`);
        continue;
      }
      pointers.push(pointer);
    }
  }
  return { pointers, findings };
}

export interface V1DrainState {
  readonly folds: V1FoldedThread[];
  readonly unreadNoncritical: string[];
  readonly shipBlockers: string[];
}

/**
 * Reads the pending/ship state of a v1 runtime. Unread noncritical mail is
 * override-able with --force-archive; ship-gate blockers are a separate result
 * that --force-archive never bypasses.
 */
export async function evaluateV1Drain(paths: V1Paths, opts: { strictTemps?: boolean } = {}): Promise<V1DrainState> {
  const folds: V1FoldedThread[] = [];
  const unreadNoncritical: string[] = [];
  const shipBlockers: string[] = [];
  const corruptRecords: string[] = [];
  const ackedByRole = { implementer: new Set<string>(), reviewer: new Set<string>() };

  // A malformed endpoint record can hide an attached peer from the offline proof,
  // so the drain gate must fail closed rather than skip it.
  const { findings: endpointFindings } = await listV1Endpoints(paths);
  corruptRecords.push(...endpointFindings);

  // A permission/IO error reading the threads dir, or an unexpected/malformed
  // thread entry, can hide a pending thread from the gate. Fail closed on any.
  const { threadIds, findings: threadIdFindings } = await listV1ThreadIds(paths);
  corruptRecords.push(...threadIdFindings);

  for (const threadId of threadIds) {
    // Temp handling follows the CALLER's lock context, not the evaluator itself: the
    // authoritative migration drain (migrateV1Runtime, under withV1Locks with writers
    // quiesced) passes strictTemps, so a committed tail renamed to a temp-shaped name
    // cannot be archived as truncated-verified history. The LOCK-FREE advisory callers
    // (`bus setup` preflight, `bus check --ship`) stay tolerant: a concurrent ack/update
    // `durableCreate` temp is legitimate there and must not spuriously quarantine.
    const folded = await foldV1Thread(paths, threadId, { strictTemps: opts.strictTemps === true });
    folds.push(folded);
    for (const id of folded.acknowledgedIds) {
      ackedByRole.implementer.add(id);
      ackedByRole.reviewer.add(id);
    }
    // A quarantined fold exposes only an incomplete verified prefix: the first
    // critical message may be the one that quarantined the fold, leaving
    // `folded.messages` empty and `critical` false. Never infer noncriticality
    // from a truncated prefix. Treat every quarantined thread as a
    // non-overridable migration blocker; the authoritative gate cannot
    // conservatively prove it noncritical from the metadata it can verify.
    if (folded.integrity !== "verified") {
      shipBlockers.push(`quarantined Bus thread ${threadId}`);
      continue;
    }
    // Ship-gate blockers on a verified thread: unacked critical, parked critical.
    // Deliberate omission: canonical-issue existence/resolution is intentionally
    // NOT coupled into this critical-severity check. The Storybloq ledger is the
    // canonical source of truth and the normal ship gate enforces issue
    // resolution, so the v1 drain stays unblockable on that axis by design.
    const critical = folded.messages.some((message) => message.severity === "critical");
    if (critical) {
      if (folded.messages.some((message) => message.severity === "critical" && !folded.acknowledgedIds.has(message.messageId))) {
        shipBlockers.push(`unacknowledged critical Bus message in thread ${threadId}`);
      }
      if (folded.state === "parked") shipBlockers.push(`parked critical Bus thread ${threadId}`);
    }
  }

  for (const role of V1_ROLES) {
    const { pointers, findings: pointerFindings } = await v1MailboxPointers(paths, role);
    corruptRecords.push(...pointerFindings);
    for (const pointer of pointers) {
      const folded = folds.find((candidate) => candidate.threadId === pointer.threadId);
      if (!folded) continue;
      if (folded.acknowledgedIds.has(pointer.messageId)) continue;
      const message = folded.messages.find((candidate) => candidate.messageId === pointer.messageId);
      if (!message) continue;
      if (message.severity === "critical") continue; // covered by ship gate
      unreadNoncritical.push(`${role} mailbox: unread ${message.severity} message ${pointer.messageId} in thread ${pointer.threadId}`);
    }
  }

  // Fail closed on any corrupt v1 record. A malformed endpoint escapes the offline
  // proof and a malformed pointer is indistinguishable from empty; either would let
  // the drain gate archive over unresolved or tampered work. This throws before the
  // caller inspects unreadNoncritical, so --force-archive never bypasses it.
  if (corruptRecords.length > 0) {
    throw new BusError(
      "corrupt",
      `Cannot upgrade: the v1 Bus runtime has corrupt records that must be resolved before migration:\n${corruptRecords.map((finding) => `- ${finding}`).join("\n")}`,
    );
  }

  return { folds, unreadNoncritical: [...new Set(unreadNoncritical)], shipBlockers: [...new Set(shipBlockers)] };
}

export const V1_DEFAULT_MAX_HOPS = DEFAULT_BUS_MAX_HOPS;

// ---------------------------------------------------------------------------
// Legacy-drain surface (D5).
//
// v1 runtimes are frozen for NEW coordination state in 1.8.0 (send/join/hooks
// refuse with upgrade_required upstream), but remain drainable so a user with
// pending v1 mail can ack it and satisfy the migration drain gate without a
// 1.7.0 binary. Only poll, ack, thread park/resolve, export, status, and doctor
// are served here; each mutating op re-reads the live instance after taking its
// operation lock and immediately before mutating, so a drain op paused before
// its lock and resumed after another task migrated returns upgrade_required
// instead of writing v1 records into the archived-or-replaced tree. v1 hash
// chains are never rewritten; ack/park/resolve only append v1-schema entries.
// ---------------------------------------------------------------------------

function v1Serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function v1EntryFilename(seq: number, type: string, entryId: string): string {
  return `${String(seq).padStart(6, "0")}-${type}-${entryId}.json`;
}

function v1PointerFilename(pointer: V1MailboxPointer): string {
  return `${String(pointer.mailboxSeq).padStart(12, "0")}-${pointer.messageId}.json`;
}

function locksDirOf(busRoot: string): string {
  return join(busRoot, "locks");
}

// Guard v1 role-mailbox pointer enumeration, cleanup, and cursor persistence with
// the same v1 lock names v1 used (`mailbox-<role>.lock`, `mailbox-reconcile-<role>.lock`).
// The two paths are acquired in sorted-path order, matching the canonical global
// order enumerateV1Locks (admin.ts) uses when a migration takes every v1 lock, so
// concurrent drain and migration serialize instead of deadlocking. Lock-ordering
// contract: migration (withV1Locks) and ackV1 both acquire the per-thread lock
// BEFORE these fixed mailbox/reconcile locks, so ackV1 nests this helper INSIDE its
// thread lock. pollV1 acquires these mailbox locks standalone (no thread lock) and
// only READS thread files, so it never waits on a thread lock and cannot invert the
// order. Never acquire a `thread-*` lock while already holding these.
async function withV1MailboxLocks<T>(
  busRoot: string,
  role: (typeof V1_ROLES)[number],
  handler: () => Promise<T>,
): Promise<T> {
  const locksDir = locksDirOf(busRoot);
  const lockPaths = [
    join(locksDir, `mailbox-${role}.lock`),
    join(locksDir, `mailbox-reconcile-${role}.lock`),
  ].sort();
  const handles: HardenedLockHandle[] = [];
  try {
    for (const lockPath of lockPaths) {
      handles.push(await acquireHardenedLock(lockPath, { timeoutMs: 15_000 }));
    }
    return await handler();
  } finally {
    for (const handle of handles.reverse()) await releaseHardenedLock(handle).catch(() => undefined);
  }
}

// Re-read the canonical instance under the operation lock. Absent or non-v1 means
// the runtime was migrated; the drain op must abort without mutating anything.
async function revalidateV1Live(busRoot: string): Promise<void> {
  let raw: { schema: string };
  try {
    raw = await readJsonNoFollow(join(busRoot, "instance.json"), z.object({ schema: z.string() }).passthrough());
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") {
      throw new BusError("upgrade_required", "The v1 Bus runtime was migrated. Run `storybloq bus setup`.");
    }
    throw err;
  }
  if (raw.schema !== "storybloq-bus-instance/v1") {
    throw new BusError("upgrade_required", "The v1 Bus runtime was migrated. Run `storybloq bus setup`.");
  }
}

function makeV1Entry(input: {
  type: "ack" | "state";
  threadId: string;
  seq: number;
  prevHash: string;
  payload: Record<string, unknown>;
}): z.infer<typeof V1EntrySchema> {
  const unsigned = {
    schema: "storybloq-bus-entry/v1" as const,
    entryId: randomUUID(),
    threadId: input.threadId,
    seq: input.seq,
    type: input.type,
    prevHash: input.prevHash,
    payload: input.payload,
    createdAt: new Date().toISOString(),
    entryHash: "0".repeat(64),
  };
  return V1EntrySchema.parse({ ...unsigned, entryHash: hashWithoutKey(unsigned, "entryHash") });
}

// Append a v1 entry onto a verified chain. The caller must hold the thread lock
// and have revalidated the live instance.
async function appendV1Entry(
  paths: V1Paths,
  folded: V1FoldedThread,
  type: "ack" | "state",
  payload: Record<string, unknown>,
): Promise<void> {
  const entry = makeV1Entry({
    type,
    threadId: folded.threadId,
    seq: folded.validThroughSeq + 1,
    prevHash: folded.lastHash,
    payload,
  });
  const filename = v1EntryFilename(entry.seq, type, entry.entryId);
  const path = join(paths.threads, folded.threadId, "entries", filename);
  if (Buffer.byteLength(v1Serialize(entry), "utf-8") > BUS_MAX_ENTRY_BYTES) {
    throw new BusError("invalid_input", `Message entry exceeds ${BUS_MAX_ENTRY_BYTES} bytes`);
  }
  await durableCreate(path, v1Serialize(entry));
}

async function removeV1Pointer(paths: V1Paths, pointer: V1MailboxPointer): Promise<void> {
  const mailbox = join(paths.mailboxes, pointer.role);
  const filename = v1PointerFilename(pointer);
  await durableUnlink(join(mailbox, filename)).catch(() => undefined);
  await durableUnlink(join(mailbox, "pending", filename)).catch(() => undefined);
}

async function removeV1PointersForMessage(paths: V1Paths, role: (typeof V1_ROLES)[number], messageId: string): Promise<void> {
  for (const pointer of (await v1MailboxPointers(paths, role)).pointers) {
    if (pointer.messageId === messageId) await removeV1Pointer(paths, pointer);
  }
}

interface V1CallerContext {
  readonly endpoint: V1Endpoint;
  readonly paths: V1Paths;
  readonly busRoot: string;
  readonly persist: (update: (endpoint: V1Endpoint) => Record<string, unknown>) => Promise<void>;
}

// v1 equivalent of withEndpointCaller: acquire the endpoint lock, revalidate the
// live v1 instance, then enforce the same ownership rule (endpointId + validated
// clientTaskId must own the non-retired endpoint).
async function withV1EndpointCaller<T>(
  root: string,
  endpointId: string,
  clientTaskId: string,
  handler: (ctx: V1CallerContext) => Promise<T>,
): Promise<T> {
  if (!UuidSchema.safeParse(endpointId).success) throw new BusError("invalid_input", "Invalid endpoint id");
  const taskId = normalizeClientTaskId(clientTaskId);
  if (!taskId) throw new BusError("unauthorized", "A valid client task id is required");
  const busPaths = await resolveBusPaths(root, false);
  if (!(await busRuntimeExists(busPaths.busRoot))) {
    throw new BusError("not_found", "Bus is not initialized in this checkout. Run `storybloq bus setup` first.");
  }
  const busRoot = busPaths.busRoot;
  const paths = v1PathsFrom(busRoot);
  const endpointPath = join(paths.endpoints, `${endpointId}.json`);
  return withHardenedLock(join(locksDirOf(busRoot), `endpoint-${endpointId}.lock`), async () => {
    await revalidateV1Live(busRoot);
    const endpoint = await readJsonNoFollow(endpointPath, V1EndpointSchema);
    if (endpoint.retiredAt || endpoint.clientTaskId !== taskId) {
      throw new BusError("unauthorized", "Endpoint ownership does not match this task");
    }
    const persist: V1CallerContext["persist"] = async (update) => {
      await revalidateV1Live(busRoot);
      await durableWrite(endpointPath, v1Serialize(update(endpoint)));
    };
    return handler({ endpoint, paths, busRoot, persist });
  }, { timeoutMs: 15_000 });
}

export async function findV1EndpointForTask(
  root: string,
  client: "claude" | "codex",
  clientTaskId: string,
): Promise<string | null> {
  const taskId = normalizeClientTaskId(clientTaskId);
  if (!taskId) return null;
  const busPaths = await resolveBusPaths(root, false);
  if (!(await busRuntimeExists(busPaths.busRoot))) return null;
  for (const endpoint of (await listV1Endpoints(v1PathsFrom(busPaths.busRoot))).endpoints) {
    if (!endpoint.retiredAt && endpoint.client === client && endpoint.clientTaskId === taskId) {
      return endpoint.endpointId;
    }
  }
  return null;
}

async function findV1MessageThread(paths: V1Paths, role: (typeof V1_ROLES)[number], messageId: string): Promise<string | null> {
  for (const pointer of (await v1MailboxPointers(paths, role)).pointers) {
    if (pointer.messageId === messageId) return pointer.threadId;
  }
  // Tolerant lookup: ignore thread-id scan findings (the drain gate enforces
  // them); scan the valid thread directories for the message.
  for (const threadId of (await listV1ThreadIds(paths)).threadIds) {
    const folded = await foldV1Thread(paths, threadId);
    if (folded.messages.some((message) => message.messageId === messageId)) return threadId;
  }
  return null;
}

export interface V1PollEnvelope {
  readonly source: "storybloq_bus";
  readonly authority: "peer_agent";
  readonly integrity: "verified" | "quarantined";
  readonly sender: { readonly role: string };
  readonly threadId: string;
  readonly mailboxSeq: number;
  readonly message: {
    readonly messageId: string;
    readonly kind: string;
    readonly severity: string;
    readonly body: string;
    readonly toRole: string;
    readonly fromRole: string;
  };
}

export interface V1PollResult {
  readonly legacy: "v1_drain";
  readonly endpointId: string;
  readonly cursor: number;
  readonly messages: readonly V1PollEnvelope[];
  readonly findings: readonly string[];
}

export async function pollV1(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  limit?: number;
}): Promise<V1PollResult> {
  return withV1EndpointCaller(root, input.endpointId, input.clientTaskId, async ({ endpoint, paths, busRoot, persist }) => {
    const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit!) : 20;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    // Hold the v1 role mailbox + reconcile locks across pointer enumeration,
    // acked-pointer cleanup, and cursor persistence so this drain op never races
    // a concurrent migration or peer drain mutating the same role mailbox.
    return withV1MailboxLocks(busRoot, endpoint.role, async () => {
      const findings: string[] = [];
      const pointers = (await v1MailboxPointers(paths, endpoint.role)).pointers.sort((a, b) => a.mailboxSeq - b.mailboxSeq);
      const messages: V1PollEnvelope[] = [];
      const ackedPointers: V1MailboxPointer[] = [];
      const priorCursor = endpoint.lastPolledMailboxSeq ?? 0;
      let cursor = priorCursor;

      for (const pointer of pointers) {
        if (messages.length >= limit) break;
        let folded: V1FoldedThread;
        try {
          folded = await foldV1Thread(paths, pointer.threadId);
        } catch (err) {
          findings.push(`${pointer.threadId}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const message = folded.messages.find((candidate) => candidate.messageId === pointer.messageId);
        if (!message || message.toRole !== endpoint.role) {
          findings.push(`${pointer.messageId}: mailbox pointer does not match the thread`);
          continue;
        }
        if (folded.acknowledgedIds.has(pointer.messageId)) {
          ackedPointers.push(pointer);
          continue;
        }
        messages.push({
          source: "storybloq_bus",
          authority: "peer_agent",
          integrity: folded.integrity,
          sender: { role: message.fromRole },
          threadId: pointer.threadId,
          mailboxSeq: pointer.mailboxSeq,
          message: {
            messageId: message.messageId,
            kind: message.kind,
            severity: message.severity,
            body: message.body,
            toRole: message.toRole,
            fromRole: message.fromRole,
          },
        });
        cursor = Math.max(cursor, pointer.mailboxSeq);
      }

      // Poll is read-only aside from removing already-acked pointers and advancing
      // the cursor; both are mutations under the same revalidation guard.
      if (ackedPointers.length > 0 || cursor !== priorCursor) {
        await revalidateV1Live(busRoot);
        for (const pointer of ackedPointers) await removeV1Pointer(paths, pointer);
        await persist((current) => ({
          ...current,
          lastPolledMailboxSeq: Math.max(current.lastPolledMailboxSeq ?? 0, cursor),
          lastSeenAt: new Date().toISOString(),
        }));
      }
      return { legacy: "v1_drain", endpointId: endpoint.endpointId, cursor, messages, findings };
    });
  });
}

export async function ackV1(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  messageId: string;
  disposition: "accepted" | "rejected" | "deferred";
  reason?: string;
}): Promise<{ threadId: string; replayed: boolean }> {
  if (!UuidSchema.safeParse(input.messageId).success) throw new BusError("invalid_input", "Invalid message id");
  return withV1EndpointCaller(root, input.endpointId, input.clientTaskId, async ({ endpoint, paths, busRoot }) => {
    // Resolve the message's thread with a LOCK-FREE lookup (the messageId -> threadId
    // mapping is stable), then acquire locks in the MIGRATION-COMPATIBLE order:
    // thread-<id> BEFORE the mailbox/reconcile locks. Migration's withV1Locks holds
    // the per-thread locks before the fixed mailbox locks, so taking the mailbox lock
    // first here (the previous order) inverted against it and could deadlock a
    // concurrent upgrade. The revalidate + refold under the locks re-check the live
    // runtime and the message state, so the unlocked lookup cannot cause a stale
    // mutation, and pointer removal happens under the mailbox lock regardless.
    const threadId = await findV1MessageThread(paths, endpoint.role, input.messageId);
    if (!threadId) throw new BusError("not_found", "Bus message not found");
    return withHardenedLock(join(locksDirOf(busRoot), `thread-${threadId}.lock`), async () => {
      return withV1MailboxLocks(busRoot, endpoint.role, async () => {
        await revalidateV1Live(busRoot);
        const folded = await foldV1Thread(paths, threadId);
        if (folded.integrity !== "verified") throw new BusError("corrupt", "Thread is quarantined");
        const message = folded.messages.find((candidate) => candidate.messageId === input.messageId);
        if (!message || message.toRole !== endpoint.role) {
          throw new BusError("unauthorized", "Message is not addressed to this endpoint");
        }
        const reasonText = input.reason?.trim();
        if ((input.disposition === "rejected" || input.disposition === "deferred") && !reasonText) {
          throw new BusError("invalid_input", `A reason is required for ${input.disposition} acknowledgment`);
        }
        const reason = reasonText ? normalizeBusText(input.reason!, "Acknowledgment reason", 4096) : undefined;
        const next: V1AckPayload = {
          messageId: input.messageId,
          byEndpoint: endpoint.endpointId,
          disposition: input.disposition,
          ...(reason ? { reason } : {}),
        };
        // An identical disposition + reason is an idempotent replay. A deferred ack
        // may still be promoted to accepted/rejected (v1AckTransitionAllowed); any
        // other disposition change is rejected here rather than written as a poison
        // entry that the next fold would quarantine. The prior disposition comes from
        // the fold's exposed acknowledgments map, not the bare acknowledgedIds set.
        const previous = folded.acknowledgments.get(input.messageId);
        if (previous && previous.disposition === next.disposition && previous.reason === next.reason) {
          return { threadId, replayed: true };
        }
        if (!v1AckTransitionAllowed(previous, next)) {
          throw new BusError("invalid_input", "Cannot change the disposition of an existing acknowledgment");
        }
        await appendV1Entry(paths, folded, "ack", next);
        await removeV1PointersForMessage(paths, endpoint.role, input.messageId);
        return { threadId, replayed: false };
      });
    });
  });
}

async function validateV1Commit(root: string, commit: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: root, timeout: 3000 }, (err) => {
      if (err) reject(new BusError("invalid_input", `Commit evidence does not resolve: ${commit}`));
      else resolve();
    });
  });
}

export interface V1ThreadView {
  readonly legacy: "v1_drain";
  readonly threadId: string;
  readonly kind: string;
  readonly state: "open" | "parked" | "resolved";
  readonly integrity: "verified" | "quarantined";
}

export async function updateV1Thread(root: string, input: {
  endpointId: string;
  clientTaskId: string;
  threadId: string;
  action: "park" | "resolve" | "reopen";
  reason?: string;
  resolution?: string;
  evidence?: { commit?: string; ciRun?: string };
}): Promise<V1ThreadView> {
  if (input.action === "reopen") {
    throw new BusError("invalid_input", "A v1 Bus thread can only be parked or resolved during drain; reopen is unavailable. Run `storybloq bus setup` after draining.");
  }
  if (!UuidSchema.safeParse(input.threadId).success) throw new BusError("invalid_input", "Invalid Bus thread id");
  return withV1EndpointCaller(root, input.endpointId, input.clientTaskId, async ({ endpoint, paths, busRoot }) => {
    return withHardenedLock(join(locksDirOf(busRoot), `thread-${input.threadId}.lock`), async () => {
      await revalidateV1Live(busRoot);
      const folded = await foldV1Thread(paths, input.threadId);
      if (folded.integrity !== "verified") throw new BusError("corrupt", "Thread is quarantined");
      if (!folded.participantRoles.includes(endpoint.role)) {
        throw new BusError("unauthorized", "Endpoint is not a thread participant");
      }
      const reason = input.reason?.trim() ? normalizeBusText(input.reason, "Thread-state reason", 4096) : undefined;
      const resolution = input.resolution?.trim() ? normalizeBusText(input.resolution, "Thread resolution", 8192) : undefined;
      const commit = input.evidence?.commit?.trim();
      const ciRun = input.evidence?.ciRun?.trim();
      const evidence = commit || ciRun
        ? { ...(commit ? { commit: commit.toLowerCase() } : {}), ...(ciRun ? { ciRun } : {}) }
        : undefined;
      if (input.action === "park" && (folded.state !== "open" || !reason)) {
        throw new BusError("invalid_input", "Parking an open thread requires a reason");
      }
      if (input.action === "resolve" && (folded.state === "resolved" || !resolution || !evidence)) {
        throw new BusError("invalid_input", "Resolving a thread requires resolution text and evidence");
      }
      if (evidence?.commit) await validateV1Commit(root, evidence.commit);
      await appendV1Entry(paths, folded, "state", {
        action: input.action,
        byEndpoint: endpoint.endpointId,
        ...(reason ? { reason } : {}),
        ...(resolution ? { resolution } : {}),
        ...(evidence ? { evidence } : {}),
      });
      const next = await foldV1Thread(paths, input.threadId);
      return { legacy: "v1_drain", threadId: next.threadId, kind: next.kind, state: next.state, integrity: next.integrity };
    });
  });
}

async function foldV1FromBase(root: string, base: "live" | "archive", threadId: string): Promise<V1FoldedThread> {
  const busPaths = await resolveBusPaths(root, false);
  const v1Root = base === "live" ? busPaths.busRoot : join(busPaths.busRoot, "archive", "v1");
  return foldV1Thread(v1PathsFrom(v1Root), threadId);
}

function serializeV1Export(folded: V1FoldedThread, format: "json" | "md"): string {
  if (format === "json") {
    return JSON.stringify({
      thread: {
        threadId: folded.threadId,
        kind: folded.kind,
        topicRef: folded.topicRef,
        participantRoles: folded.participantRoles,
      },
      state: folded.state,
      integrity: folded.integrity,
      messages: folded.messages,
      acknowledgedIds: [...folded.acknowledgedIds].sort(),
    }, null, 2);
  }
  const lines = [
    `# Storybloq Bus thread ${folded.threadId} (legacy v1)`,
    "",
    `Kind: ${folded.kind} | State: ${folded.state} | Integrity: ${folded.integrity}`,
    `Topic: ${JSON.stringify(folded.topicRef)}`,
    "",
  ];
  for (const message of folded.messages) {
    lines.push(`## ${message.fromRole} -> ${message.toRole} (${message.severity} ${message.kind})`, "", message.body, "");
  }
  return lines.join("\n").trimEnd();
}

/** Read-only export of a live-or-archived v1 thread (D5). */
export async function exportV1Thread(
  root: string,
  threadId: string,
  format: "json" | "md",
  base: "live" | "archive" = "live",
): Promise<string> {
  return serializeV1Export(await foldV1FromBase(root, base, threadId), format);
}

export async function summarizeV1(root: string): Promise<BusSummary> {
  const busPaths = await resolveBusPaths(root, false);
  const paths = v1PathsFrom(busPaths.busRoot);
  const { endpoints, findings: endpointFindings } = await listV1Endpoints(paths);
  const active = endpoints.filter((endpoint) => !endpoint.retiredAt);
  const folds: V1FoldedThread[] = [];
  // Tolerant: status ignores thread-id scan findings and folds what it can.
  for (const threadId of (await listV1ThreadIds(paths)).threadIds) {
    try {
      folds.push(await foldV1Thread(paths, threadId));
    } catch {
      // Doctor surfaces unreadable threads; status stays available.
    }
  }
  let pendingMessages = 0;
  let unacknowledgedCritical = 0;
  for (const folded of folds) {
    for (const message of folded.messages) {
      if (!folded.acknowledgedIds.has(message.messageId)) {
        pendingMessages += 1;
        if (message.severity === "critical") unacknowledgedCritical += 1;
      }
    }
  }
  const activeCount = active.length;
  // Mirror the v2 setup-state derivation: `ready` requires EXACTLY two valid
  // active endpoints. More than two active endpoints violates the two-endpoint
  // invariant, and any endpoint-scan finding means an endpoint record could not
  // be trusted; either makes the runtime `invalid`, never `ready`.
  const setupState: BusSummary["setupState"] =
    activeCount > 2 || endpointFindings.length > 0 ? "invalid"
    : activeCount === 2 ? "ready"
    : activeCount === 1 ? "waiting_for_peer"
    : "disconnected";
  return {
    enabled: true,
    initialized: true,
    daemonState: "stopped",
    setupState,
    deliveryMode: "poll",
    participants: active.map((endpoint) => ({
      client: endpoint.client,
      surface: endpoint.surface,
      state: endpoint.state ?? "unknown",
    })),
    // A v1 runtime is drainable but not migrated; steer the reader to `bus setup`.
    nextActions: ["run: storybloq bus setup"],
    endpoints: activeCount,
    pendingMessages,
    unacknowledgedCritical,
    openThreads: folds.filter((folded) => folded.state === "open").length,
    parkedThreads: folds.filter((folded) => folded.state === "parked").length,
    undeliverable: 0,
    quarantined: folds.filter((folded) => folded.integrity !== "verified").length,
    hookDelivery: { claude: false, codex: false },
    // A v1 runtime predates guarded hook delivery entirely; no channel is active.
    deliveryCapabilities: { onStop: "none", onTool: "none" },
  };
}

export interface V1DoctorResult {
  readonly healthy: boolean;
  readonly summary: BusSummary;
  readonly findings: readonly string[];
  // ISS-1002 follow-up: always empty. A v1 runtime predates the redeliver-marker
  // hop-cap-successor mechanism entirely, so no code path in this legacy drain
  // report can ever produce a notice; the field exists only to satisfy the
  // shared BusDoctorResult shape busDoctor's v1 branch returns.
  readonly notices: readonly string[];
}

export async function doctorV1(root: string): Promise<V1DoctorResult> {
  const summary = await summarizeV1(root);
  const busPaths = await resolveBusPaths(root, false);
  const paths = v1PathsFrom(busPaths.busRoot);
  const findings: string[] = [];
  // Tolerant: doctor annotates thread-id scan findings rather than throwing.
  const threadScan = await listV1ThreadIds(paths);
  findings.push(...threadScan.findings.map((finding) => `threads: ${finding}`));
  for (const threadId of threadScan.threadIds) {
    try {
      const folded = await foldV1Thread(paths, threadId);
      if (folded.integrity !== "verified") findings.push(`thread ${threadId}: quarantined`);
    } catch (err) {
      findings.push(`thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Tolerant: doctor also surfaces the structured endpoint-scan and both role
  // mailbox-pointer findings (the same records the drain gate fails closed on)
  // so a corrupt endpoint or a misfiled/missing mailbox pointer is visible in
  // status/doctor output instead of only blocking migration. Doctor reports;
  // it never throws.
  findings.push(...(await listV1Endpoints(paths)).findings.map((finding) => `endpoint: ${finding}`));
  for (const role of V1_ROLES) {
    findings.push(...(await v1MailboxPointers(paths, role)).findings);
  }
  // A v1 runtime is a detected, actionable state, not a clean one.
  findings.push("v1 Bus runtime detected; run `storybloq bus setup` to drain and upgrade it.");
  return { healthy: false, summary, findings, notices: [] };
}
