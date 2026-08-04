/**
 * The shared cancellation core: the transition itself (`applyCancellationTransition`),
 * the tail both recovery paths re-run (`runCancellationTail`), and the gates that
 * authorize re-running it. Extracted VERBATIM from `guide.ts` (B2b) so that step 6b's
 * candidate recovery can consume the same code `handleCancel` runs, without importing
 * the whole guide.
 *
 * WHY THIS IS ITS OWN MODULE and not part of `cancellation-transition.ts`, which the
 * plan's file table literally names: the write-protocol suite instruments
 * `writeShutdownArtifact` / `writeCompletionMarker` by `vi.mock`ing
 * `cancellation-transition.js`. Calls from INSIDE that module would bind lexically and
 * become invisible to the mock (L-041), silently blinding the suite's write-order
 * probes. This module calls those primitives ACROSS the module boundary, which is what
 * keeps them interceptable; the import direction (core -> transition, guide -> core)
 * stays acyclic.
 */
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type FullSessionState,
  type StashPopOutcome,
  type PersistedTicketDisposition,
  type CancellationAuthority,
  type CancellationTransition,
  CANCELLATION_SHUTDOWN_ARTIFACT,
  TransitionIdSchema,
} from "./session-types.js";
import { appendEvent } from "./session.js";
import {
  killSidecar,
  writeShutdownMarker,
  telemetryDirPath,
  type SidecarShutdownOutcome,
} from "./liveness.js";
import { gitStashPop } from "./git-inspector.js";
import { removeResumeMarker, type ResumeMarkerRemoval } from "./resume-marker.js";
import { writeSessionAndRefresh, postStateWrite } from "./guide-effects.js";
import { withTelemLock } from "./telemetry-writer.js";
import {
  auditOf,
  writeShutdownArtifact,
  writeCompletionMarker,
  readCancellationTransition,
  classifyCompletionMarker,
  type TicketDisposition,
} from "./cancellation-transition.js";

/**
 * The cancellation transition: stash restore, terminal publication, and the
 * cleanup that follows it. Shared so candidate cancellation runs THIS code
 * rather than a second spelling of it.
 *
 * RECOVERABLE SINCE B2b: an interrupted run is RESUMED through the dispatcher
 * in `handleCancel` (nonterminal, under the original transitionId) or its tail
 * re-run through `authorizeTailRecovery` (terminal, gated on the completion
 * marker). The durable protocol below is what makes that safe; the effects are
 * still not blindly re-runnable, which is why recovery validates before it
 * touches anything:
 *   - `killSidecar` signals a RAW pid with no generation check, so a delayed
 *     retry can signal an unrelated process that inherited that pid;
 *   - `removeResumeMarker` deletes by PATH with no session identity, so a
 *     delayed retry can delete a NEWER session's marker;
 *   - `markEnded` overwrites its timestamp, and `appendEvent` appends, so a
 *     rerun rewrites the end time and duplicates the audit entry;
 *   - re-running the whole thing performs a second terminal write and bumps
 *     the revision.
 * The disposition is also volatile: it is computed by the caller BEFORE
 * publication, so a crash in between loses the fact that a release happened.
 *
 * ORDER, which is observable and load-bearing:
 *   1.  stash restore -- the ONLY effect here that precedes publication.
 *   2a. atomic terminal state write.
 *   2b. status refresh, a SEPARATE best-effort checkpoint inside
 *       `writeSessionAndRefresh`. It can be absent after a crash, and its
 *       failure must not stop anything below.
 *   3.  `killSidecar`, then `writeShutdownMarker`. After publication, or a
 *       failed cancel would kill a still-live session's sidecar.
 *   4.  `appendEvent`, which needs `written.revision`.
 *   5.  telemetry `session_cancelled`, then `markEnded`, which requires an
 *       already-persisted SESSION_END.
 *   6.  `removeResumeMarker`, last, so a failed cancel does not erase recovery
 *       guidance.
 * Every post-publication effect is independently best-effort: the failure of
 * one must not suppress a later one.
 *
 * The caller keeps the compact report and the response prose, which differ per
 * caller. Everything here is the transition itself.
 */
/**
 * The session's start instant in the canonical grammar the transition schema
 * requires, or `null` when the stored value cannot support the claim.
 *
 * `startedAt` is `z.string()` on the session schema, so it is not guaranteed
 * canonical, while `CanonicalInstantSchema` demands the exact `toISOString()`
 * form. Re-emitting a parseable value through `Date` is a NORMALIZATION, not a
 * fabrication: it names the same instant. An unparseable value is different in
 * kind, and there is nothing truthful to write, so the caller mints no
 * transition at all and the tail behaves exactly as it does today. That
 * degradation is deliberate: a session with a corrupt start time loses the new
 * recovery route, which is where it already was, rather than gaining a record
 * with an invented provenance field in it.
 */
export function canonicalStartedAt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * The in-memory disposition in its persisted spelling.
 *
 * The two differ in exactly one place: persisted `unchanged` is split by reason
 * because the reasons disagree about the ticket id, and `empty-id` is the one
 * that reaches here with `""`. The split makes the contradictions
 * unrepresentable; this function is where the in-memory union, which cannot
 * express that, is narrowed into it.
 */
function toPersistedDisposition(d: TicketDisposition): PersistedTicketDisposition {
  if (d.kind !== "unchanged") return d;
  return d.reason === "empty-id"
    ? { kind: "unchanged", ticketId: "", reason: "empty-id" }
    : { kind: "unchanged", ticketId: d.ticketId, reason: d.reason };
}

