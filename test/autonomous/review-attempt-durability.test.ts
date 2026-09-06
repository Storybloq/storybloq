/**
 * T-488 D3: a round survives a crash at any point between its sinks.
 *
 * A bare `reviewAttemptId` was the first design and it was not enough. It
 * preserves nothing across a crash except itself: not the payload, not the
 * subject, not the generation, not the provenance. And "clear the pending
 * marker once all three sinks succeed" is UNSATISFIABLE, because `appendEvent`
 * swallows its own errors and can never report success.
 *
 * So the whole accepted round is persisted before any sink runs, and the sinks
 * are idempotent by id. A crash is simulated here the way a crash actually
 * behaves: whatever the last completed write left behind is all the next call
 * gets, and the steps after the failure point simply never run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareReviewRound,
  upsertReviewRecord,
  writeRoundArtifact,
  type PendingReviewAttempt,
  type PrepareRoundParams,
  type ReviewRoundHost,
  type ReviewRoundIdentity,
} from "../../src/autonomous/review-identity.js";
import type { ReviewVerdictArtifact } from "../../src/autonomous/review-verdict.js";
import { SessionStateSchema } from "../../src/autonomous/session-types.js";

const NOW = "2026-09-05T12:00:00.000Z";
const FINDINGS = [{ severity: "major", category: "c", description: "d", disposition: "open" }];

/** A `state.json` as a build before this spine wrote it: one round, no spine. */
function legacyStateWithOneRound(): Record<string, unknown> {
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000004ee",
    recipe: "coding", state: "CODE_REVIEW", revision: 4, status: "active", mode: "auto",
    reviews: {
      plan: [],
      code: [{
        round: 1, reviewer: "codex", verdict: "approve", findingCount: 0,
        criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: NOW,
      }],
    },
    completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: NOW, expiresAt: NOW },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: NOW, startedAt: NOW, guideCallCount: 4,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Legacy ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
  };
}

class FakeHost implements ReviewRoundHost {
  state: Record<string, unknown> = {};
  constructor(readonly dir: string) {}
  writeState(updates: Record<string, unknown>): unknown {
    this.state = { ...this.state, ...updates };
    return this.state;
  }
  /** A process restart: state survives, in-flight locals do not. */
  restart(): FakeHost {
    const next = new FakeHost(this.dir);
    next.state = { ...this.state };
    return next;
  }
}

function params(overrides: Partial<PrepareRoundParams> = {}): PrepareRoundParams {
  return {
    stage: "code",
    subject: { workItemId: "T-001", kind: "ticket" },
    target: "T-001",
    verdict: "revise",
    reviewer: "codex",
    summary: "please fix",
    findings: FINDINGS,
    arrayRound: 1,
    report: { reviewerSessionId: "sess-1" },
    nowIso: NOW,
    ...overrides,
  };
}

function buildArtifact(round: number) {
  return (identity: ReviewRoundIdentity): ReviewVerdictArtifact => ({
    target: "T-001", stage: "code", round, reviewer: "codex", verdict: "revise",
    findingsCount: FINDINGS.length,
    severityCounts: { critical: 0, major: 1, minor: 0, suggestion: 0 },
    startedAt: NOW, durationMs: 1, summary: "please fix", findings: FINDINGS,
    // Deliberately a MOVING value: two attempts at one round must still be
    // recognised as one round, and a timestamp is excluded from the hash.
    timestamp: new Date().toISOString(),
    workItemId: identity.workItemId, kind: identity.kind,
    reviewAttemptId: identity.reviewAttemptId, itemAttemptId: identity.itemAttemptId,
    generation: identity.generation, backend: identity.backend,
    normalizerVersion: identity.normalizerVersion,
    payloadConsistent: identity.payloadConsistent,
  });
}

function writeArtifactFor(host: FakeHost, prepared: { identity: ReviewRoundIdentity; envelope: PendingReviewAttempt }, round = 1) {
  return writeRoundArtifact(host, {
    identity: prepared.identity,
    envelope: prepared.envelope,
    attempt: (host.state.itemAttempt ?? null) as never,
    buildArtifact: buildArtifact(round),
  });
}

