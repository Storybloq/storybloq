/**
 * B6/B8 (ISS-1049/ISS-1032, plan-run6.md): `codeReviewRoundCounter` and
 * `pendingCeilingEscalation` renamed `ticketId` -> `workItemId` + `kind`.
 *
 * A pre-rename `state.json` (written by an OLDER build, no `kind`, no
 * `workItemId`) must resume through the REAL `SessionStateSchema.parse` --
 * not a hand-rolled stand-in -- and land on the safe restart-at-0 posture,
 * never a crash and never a stale carry-forward of a shape the ceiling no
 * longer understands. `z.preprocess(preprocessLegacyTicketIdShape, ...)` is
 * what buys this: it recognizes ONLY the one known pre-rename shape
 * (`ticketId` present, `workItemId`/`kind` both absent) and maps THAT to
 * `null` before the object schema ever runs, so the legacy shape degrades
 * safely while a malformed CURRENT-format record (which is not that
 * recognized shape) still fails the parse loudly (codex round-1 finding:
 * a blanket `.catch(null)` on the whole object would have converted BOTH
 * cases to `null` indiscriminately).
 */
import { describe, it, expect } from "vitest";
import { SessionStateSchema, type FullSessionState } from "../../src/autonomous/session-types.js";
import { roundsForWorkItem } from "../../src/autonomous/stages/code-review-ceiling.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-00000000000e",
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"], handoverInterval: 3 },
    ticket: { id: "t-ce111n9000000901", displayId: "T-901", title: "Test ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

describe("codeReviewRoundCounter / pendingCeilingEscalation: pre-rename resume [B6/B8]", () => {
  it("a pre-rename round counter ({ticketId, completedRounds}, no kind, no workItemId) parses to null rather than throwing", () => {
    const parsed = SessionStateSchema.parse(makeState({
      codeReviewRoundCounter: { ticketId: "T-901", completedRounds: 4 },
    } as unknown as Partial<FullSessionState>));

    expect(parsed.codeReviewRoundCounter).toBeNull();
    // The safe restart-at-0 posture, read through the REAL helper, not asserted.
    expect(roundsForWorkItem(parsed.codeReviewRoundCounter, { kind: "ticket", id: "T-901" })).toBe(0);
  });

  it("a pre-rename pending escalation ({ticketId, ...}, no kind, no workItemId) parses to null rather than throwing", () => {
    const parsed = SessionStateSchema.parse(makeState({
      pendingCeilingEscalation: {
        ticketId: "T-901", round: 4, ceiling: 7, maxReviewRounds: 4,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(),
      },
    } as unknown as Partial<FullSessionState>));

    expect(parsed.pendingCeilingEscalation).toBeNull();
  });

  it("both fields together, on the same legacy record, both degrade safely in one parse", () => {
    const parsed = SessionStateSchema.parse(makeState({
      codeReviewRoundCounter: { ticketId: "T-901", completedRounds: 9 },
      pendingCeilingEscalation: {
        ticketId: "T-901", round: 9, ceiling: 9, maxReviewRounds: 6,
        reason: "stale", unresolvedCritical: 0, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(),
      },
    } as unknown as Partial<FullSessionState>));

    expect(parsed.codeReviewRoundCounter).toBeNull();
    expect(parsed.pendingCeilingEscalation).toBeNull();
  });

  it("a genuinely absent field (never written by any build) still parses to null, unaffected by the rename", () => {
    const parsed = SessionStateSchema.parse(makeState());
    expect(parsed.codeReviewRoundCounter).toBeNull();
    expect(parsed.pendingCeilingEscalation).toBeNull();
  });

  it("a POST-rename record (workItemId + kind) round-trips unchanged", () => {
    const parsed = SessionStateSchema.parse(makeState({
      codeReviewRoundCounter: { workItemId: "i-abc", kind: "issue", completedRounds: 3 },
    } as Partial<FullSessionState>));

    expect(parsed.codeReviewRoundCounter).toEqual({ workItemId: "i-abc", kind: "issue", completedRounds: 3 });
    expect(roundsForWorkItem(parsed.codeReviewRoundCounter, { kind: "issue", id: "i-abc" })).toBe(3);
  });

  /**
   * codex round-1 finding: a blanket `.catch(null)` on the whole object
   * would convert THIS failure to null too, silently discarding an
   * in-progress round count rather than failing the parse loudly. Only the
   * ONE recognized pre-rename shape (`ticketId` present, `workItemId`/`kind`
   * absent) may degrade to null -- a malformed CURRENT-format record (a
   * `kind` outside the enum) must still throw.
   */
  it("[codex round-1] a malformed CURRENT-format round counter (invalid kind) still throws, not silently null", () => {
    expect(() => SessionStateSchema.parse(makeState({
      codeReviewRoundCounter: { workItemId: "T-901", kind: "epic", completedRounds: 4 },
    } as unknown as Partial<FullSessionState>))).toThrow();
  });

  it("[codex round-1] a malformed CURRENT-format pending escalation (workItemId present but kind missing) still throws, not silently null", () => {
    expect(() => SessionStateSchema.parse(makeState({
      pendingCeilingEscalation: {
        workItemId: "T-901", round: 4, ceiling: 7, maxReviewRounds: 4,
        reason: "x", unresolvedCritical: 0, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(),
      },
    } as unknown as Partial<FullSessionState>))).toThrow();
  });

  /**
   * [codex round-3 finding] the round-2 preprocessor recognized a legacy
   * record by KEY PRESENCE alone (`ticketId` present, `workItemId`/`kind`
   * absent) without checking the values' TYPES. `{ticketId: 123,
   * completedRounds: "corrupt"}` has the right shape but the wrong types --
   * that is corruption, not the pre-rename format, and treating it as safely
   * legacy silently resets an in-progress round count exactly the way D1
   * forbids. It must throw, not degrade to null.
   */
  it("[codex round-3] a legacy-SHAPED but internally corrupt round counter (non-string ticketId) still throws, not silently null", () => {
    expect(() => SessionStateSchema.parse(makeState({
      codeReviewRoundCounter: { ticketId: 123, completedRounds: 4 },
    } as unknown as Partial<FullSessionState>))).toThrow();
  });

  it("[codex round-3] a legacy-SHAPED but internally corrupt round counter (non-numeric completedRounds) still throws, not silently null", () => {
    expect(() => SessionStateSchema.parse(makeState({
      codeReviewRoundCounter: { ticketId: "T-901", completedRounds: "corrupt" },
    } as unknown as Partial<FullSessionState>))).toThrow();
  });

  it("[codex round-3] a legacy-SHAPED but truncated pending escalation (missing reason, non-numeric round) still throws, not silently null", () => {
    expect(() => SessionStateSchema.parse(makeState({
      pendingCeilingEscalation: {
        ticketId: "T-901", round: "four", ceiling: 7, maxReviewRounds: 4,
        unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(),
      },
    } as unknown as Partial<FullSessionState>))).toThrow();
  });

  it("a genuinely well-formed pre-rename round counter and pending escalation still degrade to null (sanity: the round-3 tightening did not break the legacy path itself)", () => {
    const parsed = SessionStateSchema.parse(makeState({
      codeReviewRoundCounter: { ticketId: "T-901", completedRounds: 4 },
      pendingCeilingEscalation: {
        ticketId: "T-901", round: 4, ceiling: 7, maxReviewRounds: 4,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(),
      },
    } as unknown as Partial<FullSessionState>));
    expect(parsed.codeReviewRoundCounter).toBeNull();
    expect(parsed.pendingCeilingEscalation).toBeNull();
  });

  it("planReviewRoundCounter and pendingPlanCeilingEscalation are UNCHANGED -- still ticketId-shaped, out of B6's scope", () => {
    const parsed = SessionStateSchema.parse(makeState({
      planReviewRoundCounter: { ticketId: "T-901", completedRounds: 2 },
    } as unknown as Partial<FullSessionState>));
    expect(parsed.planReviewRoundCounter).toEqual({ ticketId: "T-901", completedRounds: 2 });
  });
});