/**
 * Does this transition record belong to THIS session?
 *
 * Shared by both recovery paths so they cannot drift. A record is bound by
 * `sessionId`, and `sessionStartedAt` is checked IN ADDITION, never instead:
 * session directories are reused, so a record left by an earlier incarnation
 * carries the right id and the wrong provenance, and resuming it would adopt
 * another run's transitionId, disposition and stash outcome as this run's own.
 *
 * Timestamps deliberately do NOT order anything here. They are compared for
 * equality only: equal-millisecond values and clock rollback both make ordering
 * unable to authorize a decision, and `startedAt` cannot bind identity at all.
 */
export function transitionBelongsTo(
  state: FullSessionState,
  t: CancellationTransition,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  if (t.sessionId !== state.sessionId) {
    return { ok: false, detail: `it names session ${t.sessionId}, not ${state.sessionId}` };
  }
  const startedAt = canonicalStartedAt((state as Record<string, unknown>).startedAt);
  // FAIL CLOSED when the live start time is unusable, rather than falling back
  // to the id alone. The id is the REUSABLE half: a directory outlives the
  // session that made it, so dropping provenance exactly where provenance
  // cannot be established is dropping it exactly where it was load-bearing.
  //
  // This costs nothing legitimate. `applyCancellationTransition` mints a
  // transition ONLY when `canonicalStartedAt` returns non-null, so no record
  // created by this protocol can live on a session whose start time is
  // unreadable. Reaching here means the state file changed underneath the
  // record, which is precisely when a recovery should stop.
  if (startedAt === null) {
    return { ok: false, detail:
      "this session's own startedAt is missing or unparseable, so the record's provenance " +
      "cannot be checked and the session id alone cannot prove the directory was not reused" };
  }
  if (t.sessionStartedAt !== startedAt) {
    return { ok: false, detail:
      `it names start time ${t.sessionStartedAt}, but this session started at ${startedAt}, ` +
      `so the record was left by an earlier session in this directory` };
  }
  return { ok: true };
}

/**
 * May THIS caller finish a cancellation recorded under THIS authority?
 *
 * Shared by both recovery paths so they cannot drift. The rules are the
 * contract's, verbatim: `legacy` recovers, because it records that no task
 * identity existed at cancel time and refusing it would strand exactly the
 * sessions most likely to need recovery. `task` recovers only for the recorded
 * caller. `candidate` ALWAYS refuses here: its recovery runs through the locked
 * candidate validator that ships with the candidate paths, never through a
 * plain cancel, so honoring it from this path would bypass every check that
 * validator exists to make.
 */
export function validateRecoveryAuthority(
  authority: CancellationAuthority,
  callerTaskId: string | undefined,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  switch (authority.kind) {
    case "legacy":
      return { ok: true };
    case "task":
      if (callerTaskId === authority.callerTaskId) return { ok: true };
      return { ok: false, detail:
        `it was recorded under task authority for ${authority.callerTaskId}, and this caller ` +
        (callerTaskId ? `is ${callerTaskId}` : "carries no task identity") };
    case "candidate":
      return { ok: false, detail:
        "it was recorded under candidate authority, which is finished only through the locked " +
        "candidate recovery path, never through a plain cancel" };
  }
}

/**
 * THE SIX-WAY COMPLETION-MARKER GATE, wrapped exactly once (T-450 step 6b).
 *
 * `authorizeTailRecovery` and `retryAdvice` both decide the same question --
 * may this transition's tail be re-run? -- and before this function each
 * spelled the marker switch itself (the candidate published branch becomes the
 * third consumer). Two spellings of a six-way
 * fail-closed switch is how one of them silently gains a seventh behavior, so
 * the CLASSIFICATION lives here and only the refusal TEXT stays with each
 * owner, because the ordinary path and the candidate path owe their operators
 * different sentences, not different decisions.
 *
 * PURE over durable state: reads the marker, mutates nothing, throws nothing.
 */
export type TailRecoveryGate =
  | { readonly kind: "proceed"; readonly marker: "absent" | "owned-mismatched" }
  | { readonly kind: "already-complete" }
  | { readonly kind: "refuse"; readonly classification: "foreign"; readonly owner: string }
  | { readonly kind: "refuse"; readonly classification: "malformed" | "io-unreadable"; readonly detail: string };

export function classifyTailRecovery(sessionDir: string, transitionId: string): TailRecoveryGate {
  const marker = classifyCompletionMarker(sessionDir, transitionId);
  switch (marker.kind) {
    case "absent":
    case "owned-mismatched":
      return { kind: "proceed", marker: marker.kind };
    case "matching":
      return { kind: "already-complete" };
    case "foreign":
      return { kind: "refuse", classification: "foreign", owner: marker.owner };
    case "malformed":
      return { kind: "refuse", classification: "malformed", detail: marker.detail };
    case "io-unreadable":
      return { kind: "refuse", classification: "io-unreadable", detail: marker.detail };
  }
}

/**
 * THE NARROWLY AUTHORIZED, FAIL-CLOSED EXCEPTION to handleCancel's SESSION_END
 * refusal (T-450 step 6a).
 *
 * Without it, the state "publication landed, tail did not" is unreachable
 * through the API: the session is terminal, so cancel refuses, and the operator
 * is sent to `storybloq session stop`, the admin escape hatch this ticket
 * exists to retire. Meanwhile the sidecar may still be running and the resume
 * marker may still be on disk pointing the next session at this one.
 *
 * IT GRANTS NO NEW AUTHORITY. It finishes a cancellation that was already
 * authorized, under that transition's own recorded `action` and `authority`,
 * with its `transitionId` as the evidence pointer that keys every artifact the
 * tail writes. Nothing here can start a cancellation, release a ticket, pop a
 * stash, or write session state.
 *
 * AND IT IS FAIL CLOSED. Six classifications, two of which open the gate:
 *
 *   absent           ours, unattested       -> RECOVER
 *   owned-mismatched ours, provably wrong   -> RECOVER (repairable)
 *   matching         the tail is done       -> refuse, and rightly: this is the
 *                                              ordinary clean-cancel case
 *   foreign          another transition's   -> refuse; overwriting it destroys
 *                                              the only trace of a conflict
 *   malformed        ownership unprovable   -> refuse; repairing claims a
 *                                              transition we cannot show is ours
 *   io-unreadable    we could not look      -> refuse; unreadable is never absence
 *
 * Every refusal names its own condition. A refusal that says "already ended"
 * when the real condition is a foreign marker is diagnosis-substitution, which
 * is the specific failure three operators hit on the way to the admin CLI.
 */
