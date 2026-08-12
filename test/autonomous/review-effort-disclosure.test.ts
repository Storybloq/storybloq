import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildTier1Verdict,
  computeContentHash,
  type ReviewVerdictArtifact,
} from "../../src/autonomous/review-verdict.js";
import { formatSessionReport } from "../../src/core/session-report-formatter.js";
import { SessionStateSchema, type FullSessionState } from "../../src/autonomous/session-types.js";

/**
 * T-461 phase 4: the level reaching the DURABLE surfaces.
 *
 * Phase 3 put the level on every instruction, which discloses it to the agent
 * running the round and to nobody afterwards. These are the records a person
 * reads later -- the round history, the verdict artifact, the session report --
 * and the reason they need it is the same reason the instruction did: a
 * reviewed-at-light commit and a reviewed-at-standard commit are not the same
 * claim, and by the time anyone asks, the session field that would have said so
 * has been overwritten by the next item.
 */

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-00000000000d",
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
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

const round = (n: number, effort?: string) => ({
  round: n, reviewer: "codex", verdict: "approve",
  findingCount: 0, criticalCount: 0, unresolvedCriticalCount: 0,
  majorCount: 0, suggestionCount: 0,
  ...(effort === undefined ? {} : { effort }),
  timestamp: new Date().toISOString(),
});

const artifact = (extra: Partial<ReviewVerdictArtifact> = {}): ReviewVerdictArtifact => ({
  target: "T-001", stage: "code", round: 1, reviewer: "codex", verdict: "approve",
  findingsCount: 0,
  severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  unresolvedCriticalCount: 0,
  startedAt: "2026-08-12T00:00:00.000Z", durationMs: 1000,
  summary: "ok", findings: [], timestamp: "2026-08-12T00:00:01.000Z",
  ...extra,
});

describe("review effort on the persisted round record", () => {
  it("survives a schema round trip, including a value this build does not know", () => {
    // The persisted-field rule: permissive in, normalized out. A level from a
    // NEWER build must not strand the session -- the whole record is gated by
    // SessionStateSchema, so a strict field here costs a resume, not a value.
    const parsed = SessionStateSchema.parse(makeState({
      reviews: {
        plan: [round(1, "light")],
        code: [round(1, "thorough"), round(2, "from-the-future")],
      },
    } as Partial<FullSessionState>));

    expect(parsed.reviews.plan[0].effort).toBe("light");
    expect(parsed.reviews.code[0].effort).toBe("thorough");
    expect(parsed.reviews.code[1].effort).toBe("from-the-future");
  });

  it("keeps a pre-dial record parseable with the level simply absent", () => {
    const parsed = SessionStateSchema.parse(makeState({
      reviews: { plan: [], code: [round(1)] },
    } as Partial<FullSessionState>));
    expect(parsed.reviews.code[0].effort).toBeUndefined();
  });

  it("records the level per completed item, not per session", () => {
    // The reason this field exists: `currentReviewEffort` is overwritten on the
    // next pick, so without a per-item copy a session that ran one ticket at
    // light and the next at standard would report both as standard.
    const parsed = SessionStateSchema.parse(makeState({
      completedTickets: [
        { id: "T-001", displayId: "T-001", title: "a", commitHash: "abc", reviewEffort: "light" },
        { id: "T-002", displayId: "T-002", title: "b", commitHash: "def", reviewEffort: "standard" },
      ],
      currentReviewEffort: "thorough",
    } as unknown as Partial<FullSessionState>));

    expect(parsed.completedTickets.map((t) => (t as { reviewEffort?: string }).reviewEffort))
      .toEqual(["light", "standard"]);
  });
});