function artifactNames(sessionDir: string): string[] {
  try {
    return readdirSync(join(sessionDir, "telemetry", "reviews")).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

describe("crash between sinks", () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), "t488-durable-")); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  it("crash AFTER the envelope, before the artifact: the replay reuses the same round", () => {
    const first = new FakeHost(sessionDir);
    const before = prepareReviewRound(first, params());
    // Stop here. No artifact, no record, no event.
    expect(artifactNames(sessionDir)).toEqual([]);

    const after = first.restart();
    const replay = prepareReviewRound(after, params());

    expect(replay.replay).toBe(true);
    expect(replay.identity.reviewAttemptId).toBe(before.identity.reviewAttemptId);
    expect(replay.round).toBe(before.round);
    expect(replay.identity.generation).toBe(before.identity.generation);
    expect(replay.identity.itemAttemptId).toBe(before.identity.itemAttemptId);
  });

  it("crash AFTER the artifact, before the state record: the artifact is adopted, not duplicated", () => {
    const first = new FakeHost(sessionDir);
    const before = prepareReviewRound(first, params());
    const wrote = writeArtifactFor(first, before);
    expect(wrote.kind === "ok" && wrote.artifactStatus).toBe("written");
    expect(artifactNames(sessionDir)).toEqual(["T-001-code-r1.json"]);
    // Stop here. The state record never landed.

    const after = first.restart();
    const replay = prepareReviewRound(after, params());
    const again = writeArtifactFor(after, replay);

    expect(again.kind === "ok" && again.artifactStatus).toBe("exists");
    // ONE artifact, not two, and not renumbered into a new generation.
    expect(artifactNames(sessionDir)).toEqual(["T-001-code-r1.json"]);
    expect(again.kind === "ok" && again.identity.generation).toBe(0);
  });

  it("crash BETWEEN the artifact and the state record: the replay upserts rather than pushing a second row", () => {
    // This is the window the upsert exists for. A blind push here would record
    // the same round twice, and the ceiling fires on the round count -- so a
    // duplicate is not cosmetic, it can park an item early.
    //
    // The envelope is STILL SET at the failure point, which is what production
    // looks like here: both stages clear it in the same write that lands the
    // record, and that write has not happened yet.
    const first = new FakeHost(sessionDir);
    const before = prepareReviewRound(first, params());
    const wrote = writeArtifactFor(first, before);
    expect(first.state.pendingReviewAttempt).toBeTruthy();

    const after = first.restart();
    const replay = prepareReviewRound(after, params());
    writeArtifactFor(after, replay);
    expect(replay.replay).toBe(true);
    const merged = upsertReviewRecord([{
      round: before.round, reviewer: "codex", verdict: "revise",
      reviewAttemptId: before.identity.reviewAttemptId,
      artifactStatus: wrote.kind === "ok" ? wrote.artifactStatus : undefined,
    }], {
      round: replay.round, reviewer: "codex", verdict: "revise",
      reviewAttemptId: replay.identity.reviewAttemptId,
      artifactStatus: "exists",
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.round).toBe(1);
    expect(artifactNames(sessionDir)).toEqual(["T-001-code-r1.json"]);
  });

  it("crash AFTER the state record: the recorded round stays joinable and is never replaced later", () => {
    // Production clears the envelope in the SAME write that lands the record,
    // so this restart has no envelope -- and that is deliberate rather than an
    // oversight. Holding it one write longer would make a genuine second round
    // carrying an identical payload indistinguishable from a replay of the
    // first, and the upsert would then REPLACE round 1 instead of appending
    // round 2. Losing a round that really ran is worse than the cost here,
    // which is that a resumed session runs one more review than it needed to.
    //
    // What must survive is the part the spine promises: the round that landed
    // keeps its identity, and nothing later can overwrite it.
    const first = new FakeHost(sessionDir);
    const before = prepareReviewRound(first, params());
    const wrote = writeArtifactFor(first, before);
    const record = {
      round: before.round, reviewer: "codex", verdict: "revise",
      reviewAttemptId: before.identity.reviewAttemptId,
      generation: before.identity.generation,
      artifactStatus: wrote.kind === "ok" ? wrote.artifactStatus : undefined,
    };
    // The production write, both fields together.
    first.writeState({
      reviews: { plan: [], code: upsertReviewRecord([], record) },
      pendingReviewAttempt: null,
    });

    const after = first.restart();
    const recorded = (after.state.reviews as { code: typeof record[] }).code;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      reviewAttemptId: before.identity.reviewAttemptId,
      generation: 0,
      artifactStatus: "written",
    });

    // A later report of the same payload is a NEW round, because the round it
    // would otherwise replay is already durable.
    const next = prepareReviewRound(after, params({ arrayRound: recorded.length + 1 }));
    expect(next.replay).toBe(false);
    expect(next.identity.reviewAttemptId).not.toBe(before.identity.reviewAttemptId);
    expect(next.round).toBe(2);
    const merged = upsertReviewRecord(recorded, {
      round: next.round, reviewer: "codex", verdict: "revise",
      reviewAttemptId: next.identity.reviewAttemptId,
      generation: next.identity.generation,
      artifactStatus: "written",
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]!.reviewAttemptId).toBe(before.identity.reviewAttemptId);
  });

  it("the envelope carries the whole round, not just an id", () => {
    // Everything a replay needs to reconstruct the identical round, so a reader
    // inspecting a stopped session can also see WHAT was in flight.
    const host = new FakeHost(sessionDir);
    prepareReviewRound(host, params());
    const envelope = host.state.pendingReviewAttempt as PendingReviewAttempt;

    expect(envelope).toMatchObject({
      stage: "code", round: 1, generation: 0,
      workItemId: "T-001", kind: "ticket",
      verdict: "revise", reviewer: "codex", summary: "please fix",
      backend: "codex", backendRunId: "sess-1", backendRunIdKind: "codex-session",
      normalizerVersion: 1, payloadConsistent: true, decidedAt: NOW,
    });
    expect(envelope.findings).toEqual(FINDINGS);
    expect(envelope.reviewAttemptId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("a replay is only a replay when the payload matches", () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), "t488-replay-")); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  it("a DIFFERENT verdict supersedes the envelope instead of reusing its identity", () => {
    // A reviewer that comes back with a new verdict is reporting a new round.
    // Reusing the envelope would file that verdict under the old round's id,
    // and the record would say something the reviewer never said.
    const host = new FakeHost(sessionDir);
    const first = prepareReviewRound(host, params());
    const second = prepareReviewRound(host, params({ verdict: "approve", summary: "fixed" }));

    expect(second.replay).toBe(false);
    expect(second.identity.reviewAttemptId).not.toBe(first.identity.reviewAttemptId);
  });

  it("a changed SUMMARY is enough to supersede, because summary reaches the artifact", () => {
    const host = new FakeHost(sessionDir);
    const first = prepareReviewRound(host, params());
    const second = prepareReviewRound(host, params({ summary: "different notes" }));
    expect(second.replay).toBe(false);
    expect(second.identity.reviewAttemptId).not.toBe(first.identity.reviewAttemptId);
  });

  it("an envelope from the OTHER stage is never mistaken for this stage's round", () => {
    const host = new FakeHost(sessionDir);
    prepareReviewRound(host, params({ stage: "plan" }));
    const codeRound = prepareReviewRound(host, params({ stage: "code" }));
    expect(codeRound.replay).toBe(false);
  });

  it("the attempt id survives a superseded round, because the ITEM did not change", () => {
    // Round identity and attempt identity are different lifetimes: a new
    // verdict is a new round of the SAME attempt at the same work item.
    const host = new FakeHost(sessionDir);
    const first = prepareReviewRound(host, params());
    const second = prepareReviewRound(host, params({ verdict: "approve", summary: "fixed" }));
    expect(second.identity.itemAttemptId).toBe(first.identity.itemAttemptId);
  });
});