export type TailRecovery =
  | { readonly kind: "refuse"; readonly message: string }
  | { readonly kind: "recover"; readonly transition: Extract<CancellationTransition, { phase: "published" }> };

export function authorizeTailRecovery(
  sessionDir: string,
  state: FullSessionState,
  prior: ReturnType<typeof readCancellationTransition>,
  callerTaskId: string | undefined,
): TailRecovery {
  const ended = "Session already ended.";

  // A legacy session, or one terminated by something that is not this
  // protocol. There is no recorded tail to finish and no authority to finish
  // one under, so the answer is today's answer.
  if (prior.kind === "absent") return { kind: "refuse", message: ended };
  if (prior.kind === "malformed") {
    return { kind: "refuse", message:
      `${ended} Its cancellationTransition record is unreadable (${prior.detail}), so there is no ` +
      `recorded cancellation to finish. Inspect .story/sessions/${state.sessionId}/state.json.` };
  }

  const t = prior.transition;

  // Contradictory: publication is what makes a session terminal. A terminal
  // session still holding `stash_pending` was terminated by another route, and
  // the tail this branch knows how to finish is not the one interrupted.
  if (t.phase !== "published") {
    return { kind: "refuse", message:
      `${ended} Its cancellation transition is recorded as ${t.phase}, not published, so it did not ` +
      `terminate through the cancellation protocol and has no published tail to finish.` };
  }

  const belongs = transitionBelongsTo(state, t);
  if (!belongs.ok) {
    return { kind: "refuse", message:
      `${ended} The cancellation transition in this session's directory does not belong to it: ` +
      `${belongs.detail}. It authorizes nothing here.` };
  }

  const authorized = validateRecoveryAuthority(t.authority, callerTaskId);
  if (!authorized.ok) {
    return { kind: "refuse", message:
      `${ended} Its recorded cancellation cannot be finished by this caller: ${authorized.detail}.` };
  }

  // THE PUBLISHED SHAPE CHECK. Write 3 and write 4 are the only writes after
  // tSR, so a published record violating this was not produced by the write
  // sequence it claims, and finishing its tail would attest artifacts to a
  // transition whose own arithmetic contradicts it.
  if (t.terminalRevision !== t.transitionStartedRevision + 2) {
    return { kind: "refuse", message:
      `${ended} Its transition record fails the published revision equation ` +
      `(terminalRevision ${t.terminalRevision}, transitionStartedRevision ` +
      `${t.transitionStartedRevision}; expected terminal = started + 2), so it was not produced ` +
      `by the cancellation write sequence and its tail is not safe to finish.` };
  }

  const gate = classifyTailRecovery(sessionDir, t.transitionId);
  switch (gate.kind) {
    case "proceed":
      return { kind: "recover", transition: t };
    case "already-complete":
      return { kind: "refuse", message: ended };
    case "refuse":
      switch (gate.classification) {
        case "foreign":
          return { kind: "refuse", message:
            `${ended} Its completion marker names a DIFFERENT transition (${gate.owner}), which is durable ` +
            `evidence that another cancellation ran in this session directory. Finishing this one would ` +
            `overwrite that record, so it is refused rather than resolved silently.` };
        case "malformed":
          return { kind: "refuse", message:
            `${ended} Its completion marker is malformed (${gate.detail}), so it proves ownership in ` +
            `neither direction: this session's tail can be neither confirmed finished nor safely finished. ` +
            `Inspect the telemetry directory under .story/sessions/${state.sessionId}/.` };
        case "io-unreadable":
          return { kind: "refuse", message:
            `${ended} Its completion marker could not be read (${gate.detail}). An unreadable artifact is ` +
            `not an absent one, so nothing here is assumed about whether the cancellation finished.` };
      }
  }
}

/**
 * THE CANCELLATION TAIL: the six effects that run after publication.
 *
 * Extracted so the terminal recovery branch runs the SAME code rather than a
 * second spelling of it. Publication is what makes a session terminal and it
 * happens before any of this, so a crash in here leaves a session that is
 * terminal with its shutdown unfinished, and finishing it later has to mean
 * finishing it identically.
 *
 * Everything the tail needs is passed EXPLICITLY rather than read off the
 * session, because on recovery the session no longer says these things. Its
 * `state` is `SESSION_END`, not the state cancellation interrupted, and its
 * revision has moved past the one the audit event must carry. The transition
 * record is what remembers them.
 */
/**
 * What an operator should actually do after a tail that did not complete.
 *
 * The completion marker is RE-CLASSIFIED rather than assumed, because a failed
 * marker write can itself be the reason the gate has closed: a marker that
 * became foreign, malformed or unreadable after this recovery was authorized
 * will be REFUSED by the next `authorizeTailRecovery`. Telling an operator to
 * re-issue cancel in that state promises a retry that will not happen, which is
 * the same untruth as reporting a completion that did not occur, moved one
 * sentence over.
 */
