/**
 * Candidate recovery (T-450 step 6b): the durable intent protocol.
 *
 * The candidate invariant `transitionStartedRevision ===
 * confirmedSessionRevision + 1` requires that NOTHING increments the session
 * revision between authorize and write 1. So the pre-publication phases of a
 * candidate cancellation do not live in `state.json`: the durable intent is
 * its own file in the session directory, created exclusively, advanced by
 * atomic replace, and superseded archive-first, so that recovery at any
 * pre-publication boundary reconstructs deterministically without a session
 * write.
 *
 * THE PATHNAME RULE, which every writer below serves: the canonical pathname
 * is NEVER freed. There is no instant at which `cancellation-intent.json` is
 * absent once created, so a crash anywhere in any writer leaves either the
 * old intent (retry) or the new one (proceed), and absence stays unambiguous
 * permission to create. Archives are evidence, never authority: exactly one
 * transitionId is ever live, the canonical file's.
 *
 * LOCKING: every writer here REQUIRES the already-held session lock. Nothing
 * in this module acquires it, exactly as `applyCancellationTransition`
 * requires it of its callers.
 *
 * DURABILITY: fsync barriers are explicit because rename atomicity only
 * ORDERS the two states; only the directory fsync makes the ordering reach
 * the drive. Stated precisely: on macOS `fsyncSync` is fsync(2), which
 * flushes to the DRIVE, not through its write cache (F_FULLFSYNC would), so
 * these barriers order and persist writes against process and OS failure and
 * against power loss only as far as the device's own cache guarantees. Each barrier is followed by an `__intentTesting.at` point so the
 * crash-injection suite can stop the world after every filesystem operation
 * and assert the invariants above.
 */
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Buffer } from "node:buffer";
import {
  CANCELLATION_INTENT_FILE,
  CancellationIntentSchema,
  PersistedLivenessEvidenceSchema,
  PersistedTicketSnapshotSchema,
  type CancellationAuthority,
  type CancellationIntent,
  type PersistedLivenessEvidence,
  type PersistedTicketSnapshot,
} from "./session-types.js";
import {
  evidenceFingerprint,
  permitsRecoveryOffer,
  readOwnerLiveness,
  OWNER_STALE_MS,
  type OwnableLivenessState,
  type OwnerLivenessSignals,
} from "./liveness.js";
import type { SuccessorServers } from "./mcp-registry.js";
import { reconcileClaim, type ClaimEpoch, type ClaimReconciliation } from "./claim-reconciliation.js";
import { readTicketClaimState } from "./claim-preflight.js";
import type { Ticket } from "../models/ticket.js";
import { canonicalStartedAt } from "./cancellation-core.js";
import { readCancellationTransition } from "./cancellation-transition.js";

/** Crash-injection seam. Production is a no-op; the intent suite replaces it
 * to throw after a named filesystem operation. Same shape as liveness's
 * `__testing` hooks: module-private effects, test-visible seams. */
export const __intentTesting = {
  at: (_point: string): void => undefined,
};

function intentPath(sessionDir: string): string {
  return join(sessionDir, CANCELLATION_INTENT_FILE);
}

function archivePathFor(sessionDir: string, transitionId: string, epoch: number): string {
  return join(sessionDir, `cancellation-intent.superseded.${transitionId}.${epoch}.json`);
}

/** One serialization for every writer, so byte-strict comparisons (the EEXIST
 * archive rule) compare content, never formatting accidents. */
