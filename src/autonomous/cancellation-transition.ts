/**
 * The durable substrate for ordinary session cancellation (T-450 step 6a).
 *
 * WHAT PROBLEM THIS SOLVES. The shipped cancellation tail publishes a terminal
 * session state and then performs six follow-up effects, every one of them a
 * `: void` writer wrapping its body in a bare catch. Each therefore returns
 * normally having done nothing at all, so a session can be durably CANCELLED
 * while its audit event, telemetry record, ended marker, sidecar shutdown and
 * resume-marker removal silently did not happen. Nothing detects that and
 * nothing retries it.
 *
 * THE SHAPE OF THE FIX. Not atomicity, and not reordering. The codebase does
 * own an all-or-nothing state-plus-event primitive (`writeSessionWithEvent`,
 * session.ts:527-553), and it is deliberately NOT used here: it would move the
 * audit append ahead of `killSidecar` and `writeShutdownMarker`, and the step 5
 * characterization suite declares that order a compatibility invariant in its
 * own words. It would also buy atomicity for exactly one of six effects, while
 * a recovery route has to exist for the other five regardless. So the shipped
 * order is untouched and completeness comes from recovery:
 *
 *   1. A durable transition record says what was intended and what has been
 *      decided so far.
 *   2. Each effect is verified by READING BACK what it should have produced.
 *   3. A completion marker is written only after every postcondition holds.
 *
 * The marker comes AFTER the effects, never before. `stages/finalize.ts` is the
 * cautionary precedent: it writes `finalizeCheckpoint: "committed"` (:614-629)
 * and appends the commit event (:631) as two steps, while its own re-entry
 * guard (:151) returns before ever reaching the append, so a crash between them
 * loses the event permanently. A marker written before the thing it attests to
 * is a marker that can lie.
 *
 * ONE RULE GOVERNS EVERY CLASSIFIER BELOW: an unreadable artifact is not an
 * absent one. Absence is an observation with a remedy. Unreadable is a refusal
 * to look, and treating it as absence lets a transient IO failure manufacture
 * the conclusion that recovery finished. The vocabulary follows
 * `BusEvidenceRead` (bus/runtime-evidence.ts:60-67), whose comment states the
 * same rule: "the classifier must never treat an unreadable file as absence,
 * which would mask a loss."
 *
 * The same principle explains why the completion gate reads the RECORDED
 * shutdown artifact rather than re-probing the sidecar at gate time. A probe at
 * gate time answers "is something alive now", which is a different question
 * from "what did the shutdown do", and it is answerable wrongly: a killed
 * process whose parent has not reaped it is a zombie that still occupies its
 * pid and still accepts signals.
 */
