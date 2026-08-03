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
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  CANCELLATION_INTENT_FILE,
  CancellationIntentSchema,
  PersistedLivenessEvidenceSchema,
  PersistedTicketSnapshotSchema,
  type CancellationAuthority,
  type CancellationIntent,
  type CancellationTransition,
  type FullSessionState,
  type PersistedLivenessEvidence,
  type PersistedTicketSnapshot,
  CandidateRecoveryEvidenceSchema,
  CandidateTakeoverPostimageSchema,
  type CandidateTakeoverPostimage,
} from "./session-types.js";
import {
  evidenceFingerprint,
  permitsRecoveryOffer,
  readOwnerLiveness,
  stageHeartbeatGeneration,
  discardStagedGeneration,
  validateStagedGeneration,
  OWNER_STALE_MS,
  type OwnableLivenessState,
  type OwnerLivenessSignals,
  type StagedHeartbeatGeneration,
  type StagedGenerationValidation,
} from "./liveness.js";
import type { SuccessorServers } from "./mcp-registry.js";
import { parseClaimEpoch } from "./claim-preflight.js";
import {
  authorityLedgerTargets,
  decideTakeoverAuthority,
  type LedgerRead,
  type IssueAuthorityView,
  type TakeoverAuthority,
} from "./candidate-authority.js";
import {
  reconcileClaim,
  recoverClaimTransaction,
  type ClaimEpoch,
  type ClaimReconciliation,
  type ClaimTxn,
  type TicketSnapshot,
} from "./claim-reconciliation.js";
import { readTicketClaimState } from "./claim-preflight.js";
import type { Ticket } from "../models/ticket.js";
import type { OwnerTask } from "./client-profile.js";
import {
  applyCancellationTransition,
  canonicalStartedAt,
  classifyTailRecovery,
  runCancellationTail,
  transitionBelongsTo,
  type TailOutcome,
} from "./cancellation-core.js";
import { readCancellationTransition, type TicketDisposition } from "./cancellation-transition.js";
import { readSession, withSessionLock, StateWriteUndurableError } from "./session.js";
import { writeSessionAndRefresh } from "./guide-effects.js";

/** Crash-injection seam. Production is a no-op; the intent suite replaces it
 * to throw after a named filesystem operation. Same shape as liveness's
 * `__testing` hooks: module-private effects, test-visible seams. */
export const __intentTesting = {
  at: (_point: string): void => undefined,
  /**
   * Temp-name components, injectable for the same reason the crash seams are.
   *
   * The claim loop's failure arms are unreachable from on-disk fixtures: the
   * name carries 32 bits of seeded entropy plus the pid, so no test can force
   * a collision, let alone the 32 consecutive ones that reach the exhaustion
   * wrap. Without this the `wx` exclusivity, the retry, and the wrap are three
   * guards no test can distinguish from their own absence -- which is a
   * coverage gap dressed as a passing suite. Returning a CONSTANT name makes
   * every attempt collide deterministically.
   */
  tempSuffix: null as null | ((attempt: number) => string),
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
 * Per-attempt temp names. The counter is seeded with process entropy so two
 * processes that share a pid across a restart do not march through the same
 * sequence and turn every collision into a retry storm.
 */
let tempCounter = randomBytes(4).readUInt32BE(0);

/** Matches `<target>.creating.<pid>.<counter>` and `<target>.tmp.<pid>.<counter>`. */
const TEMP_NAME = /\.(?:creating|tmp)\.(\d+)\.[0-9a-z]+$/;
const MAX_TEMP_ATTEMPTS = 32;

/**
 * Delete temps whose owner is PROVEN gone, and nothing else.
 *
 * ESRCH is the only proof of death. EPERM, and every other probe error, means
 * a process exists that we may not signal, so the temp is KEPT: deleting a
 * live attempt's name is exactly the theft this sweep exists downstream of.
 * Sweep failures are ignored and no caller's correctness depends on it
 * running, which is what lets it be this conservative.
 *
 * Legacy bare `.creating` / `.tmp` names are deliberately NOT swept. They
 * carry no pid, so nothing about them can be proven, and removing one could
 * pull the name out from under a writer running older bytes.
 */
function sweepOrphanTemps(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = TEMP_NAME.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // alive
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue; // unprovable, keep
    }
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Cosmetic only. Never a correctness path.
    }
  }
}

/**
 * Claim a fresh temp beside `target`, opened `wx` so the name is ours alone.
 *
 * EEXIST HERE IS A NAME COLLISION, NOT THE PROTOCOL'S ANSWER, and confusing
 * the two would be a reporting bug with teeth: `createCancellationIntent`
 * reads EEXIST as "a canonical intent already exists" and the archive writers
 * read it as `archive-conflict`, so a temp collision reaching either
 * classifier would report an existing record at a pathname that is ABSENT.
 * Collisions therefore retry on a new counter, and exhaustion throws a wrapped
 * error carrying no `code`, which cannot satisfy any `code === "EEXIST"` test
 * downstream.
 */
function openFreshTemp(sessionDir: string, target: string, kind: "creating" | "tmp"): { fd: number; tmp: string } {
  sweepOrphanTemps(sessionDir);
  let last: unknown;
  for (let i = 0; i < MAX_TEMP_ATTEMPTS; i++) {
    const suffix = __intentTesting.tempSuffix
      ? __intentTesting.tempSuffix(i)
      : `${process.pid}.${(tempCounter++ >>> 0).toString(36)}`;
    const tmp = `${target}.${kind}.${suffix}`;
    try {
      return { fd: openSync(tmp, "wx"), tmp };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      last = err;
    }
  }
  throw new Error(
    `could not claim a temporary file beside ${target} after ${MAX_TEMP_ATTEMPTS} attempts; ` +
    "this is a temp-name collision, NOT an existing record at the target",
    { cause: last },
  );
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
 * The temp name is UNIQUE PER ATTEMPT, and derived from the TARGET rather
 * than always from the canonical intent. Both properties are corrections
 * (ISS-954). A single deterministic name shared by every writer in the
 * directory is stealable: `link` and `rename` resolve that name a SECOND
 * time, after the bytes are already written through a descriptor, so a
 * concurrent process that replaces the name in between makes this writer
 * publish the OTHER attempt's inode under this attempt's pathname. If that
 * attempt completed, the pathname holds well-formed bytes belonging to
 * another cycle, which parse and so are never flagged; if it crashed
 * mid-write, the pathname is empty or partial, which is the zero-length wedge
 * build-then-claim exists to remove, and this time nothing can clear it.
 *
 * The lock narrows that window and does not close it. Every writer here
 * requires the held session lock, but stale-lock breakage hands the lock to a
 * second process BY DESIGN, and a zombie writer that has lost the lock still
 * holds an open descriptor and still completes its publish. This ticket
 * exists precisely to let a second process act on a session whose owner is
 * believed dead, so those are the central paths, not exotic ones.
 *
 * Uniqueness makes the name unstealable; `wx` makes the claim on it
 * exclusive. The cost is litter, because a name no other attempt may reuse is
 * also a name no other attempt may blindly clean up: anti-litter and
 * anti-theft cannot both be bought with one deterministic name. Litter is
 * reclaimed by a sweep that deletes only temps whose owning pid is PROVEN
 * gone, since a cosmetic leak is cheaper than deleting a live attempt's name
 * and reopening this entire class.
 */
function createExclusiveDurable(sessionDir: string, path: string, text: string, prefix: string): void {
  const { fd, tmp } = openFreshTemp(sessionDir, path, "creating");
  try {
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
  } finally {
    // IN A FINALLY, so no exit leaves our name behind. The unique name means
    // this unlink can only ever remove OUR attempt, which is what makes doing
    // it unconditionally safe -- under the old shared name the same line would
    // have been the theft. On the success path the record is already durable
    // under its real name, so losing the machine here costs a stale temp and
    // nothing else; on a failure path it keeps litter proportional to crashes
    // rather than to attempts.
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone, or unremovable. The sweep is the backstop.
    }
  }
  __intentTesting.at(`${prefix}:tmp-removed`);
}

/** Atomic replace: fsync'd temp, rename over the canonical name, directory
 * fsync. The canonical pathname is never absent at any instant. */
function replaceDurable(sessionDir: string, text: string, pointPrefix: string): void {
  const target = intentPath(sessionDir);
  // Same per-attempt uniqueness as the link writer, and for the same reason:
  // `renameSync` resolves this name a second time after the bytes are written
  // through the descriptor, so a shared name lets a concurrent attempt's inode
  // be published over the canonical record (ISS-954).
  const { fd, tmp } = openFreshTemp(sessionDir, target, "tmp");
  let renamed = false;
  try {
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
    renameSync(tmp, target);
    // Set only after the rename returns: the rename CONSUMES the temp name, so
    // unlinking afterwards would either fail or, if some other attempt had
    // since claimed the name, remove a file that is not ours.
    renamed = true;
    __intentTesting.at(`${pointPrefix}:renamed`);
    fsyncPath(sessionDir);
    __intentTesting.at(`${pointPrefix}:dir-fsynced`);
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // Already gone, or unremovable. The sweep is the backstop.
      }
    }
  }
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
      | "nonce-not-writable"
      | "takeover-postimage-unreadable"
      | "takeover-postimage-conflict"
      | "not-committed"
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

/**
 * What a caller may hand a NEW-CYCLE writer: everything except the cycle's
 * own identity. Distributive on purpose, since a plain Omit over the
 * discriminated union would collapse the phase arms.
 *
 * The nonce is minted INSIDE create, supersession and retirement (the three
 * writers that birth a cycle; retirement births cycle N+1) and nowhere else.
 * The type makes fabrication unnecessary; `refuseCallerSuppliedNonce` makes
 * it refused, because the type system does not survive JSON.parse.
 */
export type NewCycleIntent = CancellationIntent extends infer T
  ? T extends CancellationIntent ? Omit<T, "cycleNonce"> : never
  : never;

/**
 * LOAD-BEARING, not hygiene, and deliberately BELOW the retry shortcuts,
 * exactly where `refuseReusedTransitionId` sits and for the same reason.
 * Without this gate a doctored COPY of an archived record, carrying the old
 * cycle's nonce, passes every supersession gate; the postimage field still
 * matching that copied nonce would then let a close succeed with no commit
 * ever having run, and retirement would wrongfully derive. Any replayed
 * on-disk record necessarily carries a nonce, so this also closes the
 * documented authorized-phase self-spoof residual.
 */
function refuseCallerSuppliedNonce(record: NewCycleIntent, what: string): IntentWrite | null {
  if (!("cycleNonce" in (record as Record<string, unknown>))) return null;
  return { ok: false, reason: "nonce-not-writable", detail:
    `${what} carries a cycleNonce, which only the writer that births a cycle may mint; a caller-supplied ` +
    "nonce is how a copied record impersonates a cycle it did not begin" };
}

/** The one place a cycle's identity comes from. Minted BEFORE the
 * `refuseUnwritableRecord` parse, or a required schema field would deadlock
 * every writer. */
function mintCycle(record: NewCycleIntent): CancellationIntent {
  return { ...(record as Record<string, unknown>), cycleNonce: randomUUID() } as unknown as CancellationIntent;
}

/** Shortcut equality for crash-after-rename retries: the caller never learned
 * the nonce the crashed attempt minted, so the comparison EXCLUDES it; every
 * other byte must match. */
function equalsModuloNonce(canonical: CancellationIntent, replacement: NewCycleIntent): boolean {
  const { cycleNonce: _n, ...rest } = canonical as Record<string, unknown> & { cycleNonce: string };
  return deepEquals(rest, replacement);
}

