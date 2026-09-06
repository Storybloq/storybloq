/**
 * T-488 Run A: the identity and provenance spine for review rounds.
 *
 * One module, used by BOTH review stages, for the reason ISS-1114 established:
 * two stages writing the same fields by parallel edit is how two spellings of
 * one concept appear, and this ticket exists because the record already carries
 * that kind of drift.
 *
 * The cut line for Run A is not size, it is recoverability. An identity field
 * chosen wrongly is UNRECOVERABLE, because every record written before the
 * correction is permanently unjoinable -- the shape the fleet audit found, with
 * 667 records carrying a backend session id and zero exact review-to-turn
 * joins. A measurement field added later still attaches to records written
 * earlier, provided the spine is right. So the spine ships first.
 */

import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { telemetryDirPath } from "./liveness.js";
import { normalizeSeverity } from "./session-types.js";
import {
  artifactBelongsToAttempt,
  computeContentHash,
  parseVerdictFilename,
  writeReviewVerdict,
  type ReviewVerdictArtifact,
} from "./review-verdict.js";

// ---------------------------------------------------------------------------
// Work item identity
// ---------------------------------------------------------------------------

export type WorkItemKind = "ticket" | "issue";

/**
 * The subject of a review round.
 *
 * `workItemId` + `kind`, never `ticketId`. A round's subject is a ticket OR an
 * issue (ISS-1032), and `codeReviewRoundCounter`, `pendingCeilingEscalation`
 * and `reviewRepairAttempts` already key on exactly this pair. A `ticketId`
 * field would either record a ticket id that is not a ticket, or record
 * nothing, on every issue-fix round.
 */
export interface ReviewSubject {
  readonly workItemId: string;
  readonly kind: WorkItemKind;
}

/**
 * One attempt at a work item, spanning every session that works it.
 *
 * `generation` lives here and is THE generation: one number, incremented by a
 * PLAN redirect, used by both the artifact path and `reviewGenerationHistory`.
 * A second counter could disagree with the first, and that disagreement is
 * unrecoverable in exactly the way this ticket exists to prevent.
 *
 * One number is right for both stages because the redirect clears
 * `reviews.plan` and `reviews.code` in the SAME write, so both stages restart
 * their numbering at the same moment. A per-stage map would be the second
 * counter wearing a different hat.
 */
export interface ItemAttempt {
  readonly id: string;
  readonly workItemId: string;
  readonly kind: WorkItemKind;
  readonly startedAt: string;
  /**
   * Absent means UNINITIALIZED, which is not the same as 0.
   *
   * The distinction is load-bearing: legacy generation initialization scans the
   * reviews directory only when this is absent. Firing it on a valid 0 would
   * also fire on round 2 of an ordinary attempt (which has just written its own
   * r1 at generation 0), advancing the generation with no redirect anywhere.
   *
   * A round with NO ATTEMPT AT ALL has no lineage for this number to describe,
   * and there its `generation` is a filename discriminator and nothing more.
   * Subjectless rounds all share the `unknown` filename stem, so two unrelated
   * sequences can meet at one path; the artifact sink advances one of them,
   * and that advance says only "somebody else was already here". A reader
   * tells the two readings apart by `itemAttemptId`: where it is present the
   * generation is attempt-scoped lineage, and where it is absent it is not
   * lineage and must not be counted as attempts.
   */
  readonly generation?: number;
}

/**
 * Mint a fresh attempt for a subject.
 *
 * `generation` is deliberately LEFT UNSET rather than initialized to 0.
 * Writing 0 here would assert "no prior artifacts exist for this subject"
 * without having looked, and the one place that can actually look is the first
 * artifact write. Leaving it absent means the scan runs exactly once per
 * attempt, at the only moment it can be answered honestly.
 */
export function newItemAttempt(subject: ReviewSubject, nowIso: string): ItemAttempt {
  return {
    id: randomUUID(),
    workItemId: subject.workItemId,
    kind: subject.kind,
    startedAt: nowIso,
  };
}

/**
 * Does a stored attempt belong to the subject currently under review?
 *
 * A mismatch is NOT a smaller match, it is no match: reusing another item's
 * attempt id would attach this round to the wrong work, which is worse than
 * having no attempt id at all.
 */
export function attemptMatchesSubject(
  attempt: ItemAttempt | null | undefined,
  subject: ReviewSubject | null,
): boolean {
  if (!attempt || !subject) return false;
  return attempt.workItemId === subject.workItemId && attempt.kind === subject.kind;
}

/**
 * The single lifecycle decision, shared by acquisition, resume, park,
 * completion and subject switch.
 *
 * Establishing an attempt only at PICK_TICKET was wrong: sessions resume
 * directly into PLAN_REVIEW, IMPLEMENT or CODE_REVIEW, and a session can switch
 * subject without passing acquisition again. So this is the ONLY writer, and it
 * establishes lazily wherever it is first called.
 */
export function resolveItemAttempt(
  stored: ItemAttempt | null | undefined,
  subject: ReviewSubject | null,
  nowIso: string,
): { attempt: ItemAttempt | null; changed: boolean } {
  if (!subject) return { attempt: null, changed: Boolean(stored) };
  if (attemptMatchesSubject(stored, subject)) {
    return { attempt: stored as ItemAttempt, changed: false };
  }
  return { attempt: newItemAttempt(subject, nowIso), changed: true };
}