import {
  mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync,
  openSync, closeSync, lstatSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { telemetryDirPath, type SidecarShutdownOutcome } from "./liveness.js";
import type { ResumeMarkerRemoval } from "./resume-marker.js";
import {
  CancellationTransitionSchema,
  CancellationShutdownResultSchema,
  CANCELLATION_SHUTDOWN_ARTIFACT,
  type CancellationTransition,
} from "./session-types.js";

const COMPLETION_MARKER = "cancellation-complete.json";

/**
 * CONTAINMENT. These artifacts are `.story/` project data, and project data
 * must never be reachable through a planted symlink.
 *
 * This is not a policy invented here. `core/symlink-write.ts` states the split
 * in its own header: user dotfiles are symlinked on purpose and must be
 * FOLLOWED, and it says in as many words "Do NOT route `.story/` writers
 * through this module", because `guardPath` in `core/project-loader.ts`
 * REJECTS a symlinked target "so that project data inside `.story/` can never
 * escape the repo through a planted symlink". Session telemetry is project
 * data, so it takes the rejecting side of that split.
 *
 * The check has to happen BEFORE the read, not as an error code afterwards,
 * because `readFileSync` follows symlinks silently and succeeds: a link at the
 * artifact path would let arbitrary external JSON satisfy the completion gate.
 * On the write side the exposure is worse, since `rename(2)` acts on the path
 * entry, so a symlinked telemetry directory would land session artifacts
 * outside the session entirely, and could replace an unrelated file.
 *
 * Only symlink-ness is a containment question. A directory sitting where the
 * artifact belongs is a broken session, not an escape, and is left to fail
 * through the ordinary error paths.
 */
function checkNotSymlink(path: string): "ok" | "absent" | "blocked" {
  try {
    return lstatSync(path).isSymbolicLink() ? "blocked" : "ok";
  } catch (err) {
    // Only a genuinely missing entry is absence. Every other error leaves
    // symlink-ness UNKNOWN, and an unknown containment status is not one we may
    // proceed on -- that would be the "unreadable becomes absent" defect in its
    // most consequential form, since proceeding here means following the path.
    return errCode(err) === "ENOENT" ? "absent" : "blocked";
  }
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * The shared pre-read gate: is this artifact contained, present, and safe to
 * open? Returns the classifier arm to use when it is not.
 */
function containedFor(
  telemetryDir: string,
  artifactPath: string,
): { readonly kind: "ok" } | { readonly kind: "absent" } | { readonly kind: "blocked"; readonly detail: string } {
  const dir = checkNotSymlink(telemetryDir);
  if (dir === "absent") return { kind: "absent" };
  if (dir === "blocked") return { kind: "blocked", detail: "telemetry directory is a link or unstattable" };

  const artifact = checkNotSymlink(artifactPath);
  if (artifact === "absent") return { kind: "absent" };
  if (artifact === "blocked") return { kind: "blocked", detail: "artifact is a link or unstattable" };
  return { kind: "ok" };
}

// ---------------------------------------------------------------------------
// The transition record
// ---------------------------------------------------------------------------

/**
 * What the persisted `cancellationTransition` field turned out to be.
 *
 * `absent` and `malformed` are kept apart because they lead somewhere
 * different: absent means this session never started a cancellation and the
 * ordinary path applies, while malformed means something IS there that cannot
 * be trusted, and minting a fresh transition over it would destroy whatever it
 * was recording.
 */
export type TransitionRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly transition: CancellationTransition }
  | { readonly kind: "malformed"; readonly detail: string };

/**
 * Classify the raw field.
 *
 * This is the ONLY place the strict schema is applied to it. The session schema
 * deliberately types the field as `unknown` so that a malformed transition
 * cannot make `readSessionDetailed` report a corrupt SESSION, which would put
 * the whole cancel path out of reach before any of this could run.
 *
 * Never throws. Anything at all can arrive here, including values no writer of
 * ours produced.
 */
export function readCancellationTransition(raw: unknown): TransitionRead {
  // `undefined` is a field that was never written. `null` is a field something
  // deliberately set, which no writer of ours does, so it is a corrupt value
  // rather than an absence and must not license a fresh start.
  if (raw === undefined) return { kind: "absent" };

  const parsed = CancellationTransitionSchema.safeParse(raw);
  if (parsed.success) return { kind: "valid", transition: parsed.data };

  const detail = parsed.error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  return { kind: "malformed", detail: detail || "unparseable transition record" };
}

// ---------------------------------------------------------------------------
// The ticket disposition
// ---------------------------------------------------------------------------

/**
 * How a cancellation left the session's ticket claim.
 *
 * A discriminated union rather than the two booleans this replaced, because
 * those admitted `{released: true, conflict: true}`, which means nothing, and
 * could not tell a successful no-op apart from an operational failure. That
 * distinction matters to any future retry: `unchanged` must never be retried,
 * `failed` might be.
 *
 * RELOCATED VERBATIM from `guide.ts` (T-450 step 6a). It lives here because the
 * transition record persists it and the recovery path reads it back, so leaving
 * the definition in the guide would make this module import the guide purely to
 * name a type the guide no longer owns.
 */
export type TicketDisposition =
  | { readonly kind: "not-authorized" }
  | { readonly kind: "no-ticket" }
  | { readonly kind: "released"; readonly ticketId: string }
  | { readonly kind: "conflict"; readonly ticketId: string }
  | { readonly kind: "unchanged"; readonly ticketId: string;
      readonly reason: "empty-id" | "missing" | "not-inprogress" }
  | { readonly kind: "failed"; readonly ticketId: string };

/**
 * The disposition as it is PERSISTED, which is the pre-existing shape.
 *
 * The union above is internal. Both the audit event and the telemetry keep
 * emitting exactly `{ticketId, ticketReleased, ticketConflict}`, because those
 * records are read by things this module does not control. Widening the union
 * is free; widening the payload is not.
 */
export function auditOf(disposition: TicketDisposition): {
  ticketId: string | null;
  ticketReleased: boolean;
  ticketConflict: boolean;
} {
  switch (disposition.kind) {
    case "not-authorized":
    case "no-ticket":
      return { ticketId: null, ticketReleased: false, ticketConflict: false };
    case "released":
      return { ticketId: disposition.ticketId, ticketReleased: true, ticketConflict: false };
    case "conflict":
      return { ticketId: disposition.ticketId, ticketReleased: false, ticketConflict: true };
    // A no-op and a swallowed failure were indistinguishable in the payload
    // before this union existed, and stay so, because changing the record is
    // not behavior-preserving.
    case "unchanged":
    case "failed":
      return { ticketId: disposition.ticketId, ticketReleased: false, ticketConflict: false };
  }
}

// ---------------------------------------------------------------------------
// The completion marker
// ---------------------------------------------------------------------------

/**
 * Whether this transition's tail is durably finished.
 *
 * `foreign` is the arm that earns its keep. A VALID marker naming a DIFFERENT
 * transition is durable evidence that another cancellation ran here, and
 * overwriting it would destroy the only trace of a conflict worth surfacing.
 * `owned-mismatched` is ours and merely wrong, so it is repairable.
 * `malformed` yields no id at all, so ownership is unprovable in either
 * direction and neither repairing nor declaring completion would be honest.
 */
export type CompletionMarkerRead =
  | { readonly kind: "matching" }
  | { readonly kind: "absent" }
  | { readonly kind: "owned-mismatched"; readonly detail: string }
  | { readonly kind: "foreign"; readonly owner: string }
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "io-unreadable"; readonly detail: string };

