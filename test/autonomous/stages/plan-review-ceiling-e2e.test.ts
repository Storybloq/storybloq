/**
 * ISS-598/ISS-1031: the PLAN_REVIEW ceiling and scope-drift hint, driven
 * through `PlanReviewStage` directly against a real ephemeral `.story/`
 * project -- mirroring `code-review-ceiling.test.ts`'s "end to end through the
 * stage" section, adapted for PLAN_REVIEW's own shape:
 *
 *  - The park target is PICK_TICKET, not HANDOVER: nothing has been
 *    implemented yet at PLAN_REVIEW, so the tree is clean and the queue can
 *    advance instead of ending the session (ISS-1031's distinct point from
 *    CODE_REVIEW's ceiling).
 *  - The ceiling bounds BOTH an ordinary revise-loop (isRevise always stays in
 *    PLAN_REVIEW, ISS-048, unbounded before this fix) AND a reject-loop
 *    (reject clears `reviews.plan` and returns to PLAN, invisible to any
 *    review-history-derived counter -- the ISS-904 blind spot this closes).
 *  - The scope-drift signal is advisory only: it appears as a hint in the
 *    retry instruction and as telemetry, and never itself changes routing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import { PLAN_REVIEW_HARD_CEILING_GRACE, DEFAULT_PLAN_REVIEW_MAX_ROUNDS } from "../../../src/autonomous/stages/plan-review-ceiling.js";
import { hashToken, hashPlanContent } from "../../../src/autonomous/stages/plan-review-drift.js";
import { StageContext } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../../src/autonomous/recipes/loader.js";

const TICKET = "t-p1ce111n90000012";
const CEILING = DEFAULT_PLAN_REVIEW_MAX_ROUNDS + PLAN_REVIEW_HARD_CEILING_GRACE; // 8
const SESSION_ID = "00000000-0000-0000-0000-0000000000p1";
const NOW = "2026-08-27T00:00:00.000Z";
/** A provable claim this session holds on TICKET, for the ownership-release tests below. */
const MY_CLAIM = { user: SESSION_ID, branch: "main", since: NOW };
const MY_CLAIM_EPOCH = {
  ticketId: TICKET, sessionId: SESSION_ID,
  user: MY_CLAIM.user, branch: MY_CLAIM.branch, since: MY_CLAIM.since,
  establishedAt: NOW,
};

/**
 * ISS-598 codex round 2 (test fixtures, minor): every active-baseline fixture
 * now needs `planHash` (the schema requires it) and hashed, not raw, tokens.
 * Routing every construction through one helper means a fixture cannot drift
 * out of the shape production code actually writes.
 */
function activeBaseline(rawTokens: readonly string[], planText = "placeholder plan text") {
  return { ticketId: TICKET, planHash: hashPlanContent(planText), tokens: rawTokens.map(hashToken), truncated: false };
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000000p1",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ticket: { id: TICKET, displayId: "T-901", title: "Non-converging plan", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null,
    planReviewRoundCounter: null, pendingPlanCeilingEscalation: null,
    planReviewBaseline: null, planReviewDriftHistory: null,
    claimEpoch: MY_CLAIM_EPOCH,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  } as unknown as ResolvedRecipe;
}

const BLOCKING = [
  { severity: "critical", category: "correctness", description: "Off-by-one in the retry bound", disposition: "open" },
  { severity: "major", category: "security", description: "Token logged at debug level", disposition: "open" },
  { severity: "suggestion", category: "style", description: "Rename this variable", disposition: "open" },
];