// ---------------------------------------------------------------------------
// Backend identity
// ---------------------------------------------------------------------------

export type ReviewBackend = "codex" | "agent" | "lenses" | "mixed" | "other";

export type BackendRunIdKind = "codex-session" | "agent-dispatch" | "lens-review";

const BACKEND_RUN_ID_KINDS: readonly string[] = ["codex-session", "agent-dispatch", "lens-review"];

/**
 * Narrows a kind read back off a PERSISTED envelope.
 *
 * The envelope stores it as a bare string, per the persisted-read rule: an
 * enum on a persisted field does not drop a bad value, it makes the whole
 * session unreadable. So the check happens here, at the moment the value
 * re-enters typed code, and an unrecognized kind is dropped rather than
 * carried -- a join derived from a kind nothing understands would be a claim
 * about precision that no reader could check.
 */
function asBackendRunIdKind(value: unknown): BackendRunIdKind | undefined {
  return typeof value === "string" && BACKEND_RUN_ID_KINDS.includes(value)
    ? (value as BackendRunIdKind)
    : undefined;
}

/**
 * Normalize the free-text `reviewer` into an enum, WITHOUT replacing it.
 *
 * `reviewer` carries roughly 60 distinct values fleet-wide, including
 * "codex + adversarial Opus agent (dual)" and
 * "workflow: 6-lens adversarial plan review (20 agents, refutation-verified)".
 * It is the only record of what the writer actually claimed, so it is never
 * rewritten; this is a second field beside it.
 *
 * `mixed` exists because dual-backend rounds provably happen. `other` exists so
 * an unrecognized string is recorded AS unrecognized rather than forced into a
 * bucket it does not belong in.
 */
export function normalizeBackend(reviewer: string | null | undefined): ReviewBackend {
  if (!reviewer) return "other";
  // A COUNT of agents is fan-out, not a backend. The real fleet value
  // "6-lens adversarial plan review (20 agents, refutation-verified)" describes
  // one lens review executed by twenty subagents; reading "agents" there as a
  // second backend would report a pure lens round as dual. A bare "agent",
  // as in "codex + adversarial Opus agent (dual)", IS a second backend.
  //
  // This is a heuristic over free text and is treated as one. `reviewer` stays
  // the authoritative record of what the writer claimed; this enum sits beside
  // it, and an unclear string lands on `mixed` or `other` rather than on a
  // guess that reads as certainty.
  const r = reviewer.toLowerCase().replace(/\b\d+\s*agents?\b/g, " ");
  const hits = [
    r.includes("codex") ? "codex" : null,
    r.includes("lens") ? "lenses" : null,
    r.includes("agent") ? "agent" : null,
  ].filter((x): x is ReviewBackend => x !== null);

  const distinct = Array.from(new Set(hits));
  if (distinct.length > 1) return "mixed";
  return distinct[0] ?? "other";
}

/**
 * Join quality, DERIVED and never stored.
 *
 * A stored field was the first design and it was wrong: it is derivable from
 * the ids, so a persisted copy can contradict the very ids it summarizes.
 *
 * The published contract, which also lives in the generated reference so
 * external readers of raw artifacts are not left to guess:
 *
 * | kind             | scope of the run id              | `exact` requires           |
 * |------------------|----------------------------------|----------------------------|
 * | `codex-session`  | a thread spanning many turns     | a turn id under that thread|
 * | `agent-dispatch` | one dispatch, already single-turn| the dispatch id itself     |
 * | `lens-review`    | one review invocation            | the review id itself       |
 *
 * A turn id is meaningful only alongside its parent run id; one without the
 * other is `none`. A legacy record carrying neither is `none`. **Absence is
 * never read as `exact`.**
 */
export type JoinAvailability = "exact" | "session-scoped" | "none";