describe("provenance is frozen with the round, not re-read on replay", () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), "t488-prov-")); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  it("a replay keeps the provenance the round was accepted with", () => {
    // If a replay re-derived provenance, a session whose implementer changed
    // in between would rewrite an already-durable round's attribution.
    const host = new FakeHost(sessionDir);
    const first = prepareReviewRound(host, params({
      report: { reviewerModel: "gpt-6-astra", reviewerEvidence: "observed" },
    }));
    expect(first.identity.reviewerIdentity).toMatchObject({ model: "gpt-6-astra", evidence: "observed" });

    // The replay reports DIFFERENT provenance, and the host's attempt-bound
    // implementer has changed underneath it. Re-deriving either would show up
    // here; supplying the same values on both calls would not, because a
    // re-derivation would land on the same answer and the test would pass
    // while proving nothing.
    const restarted = host.restart();
    restarted.writeState({
      implementer: {
        itemAttemptId: (restarted.state.itemAttempt as { id: string }).id,
        model: "a-different-implementer", source: "explicit-pin", evidence: "configured",
      },
    });
    const replay = prepareReviewRound(restarted, params({
      report: { reviewerModel: "sonnet-5", reviewerEvidence: "configured" },
    }));
    expect(replay.replay).toBe(true);
    expect(replay.identity.reviewerIdentity).toEqual(first.identity.reviewerIdentity);
    expect(replay.identity.reviewerIdentity).toMatchObject({ model: "gpt-6-astra", evidence: "observed" });
    expect(replay.identity.implementer).toEqual(first.identity.implementer);
  });

  it("a replay keeps the BACKEND RUN the round was accepted with, even when the re-report omits it", () => {
    // The artifact was written under the accepted ids and its content hash does
    // not cover them, so a re-derived (or absent) run id would leave the record
    // naming an execution the artifact does not name.
    const host = new FakeHost(sessionDir);
    const first = prepareReviewRound(host, params({ report: { reviewerSessionId: "sess-accepted" } }));
    expect(first.identity.backendRunId).toBe("sess-accepted");

    const replay = prepareReviewRound(host.restart(), params({ report: {} }));
    expect(replay.replay).toBe(true);
    expect(replay.identity.backendRunId).toBe("sess-accepted");
    expect(replay.identity.backendRunIdKind).toBe("codex-session");
  });

  it("a CONTRADICTING run id is a new execution, not a replay of the accepted one", () => {
    // The fingerprint covers the payload, and two rounds can carry the same
    // verdict, summary and findings. An explicitly different execution id is
    // the only thing that tells them apart.
    const host = new FakeHost(sessionDir);
    const first = prepareReviewRound(host, params({ report: { reviewerSessionId: "sess-1" } }));
    const second = prepareReviewRound(host, params({ report: { reviewerSessionId: "sess-2" } }));

    expect(second.replay).toBe(false);
    expect(second.identity.reviewAttemptId).not.toBe(first.identity.reviewAttemptId);
    expect(second.identity.backendRunId).toBe("sess-2");
  });

  it("records unknown provenance rather than the session's implementer when the attempt differs", () => {
    // Item B's first round, with item A's implementer still on the session.
    const host = new FakeHost(sessionDir);
    host.writeState({
      implementer: { itemAttemptId: "attempt-for-item-A", model: "opus-5", source: "explicit-pin", evidence: "configured" },
    });
    const prepared = prepareReviewRound(host, params({ subject: { workItemId: "T-002", kind: "ticket" } }));
    expect(prepared.identity.implementer).toEqual({ source: "unknown", evidence: "none" });
  });

  it("uses the implementer when it belongs to THIS attempt", () => {
    const host = new FakeHost(sessionDir);
    const attemptId = "the-live-attempt";
    host.writeState({
      itemAttempt: { id: attemptId, workItemId: "T-001", kind: "ticket", startedAt: NOW, generation: 0 },
      implementer: { itemAttemptId: attemptId, model: "sonnet-5", source: "explicit-pin", evidence: "configured" },
    });
    const prepared = prepareReviewRound(host, params());
    expect(prepared.identity.implementer).toMatchObject({ model: "sonnet-5", evidence: "configured" });
  });
});