function completionMarkerPath(sessionDir: string): string {
  return join(telemetryDirPath(sessionDir), COMPLETION_MARKER);
}

export function classifyCompletionMarker(sessionDir: string, transitionId: string): CompletionMarkerRead {
  const contained = containedFor(telemetryDirPath(sessionDir), completionMarkerPath(sessionDir));
  if (contained.kind === "absent") return { kind: "absent" };
  if (contained.kind === "blocked") return { kind: "io-unreadable", detail: contained.detail };

  let raw: string;
  try {
    raw = readFileSync(completionMarkerPath(sessionDir), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is the ONLY absence: we reached the directory and the file was not
    // in it. Everything else is a refusal to look. ENOTDIR in particular is not
    // absence however much it resembles it: it means a path component is a
    // regular file, which `mkdirSync(..., {recursive: true})` answers with
    // EEXIST rather than repairing, so reporting absence would tell recovery to
    // proceed and write, and that write can never succeed. EACCES, EIO and
    // ELOOP are the same class -- a file we could not look at proves nothing
    // about whether it exists.
    // Containment already passed, so an ENOENT here is the file disappearing
    // between the check and the open, which is a genuine absence.
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "io-unreadable", detail: code ?? "unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed", detail: "invalid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", detail: "not an object" };
  }

  const rec = parsed as Record<string, unknown>;
  const owner = rec.transitionId;
  if (typeof owner !== "string" || owner.length === 0) {
    return { kind: "malformed", detail: "no transitionId" };
  }
  if (owner !== transitionId) return { kind: "foreign", owner };

  if (rec.schemaVersion !== 1) return { kind: "owned-mismatched", detail: "unexpected schemaVersion" };
  if (typeof rec.completedAt !== "string" || rec.completedAt.length === 0) {
    return { kind: "owned-mismatched", detail: "missing completedAt" };
  }
  return { kind: "matching" };
}