export function retryAdvice(sessionDir: string, transitionId: string): string {
  const gate = classifyTailRecovery(sessionDir, transitionId);
  switch (gate.kind) {
    case "proceed":
      return `Transition ${transitionId} remains recoverable, so re-issuing cancel will retry.`;
    case "already-complete":
      // The marker landed after all; whatever failed did so before it, and the
      // gate is now closed because the tail reads as finished.
      return `Transition ${transitionId} is now marked complete, so a further cancel will be refused.`;
    case "refuse":
      switch (gate.classification) {
        case "foreign":
          return `A completion marker belonging to a DIFFERENT transition (${gate.owner}) is now present, `
            + `so a further cancel will be refused until it is inspected.`;
        case "malformed":
          return `Its completion marker is now malformed (${gate.detail}), so a further cancel will be `
            + `refused until it is inspected.`;
        case "io-unreadable":
          return `Its completion marker cannot be read (${gate.detail}), so a further cancel will be `
            + `refused until that is resolved.`;
      }
  }
}

/**
 * Whether the tail's postconditions all hold, and which do not.
 *
 * The tail is six best-effort effects and every one can fail without throwing,
 * so a caller that reports completion without consulting this is asserting
 * something it never checked.
 */
export type TailOutcome = { readonly completed: boolean; readonly unmet: readonly string[] };

