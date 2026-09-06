/**
 * T-488 Run A: the schema is ADDITIVE, and absence keeps its meaning.
 *
 * Every field this ticket adds is optional. That is not a convenience, it is
 * the property that lets a record written before the field still be read, and
 * lets `absent` mean "this was never recorded" rather than "this was measured
 * and came back empty". Three of the new fields depend on that distinction
 * being preserved rather than collapsed, and they are asserted individually
 * below.
 *
 * These parse through the REAL `SessionStateSchema`, never a stand-in: the
 * whole risk being covered is that a persisted state stops loading, and a
 * hand-rolled schema cannot fail that way.
 */
import { describe, it, expect } from "vitest";
import { SessionStateSchema } from "../../src/autonomous/session-types.js";

const NOW = "2026-09-05T12:00:00.000Z";

/** A `state.json` shaped as an older build wrote it: no spine anywhere. */
function legacyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000004ee",
    recipe: "coding", state: "CODE_REVIEW", revision: 4, status: "active", mode: "auto",
    reviews: {
      plan: [{
        round: 1, reviewer: "codex", verdict: "approve", findingCount: 0,
        criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: NOW,
      }],
      code: [{
        round: 1, reviewer: "agent", verdict: "revise", findingCount: 1,
        criticalCount: 0, majorCount: 1, suggestionCount: 0, timestamp: NOW,
      }],
    },
    completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: NOW, expiresAt: NOW },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: NOW, startedAt: NOW, guideCallCount: 4,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"], handoverInterval: 3 },
    ticket: { id: "T-001", displayId: "T-001", title: "Legacy ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  };
}

describe("legacy state parses with the spine absent", () => {
  it("loads a pre-T-488 session unchanged", () => {
    const parsed = SessionStateSchema.parse(legacyState());
    expect(parsed.reviews.plan).toHaveLength(1);
    expect(parsed.reviews.code).toHaveLength(1);
    expect(parsed.itemAttempt).toBeNull();
    expect(parsed.implementer).toBeNull();
    expect(parsed.pendingReviewAttempt).toBeNull();
    expect(parsed.reviewGenerationHistory).toEqual([]);
  });

  it("leaves every new round field undefined rather than defaulting it", () => {
    const parsed = SessionStateSchema.parse(legacyState());
    const round = parsed.reviews.code[0]!;
    for (const key of [
      "workItemId", "kind", "reviewAttemptId", "itemAttemptId",
      "backendRunId", "backendRunIdKind", "backendTurnId", "backend",
      "normalizerVersion", "generation", "payloadConsistent",
      "reviewerIdentity", "implementer", "artifactStatus",
    ] as const) {
      expect((round as Record<string, unknown>)[key], key).toBeUndefined();
    }
  });

  it("an absent normalizerVersion is NOT read as normalized", () => {
    // The corpus is a genuine mix. Artifacts exist carrying `blocking`, which
    // the current normalizer would have changed -- so a record with no version
    // number may not have been normalized at all, and assuming otherwise would
    // make every severity statistic read as more precise than it is.
    const round = SessionStateSchema.parse(legacyState()).reviews.code[0]!;
    expect(round.normalizerVersion).toBeUndefined();
    expect(round.normalizerVersion === 1).toBe(false);
  });

  it("an absent artifactStatus is unknown, not present and not missing", () => {
    const round = SessionStateSchema.parse(legacyState()).reviews.code[0]!;
    expect(round.artifactStatus).toBeUndefined();
    expect(round.artifactStatus === "written").toBe(false);
    expect(round.artifactStatus === "exists").toBe(false);
  });

  it("an absent generation is uninitialized, which is not 0", () => {
    // Load-bearing: the legacy directory scan runs only on absence. Firing it
    // on a valid 0 would also fire on round 2 of an ordinary attempt, which has
    // just written its own r1 at generation 0.
    const parsed = SessionStateSchema.parse(legacyState({
      itemAttempt: { id: "a1", workItemId: "T-001", kind: "ticket", startedAt: NOW },
    }));
    // The attempt has to SURVIVE first. Optional chaining alone reports the
    // same `undefined` whether the generation was preserved as absent or the
    // whole attempt was dropped to null, and those are opposite outcomes.
    expect(parsed.itemAttempt).toMatchObject({ id: "a1", workItemId: "T-001" });
    expect(parsed.itemAttempt!.generation).toBeUndefined();
    expect(parsed.itemAttempt!.generation ?? "absent").toBe("absent");
  });

  it("a generation of 0 survives as the NUMBER 0, which is the other half of the distinction", () => {
    // Absent and 0 are different states and the scan fires on only one of
    // them, so a schema that coerced a valid 0 away would rescan a directory
    // on every ordinary round.
    const parsed = SessionStateSchema.parse(legacyState({
      itemAttempt: { id: "a1", workItemId: "T-001", kind: "ticket", startedAt: NOW, generation: 0 },
    }));
    expect(parsed.itemAttempt).toMatchObject({ id: "a1" });
    expect(parsed.itemAttempt!.generation).toBe(0);
    expect(parsed.itemAttempt!.generation).not.toBeUndefined();
  });
});