/**
 * Record that this transition's tail is durably finished.
 *
 * Returns whether the marker actually landed, because the caller's contract is
 * that a FAILED marker write leaves recovery open. Throwing would abort the
 * tail; returning success regardless would close recovery over a marker that
 * does not exist, which is the finalize.ts failure mode this module exists to
 * avoid reproducing.
 */
export function writeCompletionMarker(sessionDir: string, transitionId: string, completedAt: string): boolean {
  return atomicWriteJson(completionMarkerPath(sessionDir), {
    schemaVersion: 1,
    transitionId,
    completedAt,
  });
}

// ---------------------------------------------------------------------------
// The shutdown artifact
// ---------------------------------------------------------------------------

/**
 * The artifact's on-disk shape, derived from the schema the transition record
 * already uses rather than restated.
 *
 * Restating the outcome vocabulary here would create two independent
 * declarations of the same enum, and nothing would notice when one gained a
 * member the other lacked: the writer would emit a value the reader classifies
 * as corrupt, and the completion gate would refuse a shutdown that actually
 * succeeded. Extending the existing schema means there is one place to change.
 *
 * `.strict()` is inherited, so an unrecognized key is corruption. A file
 * carrying fields we do not understand is not a file we may act on.
 */
const ShutdownArtifactFileSchema = CancellationShutdownResultSchema.extend({
  schemaVersion: z.literal(1),
  transitionId: z.string().uuid(),
});

export type ShutdownArtifact = z.infer<typeof ShutdownArtifactFileSchema>;
export type SidecarOutcome = ShutdownArtifact["sidecar"];
export type ResumeMarkerOutcome = ShutdownArtifact["resumeMarker"];

export type ShutdownArtifactRead =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly artifact: ShutdownArtifact }
  | { readonly kind: "corrupt"; readonly detail: string }
  | { readonly kind: "io-unreadable"; readonly detail: string };

/**
 * Compile-time proof that the artifact vocabulary still matches the producers.
 *
 * `killSidecar` and `removeResumeMarker` are the only things that can supply
 * these values (commit B1). If either gains an outcome the artifact cannot
 * express, this assignment stops compiling here rather than silently writing a
 * value the reader will later call corrupt.
 */
const _sidecarVocabularyMatches: SidecarOutcome = null as unknown as SidecarShutdownOutcome;
const _resumeVocabularyMatches: ResumeMarkerOutcome = null as unknown as ResumeMarkerRemoval;
void _sidecarVocabularyMatches;
void _resumeVocabularyMatches;

function shutdownArtifactPath(sessionDir: string): string {
  return join(telemetryDirPath(sessionDir), CANCELLATION_SHUTDOWN_ARTIFACT);
}

/**
 * Record what the shutdown actually did.
 *
 * This artifact, not a live probe, is what the completion gate consumes. A
 * probe at gate time answers a different question ("is something alive now")
 * and answers it unreliably: a killed process whose parent has not reaped it is
 * a zombie that still holds its pid and still accepts signals, so liveness at
 * gate time is not proof of shutdown either way.
 */
export function writeShutdownArtifact(
  sessionDir: string,
  transitionId: string,
  outcome: { sidecar: SidecarOutcome; resumeMarker: ResumeMarkerOutcome; detail?: string },
): boolean {
  return atomicWriteJson(shutdownArtifactPath(sessionDir), {
    schemaVersion: 1,
    transitionId,
    sidecar: outcome.sidecar,
    resumeMarker: outcome.resumeMarker,
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  });
}

