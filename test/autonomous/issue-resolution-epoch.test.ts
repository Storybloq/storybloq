/**
 * ISS-1032 (T-470 Amendment A5): `parseIssueResolutionEpoch` and
 * `issueEpochProvesOwnership`, the ABA-ownership proof for `parkCurrentIssue`.
 */
import { describe, it, expect } from "vitest";
import {
  parseIssueResolutionEpoch,
  issueEpochProvesOwnership,
  type IssueResolutionEpoch,
} from "../../src/autonomous/issue-resolution-epoch.js";
import { SessionStateSchema, type FullSessionState } from "../../src/autonomous/session-types.js";
import { IssueSchema } from "../../src/models/issue.js";

const EPOCH: IssueResolutionEpoch = {
  issueId: "i-abc1230000000001",
  sessionId: "00000000-0000-0000-0000-0000000000c7",
  establishedAt: "2026-08-29T00:00:00.000Z",
};

describe("parseIssueResolutionEpoch", () => {
  it("returns null for absent, null, and non-object values", () => {
    expect(parseIssueResolutionEpoch(undefined)).toBeNull();
    expect(parseIssueResolutionEpoch(null)).toBeNull();
    expect(parseIssueResolutionEpoch("i-abc")).toBeNull();
    expect(parseIssueResolutionEpoch(42)).toBeNull();
  });

  it("rejects an epoch missing any identifying field", () => {
    expect(parseIssueResolutionEpoch({ sessionId: EPOCH.sessionId, establishedAt: EPOCH.establishedAt })).toBeNull();
    expect(parseIssueResolutionEpoch({ issueId: EPOCH.issueId, establishedAt: EPOCH.establishedAt })).toBeNull();
    expect(parseIssueResolutionEpoch({ issueId: EPOCH.issueId, sessionId: EPOCH.sessionId })).toBeNull();
  });

  it("rejects empty-string ids rather than treating them as present", () => {
    expect(parseIssueResolutionEpoch({ ...EPOCH, issueId: "" })).toBeNull();
    expect(parseIssueResolutionEpoch({ ...EPOCH, sessionId: "" })).toBeNull();
  });

  it("accepts a well-formed epoch", () => {
    expect(parseIssueResolutionEpoch(EPOCH)).toEqual(EPOCH);
  });

  it("accepts a well-formed epoch carrying additional passthrough keys, ignoring them", () => {
    expect(parseIssueResolutionEpoch({ ...EPOCH, extra: "ignored" })).toEqual(EPOCH);
  });
});

describe("issueEpochProvesOwnership [ISS-1032 Amendment A5]", () => {
  it("legacy match: a genuinely ABSENT (undefined) issue-side epoch is sufficient regardless of the session side", () => {
    expect(issueEpochProvesOwnership(undefined, undefined)).toBe(true);
    expect(issueEpochProvesOwnership(undefined, EPOCH)).toBe(true);
    expect(issueEpochProvesOwnership(undefined, null)).toBe(true);
  });

  /**
   * [codex round-2 finding #1] a PRESENT-but-invalid issue-side value (an
   * explicit null -- nothing in this codebase legitimately writes one for
   * this field -- or garbage) must NOT get the same legacy treatment as a
   * genuinely absent field: that would silently restore the pre-A5
   * status-only proof for a corrupted-but-current issue, exactly the
   * fail-open D1 forbids.
   */
  it("[codex round-2 finding #1] a present-but-invalid issue-side epoch (explicit null, or malformed) fails closed, unlike a genuinely absent one", () => {
    expect(issueEpochProvesOwnership(null, null)).toBe(false);
    expect(issueEpochProvesOwnership(null, EPOCH)).toBe(false);
    expect(issueEpochProvesOwnership({ garbage: true }, null)).toBe(false);
    expect(issueEpochProvesOwnership({ garbage: true }, EPOCH)).toBe(false);
  });

  it("a stamped issue-side epoch with no session-side epoch fails closed (not-ours)", () => {
    expect(issueEpochProvesOwnership(EPOCH, null)).toBe(false);
    expect(issueEpochProvesOwnership(EPOCH, undefined)).toBe(false);
  });

  it("a stamped issue-side epoch with a malformed session-side epoch fails closed", () => {
    expect(issueEpochProvesOwnership(EPOCH, { issueId: EPOCH.issueId })).toBe(false);
  });

  it("[ABA hazard, codex round-1 finding #2] a foreign session's resolve-reopen-resolve cycle mints a NEW epoch that no longer matches this session's stale copy", () => {
    const foreignReresolve: IssueResolutionEpoch = {
      ...EPOCH,
      sessionId: "ffffffff-0000-0000-0000-000000000009",
      establishedAt: "2026-08-29T01:00:00.000Z",
    };
    expect(issueEpochProvesOwnership(foreignReresolve, EPOCH)).toBe(false);
  });

  it("an exact match on all three fields proves ownership", () => {
    expect(issueEpochProvesOwnership(EPOCH, { ...EPOCH })).toBe(true);
  });

  it("a mismatch on issueId alone (defensive: should never happen for the same record) fails closed", () => {
    expect(issueEpochProvesOwnership(EPOCH, { ...EPOCH, issueId: "i-other0000000001" })).toBe(false);
  });
});

/**
 * ISS-1032 (Amendment A5), round-trip discipline mirroring
 * plan-review-gate-ack.test.ts's "frozenGate ... round-trips through the real
 * Zod schema" test: guards against a future edit that starts treating either
 * field as schema-modeled without actually adding it to the Zod object,
 * which would silently strip it on the very persistence path every session
 * reload and every issue read goes through.
 */
describe("[ISS-1032 Amendment A5] old readers pass the new fields through untouched", () => {
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
      ticket: undefined,
      filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
      ...overrides,
    } as FullSessionState;
  }

  it("session-state: issueResolutionEpoch is schema-escaping (like claimEpoch) and survives SessionStateSchema.parse byte-identical", () => {
    const parsed = SessionStateSchema.parse(makeState({
      issueResolutionEpoch: EPOCH,
    } as unknown as Partial<FullSessionState>));
    expect((parsed as unknown as Record<string, unknown>).issueResolutionEpoch).toEqual(EPOCH);
  });

  it("issue: resolutionEpoch is a passthrough field on IssueSchema and survives IssueSchema.parse byte-identical", () => {
    const rawIssue = {
      id: "ISS-901", title: "Fixed", status: "resolved", severity: "high",
      components: [], impact: "test", resolution: "fixed", location: [],
      discoveredDate: "2026-08-29", resolvedDate: "2026-08-29", relatedTickets: [],
      resolutionEpoch: EPOCH,
    };
    const parsed = IssueSchema.parse(rawIssue);
    expect((parsed as unknown as Record<string, unknown>).resolutionEpoch).toEqual(EPOCH);
  });
});