export function runCancellationTail(
  root: string,
  session: { readonly dir: string; readonly state: FullSessionState },
  ctx: {
    readonly published: Extract<CancellationTransition, { phase: "published" }> | undefined;
    readonly disposition: TicketDisposition;
    readonly stashPopFailed: boolean;
    readonly previousState: string;
    /**
     * The revision the audit event is stamped with AND read back by. On the
     * first pass this is the revision write 4 produced; on recovery it is the
     * `terminalRevision` that write 4 recorded, which is the same number. A
     * recovery pass stamping today's revision would append an event the
     * postcondition could not find, and would leave the completion marker
     * unwritable for a tail that in fact completed.
     */
    readonly terminalRevision: number;
    readonly mode: "first-pass" | "recovery";
  },
): TailOutcome {
  // Destructured so the `published &&` guard below NARROWS. Read through
  // `ctx` inside the postcondition closures, TypeScript loses the narrowing
  // and the guarded block stops compiling.
  const { published } = ctx;
  // T-260: Same-process finalization (after state write succeeds)
  //
  // The `verify` form binds the signal to THIS session. `hasSidecarSignature`
  // proves only that the pid is SOME Storybloq sidecar, so a recycled pid
  // running another session's sidecar passes it; the sidecar's argv carries the
  // real binding, because it is spawned with this session's telemetry
  // directory on the command line. Declining is SAFE: `writeShutdownMarker`
  // below is the guaranteed shutdown channel and the sidecar self-exits on it.
  // The kill is an accelerator, not the mechanism of record.
  // UNDEFINED until the call returns, exactly like `resumeOutcome` below. Both
  // are recorded outcomes in the same artifact, so a reader must not have to
  // remember that one of them is lossy. Pre-seeding this with `"declined"` made
  // a THROWN kill indistinguishable from a probe that ran and refused, which
  // would let the artifact assert that an identity check happened when it did
  // not.
  let sidecarOutcome: SidecarShutdownOutcome | undefined;
  try {
    sidecarOutcome = published
      ? killSidecar(session.state.sidecarPid, { sessionDir: session.dir })
      : (killSidecar(session.state.sidecarPid), "declined");
  } catch { /* stays undefined: we do not know what happened */ }
  // READ BACK, rather than trusting the call. `writeShutdownMarker` is a `: void`
  // best-effort writer that swallows its own failures, so its returning tells
  // us nothing about whether it wrote anything (L-039: the thing that reports
  // your verification worked is itself unverified until something independent
  // checks it).
  //
  // This matters precisely because the kill above is allowed to DECLINE. The
  // justification for declining being safe is that this marker is the
  // guaranteed shutdown channel, since the sidecar self-exits on it. If the
  // marker never lands and the kill declined, nothing shut the sidecar down,
  // and a completion marker claiming otherwise would be false.
  let shutdownMarkerLanded = false;
  try {
    writeShutdownMarker(session.dir);
    // EXISTENCE, which is exactly the predicate the sidecar itself consumes
    // (`fs.existsSync(shut)` in SIDECAR_SCRIPT). Requiring content would be a
    // STRICTER test than the consumer applies, so a partial write that the
    // sidecar would honour would be reported unmet and leave recovery open for
    // a shutdown that will in fact happen.
    shutdownMarkerLanded = existsSync(join(telemetryDirPath(session.dir), "shutdown"));
  } catch { /* best-effort */ }

  const audit = auditOf(ctx.disposition);
  // IDEMPOTENT, and bound to the transition. `events.log` is append-only, so a
  // recovery pass that re-ran the tail after an earlier pass had already
  // appended would leave TWO `cancelled` records for one cancellation, and a
  // reader with no id on them could not tell a retry from a second cancel.
  // Adding `transitionId` (additive, matching what the telemetry event already
  // carries) makes the record self-identifying, which is what makes skipping it
  // safe. The legacy path has no transition, so the guard is false there and
  // the append stays unconditional exactly as before.
  const appendAudit = (): void => {
    appendEvent(session.dir, {
      rev: ctx.terminalRevision,
      type: "cancelled",
      timestamp: new Date().toISOString(),
      data: {
        previousState: ctx.previousState,
        ...audit,
        stashPopFailed: ctx.stashPopFailed,
        ...(published ? { transitionId: published.transitionId } : {}),
      },
    });
  };
  if (published === undefined) {
    // The legacy path, byte for byte: no transition means no id to deduplicate
    // on and no second pass that could reach here, so the append stays
    // unconditional and unlocked exactly as it has always been.
    appendAudit();
  } else {
    // ATOMIC check-and-append. `events.log` is append-only, so a recovery that
    // re-appends leaves two `cancelled` records for one cancellation and a
    // reader cannot tell a retry from a second cancel. A bare read-then-append
    // is only SEQUENTIALLY idempotent: two concurrent authorized recoveries can
    // both observe nothing and both append, recreating the duplicate this is
    // here to prevent. The session's existing telemetry lock is what makes the
    // pair indivisible; `markEnded` already serializes on it, so the two
    // postconditions of this tail now share one mutual exclusion rather than
    // inventing a second.
    const tid = published.transitionId;
    // NO FALLBACK when the lock cannot be taken. Appending outside it would
    // defeat the serialization at exactly the moment it is needed: the holder
    // may already have read the event as absent and be about to append, so both
    // would write and the duplicate would be back.
    //
    // Failing closed costs nothing here, and that is the point of doing the
    // recovery work first. An append that does not happen leaves the audit
    // postcondition unmet, so no completion marker is written, so the
    // transition stays recoverable and a later pass appends it. The record is
    // DEFERRED, not lost. (And if the concurrent holder does land it, the
    // read-back below simply finds it and this attempt completes anyway.)
    withTelemLock(session.dir, () => {
      const present = anyJsonLineMatches(
        join(session.dir, "events.log"),
        (e) => e.type === "cancelled"
          && e.rev === ctx.terminalRevision
          && (e.data as Record<string, unknown> | undefined)?.transitionId === tid,
      );
      if (!present) appendAudit();
    });
  }
  const endedOutcome = postStateWrite(session.dir, {
    event: {
      type: "session_cancelled",
      layer: "guide",
      data: {
        previousState: ctx.previousState,
        reason: "cancelled",
        ...audit,
        stashPopFailed: ctx.stashPopFailed,
        // ATTRIBUTION, and the read-back below depends on it. Matching on the
        // event TYPE alone would let a session_cancelled record from an earlier
        // cancellation satisfy a check about this one, so a failed telemetry
        // write could be read back as successful. Additive: nothing asserts an
        // exact payload shape.
        ...(published ? { transitionId: published.transitionId } : {}),
      },
    },
    ended: published
      ? {
          reason: "cancelled",
          transition: { transitionId: published.transitionId, endedAt: published.endedAt, mode: ctx.mode },
        }
      : { reason: "cancelled" },
  });

  // T-183: Clean resume marker.
  //
  // The identified form deletes only a marker this session owns.
  // `removeResumeMarker` otherwise deletes by PATH with no session identity, so
  // a delayed pass can remove a NEWER session's marker.
  // UNDEFINED until the call returns, never pre-seeded with a real outcome.
  // Initializing this to `"absent"` would mean a throw silently became the
  // successful observation "there was no marker to remove", which is the same
  // unreadable-becomes-absent defect the rest of this protocol exists to
  // prevent, reached through an exception instead of an error code.
  let resumeOutcome: ResumeMarkerRemoval | undefined;
  try {
    resumeOutcome = published
      ? removeResumeMarker(root, { sessionId: session.state.sessionId, mode: ctx.mode })
      : (removeResumeMarker(root), "removed");
  } catch { /* stays undefined: we do not know what happened */ }

  // Either outcome being `undefined` means its call THREW, so there is nothing
  // truthful to put in that artifact field, and the artifact's whole value is
  // that it records what actually happened. Writing no artifact is both the
  // honest answer and the fail-closed one: recovery reads a published
  // transition with no artifact as a tail that did not finish, which is exactly
  // the state we are in.
  if (published && resumeOutcome !== undefined && sidecarOutcome !== undefined) {
    // The ended marker is a POSTCONDITION, so its outcome gates the completion
    // marker rather than being fire-and-forget. `markEnded` can refuse: a valid
    // marker naming a different transition is durable evidence of a competing
    // one and is never overwritten, and an unreadable marker proves nothing. A
    // completion marker written over any of those would assert that every
    // postcondition holds when one demonstrably does not.
    const endedOk = endedOutcome === "written"
      || endedOutcome === "repaired"
      || endedOutcome === "already-correct";

    // THE OTHER TWO SILENT WRITERS. `appendEvent` and the telemetry
    // `session_cancelled` write are `: void` best-effort writers with bare
    // catches, exactly like the ones this protocol exists to stop trusting, so
    // each is verified by READING BACK what it should have produced. Without
    // this the completion marker would assert that every postcondition holds
    // while the audit trail and the telemetry record were both silently lost,
    // which is the very condition the marker is supposed to exclude.
    const auditLanded = anyJsonLineMatches(
      join(session.dir, "events.log"),
      (e) => e.type === "cancelled"
        && e.rev === ctx.terminalRevision
        && (e.data as Record<string, unknown> | undefined)?.transitionId === published.transitionId,
    );
    const telemetryLanded = anyJsonLineMatches(
      join(telemetryDirPath(session.dir), "events.jsonl"),
      (e) => e.type === "session_cancelled"
        && (e.data as Record<string, unknown> | undefined)?.transitionId === published.transitionId,
    );

    // The shutdown postcondition. `already-absent` means there was nothing to
    // shut down, which satisfies it outright. Otherwise the marker is what
    // satisfies it: a bare `signalled` is NOT sufficient, because delivering
    // SIGTERM is not the same fact as the process having exited, and the marker
    // is the channel the sidecar actually self-exits on.
    const shutdownAssured = sidecarOutcome === "already-absent" || shutdownMarkerLanded;

    const unmet = [
      ...(auditLanded ? [] : ["audit-event: not found in events.log"]),
      ...(telemetryLanded ? [] : ["telemetry: session_cancelled not found"]),
      ...(endedOk ? [] : [`ended-marker: ${String(endedOutcome)}`]),
      ...(shutdownAssured ? [] : [`shutdown-marker: absent after ${sidecarOutcome}`]),
    ];

    // The record of what the shutdown ACTUALLY did. The completion gate reads
    // this rather than re-probing liveness, because a killed process whose
    // parent has not reaped it is a zombie that still holds its pid and still
    // accepts signals, so a probe at gate time is not proof either way.
    //
    // A refusal is carried in `detail` so the reason survives to whoever finds
    // the transition unfinished, instead of being inferable only from the
    // completion marker's absence.
    const recorded = writeShutdownArtifact(session.dir, published.transitionId, {
      sidecar: sidecarOutcome,
      resumeMarker: resumeOutcome,
      ...(unmet.length === 0 ? {} : { detail: unmet.join("; ") }),
    });
    // The marker comes LAST, and only when every postcondition it attests to
    // actually holds. `stages/finalize.ts` is the cautionary precedent: it
    // writes its checkpoint and appends its event as two steps, and its own
    // re-entry guard returns before the append, so a crash between them loses
    // the event permanently. A marker written before the thing it attests to is
    // a marker that can lie, and a marker written over a FAILED artifact write
    // would close recovery over evidence that does not exist.
    if (!recorded) return { completed: false, unmet: [...unmet, "shutdown-artifact: not written"] };
    if (unmet.length > 0) return { completed: false, unmet };
    // The marker write can fail on its own, and a caller told "completed" over
    // a marker that does not exist is the finalize.ts failure this module
    // exists to stop reproducing.
    const marked = writeCompletionMarker(session.dir, published.transitionId, published.endedAt);
    return marked
      ? { completed: true, unmet: [] }
      : { completed: false, unmet: ["completion-marker: not written"] };
  }

  // TWO different unfinished states, named apart. A missing transition is the
  // legacy path: nothing to verify, nothing recoverable. A PRESENT transition
  // whose sibling outcome is undefined means a shutdown call THREW (the
  // undefined-on-throw rule), so no artifact was written and the tail is
  // unfinished but recoverable. Reporting the second as "no transition record"
  // would tell an operator there is nothing to recover exactly when there is.
  if (published) {
    const unknown = [
      ...(sidecarOutcome === undefined ? ["sidecar: shutdown call threw, outcome unknown"] : []),
      ...(resumeOutcome === undefined ? ["resume-marker: removal call threw, outcome unknown"] : []),
    ];
    // DEFENSIVE (pen N3): with both siblings defined this branch should be
    // unreachable, but an incomplete outcome with an EMPTY unmet list would
    // render F1's note with nothing after the colon, so the artifact that was
    // certainly not recorded on this path names itself.
    return { completed: false, unmet: unknown.length > 0 ? unknown : ["shutdown-artifact: not recorded"] };
  }
  return { completed: false, unmet: ["no transition record"] };
}