describe("review effort on the verdict artifact", () => {
  it("carries onto Tier1 so lastReviewVerdict discloses it too", () => {
    expect(buildTier1Verdict(artifact({ effort: "light" })).effort).toBe("light");
  });

  it("omits the key entirely on a pre-dial artifact rather than inventing one", () => {
    // `standard` would be a guess. An absent level means the record predates
    // the dial, and the three not-attributable provenances exist precisely so
    // that distinction is never quietly collapsed.
    expect("effort" in buildTier1Verdict(artifact())).toBe(false);
  });

  it("survives the state write that a plain z.object would have stripped", () => {
    // The trap this feature has now hit twice: a plain `z.object` DROPS what it
    // does not declare, so putting `effort` on the Tier1 projection was not
    // enough -- `lastReviewVerdict` had to declare it too, or every write threw
    // the level away and the artifact and the session record disagreed about
    // the same round. `recipeOverrides.reviewEffort` was dead for exactly this
    // reason until an end-to-end test caught it.
    const parsed = SessionStateSchema.parse(makeState({
      lastReviewVerdict: buildTier1Verdict(artifact({ effort: "light" })),
    } as unknown as Partial<FullSessionState>));
    expect((parsed.lastReviewVerdict as { effort?: string } | null | undefined)?.effort).toBe("light");

    // A pre-dial verdict still parses, with no level rather than a guessed one.
    const legacy = SessionStateSchema.parse(makeState({
      lastReviewVerdict: buildTier1Verdict(artifact()),
    } as unknown as Partial<FullSessionState>));
    expect((legacy.lastReviewVerdict as { effort?: string } | null | undefined)?.effort).toBeUndefined();
  });

  it("leaves the content hash untouched, so the dial does not rewrite history", () => {
    // `effort` joins reviewId/reviewerPath/timestamp/durationMs in the
    // exclusion list. Two rounds with identical findings and verdict are the
    // same review whether one ran at light -- and hashing it would change every
    // artifact hash the moment the dial shipped, which is the cross-version
    // churn the exclusion list exists to prevent.
    const base = computeContentHash(artifact());
    expect(computeContentHash(artifact({ effort: "light" }))).toBe(base);
    expect(computeContentHash(artifact({ effort: "thorough" }))).toBe(base);

    // Positive control: the hash is not simply insensitive to everything.
    expect(computeContentHash(artifact({ verdict: "revise" }))).not.toBe(base);
  });
});

describe("review effort in the session report", () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "effort-report-"));
    dir = join(root, ".story", "sessions", "s1");
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const report = (state: FullSessionState) =>
    formatSessionReport({ state, events: { events: [], malformedCount: 0 }, sessionDir: dir }, "markdown");

  it("annotates only the rounds that ran below or above standard", () => {
    const text = report(makeState({
      reviews: { plan: [round(1, "light")], code: [round(1, "standard"), round(2, "thorough"), round(3)] },
    } as Partial<FullSessionState>));

    expect(text).toContain("Round 1: approve (0 findings, 0 critical, 0 unresolved critical, 0 major) -- codex @ light");
    expect(text).toContain("Round 2: approve (0 findings, 0 critical, 0 unresolved critical, 0 major) -- codex @ thorough");
    // standard is what every pre-dial round ran at and what an unset dial still
    // runs at, so annotating it would add a token to every line of every report
    // to say nothing changed. Round 3 has no recorded level at all -- a
    // pre-dial record -- and is left alone for the same reason.
    expect(text).not.toContain("@ standard");
    expect(text).toContain("Round 3: approve (0 findings, 0 critical, 0 unresolved critical, 0 major) -- codex\n");
  });

  it("does not print a level this build cannot recognize", () => {
    // The field is a bare string by design, so a corrupt or newer value reaches
    // here. Printing it verbatim would put unvalidated text into a document a
    // person reads as fact.
    const text = report(makeState({
      reviews: { plan: [], code: [round(1, "<script>")] },
    } as Partial<FullSessionState>));
    expect(text).not.toContain("<script>");
    expect(text).not.toContain(" @ ");
  });

  it("separates a deliberate skip from an empty section", () => {
    // "No reviews recorded" reads as an anomaly. A session that ran at `off`
    // has no anomaly to report, and a reader deciding whether a commit was
    // reviewed needs the two told apart.
    expect(report(makeState({
      currentReviewEffort: "off",
      currentReviewEffortSource: "item",
    } as Partial<FullSessionState>)))
      .toContain("Review effort: off (item). Reviews were skipped for this work; no review verdict exists.");

    expect(report(makeState())).toContain("No reviews recorded.");
  });
});
