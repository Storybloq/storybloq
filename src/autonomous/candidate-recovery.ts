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
 * ORDERS the two states; only the directory fsync makes the ordering survive
 * power loss. Each barrier is followed by an `__intentTesting.at` point so the
 * crash-injection suite can stop the world after every filesystem operation
 * and assert the invariants above.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  CANCELLATION_INTENT_FILE,
  CancellationIntentSchema,
  type CancellationIntent,
  type PersistedLivenessEvidence,
} from "./session-types.js";
import { canonicalStartedAt } from "./cancellation-core.js";

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

/** Exclusive create + fsync, with an injection point after each operation.
 * Throws EEXIST through to the caller, whose situation table decides. */
function writeExclusiveDurable(path: string, text: string, points: readonly [string, string]): void {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, text);
    __intentTesting.at(points[0]);
    fsyncSync(fd);
    __intentTesting.at(points[1]);
  } finally {
    closeSync(fd);
  }
}

/** Atomic replace: fsync'd temp, rename over the canonical name, directory
 * fsync. The canonical pathname is never absent at any instant. */
function replaceDurable(sessionDir: string, text: string, pointPrefix: string): void {
  const tmp = intentPath(sessionDir) + ".tmp";
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
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
      | "archive-conflict";
      readonly detail: string };

/** The only way an intent comes into existence: exclusive create (`wx`). A
 * present intent, whatever its state, routes through classification. */
export function createCancellationIntent(sessionDir: string, intent: CancellationIntent): IntentWrite {
  try {
    writeExclusiveDurable(intentPath(sessionDir), serialize(intent), ["create:written", "create:fsynced"]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, reason: "exists", detail: "an intent already exists at the canonical pathname" };
    }
    throw err;
  }
  fsyncPath(sessionDir);
  __intentTesting.at("create:dir-fsynced");
  return { ok: true, intent };
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
  if (next.transitionId !== c.transitionId || next.confirmationEpoch !== c.confirmationEpoch
    || next.sessionId !== c.sessionId || next.sessionStartedAt !== c.sessionStartedAt
    || next.clientTaskId !== c.clientTaskId
    || next.confirmedSessionRevision !== c.confirmedSessionRevision
    || next.confirmedFingerprint !== c.confirmedFingerprint) {
    return { ok: false, reason: "identity-mismatch", detail:
      "advancement must carry the canonical intent's identity and confirmation verbatim" };
  }
  if (ALLOWED_EDGES[c.phase] !== next.phase) {
    return { ok: false, reason: "edge-refused", detail:
      `the only edge from ${c.phase} is ${ALLOWED_EDGES[c.phase] ?? "none"}, not ${next.phase}` };
  }
  replaceDurable(sessionDir, serialize(next), "advance");
  return { ok: true, intent: next };
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

  // Crash-after-rename retry: the replacement already IS the canonical intent.
  if (c.transitionId === replacement.transitionId && c.confirmationEpoch === replacement.confirmationEpoch) {
    return { ok: true, intent: c };
  }

  if (c.phase === "ticket_applied" || c.phase === "claim_cleared" || c.phase === "closed") {
    return { ok: false, reason: "ticket-work-begun", detail:
      `the canonical intent is at ${c.phase}; once ticket work exists its transitionId is the audit ` +
      "identity of that work, and re-authorization adopts rather than supersedes" };
  }
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
    writeExclusiveDurable(archive, current.raw, ["supersede:archive-written", "supersede:archive-fsynced"]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let archived: string;
    try {
      archived = readFileSync(archive, "utf-8");
    } catch (readErr) {
      return { ok: false, reason: "archive-conflict", detail:
        `an archive already exists at ${archive} and could not be read (${(readErr as NodeJS.ErrnoException).code})` };
    }
    if (archived !== current.raw) {
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
  if (c.phase !== "ticket_applied" && c.phase !== "claim_cleared") {
    return { ok: false, reason: "no-ticket-work", detail:
      `the canonical intent is at ${c.phase}; before ticket work exists, re-authorization supersedes rather than adopts` };
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
  };
  replaceDurable(sessionDir, serialize(next), "adopt");
  return { ok: true, intent: next };
}