describe("a subjectless round writes neither identity field", () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), "t488-nosubject-")); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  it("omits workItemId and kind rather than writing a placeholder", () => {
    // A placeholder would either fail schema validation or collide across
    // items, and "unknown" as an id is a value that looks like an address.
    const host = new FakeHost(sessionDir);
    const prepared = prepareReviewRound(host, params({ subject: null, target: "unknown" }));
    expect(prepared.identity.workItemId).toBeUndefined();
    expect(prepared.identity.kind).toBeUndefined();
    expect(prepared.identity.itemAttemptId).toBeUndefined();
    expect(Object.keys(host.state.pendingReviewAttempt as object)).not.toContain("workItemId");
  });
});

describe("artifactStatus", () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), "t488-status-")); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  it("says written on a fresh write and exists on an adopted one", () => {
    const host = new FakeHost(sessionDir);
    const prepared = prepareReviewRound(host, params());
    expect((writeArtifactFor(host, prepared) as { artifactStatus: string }).artifactStatus).toBe("written");
    expect((writeArtifactFor(host, prepared) as { artifactStatus: string }).artifactStatus).toBe("exists");
  });

  it("an ABSENT value survives the PRODUCTION parser as absent, rather than being defaulted", () => {
    // 90 local pre-artifact-era rounds have no artifact at all, and the
    // westworld rounds had theirs dropped by the collision. Neither may be
    // read as "an artifact exists", and neither may be read as "it is missing".
    //
    // Asserted through the real schema, not a hand-built object: a literal
    // with no `artifactStatus` key is undefined whatever the schema does, so
    // it cannot detect a default being filled in on the way through.
    const parsed = SessionStateSchema.parse(legacyStateWithOneRound());
    const round = parsed.reviews.code[0]!;
    expect(round.artifactStatus).toBeUndefined();
    expect(round.artifactStatus === "written").toBe(false);
    expect(round.artifactStatus === "exists").toBe(false);
  });

  it("an I/O failure produces a retry naming it, and records no round", () => {
    // A FILE where the reviews directory has to be, so `mkdirSync` throws
    // outside the lock and the outer catch reports it as what it is.
    const host = new FakeHost(sessionDir);
    const prepared = prepareReviewRound(host, params());
    mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
    writeFileSync(join(sessionDir, "telemetry", "reviews"), "not a directory");

    const result = writeArtifactFor(host, prepared);
    expect(result.kind).toBe("retry");
    expect(result.kind === "retry" && result.instruction).toContain("I/O error");
    expect(result.kind === "retry" && result.instruction).toContain("Re-report your review verdict");
    expect(artifactNames(sessionDir)).toEqual([]);
  });

  it("an unavailable lock produces a DIFFERENT reason, not the same one", () => {
    // The two reasons exist so a lock timeout and a full disk do not read
    // identically to whoever is looking at a stopped session. They are also
    // the WHOLE enum: there is no "telemetry disabled" state to distinguish,
    // because nothing gates this writer off -- so recording a fault as a
    // deliberate configuration would be inventing intent from a failure.
    const host = new FakeHost(sessionDir);
    const prepared = prepareReviewRound(host, params());
    // proper-lockfile takes `<dir>.lock`; holding it makes the acquisition
    // fail while the directory itself stays perfectly writable.
    mkdirSync(join(sessionDir, "telemetry"), { recursive: true });
    mkdirSync(join(sessionDir, "telemetry.lock"), { recursive: true });

    const result = writeArtifactFor(host, prepared);
    expect(result.kind).toBe("retry");
    expect(result.kind === "retry" && result.instruction)
      .toContain("telemetry lock or directory unavailable");
    expect(artifactNames(sessionDir)).toEqual([]);
  });
});