/**
 * Whether ANY record in an append-only log satisfies a predicate.
 *
 * Scanning rather than checking only the newest line, and that is safe HERE for
 * one specific reason: both predicates below are bound to this transition, one
 * by `rev` and one by `transitionId`. An unbound predicate could be satisfied
 * by an older record of the same shape, which would let a write that failed
 * read back as successful. With the binding, no other record can match, so the
 * scan cannot produce a false positive.
 *
 * The alternative, trusting the last line, is fragile in the other direction:
 * anything that appends after our write would push our record off the end and
 * make a met postcondition read as unmet.
 *
 * Never throws. An unreadable or malformed log is reported as unsatisfied,
 * which leaves recovery open, and that is the correct direction because we
 * cannot see the record we are trying to confirm.
 */
function anyJsonLineMatches(path: string, predicate: (entry: Record<string, unknown>) => boolean): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (predicate(parsed as Record<string, unknown>)) return true;
    } catch {
      // A torn or truncated line is not the record we are looking for.
    }
  }
  return false;
}

/**
 * The candidate path's write-1 identity (T-450 step 6b).
 *
 * A FRESH candidate cancellation cannot reach write 1 through either existing
 * parameter: the ordinary default mints its own legacy-authority record, and
 * `resume` structurally requires an already-persisted stash_pending record. So
 * the shared core accepts a third, mutually exclusive input carrying the
 * identity the intent file pre-minted at authorize.
 *
 * There is deliberately NO separate `confirmedSessionRevision` field: the one
 * inside `authority` is the single source, so the invariant checked at write
 * time and the value recovery later validates against cannot disagree.
 */
export interface CandidateCancellationInit {
  /** Pre-minted at authorize and carried by the durable intent, never fresh. */
  readonly transitionId: string;
  /** Either candidate action. ISS-967: a cancellation records itself as a
   * cancellation; only a takeover records a takeover. */
  readonly action: "candidate_recovery_takeover" | "candidate_recovery_cancellation";
  readonly authority: Extract<CancellationAuthority, { kind: "candidate" }>;
}

/** The exact predicate `transitionCommon` applies to persisted ids, imported
 * BY REFERENCE rather than reconstructed, so an edit to the persisted
 * predicate propagates to this gate instead of silently diverging from it. */
const TRANSITION_UUID = TransitionIdSchema;

