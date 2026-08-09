import { join } from "node:path";
import { z } from "zod";
import { resolveInitializedBusPaths } from "./admin.js";
import { canonicalHash, hashWithoutKey } from "./canonical.js";
import { endpointAddressees, listEndpoints } from "./endpoints.js";
import { BusError } from "./errors.js";
import { durableWrite, listRegularJsonFiles, readJsonNoFollow } from "./io.js";
import { resolveBusPaths, validatedRedeliverMarkerDir, type BusPaths } from "./paths.js";
import { readConsistentRefusedArtifact } from "./refused.js";
import {
  BUS_MAX_ENTRY_BYTES,
  BusEntrySchema,
  BusRedeliverMarkerSchema,
  BusThreadRecordSchema,
  type BusAckPayload,
  type BusEntry,
  type BusMessagePayload,
  type BusRefusal,
  type FoldedBusThread,
} from "./schemas.js";
import { evidenceKeys } from "./security.js";

const ThreadIdSchema = z.string().uuid();
const ENTRY_FILENAME = /^(\d{6})-(message|ack|state|wake)-([0-9a-f-]{36})\.json$/;
function participantsInclude(participants: readonly [string, string], endpointId: string): boolean {
  return participants[0] === endpointId || participants[1] === endpointId;
}
const BusDerivedRecordSchema = z.object({
  schema: z.literal("storybloq-bus-derived/v1"),
  threadId: z.string().uuid(),
  lastSeq: z.number().int().nonnegative(),
  lastHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["open", "parked", "resolved"]),
  hopCount: z.number().int().nonnegative(),
  pendingMessageIds: z.array(z.string().uuid()),
  integrity: z.enum(["verified", "quarantined"]),
  finding: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

function entryHash(entry: BusEntry): string {
  return hashWithoutKey(entry as unknown as Record<string, unknown>, "entryHash");
}

function threadHash(thread: z.infer<typeof BusThreadRecordSchema>): string {
  return hashWithoutKey(thread as unknown as Record<string, unknown>, "threadHash");
}

function ackTransitionAllowed(previous: BusAckPayload | undefined, next: BusAckPayload): boolean {
  if (!previous) return true;
  if (previous.disposition === next.disposition && previous.reason === next.reason) return true;
  return previous.disposition === "deferred" &&
    (next.disposition === "accepted" || next.disposition === "rejected");
}

function actionableMessage(message: BusMessagePayload): boolean {
  return ["issue_notice", "question", "reply", "patch_request"].includes(message.kind);
}

// ISS-953: read one predecessor's redeliver marker for one park entry. Absence is
// NOT an error (the ordinary, common case: no redeliver has been attempted yet).
async function readRedeliverMarker(
  paths: BusPaths,
  predecessorThreadId: string,
  entryHash: string,
): Promise<
  | { status: "none" }
  | { status: "invalid" }
  | { status: "present"; record: z.infer<typeof BusRedeliverMarkerSchema> }
> {
  // validatedRedeliverMarkerDir guards the redeliver-markers DIRECTORY itself
  // against being a symlink -- readJsonNoFollow below only guards the leaf
  // <hash>.json component, and path resolution traverses the directory first.
  try {
    const dir = await validatedRedeliverMarkerDir(paths, predecessorThreadId, { create: false });
    if (!dir) return { status: "none" };
    const target = join(dir, `${entryHash}.json`);
    const record = await readJsonNoFollow(target, BusRedeliverMarkerSchema);
    return { status: "present", record };
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return { status: "none" };
    // Schema failure, symlink (leaf or directory), or any other read failure: a
    // marker that exists but cannot be trusted is a genuine data-integrity
    // finding, never silently treated as absent (that would mask corruption --
    // ISS-953 fix step 12's finding #1).
    return { status: "invalid" };
  }
}

// ISS-953: verify a marker's claimed successor using ONLY that successor's CORE
// fold (no `includeRefusals` -- foldBusThread called with no opts, so this can
// never trigger the successor's OWN refusal resolution regardless of how deep a
// rollover chain runs). "pending" (successor not landed yet) is distinguished
// from "invalid" (something is actually wrong) -- but "pending" is NOT itself a
// trust verdict (CORRECTED, ISS-953 Codex round 5 finding #10 / ISS-1002): it
// means "no successor exists yet to check anything against," which is equally
// true of the benign crash/in-flight window this function was originally
// written to describe AND of a forged marker naming a successorThreadId that
// was never legitimately assigned by anyone -- this function cannot tell those
// two apart, because there is nothing on the successor side yet to verify
// either claim against. Reproduced and confirmed: a bindings-valid marker
// naming a nonexistent successorThreadId, planted by a direct write to the
// real redeliver-markers directory (no race, no swap needed at all), reaches
// "pending" here and was then adopted unconditionally by
// createHopCapSuccessorThread's caller, publishing a real thread under the
// attacker-chosen id. store.ts's createHopCapSuccessorThread no longer trusts
// a "pending" verdict's successorThreadId as a result (ISS-1002 interim
// remedy): it treats "pending" as "unverifiable, start over," mints its own
// fresh id, and durably supersedes the untrusted marker rather than adopting it.
// ISS-953 Codex round 2 finding #14: every prior version of this function
// returned only a bare status string, so both store.ts callers that need to
// ACT on "verified" (not just record it) discarded this function's own fold
// and folded the successor a SECOND time to build their response -- checking
// only integrity and that entry zero is a message on that second read, never
// re-running the provenance/artifact checks this function just did. The
// successor directory can change in the window between the two folds, so
// that second, unverified fold could return identifiers and recipient data
// from a successor that was never actually checked against the marker,
// predecessor, or refused artifact. Returning the validated FoldedBusThread
// (and its already-narrowed first message) directly from here removes the
// second fold entirely -- callers construct their response from the SAME
// snapshot this function verified, not a fresh, unverified one.
//
// ISS-953 Codex round 2 findings #19/#22: `trigger` is the park entry's OWN
// recorded trigger for the refusal this marker claims to resolve -- a
// duplicate_fingerprint park has no redeliver path at all (same rule
// nextActionForPark and both store.ts creation-time guards already enforce
// UPSTREAM of ever calling this function). SCOPED (ISS-953 Codex round 5
// finding #10 / ISS-1002): this function's purpose is deciding whether a
// successor that ACTUALLY EXISTS on disk is trustworthy, without relying on
// in-process checks that only constrain the legitimate creation path -- that
// claim holds for every check below, all of which run only once a successor
// is found. It does NOT hold for "pending" (no successor exists yet): there
// is nothing on disk yet for this or any check here to verify, so a caller
// must not read "pending" as "checked and provisionally fine" -- see the
// header comment above and store.ts's ISS-1002 remedy. The trigger check
// immediately below is one of the checks that DOES apply once a successor
// exists, exactly the reasoning the authorship-binding check further down
// already applies.
// store.ts's two callers already reject a non-hop_cap parkEntry before ever
// reaching this function, so passing their trigger through here is a
// redundant, zero-behavior-change confirmation. resolveRefusals below is the
// one caller that iterates EVERY park entry unconditionally (the doctor/
// ship-gate diagnostic path) with no such upstream guard -- without this
// check, a hand-forged marker naming a duplicate_fingerprint park entry, but
// otherwise satisfying every structural/content/authorship check above,
// could report markerState "verified" and disposition "redelivered",
// incorrectly clearing a critical refusal at the ship gate.
export async function verifiedSuccessorState(
  paths: BusPaths,
  marker: z.infer<typeof BusRedeliverMarkerSchema>,
  entryHash: string,
  artifact: { messageKind: string; severity: string; body: string; refs: unknown } | null,
  trigger: "hop_cap" | "duplicate_fingerprint",
  // ISS-953 Codex round 3 finding #1: the predecessor thread this marker claims
  // to resolve, ALREADY folded and verified by every call site before it ever
  // calls this function (createHopCapSuccessorThread, redeliverBusMessage's
  // marker-hit path, and resolveRefusals's own `folded` parameter) -- passed
  // through rather than re-folded here, both to avoid a redundant fold and
  // because resolveRefusals's caller already IS that fold.
  predecessor: FoldedBusThread,
): Promise<
  | { status: "pending" }
  | { status: "invalid" }
  | { status: "verified"; fold: FoldedBusThread; message: BusMessagePayload }
> {
  if (trigger !== "hop_cap") return { status: "invalid" };
  let successorFold: FoldedBusThread;
  try {
    successorFold = await foldBusThread(paths.projectRoot, marker.successorThreadId);
  } catch (err) {
    if (err instanceof BusError && err.code === "not_found") return { status: "pending" };
    return { status: "invalid" };
  }
  if (successorFold.integrity !== "verified") return { status: "invalid" };
  const successorThread = successorFold.thread;
  if (
    successorThread.predecessorRelation !== "hop_cap_successor" ||
    successorThread.predecessorEntryHash !== entryHash ||
    successorThread.predecessorThreadId !== marker.predecessorThreadId ||
    successorThread.threadId !== marker.successorThreadId
  ) {
    return { status: "invalid" };
  }
  // Require the successor's actual first IMMUTABLE entry to be the message,
  // not merely that a message exists somewhere in it: successorFold.messages
  // only collects entries of type "message" in order, so a successor whose
  // real entry seq 1 is something else (e.g. a "wake" entry, which the core
  // fold loop above accepts without touching state/messages at all) with a
  // matching message at seq 2 would otherwise report messages[0] as that later
  // message and verify -- even though the thread's actual first entry was
  // never checked against the artifact at all.
  const firstEntry = successorFold.entries[0];
  if (!firstEntry || firstEntry.type !== "message") return { status: "invalid" };
  const firstMessage = firstEntry.payload;
  if (!artifact) return { status: "invalid" };
  if (
    firstMessage.kind !== artifact.messageKind ||
    firstMessage.severity !== artifact.severity ||
    firstMessage.body !== artifact.body ||
    canonicalHash(firstMessage.refs) !== canonicalHash(artifact.refs)
  ) {
    return { status: "invalid" };
  }
  // Authorship binding: everything above verifies the successor's STRUCTURE and
  // CONTENT self-consistently against the marker and the artifact, but nothing
  // yet ties WHO actually produced it back to the original sender the marker
  // names. A thread record and first message satisfying every check above could
  // still be forged directly on disk (bypassing createHopCapSuccessorThread's
  // own in-lock authorization entirely) by any writer, attributing authorship to
  // an unrelated endpoint -- and this check's purpose is to decide whether an
  // EXISTING successor's ON-DISK data is trustworthy, not to re-run the
  // in-process checks that only apply to the original, legitimate creation
  // path (see the header comment above: this reasoning only applies once a
  // successor exists to check -- it is not a trust claim about "pending").
  // Require the
  // thread record's own createdByEndpoint to match the first message's sender
  // (a forged thread record and a forged first message must at least agree with
  // each other), and require THAT endpoint's succession chain to reach
  // marker.originalByEndpoint -- the same endpointAddressees check
  // createHopCapSuccessorThread itself uses at creation time, re-applied here
  // against whatever the marker and successor actually claim now.
  if (successorThread.createdByEndpoint !== firstMessage.from.endpointId) {
    return { status: "invalid" };
  }
  const { endpoints: allEndpoints, findings: endpointFindings } = await listEndpoints(paths.projectRoot);
  if (endpointFindings.length > 0) return { status: "invalid" };
  const creator = allEndpoints.find((candidate) => candidate.endpointId === successorThread.createdByEndpoint);
  if (!creator) return { status: "invalid" };
  const addressees = endpointAddressees(creator, allEndpoints);
  if (addressees.corrupt || !addressees.ids.includes(marker.originalByEndpoint)) {
    return { status: "invalid" };
  }
  // ISS-953 Codex round 3 finding #1: everything above verifies the successor's
  // SENDER and content against the marker and artifact, but nothing yet ties the
  // successor back to the predecessor CONVERSATION it claims to preserve. A
  // coherently forged successor satisfying every check above could still
  // redirect the recipient, or detach from the predecessor's issue/kind, while
  // still reporting "verified" and clearing the ship gate. createHopCapSuccessorThread
  // hard-codes kind: "issue_notice" and topicRef: { issue: predecessor's issue }
  // at creation time (never trusting the caller's own declared threadKind/refs
  // for this relation) -- re-derive that exact invariant from the ALREADY-
  // VERIFIED predecessor fold, rather than hardcoding it a second time, so a
  // predecessor whose own kind/topicRef ever change stays the single source of
  // truth.
  // Pen's review (S7 round 3, order item 4 return): comparing successorThread.kind
  // only to predecessor.thread.kind checks CONSISTENCY, not the creation
  // invariant itself -- createHopCapSuccessorThread's own
  // `predecessor.thread.kind !== "issue_notice"` guard refuses the call outright
  // unless the PREDECESSOR's own kind is "issue_notice" (checked BEFORE the
  // hard-coded "issue_notice" is ever written), and hop-cap park itself has no
  // thread-kind gate (store.ts's automatic-park path keys only on message kind
  // and hop count), so a genuine "question" thread can carry a hop-cap park with
  // a critical droppedMessage. Without this clause, a forged "question"-kind
  // successor over a genuine "question" predecessor would satisfy mere
  // consistency and verify. Re-deriving from a source is only equivalent to
  // hardcoding when that source is ITSELF pinned to the invariant -- the
  // predecessor fold is verified for hash-chain INTEGRITY, never for kind, so
  // this clause pins the kind half explicitly, mirroring that same guard.
  if (
    predecessor.thread.kind !== "issue_notice" ||
    !predecessor.thread.topicRef.issue ||
    successorThread.kind !== predecessor.thread.kind ||
    canonicalHash(successorThread.topicRef) !== canonicalHash({ issue: predecessor.thread.topicRef.issue })
  ) {
    return { status: "invalid" };
  }
  // Recipient binding: the preserved message must reach the predecessor's OTHER
  // participant (never the endpoint that authored the dropped message itself)
  // or a legitimate successor of it. ISS-953 Codex round 4 finding #1: this used
  // to select via literal inequality against marker.originalByEndpoint, which
  // only works when originalByEndpoint IS one of the two original participants
  // directly -- when it is a successor's id instead (the same shape round 3's
  // finding #10 already fixed on the CREATE side, createHopCapSuccessorThread's
  // own callerAddressees/authorSideParticipants derivation), `.find` returns
  // whichever participant happens to sit first in the array regardless of which
  // side actually authored the drop, silently right in some orderings and
  // silently wrong in others. Mirror that same mechanism instead of re-
  // describing it: `addressees` above is already the creator's validated,
  // non-corrupt succession chain, already confirmed above to reach
  // marker.originalByEndpoint -- exactly analogous to store.ts's already-
  // validated callerAddressees confirmed to reach byEndpoint.
  // Intersecting it with the predecessor's two original participants identifies
  // the author side directly; require exactly one match, then select the other.
  const authorSideParticipants = predecessor.thread.participants.filter((id) => addressees.ids.includes(id));
  if (authorSideParticipants.length !== 1) return { status: "invalid" };
  const predecessorOtherParticipant = predecessor.thread.participants.find((id) => id !== authorSideParticipants[0]);
  if (!predecessorOtherParticipant) return { status: "invalid" };
  const recipient = allEndpoints.find((candidate) => candidate.endpointId === firstMessage.to);
  if (!recipient) return { status: "invalid" };
  const recipientAddressees = endpointAddressees(recipient, allEndpoints);
  if (recipientAddressees.corrupt || !recipientAddressees.ids.includes(predecessorOtherParticipant)) {
    return { status: "invalid" };
  }
  return { status: "verified", fold: successorFold, message: firstMessage };
}

// ISS-953 fix step 8: a thread's ENTIRE automatic-park refusal history, resolved
// independently of which park entry (if any) is currently terminal -- a thread can
// be parked, reopened, and parked again more than once over its life, and every
// earlier refusal stays visible here, not only the latest. A SEPARATE, additive
// pass over an already-folded thread's entries: never invoked by the fold of any
// OTHER thread (verifiedSuccessorState above calls the plain, opts-less
// foldBusThread), so resolving one thread's refusals is always exactly one hop
// deep regardless of how long a rollover chain runs.
async function resolveRefusals(paths: BusPaths, folded: FoldedBusThread): Promise<BusRefusal[]> {
  const refusals: BusRefusal[] = [];
  for (const entry of folded.entries) {
    if (entry.type !== "state") continue;
    const payload = entry.payload;
    if (payload.action !== "park" || !payload.automatic || !payload.droppedMessage) continue;
    const droppedMessage = payload.droppedMessage;
    // ISS-953 Codex round 3 finding #2: an absent or malformed trigger must
    // never silently normalize to hop_cap eligibility -- the old ternary
    // treated ANYTHING that wasn't literally "duplicate_fingerprint" as
    // "hop_cap", including undefined. Round 3 finding #6's schema refinement
    // now rejects this combination at parse time for every entry going
    // forward (droppedMessage present requires a valid trigger), so a
    // successfully-parsed entry reaching this point should already be safe
    // -- this check is deliberately defensive rather than a no-op: it does
    // not assume that invariant holds, it verifies it, and fails the SAME
    // closed way (artifactStatus forced corrupt, markerState forced invalid,
    // regardless of what the artifact/marker reads themselves found) if it
    // is ever violated by data that reached this loop some other way.
    const validTrigger = payload.trigger === "hop_cap" || payload.trigger === "duplicate_fingerprint";
    // Internal only, narrow ("hop_cap" | "duplicate_fingerprint"): every use
    // below (verifiedSuccessorState's trigger param) is reached only inside a
    // branch already guarded by validTrigger === true, so its fabrication for
    // an invalid trigger is never observed there. The value actually exposed
    // on BusRefusal is computed separately, below, and does NOT fabricate.
    const trigger = payload.trigger === "duplicate_fingerprint" ? ("duplicate_fingerprint" as const) : ("hop_cap" as const);

    const artifactResult = await readConsistentRefusedArtifact(paths, droppedMessage);
    let artifactStatus = artifactResult.status;
    const artifact = artifactResult.status === "resolved" ? artifactResult.artifact : null;
    // ISS-953 Codex round 2 finding #24: droppedMessage.evidenceKeys is an
    // independently-editable copy of what evidenceKeys(artifact.refs) derives
    // fresh from the artifact -- the entry's own hash chain never re-derives
    // this field, so a hand-tampered entry (recomputing its own entryHash)
    // can disagree with an otherwise-intact artifact undetected. Scoped to
    // THIS diagnostic only, not readConsistentRefusedArtifact itself: that
    // function is also used by createHopCapSuccessorThread/redeliverBusMessage
    // for content/authorship verification, which has nothing to do with
    // evidenceKeys -- folding this check into it would block a legitimate
    // redelivery over a mismatch irrelevant to redelivery's own concern.
    if (artifact && droppedMessage.evidenceKeys) {
      const persisted = [...droppedMessage.evidenceKeys].sort();
      const derived = [...evidenceKeys(artifact.refs)].sort();
      if (JSON.stringify(persisted) !== JSON.stringify(derived)) {
        artifactStatus = "corrupt";
      }
    }
    // ISS-953 Codex round 3 finding #2: an invalid trigger is itself a
    // data-integrity finding on this refusal, independent of whatever the
    // artifact's own content otherwise resolved to -- surfaced through the
    // SAME artifactStatus channel the ship gate and doctor already read
    // unconditionally, rather than a separate, easy-to-miss signal.
    if (!validTrigger) {
      artifactStatus = "corrupt";
    }

    const marker = await readRedeliverMarker(paths, folded.thread.threadId, entry.entryHash);
    let disposition: "redelivered" | "unresolved" = "unresolved";
    let markerState: "none" | "pending" | "verified" | "invalid" = "none";
    let successorThreadId: string | undefined;

    if (marker.status === "none") {
      markerState = "none";
    } else if (marker.status === "invalid" || !validTrigger) {
      // A malformed trigger must never reach verifiedSuccessorState with a
      // fabricated "hop_cap" default -- that IS the normalization finding #2
      // names. Any marker attached to this refusal is unconditionally
      // invalid when the refusal it claims to resolve cannot even be
      // classified.
      //
      // CORRECTED (ISS-953 Codex round 5 finding #4): this disjunct is NOT
      // redundant with the `bound` check below, and the earlier claim that it
      // was rested on an incomplete threat model. `bound` only fails on its
      // own for a marker that is a genuine (or copied) record whose
      // predecessorEntryHash still names some OTHER, unmutated entry hash. An
      // on-disk forger is not limited to that: nothing stops them from
      // writing a marker whose filename AND predecessorEntryHash both name
      // the malformed-trigger entry's OWN recomputed hash directly -- `bound`
      // then succeeds on its own terms, and this disjunct is the ONLY thing
      // standing between that entry and the deeper verifiedSuccessorState
      // check. RED-proofed per L-055: removing `!validTrigger` from this
      // condition changes a bound, forged marker's outcome from "invalid" to
      // "pending" (store.test.ts's round 5 finding #4 test, which builds
      // exactly that marker). Kept for the same reason it was always kept --
      // per #6's schema contract a malformed trigger should never reach this
      // loop via the normal write/read path at all -- but this is now
      // documented as independently necessary defense-in-depth against an
      // on-disk forger who bypasses that path entirely, not merely
      // "unreachable in practice."
      markerState = "invalid";
    } else {
      const bound =
        marker.record.predecessorThreadId === folded.thread.threadId &&
        marker.record.predecessorEntryHash === entry.entryHash &&
        marker.record.originalByEndpoint === payload.byEndpoint;
      if (!bound) {
        markerState = "invalid";
      } else {
        const verifiedState = await verifiedSuccessorState(paths, marker.record, entry.entryHash, artifact, trigger, folded);
        markerState = verifiedState.status;
        if (verifiedState.status === "verified") {
          disposition = "redelivered";
          successorThreadId = marker.record.successorThreadId;
        }
      }
    }
    // ISS-1002 interim remedy: surfaced only for a BOUND marker (markerState
    // "pending" or "verified") -- the common case is "verified" (the fresh id
    // it names was published in the same call that superseded the old one),
    // but a second crash before that publish landed would leave it "pending"
    // again on this NEW marker too. Observability, not a trust signal: never
    // read to decide anything, only to tell an operator a discard happened
    // and what id it discarded.
    //
    // ISS-953 Codex round 6 finding #2: the previous gate checked
    // `marker.status` (the READ-level result: was the file present and
    // schema-parseable) instead of `markerState` (the SEMANTIC result: does
    // this marker actually bind to THIS refusal). Those are different --
    // `marker.status === "present"` with `markerState === "invalid"` is
    // exactly the shape of a schema-valid marker whose predecessorThreadId,
    // predecessorEntryHash, or originalByEndpoint mismatch this refusal (or
    // whose trigger is malformed), and the old gate still copied
    // discardedSuccessorThreadId from it -- contradicting the field's own
    // documented meaning as evidence of a completed supersede. `marker.status
    // === "present"` is kept alongside the markerState check purely so
    // TypeScript can narrow `marker` to the `{ record }` variant below;
    // markerState can only be "pending" or "verified" when marker.status is
    // already "present" (see the branching above), so this adds no cases.
    const discardedSuccessorThreadId =
      marker.status === "present" && (markerState === "pending" || markerState === "verified")
        ? marker.record.discardedSuccessorThreadId
        : undefined;

    refusals.push({
      entryHash: entry.entryHash,
      byEndpoint: payload.byEndpoint,
      // ISS-953 Codex round 4 finding #2: the value actually exposed on
      // BusRefusal, unlike the internal `trigger` above -- an invalid trigger
      // is reported as "invalid", never fabricated to "hop_cap", so a
      // consumer reading this field directly (store.ts's markdown thread
      // export) receives the same corrupt classification artifactStatus and
      // markerState already carry for this refusal, not a specific, wrong one.
      trigger: validTrigger ? trigger : "invalid",
      droppedMessage,
      artifactStatus,
      disposition,
      markerState,
      ...(successorThreadId ? { successorThreadId } : {}),
      ...(discardedSuccessorThreadId ? { discardedSuccessorThreadId } : {}),
    });
  }
  return refusals;
}

export async function foldBusThread(
  root: string,
  threadId: string,
  opts?: { includeRefusals?: boolean },
): Promise<FoldedBusThread> {
  const parsedId = ThreadIdSchema.safeParse(threadId);
  if (!parsedId.success) throw new BusError("invalid_input", "Invalid Bus thread id");
  const paths = await resolveBusPaths(root, false);
  const threadDir = join(paths.threads, threadId);
  const thread = await readJsonNoFollow(join(threadDir, "thread.json"), BusThreadRecordSchema);
  if (thread.threadId !== threadId) throw new BusError("corrupt", "Thread id does not match its directory");

  const entries: BusEntry[] = [];
  const messages: BusMessagePayload[] = [];
  const acknowledgments = new Map<string, BusAckPayload>();
  const seenEvidence = new Set<string>();
  let state: "open" | "parked" | "resolved" = "open";
  let hopCount = 0;
  let lastHash = thread.threadHash;
  let finding: string | undefined;

  if (threadHash(thread) !== thread.threadHash) {
    finding = "thread.json hash mismatch";
  }

  const filenames = finding ? [] : await listRegularJsonFiles(join(threadDir, "entries"));
  for (let index = 0; !finding && index < filenames.length; index++) {
    const filename = filenames[index]!;
    const match = ENTRY_FILENAME.exec(filename);
    const expectedSeq = index + 1;
    if (!match || Number(match[1]) !== expectedSeq) {
      finding = `${filename}: expected contiguous sequence ${expectedSeq}`;
      break;
    }
    let entry: BusEntry;
    try {
      entry = await readJsonNoFollow(join(threadDir, "entries", filename), BusEntrySchema, BUS_MAX_ENTRY_BYTES);
    } catch (err) {
      finding = `${filename}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    if (entry.threadId !== thread.threadId || entry.seq !== expectedSeq ||
        entry.type !== match[2] || entry.entryId !== match[3]) {
      finding = `${filename}: envelope does not match filename or thread`;
      break;
    }
    if (entry.prevHash !== lastHash || entryHash(entry) !== entry.entryHash) {
      finding = `${filename}: integrity chain mismatch`;
      break;
    }

    if (entry.type === "message") {
      const message = entry.payload;
      if (state !== "open") {
        finding = `${filename}: ${state} thread received a message`;
        break;
      }
      if (!participantsInclude(thread.participants, message.from.endpointId) ||
          !participantsInclude(thread.participants, message.to) ||
          message.from.endpointId === message.to) {
        finding = `${filename}: invalid message direction`;
        break;
      }
      if (message.inReplyTo && !messages.some((candidate) => candidate.messageId === message.inReplyTo)) {
        finding = `${filename}: reply target does not exist in the valid prefix`;
        break;
      }
      messages.push(message);
      if (actionableMessage(message)) hopCount += 1;
      for (const key of evidenceKeys(message.refs)) seenEvidence.add(key);
    } else if (entry.type === "ack") {
      const message = messages.find((candidate) => candidate.messageId === entry.payload.messageId);
      if (!message || !ackTransitionAllowed(acknowledgments.get(entry.payload.messageId), entry.payload)) {
        finding = `${filename}: invalid acknowledgment transition`;
        break;
      }
      acknowledgments.set(entry.payload.messageId, entry.payload);
    } else if (entry.type === "state") {
      const transition = entry.payload;
      if (transition.action === "park") {
        if (state !== "open" || !transition.reason) {
          finding = `${filename}: invalid park transition`;
          break;
        }
        state = "parked";
        // ISS-953 fix step 16: mirror the message-entry branch above for a dropped
        // message's OWN refs, not just the transition's own (manual-park) evidence
        // below -- otherwise the exact evidence that was just dropped could later
        // be resubmitted as if it were genuinely new, reopening on stale grounds.
        // Mark-seen only, deliberately never whitelisted: redelivery (fix step 11)
        // is the sanctioned path back into the conversation; this addition exists
        // solely to close the staleness gap, not to grant reopen eligibility.
        //
        // Revised after review (ISS-953 Codex round 2 finding #24): PREFER the
        // artifact's OWN freshly-derived keys whenever it resolves -- the
        // artifact is content-addressed by refusedPayloadHash: readRefusedArtifact
        // re-derives canonicalHash from the artifact's actual content and compares
        // it against the filename on every read (refused.ts), so tampering its
        // refs is DETECTABLE (the artifact fails to resolve, reported corrupt)
        // rather than physically prevented -- nothing stops a write at the same
        // filename with different content, only the re-hash-and-compare on read
        // catches the mismatch. This is still a stronger guarantee than the
        // entry-side evidenceKeys copy, which lives inside a hash-chained entry
        // whose OWN hash a tamperer can freely recompute.
        // Trusting the persisted copy unconditionally (the original fix step
        // 16 shape) let a hand-tampered, emptied-or-wrong evidenceKeys make
        // genuinely-dropped evidence appear unseen even though the artifact
        // that would reveal the truth was still right there and valid. Fall
        // back to the persisted copy only when the artifact does NOT resolve
        // (missing or corrupt for an unrelated reason, e.g. later deleted) --
        // this is fix step 16's original resilience goal, preserved for
        // exactly the case it was meant for: seen-ness must not depend on the
        // artifact still being resolvable YEARS later, only on it being
        // trustworthy RIGHT NOW when both copies are available to compare.
        if (transition.droppedMessage) {
          const resolvedArtifact = await readConsistentRefusedArtifact(paths, transition.droppedMessage);
          if (resolvedArtifact.status === "resolved") {
            for (const key of evidenceKeys(resolvedArtifact.artifact.refs)) seenEvidence.add(key);
          } else if (transition.droppedMessage.evidenceKeys) {
            for (const key of transition.droppedMessage.evidenceKeys) seenEvidence.add(key);
          }
        }
      } else if (transition.action === "resolve") {
        if (state === "resolved" || !transition.resolution || !transition.evidence) {
          finding = `${filename}: invalid resolve transition`;
          break;
        }
        state = "resolved";
      } else {
        if (state !== "parked" || !transition.reason || !transition.evidence) {
          finding = `${filename}: invalid reopen transition`;
          break;
        }
        const keys = evidenceKeys(transition.evidence);
        if (keys.every((key) => seenEvidence.has(key))) {
          finding = `${filename}: reopen evidence was already present`;
          break;
        }
        state = "open";
      }
      if (transition.evidence) {
        for (const key of evidenceKeys(transition.evidence)) seenEvidence.add(key);
      }
    }

    entries.push(entry);
    lastHash = entry.entryHash;
  }

  if (!finding && entries.length === 0) finding = "thread has no immutable entries";

  const core: FoldedBusThread = {
    thread,
    entries,
    validThroughSeq: entries.length,
    lastHash,
    state,
    hopCount,
    acknowledgments,
    messages,
    seenEvidence,
    integrity: finding ? "quarantined" : "verified",
    ...(finding ? { finding } : {}),
    refusals: [],
  };
  if (!opts?.includeRefusals || core.integrity !== "verified") return core;
  return { ...core, refusals: await resolveRefusals(paths, core) };
}

function derivedContent(folded: FoldedBusThread) {
  return {
    schema: "storybloq-bus-derived/v1",
    threadId: folded.thread.threadId,
    lastSeq: folded.validThroughSeq,
    lastHash: folded.lastHash,
    state: folded.state,
    hopCount: folded.hopCount,
    pendingMessageIds: folded.messages
      .filter((message) => !folded.acknowledgments.has(message.messageId))
      .map((message) => message.messageId),
    integrity: folded.integrity,
    finding: folded.finding ?? null,
  } as const;
}

export async function writeDerivedThread(root: string, folded: FoldedBusThread): Promise<void> {
  const paths = await resolveInitializedBusPaths(root);
  const record = BusDerivedRecordSchema.parse({
    ...derivedContent(folded),
    updatedAt: new Date().toISOString(),
  });
  await durableWrite(
    join(paths.threads, folded.thread.threadId, "derived.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
}

export async function ensureDerivedThread(root: string, folded: FoldedBusThread): Promise<boolean> {
  const paths = await resolveInitializedBusPaths(root);
  const path = join(paths.threads, folded.thread.threadId, "derived.json");
  try {
    const current = await readJsonNoFollow(path, BusDerivedRecordSchema);
    const { updatedAt: _updatedAt, ...currentContent } = current;
    if (canonicalHash(currentContent) === canonicalHash(derivedContent(folded))) return false;
  } catch {
    // Derived state is disposable and can be rebuilt from the verified prefix.
  }
  await writeDerivedThread(root, folded);
  return true;
}