describe("a current-format state round-trips", () => {
  const current = legacyState({
    reviews: {
      plan: [],
      code: [{
        round: 1, reviewer: "codex", verdict: "approve", findingCount: 0,
        criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: NOW,
        workItemId: "T-001", kind: "ticket",
        reviewAttemptId: "r1", itemAttemptId: "a1",
        backendRunId: "sess-1", backendRunIdKind: "codex-session",
        backend: "codex", normalizerVersion: 1, generation: 2, payloadConsistent: true,
        reviewerIdentity: { model: "gpt-6-astra", source: "explicit-pin", evidence: "configured" },
        implementer: { model: "sonnet-5", source: "session-default", evidence: "configured" },
        artifactStatus: "written",
      }],
    },
    itemAttempt: { id: "a1", workItemId: "T-001", kind: "ticket", startedAt: NOW, generation: 2 },
    implementer: { itemAttemptId: "a1", model: "sonnet-5", source: "session-default", evidence: "configured" },
    reviewGenerationHistory: [{
      itemAttemptId: "a1", generation: 0, realizedRisk: "high",
      lensReviewHistory: [], endedAt: NOW, reason: "plan-redirect",
    }],
  });

  it("preserves every spine field through a parse", () => {
    const round = SessionStateSchema.parse(current).reviews.code[0]!;
    expect(round).toMatchObject({
      workItemId: "T-001", kind: "ticket", reviewAttemptId: "r1", itemAttemptId: "a1",
      backendRunId: "sess-1", backendRunIdKind: "codex-session", backend: "codex",
      normalizerVersion: 1, generation: 2, payloadConsistent: true, artifactStatus: "written",
    });
    expect(round.reviewerIdentity).toEqual({ model: "gpt-6-astra", source: "explicit-pin", evidence: "configured" });
  });

  it("preserves the attempt, the bound implementer and the retention history", () => {
    const parsed = SessionStateSchema.parse(current);
    expect(parsed.itemAttempt).toMatchObject({ id: "a1", generation: 2 });
    expect(parsed.implementer).toMatchObject({ itemAttemptId: "a1", model: "sonnet-5" });
    expect(parsed.reviewGenerationHistory?.[0]).toMatchObject({ generation: 0, realizedRisk: "high" });
  });

  it("carries a pending envelope through a resume", () => {
    const parsed = SessionStateSchema.parse(legacyState({
      pendingReviewAttempt: {
        reviewAttemptId: "r9", itemAttemptId: "a1", workItemId: "T-001", kind: "ticket",
        stage: "code", round: 3, generation: 1, payloadFingerprint: "fp",
        verdict: "revise", reviewer: "codex", summary: "s",
        findings: [{ severity: "major" }], decidedAt: NOW,
      },
    }));
    expect(parsed.pendingReviewAttempt).toMatchObject({
      reviewAttemptId: "r9", stage: "code", round: 3, generation: 1, payloadFingerprint: "fp",
    });
  });
});

describe("damaged audit data costs the disclosure, never the session", () => {
  it("a corrupt provenance object drops to undefined and the state still loads", () => {
    // The T-328 rule this schema already applies to `currentReviewEffort`:
    // nothing resumes work from provenance, so a hand-edited or newer-build
    // value must not be the reason a session cannot be read.
    const parsed = SessionStateSchema.parse(legacyState({
      reviews: {
        plan: [],
        code: [{
          round: 1, reviewer: "codex", verdict: "approve", findingCount: 0,
          criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: NOW,
          reviewerIdentity: "not an object",
          generation: "not a number",
        }],
      },
    }));
    const round = parsed.reviews.code[0]!;
    expect(round.reviewerIdentity).toBeUndefined();
    expect(round.generation).toBeUndefined();
    expect(round.round).toBe(1);
  });

  it("a corrupt retention array is discarded rather than failing the load", () => {
    const parsed = SessionStateSchema.parse(legacyState({ reviewGenerationHistory: "nonsense" }));
    expect(parsed.reviewGenerationHistory).toEqual([]);
    expect(parsed.reviews.code).toHaveLength(1);
  });

  it("a corrupt itemAttempt drops to null rather than failing the load", () => {
    const parsed = SessionStateSchema.parse(legacyState({ itemAttempt: { id: 7 } }));
    expect(parsed.itemAttempt).toBeNull();
  });

  it("an UNRECOGNIZED enum value survives, because the reader must not lose the session over it", () => {
    // A newer build's vocabulary reaching an older reader. These are bare
    // strings on the record for exactly this reason; the enums live on the
    // WRITE side, where rejecting a bad value is correct.
    const parsed = SessionStateSchema.parse(legacyState({
      reviews: {
        plan: [],
        code: [{
          round: 1, reviewer: "x", verdict: "approve", findingCount: 0,
          criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: NOW,
          backend: "some-2027-backend", kind: "epic", artifactStatus: "archived",
        }],
      },
    }));
    const round = parsed.reviews.code[0]!;
    expect(round.backend).toBe("some-2027-backend");
    expect(round.kind).toBe("epic");
    expect(round.artifactStatus).toBe("archived");
  });
});