export function readShutdownArtifact(sessionDir: string): ShutdownArtifactRead {
  const contained = containedFor(telemetryDirPath(sessionDir), shutdownArtifactPath(sessionDir));
  if (contained.kind === "absent") return { kind: "absent" };
  if (contained.kind === "blocked") return { kind: "io-unreadable", detail: contained.detail };

  let raw: string;
  try {
    raw = readFileSync(shutdownArtifactPath(sessionDir), "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // See `classifyCompletionMarker`: containment already passed, so ENOENT here
    // is the file disappearing between the check and the open.
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "io-unreadable", detail: code ?? "unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", detail: "invalid JSON" };
  }

  // An outcome outside the vocabulary is not a value to act on. Accepting it
  // would let an edited file steer the completion gate toward a conclusion no
  // code ever reached.
  const result = ShutdownArtifactFileSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { kind: "corrupt", detail: detail || "unparseable shutdown artifact" };
  }
  return { kind: "present", artifact: result.data };
}

// ---------------------------------------------------------------------------

/**
 * Write JSON where a reader can never observe a half-written file.
 *
 * Both of these artifacts are read by a recovery path deciding whether work is
 * finished, so a torn read is not a cosmetic problem: it would classify as
 * malformed and, for the completion marker, could send an already-complete
 * transition back through its tail.
 *
 * Returns success rather than throwing, because every caller is inside a tail
 * that must keep running, and because a failed write has to leave recovery OPEN
 * rather than be swallowed into apparent success.
 */
function atomicWriteJson(path: string, value: unknown): boolean {
  // The temp name must be unique per ATTEMPT, not per process. `process.pid` is
  // not unique across PID namespaces, so two containers writing the same bind
  // -mounted session directory can pick the same temp path; one truncates the
  // other's payload and then renames it into place, and BOTH writers return
  // success while only one payload survives under the other's name. A random
  // component makes collision negligible and the exclusive "wx" create makes it
  // impossible rather than merely unlikely: a second writer that somehow drew
  // the same name fails to create instead of silently sharing the file.
  //
  // The temp stays in the SAME directory as its destination, because rename is
  // only atomic within a filesystem, and that atomicity is the whole point: a
  // reader either sees the previous file or the complete new one, never a
  // half-written one. These artifacts are read by a recovery path deciding
  // whether work is finished, so a torn read is not cosmetic -- it classifies
  // as malformed and could send an already-complete transition back through its
  // tail.
  //
  // `tmp` is assigned ONLY once the exclusive create has succeeded, which is the
  // moment this attempt actually owns that path. That ordering is what makes the
  // cleanup safe: an exclusive create that fails because the path already exists
  // must never reach `unlinkSync`, or the collision defence would itself delete
  // the other writer's in-flight file -- turning the guard into the hazard it
  // exists to prevent.
  //
  // Name generation is INSIDE the guard too. `randomUUID` can throw if the
  // platform entropy source fails, and a throw escaping here would abort the
  // cancellation tail, contradicting the contract that a failed artifact write
  // merely leaves recovery open.
  let tmp: string | undefined;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // AFTER the mkdir, because a symlink to a real directory satisfies mkdir
    // silently. `rename(2)` acts on the path entry, so writing through either
    // link would put session artifacts outside the session directory.
    if (checkNotSymlink(dirname(path)) !== "ok") return false;
    if (checkNotSymlink(path) === "blocked") return false;
    const candidate = `${path}.${process.pid}.${randomUUID()}.tmp`;
    fd = openSync(candidate, "wx");
    tmp = candidate;
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf-8");
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    return true;
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
    // Only ever this attempt's own path, and only if it was really created.
    if (tmp !== undefined) { try { unlinkSync(tmp); } catch { /* nothing to clean up */ } }
    return false;
  }
}