/** The only way an intent comes into existence: exclusive create. A present
 * intent, whatever its state, routes through classification. Takes a
 * NONCE-LESS record and mints the cycle identity itself; the returned intent
 * carries the minted nonce, and a crash-after-create retry needs no byte
 * rule, because EEXIST resolves to "exists" and ownership classification
 * resumes the existing canonical, whose nonce was validly minted by the same
 * cycle's crashed attempt. */
export function createCancellationIntent(sessionDir: string, intent: NewCycleIntent): IntentWrite {
  const noncedByCaller = refuseCallerSuppliedNonce(intent, "the intent being created");
  if (noncedByCaller) return noncedByCaller;
  const minted = mintCycle(intent);
  const forged = refuseCallerSuppliedReceipt(minted, "the intent being created");
  if (forged) return forged;
  const unwritable = refuseUnwritableRecord(minted, "the intent being created");
  if (unwritable) return unwritable;
  try {
    createExclusiveDurable(sessionDir, intentPath(sessionDir), serialize(minted), "create");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, reason: "exists", detail: "an intent already exists at the canonical pathname" };
    }
    throw err;
  }
  return { ok: true, intent: minted };
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
export function supersedeCancellationIntent(sessionDir: string, replacement: NewCycleIntent): IntentWrite {
  const current = readCancellationIntent(sessionDir);
  if (current.kind === "absent") {
    return { ok: false, reason: "nothing-to-supersede", detail:
      "no canonical intent exists; absence is permission to create, not to supersede" };
  }
  if (current.kind === "unreadable" || current.kind === "malformed") {
    return { ok: false, reason: current.kind, detail: current.detail };
  }
  const c = current.intent;

  const supersedeForged = refuseCallerSuppliedReceipt(replacement as CancellationIntent, "the superseding intent");
  if (supersedeForged) return supersedeForged;

  // Crash-after-rename retry, under two requirements that answer two
  // different questions. `equalsModuloNonce` asks whether the canonical file
  // IS the postimage being requested -- the WHOLE record save the minted
  // nonce (the MODULO paragraph below says why), because a replacement
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
  // MODULO cycleNonce, and only that: the caller never learned the nonce a
  // crashed attempt minted, so requiring it would make every genuine retry
  // die at transition-id-reused, the exact already-done-versus-defect
  // confusion the contracts forbid. On match the CANONICAL is returned,
  // carrying its already-minted nonce.
  if (equalsModuloNonce(c, replacement) && replacement.phase === "authorized"
    && priorCycleIsArchived(sessionDir, replacement as CancellationIntent)) {
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
  const supersedeReused = refuseReusedTransitionId(c, replacement as CancellationIntent);
  if (supersedeReused) return supersedeReused;
  const supersedeNonced = refuseCallerSuppliedNonce(replacement, "the superseding intent");
  if (supersedeNonced) return supersedeNonced;

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

  // The new cycle's identity, minted here and nowhere the caller can reach,
  // BEFORE the unwritable parse (a required schema field would otherwise
  // refuse every legitimate replacement).
  const minted = mintCycle(replacement);
  const supersedeUnwritable = refuseUnwritableRecord(minted, "the superseding intent");
  if (supersedeUnwritable) return supersedeUnwritable;

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

  replaceDurable(sessionDir, serialize(minted), "supersede");
  return { ok: true, intent: minted };
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
 * A closed TAKEOVER derives from `state.candidateTakeover`, the postimage
 * `commitCandidateTakeover` writes atomically with the ownership fields it
 * proves (ruling ea611619 B10). Its `committedRevision` stays a precondition,
 * never a proof: a revision counter advances for any write for any reason.
 * The proof is the CYCLE NONCE, decisive on equality with the closed
 * intent's, corroborated by the intent's transitionId and clientTaskId; a
 * nonce match with contradicting corroboration is corruption and refuses.
 * The epoch is never compared (adoption is legal after the postimage) and
 * argvProof is never read (a degraded-unknown takeover retires on identical
 * proof to a proven one).
 *
 * The shape is supersession's, for the same reason: archive first, replace
 * second, canonical pathname never freed.
 */
export function retireClosedIntent(
  sessionDir: string,
  replacement: NewCycleIntent,
  durable: {
    /** The session's `cancellationTransition` as persisted, unparsed. */
    readonly cancellationTransition: unknown;
    /** The session's `candidateTakeover` as persisted, UNPARSED, read by the
     * caller under the held lock and passed as a VALUE, never a reader:
     * retirement discovers nothing itself, exactly as it does not for the
     * cancellation arm. Absent means the takeover arm is underivable. */
    readonly candidateTakeover: unknown;
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

  const retireForged = refuseCallerSuppliedReceipt(replacement as CancellationIntent, "the new cycle's intent");
  if (retireForged) return retireForged;

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
  // MODULO cycleNonce, same reasoning as supersession's shortcut: the caller
  // never learned the nonce the crashed attempt minted, and on match the
  // CANONICAL is returned carrying it.
  if (equalsModuloNonce(c, replacement) && c.phase !== "closed"
    && priorCycleIsArchived(sessionDir, replacement as CancellationIntent)) {
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
    // THE TAKEOVER ARM (ruling ea611619 B10). The proof is the durable
    // takeover postimage, matched on the CYCLE NONCE, which only the writer
    // that birthed this cycle could have minted and only
    // commitCandidateTakeover writes into state, atomically with the
    // ownership fields it proves.
    //
    // A revision counter is not evidence: `sessionRevision >= committedRevision`
    // is satisfied by ANY later write for any reason. The check is kept as a
    // PRECONDITION, reported first as the cheaper and more specific refusal,
    // and passing it is explicitly not treated as proof.
    if (durable.sessionRevision < c.outcome.committedRevision) {
      return { ok: false, reason: "outcome-underivable", detail:
        `the closed intent points at a takeover committed at revision ${c.outcome.committedRevision}, and the ` +
        `session is at ${durable.sessionRevision}; the outcome is not confirmed in durable state` };
    }
    // ABSENT is underivable, never an error: no postimage means no committed
    // takeover, which is the answer, not a failure to look.
    if (durable.candidateTakeover === undefined || durable.candidateTakeover === null) {
      return { ok: false, reason: "outcome-underivable", detail:
        "the session state carries no takeover postimage; a takeover that was never committed cannot be " +
        "proved, and retiring on the revision counter alone would discard the only record naming it" };
    }
    // MALFORMED is a REFUSAL, deliberately distinct from underivable: a value
    // that exists but cannot be read is not absence, and treating it as
    // absence would let corruption stand in for "never happened".
    const post = CandidateTakeoverPostimageSchema.safeParse(durable.candidateTakeover);
    if (!post.success) {
      return { ok: false, reason: "takeover-postimage-unreadable", detail:
        "the session state carries a takeover postimage that does not parse; it can neither prove nor " +
        "disprove this intent's outcome, so nothing may be discarded against it" };
    }
    // THE NONCE IS DECISIVE. A mismatch means the postimage belongs to a
    // different cycle (a consumed predecessor's stale value, legal under the
    // consumed-before-overwrite invariant), which proves nothing about THIS
    // intent: underivable, not an error.
    if (post.data.cycleNonce !== c.cycleNonce) {
      return { ok: false, reason: "outcome-underivable", detail:
        "the takeover postimage names a different cycle; this intent's takeover has no durable proof" };
    }
    // CORROBORATION must agree once the nonce matches. A record carrying this
    // cycle's nonce but another intent's identity is CORRUPTION, not absence
    // and not a different cycle; nothing may be retired or trusted against it.
    if (post.data.intentTransitionId !== c.transitionId || post.data.clientTaskId !== c.clientTaskId) {
      return { ok: false, reason: "takeover-postimage-conflict", detail:
        "the takeover postimage matches this cycle's nonce but contradicts its identity; a record that " +
        "disagrees with itself is corruption and proves nothing" };
    }
    // EPOCH IS NEVER COMPARED, and argvProof is NEVER READ. Adoption is legal
    // after the postimage is written, so the closed intent may sit at a
    // higher epoch than the postimage captured; comparing would foreclose
    // exactly those recovery histories. And a degraded-unknown takeover
    // retires on identical proof to a proven one, because derivability asks
    // whether the record exists and names this cycle, not how strongly the
    // takeover was authorized. The proof passes: fall through to the new
    // cycle's own gates.
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
  const retireReused = refuseReusedTransitionId(c, replacement as CancellationIntent);
  if (retireReused) return retireReused;
  const retireNonced = refuseCallerSuppliedNonce(replacement, "the new cycle's intent");
  if (retireNonced) return retireNonced;

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
  // The new cycle's identity, minted beyond the caller's reach, BEFORE the
  // unwritable parse for the same reason as supersession's.
  const minted = mintCycle(replacement);
  const retireUnwritable = refuseUnwritableRecord(minted, "the new cycle's intent");
  if (retireUnwritable) return retireUnwritable;

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

  replaceDurable(sessionDir, serialize(minted), "retire");
  return { ok: true, intent: minted };
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
  /**
   * The session's lifecycle RIGHT NOW, read under the held lock (ruling
   * ea611619 C3). A PROVIDER, never a snapshot, for the same reason as
   * `readState`: terminal-ness can change under us, and a gate that cannot
   * re-ask would be theatre at exactly the boundary it exists for.
   */
  readonly readLifecycle: () => { readonly state: string; readonly status: string };
  readonly readSuccessors: () => SuccessorServers;
  readonly loadTicket: (ticketId: string) => Promise<Ticket | null | undefined>;
  /** The ledger issue behind `state.currentIssue`, for the ISSUE_FIX authority
   * row. Same three-way contract as `loadTicket`: `undefined` means the read
   * FAILED, `null` means it positively resolved to nothing. */
  readonly loadIssue?: (issueId: string) => Promise<IssueAuthorityView | null | undefined>;
  /**
   * The session state RIGHT NOW. A provider, never a snapshot, and the single
   * source of every SERVER-DERIVED value the handshake decides on -- see the
   * provenance note on `CandidateHandshakeInput`.
   */
  readonly readSessionState: () => FullSessionState | null;
  readonly claimStalenessHours?: number;
}

/**
 * WHAT THE CALLER CONFIRMED, and nothing else.
 *
 * This type is split by PROVENANCE, and the split is load-bearing. It used to
 * also carry `sessionRevision`, `ticket` and `claimEpoch`, which the caller read
 * before acquiring the lock. The commit then re-validated under the lock by
 * spreading that same struct and overriding ONE field:
 * `{ ...args.input, sessionRevision: fresh.revision }`. So the ticket and the
 * claim epoch -- the two values the ticket-work decision is actually made from
 * -- were never refreshed, and a gate that re-reads one field out of four is
 * not a recheck.
 *
 * What remains here is exactly what only the CALLER can know: which session
 * they mean, who they are, and the picture a human confirmed. Everything a
 * SERVER can read for itself now comes from `deps.readSessionState()` at
 * decision time, so no caller snapshot can reach an authority decision.
 */
export interface CandidateHandshakeInput {
  readonly sessionId: string;
  readonly clientTaskId: string | undefined;
  /** The revision the human was shown, and the fingerprint of that picture. */
  readonly confirmedSessionRevision: number;
  readonly confirmedFingerprint: string;
}

/**
 * WHICH operation an authorization was granted for.
 *
 * Not a field on the input. A caller-supplied discriminator would be fail-open
 * by construction: a takeover caller could pass `"cancel"` and skip the takeover
 * authority matrix entirely. It is stamped by the shared core from its own
 * parameter, and each commit path rejects an authorization carrying the other
 * value.
 */
export type CandidateOperation = "takeover" | "cancel";

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
      /** Stamped by the core, never read from caller input. Each commit path
       * rejects the value that is not its own. */
      readonly operation: CandidateOperation;
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
      readonly reason:
        | "no-caller-identity"
        | "caller-is-owner"
        | "unpersistable-evidence"
        | "session-mismatch"
        | "session-terminal"
        | "state-unreadable"
        | "takeover-unauthorized";
      readonly detail: string;
      /** Present on `takeover-unauthorized`: which posture refused, and why. */
      readonly authority?: TakeoverAuthority;
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
async function authorizeCandidateRecoveryCore(
  sessionDir: string,
  input: CandidateHandshakeInput,
  deps: CandidateHandshakeDeps,
  operation: CandidateOperation,
): Promise<CandidateAuthorization> {
  const now = (deps.now ?? Date.now)();
  const staleThresholdMs = deps.staleThresholdMs ?? OWNER_STALE_MS;

  // EVERY SERVER-DERIVED VALUE COMES FROM HERE, and from nowhere the caller
  // controls. Read once, at decision time: in the commit's case this executes
  // under the held locks, so the values the authority decision is made from are
  // the values on disk at the moment of the decision.
  const sessionState = deps.readSessionState();
  if (sessionState === null) {
    return { kind: "refused", reason: "state-unreadable", detail:
      "the session state could not be read, and an authorization cannot be derived from a state " +
      "nobody can load" };
  }
  const sessionRevision = sessionState.revision;
  const derivedTicket = sessionState.ticket ? { id: sessionState.ticket.id } : null;
  const derivedEpoch = parseClaimEpoch((sessionState as Record<string, unknown>).claimEpoch);

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

  // C3 (ruling ea611619): a TERMINAL session refuses candidate authorization
  // categorically. Cancellation ends a session and this one already ended;
  // takeover exists to continue a live session its owner abandoned, and a
  // terminal session has nothing to continue. `permitsRecoveryOffer` cannot
  // catch this: it judges the OWNER's liveness, and a cleanly ended session's
  // owner is legitimately gone. With write 4 bundling SESSION_END atomically
  // into the published transition, this gate is what keeps the cancellation
  // arm cycle-bound: no new cycle can be authorized against a session a
  // published transition already terminalized.
  const lifecycle = deps.readLifecycle();
  if (lifecycle.state === "SESSION_END" || lifecycle.status === "completed") {
    return { kind: "refused", reason: "session-terminal", detail:
      `the session is terminal (state ${lifecycle.state}, status ${lifecycle.status}); owner-gone ` +
      "recovery applies only to a live session, and a terminal one has nothing to recover" };
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
  if (sessionRevision !== input.confirmedSessionRevision) {
    return { kind: "re-confirm", reason: "revision-moved", detail:
      `the session was at revision ${input.confirmedSessionRevision} when confirmed and is at ` +
      `${sessionRevision} now`, fresh: { evidence, fingerprint } };
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
  const epoch = derivedEpoch;

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
    !epoch && !derivedTicket
      ? { kind: "none", why: "no-ticket", detail:
          "this session holds no ticket and recorded no claim epoch, so no ticket work is owed" }
      : !epoch
        ? { kind: "none", why: "claim-not-held", detail:
            `this session is on ticket ${derivedTicket!.id} but recorded no claim epoch, so it cannot prove ` +
            "ownership and no release may be written for it" }
        : { kind: "blocked", why: "claim-context-mismatch", detail:
            `the recorded claim epoch names ticket ${epoch.ticketId} while the session is on ` +
            `${derivedTicket ? derivedTicket.id : "no ticket"}; the claim context contradicts itself, so what ` +
            "is owed cannot be determined" };

  // Hoisted so the authority matrix below reuses THIS observation rather than
  // taking a second, possibly divergent, reading of the same ticket.
  //
  // Carried as a THREE-WAY read, not as `Ticket | null`. The catch below sets
  // `ticket = null` so the claim arms can share one variable, and handing that
  // null on as the matrix's observation would spell a failed read the same way
  // as a positive finding of absence -- the exact collapse this module refuses
  // to make everywhere else. It is not fail-open today (the ticket postures
  // refuse anyway, through reconciliation or the shape check), but the refusal
  // would name the wrong reason and the operator would be told the ticket is
  // gone when it is unreadable.
  let loadedRead: LedgerRead<Ticket> | undefined;
  if (epoch && derivedTicket && derivedTicket.id === epoch.ticketId) {
    let ticket: Ticket | null | undefined;
    let unreadable: string | null = null;
    try {
      ticket = await deps.loadTicket(epoch.ticketId);
    } catch (err) {
      unreadable = err instanceof Error ? err.message : "unknown error";
      ticket = null;
    }
    loadedRead = unreadable !== null
      ? { kind: "unreadable", detail: unreadable }
      : ticket === undefined
        ? { kind: "unreadable", detail: "the ledger read did not answer" }
        : ticket === null
          ? { kind: "absent" }
          : { kind: "found", value: ticket };
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

  // THE AUTHORITY MATRIX, and only for a takeover.
  //
  // Cancel deliberately skips it: a session needs ENDING whatever its claim
  // posture, and refusing to cancel a claim-lost session is precisely what
  // strands it. Takeover is the opposite question -- may this session's WORK be
  // handed on -- and until now nothing asked it, so a takeover was authorized
  // and published even when the claim had been released, won by another
  // session, left unreadable, or left contradicting itself.
  //
  // It runs HERE rather than at a caller so that the commit's under-lock
  // re-validation inherits it from the same implementation, which closes the
  // window between a caller's pre-check and the write for free.
  if (operation === "takeover") {
    // WHAT TO READ is the module's question, not this function's. Asking
    // `state.currentIssue` and "the epoch's ticket" directly loaded the wrong
    // record in two postures: the retained epoch names the PREVIOUS item at a
    // pre-acquisition state, and `currentIssue` is already cleared at
    // FINALIZE/`committed`, which is precisely the crash `finalizedItem` exists
    // to make resolvable.
    const targets = authorityLedgerTargets(sessionState);
    const authorityDecision = decideTakeoverAuthority({
      state: sessionState,
      ticket: await readLedgerTicket(deps, loadedRead, epoch, targets.ticketId),
      issue: await readLedgerIssue(deps, targets.issueId),
      reconciliation,
    });
    if (authorityDecision.kind === "refused") {
      return { kind: "refused", reason: "takeover-unauthorized", authority: authorityDecision, detail:
        `takeover is not authorized at ${sessionState.state} (${authorityDecision.posture}): ` +
        authorityDecision.detail };
    }
  }

  return {
    kind: "authorized",
    operation,
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

/**
 * The ledger ticket for the authority matrix, as a three-way read.
 *
 * The claim path above may already have loaded it; reusing that result avoids a
 * second ledger hit and, more importantly, keeps both decisions made from ONE
 * observation. When it did not (no epoch, so no claim work was owed) this loads
 * it for the identity the matrix resolves, and a THROW is reported as
 * `unreadable` rather than swallowed into absence.
 */
async function readLedgerTicket(
  deps: CandidateHandshakeDeps,
  alreadyLoaded: LedgerRead<Ticket> | undefined,
  epoch: ClaimEpoch | null,
  ticketId: string | null,
): Promise<LedgerRead<Ticket>> {
  if (!ticketId) return { kind: "absent" };
  // Reuse the claim path's read only when it is a read of the SAME ticket, so
  // an epoch pointing at a previous item cannot answer for the current one. It
  // is carried three-way, so an unreadable ledger stays unreadable here.
  if (epoch && epoch.ticketId === ticketId && alreadyLoaded !== undefined) {
    return alreadyLoaded;
  }
  try {
    const loaded = await deps.loadTicket(ticketId);
    if (loaded === undefined) return { kind: "unreadable", detail: "the ledger read did not answer" };
    return loaded === null ? { kind: "absent" } : { kind: "found", value: loaded };
  } catch (err) {
    return { kind: "unreadable", detail: err instanceof Error ? err.message : "unknown error" };
  }
}

/** As above, for the ISSUE_FIX and issue-finalization rows. */
async function readLedgerIssue(
  deps: CandidateHandshakeDeps,
  issueId: string | null,
): Promise<LedgerRead<IssueAuthorityView>> {
  if (!issueId) return { kind: "absent" };
  if (!deps.loadIssue) {
    return { kind: "unreadable", detail: "no issue loader was supplied, so the ledger issue could not be read" };
  }
  try {
    const loaded = await deps.loadIssue(issueId);
    if (loaded === undefined) return { kind: "unreadable", detail: "the ledger read did not answer" };
    return loaded === null ? { kind: "absent" } : { kind: "found", value: loaded };
  } catch (err) {
    return { kind: "unreadable", detail: err instanceof Error ? err.message : "unknown error" };
  }
}

/**
 * TAKEOVER authorization: the five-step handshake PLUS the per-state authority
 * matrix. `commitCandidateTakeoverLocked` calls this and nothing else.
 */
export async function authorizeCandidateTakeover(
  sessionDir: string,
  input: CandidateHandshakeInput,
  deps: CandidateHandshakeDeps,
): Promise<CandidateAuthorization> {
  return authorizeCandidateRecoveryCore(sessionDir, input, deps, "takeover");
}

/**
 * CANCEL authorization: the five-step handshake alone.
 *
 * No authority matrix, deliberately. Cancellation ends a session, and a session
 * whose claim posture has gone wrong is exactly the one that most needs ending;
 * gating it on claim authority would strand it. The protection cancel needs is
 * on its WRITES (it refuses to touch a ticket it cannot prove is this
 * session's), not on its right to run.
 */
export async function authorizeCandidateCancel(
  sessionDir: string,
  input: CandidateHandshakeInput,
  deps: CandidateHandshakeDeps,
): Promise<CandidateAuthorization> {
  return authorizeCandidateRecoveryCore(sessionDir, input, deps, "cancel");
}

/** Presence-preserving read of one ticket field, the same shape
 * `readTicketClaimState` produces for the two ownership fields. */
function fieldOf(ticket: object, key: string): { present: boolean; value: string | null } {
  if (!(key in ticket)) return { present: false, value: null };
  const value = (ticket as Record<string, unknown>)[key];
  return { present: true, value: typeof value === "string" ? value : null };
}

// ---------------------------------------------------------------------------
// The takeover commit (T-450 step 6b, ruling ea611619 Parts B5-B8)
// ---------------------------------------------------------------------------

/**
 * THE CONTENT-GATED CLOSE for a takeover cycle (ruling ea611619 B8).
 *
 * Closing the intent is the statement "this cycle's outcome is derivable",
 * and for a takeover the derivation source is `state.candidateTakeover`, so
 * the close verifies THAT RECORD before writing anything: strict parse, then
 * cycleNonce equality with the live intent, DECISIVE, never revision math.
 * The gate itself never writes session state; its one write is the intent's
 * own closed record, and only after the proof holds.
 *
 * `durable.candidateTakeover` must be the RE-READ persisted value, read by
 * the caller under the held lock after its commit write returned -- never
 * the in-memory object it intended to write. That is the difference between
 * proving the postimage is durable and assuming it (the same value-not-reader
 * discipline as `retireClosedIntent`'s injection).
 *
 * The takeover close leaves from `authorized` ONLY. The ticket phases belong
 * to the cancellation path: a takeover does no ticket work (the new owner
 * adopts the claim), so an intent at prepared/ticket_applied/claim_cleared is
 * a cancellation in flight, and a takeover may not close somebody's
 * half-done cancellation. This writer is deliberately OUTSIDE
 * `advanceCancellationIntent`'s edge table: that table orders the
 * cancellation phases, and folding `authorized -> closed` into it would hand
 * every advancement caller an edge only this gate may take.
 */
export function closeTakeoverIntent(
  sessionDir: string,
  durable: { readonly candidateTakeover: unknown; readonly committedRevision: number },
): IntentWrite {
  const current = readCancellationIntent(sessionDir);
  if (current.kind === "absent") {
    return { ok: false, reason: "not-found", detail: "no intent exists to close" };
  }
  if (current.kind === "unreadable" || current.kind === "malformed") {
    return { ok: false, reason: current.kind, detail: current.detail };
  }
  const c = current.intent;

  // THE GATE, before any phase arithmetic: the proof must name THIS cycle.
  // Absent is "the commit never happened" (not-committed), a parse failure is
  // corruption-adjacent and gets its own reason, a foreign nonce is a
  // consumed cycle's stale value (B9) and proves nothing about this one, and
  // a nonce match with contradicting corroboration is CORRUPTION: the nonce
  // is collision-negligible, so agreement on it with disagreement on the
  // fields it travels with cannot be two honest cycles.
  if (durable.candidateTakeover === undefined || durable.candidateTakeover === null) {
    return { ok: false, reason: "not-committed", detail:
      "the persisted state carries no candidateTakeover postimage, so no takeover commit is durable " +
      "and the intent may not close on one" };
  }
  const post = CandidateTakeoverPostimageSchema.safeParse(durable.candidateTakeover);
  if (!post.success) {
    return { ok: false, reason: "takeover-postimage-unreadable", detail:
      "the persisted candidateTakeover does not parse as a takeover postimage; refusing to close " +
      "an intent on a record whose own reader rejects it" };
  }
  if (post.data.cycleNonce !== c.cycleNonce) {
    return { ok: false, reason: "not-committed", detail:
      "the persisted postimage carries another cycle's nonce, so it is a consumed cycle's stale value " +
      "and proves nothing about this intent's commit" };
  }
  if (post.data.intentTransitionId !== c.transitionId || post.data.clientTaskId !== c.clientTaskId) {
    return { ok: false, reason: "takeover-postimage-conflict", detail:
      "the postimage matches this cycle's nonce but contradicts its corroboration " +
      "(transitionId/clientTaskId); nonce agreement with corroboration disagreement is corruption, not a retry" };
  }

  if (c.phase === "closed") {
    // The crash-between-close-and-return retry. The gate above already proved
    // the postimage is this cycle's, so a closed takeover outcome naming the
    // same committed write is this exact close having already run.
    if (c.outcome.kind === "takeover" && c.outcome.committedRevision === durable.committedRevision) {
      return { ok: true, intent: c };
    }
    return { ok: false, reason: "takeover-postimage-conflict", detail:
      c.outcome.kind === "takeover"
        ? `the intent is already closed on committedRevision ${c.outcome.committedRevision}, not ` +
          `${durable.committedRevision}; two commits cannot both own one cycle`
        : "the intent is already closed as a cancellation, and a matching takeover postimage for the same " +
          "cycle means two outcomes claim one cycle: corruption, not a retry" };
  }
  if (c.phase !== "authorized") {
    return { ok: false, reason: "edge-refused", detail:
      `a takeover closes an intent from authorized only; this one is at ${c.phase}, which is a ` +
      "cancellation in flight, and a takeover may not close another path's half-done work" };
  }

  const next = {
    ...c,
    phase: "closed",
    outcome: { kind: "takeover", committedRevision: durable.committedRevision },
  } as CancellationIntent;
  const unwritable = refuseUnwritableRecord(next, "the closed takeover intent");
  if (unwritable) return unwritable;
  replaceDurable(sessionDir, serialize(next), "close");
  return { ok: true, intent: next };
}

/**
 * Injection seams for `commitCandidateTakeover`. Everything a test must be
 * able to fail INDIVIDUALLY (staging, project lock, generation validation,
 * the state write) is a named dependency with a production default, per the
 * staged-generation ownership rule: `discard` runs on every exit that does
 * not commit, so each injected failure also proves the discard.
 */
export interface CandidateTakeoverDeps {
  readonly handshake: CandidateHandshakeDeps;
  readonly stage?: () => StagedHeartbeatGeneration | null;
  readonly validateStaged?: (staged: StagedHeartbeatGeneration) => StagedGenerationValidation;
  readonly discardStaged?: (staged: StagedHeartbeatGeneration) => void;
  /** Acquire the PROJECT lock and run the body under it. The session lock is
   * the caller's (the `Locked` suffix is that contract); this seam exists so
   * tests can fail acquisition deterministically. */
  readonly withProjectLock?: (fn: () => Promise<void>) => Promise<void>;
  /** Fresh session state, read under the held locks. A provider, never a
   * snapshot: the already-committed check and the postimage's base state
   * must both come from what is on disk NOW. Defaults to `readSession` on
   * the session directory. */
  readonly readState?: () => FullSessionState | null;
  /** The durable state write (ruling B7). Defaults to the durable variant
   * through `writeSessionAndRefresh`; injectable so a write failure is
   * testable without breaking a real filesystem. */
  readonly writeState?: (state: FullSessionState) => FullSessionState;
  readonly nowIso?: () => string;
}

export type CandidateTakeoverCommit =
  | {
      readonly kind: "committed";
      readonly state: FullSessionState;
      readonly postimage: CandidateTakeoverPostimage;
      /** The content-gated close's own verdict. A refusal here does NOT undo
       * the commit: the postimage is durable and the intent stays open for a
       * verified retry, which is exactly the crash contract. */
      readonly close: IntentWrite;
      /** True when this call found the postimage already durable and only
       * verified and closed (the crash-retry path): verify, never redo. */
      readonly resumed: boolean;
    }
  | {
      readonly kind: "refused";
      readonly stage:
        | "staging"
        | "state-unreadable"
        | "validation"
        // NOT a policy outcome. An invariant this module's correctness rests on
        // was violated, which can only mean the code is wired wrong. It is a
        // separate arm so it cannot be mistaken for, or "fixed" by loosening,
        // an ordinary authorization refusal.
        | "invariant-violated"
        | "intent"
        | "generation"
        | "write"
        | "project-lock";
      readonly detail: string;
      /** Present when the refusal came from the re-validation, so the caller
       * can re-present fresh evidence instead of starting over blind. */
      readonly authorization?: CandidateAuthorization;
    };

/**
 * COMMIT an owner-gone candidate takeover (ruling ea611619 B5-B8; plan
 * step 6b). Requires the ALREADY-HELD session lock; acquires only the
 * project lock. `commitCandidateTakeoverWithSessionLock` wraps this for
 * non-guide callers and tests.
 *
 * ORDER, and why each step sits where it does:
 *
 *   1. STAGE the heartbeat generation OUTSIDE the project lock: staging
 *      blocks on readiness acknowledgement, and holding the lock across it
 *      would stall every project write for the readiness timeout.
 *   2. Under the project lock, CHECK FOR AN ALREADY-DURABLE COMMIT first:
 *      a crashed prior attempt left the postimage in state and the intent
 *      open, and re-validation would refuse that retry as caller-is-owner
 *      (the crashed attempt's write made this caller the owner). The proof
 *      of "already committed" is the B8 gate itself: strict parse plus
 *      nonce equality with the live intent. Verify, never redo: the retry
 *      closes the intent and returns; it never re-writes state, and its own
 *      staged generation is discarded.
 *   3. Otherwise RE-RUN THE FULL VALIDATION against state loaded under the
 *      lock (the same five-step handshake, same providers), then settle the
 *      intent (create it, or resume this task's own authorized intent),
 *      then `validateStagedGeneration` IMMEDIATELY before the write: the
 *      staged child can exit, or its directory be replaced, between
 *      readiness and lock acquisition, so a readiness result from before
 *      the lock is not evidence of liveness at write time.
 *   4. ONE atomic durable postimage (B5/B7): ownerTask, the generation, the
 *      refreshed mcpServerPid/mcpGuideCallAt pair, and `candidateTakeover`
 *      in the SAME write, so a crash cannot produce a completed takeover
 *      with no audit record, or a proof without its fact.
 *   5. The content-gated close (B8), against the RE-READ persisted state.
 *
 * The staged generation is OWNED by this attempt from the moment staging
 * returns: `discard` runs on EVERY exit that does not flip `committed`,
 * structurally in a `finally`.
 */
export async function commitCandidateTakeoverLocked(
  root: string,
  sessionDir: string,
  args: {
    readonly input: CandidateHandshakeInput;
    readonly callerTask: OwnerTask;
  },
  deps: CandidateTakeoverDeps,
): Promise<CandidateTakeoverCommit> {
  const stage = deps.stage ?? (() => stageHeartbeatGeneration(sessionDir));
  const validateStaged = deps.validateStaged ?? validateStagedGeneration;
  const discardStaged = deps.discardStaged ?? discardStagedGeneration;
  const readState = deps.readState ?? (() => readSession(sessionDir));
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const writeState = deps.writeState
    ?? ((state: FullSessionState) => writeSessionAndRefresh(root, sessionDir, state, "if-active", "durable"));
  const underProjectLock = deps.withProjectLock
    ?? (async (fn: () => Promise<void>) => {
      const { withProjectLock } = await import("../core/project-loader.js");
      await withProjectLock(root, { strict: false }, async () => fn());
    });

  const staged = stage();
  if (staged === null) {
    return { kind: "refused", stage: "staging", detail:
      "the heartbeat generation could not be staged, so the takeover would publish an ownership " +
      "record with no liveness behind it; nothing was mutated" };
  }

  let committed = false;
  // Separate from `committed` on purpose: the postimage-published-but-
  // undurable path is NOT a commit (the intent stays open, so a retry must
  // re-enter), yet the persisted state names this generation, so it survives.
  let keepStaged = false;
  let result: CandidateTakeoverCommit | null = null;
  try {
    await underProjectLock(async () => {
      const fresh = readState();
      if (fresh === null) {
        result = { kind: "refused", stage: "state-unreadable", detail:
          "the session state could not be read under the lock; a takeover cannot be validated against " +
          "a state nobody can load" };
        return;
      }

      // STEP 2: the crash-retry path, BEFORE re-validation (which would
      // refuse it as caller-is-owner). The gate is nonce equality against
      // the live intent, so a lingering postimage from a CONSUMED cycle
      // (B9) falls through to the fresh-commit path and is overwritten.
      const existing = readCancellationIntent(sessionDir);
      if (existing.kind === "valid" && existing.intent.clientTaskId === args.callerTask.id) {
        const durablePost = CandidateTakeoverPostimageSchema.safeParse(
          (fresh as Record<string, unknown>).candidateTakeover,
        );
        if (durablePost.success && durablePost.data.cycleNonce === existing.intent.cycleNonce) {
          const close = closeTakeoverIntent(sessionDir, {
            candidateTakeover: (fresh as Record<string, unknown>).candidateTakeover,
            // The pointer names a revision the caller can PROVE carries the
            // proof. The postimage's own write revision is unrecoverable by
            // design (the postimage carries NO revision field, B5), so a
            // resumed close uses: the closed outcome's recorded value when
            // the close already ran (making the idempotent arm's equality
            // hold), else the revision of the very state this postimage was
            // just parsed from -- which satisfies retirement's revision
            // precondition, since that state is durable at that revision.
            committedRevision:
              existing.intent.phase === "closed" && existing.intent.outcome.kind === "takeover"
                ? existing.intent.outcome.committedRevision
                : fresh.revision,
          });
          result = {
            kind: "committed",
            state: fresh,
            postimage: durablePost.data,
            close,
            resumed: true,
          };
          return;
        }
      }
      if (existing.kind === "unreadable" || existing.kind === "malformed") {
        result = { kind: "refused", stage: "intent", detail:
          `the durable intent is ${existing.kind}; an unreadable intent is never absence, and a takeover ` +
          "may not write past evidence it cannot read" };
        return;
      }
      if (existing.kind === "valid" && existing.intent.clientTaskId !== args.callerTask.id) {
        result = { kind: "refused", stage: "intent", detail:
          "a durable intent from another task exists; it is that attempt's evidence, and this takeover " +
          "may not adopt or overwrite it" };
        return;
      }
      if (existing.kind === "valid" && existing.intent.phase !== "authorized") {
        result = { kind: "refused", stage: "intent", detail:
          `this task's own intent is at ${existing.intent.phase}: a cancellation is in flight, and the ` +
          "takeover may not close another path's half-done work" };
        return;
      }

      // STEP 3a: FULL re-validation against the state under the lock. The
      // sessionRevision is read HERE, not taken from the caller: the
      // confirmation was made against a number, and the number that counts
      // is the one the postimage write is about to build on.
      const authorization = await authorizeCandidateTakeover(sessionDir, args.input, deps.handshake);
      // AN INVARIANT CHECK, NOT DEAD CODE, and the distinction is the reason
      // this is kept. An unreachable BRANCH of business logic should be
      // deleted; an executable statement of a PRECONDITION the module's
      // correctness rests on should not, and the test that separates them is
      // the failure mode when the precondition is violated. Here it is a SILENT
      // authority bypass, and a guard is the only thing that turns silence into
      // a signal. A comment asserting the same precondition would drift with
      // nothing to say when it had; this cannot.
      //
      // It is unreachable today -- the entry point above stamps its own tag --
      // so no behavioural test can kill a mutation of it. That is a property of
      // invariant guards, not a coverage gap.
      //
      // The refusal is deliberately NOT the ordinary shape. If it ever fires
      // and reads as a routine authorization refusal, someone debugs it as a
      // policy question and "fixes" it by loosening policy, at which point the
      // guard has caused the very bypass it exists to prevent.
      if (authorization.kind === "authorized" && authorization.operation !== "takeover") {
        result = { kind: "refused", stage: "invariant-violated", authorization, detail:
          "PROGRAMMING ERROR, not a policy refusal: this takeover commit received an authorization " +
          `stamped "${authorization.operation}". The takeover entry point stamps its own tag, so this ` +
          "cannot happen unless the call above has been repointed at the shared core or at the cancel " +
          "entry point. The takeover authority matrix runs only on the takeover path, so committing " +
          "here would publish a takeover nothing ever authorized. Fix the wiring; do NOT loosen this " +
          "check or the authorization policy." };
        return;
      }
      if (authorization.kind !== "authorized") {
        result = { kind: "refused", stage: "validation", authorization, detail:
          `re-validation under the lock returned ${authorization.kind}; the takeover commits only what ` +
          "a fresh five-step handshake would authorize right now" };
        return;
      }

      // STEP 3b: settle the intent. Absent creates (minting the cycle
      // nonce); this task's own authorized intent resumes verbatim.
      let intent: CancellationIntent;
      if (existing.kind === "valid") {
        // THE TICKET IS A SECOND, INDEPENDENT AXIS, and this arm used to ignore
        // it. Resuming `existing.intent` verbatim inherits a `ticketPreimage`
        // minted under an EARLIER authorization, with no comparison against
        // what the fresh under-lock handshake just found -- so a ticket that
        // moved between the crashed attempt and this retry would be recorded by
        // its stale preimage, and the postimage written below would carry audit
        // evidence the live ledger contradicts. The cancel path has guarded
        // exactly this since step 6b (`ticketWorkMoved`); the takeover path did
        // not, and the asymmetry was the defect.
        //
        // Only supersession applies here, never adoption: this arm is reached
        // only at `authorized` (a further-along phase refused above), and the
        // already-committed check at STEP 2 has already returned for any cycle
        // whose postimage is durable. So nothing durable references the nonce
        // being retired, and the id retires with its confirmation.
        //
        // BOTH AXES, as the cancel path does at its own resume. The
        // confirmation pair describes the SESSION and the preimage describes
        // the TICKET, and either can move without the other. Reusing an intent
        // whose confirmation pair is stale while the postimage below is written
        // from the FRESH authorization's evidence would leave the durable cycle
        // recording two confirmations that disagree about the same transition.
        const freshPreimage = authorization.ticketWork.kind === "release"
          ? authorization.ticketWork.preimage
          : null;
        const confirmationMoved =
          existing.intent.confirmedSessionRevision !== authorization.authority.confirmedSessionRevision
          || existing.intent.confirmedFingerprint !== authorization.authority.confirmedFingerprint;
        const ticketWorkMoved = !deepEquals(existing.intent.ticketPreimage ?? null, freshPreimage ?? null);
        if (!confirmationMoved && !ticketWorkMoved) {
          intent = existing.intent;
        } else {
          const superseded = supersedeCancellationIntent(sessionDir, {
            schemaVersion: 1,
            transitionId: randomUUID(),
            confirmationEpoch: existing.intent.confirmationEpoch + 1,
            clientTaskId: args.callerTask.id,
            sessionId: existing.intent.sessionId,
            sessionStartedAt: existing.intent.sessionStartedAt,
            confirmedSessionRevision: authorization.authority.confirmedSessionRevision,
            confirmedFingerprint: authorization.authority.confirmedFingerprint,
            evidence: authorization.authority.evidence,
            ticketPreimage: freshPreimage,
            predecessor: {
              predecessorTransitionId: existing.intent.transitionId,
              predecessorEpoch: existing.intent.confirmationEpoch,
              predecessorFingerprint: existing.intent.confirmedFingerprint,
            },
            phase: "authorized",
          } as NewCycleIntent);
          if (!superseded.ok) {
            result = { kind: "refused", stage: "intent", detail:
              `a resumed takeover intent moved on its ` +
              `${confirmationMoved && ticketWorkMoved ? "confirmation and ticket axes" : confirmationMoved ? "confirmation axis" : "ticket axis"} ` +
              `and supersession failed (${superseded.reason}): ${superseded.detail}` };
            return;
          }
          intent = superseded.intent;
        }
      } else {
        // Provenance is REQUIRED: an intent without a usable start time could
        // be matched by a later incarnation of the same directory. The same
        // refusal applyCancellationTransition makes for candidates, made
        // here for the same reason.
        const startedAt = canonicalStartedAt((fresh as Record<string, unknown>).startedAt);
        if (startedAt === null) {
          result = { kind: "refused", stage: "intent", detail:
            "this session's start time is unusable, so no durable intent can bind provenance and no " +
            "takeover cycle can be minted for it" };
          return;
        }
        const created = createCancellationIntent(sessionDir, {
          schemaVersion: 1,
          transitionId: randomUUID(),
          confirmationEpoch: 0,
          clientTaskId: args.callerTask.id,
          sessionId: args.input.sessionId,
          sessionStartedAt: startedAt,
          confirmedSessionRevision: authorization.authority.confirmedSessionRevision,
          confirmedFingerprint: authorization.authority.confirmedFingerprint,
          evidence: authorization.authority.evidence,
          ticketPreimage: authorization.ticketWork.kind === "release" ? authorization.ticketWork.preimage : null,
          phase: "authorized",
        } as NewCycleIntent);
        if (!created.ok) {
          result = { kind: "refused", stage: "intent", detail:
            `the durable intent could not be created (${created.reason}): ${created.detail}` };
          return;
        }
        intent = created.intent;
      }

      // STEP 3c: re-prove the staged generation IMMEDIATELY before the write.
      const generation = validateStaged(staged);
      if (!generation.ok) {
        result = { kind: "refused", stage: "generation", detail:
          `the staged generation failed re-validation (${generation.reason}); a readiness result from ` +
          "before lock acquisition is not evidence of liveness at write time" };
        return;
      }

      // STEP 4: the one atomic durable postimage (B5/B7). The evidence
      // bundle is validated by ITS OWN schema before the write, because no
      // writer may produce a record its own reader refuses; the reader keeps
      // it opaque (B6).
      const evidence = CandidateRecoveryEvidenceSchema.safeParse({
        argvProof: generation.argvProof,
        liveness: authorization.authority.evidence,
      });
      if (!evidence.success) {
        result = { kind: "refused", stage: "write", detail:
          "the takeover evidence bundle does not fit its persisted schema, so no auditable postimage " +
          "can be written" };
        return;
      }
      const postimage: CandidateTakeoverPostimage = {
        schemaVersion: 1,
        kind: "candidate_takeover_committed",
        cycleNonce: intent.cycleNonce,
        takeoverKind: "owner_gone_candidate_takeover",
        intentTransitionId: intent.transitionId,
        clientTaskId: args.callerTask.id,
        confirmationEpoch: intent.confirmationEpoch,
        evidence: evidence.data,
      };
      const written = CandidateTakeoverPostimageSchema.safeParse(postimage);
      if (!written.success) {
        result = { kind: "refused", stage: "write", detail:
          "the takeover postimage does not fit its own schema; refusing to write a record its reader " +
          "would reject" };
        return;
      }

      let after: FullSessionState;
      try {
        after = writeState({
          ...(fresh as unknown as Record<string, unknown>),
          ownerTask: args.callerTask,
          heartbeatGeneration: staged.id,
          mcpServerPid: process.pid,
          mcpGuideCallAt: nowIso(),
          candidateTakeover: written.data,
        } as unknown as FullSessionState);
      } catch (err) {
        // A POST-RENAME failure is not a failed write. The state carrying the
        // rebind and this postimage is already visible to every reader; only
        // its survival across power loss is unproven. Two things must then
        // NOT happen. The intent must not close, because a close that outlives
        // the state write is the permanent foreclosure B7 exists to prevent.
        // And the staged generation must not be discarded, because the
        // persisted state now NAMES it, and discarding it would leave a
        // session owned through a generation nobody can find.
        //
        // The retry is the recovery: it re-reads the state, finds the
        // postimage, matches the nonce and closes through the already-
        // committed path at STEP 2.
        if (err instanceof StateWriteUndurableError) {
          keepStaged = true;
          result = { kind: "refused", stage: "write", detail:
            `the postimage was published at revision ${err.published.revision} but its durability ` +
            "barriers did not complete; the intent is deliberately left open and the staged generation " +
            "kept, so a retry resumes this same commit rather than starting a second one" };
          return;
        }
        result = { kind: "refused", stage: "write", detail:
          `the postimage write failed (${err instanceof Error ? err.message : "unknown error"}); nothing ` +
          "was published and the staged generation is discarded" };
        return;
      }
      committed = true;

      // STEP 5: the content-gated close, against the RE-READ persisted
      // state, never the in-memory object this function just built.
      const reread = readState();
      const close = closeTakeoverIntent(sessionDir, {
        candidateTakeover: reread === null
          ? undefined
          : (reread as Record<string, unknown>).candidateTakeover,
        committedRevision: after.revision,
      });
      result = { kind: "committed", state: after, postimage: written.data, close, resumed: false };
    });
  } catch (err) {
    if (result === null) {
      result = { kind: "refused", stage: "project-lock", detail:
        `the project lock could not be acquired or its body failed (${err instanceof Error ? err.message : "unknown error"})` };
    }
  } finally {
    if (!committed && !keepStaged) discardStaged(staged);
  }
  return result ?? { kind: "refused", stage: "project-lock", detail:
    "the project lock body never ran; nothing was mutated" };
}

/**
 * The session-lock-acquiring wrapper for non-guide callers and tests.
 * `commitCandidateTakeoverLocked` is what guide.ts imports (step 7), because
 * the guide already holds the session lock and `withSessionLock` is not
 * reentrant. Exactly one acquisition happens here and none in the locked
 * form; a test pins both.
 */
export async function commitCandidateTakeoverWithSessionLock(
  root: string,
  sessionDir: string,
  args: {
    readonly input: CandidateHandshakeInput;
    readonly callerTask: OwnerTask;
  },
  deps: CandidateTakeoverDeps,
): Promise<CandidateTakeoverCommit> {
  return withSessionLock(root, () => commitCandidateTakeoverLocked(root, sessionDir, args, deps));
}

// ---------------------------------------------------------------------------
// The cancellation commit (T-450 step 6b, ruling ea611619 Part C)
// ---------------------------------------------------------------------------

/**
 * THE CONTENT-GATED CLOSE for a cancellation cycle (ruling ea611619 C2).
 *
 * Symmetric with `closeTakeoverIntent` and outside the advancement edge table
 * for the same reason: closing is a statement of derivability, not a phase of
 * the work, and its gate is the shipped published-transition conditions (the
 * same ones retirement's cancellation arm applies): the RE-READ persisted
 * transition parses, names THIS intent's transitionId, is `published`, and
 * its `terminalRevision` is within the persisted revision, so the proof is
 * durable before the intent stops being retryable.
 *
 * Legal FROM phases: `claim_cleared` (the ticket path ran) and `authorized`
 * (the audited no-ticket-write path, where no ClaimTxn ever existed and the
 * ticket phases would have nothing durable to record). `prepared` and
 * `ticket_applied` REFUSE: a nested ClaimTxn is half-done ticket work, and
 * closing over it would orphan the transaction the recovery table needs.
 */
export function closeCancellationIntentOnPublication(
  sessionDir: string,
  durable: { readonly cancellationTransition: unknown; readonly sessionRevision: number },
): IntentWrite {
  const current = readCancellationIntent(sessionDir);
  if (current.kind === "absent") {
    return { ok: false, reason: "not-found", detail: "no intent exists to close" };
  }
  if (current.kind === "unreadable" || current.kind === "malformed") {
    return { ok: false, reason: current.kind, detail: current.detail };
  }
  const c = current.intent;

  const read = readCancellationTransition(durable.cancellationTransition);
  if (read.kind !== "valid") {
    return { ok: false, reason: "not-committed", detail:
      read.kind === "absent"
        ? "the persisted state carries no cancellation transition, so no publication is durable and the " +
          "intent may not close on one"
        : `the persisted cancellation transition is malformed (${read.detail}); refusing to close an ` +
          "intent on a record whose own reader rejects it" };
  }
  const t = read.transition;
  if (t.transitionId !== c.transitionId) {
    return { ok: false, reason: "not-committed", detail:
      `the persisted transition is ${t.transitionId}, not this intent's ${c.transitionId}; another ` +
      "transition's publication proves nothing about this cycle" };
  }
  if (t.phase !== "published") {
    return { ok: false, reason: "not-committed", detail:
      `the persisted transition is at ${t.phase}, not published; the intent closes only once the ` +
      "terminal write is durable" };
  }
  if (t.terminalRevision > durable.sessionRevision) {
    return { ok: false, reason: "not-committed", detail:
      `the transition names terminalRevision ${t.terminalRevision} but the persisted session is at ` +
      `${durable.sessionRevision}; the publication is not durable yet` };
  }

  if (c.phase === "closed") {
    if (c.outcome.kind === "cancellation" && c.outcome.transitionId === t.transitionId) {
      return { ok: true, intent: c };
    }
    return { ok: false, reason: "takeover-postimage-conflict", detail:
      c.outcome.kind === "cancellation"
        ? `the intent is already closed on cancellation ${c.outcome.transitionId}, not ${t.transitionId}; ` +
          "two publications cannot both own one cycle"
        : "the intent is already closed as a takeover, and a published cancellation for the same cycle " +
          "means two outcomes claim one cycle: corruption, not a retry" };
  }
  if (c.phase === "prepared" || c.phase === "ticket_applied") {
    return { ok: false, reason: "edge-refused", detail:
      `the intent is at ${c.phase} with a nested claim transaction; closing over half-done ticket work ` +
      "would orphan the transaction the recovery table needs, so the transaction resolves first" };
  }

  const next = {
    ...c,
    phase: "closed",
    outcome: { kind: "cancellation", transitionId: t.transitionId },
  } as CancellationIntent;
  delete (next as unknown as Record<string, unknown>).claimTxn;
  const unwritable = refuseUnwritableRecord(next, "the closed cancellation intent");
  if (unwritable) return unwritable;
  replaceDurable(sessionDir, serialize(next), "close");
  return { ok: true, intent: next };
}

/** The ClaimTxn axes of a LIVE ledger ticket, projected the same way the
 * persisted snapshot records them, so `recoverClaimTransaction` compares like
 * with like. */
function observedSnapshotOf(ticket: object, ticketId: string): TicketSnapshot {
  const raw = ticket as Record<string, unknown>;
  const field = <T>(key: string): { present: boolean; value: T | null } =>
    key in raw ? { present: true, value: (raw[key] ?? null) as T | null } : { present: false, value: null };
  return {
    ticketId,
    lifecycle: field<string>("lifecycle"),
    status: field<string>("status"),
    completedDate: field<string>("completedDate"),
    claim: field<never>("claim") as TicketSnapshot["claim"],
    claimedBySession: field<string>("claimedBySession"),
  };
}

/** Materialize a snapshot's five axes onto a live ticket, preserving every
 * field outside them. Absent means DELETE the key, per Field semantics. */
function applySnapshotToTicket(ticket: object, snap: TicketSnapshot): Record<string, unknown> {
  const out = { ...(ticket as Record<string, unknown>) };
  const put = (key: string, f: { readonly present: boolean; readonly value: unknown }): void => {
    if (f.present) out[key] = f.value;
    else delete out[key];
  };
  put("lifecycle", snap.lifecycle);
  put("status", snap.status);
  put("completedDate", snap.completedDate);
  put("claim", snap.claim);
  put("claimedBySession", snap.claimedBySession);
  return out;
}

/** The released postimage a candidate cancellation's release txn drives the
 * ticket to: open, both ownership fields REMOVED (ISS-759/ISS-652: deleted
 * keys, never explicit nulls). */
function releasedPostimageOf(preimage: PersistedTicketSnapshot): PersistedTicketSnapshot {
  return {
    ticketId: preimage.ticketId,
    lifecycle: preimage.lifecycle,
    status: { present: true, value: "open" },
    completedDate: preimage.completedDate,
    claim: { present: false, value: null },
    claimedBySession: { present: false, value: null },
  };
}

/** What the ticket lock hands the transaction steps: a loader and a writer,
 * both bound to the held project lock. */
export interface CandidateTicketIO {
  readonly load: (ticketId: string) => Ticket | null;
  readonly write: (ticket: Record<string, unknown>) => Promise<void>;
}

export interface CandidateCancelDeps {
  readonly handshake: CandidateHandshakeDeps;
  /** Acquire the PROJECT lock and run the ticket transaction step under it.
   * Two acquisitions per release (the mutate+stamp write and the nonce
   * removal) is the five-step transaction's own shape. */
  readonly withTicketLock?: (fn: (io: CandidateTicketIO) => Promise<void>) => Promise<void>;
  /** Fresh session state under the held session lock; provider, never a
   * snapshot. Defaults to `readSession`. */
  readonly readState?: () => FullSessionState | null;
  readonly nowIso?: () => string;
  /** The shared core's writes 1-4. Injectable so a transition failure is one
   * test, not one filesystem. */
  readonly apply?: typeof applyCancellationTransition;
  /** The published tail, for the post-publication recovery branch. */
  readonly tail?: typeof runCancellationTail;
}

export type CandidateCancelCommit =
  | {
      readonly kind: "published";
      readonly state: FullSessionState;
      readonly tail: TailOutcome;
      readonly close: IntentWrite;
      /** True when this call resumed a crashed transition rather than
       * minting one: verify and finish, never redo. */
      readonly resumed: boolean;
    }
  | { readonly kind: "already-complete"; readonly close: IntentWrite; readonly detail: string }
  | {
      readonly kind: "refused";
      readonly stage:
        | "state-unreadable"
        | "validation"
        // See the note on the takeover result's own `invariant-violated` arm.
        | "invariant-violated"
        | "intent"
        | "ticket-txn"
        | "transition"
        | "tail-gate"
        | "resume-validation";
      readonly detail: string;
      readonly authorization?: CandidateAuthorization;
    };

/** The pre-publication resume checks (plan 6b, per-phase validation): the
 * candidate invariant and the per-phase revision equation, fingerprint
 * verbatim-equality against a FRESH probe (B-5), current eligibility, caller
 * identity, and session binding. Returns null when every check holds, else
 * the refusal detail. */
function refuseStashPendingResume(
  sessionDir: string,
  fresh: FullSessionState,
  t: Extract<CancellationTransition, { phase: "stash_pending" }>,
  callerTaskId: string,
  deps: CandidateHandshakeDeps,
): string | null {
  if (t.authority.kind !== "candidate") return "the recorded transition does not carry candidate authority";
  if (t.authority.clientTaskId !== callerTaskId) {
    return `the transition was recorded for task ${t.authority.clientTaskId}, not this caller`;
  }
  const belongs = transitionBelongsTo(fresh, t);
  if (!belongs.ok) return `the transition does not belong to this session: ${belongs.detail}`;
  if (t.transitionStartedRevision !== t.authority.confirmedSessionRevision + 1) {
    return `the candidate invariant fails on the record itself (transitionStartedRevision ` +
      `${t.transitionStartedRevision}, confirmedSessionRevision ${t.authority.confirmedSessionRevision})`;
  }
  const expected = t.stash.outcome === null ? t.transitionStartedRevision : t.transitionStartedRevision + 1;
  if (fresh.revision !== expected) {
    return `the session is at revision ${fresh.revision}, not the ${expected} the ` +
      `${t.stash.outcome === null ? "null" : "concrete"}-outcome equation requires; something else wrote ` +
      "this session after the crash, and resuming would publish over it";
  }
  const now = (deps.now ?? Date.now)();
  const verdict = readOwnerLiveness(
    sessionDir, deps.readState, now, deps.staleThresholdMs ?? OWNER_STALE_MS, deps.readSuccessors,
  );
  if (evidenceFingerprint(verdict.signals) !== t.authority.confirmedFingerprint) {
    return "the liveness picture changed since the confirmation this transition was published under; " +
      "re-authorization is required, not a blind resume";
  }
  if (!permitsRecoveryOffer(verdict)) {
    return `the session is no longer an owner-gone candidate (verdict ${verdict.kind})`;
  }
  return null;
}

/** The post-publication resume checks: durable authority only, NO live
 * eligibility re-evaluation (the session is terminal by this transition's own
 * doing, and the authority to finish was durably established at publication;
 * fingerprint inputs are not assumed stable across publication BY DESIGN). */
function refusePublishedResume(
  fresh: FullSessionState,
  t: Extract<CancellationTransition, { phase: "published" }>,
  callerTaskId: string,
): string | null {
  if (t.authority.kind !== "candidate") return "the recorded transition does not carry candidate authority";
  if (t.authority.clientTaskId !== callerTaskId) {
    return `the transition was recorded for task ${t.authority.clientTaskId}, not this caller`;
  }
  const belongs = transitionBelongsTo(fresh, t);
  if (!belongs.ok) return `the transition does not belong to this session: ${belongs.detail}`;
  if (t.transitionStartedRevision !== t.authority.confirmedSessionRevision + 1) {
    return `the candidate invariant fails on the record itself (transitionStartedRevision ` +
      `${t.transitionStartedRevision}, confirmedSessionRevision ${t.authority.confirmedSessionRevision})`;
  }
  if (t.terminalRevision !== t.transitionStartedRevision + 2) {
    return `the record fails the published revision equation (terminalRevision ${t.terminalRevision}, ` +
      `transitionStartedRevision ${t.transitionStartedRevision})`;
  }
  return null;
}

/**
 * COMMIT an owner-gone candidate CANCELLATION (ruling ea611619 Part C; the
 * plan-step6 phase table). Requires the ALREADY-HELD session lock; acquires
 * only the project lock, and only for the two ticket-transaction writes.
 *
 * The driver is a resume-first state machine over two durable records:
 *
 *   TRANSITION IN STATE (write 1 landed)
 *     stash_pending -> full pre-publication validation, then the shared
 *                      core's resume path (writes 3/4 and the tail).
 *     published     -> post-publication validation, the completion-marker
 *                      gate, then the tail DIRECTLY in mode "recovery".
 *   INTENT ONLY (pre-write-1)
 *     authorized      -> ticket txn if release work is owed, else straight
 *                        to the writes (the audited no-ticket-write path).
 *     prepared /
 *     ticket_applied  -> `recoverClaimTransaction` decides: redo the ticket
 *                        write, commit the epoch, remove the nonce, or clear
 *                        the intent; `recovery-required` refuses.
 *     claim_cleared   -> straight to the writes.
 *
 * Ticket work never re-runs after `ticket_applied` (the R2 rule): a moved
 * confirmation ADOPTS (same transitionId, re-minted pair, bumped epoch) when
 * work exists, and SUPERSEDES (new id, predecessor triple) when it does not.
 *
 * C2: the intent closes ONLY after write 4 is locally durable. Write 4
 * itself routes through the durable variant for candidate authority (the
 * shared core's barrier), and the close verifies the RE-READ persisted
 * transition, so a crash at any point leaves a retryable intent, never a
 * closed intent whose publication evaporated.
 */
export async function commitCandidateCancelLocked(
  root: string,
  sessionDir: string,
  args: {
    readonly input: CandidateHandshakeInput;
    readonly callerTask: OwnerTask;
  },
  deps: CandidateCancelDeps,
): Promise<CandidateCancelCommit> {
  const readState = deps.readState ?? (() => readSession(sessionDir));
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const apply = deps.apply ?? applyCancellationTransition;
  const tail = deps.tail ?? runCancellationTail;
  const withTicketLock = deps.withTicketLock
    ?? (async (fn: (io: CandidateTicketIO) => Promise<void>) => {
      const { withProjectLock, writeTicketUnlocked } = await import("../core/project-loader.js");
      await withProjectLock(root, { strict: false }, async ({ state: projectState }) => {
        await fn({
          load: (ticketId: string) => (projectState.ticketByID(ticketId) ?? null) as Ticket | null,
          write: async (ticket: Record<string, unknown>) => {
            await writeTicketUnlocked(ticket as unknown as Ticket, root);
          },
        });
      });
    });

  const fresh = readState();
  if (fresh === null) {
    return { kind: "refused", stage: "state-unreadable", detail:
      "the session state could not be read under the lock; a cancellation cannot be validated against " +
      "a state nobody can load" };
  }

  // SERVER-DERIVED, from the state under the lock rather than from the caller's
  // pre-lock snapshot. These used to be read off `args.input`, which is the
  // provenance defect the handshake split closes: the audit records below name
  // a ticket and an epoch, and naming the ones the caller happened to see
  // before acquiring the lock would let the record disagree with what the
  // transaction actually ran against.
  const freshEpoch = parseClaimEpoch((fresh as Record<string, unknown>).claimEpoch);
  const freshTicketId = fresh.ticket?.id ?? null;

  // THE INTENT, classified first (startup order: canonical intent, then the
  // transition record; archives are never consulted for authority).
  const intentRead = readCancellationIntent(sessionDir);
  if (intentRead.kind === "unreadable" || intentRead.kind === "malformed") {
    return { kind: "refused", stage: "intent", detail:
      `the durable intent is ${intentRead.kind}; an unreadable intent is never absence, and a ` +
      "cancellation may not write past evidence it cannot read" };
  }
  if (intentRead.kind === "valid" && intentRead.intent.clientTaskId !== args.callerTask.id) {
    return { kind: "refused", stage: "intent", detail:
      "a durable intent from another task exists; it is that attempt's evidence, and this cancellation " +
      "may not adopt or overwrite it" };
  }

  // A CLOSED intent: this cycle already ended. Report which way, honestly.
  if (intentRead.kind === "valid" && intentRead.intent.phase === "closed") {
    const c = intentRead.intent;
    if (c.outcome.kind === "takeover") {
      return { kind: "refused", stage: "intent", detail:
        "this cycle already closed as a TAKEOVER; a cancellation of the taken-over session is a new " +
        "cycle and requires retirement first" };
    }
    const close = closeCancellationIntentOnPublication(sessionDir, {
      cancellationTransition: (fresh as unknown as Record<string, unknown>).cancellationTransition,
      sessionRevision: fresh.revision,
    });
    return { kind: "already-complete", close, detail:
      `this cycle already closed on cancellation ${c.outcome.transitionId}` };
  }

  // TRANSITION-RECORD RESUME. Write 1 landing is the point of no return for
  // the identity: from here every path finishes THIS transition or refuses.
  const tRead = readCancellationTransition(
    (fresh as unknown as Record<string, unknown>).cancellationTransition,
  );
  if (tRead.kind === "valid" && tRead.transition.authority.kind === "candidate") {
    const t = tRead.transition;
    if (intentRead.kind !== "valid" || intentRead.intent.transitionId !== t.transitionId) {
      return { kind: "refused", stage: "resume-validation", detail:
        "a candidate transition is recorded but the durable intent that minted it is " +
        (intentRead.kind === "valid" ? "another cycle's" : "missing") +
        "; finishing it blind would adopt a transition whose preparation cannot be checked" };
    }
    if (t.phase === "stash_pending") {
      const refusal = refuseStashPendingResume(sessionDir, fresh, t, args.callerTask.id, deps.handshake);
      if (refusal !== null) {
        return { kind: "refused", stage: "resume-validation", detail: refusal };
      }
      let applied: Awaited<ReturnType<typeof applyCancellationTransition>>;
      try {
        applied = await apply(root, { dir: sessionDir, state: fresh }, t.disposition as TicketDisposition, t);
      } catch (err) {
        return { kind: "refused", stage: "transition", detail:
          `the resumed transition failed (${err instanceof Error ? err.message : "unknown error"}); the ` +
          "record and intent are unchanged and the resume is retryable" };
      }
      const after = readState();
      const close = closeCancellationIntentOnPublication(sessionDir, {
        cancellationTransition: after === null
          ? undefined
          : (after as unknown as Record<string, unknown>).cancellationTransition,
        sessionRevision: after?.revision ?? applied.written.revision,
      });
      return { kind: "published", state: applied.written, tail: applied.tail, close, resumed: true };
    }
    // published: tail-only recovery. The marker gate answers "may this tail
    // re-run", and only the TEXT of each refusal is ours.
    const refusal = refusePublishedResume(fresh, t, args.callerTask.id);
    if (refusal !== null) {
      return { kind: "refused", stage: "resume-validation", detail: refusal };
    }
    const gate = classifyTailRecovery(sessionDir, t.transitionId);
    if (gate.kind === "already-complete") {
      const close = closeCancellationIntentOnPublication(sessionDir, {
        cancellationTransition: (fresh as unknown as Record<string, unknown>).cancellationTransition,
        sessionRevision: fresh.revision,
      });
      return { kind: "already-complete", close, detail:
        `transition ${t.transitionId} already completed; its marker is durable` };
    }
    if (gate.kind === "refuse") {
      return { kind: "refused", stage: "tail-gate", detail:
        gate.classification === "foreign"
          ? `the completion marker names a DIFFERENT transition (${gate.owner}); finishing this one would ` +
            "destroy the only trace of a conflict"
          : `the completion marker is ${gate.classification} (${gate.detail}); ownership is unprovable, so ` +
            "neither repairing nor declaring completion would be honest" };
    }
    const tailOutcome = tail(root, { dir: sessionDir, state: fresh }, {
      published: t,
      disposition: t.disposition as TicketDisposition,
      stashPopFailed: t.stash.outcome === "failed",
      previousState: (fresh as unknown as Record<string, unknown>).previousState as string ?? fresh.state,
      terminalRevision: t.terminalRevision,
      mode: "recovery",
    });
    const close = closeCancellationIntentOnPublication(sessionDir, {
      cancellationTransition: (fresh as unknown as Record<string, unknown>).cancellationTransition,
      sessionRevision: fresh.revision,
    });
    return { kind: "published", state: fresh, tail: tailOutcome, close, resumed: true };
  }
  if (tRead.kind === "valid") {
    return { kind: "refused", stage: "resume-validation", detail:
      "this session carries a NON-candidate cancellation transition; another path's work is in flight " +
      "and the candidate driver may not finish it" };
  }

  // PRE-WRITE-1: full validation, always, because everything from here mints
  // or advances durable records against the CURRENT state.
  const authorization = await authorizeCandidateCancel(sessionDir, args.input, deps.handshake);
  // The cancel twin of the invariant guard documented at the takeover commit
  // above, kept for the same reason and refused in the same distinguishable
  // shape.
  if (authorization.kind === "authorized" && authorization.operation !== "cancel") {
    return { kind: "refused", stage: "invariant-violated", authorization, detail:
      "PROGRAMMING ERROR, not a policy refusal: this cancellation commit received an authorization " +
      `stamped "${authorization.operation}". The cancel entry point stamps its own tag, so this cannot ` +
      "happen unless the call above has been repointed. Fix the wiring; do NOT loosen this check or " +
      "the authorization policy." };
  }
  if (authorization.kind !== "authorized") {
    return { kind: "refused", stage: "validation", authorization, detail:
      `re-validation under the lock returned ${authorization.kind}; the cancellation commits only what ` +
      "a fresh five-step handshake would authorize right now" };
  }
  const authority = authorization.authority;

  // SETTLE THE INTENT: create, resume, adopt, or supersede.
  let intent: CancellationIntent;
  if (intentRead.kind === "absent") {
    const startedAt = canonicalStartedAt((fresh as unknown as Record<string, unknown>).startedAt);
    if (startedAt === null) {
      return { kind: "refused", stage: "intent", detail:
        "this session's start time is unusable, so no durable intent can bind provenance; the candidate " +
        "path refuses rather than degrading to a recordless cancel" };
    }
    const created = createCancellationIntent(sessionDir, {
      schemaVersion: 1,
      transitionId: randomUUID(),
      confirmationEpoch: 0,
      clientTaskId: args.callerTask.id,
      sessionId: args.input.sessionId,
      sessionStartedAt: startedAt,
      confirmedSessionRevision: authority.confirmedSessionRevision,
      confirmedFingerprint: authority.confirmedFingerprint,
      evidence: authority.evidence,
      ticketPreimage: authorization.ticketWork.kind === "release" ? authorization.ticketWork.preimage : null,
      phase: "authorized",
    } as NewCycleIntent);
    if (!created.ok) {
      return { kind: "refused", stage: "intent", detail:
        `the durable intent could not be created (${created.reason}): ${created.detail}` };
    }
    intent = created.intent;
  } else {
    intent = intentRead.intent;
    const confirmationMoved =
      intent.confirmedSessionRevision !== authority.confirmedSessionRevision ||
      intent.confirmedFingerprint !== authority.confirmedFingerprint;
    // THE TICKET IS A SECOND, INDEPENDENT AXIS. The confirmation pair
    // describes the SESSION; the claim lives in a ticket file that can change
    // without moving either field, so a resume that consults only the
    // confirmation can inherit a `ticketPreimage` the live ledger contradicts.
    // Both directions are wrong in the same way. A null preimage against
    // fresh release work skips the transaction and publishes `no-ticket` over
    // a claim still held; a recorded preimage against no fresh work abandons
    // a release the record promised. Either way the audit record and the
    // ticket disagree, which is the one thing this whole path exists to
    // prevent.
    //
    // ONLY WHILE `authorized`. Once work has begun the preimage is the audit
    // identity of writes that already happened, and re-deriving it would
    // rewrite their history; that phase is adoption's territory, and a ticket
    // that no longer matches either side of the recorded transaction is
    // answered by `recoverClaimTransaction` with recovery-required, which is
    // the honest refusal.
    const freshPreimage = authorization.ticketWork.kind === "release"
      ? authorization.ticketWork.preimage
      : null;
    const ticketWorkMoved = intent.phase === "authorized"
      && !deepEquals(intent.ticketPreimage ?? null, freshPreimage ?? null);
    if (confirmationMoved || ticketWorkMoved) {
      const workBegun = intent.phase === "ticket_applied" || intent.phase === "claim_cleared";
      if (workBegun) {
        // R2 ADOPTION: the id is the audit identity of work that exists.
        const adopted = readoptCancellationIntent(sessionDir, {
          transitionId: intent.transitionId,
          confirmationEpoch: intent.confirmationEpoch + 1,
          confirmedSessionRevision: authority.confirmedSessionRevision,
          confirmedFingerprint: authority.confirmedFingerprint,
          evidence: authority.evidence,
        });
        if (!adopted.ok) {
          return { kind: "refused", stage: "intent", detail:
            `adoption of the moved confirmation failed (${adopted.reason}): ${adopted.detail}` };
        }
        intent = adopted.intent;
      } else {
        // SUPERSESSION: work has not begun, so the id retires with its
        // confirmation. Archive-first; the canonical pathname is never freed.
        const superseded = supersedeCancellationIntent(sessionDir, {
          schemaVersion: 1,
          transitionId: randomUUID(),
          confirmationEpoch: intent.confirmationEpoch + 1,
          clientTaskId: args.callerTask.id,
          sessionId: intent.sessionId,
          sessionStartedAt: intent.sessionStartedAt,
          confirmedSessionRevision: authority.confirmedSessionRevision,
          confirmedFingerprint: authority.confirmedFingerprint,
          evidence: authority.evidence,
          ticketPreimage: authorization.ticketWork.kind === "release" ? authorization.ticketWork.preimage : null,
          predecessor: {
            predecessorTransitionId: intent.transitionId,
            predecessorEpoch: intent.confirmationEpoch,
            predecessorFingerprint: intent.confirmedFingerprint,
          },
          phase: "authorized",
        } as NewCycleIntent);
        if (!superseded.ok) {
          return { kind: "refused", stage: "intent", detail:
            `supersession of the moved confirmation failed (${superseded.reason}): ${superseded.detail}` };
        }
        intent = superseded.intent;
      }
    }
  }

  // THE TICKET TRANSACTION. Entered when release work is owed and the intent
  // has not yet cleared it; every step is decided by `recoverClaimTransaction`
  // so a fresh pass and a crash retry are the same code path.
  //
  // SEEDED FROM THE DURABLE PHASE, not from `false`. A retry can arrive with
  // the transaction already cleared, in which case neither the opener nor the
  // loop below runs and a `false` seed would publish a disposition denying a
  // release the previous pass really performed -- an audit record contradicted
  // by the ticket it describes. `claim_cleared` is reachable only through this
  // transaction, so the phase IS the record that the release happened, and
  // the preimage is what names the ticket it happened to.
  let released = intent.phase === "claim_cleared" && intent.ticketPreimage !== null;
  // DRIVEN BY THE DURABLE INTENT, not by a second reading of the
  // authorization. Settlement above guarantees that an `authorized` intent's
  // preimage agrees with what a fresh authorization just found, so gating
  // here on `authorization.ticketWork.kind` again would only reintroduce the
  // chance for the two to disagree.
  if (intent.phase === "authorized" && intent.ticketPreimage) {
    const preimage = intent.ticketPreimage;
    const txn = {
      kind: "release",
      ticketId: preimage.ticketId,
      transitionId: intent.transitionId,
      fromEpoch: freshEpoch,
      toEpoch: null,
      fromBusiness: preimage,
      toBusiness: releasedPostimageOf(preimage),
      startedAt: nowIso(),
      phase: "prepared",
    };
    const advanced = advanceCancellationIntent(sessionDir, {
      ...intent, phase: "prepared", claimTxn: txn,
    } as unknown as CancellationIntent);
    if (!advanced.ok) {
      return { kind: "refused", stage: "intent", detail:
        `the intent could not record the prepared transaction (${advanced.reason}): ${advanced.detail}` };
    }
    intent = advanced.intent;
  }
  while (intent.phase === "prepared" || intent.phase === "ticket_applied") {
    const txn = intent.claimTxn as unknown as ClaimTxn;
    let stepRefusal: string | null = null;
    let nextPhase: "ticket_applied" | "claim_cleared" | null = null;
    try {
      await withTicketLock(async (io) => {
        const live = io.load(txn.ticketId);
        if (live === null) {
          stepRefusal = `ticket ${txn.ticketId} could not be loaded under the lock`;
          return;
        }
        const observed = observedSnapshotOf(live, txn.ticketId);
        const nonce = (live as unknown as Record<string, unknown>).claimTxnId;
        const verdict = recoverClaimTransaction(
          { ...txn, phase: intent.phase as "prepared" | "ticket_applied" },
          { observed, nonce: typeof nonce === "string" ? nonce : null },
        );
        switch (verdict.action) {
          case "apply-mutation": {
            const mutated = applySnapshotToTicket(live, txn.toBusiness as unknown as TicketSnapshot);
            mutated.claimTxnId = txn.transitionId;
            await io.write(mutated);
            nextPhase = "ticket_applied";
            return;
          }
          case "commit-epoch":
            nextPhase = "ticket_applied";
            return;
          case "remove-nonce": {
            const cleared = { ...(live as unknown as Record<string, unknown>) };
            delete cleared.claimTxnId;
            await io.write(cleared);
            nextPhase = "claim_cleared";
            return;
          }
          case "clear-intent":
            nextPhase = "claim_cleared";
            return;
          case "recovery-required":
            stepRefusal =
              `the ticket does not match either side of the ${intent.phase} transaction; something ` +
              "else moved it, and neither redoing nor skipping the write would be honest";
            return;
        }
      });
    } catch (err) {
      return { kind: "refused", stage: "ticket-txn", detail:
        `the ticket transaction failed (${err instanceof Error ? err.message : "unknown error"}); the ` +
        "durable intent still records the phase, so a retry resumes exactly here" };
    }
    if (stepRefusal !== null) {
      return { kind: "refused", stage: "ticket-txn", detail: stepRefusal };
    }
    if (nextPhase === null) {
      return { kind: "refused", stage: "ticket-txn", detail:
        "the ticket transaction step decided nothing; refusing rather than guessing" };
    }
    const advanced = advanceCancellationIntent(sessionDir, (nextPhase === "ticket_applied"
      ? { ...intent, phase: "ticket_applied", claimTxn: { ...(intent.claimTxn as object), phase: "ticket_applied" } }
      : (() => {
          const { claimTxn: _txn, ...rest } = intent as unknown as Record<string, unknown> & { claimTxn: unknown };
          return { ...rest, phase: "claim_cleared" };
        })()) as unknown as CancellationIntent);
    if (!advanced.ok) {
      return { kind: "refused", stage: "intent", detail:
        `the intent could not record the ${nextPhase} step (${advanced.reason}): ${advanced.detail}` };
    }
    intent = advanced.intent;
    if (nextPhase === "claim_cleared") released = true;
  }

  // THE DISPOSITION, from what actually happened, never from a belief.
  const disposition: TicketDisposition = released
    ? { kind: "released", ticketId: intent.ticketPreimage!.ticketId }
    : authorization.ticketWork.kind === "none"
      ? authorization.ticketWork.why === "no-ticket"
        ? { kind: "no-ticket" }
        : { kind: "conflict", ticketId: freshTicketId ?? freshEpoch?.ticketId ?? "" }
      : authorization.ticketWork.kind === "blocked"
        ? { kind: "failed", ticketId: freshTicketId ?? freshEpoch?.ticketId ?? "" }
        : { kind: "no-ticket" };

  // WRITES 1-4 AND THE TAIL. The state must not have moved since validation:
  // the candidate invariant is checked by the shared core against the
  // snapshot we hand it, so hand it the freshest one and let a mismatch
  // refuse there (that refusal is the invariant doing its job).
  const now = readState();
  if (now === null) {
    return { kind: "refused", stage: "state-unreadable", detail:
      "the session state disappeared between validation and the transition; nothing was published" };
  }
  let applied: Awaited<ReturnType<typeof applyCancellationTransition>>;
  try {
    applied = await apply(root, { dir: sessionDir, state: now }, disposition, undefined, {
      transitionId: intent.transitionId,
      action: "candidate_recovery_takeover",
      authority,
    });
  } catch (err) {
    return { kind: "refused", stage: "transition", detail:
      `the transition refused or failed (${err instanceof Error ? err.message : "unknown error"}); the ` +
      "durable intent is unchanged, so re-authorization and retry remain available" };
  }

  // C2: close ONLY against the RE-READ persisted publication.
  const after = readState();
  const close = closeCancellationIntentOnPublication(sessionDir, {
    cancellationTransition: after === null
      ? undefined
      : (after as unknown as Record<string, unknown>).cancellationTransition,
    sessionRevision: after?.revision ?? applied.written.revision,
  });
  return { kind: "published", state: applied.written, tail: applied.tail, close, resumed: false };
}

/** The session-lock-acquiring wrapper, mirroring the takeover's: exactly one
 * acquisition here, none in the locked form. */
export async function commitCandidateCancelWithSessionLock(
  root: string,
  sessionDir: string,
  args: {
    readonly input: CandidateHandshakeInput;
    readonly callerTask: OwnerTask;
  },
  deps: CandidateCancelDeps,
): Promise<CandidateCancelCommit> {
  return withSessionLock(root, () => commitCandidateCancelLocked(root, sessionDir, args, deps));
}