export async function applyCancellationTransition(
  root: string,
  session: { readonly dir: string; readonly state: FullSessionState },
  disposition: TicketDisposition,
  resume?: Extract<CancellationTransition, { phase: "stash_pending" }>,
  init?: CandidateCancellationInit,
): Promise<{ readonly written: FullSessionState; readonly stashPopFailed: boolean; readonly tail: TailOutcome }> {
  // THE WRITE PROTOCOL (T-450 step 6a). Four writes, and the shape carries the
  // recovery guarantees:
  //
  //   1. the nonterminal transition, outcome undecided;
  //   2. the pop attempt;
  //   3. the outcome, now concrete, still nonterminal;
  //   4. terminal publication.
  //
  // WHY DISPOSITION RIDES IN WRITE 1. The ticket release happens BEFORE any of
  // this (:3060/:3082). A crash between the release and publication would
  // otherwise lose the `released` result, and re-entry would see an open ticket
  // and reconstruct `unchanged` -- a false audit record of a release that did
  // happen. Persisting it in write 1 means every window after a successful
  // release retains the truth. The remaining exposure, a crash after the ticket
  // write and before write 1, is ISS-936's recorded window; this narrows it
  // from "the whole tail" to "the gap between two adjacent writes".
  //
  // WHY WRITE 3 IS NOT FOLDED INTO WRITE 4. Folding would make EVERY crash
  // between the pop and publication resolve to `indeterminate`, including the
  // ones whose outcome was known. The extra write buys that distinction.
  //
  // BOTH preconditions are guarded, and neither may abort the cancel. Minting a
  // transition is an ENHANCEMENT to a path that already worked, so any failure
  // to mint one has to degrade to exactly today's behavior rather than take the
  // cancellation down with it. `randomUUID` can throw when the platform entropy
  // source fails, and it is generated only after `startedAt` validates so the
  // legacy path costs nothing.
  //
  // ON RESUME every one of these is taken from the record instead. A fresh
  // `transitionId` would orphan the first attempt's evidence, which is keyed by
  // the original; a fresh `transitionStartedRevision` would misdate the
  // transition's start; and re-deriving the disposition would overwrite what
  // the first attempt actually did with a reading of the ticket it already
  // changed.
  const startedAt = canonicalStartedAt((session.state as Record<string, unknown>).startedAt);

  // THE CANDIDATE ENTRY CONDITIONS, refused BEFORE any write. These throw
  // rather than degrade because for a candidate the record IS the
  // authorization: the ordinary path's recordless fallback exists so that
  // minting failure cannot take a working cancel down, but a candidate
  // cancellation with no durable transition could never be resumed and its
  // invariant could never be validated, so degradation here would be silent
  // authority laundering. The caller (commitCandidateCancel) treats a throw as
  // a refusal and re-authorizes.
  //
  // CALLER OBLIGATION: `session.state` must be freshly loaded under the held
  // session lock. The invariant below binds to this in-memory snapshot, and
  // for a takeover the invariant IS the authorization, so a stale snapshot
  // would validate a confirmation against a state nobody confirmed.
  if (init) {
    if (resume) {
      throw new Error("applyCancellationTransition: init and resume are mutually exclusive");
    }
    // The schema's superRefine catches this pairing at READ time, but by then
    // the lie is on disk. This is the one place that refuses it pre-write.
    // WIDENED to the two-value candidate set (ISS-967), NOT narrowed per path.
    // This guard is the only thing standing between candidate authority and an
    // `ordinary_cancellation` record pre-write, so it still refuses that
    // pairing; what it no longer does is force a cancellation to describe
    // itself as a takeover.
    if (
      (init.action !== "candidate_recovery_takeover" && init.action !== "candidate_recovery_cancellation")
      || init.authority.kind !== "candidate"
    ) {
      throw new Error(
        "applyCancellationTransition: init requires a candidate recovery action " +
        "(candidate_recovery_takeover or candidate_recovery_cancellation) under candidate authority",
      );
    }
    // The transitionId is the key every artifact and every future validation
    // hangs off. A null or empty id would collapse `common` to null below and
    // silently degrade to the recordless path WITH init present; a non-uuid
    // id would write a record the strict reader refuses at every future read,
    // which is a transition that can never be resumed. Both refuse pre-write,
    // and the predicate is THE SAME `z.string().uuid()` the persisted schema
    // applies, so this gate and the reader cannot drift apart under a zod
    // upgrade: whatever passes here parses there, by construction.
    if (typeof init.transitionId !== "string" || !TRANSITION_UUID.safeParse(init.transitionId).success) {
      throw new Error(
        "applyCancellationTransition: init.transitionId must be a uuid; the intent pre-mints it at authorize",
      );
    }
    if (startedAt === null) {
      throw new Error(
        "applyCancellationTransition: this session's start time is unusable, so no candidate " +
        "transition can be minted; the candidate path refuses rather than degrading to a recordless cancel",
      );
    }
    // THE CANDIDATE INVARIANT: transitionStartedRevision (the revision write 1
    // is about to produce, session.state.revision + 1) must equal
    // confirmedSessionRevision + 1. Anything that moved the session between
    // authorize and here makes the confirmation stale, and acting on it would
    // take over a session the human was not shown. Re-authorization is cheap;
    // an unearned takeover is not.
    if (session.state.revision !== init.authority.confirmedSessionRevision) {
      throw new Error(
        `applyCancellationTransition: the candidate invariant fails: the session is at ` +
        `revision ${session.state.revision} but the authorization confirmed ` +
        `confirmedSessionRevision ${init.authority.confirmedSessionRevision}, so write 1 would ` +
        `produce transitionStartedRevision ${session.state.revision + 1}, not ` +
        `${init.authority.confirmedSessionRevision + 1}. Re-authorize against the current state.`,
      );
    }
  }

  let transitionId: string | null = resume ? resume.transitionId : init ? init.transitionId : null;
  if (!resume && !init && startedAt !== null) {
    try { transitionId = randomUUID(); } catch { transitionId = null; }
  }
  const common = resume ? {
    transitionId: resume.transitionId,
    action: resume.action,
    authority: resume.authority,
    disposition: resume.disposition,
    sessionId: resume.sessionId,
    sessionStartedAt: resume.sessionStartedAt,
    transitionStartedRevision: resume.transitionStartedRevision,
  } : (startedAt === null || transitionId === null) ? null : {
    transitionId,
    // With init the identity is the intent's, pre-minted at authorize; the
    // entry conditions above already proved the pairing and the invariant.
    action: init ? init.action : ("ordinary_cancellation" as const),
    authority: init ? init.authority : { kind: "legacy" as const },
    disposition: toPersistedDisposition(disposition),
    // IDENTITY is the session id. `sessionStartedAt` is provenance, checked in
    // addition to it and never instead of it.
    sessionId: session.state.sessionId,
    sessionStartedAt: startedAt,
    // The revision write 1 PRODUCES, precomputable the same way
    // `terminalRevision` is (`writeSessionSync` increments by exactly one).
    // The per-phase equations hang off this definition -- null outcome:
    // current === tSR; concrete: tSR + 1; published: terminalRevision ===
    // tSR + 2 -- and 6b's locked validator checks them, so persisting the
    // OBSERVED revision here would make every legitimate record fail
    // validation by one.
    transitionStartedRevision: session.state.revision + 1,
  };

  // WRITE 1. `if-active` rather than `always`: the session is still live at
  // this point, so this is an ordinary in-flight update, not the terminal
  // publication that the status file exists to reflect.
  //
  // SKIPPED on resume: write 1 is what records that a transition began, and it
  // is already on disk. Rewriting it would reset a concrete outcome back to
  // `null`, discarding the very fact recovery came here to preserve.
  let current = session.state;
  if (common && !resume) {
    current = writeSessionAndRefresh(root, session.dir, {
      ...current,
      cancellationTransition: {
        ...common, phase: "stash_pending", stash: { outcome: null },
      } satisfies CancellationTransition,
    } as FullSessionState, "if-active");
  }

  // T-125: Restore auto-stashed changes on cancel.
  //
  // NEVER on resume. `outcome: null` spans two indistinguishable crash seams,
  // before the pop and after it but before write 3, and the durable state is
  // identical in both. A second pop would therefore be a coin flip on whether
  // it re-applies work already applied, or applies an unrelated stash that has
  // since taken the ref. `indeterminate` is the honest terminal value: it says
  // the answer is unknowable rather than guessing at it.
  let stashPopFailed = false;
  const autoStash = session.state.git.autoStash;
  let outcome: StashPopOutcome = "none";
  if (resume) {
    // `indeterminate` says "whether the pop ran is unknowable". With no
    // autoStash there was never a pop to run, so nothing is unknowable and
    // `none` is the truthful record (pen N2, 6a completion verdict).
    outcome = resume.stash.outcome ?? (autoStash ? "indeterminate" : "none");
    stashPopFailed = outcome === "failed";
  } else if (autoStash) {
    const popResult = await gitStashPop(root, autoStash.ref);
    if (!popResult.ok) stashPopFailed = true;
    outcome = popResult.ok ? "popped" : "failed";
  }

  // WRITE 3. SKIPPED when a concrete outcome is already on disk: that IS
  // write 3, verbatim, and rewriting it would spend a revision the published
  // equation does not allow (terminalRevision === tSR + 2 admits exactly one
  // write between the outcome and publication on re-entry). The null-outcome
  // resume does run it, because recording `indeterminate` is the whole point.
  if (common && !(resume && resume.stash.outcome !== null)) {
    current = writeSessionAndRefresh(root, session.dir, {
      ...current,
      cancellationTransition: {
        ...common, phase: "stash_pending", stash: { outcome },
      } satisfies CancellationTransition,
    } as FullSessionState, "if-active");
  }

  // WRITE 4. `terminalRevision` is precomputable because `writeSessionSync`
  // increments by exactly one (session.ts:497), so the record can name the very
  // write that carries it rather than needing a fifth write to point back.
  const published: CancellationTransition | undefined = common ? {
    ...common,
    phase: "published",
    stash: { outcome },
    endedAt: new Date().toISOString(),
    terminalRevision: current.revision + 1,
    // A pointer, not the outcomes: this write happens BEFORE the shutdown, so
    // nothing here could know them without fabricating them.
    shutdownArtifact: { schemaVersion: 1, filename: CANCELLATION_SHUTDOWN_ARTIFACT },
  } : undefined;

  const written = writeSessionAndRefresh(root, session.dir, {
    ...current,
    state: "SESSION_END",
    previousState: session.state.state,
    status: "completed",
    terminationReason: "cancelled",
    compactPending: false,
    compactPreparedAt: null,
    compactObservedAt: null,
    resumeBlocked: false,
    ticket: undefined,
    ...(published ? { cancellationTransition: published } : {}),
    // THE C2 BARRIER (ruling ea611619). For a CANDIDATE transition write 4 is
    // fsync'd through the durable variant, because commitCandidateCancel
    // closes the durable intent on the strength of this write having
    // happened: writes 1/3 route through the un-fsynced ordinary writer, so
    // power loss can drop every state rename -- and if the intent's close
    // survived while this write did not, the result would be a closed
    // cancellation intent with no published transition, which is permanent
    // foreclosure (the exact class B7 closes for takeovers). The ordinary
    // path passes "ordinary" and is byte-unchanged.
  } as FullSessionState, "always", common && common.authority.kind === "candidate" ? "durable" : "ordinary");
  const tail = runCancellationTail(root, session, {
    published: published as Extract<CancellationTransition, { phase: "published" }> | undefined,
    disposition,
    stashPopFailed,
    previousState: session.state.state,
    // EXACTLY `written.revision`: `terminalRevision` is `current.revision + 1`
    // and `writeSessionSync` increments by one, so these are the same number
    // by construction. Passing the written revision keeps the legacy path,
    // which has no transition and therefore no `terminalRevision`, byte for
    // byte what it was.
    terminalRevision: written.revision,
    // A RESUMED tail is not a first pass, and the distinction is load-bearing:
    // first-pass mode may adopt an identifier-free ended marker and delete an
    // identifier-free resume marker, on the proof that it runs before this
    // transition wrote either. A resume arrives LATE, after a crash window in
    // which anything may have written them, so that proof is gone and the
    // recovery rules (preserve what cannot be attributed) are the honest ones.
    // A CANDIDATE (init) tail is recovery for the same reason with a different
    // clock: first-pass adoption rests on the claim that no OTHER writer could
    // have produced an identifier-free marker, and an owner-gone takeover
    // arrives after an unbounded unattended window in which anything may have
    // written one (pen ruling, 6b enablers byte-review).
    mode: resume || init ? "recovery" : "first-pass",
  });

  return { written, stashPopFailed, tail };
}