export function deriveJoinAvailability(record: {
  readonly backendRunId?: string;
  readonly backendRunIdKind?: BackendRunIdKind;
  readonly backendTurnId?: string;
}): JoinAvailability {
  const { backendRunId, backendRunIdKind, backendTurnId } = record;
  if (!backendRunId) return "none";
  switch (backendRunIdKind) {
    // A dispatch and a lens invocation ARE single turns, so their run id is
    // already turn-precise. A codex thread is not: it spans many turns, so a
    // thread id alone can attribute a round to the thread and no further.
    case "agent-dispatch":
    case "lens-review":
      return "exact";
    case "codex-session":
      return backendTurnId ? "exact" : "session-scoped";
    default:
      return backendTurnId ? "exact" : "session-scoped";
  }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type ProvenanceSource = "explicit-pin" | "session-default" | "unknown";

/**
 * How much we actually know about what ran.
 *
 * `observed` ONLY when the backend reported what executed. A configured pin is
 * evidence of INTENT, never of execution, and recording it as observed is the
 * single error this whole field exists to prevent.
 *
 * The vocabulary maps onto codex-bridge's own labels rather than inventing a
 * parallel one: it emits `runtime_session_record` for an observed run and
 * `bridge_selection` for a configured one.
 */
export type ProvenanceEvidence = "observed" | "configured" | "none";

export interface Provenance {
  readonly model?: string;
  readonly tier?: string;
  readonly effort?: string;
  readonly source: ProvenanceSource;
  readonly evidence: ProvenanceEvidence;
}

/** Provenance bound to the attempt it describes. */
export interface AttemptBoundProvenance extends Provenance {
  readonly itemAttemptId: string;
}

/** Nothing is known. Never fabricate a model name: absent beats wrong. */
export const UNKNOWN_PROVENANCE: Provenance = { source: "unknown", evidence: "none" };

/** Map a backend-reported evidence label onto ours. */
export function evidenceFromBackendLabel(label: string | null | undefined): ProvenanceEvidence {
  if (label === "runtime_session_record") return "observed";
  if (label === "bridge_selection") return "configured";
  return "none";
}

/**
 * Read the implementer for a round, refusing STALE attribution.
 *
 * The case this exists for: after item A completes and item B is picked, B's
 * PLAN_REVIEW runs BEFORE B's first IMPLEMENT. A session-level implementer
 * would still hold A's, and a naive snapshot would attach A's model to B's
 * round. `maxTicketsPerSession` is up to 5, so this is an ordinary path.
 *
 * Binding to the attempt makes it impossible by construction rather than by
 * ordering luck: provenance is used only when it belongs to THIS attempt.
 */
export function implementerForRound(
  stored: AttemptBoundProvenance | null | undefined,
  itemAttemptId: string | null | undefined,
): Provenance {
  if (!stored || !itemAttemptId || stored.itemAttemptId !== itemAttemptId) {
    return UNKNOWN_PROVENANCE;
  }
  const { itemAttemptId: _bound, ...provenance } = stored;
  return provenance;
}

// ---------------------------------------------------------------------------
// Payload consistency
// ---------------------------------------------------------------------------

const CHANGE_REQUESTING = new Set(["revise", "request_changes"]);

/**
 * Does the verdict agree with the findings it carries (the ISS-1114 rule)?
 *
 * CAVEAT THAT MUST TRAVEL WITH THIS FIELD. ISS-1114 now REPAIRS the empty
 * change-request, so that payload no longer becomes a round at all. Rounds
 * recorded from here on will read `true` almost always, and a reader taking
 * that as "the contradiction stopped happening" would be wrong. The rate is
 * readable only as this field on landed rounds PLUS `reviewRepairAttempts`,
 * which counts the payloads that were refused. Two populations, never summed.
 */
export function isPayloadConsistent(
  verdict: string,
  findings: readonly { severity: string; disposition?: string }[],
): boolean {
  if (CHANGE_REQUESTING.has(verdict)) return findings.length > 0;
  if (verdict === "approve") {
    return !findings.some(
      (f) =>
        (f.severity === "critical" || f.severity === "major") &&
        f.disposition !== "addressed" &&
        f.disposition !== "deferred",
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Severity normalization version
// ---------------------------------------------------------------------------

/**
 * The version of the severity normalization applied to a written payload.
 *
 * Version 1 is EXACTLY today's behavior: trim, lowercase, and map "blocking" to
 * "critical" (ISS-823). Nothing else is remapped. Remapping "high" to "major"
 * would change which findings BLOCK a review, which is a gate-behavior decision
 * and not this ticket's to make; that would be a version 2.
 *
 * The number's job is that a reader can tell a normalized record from a legacy
 * one. ABSENCE means the record may not be normalized at all, which is the
 * honest reading: the corpus is a genuine mix, and artifacts exist carrying
 * severities the current normalizer would have changed.
 */
export const SEVERITY_NORMALIZER_VERSION = 1;

// ---------------------------------------------------------------------------
// Round attempt identity
// ---------------------------------------------------------------------------

/** Mint an id for one review round attempt. */
export function newReviewAttemptId(): string {
  return randomUUID();
}

/**
 * Normalize severities and record what was reported, in ONE pass.
 *
 * One pass and one function, called by both stages, so `severity` and
 * `rawSeverity` can never come from different reports or diverge by parallel
 * edit. An already-present `rawSeverity` is preserved: a replay reconstructing
 * a round from its envelope must reproduce the original bytes rather than
 * re-derive them from an already-normalized copy.
 *
 * `normalizeSeverity` only trims, lowercases and maps `blocking`, so most raw
 * values survive into `severity` unchanged -- which is exactly why the raw copy
 * is worth taking. The reviewers' real vocabulary (`high`, `important`,
 * `nitpick`, `note`) passes straight through a field whose declared type says
 * it cannot, and `rawSeverity` is what lets a reader see that rather than infer
 * it from a type that is not being enforced.
 */
export function normalizeFindings<T extends { severity: string; rawSeverity?: string }>(
  findings: readonly T[],
  // `Omit<T, ...>` rather than `T & ...` on purpose. An intersection that
  // includes a declared INTERFACE carries no implicit index signature, and
  // `buildLensHistoryUpdate` takes an index-signature parameter -- so the
  // intersection form compiles here and fails at the call site with an error
  // that points at the wrong line entirely. The mapped type keeps the implicit
  // index signature the previous inline spread had.
): (Omit<T, "severity" | "rawSeverity"> & { severity: string; rawSeverity: string })[] {
  return findings.map((f) => ({
    ...f,
    severity: normalizeSeverity(f.severity),
    rawSeverity: f.rawSeverity ?? f.severity,
  }));
}

// ---------------------------------------------------------------------------
// The durable pending envelope
// ---------------------------------------------------------------------------

export type ReviewStageName = "code" | "plan";

/**
 * A round that has been ACCEPTED but whose sinks are not all durable yet.
 *
 * See the schema comment on `pendingReviewAttempt` for why this is an envelope
 * rather than a bare id. The short version: an id preserves nothing across a
 * crash except itself.
 */
export interface PendingReviewAttempt {
  readonly reviewAttemptId: string;
  readonly itemAttemptId?: string;
  readonly workItemId?: string;
  readonly kind?: string;
  readonly stage: string;
  readonly round: number;
  readonly generation: number;
  readonly payloadFingerprint: string;
  readonly verdict: string;
  readonly reviewer: string;
  readonly summary: string;
  readonly findings: readonly Record<string, unknown>[];
  readonly reviewerIdentity?: Provenance;
  readonly implementer?: Provenance;
  readonly backend?: string;
  readonly backendRunId?: string;
  readonly backendRunIdKind?: string;
  readonly backendTurnId?: string;
  readonly normalizerVersion?: number;
  readonly payloadConsistent?: boolean;
  readonly decidedAt: string;
}

/**
 * Pins the exact payload a round was accepted for.
 *
 * Covers everything the artifact's identity is built from, so a replay whose
 * fingerprint matches provably reproduces the same artifact bytes -- including
 * `summary`, which comes from free-text notes and would otherwise be able to
 * differ between an accepted round and its replay.
 */
export function reviewPayloadFingerprint(input: {
  readonly stage: string;
  readonly workItemId?: string;
  readonly kind?: string;
  readonly verdict: string;
  readonly reviewer: string;
  readonly summary: string;
  readonly findings: readonly unknown[];
}): string {
  // `findings` is stringified as it arrived, NOT canonicalized the way
  // `computeContentHash` canonicalizes the artifact. The asymmetry is
  // deliberate. A re-report whose findings were re-serialized with a different
  // key order produces a different fingerprint, misses the envelope, and is
  // recorded as a new round rather than a replay. That is the over-recording
  // direction, which is the one this design prefers everywhere: an extra round
  // is visible and bounded, and a swallowed round corrupts the count the
  // ceiling fires on. Canonicalizing here would make more replays match and
  // would therefore move the residual failure to the swallowing side.
  const canonical = JSON.stringify([
    input.stage,
    input.workItemId ?? null,
    input.kind ?? null,
    input.verdict,
    input.reviewer,
    input.summary,
    input.findings,
  ]);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// The identity block that lands on every sink
// ---------------------------------------------------------------------------

/**
 * The fields the record, the artifact and the event must AGREE on.
 *
 * Built once and spread into all three, because building it three times is how
 * they come to disagree -- which is the defect this ticket was filed about.
 */
export interface ReviewRoundIdentity {
  readonly workItemId?: string;
  readonly kind?: WorkItemKind;
  readonly reviewAttemptId: string;
  readonly itemAttemptId?: string;
  readonly backendRunId?: string;
  readonly backendRunIdKind?: BackendRunIdKind;
  readonly backendTurnId?: string;
  readonly backend: ReviewBackend;
  readonly normalizerVersion: number;
  readonly generation: number;
  readonly payloadConsistent: boolean;
  readonly reviewerIdentity: Provenance;
  readonly implementer: Provenance;
}

/** The subset an event carries. Events are small on purpose; ids are enough. */
export function eventIdentity(identity: ReviewRoundIdentity): Record<string, unknown> {
  return {
    ...(identity.workItemId === undefined ? {} : { workItemId: identity.workItemId }),
    ...(identity.kind === undefined ? {} : { kind: identity.kind }),
    reviewAttemptId: identity.reviewAttemptId,
    ...(identity.itemAttemptId === undefined ? {} : { itemAttemptId: identity.itemAttemptId }),
  };
}

/**
 * Spread form with absent values genuinely ABSENT, never explicitly undefined.
 *
 * The difference is not cosmetic. `canonicalize` sorts `Object.keys`, so an
 * explicitly-undefined key would enter the canonical form and only then be
 * dropped by `JSON.stringify` -- and every reader downstream would have to know
 * that. Omitting the key means an unpopulated field is indistinguishable from a
 * field that did not exist when the record was written, which is exactly the
 * reading every one of these fields is documented to have.
 */
export function identityFields(identity: ReviewRoundIdentity): ReviewRoundIdentity {
  const out: Record<string, unknown> = {
    reviewAttemptId: identity.reviewAttemptId,
    backend: identity.backend,
    normalizerVersion: identity.normalizerVersion,
    generation: identity.generation,
    payloadConsistent: identity.payloadConsistent,
    reviewerIdentity: identity.reviewerIdentity,
    implementer: identity.implementer,
  };
  const optional: readonly (keyof ReviewRoundIdentity)[] = [
    "workItemId", "kind", "itemAttemptId", "backendRunId", "backendRunIdKind", "backendTurnId",
  ];
  for (const key of optional) {
    const value = identity[key];
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as ReviewRoundIdentity;
}

// ---------------------------------------------------------------------------
// Provenance from a report
// ---------------------------------------------------------------------------

/**
 * What the caller said about the reviewer, and NOTHING more.
 *
 * `evidence` defaults to `configured`, never `observed`, whenever a model or
 * tier was supplied without the caller saying the backend reported it. That
 * default is the whole safety property: a dispatcher that pins a model is
 * stating intent, and intent recorded as execution is a lie that reads like
 * data. A caller that supplies nothing gets `unknown`/`none`.
 */
export function reviewerProvenanceFromReport(report: {
  readonly reviewerModel?: string;
  readonly reviewerTier?: string;
  readonly reviewerSource?: string;
  readonly reviewerEvidence?: string;
  readonly effort?: string;
}): Provenance {
  const known = report.reviewerModel !== undefined || report.reviewerTier !== undefined;
  if (!known) return UNKNOWN_PROVENANCE;
  return {
    ...(report.reviewerModel === undefined ? {} : { model: report.reviewerModel }),
    ...(report.reviewerTier === undefined ? {} : { tier: report.reviewerTier }),
    ...(report.effort === undefined ? {} : { effort: report.effort }),
    // `unknown`, not `explicit-pin`. A caller that names a model without saying
    // how it was chosen has told us the model and nothing else, and guessing
    // the harder claim is the exact fabrication this module exists to prevent:
    // it would record an unpinned session default as a deliberate pin, and
    // inflate every "rounds run on a pinned model" count with rounds nobody
    // pinned. `source` and `evidence` answer different questions, so an unknown
    // source sits perfectly well beside a `configured` evidence: the model was
    // configured somewhere, and how it came to be configured was not stated.
    source: report.reviewerSource === "explicit-pin" || report.reviewerSource === "session-default"
      ? report.reviewerSource
      : "unknown",
    evidence: report.reviewerEvidence === "observed" ? "observed" : "configured",
  };
}

/**
 * What the caller said about the IMPLEMENTER, and nothing more.
 *
 * Same rule as the reviewer's: a pin supplied without the caller claiming it
 * was observed is recorded as `configured`. A dispatcher that pins a model is
 * stating intent, and intent recorded as execution reads as a fact it is not.
 */
export function implementerProvenanceFromReport(report: {
  readonly implementerModel?: string;
  readonly implementerTier?: string;
  readonly implementerSource?: string;
  readonly implementerEvidence?: string;
}): Provenance {
  const known = report.implementerModel !== undefined || report.implementerTier !== undefined;
  if (!known) return UNKNOWN_PROVENANCE;
  return {
    ...(report.implementerModel === undefined ? {} : { model: report.implementerModel }),
    ...(report.implementerTier === undefined ? {} : { tier: report.implementerTier }),
    // `unknown` for the same reason as the reviewer's, above.
    source: report.implementerSource === "explicit-pin" || report.implementerSource === "session-default"
      ? report.implementerSource
      : "unknown",
    evidence: report.implementerEvidence === "observed" ? "observed" : "configured",
  };
}

/**
 * The backend's own run id, taken from what the backend already gives us.
 *
 * No new input is invented for this: codex reports its thread as
 * `reviewerSessionId`, lenses reports its review as `reviewId`, and an agent
 * dispatch reports nothing that survives to here. Absent is the honest answer
 * for that last case, and `deriveJoinAvailability` reads it as `none`.
 */
export function backendRunIdentity(
  backend: ReviewBackend,
  ids: { readonly reviewerSessionId?: string; readonly reviewId?: string },
): { backendRunId?: string; backendRunIdKind?: BackendRunIdKind } {
  if (backend === "codex" && ids.reviewerSessionId) {
    return { backendRunId: ids.reviewerSessionId, backendRunIdKind: "codex-session" };
  }
  if (backend === "lenses" && ids.reviewId) {
    return { backendRunId: ids.reviewId, backendRunIdKind: "lens-review" };
  }
  // A `mixed` round has more than one backend and therefore no single run id
  // that could stand for the round. Recording one of them would misattribute
  // the whole round to half of what ran.
  return {};
}

// ---------------------------------------------------------------------------
// Round records: upsert, never push
// ---------------------------------------------------------------------------

/**
 * Insert or replace a round by `reviewAttemptId`.
 *
 * A blind push is what turns a crash-replay into a double-counted round, and
 * the round count is what the ceiling fires on -- so a duplicate is not a
 * cosmetic error, it can park an item early. A record with NO attempt id is
 * legacy and is always appended: it has no identity to match on, and inventing
 * one to match against would be worse than the duplicate.
 */
export function upsertReviewRecord<T extends { reviewAttemptId?: string }>(
  records: readonly T[],
  record: T,
): T[] {
  const next = [...records];
  if (record.reviewAttemptId) {
    const at = next.findIndex((r) => r.reviewAttemptId === record.reviewAttemptId);
    if (at >= 0) {
      next[at] = record;
      return next;
    }
  }
  next.push(record);
  return next;
}

// ---------------------------------------------------------------------------
// Generation allocation and the artifact sink
// ---------------------------------------------------------------------------

/**
 * The next generation for an attempt whose generation is UNINITIALIZED.
 *
 * Runs at most once per attempt, at the first artifact write, which is the only
 * moment the question can be answered by looking rather than assuming. It is
 * gated on ABSENCE, never on zero: an earlier draft of this rule triggered on
 * "generation is 0 and any artifact exists", which also describes round 2 of an
 * ordinary attempt (it has just written its own r1 at generation 0) and would
 * have advanced the generation with no redirect anywhere.
 *
 * Returns `max(existing generation) + 1` rather than a flat 1, so a directory
 * that already holds suffixed artifacts cannot be collided with either.
 */
export function scanForNextGeneration(reviewsDir: string, target: string, stage: string): number {
  const safeTarget = target.replace(/\//g, "-");
  const wantStage = stage.toLowerCase();
  let highest: number | null = null;
  let files: string[];
  try {
    files = readdirSync(reviewsDir);
  } catch {
    // No directory means no artifacts, which is generation 0. This is the
    // ordinary first-round case, not an error.
    return 0;
  }
  for (const file of files) {
    const parsed = parseVerdictFilename(file);
    if (!parsed) continue;
    if (parsed.target !== safeTarget || parsed.stage !== wantStage) continue;
    if (highest === null || parsed.generation > highest) highest = parsed.generation;
  }
  return highest === null ? 0 : highest + 1;
}

/**
 * The minimum a review stage has to expose for this module to drive a round.
 *
 * A structural interface rather than `StageContext`, so the whole lifecycle
 * stays unit-testable without standing up a session.
 */
export interface ReviewRoundHost {
  readonly dir: string;
  readonly state: Record<string, unknown>;
  writeState(updates: Record<string, unknown>): unknown;
}

export interface PrepareRoundParams {
  readonly stage: ReviewStageName;
  readonly subject: ReviewSubject | null;
  /** The artifact filename's target, which may be "unknown" for a subjectless round. */
  readonly target: string;
  readonly verdict: string;
  readonly reviewer: string;
  readonly summary: string;
  readonly findings: readonly Record<string, unknown>[];
  /** `reviews[stage].length + 1`, used only when this is NOT a replay. */
  readonly arrayRound: number;
  readonly report: {
    readonly reviewerSessionId?: string;
    readonly reviewId?: string;
    readonly reviewerModel?: string;
    readonly reviewerTier?: string;
    readonly reviewerSource?: string;
    readonly reviewerEvidence?: string;
    readonly reviewerTurnId?: string;
  };
  readonly effort?: string;
  readonly nowIso: string;
}

export interface PreparedRound {
  readonly identity: ReviewRoundIdentity;
  readonly envelope: PendingReviewAttempt;
  readonly round: number;
  /**
   * True when the durable envelope was reused rather than superseded.
   *
   * A payload match is necessary but not sufficient: an explicitly reported
   * execution id that contradicts the frozen one supersedes the envelope even
   * though the payload is identical, because two runs can legitimately produce
   * the same verdict, summary and findings.
   */
  readonly replay: boolean;
}

/**
 * Establish the round's identity and make it DURABLE before any sink runs.
 *
 * Order matters and is part of the contract, not an implementation detail:
 * the generation is resolved first, then the envelope is persisted, and only
 * then may a sink write. Freezing an envelope and letting a later collision
 * guard change its generation would leave a replay using a different generation
 * from the artifact -- so allocation happens first, always.
 *
 * The attempt's generation and the envelope's are written in ONE update,
 * because they are one number and a stale copy of it is the two-counter
 * disagreement this design exists to prevent.
 */
export function prepareReviewRound(
  host: ReviewRoundHost,
  params: PrepareRoundParams,
): PreparedRound {
  const storedAttempt = (host.state.itemAttempt ?? null) as ItemAttempt | null;
  const { attempt } = resolveItemAttempt(storedAttempt, params.subject, params.nowIso);

  const fingerprint = reviewPayloadFingerprint({
    stage: params.stage,
    workItemId: params.subject?.workItemId,
    kind: params.subject?.kind,
    verdict: params.verdict,
    reviewer: params.reviewer,
    summary: params.summary,
    findings: params.findings,
  });

  const backend = normalizeBackend(params.reviewer);
  const reported = backendRunIdentity(backend, params.report);

  const pending = (host.state.pendingReviewAttempt ?? null) as PendingReviewAttempt | null;
  const payloadMatches = Boolean(
    pending && pending.stage === params.stage && pending.payloadFingerprint === fingerprint,
  );
  // The fingerprint covers the PAYLOAD, not the execution that produced it, and
  // two rounds can legitimately carry the same verdict, summary and findings.
  // So an explicitly reported execution id that CONTRADICTS the frozen one is
  // the one signal that tells a genuinely new run apart from a replay of the
  // accepted one, and it wins over the payload match.
  //
  // Only a contradiction counts. An id that was absent before and is present
  // now is the same execution reported more completely -- the ordinary shape
  // after a crash, where the caller passes what it has -- and treating that as
  // a new round would mint a second identity for one review.
  const executionConflict = Boolean(
    pending && payloadMatches && (
      (reported.backendRunId !== undefined
        && pending.backendRunId !== undefined
        && reported.backendRunId !== pending.backendRunId)
      || (params.report.reviewerTurnId !== undefined
        && pending.backendTurnId !== undefined
        && params.report.reviewerTurnId !== pending.backendTurnId)
    ),
  );
  const replay = payloadMatches && !executionConflict;

  // A replay reuses the frozen generation. A new round resolves one, consulting
  // the directory only when an ATTEMPT EXISTS and has never had a generation.
  //
  // The `attempt` test is load-bearing and is not the same question as
  // `attempt?.generation`. A subjectless round has no attempt at all, so there
  // is nowhere to persist a resolved generation, and scanning would re-resolve
  // it from the directory on every round: round 1 writes at 0, round 2 scans,
  // finds round 1's artifact and lands at 1, round 3 at 2. Every round of one
  // lineage in its own generation, with no redirect anywhere, which is a FALSE
  // LINEAGE written permanently into the artifacts. A corpus reader applying
  // the documented meaning of this field would read three attempts where there
  // was one, and this ticket exists because an identity field chosen wrongly
  // cannot be repaired after the fact.
  //
  // Starting at 0 is safe precisely because the generation is not what prevents
  // a collision. Subjectless rounds all share the `unknown` filename stem, so
  // two of them CAN meet at one path, and the artifact sink resolves that the
  // same way it resolves the plan-stage reject: it sees an occupant whose
  // attempt identity is not this round's and advances before writing. Guard
  // first, allocation second, exactly as at the other clearing sites.
  const generation = replay
    ? pending!.generation
    : attempt
      ? attempt.generation ?? scanForNextGeneration(
          join(telemetryDirPath(host.dir), "reviews"),
          params.target,
          params.stage,
        )
      : 0;

  // FROZEN on replay, exactly like the provenance below it. The artifact was
  // written with the accepted ids and its content hash does not cover them, so
  // a re-report that carried different (or no) ids would leave the state record
  // naming a backend run the artifact it points at does not name -- the
  // three-sink disagreement this spine exists to make impossible.
  const runIdentity = replay
    ? {
        ...(pending!.backendRunId === undefined ? {} : { backendRunId: pending!.backendRunId }),
        ...(asBackendRunIdKind(pending!.backendRunIdKind) === undefined
          ? {}
          : { backendRunIdKind: asBackendRunIdKind(pending!.backendRunIdKind)! }),
      }
    : reported;
  const turnId = replay ? pending!.backendTurnId : params.report.reviewerTurnId;
  const reviewerIdentity = replay && pending!.reviewerIdentity
    ? pending!.reviewerIdentity
    : reviewerProvenanceFromReport({ ...params.report, effort: params.effort });
  const implementer = replay && pending!.implementer
    ? pending!.implementer
    : implementerForRound(
        (host.state.implementer ?? null) as AttemptBoundProvenance | null,
        attempt?.id,
      );

  const identity: ReviewRoundIdentity = {
    ...(params.subject ? { workItemId: params.subject.workItemId, kind: params.subject.kind } : {}),
    reviewAttemptId: replay ? pending!.reviewAttemptId : newReviewAttemptId(),
    ...(attempt ? { itemAttemptId: attempt.id } : {}),
    ...runIdentity,
    // Only ever set from a value a backend actually supplied. No backend does
    // today, which is why this is the one field with no derivation behind it.
    ...(turnId === undefined ? {} : { backendTurnId: turnId }),
    backend,
    normalizerVersion: SEVERITY_NORMALIZER_VERSION,
    generation,
    payloadConsistent: isPayloadConsistent(
      params.verdict,
      params.findings as readonly { severity: string; disposition?: string }[],
    ),
    reviewerIdentity,
    implementer,
  };

  const round = replay ? pending!.round : params.arrayRound;

  const envelope: PendingReviewAttempt = {
    reviewAttemptId: identity.reviewAttemptId,
    ...(identity.itemAttemptId === undefined ? {} : { itemAttemptId: identity.itemAttemptId }),
    ...(identity.workItemId === undefined ? {} : { workItemId: identity.workItemId }),
    ...(identity.kind === undefined ? {} : { kind: identity.kind }),
    stage: params.stage,
    round,
    generation,
    payloadFingerprint: fingerprint,
    verdict: params.verdict,
    reviewer: params.reviewer,
    summary: params.summary,
    findings: params.findings,
    reviewerIdentity,
    implementer,
    backend,
    ...(identity.backendRunId === undefined ? {} : { backendRunId: identity.backendRunId }),
    ...(identity.backendRunIdKind === undefined ? {} : { backendRunIdKind: identity.backendRunIdKind }),
    ...(identity.backendTurnId === undefined ? {} : { backendTurnId: identity.backendTurnId }),
    normalizerVersion: identity.normalizerVersion,
    payloadConsistent: identity.payloadConsistent,
    decidedAt: replay ? pending!.decidedAt : params.nowIso,
  };

  host.writeState({
    pendingReviewAttempt: envelope,
    ...(attempt ? { itemAttempt: { ...attempt, generation } } : {}),
  });

  return { identity, envelope, round, replay };
}

/**
 * How many generations a single round may burn resolving collisions.
 *
 * Bounded so a pathological directory cannot spin forever. Eight is far past
 * anything a real session produces: the observed corruption (westworld
 * `08a52602`) involved two generations, not eight.
 */
export const GENERATION_COLLISION_BOUND = 8;

export type RoundArtifactResult =
  | {
      readonly kind: "ok";
      readonly artifact: ReviewVerdictArtifact;
      readonly identity: ReviewRoundIdentity;
      readonly envelope: PendingReviewAttempt;
      readonly artifactStatus: "written" | "exists";
    }
  | { readonly kind: "retry"; readonly instruction: string };

/**
 * Write the round's artifact, resolving a generation collision if one is found.
 *
 * THE ARTIFACT GOES FIRST, before the state record, and that ordering is part
 * of the contract. The artifact is the only sink that can DETECT a collision,
 * so writing the state record first would record a generation that had never
 * been verified against the directory -- and re-persisting the envelope
 * afterwards cannot repair a record that has already landed.
 *
 * An `exists` result is not adopted on a content-hash match. Attempt ids are
 * excluded from the hash by design, so two distinct executions with identical
 * findings hash identically; only matching attempt identity proves the artifact
 * on disk is this attempt's own.
 */
export function writeRoundArtifact(
  host: ReviewRoundHost,
  opts: {
    readonly identity: ReviewRoundIdentity;
    readonly envelope: PendingReviewAttempt;
    readonly attempt: ItemAttempt | null;
    readonly buildArtifact: (identity: ReviewRoundIdentity) => ReviewVerdictArtifact;
  },
): RoundArtifactResult {
  let identity = opts.identity;
  let envelope = opts.envelope;

  for (let bump = 0; bump <= GENERATION_COLLISION_BOUND; bump++) {
    const artifact = opts.buildArtifact(identity);
    const result = writeReviewVerdict(host.dir, artifact);

    if (result.status === "skipped") {
      // Retry, not advance. A skipped artifact detected NO collision, so
      // proceeding would let a later sink record a generation still in doubt.
      // The reason is named so a lock timeout and a full disk do not read
      // identically to whoever is looking at the session.
      return {
        kind: "retry",
        instruction: `Review artifact write failed (${result.reason === "lock-unavailable"
          ? "telemetry lock or directory unavailable"
          : "I/O error"}). Re-report your review verdict.`,
      };
    }

    if (result.status === "written") {
      return { kind: "ok", artifact, identity, envelope, artifactStatus: "written" };
    }

    if (artifactBelongsToAttempt(result.existing, identity)) {
      // This attempt's own artifact, already durable from a previous pass that
      // stopped before its later sinks. The stored copy wins over the rebuilt
      // one: it is what a reader will actually find.
      //
      // But it is VERIFIED before it is adopted. The path this replaced went
      // through `readReviewVerdict`, which recomputes the hash and rejects a
      // file whose content no longer matches it; adopting on attempt identity
      // alone would drop that integrity check and let a truncated or edited
      // artifact become this round's Tier-1 verdict. Same failure, same
      // instruction as before.
      const existing = result.existing as ReviewVerdictArtifact;
      if (computeContentHash(existing) !== result.contentHash) {
        // Two conditions reach here and the message names both, because they
        // want different debugging. The file's bytes may have changed since it
        // was written, or the file may carry no `_contentHash` at all -- in
        // which case `writeReviewVerdict` hands back THIS round's hash beside
        // the OLD round's content, and the comparison fails on a hash that was
        // never stored rather than on content that moved.
        return {
          kind: "retry",
          instruction: "Review artifact recovery failed (stored hash missing or content changed). Re-report your review verdict.",
        };
      }
      return { kind: "ok", artifact: existing, identity, envelope, artifactStatus: "exists" };
    }

    // Somebody else's artifact -- a previous generation's, or a legacy one with
    // no identity at all. Advance the generation and re-persist BOTH copies of
    // it in one write, because they are one number.
    const generation = identity.generation + 1;
    identity = { ...identity, generation };
    envelope = { ...envelope, generation };
    host.writeState({
      pendingReviewAttempt: envelope,
      ...(opts.attempt ? { itemAttempt: { ...opts.attempt, generation } } : {}),
    });
  }

  // Bound exhausted. Deliberately a retry with an explicit message rather than
  // a throw: the envelope is durable and the round is still recoverable, so
  // ending the session would destroy more than it protects. What must not
  // happen is silence, and this is not silent.
  return {
    kind: "retry",
    instruction:
      `Review artifact could not be written: ${GENERATION_COLLISION_BOUND} consecutive ` +
      `generation slots are already occupied by other attempts. The telemetry reviews ` +
      `directory needs inspection before this round can be recorded.`,
  };
}