describe("the PLAN_REVIEW ceiling, end to end through the stage", () => {
  let root: string;
  let sDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plan-ceiling-"));
    const storyDir = join(root, ".story");
    for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
      mkdirSync(join(storyDir, sub), { recursive: true });
    }
    writeFileSync(join(storyDir, "config.json"), JSON.stringify({
      version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
      title: "test", date: "2026-08-27",
      phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
    }));
    // Claim fields matching MY_CLAIM/MY_CLAIM_EPOCH (codex round 2, test
    // validity): without these, park.ts's ownership proof cannot succeed and
    // silently takes the not-ours/drop path instead, which routes to
    // PICK_TICKET the same as a proven release -- a "parks to PICK_TICKET"
    // test would pass either way and never actually exercise the release.
    writeFileSync(join(storyDir, "tickets", `${TICKET}.json`), JSON.stringify({
      id: TICKET, displayId: "T-901", title: "Non-converging plan", description: "A test.",
      type: "task", status: "inprogress", phase: "p1", order: 10,
      createdDate: "2026-08-27", completedDate: null, blockedBy: [],
      claimedBySession: SESSION_ID, claim: MY_CLAIM,
    }));
    sDir = join(storyDir, "sessions", "s1");
    mkdirSync(sDir, { recursive: true });
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function atRound(n: number, over: Partial<FullSessionState> = {}): FullSessionState {
    return makeState({
      planReviewRoundCounter: { ticketId: TICKET, completedRounds: n - 1 },
      ...over,
    });
  }

  function issuesOnDisk(): Record<string, unknown>[] {
    return readdirSync(join(root, ".story", "issues"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(root, ".story", "issues", f), "utf-8")));
  }

  function ticketOnDisk(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, ".story", "tickets", `${TICKET}.json`), "utf-8"));
  }

  async function reportRound(state: FullSessionState, verdict = "revise", findings: unknown[] = BLOCKING) {
    const ctx = new StageContext(root, sDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round", verdict, findings,
    } as never);
    return { advance, ctx };
  }

  it("keeps reviewing below the ceiling", async () => {
    const { advance } = await reportRound(atRound(CEILING - 1));
    expect(advance.action).not.toBe("goto");
    expect(issuesOnDisk().length).toBe(0);
  });

  /**
   * PICK_TICKET, not HANDOVER: nothing is implemented at PLAN_REVIEW, so the
   * tree is clean and the queue can advance to the next item. Also proves the
   * claim was actually RELEASED (codex round 2, test validity) -- routing to
   * PICK_TICKET alone is consistent with both a proven release and the
   * not-ours/drop path, so without this the test would pass even if ownership
   * was never proven at all.
   */
  it("parks to PICK_TICKET at the ceiling, proving the claim was released", async () => {
    const { advance } = await reportRound(atRound(CEILING));
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("PICK_TICKET");
    const ticket = ticketOnDisk();
    expect(ticket.status).toBe("open");
    expect(ticket.claimedBySession).toBeUndefined();
    expect(ticket.claim).toBeUndefined();
    expect((ticket.park as { reason?: string })?.reason).toContain("ceiling");
  });

  /**
   * Explicit NOT-OURS control (codex round 2, test validity): a claim that
   * does not match this session's epoch must leave the ticket exactly as it
   * was, even though routing still goes to PICK_TICKET either way. This is
   * the contrast that makes the test above meaningful -- without it, nothing
   * in this suite proves "parked" and "not-ours" are actually distinguishable
   * outcomes rather than the same code path observed twice.
   */
  it("does not touch a ticket this session cannot prove it owns, even though routing is unaffected", async () => {
    const rivalClaim = { user: "rival-session", branch: "main", since: NOW };
    writeFileSync(join(root, ".story", "tickets", `${TICKET}.json`), JSON.stringify({
      id: TICKET, displayId: "T-901", title: "Non-converging plan", description: "A test.",
      type: "task", status: "inprogress", phase: "p1", order: 10,
      createdDate: "2026-08-27", completedDate: null, blockedBy: [],
      claimedBySession: "rival-session", claim: rivalClaim,
    }));
    const { advance } = await reportRound(atRound(CEILING));
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("PICK_TICKET");
    const ticket = ticketOnDisk();
    expect(ticket.status).toBe("inprogress");
    expect(ticket.claimedBySession).toBe("rival-session");
    expect(ticket.claim).toEqual(rivalClaim);
  });

  it("routes somewhere the state machine actually permits", async () => {
    const { isValidTransition } = await import("../../../src/autonomous/state-machine.js");
    expect(isValidTransition("PLAN_REVIEW", "PICK_TICKET")).toBe(true);
  });

  it("files the outstanding open findings as issues, excluding the suggestion", async () => {
    await reportRound(atRound(CEILING));
    const issues = issuesOnDisk();
    expect(issues.length).toBe(2);
    const severities = issues.map((i) => i.severity).sort();
    expect(severities).toEqual(["critical", "high"]);
  });

  it("persists the round it stopped at", async () => {
    const { ctx } = await reportRound(atRound(CEILING));
    expect(ctx.state.planReviewRoundCounter?.completedRounds).toBe(CEILING);
    expect(ctx.state.planReviewRoundCounter?.ticketId).toBe(TICKET);
  });

  /**
   * THE ISS-904 BLIND SPOT, closed. `reviews.plan` is cleared on every
   * reject, so a naive counter derived from it never sees a reject-loop. The
   * ceiling's own counter is independent of that array and bounds it anyway.
   */
  it("bounds a reject-loop the same as a revise-loop", async () => {
    const { advance, ctx } = await reportRound(atRound(CEILING), "reject", []);
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("PICK_TICKET");
    expect(ctx.state.reviews.plan.length).toBe(0); // reject still clears history
    expect(ctx.state.planReviewRoundCounter?.completedRounds).toBe(CEILING);
  });

  it("still lands on approve at the ceiling rather than parking", async () => {
    const { advance } = await reportRound(atRound(CEILING), "approve", []);
    expect((advance as { target?: string }).target).not.toBe("PICK_TICKET");
    expect(issuesOnDisk().length).toBe(0);
  });

  /**
   * IDEMPOTENCY. A resubmitted report must RESUME rather than be processed as
   * another round, which would increment the counter again.
   */
  it("a resubmitted report resumes rather than counting another round", async () => {
    const first = await reportRound(atRound(CEILING));
    expect(first.advance.action).toBe("goto");
    const afterFirst = first.ctx.state.planReviewRoundCounter?.completedRounds;

    const stuck = makeState({
      planReviewRoundCounter: { ticketId: TICKET, completedRounds: CEILING },
      pendingPlanCeilingEscalation: {
        ticketId: TICKET, round: CEILING, ceiling: CEILING, trigger: "round-ceiling",
        reason: "Plan review reached its hard ceiling of 8 rounds without an approvable plan.",
        unresolvedCritical: 1, unresolvedMajor: 1, decidedAt: new Date().toISOString(),
        findings: [], fingerprints: [], completed: false,
      },
    } as Partial<FullSessionState>);
    const second = await reportRound(stuck);

    expect(second.advance.action).toBe("goto");
    expect((second.advance as { target: string }).target).toBe("PICK_TICKET");
    expect(second.ctx.state.planReviewRoundCounter?.completedRounds).toBe(afterFirst);
  });

  it("does not resume an escalation recorded against a different ticket", async () => {
    const stale = makeState({
      planReviewRoundCounter: { ticketId: TICKET, completedRounds: 0 },
      pendingPlanCeilingEscalation: {
        ticketId: "t-someone-else", round: 9, ceiling: 9, trigger: "round-ceiling",
        reason: "stale", unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(), findings: [], fingerprints: [], completed: false,
      },
    } as Partial<FullSessionState>);
    const { advance } = await reportRound(stale);
    expect(advance.action).not.toBe("goto");
  });

  it("records the fingerprints of the findings it filed", async () => {
    const { ctx } = await reportRound(atRound(CEILING));
    const fps = ctx.state.pendingPlanCeilingEscalation?.fingerprints ?? [];
    expect(fps.length).toBe(2);
    const filed = (ctx.state.filedDeferrals ?? []).filter((d) => fps.includes(d.fingerprint));
    expect(filed.length).toBe(2);
  });

  it("marks the escalation completed only once the park has actually landed", async () => {
    const { ctx } = await reportRound(atRound(CEILING));
    expect(ctx.state.pendingPlanCeilingEscalation?.completed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope-drift telemetry, wired through the stage
// ---------------------------------------------------------------------------

describe("scope-drift telemetry through the stage (advisory only)", () => {
  let root: string;
  let sDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plan-drift-"));
    const storyDir = join(root, ".story");
    for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
      mkdirSync(join(storyDir, sub), { recursive: true });
    }
    writeFileSync(join(storyDir, "config.json"), JSON.stringify({
      version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
      title: "test", date: "2026-08-27",
      phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
    }));
    writeFileSync(join(storyDir, "tickets", `${TICKET}.json`), JSON.stringify({
      id: TICKET, displayId: "T-901", title: "Non-converging plan", description: "A test.",
      type: "task", status: "inprogress", phase: "p1", order: 10,
      createdDate: "2026-08-27", completedDate: null, blockedBy: [],
    }));
    sDir = join(storyDir, "sessions", "s1");
    mkdirSync(sDir, { recursive: true });
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** A plan whose entire vocabulary is these three identifiers. */
  const PLAN_TEXT = "Implement the RetryQueue inside the SyncEngine and update its ConfigLoader.";

  it("captures the round-1 baseline from plan.md on enter()", async () => {
    writeFileSync(join(sDir, "plan.md"), PLAN_TEXT);
    const ctx = new StageContext(root, sDir, makeState(), makeRecipe());
    await stage.enter(ctx);
    expect(ctx.state.planReviewBaseline?.ticketId).toBe(TICKET);
    // ISS-598 codex round 1 (security): tokens are one-way hash digests, not
    // the raw plan-text substrings.
    expect(ctx.state.planReviewBaseline?.tokens).toContain(hashToken("RetryQueue"));
    expect(ctx.state.planReviewBaseline?.tokens).not.toContain("RetryQueue");
    expect(ctx.state.planReviewBaseline?.truncated).toBe(false);
  });

  /**
   * ISS-598 codex round 1 (edge case): a nonempty plan with zero extractable
   * identifier-shaped tokens must not become an empty-but-active baseline --
   * every later signal-bearing finding would then classify as "introduced"
   * with no real basis, manufacturing a maximum-strength drift hint from two
   * ordinary review rounds.
   */
  it("does not store a baseline when the plan has no extractable identifier-shaped vocabulary", async () => {
    writeFileSync(join(sDir, "plan.md"), "This should never make instead without already.");
    const ctx = new StageContext(root, sDir, makeState(), makeRecipe());
    await stage.enter(ctx);
    expect(ctx.state.planReviewBaseline).toBeNull();
  });

  /**
   * ISS-598 codex round 1 (state lifecycle): CODE_REVIEW can redirect a
   * finding back to PLAN, which clears `reviews.plan` and rewrites plan.md.
   * The SAME ticketId then re-enters PLAN_REVIEW's round 1 a second time, and
   * must get a FRESH baseline from the new plan text -- not keep comparing
   * against the first cycle's stale one, which the ticketId-only guard used
   * to do.
   */
  it("recaptures a fresh baseline when the same ticket re-enters PLAN_REVIEW round 1 after a replan", async () => {
    const staleBaseline = activeBaseline(["SomeOldEntityName"], "the OLD plan, before the replan");
    writeFileSync(join(sDir, "plan.md"), "Implement the BrandNewComponent for the RewrittenFeature.");
    const ctx = new StageContext(root, sDir, makeState({ planReviewBaseline: staleBaseline }), makeRecipe());
    await stage.enter(ctx);
    expect(ctx.state.planReviewBaseline?.tokens).toContain(hashToken("BrandNewComponent"));
    expect(ctx.state.planReviewBaseline?.tokens).not.toContain(hashToken("SomeOldEntityName"));
  });

  /**
   * ISS-598 codex round 2 (state lifecycle): `stage.enter()` runs again on a
   * SESSION RESUME (compaction, restart) even mid-round-1, before any
   * `report()` has recorded a review. Gating recapture on `existingReviews`
   * alone would let that resumed entry silently overwrite the baseline a
   * later report() is about to measure findings against. Comparing plan.md's
   * content hash closes it: unchanged content is the SAME generation, and
   * this second `enter()` must be a complete no-op.
   */
  it("does not recapture the baseline on a second enter() against the same unchanged plan.md, e.g. a resumed round 1", async () => {
    const planText = "Implement the RetryQueue for the SyncEngine module.";
    writeFileSync(join(sDir, "plan.md"), planText);
    const seeded = activeBaseline(["RetryQueue", "SyncEngine"], planText);
    const ctx = new StageContext(root, sDir, makeState({ planReviewBaseline: seeded }), makeRecipe());
    await stage.enter(ctx);
    // Reference equality, not deep equality: recomputing from the SAME
    // content would produce a structurally identical but freshly-allocated
    // object, which `toEqual` could not distinguish from "never touched".
    // `toBe` proves no write happened at all.
    expect(ctx.state.planReviewBaseline).toBe(seeded);
  });

  /**
   * ISS-598 codex round 2 (state lifecycle): the OTHER half of the same fix.
   * A same-ticket replan whose new plan.md is empty, unreadable, or has no
   * extractable vocabulary must not leave a stale baseline from the PRIOR
   * generation active -- it would go on comparing round-1 findings of the
   * NEW plan against the OLD plan's vocabulary.
   */
  it("clears a stale baseline when a same-ticket replan's new plan.md is empty", async () => {
    const stale = activeBaseline(["SomeOldEntityName"], "the OLD plan, before the replan");
    writeFileSync(join(sDir, "plan.md"), "");
    const ctx = new StageContext(root, sDir, makeState({ planReviewBaseline: stale }), makeRecipe());
    await stage.enter(ctx);
    expect(ctx.state.planReviewBaseline).toBeNull();
  });

  it("clears a stale baseline when a same-ticket replan's new plan.md has no extractable vocabulary", async () => {
    const stale = activeBaseline(["SomeOldEntityName"], "the OLD plan, before the replan");
    writeFileSync(join(sDir, "plan.md"), "This should never make instead without already.");
    const ctx = new StageContext(root, sDir, makeState({ planReviewBaseline: stale }), makeRecipe());
    await stage.enter(ctx);
    expect(ctx.state.planReviewBaseline).toBeNull();
  });

  it("injects a directive hint once two consecutive rounds cross the drift threshold, without altering the routing", async () => {
    writeFileSync(join(sDir, "plan.md"), PLAN_TEXT);
    const baseline = activeBaseline(["RetryQueue", "SyncEngine", "ConfigLoader"], PLAN_TEXT);
    const introducedFindings = [
      { severity: "major", category: "design", description: "The GuardActionDispatcher citation chain is unbounded", disposition: "open" },
      { severity: "major", category: "design", description: "CitationCacheManager never expires entries", disposition: "open" },
    ];

    const round1 = await reportRound(
      makeState({ planReviewBaseline: baseline }),
      "revise",
      introducedFindings,
    );
    expect(round1.advance.action).toBe("retry");
    expect(round1.ctx.state.planReviewDriftHistory?.rounds.length).toBe(1);
    if (round1.advance.action === "retry") {
      expect(round1.advance.instruction).not.toContain("Scope-drift signal");
    }

    const round2 = await reportRound(round1.ctx.state, "revise", introducedFindings);
    expect(round2.advance.action).toBe("retry"); // never changes routing
    if (round2.advance.action === "retry") {
      expect(round2.advance.instruction).toContain("Scope-drift signal (advisory)");
      expect(round2.advance.instruction).toContain("round 1: 1.00, round 2: 1.00");
      expect(round2.advance.instruction).toContain("park_item");
    }
  });

  /**
   * ISS-598/ISS-1031, Gate-1 ratified ordering, R4: a revise round that LANDS
   * via the clean-findings path (no unresolved critical/major, roundNum >=
   * minRounds -- ticket risk is "low" here, so minRounds=1) must not append
   * drift history or emit a hint. `isRevise && nextAction === "PLAN_REVIEW"`
   * already excludes a landing round from the drift gate; this pins it.
   */
  it("does not compute drift for a revise round that lands via the clean-findings path", async () => {
    writeFileSync(join(sDir, "plan.md"), PLAN_TEXT);
    const baseline = activeBaseline(["RetryQueue", "SyncEngine", "ConfigLoader"], PLAN_TEXT);
    const { advance, ctx } = await reportRound(makeState({ planReviewBaseline: baseline }), "revise", []);
    expect(advance.action).toBe("advance");
    expect(ctx.state.planReviewDriftHistory).toBeNull();
  });

  it("never fires drift when the baseline was truncated", async () => {
    const hugeText = "widgetModule ".repeat(3000);
    writeFileSync(join(sDir, "plan.md"), hugeText);
    const ctx = new StageContext(root, sDir, makeState(), makeRecipe());
    await stage.enter(ctx);
    expect(ctx.state.planReviewBaseline?.truncated).toBe(true);

    const introducedFindings = [
      { severity: "major", category: "design", description: "GuardActionDispatcher chain is unbounded", disposition: "open" },
    ];
    const r1 = await reportRound(ctx.state, "revise", introducedFindings);
    const r2 = await reportRound(r1.ctx.state, "revise", introducedFindings);
    expect(r2.ctx.state.planReviewDriftHistory).toBeNull();
    if (r2.advance.action === "retry") {
      expect(r2.advance.instruction).not.toContain("Scope-drift signal");
    }
  });

  it("clears the baseline and drift history on reject, so a rewritten plan starts a fresh comparison", async () => {
    const baseline = activeBaseline(["RetryQueue"]);
    const history = { ticketId: TICKET, rounds: [{ round: 1, fraction: 0.9 }] };
    const { ctx } = await reportRound(
      makeState({ planReviewBaseline: baseline, planReviewDriftHistory: history }),
      "reject",
      [],
    );
    expect(ctx.state.planReviewBaseline).toBeNull();
    expect(ctx.state.planReviewDriftHistory).toBeNull();
  });

  it("does not clear the baseline on an ordinary revise round", async () => {
    const baseline = activeBaseline(["RetryQueue"]);
    const { ctx } = await reportRound(makeState({ planReviewBaseline: baseline }), "revise", []);
    expect(ctx.state.planReviewBaseline).toEqual(baseline);
  });

  /**
   * The ceiling park records WHERE drift would independently have fired,
   * even though drift itself never triggers the park (Gate-1 ratification
   * condition b).
   */
  it("records driftWouldHaveFiredAtRound on a ceiling park when drift independently triggered earlier", async () => {
    const history = {
      ticketId: TICKET,
      rounds: [
        { round: CEILING - 2, fraction: 0.9 },
        { round: CEILING - 1, fraction: 0.9 },
      ],
    };
    const baseline = activeBaseline(["RetryQueue"]);
    const state = makeState({
      planReviewRoundCounter: { ticketId: TICKET, completedRounds: CEILING - 1 },
      planReviewDriftHistory: history,
      planReviewBaseline: baseline,
    });
    const introducedFindings = [
      { severity: "major", category: "design", description: "GuardActionDispatcher chain unbounded", disposition: "open" },
    ];
    const { ctx } = await reportRound(state, "revise", introducedFindings);
    expect(ctx.state.pendingPlanCeilingEscalation?.driftWouldHaveFiredAtRound).toBe(CEILING - 1);
  });

  async function reportRound(state: FullSessionState, verdict: string, findings: unknown[]) {
    const ctx = new StageContext(root, sDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round", verdict, findings,
    } as never);
    return { advance, ctx };
  }
});