function serialize(intent: CancellationIntent): string {
  return JSON.stringify(intent, null, 2) + "\n";
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * EXCLUSIVE CREATE, done as build-then-claim rather than claim-then-build.
 *
 * The obvious spelling, `openSync(name, "wx")`, creates the inode BEFORE the
 * first byte is written, so a crash in that window leaves a zero-length file
 * at the name. For the canonical intent that is fatal and unrecoverable:
 * empty parses as malformed, malformed is never absence, and absence is the
 * only state that permits a create -- so one instant of crash window wedges
 * the pathname permanently, with nothing in this module able to clear it. A
 * short write does the same with a truncated file.
 *
 * `link` removes the window without giving up exclusivity. The temp file is
 * written and fsync'd IN FULL first, then `linkSync` publishes the real name
 * in a single step that fails with EEXIST when the name is already taken --
 * the same refusal `wx` gave, at the same strength, but now the name can only
 * ever appear carrying complete, durable bytes. Every crash therefore leaves
 * either absence (the retry creates) or a valid record (the retry reads
 * EEXIST and routes through classification). There is no third state.
 *
 * The temp name is DETERMINISTIC rather than unique, so a temp left by a
 * crashed attempt is truncated by the next attempt's `w` open instead of
 * accumulating as litter. It never carries authority; only the linked name
 * does, which is why the link, not the write, is the moment of creation.
 */
function createExclusiveDurable(sessionDir: string, path: string, text: string, prefix: string): void {
  const tmp = intentPath(sessionDir) + ".creating";
  // UNLINK BEFORE OPEN, and this is not tidiness -- it is the difference
  // between this writer and a corruption path.
  //
  // After `link` the temp NAME and the published name are two directory
  // entries for ONE inode. A crash between the link and the unlink below, or
  // a power loss that drops the un-fsynced unlink, leaves the temp still
  // pointing at the LIVE record. `openSync(tmp, "w")` is O_TRUNC, so the next
  // writer of any prefix -- create, supersede's archive, retire's archive --
  // would truncate that live record through the shared inode the instant it
  // opened its temp. For the canonical intent that resurrects the exact
  // zero-length wedge build-then-claim was introduced to remove, and this
  // time from a state nothing in the module can clear; for an archive it
  // silently rewrites evidence, breaking both the byte-strict EEXIST
  // resolution and `priorCycleIsArchived` for that triple.
  //
  // Unlinking first drops OUR entry only, so the open always mints a fresh
  // inode and the published record is untouchable from here. The
  // deterministic name is kept: a crashed attempt leaves at most one stale
  // temp, and the next attempt REMOVES it rather than reopening it, so it
  // never accumulates and never carries anything forward.
  try {
    unlinkSync(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fd = openSync(tmp, "w");
  try {
    // INSIDE the try, so an injected throw here still runs `closeSync`. This
    // seam fires on every crash-sweep iteration of every writer, so leaking a
    // descriptor per injection is how a suite runs out of them.
    __intentTesting.at(`${prefix}:tmp-opened`);
    const bytes = Buffer.from(text, "utf-8");
    const written = writeSync(fd, bytes);
    if (written !== bytes.length) {
      throw new Error(`intent write was short: ${written} of ${bytes.length} bytes to ${tmp}`);
    }
    __intentTesting.at(`${prefix}:tmp-written`);
    fsyncSync(fd);
    __intentTesting.at(`${prefix}:tmp-fsynced`);
  } finally {
    closeSync(fd);
  }
  // EEXIST propagates to the caller, whose situation table decides. This is
  // the create.
  try {
    linkSync(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EEXIST is the answer, not a failure, and must pass through untouched.
    // The others mean the FILESYSTEM cannot do this, which `wx` did not
    // require: exFAT and some SMB mounts have no hard links. Say so plainly
    // rather than surfacing a bare errno from a call the caller never made.
    if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV") {
      throw new Error(
        `the session directory's filesystem does not support hard links (${code}), which the durable ` +
        `intent protocol requires to publish ${path} without a window where the name exists empty`,
        { cause: err },
      );
    }
    throw err;
  }
  __intentTesting.at(`${prefix}:linked`);
  fsyncPath(sessionDir);
  __intentTesting.at(`${prefix}:dir-fsynced`);
  // Last, and deliberately after the directory fsync: the record is already
  // durable under its real name, so losing the machine here costs a stale
  // temp and nothing else.
  unlinkSync(tmp);
  __intentTesting.at(`${prefix}:tmp-removed`);
}

/** Atomic replace: fsync'd temp, rename over the canonical name, directory
 * fsync. The canonical pathname is never absent at any instant. */
function replaceDurable(sessionDir: string, text: string, pointPrefix: string): void {
  const tmp = intentPath(sessionDir) + ".tmp";
  const fd = openSync(tmp, "w");
  try {
    const bytes = Buffer.from(text, "utf-8");
    const written = writeSync(fd, bytes);
    // Checked for the same reason as the exclusive create: a short write here
    // is renamed over the canonical pathname, so a truncated temp becomes a
    // permanently malformed canonical intent.
    if (written !== bytes.length) {
      throw new Error(`intent write was short: ${written} of ${bytes.length} bytes to ${tmp}`);
    }
    __intentTesting.at(`${pointPrefix}:tmp-written`);
    fsyncSync(fd);
    __intentTesting.at(`${pointPrefix}:tmp-fsynced`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, intentPath(sessionDir));
  __intentTesting.at(`${pointPrefix}:renamed`);
  fsyncPath(sessionDir);
  __intentTesting.at(`${pointPrefix}:dir-fsynced`);
}

// ---------------------------------------------------------------------------
// Reading and classifying
// ---------------------------------------------------------------------------

export type IntentRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly intent: CancellationIntent; readonly raw: string }
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * `absent` is the ONLY state that permits creation. `malformed` means
 * something IS there that cannot be trusted, and `unreadable` means we could
 * not look; treating either as absence would hand out permission to create
 * over evidence we could not inspect (the 6a rule, applied to a new file).
 */
export function readCancellationIntent(sessionDir: string): IntentRead {
  let raw: string;
  try {
    raw = readFileSync(intentPath(sessionDir), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", detail: code ?? "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed", detail: "invalid JSON" };
  }
  const result = CancellationIntentSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "malformed", detail: result.error.issues[0]?.message ?? "schema violation" };
  }
  return { kind: "valid", intent: result.data, raw };
}

export type IntentOwnership =
  | { readonly kind: "ours" }
  | { readonly kind: "foreign"; readonly detail: string };

/**
 * MATCHING is sessionId + sessionStartedAt + clientTaskId together. Session
 * directories are reused, so an intent left by an earlier incarnation carries
 * the right id and the wrong provenance; and an intent is task-bound, so a
 * caller with no identity, or another's, cannot resume it. Fails closed when
 * the live start time is unusable, for the same reason the transition
 * identity gate does.
 */
export function classifyIntentOwnership(
  intent: CancellationIntent,
  live: { readonly sessionId: string; readonly startedAt: unknown },
  clientTaskId: string | undefined,
): IntentOwnership {
  if (intent.sessionId !== live.sessionId) {
    return { kind: "foreign", detail: `it names session ${intent.sessionId}, not ${live.sessionId}` };
  }
  const startedAt = canonicalStartedAt(live.startedAt);
  if (startedAt === null) {
    return { kind: "foreign", detail: "this session's own start time is unusable, so provenance cannot be proven" };
  }
  if (intent.sessionStartedAt !== startedAt) {
    return { kind: "foreign", detail:
      `it was minted for an incarnation started at ${intent.sessionStartedAt}, and this one started at ${startedAt}` };
  }
  if (!clientTaskId || intent.clientTaskId !== clientTaskId) {
    return { kind: "foreign", detail:
      `it belongs to task ${intent.clientTaskId}, and this caller ` +
      (clientTaskId ? `is ${clientTaskId}` : "carries no task identity") };
  }
  return { kind: "ours" };
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export type IntentWrite =
  | { readonly ok: true; readonly intent: CancellationIntent }
  | { readonly ok: false; readonly reason:
      | "exists"
      | "not-found"
      | "nothing-to-supersede"
      | "unreadable"
      | "malformed"
      | "identity-mismatch"
      | "edge-refused"
      | "epoch-not-monotonic"
      | "predecessor-mismatch"
      | "ticket-work-begun"
      | "no-ticket-work"
      | "archive-conflict"
      | "not-closed"
      | "outcome-underivable"
      | "receipt-not-writable"
      | "transition-id-reused";
      readonly detail: string };

/**
 * NO WRITER MAY PRODUCE A RECORD ITS OWN READER REFUSES.
 *
 * Found by a test that meant to assert something else: advancement compared
 * the incoming record against the canonical one and checked the edge, but
 * never parsed it, so carrying a `claimTxn` across the ticket_applied ->
 * claim_cleared edge wrote a canonical intent that read back as MALFORMED.
 * The whole-record pin cannot catch that, because `claimTxn` is one of the
 * two fields the phase arms legitimately vary; only the schema knows which
 * arm may carry it. A malformed canonical is the worst outcome this module
 * has -- it is not absence, so nothing may create over it, and it is not
 * valid, so nothing may advance it -- and it was reachable through an
 * entirely legal-looking call.
 */
function refuseUnwritableRecord(intent: CancellationIntent, what: string): IntentWrite | null {
  const parsed = CancellationIntentSchema.safeParse(intent);
  if (parsed.success) return null;
  const detail = parsed.error.issues.slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  return { ok: false, reason: "malformed", detail:
    `${what} would not parse as a cancellation intent, so writing it would leave a canonical record ` +
    `nothing can read, create over, or advance: ${detail || "unparseable"}` };
}

/**
 * A NEW CYCLE MUST CARRY A NEW IDENTITY.
 *
 * Nothing in the schema stops a replacement reusing the id of the intent it
 * displaces at a higher epoch, and the archive namespace survives that
 * (its names are keyed by id AND epoch, and epochs are monotonic). What does
 * not survive it is any proof keyed on the transitionId alone: with reuse
 * permitted, cycle 1's durable outcome record names the same id cycle 2's
 * closed intent carries, so cycle 1's postimage would prove cycle 2's
 * outcome. Refusing reuse here is what makes that identity a cycle-unique
 * key, which the takeover derivability proof rests on.
 */
function refuseReusedTransitionId(current: CancellationIntent, replacement: CancellationIntent): IntentWrite | null {
  if (replacement.transitionId !== current.transitionId) return null;
  return { ok: false, reason: "transition-id-reused", detail:
    `the replacement reuses transitionId ${current.transitionId}; a new cycle mints a new identity, so that ` +
    "id stays the unique key of the cycle it already names" };
}

/**
 * THE RECEIPT IS NOT CALLER-WRITABLE.
 *
 * `adoptedFromEpoch` is what tells a completed adoption apart from the state
 * it started in, so it is only worth anything if `readoptCancellationIntent`
 * is the only thing that can produce it. The persisted schema has to keep the
 * field optional -- an intent that never was adopted genuinely does not carry
 * one -- so the schema cannot enforce that, and every write API that accepts
 * a caller-built intent has to refuse it here instead. Without this a record
 * could be CREATED carrying a fabricated receipt, and its very first
 * same-epoch adoption request would then be waved through as a retry, which
 * is the exact hole the receipt was introduced to close.
 *
 * Ordinary advancement is not in this list on purpose: it must PRESERVE a
 * genuine receipt, and the whole-record pin already forbids it changing one.
 */
function refuseCallerSuppliedReceipt(intent: CancellationIntent, what: string): IntentWrite | null {
  if (intent.adoptedFromEpoch === undefined) return null;
  return { ok: false, reason: "receipt-not-writable", detail:
    `${what} carries adoptedFromEpoch, which only an adoption may write; a caller-supplied receipt would ` +
    "make a first re-authorization indistinguishable from the retry of one that already landed" };
}

/** The only way an intent comes into existence: exclusive create. A present
 * intent, whatever its state, routes through classification. */
export function createCancellationIntent(sessionDir: string, intent: CancellationIntent): IntentWrite {
  const forged = refuseCallerSuppliedReceipt(intent, "the intent being created");
  if (forged) return forged;
  const unwritable = refuseUnwritableRecord(intent, "the intent being created");
  if (unwritable) return unwritable;
  try {
    createExclusiveDurable(sessionDir, intentPath(sessionDir), serialize(intent), "create");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, reason: "exists", detail: "an intent already exists at the canonical pathname" };
    }
    throw err;
  }
  return { ok: true, intent };
}

/**
 * Structural, key-order-independent equality, the same shape and for the same
 * reason as `claim-reconciliation`'s: a formatter or merge driver that rewrote
 * a record with identical values in a different key order must not read as a
 * change.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEquals(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEquals(ao[k], bo[k]));
}

/** Everything an advancement may NOT change: the whole record minus the two
 * fields the phase arms themselves vary. */
function withoutVariantFields(intent: CancellationIntent): Record<string, unknown> {
  const { phase: _phase, ...rest } = intent as Record<string, unknown> & { phase: string };
  delete (rest as Record<string, unknown>).claimTxn;
  delete (rest as Record<string, unknown>).outcome;
  return rest;
}

/** From -> to, exact predecessor required. Any other edge would skip the
 * durable preparation that makes the corresponding recovery row
 * deterministic. */
const ALLOWED_EDGES: Readonly<Record<string, CancellationIntent["phase"]>> = {
  authorized: "prepared",
  prepared: "ticket_applied",
  ticket_applied: "claim_cleared",
  claim_cleared: "closed",
};

/**
 * Same-transition, same-epoch, one allowed edge. Advancement records that a
 * phase's work HAPPENED; it never re-confirms (epoch is untouched) and never
 * re-identifies (transitionId is untouched). Identity fields are compared,
 * not trusted, because the caller hands us a whole next-intent and a bug that
 * drifted a confirmation field through advancement would corrupt the very
 * record recovery validates against.
 */
export function advanceCancellationIntent(sessionDir: string, next: CancellationIntent): IntentWrite {
  const current = readCancellationIntent(sessionDir);
  if (current.kind === "absent") {
    return { ok: false, reason: "not-found", detail: "no intent exists to advance" };
  }
  if (current.kind === "unreadable" || current.kind === "malformed") {
    return { ok: false, reason: current.kind, detail: current.detail };
  }
  const c = current.intent;
  // EVERYTHING EXCEPT THE PHASE IS PINNED, not just the seven scalars an
  // earlier draft compared. Pinning only those left four ways for a buggy
  // caller to rewrite durable facts through a LEGAL edge, each forbidden by
  // this function's own contract: swapping `evidence` without bumping the
  // epoch (so epoch N's evidence no longer matches what minted it), rewriting
  // `ticketPreimage` (the field deterministic reconstruction rests on),
  // DROPPING `predecessor` (optional in the schema, so its absence parses,
  // erasing the supersession audit link before acceptance-time validation can
  // ever check it), and swapping the claimTxn payload to a different ticket
  // across prepared -> ticket_applied. Comparing the whole record makes the
  // contract enforced rather than merely stated.
  if (!deepEquals(withoutVariantFields(next), withoutVariantFields(c))) {
    return { ok: false, reason: "identity-mismatch", detail:
      "advancement may change only the phase; every other field must carry the canonical intent's value verbatim" };
  }
  if (ALLOWED_EDGES[c.phase] !== next.phase) {
    return { ok: false, reason: "edge-refused", detail:
      `the only edge from ${c.phase} is ${ALLOWED_EDGES[c.phase] ?? "none"}, not ${next.phase}` };
  }
  // The claim transaction's PAYLOAD is pinned across prepared ->
  // ticket_applied; only its own phase moves, in lockstep with the intent's
  // (the schema binds the two). Without this a caller could carry the edge
  // while pointing the transaction at a different ticket, and the recovery
  // table would then reconstruct a release for a ticket nobody prepared.
  if (c.phase === "prepared" && next.phase === "ticket_applied") {
    const { phase: _cp, ...cTxn } = c.claimTxn;
    const { phase: _np, ...nTxn } = next.claimTxn;
    if (!deepEquals(nTxn, cTxn)) {
      return { ok: false, reason: "identity-mismatch", detail:
        "the claim transaction's payload must survive the ticket_applied edge unchanged; only its phase moves" };
    }
  }
  const unwritable = refuseUnwritableRecord(next, "the advanced intent");
  if (unwritable) return unwritable;

  replaceDurable(sessionDir, serialize(next), "advance");
  return { ok: true, intent: next };
}

/**
 * The durable proof that a supersession or retirement ALREADY RAN.
 *
 * Both writers archive first and replace second, so "the canonical file
 * already equals the replacement" is necessary but nowhere near sufficient:
 * a caller that passes the CURRENT intent as its own replacement produces
 * that same equality on a first call, having done nothing, and a bare
 * equality check would report success and let every guard below it be
 * skipped -- including the closed-phase gate and the derivability proof that
 * exist to stop exactly this. The archive is what distinguishes the two: it
 * exists only because a real cycle wrote it, at a name the replacement itself
 * names through its predecessor triple.
 */
function priorCycleIsArchived(sessionDir: string, replacement: CancellationIntent): boolean {
  const pred = replacement.predecessor;
  if (!pred) return false;
  // EXISTENCE IS NOT THE PROOF; content is. A zero-length or foreign file at
  // the archive name would satisfy a bare `existsSync` while standing for no
  // completed cycle at all -- and the half-birth branch a few lines down
  // exists precisely because such a file can be sitting there. So the archive
  // is parsed and required to BE the intent the predecessor triple names, all
  // three components of it. That is the same record the writer archived, so a
  // real cycle always passes and nothing else does.
  let raw: string;
  try {
    raw = readFileSync(archivePathFor(sessionDir, pred.predecessorTransitionId, pred.predecessorEpoch), "utf-8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const archived = CancellationIntentSchema.safeParse(parsed);
  return archived.success
    && archived.data.transitionId === pred.predecessorTransitionId
    && archived.data.confirmationEpoch === pred.predecessorEpoch
    && archived.data.confirmedFingerprint === pred.predecessorFingerprint;
}

/**
 * Supersession after a pre-write-1 revision mismatch: archive FIRST
 * (exclusive create of the old bytes, fsync'd), replace SECOND (fsync'd temp,
 * atomic rename, directory fsync at both barriers).
 *
 * Allowed only while ticket work has NOT begun (the R2 rule): once
 * `ticket_applied` exists the transitionId is the audit identity of that work
 * and re-authorization ADOPTS instead. The replacement must start over at
 * `authorized`, carry a strictly larger `confirmationEpoch`, and name its
 * predecessor exactly; the triple is validated against the canonical intent
 * it retires, so the audit chain holds even though the id changes.
 *
 * IDEMPOTENT ON RETRY at every seam: a canonical already equal to the
 * replacement is an already-superseded success, and EEXIST on the archive is
 * answered by reading the existing archive and requiring its bytes to
 * strictly match the current canonical intent, then continuing. A mismatched
 * archive at that name is someone else's evidence and refuses.
 */
export function supersedeCancellationIntent(sessionDir: string, replacement: CancellationIntent): IntentWrite {
  const current = readCancellationIntent(sessionDir);
  if (current.kind === "absent") {
    return { ok: false, reason: "nothing-to-supersede", detail:
      "no canonical intent exists; absence is permission to create, not to supersede" };
  }
  if (current.kind === "unreadable" || current.kind === "malformed") {
    return { ok: false, reason: current.kind, detail: current.detail };
  }
  const c = current.intent;

  const supersedeForged = refuseCallerSuppliedReceipt(replacement, "the superseding intent");
  if (supersedeForged) return supersedeForged;
  const supersedeUnwritable = refuseUnwritableRecord(replacement, "the superseding intent");
  if (supersedeUnwritable) return supersedeUnwritable;

  // Crash-after-rename retry, under two requirements that answer two
  // different questions. `deepEquals` asks whether the canonical file IS the
  // postimage being requested -- the WHOLE record, because a replacement
  // sharing only the transitionId and epoch while differing in evidence,
  // confirmation, ticket preimage or predecessor is a DIFFERENT record, and
  // reporting success for it would claim durable facts nobody ever wrote.
  // `priorCycleIsArchived` asks whether a real cycle produced that state,
  // which equality alone can never establish. Neither implies the other.
  //
  // `replacement.phase === "authorized"` closes the second-generation spoof
  // for every phase but one. A canonical minted by a PRIOR cycle carries a
  // predecessor triple naming a real archive, so handing it back as its own
  // replacement satisfies both halves above on a first call and skips the
  // predecessor check that would have caught it. Supersession only ever
  // renames an `authorized` replacement into place, so a genuine retry always
  // finds one; a spoof holding anything else is refused here.
  //
  // THE SURVIVING CONTRACT, since the authorized-phase residual cannot be
  // closed at this interface without a caller-declared argument -- a guard
  // living inside the party it distrusts: `ok: true` is NOT authorization for
  // an external effect. It says the canonical record IS this intent, nothing
  // more. Callers act on the RETURNED intent, never on a belief that a cycle
  // boundary just occurred here. The residual is a zero-write false success
  // on a pure read path; the catastrophe class, discarding a record, is
  // unreachable through it.
  if (deepEquals(c, replacement) && replacement.phase === "authorized"
    && priorCycleIsArchived(sessionDir, replacement)) {
    return { ok: true, intent: c };
  }

  if (c.phase === "ticket_applied" || c.phase === "claim_cleared" || c.phase === "closed") {
    return { ok: false, reason: "ticket-work-begun", detail:
      `the canonical intent is at ${c.phase}; once ticket work exists its transitionId is the audit ` +
      "identity of that work, and re-authorization adopts rather than supersedes" };
  }
  // Placed on the FULL path, deliberately BELOW the retry shortcut: a genuine
  // crash-after-rename retry finds the canonical already equal to the
  // replacement, so it "reuses" that id by construction and would be refused
  // here. Reuse is only a defect when a NEW cycle is being written.
  const supersedeReused = refuseReusedTransitionId(c, replacement);
  if (supersedeReused) return supersedeReused;

  const pred = replacement.predecessor;
  if (!pred || pred.predecessorTransitionId !== c.transitionId
    || pred.predecessorEpoch !== c.confirmationEpoch
    || pred.predecessorFingerprint !== c.confirmedFingerprint) {
    return { ok: false, reason: "predecessor-mismatch", detail:
      "the replacement's predecessor triple must name the canonical intent it retires, exactly" };
  }
  if (replacement.confirmationEpoch <= c.confirmationEpoch) {
    return { ok: false, reason: "epoch-not-monotonic", detail:
      `confirmationEpoch ${replacement.confirmationEpoch} does not exceed the canonical ${c.confirmationEpoch}` };
  }
  if (replacement.phase !== "authorized") {
    return { ok: false, reason: "edge-refused", detail: "a superseding intent starts over at authorized" };
  }

  // ARCHIVE FIRST. The archive carries the canonical bytes verbatim, at a name
  // keyed by (transitionId, epoch), which the monotonic epoch makes unique per
  // confirmation.
  const archive = archivePathFor(sessionDir, c.transitionId, c.confirmationEpoch);
  try {
    createExclusiveDurable(sessionDir, archive, current.raw, "supersede:archive");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let archived: string;
    try {
      archived = readFileSync(archive, "utf-8");
    } catch (readErr) {
      return { ok: false, reason: "archive-conflict", detail:
        `an archive already exists at ${archive} and could not be read (${(readErr as NodeJS.ErrnoException).code})` };
    }
    if (archived.length === 0) {
      // NOT EVIDENCE. The current writer cannot produce this -- `link`
      // publishes the archive name only once the bytes are durable -- but the
      // name is keyed by the retired intent's transitionId and epoch, neither
      // of which ever changes while supersession keeps failing, so anything
      // that ever left an empty file there (a predecessor build, an
      // interrupted copy, an operator) would wedge this cycle forever. Under
      // the held session lock an empty archive can be no one's evidence,
      // since every writer that completes leaves bytes. Retryable, not
      // terminal.
      unlinkSync(archive);
      createExclusiveDurable(sessionDir, archive, current.raw, "supersede:archive");
    } else if (archived !== current.raw) {
      return { ok: false, reason: "archive-conflict", detail:
        "an archive already exists at the expected name with DIFFERENT content; that is someone else's evidence" };
    }
    // Our own half-done supersession: the archive is exactly the canonical
    // bytes, so continue to the replacement.
  }
  fsyncPath(sessionDir);
  __intentTesting.at("supersede:dir-fsynced-after-archive");

  replaceDurable(sessionDir, serialize(replacement), "supersede");
  return { ok: true, intent: replacement };
}

/**
 * Adoption (the R2 rule's other half): after a pre-write-1 revision move with
 * ticket work already durable, re-authorization keeps the SAME transitionId
 * and phase and re-mints ONLY the confirmation pair and its evidence, with the
 * epoch bumped so the two confirmations remain distinguishable on the record.
 * The ticket mutation is never touched from here: adoption verifies elsewhere,
 * it does not redo.
 */
export function readoptCancellationIntent(
  sessionDir: string,
  adoption: {
    readonly transitionId: string;
    readonly confirmationEpoch: number;
    readonly confirmedSessionRevision: number;
    readonly confirmedFingerprint: string;
    readonly evidence: PersistedLivenessEvidence;
  },
): IntentWrite {
  const current = readCancellationIntent(sessionDir);
  if (current.kind === "absent") {
    return { ok: false, reason: "not-found", detail: "no intent exists to adopt" };
  }
  if (current.kind === "unreadable" || current.kind === "malformed") {
    return { ok: false, reason: current.kind, detail: current.detail };
  }
  const c = current.intent;
  if (adoption.transitionId !== c.transitionId) {
    return { ok: false, reason: "identity-mismatch", detail:
      `adoption re-mints confirmation for the canonical transition ${c.transitionId}, not ${adoption.transitionId}` };
  }

  // THE PHASE GATE RUNS FIRST, ahead of the already-adopted short-circuit
  // below. Ordering them the other way lets a request that happens to carry
  // the canonical confirmation return `ok` from a phase where adoption is
  // forbidden -- reporting "adopted" for a `authorized` intent whose correct
  // answer is "that is supersession's territory", and for a `closed` one
  // whose correct answer is retirement. The short-circuit may only ever say
  // "this adoption is already applied"; it may not say "adoption applies".
  if (c.phase !== "ticket_applied" && c.phase !== "claim_cleared") {
    return { ok: false, reason: "no-ticket-work", detail: c.phase === "closed"
      // Stated correctly: at `closed` the work is not before-begun, it is
      // FINISHED, and supersession does not handle it either (it refuses
      // ticket-work-begun). Retirement is the only route out.
      ? "the canonical intent is closed, so its cycle is finished; a new cycle requires retirement, not adoption"
      : `the canonical intent is at ${c.phase}; before ticket work exists, re-authorization supersedes rather than adopts` };
  }
  // ALREADY-ADOPTED SHORT-CIRCUIT, the mirror of supersession's. A crash at
  // `adopt:renamed` leaves the adoption durably applied; without this, the
  // verbatim retry every caller is supposed to make would be refused as
  // non-monotonic, and the caller could not tell "already done" from "stale
  // re-authorization" -- the two states that must never be confused.
  //
  // The EVIDENCE is compared along with the confirmation triple, not just the
  // three scalars. Adoption re-mints the evidence too, so a request matching
  // on the triple while carrying different evidence is asking for a record
  // this function has NOT produced; returning success would claim a durable
  // state that does not exist. It falls through to the monotonicity refusal
  // below, which is the right answer: re-minting evidence needs a new epoch.
  // The RECEIPT is what makes this a retry check rather than a coincidence
  // check. `adoptedFromEpoch` exists only on a record an adoption produced, so
  // an intent that was created and advanced -- never adopted -- cannot match
  // here however exactly the request happens to equal it. Without it, a FIRST
  // adoption request carrying the canonical epoch returned success while
  // writing nothing, collapsing two distinct re-authorizations onto one epoch;
  // equality with the current state proves the post-state exists, never that
  // this operation produced it.
  if (c.adoptedFromEpoch !== undefined
    && c.confirmationEpoch === adoption.confirmationEpoch
    && c.confirmedSessionRevision === adoption.confirmedSessionRevision
    && c.confirmedFingerprint === adoption.confirmedFingerprint
    && deepEquals(c.evidence, adoption.evidence)) {
    return { ok: true, intent: c };
  }

  if (adoption.confirmationEpoch <= c.confirmationEpoch) {
    return { ok: false, reason: "epoch-not-monotonic", detail:
      `confirmationEpoch ${adoption.confirmationEpoch} does not exceed the canonical ${c.confirmationEpoch}` };
  }
  const next: CancellationIntent = {
    ...c,
    confirmationEpoch: adoption.confirmationEpoch,
    confirmedSessionRevision: adoption.confirmedSessionRevision,
    confirmedFingerprint: adoption.confirmedFingerprint,
    evidence: adoption.evidence,
    adoptedFromEpoch: c.confirmationEpoch,
  };
  const unwritable = refuseUnwritableRecord(next, "the adopted intent");
  if (unwritable) return unwritable;

  replaceDurable(sessionDir, serialize(next), "adopt");
  return { ok: true, intent: next };
}

/**
 * RETIREMENT: the way out of `closed`, so a session can go through the cycle
 * more than once (T-450 step 6b, pen ruling M-C).
 *
 * Without it, one successful takeover forecloses this ticket's OWN scenario
 * for that session permanently: create refuses EEXIST forever, supersession
 * refuses because ticket work exists, adoption refuses because the cycle is
 * finished, no edge leaves `closed`, and a later incarnation classifies the
 * intent foreign. Nothing ever ruled the feature one-cycle-per-session.
 *
 * The permission is DERIVABILITY, and nothing weaker. A closed intent may be
 * retired only when the outcome it points at is confirmed in the durable
 * record it names: a cancellation must find that transition published in the
 * session state, published as a candidate cancellation for this very session
 * and this very transition. That is what makes discarding the intent safe --
 * the fact it recorded is recoverable without it. An unproven closed intent
 * is the one thing that must not be retired, because then the intent IS the
 * only record.
 *
 * A closed TAKEOVER is therefore not retirable yet, and refuses. Its
 * `committedRevision` is a precondition, never a proof: a revision counter
 * advances for any write for any reason, so it cannot establish that this
 * takeover was committed. The proof is an identity-bearing durable postimage
 * naming this intent, which the commit path that writes takeovers owns and
 * which does not exist yet. Refusing costs nothing while no takeover has ever
 * been committed, and refusing never discards a record.
 *
 * The shape is supersession's, for the same reason: archive first, replace
 * second, canonical pathname never freed.
 */
export function retireClosedIntent(
  sessionDir: string,
  replacement: CancellationIntent,
  durable: {
    /** The session's `cancellationTransition` as persisted, unparsed. */
    readonly cancellationTransition: unknown;
    readonly sessionRevision: number;
  },
): IntentWrite {
  const current = readCancellationIntent(sessionDir);
  if (current.kind === "absent") {
    return { ok: false, reason: "nothing-to-supersede", detail:
      "no canonical intent exists; absence is permission to create, not to retire" };
  }
  if (current.kind === "unreadable" || current.kind === "malformed") {
    return { ok: false, reason: current.kind, detail: current.detail };
  }
  const c = current.intent;

  const retireForged = refuseCallerSuppliedReceipt(replacement, "the new cycle's intent");
  if (retireForged) return retireForged;
  const retireUnwritable = refuseUnwritableRecord(replacement, "the new cycle's intent");
  if (retireUnwritable) return retireUnwritable;

  // Crash-after-rename retry, the same two-part proof supersession carries
  // and for the same reasons: whole-record equality so no unwritten durable
  // fact is reported as written, and the archive so equality is not mistaken
  // for having caused it. Without the second half, handing this function the
  // live intent as its own replacement would return success before the
  // closed-phase gate and the derivability proof below ever ran.
  //
  // `c.phase !== "closed"` is the TOTAL closure of the self-spoof here, and
  // costs one condition. Retirement requires `replacement.phase ===
  // "authorized"` before it renames anything, so a genuine crash-after-rename
  // retry always finds the canonical at the replacement -- authorized, or
  // later if the new cycle has advanced -- and never closed. A spoof hands
  // back the CLOSED intent itself, whose canonical is closed by definition,
  // so it falls through to the guards. The one case this refuses that a
  // laxer check would accept, a stale retry arriving after the new cycle has
  // itself closed, fails closed at predecessor-mismatch, which is correct.
  //
  // The same contract as supersession's applies: `ok: true` says the
  // canonical record IS this intent, not that a retirement occurred here.
  if (deepEquals(c, replacement) && c.phase !== "closed"
    && priorCycleIsArchived(sessionDir, replacement)) {
    return { ok: true, intent: c };
  }

  if (c.phase !== "closed") {
    return { ok: false, reason: "not-closed", detail:
      `retirement applies only to a closed intent; this one is at ${c.phase}` };
  }

  // THE DERIVABILITY PROOF. Retirement discards the intent, so the fact the
  // intent recorded has to be readable WITHOUT it, and the proof has to be
  // about THIS intent's outcome rather than about some valid outcome.
  if (c.outcome.kind === "cancellation") {
    // The intent authorizes exactly one transition and carries its id, so an
    // outcome pointing anywhere else is a record that contradicts itself; it
    // is refused rather than proved, because a pointer at somebody else's
    // published cancellation would otherwise satisfy the check below.
    if (c.outcome.transitionId !== c.transitionId) {
      return { ok: false, reason: "outcome-underivable", detail:
        `the closed intent carries transitionId ${c.transitionId} but names cancellation ` +
        `${c.outcome.transitionId} as its outcome; an intent cannot be retired on another transition's record` };
    }
    const read = readCancellationTransition(durable.cancellationTransition);
    // SESSION PROVENANCE IS PART OF THE PROOF, not decoration. A transition
    // record is a file an operator can edit and a copy can be transplanted
    // between session directories, so matching the id alone would let one
    // session's published cancellation authorize discarding another's only
    // record. `sessionId` is the binding; `sessionStartedAt` is provenance
    // checked in addition to it, never instead of it.
    if (read.kind !== "valid" || read.transition.phase !== "published"
      || read.transition.transitionId !== c.outcome.transitionId
      || read.transition.sessionId !== c.sessionId
      || read.transition.sessionStartedAt !== c.sessionStartedAt) {
      return { ok: false, reason: "outcome-underivable", detail:
        `the closed intent points at cancellation ${c.outcome.transitionId}, and the session state does not ` +
        "carry that transition as published for this session; retiring it would discard the only record " +
        "of the outcome" };
    }
    // THE RECORD MUST BE THE RIGHT KIND OF RECORD. A candidate intent
    // authorizes a candidate cancellation, so an ordinary one published in the
    // same session under legacy or task authority proves something else
    // happened, not that this happened. Matching only the id and provenance
    // let an unrelated cancellation stand in as proof.
    if (read.transition.action !== "candidate_recovery_takeover"
      || read.transition.authority.kind !== "candidate"
      || read.transition.authority.clientTaskId !== c.clientTaskId) {
      return { ok: false, reason: "outcome-underivable", detail:
        "the published transition is not the candidate cancellation this intent authorized: a candidate " +
        "intent is proved by a candidate_recovery_takeover held by the same client task, not by any " +
        "cancellation that happens to share the id" };
    }
    // The CONFIRMATION PAIR is deliberately NOT compared. The transition
    // carries the pair as it stood at write 1; adoption may legitimately have
    // re-minted the intent's pair afterwards under the R2 rule, so requiring
    // equality would refuse exactly the histories this ticket exists to
    // support. `clientTaskId` is the stable identity across those re-mints.
    //
    // PUBLICATION IS NOT DURABILITY. `terminalRevision` is the revision the
    // publishing write produces, so a state that has not reached it is a state
    // where the record read here is ahead of what survived; retiring on it
    // would discard the intent against a fact not yet durable.
    if (durable.sessionRevision < read.transition.terminalRevision) {
      return { ok: false, reason: "outcome-underivable", detail:
        `the published cancellation terminates at revision ${read.transition.terminalRevision} and the ` +
        `session is at ${durable.sessionRevision}; the outcome is not durable yet` };
    }
  } else {
    // THE TAKEOVER ARM IS DELIBERATELY UNPROVABLE HERE, so it refuses.
    //
    // A revision counter is not evidence. `sessionRevision >= committedRevision`
    // is satisfied by ANY later write for any reason, so it would let a
    // schema-valid closed intent be retired -- discarding the only record
    // naming the takeover -- on the strength of an unrelated state write. The
    // check is kept as a precondition, and failing it is reported first
    // because it is the cheaper and more specific answer, but passing it is
    // explicitly NOT treated as proof.
    //
    // The real proof is an identity: the durable takeover postimage
    // (`owner_gone_candidate_takeover` plus its CandidateRecoveryEvidence)
    // naming this intent's transitionId. That postimage is written by the
    // consumer functions, which do not exist yet, and inventing its shape
    // here would mean this module deciding a record another one owns. Until
    // it lands, refusing is correct and costs nothing real: no takeover has
    // ever been committed, so no closed takeover intent exists to retire.
    if (durable.sessionRevision < c.outcome.committedRevision) {
      return { ok: false, reason: "outcome-underivable", detail:
        `the closed intent points at a takeover committed at revision ${c.outcome.committedRevision}, and the ` +
        `session is at ${durable.sessionRevision}; the outcome is not confirmed in durable state` };
    }
    return { ok: false, reason: "outcome-underivable", detail:
      "a closed takeover cannot yet be proved derivable: the revision counter alone does not establish that " +
      "this takeover was committed, and the durable takeover postimage that would is not written yet" };
  }

  if (replacement.confirmationEpoch <= c.confirmationEpoch) {
    return { ok: false, reason: "epoch-not-monotonic", detail:
      `confirmationEpoch ${replacement.confirmationEpoch} does not exceed the canonical ${c.confirmationEpoch}` };
  }
  if (replacement.phase !== "authorized") {
    return { ok: false, reason: "edge-refused", detail: "a retiring intent starts the new cycle at authorized" };
  }
  // Placed on the FULL path, deliberately BELOW the retry shortcut: a genuine
  // crash-after-rename retry finds the canonical already equal to the
  // replacement, so it "reuses" that id by construction and would be refused
  // here. Reuse is only a defect when a NEW cycle is being written.
  const retireReused = refuseReusedTransitionId(c, replacement);
  if (retireReused) return retireReused;

  const pred = replacement.predecessor;
  if (!pred || pred.predecessorTransitionId !== c.transitionId
    || pred.predecessorEpoch !== c.confirmationEpoch
    || pred.predecessorFingerprint !== c.confirmedFingerprint) {
    return { ok: false, reason: "predecessor-mismatch", detail:
      "the new cycle's intent must name the closed intent it retires, exactly" };
  }

  // ONE archive namespace, shared with supersession on purpose, even though
  // the name reads "superseded" for a record that was retired rather than
  // replaced mid-cycle. Both are the same fact to an auditor -- a prior intent
  // preserved verbatim -- and one glob keyed by (transitionId, epoch) finds
  // every one of them in order. A second naming scheme would split the audit
  // trail in half and give a reader two places to forget to look. Collision is
  // impossible for the same reason as supersession's: an intent is archived
  // once, under the identity it carried, and the epoch is monotonic within an
  // identity.
  const archive = archivePathFor(sessionDir, c.transitionId, c.confirmationEpoch);
  try {
    createExclusiveDurable(sessionDir, archive, current.raw, "retire:archive");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let archived: string;
    try {
      archived = readFileSync(archive, "utf-8");
    } catch (readErr) {
      return { ok: false, reason: "archive-conflict", detail:
        `an archive already exists at ${archive} and could not be read (${(readErr as NodeJS.ErrnoException).code})` };
    }
    if (archived.length === 0) {
      // Not evidence, for the reason spelled out at supersession's copy of
      // this branch: the name never changes, so an empty file there would
      // wedge the cycle permanently, and an empty file is no one's evidence.
      unlinkSync(archive);
      createExclusiveDurable(sessionDir, archive, current.raw, "retire:archive");
    } else if (archived !== current.raw) {
      return { ok: false, reason: "archive-conflict", detail:
        "an archive already exists at the expected name with DIFFERENT content; that is someone else's evidence" };
    }
  }
  fsyncPath(sessionDir);
  __intentTesting.at("retire:dir-fsynced-after-archive");

  replaceDurable(sessionDir, serialize(replacement), "retire");
  return { ok: true, intent: replacement };
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

/**
 * Everything the handshake reads from the world, injected so the eligibility
 * check can be staged (the fingerprint excludes time and policy by design, so
 * the only way to test "same signals, no longer eligible" is to move the
 * threshold through this seam). Production defaults are the real clock, the
 * real policy, and the caller's own state and registry readers.
 *
 * `readState` and `readSuccessors` are PROVIDERS, not snapshots, because
 * `readOwnerLiveness` re-reads both at its final gate: a precomputed set
 * cannot be re-read, so accepting one would make that gate theatre.
 */
export interface CandidateHandshakeDeps {
  readonly now?: () => number;
  readonly staleThresholdMs?: number;
  readonly readState: () => OwnableLivenessState;
  readonly readSuccessors: () => SuccessorServers;
  readonly loadTicket: (ticketId: string) => Promise<Ticket | null | undefined>;
  readonly claimStalenessHours?: number;
}

/** What the caller confirmed, and the session facts the checks are against. */
export interface CandidateHandshakeInput {
  readonly sessionId: string;
  readonly clientTaskId: string | undefined;
  /** The revision the human was shown, and the fingerprint of that picture. */
  readonly confirmedSessionRevision: number;
  readonly confirmedFingerprint: string;
  /** The session's revision RIGHT NOW, read under the held lock. */
  readonly sessionRevision: number;
  readonly ticket: { readonly id: string } | null;
  readonly claimEpoch: ClaimEpoch | null;
}

/**
 * What ticket work the commit owes, stated positively.
 *
 * The three arms are kept APART because they lead somewhere different, and an
 * earlier draft collapsed them all into a null preimage: `none` is a POSITIVE
 * finding that nothing is owed, while `blocked` means we could not determine
 * what is owed at all. Reporting the second as the first would let a transient
 * ledger read failure silently skip releasing a claim that still exists, which
 * is the ticket-side version of the fail-open this whole ticket exists to
 * remove. A cancellation may still proceed under `blocked` -- the session
 * needs ending either way -- but only down a path that RECORDS that the ticket
 * was left alone because it could not be read, never one that implies it was
 * checked and found unowned.
 */
export type CandidateTicketWork =
  | { readonly kind: "release"; readonly preimage: PersistedTicketSnapshot }
  | { readonly kind: "none"; readonly why: "no-ticket" | "claim-not-held"; readonly detail: string }
  | {
      readonly kind: "blocked";
      readonly why: "ticket-unreadable" | "unpersistable-preimage" | "claim-context-mismatch";
      readonly detail: string;
    };

export type CandidateAuthorization =
  | {
      readonly kind: "authorized";
      readonly authority: Extract<CancellationAuthority, { kind: "candidate" }>;
      readonly ticketWork: CandidateTicketWork;
      readonly claimReconciliation: ClaimReconciliation["status"] | "not-checked";
    }
  | {
      /** The picture moved. Carries FRESH evidence so the caller re-presents
       * rather than starting over blind. */
      readonly kind: "re-confirm";
      readonly reason: "fingerprint-changed" | "revision-moved";
      readonly detail: string;
      readonly fresh: { readonly evidence: PersistedLivenessEvidence; readonly fingerprint: string };
    }
  | { readonly kind: "ineligible"; readonly verdict: string; readonly detail: string }
  | {
      readonly kind: "refused";
      readonly reason: "no-caller-identity" | "caller-is-owner" | "unpersistable-evidence" | "session-mismatch";
      readonly detail: string;
    };

/**
 * The persisted projection of the signals, through the shipped schema rather
 * than a hand-written mapping. The persisted sub-schemas mirror the in-memory
 * unions exactly, so this is a VALIDATION: if a signal shape ever drifts from
 * what the record can carry, this refuses instead of writing a lossy record
 * that a future reader would reject.
 */
function persistEvidence(signals: OwnerLivenessSignals): PersistedLivenessEvidence | null {
  const parsed = PersistedLivenessEvidenceSchema.safeParse(signals);
  return parsed.success ? parsed.data : null;
}

/**
 * THE FIVE-STEP HANDSHAKE (T-450 step 6b), the gate between "a human was shown
 * an owner-gone offer" and "a takeover or cancellation may be committed".
 *
 * MUTATES NOTHING, deliberately. The candidate invariant leans on
 * re-authorization being cheap: when anything moves the session revision
 * before write 1, the answer is to run this again against the moved state,
 * not to work around the check. A handshake with side effects could not be
 * re-run that way. Writing the durable intent is the caller's step, so that
 * supersede-versus-adopt is decided with the fresh authorization in hand.
 *
 * ORDER IS LOAD-BEARING. Identity is settled first because a caller who
 * cannot hold candidate authority should never cause a probe; then check 1
 * (did the picture change), then check 2 (is it still eligible now), then the
 * claim. Check 1 before check 2 means a caller confirming a stale picture is
 * told to re-confirm rather than being told about an eligibility verdict for a
 * picture it was never shown.
 */
export async function authorizeCandidateRecovery(
  sessionDir: string,
  input: CandidateHandshakeInput,
  deps: CandidateHandshakeDeps,
): Promise<CandidateAuthorization> {
  const now = (deps.now ?? Date.now)();
  const staleThresholdMs = deps.staleThresholdMs ?? OWNER_STALE_MS;

  // STEP 3, hoisted: candidate authority is task-bound, so a caller with no
  // identity can never hold it, and the recorded OWNER taking over from
  // itself is an ordinary resume rather than an owner-gone recovery. Both are
  // settled before anything is probed.
  if (!input.clientTaskId) {
    return { kind: "refused", reason: "no-caller-identity", detail:
      "candidate authority names the task that holds it; a caller with no task identity cannot be recorded" };
  }

  // THE AUTHORIZATION IS BOUND TO THE SESSION IT PROBED. Every signal below
  // comes from `sessionDir`, so an authorization naming a different session
  // would carry evidence about one session as authority over another. The
  // directory's own name is the binding: `sessionDir(root, sessionId)` is
  // `<root>/.story/sessions/<sessionId>` by construction (session.ts:52), so
  // its basename IS the identity of everything read out of it, and comparing
  // against the caller's claim is the check that they are the same session.
  const probedSessionId = basename(sessionDir);
  if (probedSessionId !== input.sessionId) {
    return { kind: "refused", reason: "session-mismatch", detail:
      `the evidence directory belongs to session ${probedSessionId}, and this authorization names ` +
      `${input.sessionId}; evidence about one session cannot authorize action on another` };
  }
  const recordedOwner = deps.readState().ownerTask;
  if (recordedOwner && recordedOwner.id === input.clientTaskId) {
    return { kind: "refused", reason: "caller-is-owner", detail:
      "this caller IS the recorded owner, so the ordinary resume applies; owner-gone recovery is for another task" };
  }

  const verdict = readOwnerLiveness(sessionDir, deps.readState, now, staleThresholdMs, deps.readSuccessors);
  const evidence = persistEvidence(verdict.signals);
  if (!evidence) {
    return { kind: "refused", reason: "unpersistable-evidence", detail:
      "the observed signals do not fit the persisted evidence schema, so no auditable authorization can be written" };
  }
  const fingerprint = evidenceFingerprint(verdict.signals);

  // CHECK 1, did the picture change. Time-independent BY DESIGN, which is
  // exactly why it cannot answer check 2's question.
  if (fingerprint !== input.confirmedFingerprint) {
    return { kind: "re-confirm", reason: "fingerprint-changed", detail:
      "the evidence changed between being shown and being confirmed", fresh: { evidence, fingerprint } };
  }
  if (input.sessionRevision !== input.confirmedSessionRevision) {
    return { kind: "re-confirm", reason: "revision-moved", detail:
      `the session was at revision ${input.confirmedSessionRevision} when confirmed and is at ` +
      `${input.sessionRevision} now`, fresh: { evidence, fingerprint } };
  }

  // CHECK 2, still eligible NOW. The gate is `permitsRecoveryOffer` and
  // nothing else (B-3): `active` refutes, and `contradicted` / `undetermined`
  // are evidence that disagrees or evidence we could not confirm, neither of
  // which may authorize.
  if (!permitsRecoveryOffer(verdict)) {
    // The DECISION above is the predicate and nothing else (B-3). This switch
    // only chooses the sentence the operator is owed, which differs per arm;
    // `gone-candidate` is unreachable here and says so rather than falling
    // through to a wrong explanation.
    let detail: string;
    switch (verdict.kind) {
      case "active":
        detail = "the owner acted recently, so it is no longer a recovery candidate";
        break;
      case "contradicted":
        detail = `the evidence contradicts itself: ${verdict.why}`;
        break;
      case "undetermined":
        detail = `the evidence could not be confirmed: ${verdict.missing.join("; ")}`;
        break;
      case "gone-candidate":
        detail = "internal: the offer predicate refused a gone-candidate verdict";
        break;
    }
    return { kind: "ineligible", verdict: verdict.kind, detail };
  }

  // STEP 4, claim reconciliation, and STEP 5, the preimage. A claim this
  // session can no longer prove does NOT block the recovery: the session still
  // needs ending. What it blocks is the ticket WRITE. The three outcomes are
  // reported apart (see CandidateTicketWork) so a commit can never mistake
  // "we looked and nothing is owed" for "we could not look".
  let reconciliation: ClaimReconciliation["status"] | "not-checked" = "not-checked";
  const epoch = input.claimEpoch;

  // EVERY COMBINATION IS NAMED. The default used to be `no-ticket`, which
  // positively asserts that nothing is owed, and it was reached by any input
  // whose ticket and epoch disagreed -- so a contradictory claim context read
  // as a clean bill of health. The four cases are now distinct:
  //   neither          -> nothing owed, positively (no-ticket)
  //   ticket, no epoch -> nothing MAY be written: with no epoch this session
  //                       never gained the ability to prove ownership, which
  //                       is a positive finding about what we may do
  //   epoch, no ticket -> contradictory; the session claims a ticket it is
  //                       not on. We cannot say what is owed (blocked)
  //   both, ids differ -> the same contradiction, louder (blocked)
  let ticketWork: CandidateTicketWork =
    !epoch && !input.ticket
      ? { kind: "none", why: "no-ticket", detail:
          "this session holds no ticket and recorded no claim epoch, so no ticket work is owed" }
      : !epoch
        ? { kind: "none", why: "claim-not-held", detail:
            `this session is on ticket ${input.ticket!.id} but recorded no claim epoch, so it cannot prove ` +
            "ownership and no release may be written for it" }
        : { kind: "blocked", why: "claim-context-mismatch", detail:
            `the recorded claim epoch names ticket ${epoch.ticketId} while the session is on ` +
            `${input.ticket ? input.ticket.id : "no ticket"}; the claim context contradicts itself, so what ` +
            "is owed cannot be determined" };

  if (epoch && input.ticket && input.ticket.id === epoch.ticketId) {
    let ticket: Ticket | null | undefined;
    let unreadable: string | null = null;
    try {
      ticket = await deps.loadTicket(epoch.ticketId);
    } catch (err) {
      unreadable = err instanceof Error ? err.message : "unknown error";
      ticket = null;
    }
    const claimState = readTicketClaimState(ticket);
    reconciliation = reconcileClaim({
      epoch,
      ticket: claimState,
      claimStalenessHours: deps.claimStalenessHours ?? 24,
      now,
    }).status;

    if (unreadable !== null || !ticket) {
      // UNREADABLE is not "not held". `reconcileClaim` already fails closed
      // to `recovery-required` here, and this arm keeps that failure legible
      // to the commit instead of flattening it into an absence.
      ticketWork = { kind: "blocked", why: "ticket-unreadable", detail:
        `the ticket ${epoch.ticketId} could not be read from the ledger` +
        (unreadable === null ? "" : ` (${unreadable})`) };
    } else if (reconciliation !== "held") {
      ticketWork = { kind: "none", why: "claim-not-held", detail:
        `the claim on ${epoch.ticketId} reconciled as ${reconciliation}, so this session cannot prove it ` +
        "holds the ticket and no release may be written for it" };
    } else {
      const snapshot = PersistedTicketSnapshotSchema.safeParse({
        ticketId: epoch.ticketId,
        lifecycle: fieldOf(ticket, "lifecycle"),
        status: fieldOf(ticket, "status"),
        completedDate: fieldOf(ticket, "completedDate"),
        claim: claimState.claim,
        claimedBySession: claimState.claimedBySession,
      });
      ticketWork = snapshot.success
        ? { kind: "release", preimage: snapshot.data }
        // The claim IS held, so work is owed; we simply cannot record the
        // preimage the recovery table needs. Saying so is the only honest
        // move: a null here would read as "nothing owed".
        : { kind: "blocked", why: "unpersistable-preimage", detail:
            `the ticket ${epoch.ticketId} is still claimed by this session, but its preimage does not fit ` +
            "the persisted snapshot schema, so no deterministic release could be reconstructed" };
    }
  }

  return {
    kind: "authorized",
    authority: {
      kind: "candidate",
      clientTaskId: input.clientTaskId,
      confirmedSessionRevision: input.confirmedSessionRevision,
      confirmedFingerprint: input.confirmedFingerprint,
      evidence,
    },
    ticketWork,
    claimReconciliation: reconciliation,
  };
}

/** Presence-preserving read of one ticket field, the same shape
 * `readTicketClaimState` produces for the two ownership fields. */
function fieldOf(ticket: object, key: string): { present: boolean; value: string | null } {
  if (!(key in ticket)) return { present: false, value: null };
  const value = (ticket as Record<string, unknown>)[key];
  return { present: true, value: typeof value === "string" ? value : null };
}
