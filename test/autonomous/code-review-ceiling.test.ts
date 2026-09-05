/**
 * T-470: the CODE_REVIEW hard ceiling.
 *
 * The defect it closes is not "the cap is too high". `forcedLanding` is gated
 * on `!hasUnresolvedCritical`, so `maxReviewRounds` forces landing only when
 * nothing blocking is outstanding; a review that keeps producing unresolved
 * criticals routes CODE_REVIEW -> IMPLEMENT -> CODE_REVIEW with NO upper bound
 * at all. That is the reported sixty-round case, and no value of the existing
 * cap bounds it, because the cap is not on the path that loops.
 *
 * Three things here fail for different reasons:
 *
 *  1. The ceiling fires where it should and NOWHERE ELSE. It must be incapable
 *     of altering an approve, a forced landing, or an unlimited cap.
 *  2. The counter survives the two paths that clear `reviews.code`. A ceiling
 *     derived from that array is reset by a plan redirect and by any recovery
 *     out of CODE_REVIEW, and in a session heading for sixty rounds compaction
 *     is close to certain.
 *  3. The park targets a state the CODE_REVIEW row actually lists. This suite
 *     calls `CodeReviewStage.report` directly, so it pins the DECISION and
 *     checks the intended target against `isValidTransition`; the e2e suite is
 *     the one that drives `processAdvance` and therefore the real
 *     `assertTransition`, where a park routed to an unlisted target (the
 *     CODE_REVIEW row does not list PICK_TICKET) throws AFTER the ticket ledger
 *     has moved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODE_REVIEW_HARD_CEILING_GRACE,
  codeReviewHardCeiling,
  decideCeiling,
  nextRoundCounter,
  roundsForWorkItem,
} from "../../src/autonomous/stages/code-review-ceiling.js";
import { codeReviewLandingFloor } from "../../src/autonomous/session-diagnostics.js";
import { StageContext } from "../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../src/autonomous/recipes/loader.js";

const TICKET = "t-ce111n9000000001";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000000c1",
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    ticket: { id: TICKET, displayId: "T-901", title: "Non-converging", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null,
    codeReviewRoundCounter: null, pendingCeilingEscalation: null,
    ...overrides,
  } as FullSessionState;
}

// The recipe default (`recipes/coding.json`) and the round light effort clamps
// it down to (`LIGHT_CODE_REVIEW_MAX_ROUNDS`). Spelled out rather than imported
// so a change to either one shows up here as a failing number.
const RECIPE_DEFAULT_CAP = 12;
const LIGHT_CAP = 4;

function stagesWithCap(cap: number | undefined): Record<string, Record<string, unknown>> {
  return cap === undefined ? {} : { CODE_REVIEW: { maxReviewRounds: cap } };
}

// ---------------------------------------------------------------------------
// The ceiling number itself
// ---------------------------------------------------------------------------

describe("codeReviewHardCeiling", () => {
  it("sits a fixed grace above the configured cap", () => {
    expect(codeReviewHardCeiling(makeState(), stagesWithCap(6), "low"))
      .toBe(6 + CODE_REVIEW_HARD_CEILING_GRACE);
  });

  /**
   * `cap === 0` means unlimited, deliberately, at every level. Reimposing a
   * bound three rounds later would make "unlimited" mean something else, and a
   * project that turned the cap off did it on purpose.
   */
  it("is disabled entirely when the cap is unlimited", () => {
    expect(codeReviewHardCeiling(makeState(), stagesWithCap(0), "low")).toBe(0);
  });

  /**
   * Derived from the CAP, not the landing floor. The floor carries the
   * light-effort grace round, which is an exception to LANDING; compounding the
   * two graces would push the ceiling a round further out at light effort for
   * no stated reason.
   *
   * The stage map carries the RECIPE default of 12 and `explicitKnobs` is
   * empty, which is the shape the dial actually acts on -- writing an explicit
   * `maxReviewRounds: 4` here would set the knob, opt the state out of both the
   * clamp AND the grace, and leave a test that cannot fail the way it claims
   * to. So light's clamp is what produces the cap of 4, the landing floor is a
   * round further out at 5, and the ceiling has to come off the 4.
   */
  it("does not compound with the light-effort landing grace", () => {
    const light = makeState({
      resolvedReviewEffort: { level: "light", stages: {}, explicitKnobs: {} },
    } as Partial<FullSessionState>);
    const stages = stagesWithCap(RECIPE_DEFAULT_CAP);
    // The grace is really there, so the wrong derivation is really reachable.
    expect(codeReviewLandingFloor(light, stages, "low")).toBe(LIGHT_CAP + 1);
    expect(codeReviewHardCeiling(light, stages, "low"))
      .toBe(LIGHT_CAP + CODE_REVIEW_HARD_CEILING_GRACE);
  });
});

// ---------------------------------------------------------------------------
// The counter, which is the part a naive implementation gets wrong
// ---------------------------------------------------------------------------

const TICKET_REF = { kind: "ticket" as const, id: TICKET };
const ISSUE_REF = { kind: "issue" as const, id: "i-abc" };

describe("the round counter is work-item-keyed and monotonic", () => {
  it("counts up for the same ticket", () => {
    let c = nextRoundCounter(null, TICKET_REF);
    expect(c.completedRounds).toBe(1);
    c = nextRoundCounter(c, TICKET_REF);
    c = nextRoundCounter(c, TICKET_REF);
    expect(c.completedRounds).toBe(3);
  });

  /**
   * THE INVARIANT. A newly selected item must never inherit a poisoned count,
   * and making that a property of the identity rather than of a reset call site
   * is what makes it true across park-and-repick, claim-loss repick, recovery
   * and ordinary next-item selection alike -- none of which need to remember
   * to reset anything.
   */
  it("resets to 1 for a different ticket", () => {
    const poisoned = { workItemId: "t-previous", kind: "ticket" as const, completedRounds: 14 };
    expect(nextRoundCounter(poisoned, TICKET_REF).completedRounds).toBe(1);
  });

  /**
   * A same-id counter belonging to the OTHER kind is not a smaller count, it
   * is no count -- an issue and a ticket can share no id space in practice,
   * but the kind check is what makes that a proven invariant rather than an
   * assumption about id shapes never colliding.
   */
  it("resets to 1 when the id matches but the kind differs", () => {
    const foreignKind = { workItemId: TICKET, kind: "issue" as const, completedRounds: 14 };
    expect(nextRoundCounter(foreignKind, TICKET_REF).completedRounds).toBe(1);
  });

  it("reads as zero for a legacy state with no field, and for a foreign ticket", () => {
    expect(roundsForWorkItem(null, TICKET_REF)).toBe(0);
    expect(roundsForWorkItem(undefined, TICKET_REF)).toBe(0);
    expect(roundsForWorkItem({ workItemId: "t-other", kind: "ticket", completedRounds: 9 }, TICKET_REF)).toBe(0);
    expect(roundsForWorkItem({ workItemId: TICKET, kind: "ticket", completedRounds: 9 }, null)).toBe(0);
  });

  it("reads as zero for a counter whose kind differs even when the id matches", () => {
    expect(roundsForWorkItem({ workItemId: TICKET, kind: "issue", completedRounds: 9 }, TICKET_REF)).toBe(0);
  });

  it("counts up for the same issue, independently of ticket-keyed counters", () => {
    let c = nextRoundCounter(null, ISSUE_REF);
    expect(c.completedRounds).toBe(1);
    c = nextRoundCounter(c, ISSUE_REF);
    expect(c.completedRounds).toBe(2);
    expect(roundsForWorkItem(c, ISSUE_REF)).toBe(2);
    expect(roundsForWorkItem(c, TICKET_REF)).toBe(0);
  });

  /**
   * THE TWO RESET VECTORS, stated as the reason the counter is not derived.
   *
   * `reviews.code` is cleared by the plan-redirect branch and by
   * `RECOVERY_MAPPING.CODE_REVIEW`. The counter is independent of both, so a
   * session that redirected to PLAN or came back from a compaction still knows
   * how many rounds this ticket has burned.
   */
  it("is unaffected by reviews.code being cleared", () => {
    const counter = { workItemId: TICKET, kind: "ticket" as const, completedRounds: 8 };
    const afterRedirect = makeState({ reviews: { plan: [], code: [] }, codeReviewRoundCounter: counter });
    expect(roundsForWorkItem(afterRedirect.codeReviewRoundCounter, TICKET_REF)).toBe(8);
    expect(afterRedirect.reviews.code.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// When it fires
// ---------------------------------------------------------------------------

describe("decideCeiling", () => {
  const stages = stagesWithCap(6);
  const ceiling = 6 + CODE_REVIEW_HARD_CEILING_GRACE; // 9

  function decide(completedRounds: number, over: Partial<Parameters<typeof decideCeiling>[0]> = {}) {
    return decideCeiling({
      state: makeState({ codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds } }),
      stages,
      risk: "low",
      nextAction: "IMPLEMENT",
      ...over,
    });
  }

  /**
   * The boundary is the whole point of counting the round IN HAND rather than
   * the stored count: comparing the stored number fires one round late, because
   * the current round is not persisted until after the routing decision.
   */
  it("does not fire one round early", () => {
    expect(decide(ceiling - 2).shouldPark).toBe(false);
  });

  it("fires exactly at the ceiling", () => {
    const d = decide(ceiling - 1);
    expect(d.counter?.completedRounds).toBe(ceiling);
    expect(d.shouldPark).toBe(true);
  });

  it("still fires past the ceiling", () => {
    expect(decide(ceiling).shouldPark).toBe(true);
  });

  /**
   * The guard that makes the ceiling provably incapable of changing an outcome
   * that was already going to finish. It can only ever convert a would-be
   * CONTINUATION into a park.
   */
  it("never converts a landing into a park", () => {
    expect(decide(ceiling + 5, { nextAction: "FINALIZE" }).shouldPark).toBe(false);
  });

  it("never fires when the cap is unlimited", () => {
    expect(decideCeiling({
      state: makeState({ codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: 99 } }),
      stages: stagesWithCap(0), risk: "low", nextAction: "IMPLEMENT",
    }).shouldPark).toBe(false);
  });

  /**
   * ISS-1032: issue-fix sessions now trip the same ceiling as ticket sessions.
   * A work item's presence -- ticket OR issue -- is what gates the ceiling; the
   * park path now has a real issue-shaped target (`parkCurrentIssue`), so the
   * old exemption (the park path had nowhere to route an issue) no longer
   * applies.
   */
  it("fires on the issue-fix path exactly as it does for a ticket", () => {
    const d = decideCeiling({
      state: makeState({
        ticket: undefined,
        currentIssue: { id: ISSUE_REF.id, displayId: "ISS-1", title: "x", severity: "high" },
        codeReviewRoundCounter: { workItemId: ISSUE_REF.id, kind: "issue", completedRounds: ceiling - 1 },
      } as Partial<FullSessionState>),
      stages, risk: "low", nextAction: "IMPLEMENT",
    });
    expect(d.counter).toEqual({ workItemId: ISSUE_REF.id, kind: "issue", completedRounds: ceiling });
    expect(d.shouldPark).toBe(true);
  });

  it("does not fire with no ticket and no issue to park", () => {
    expect(decideCeiling({
      state: makeState({ ticket: undefined, currentIssue: null, codeReviewRoundCounter: null }),
      stages, risk: "low", nextAction: "IMPLEMENT",
    }).shouldPark).toBe(false);
  });

  /**
   * A ticket switch resets the count, so an item that inherits a previous
   * item's rounds cannot be parked on its first review.
   */
  it("does not fire for a fresh ticket carrying a previous ticket's count", () => {
    const d = decideCeiling({
      state: makeState({ codeReviewRoundCounter: { workItemId: "t-previous", kind: "ticket", completedRounds: 99 } }),
      stages, risk: "low", nextAction: "IMPLEMENT",
    });
    expect(d.counter?.completedRounds).toBe(1);
    expect(d.shouldPark).toBe(false);
  });

  /**
   * A ticket-keyed counter does not carry over when the session now holds an
   * ISSUE with the same round count -- the kind switch is itself a reset,
   * exactly like an id switch.
   */
  it("does not fire for a freshly picked issue carrying a previous ticket's count", () => {
    const d = decideCeiling({
      state: makeState({
        ticket: undefined,
        currentIssue: { id: ISSUE_REF.id, displayId: "ISS-1", title: "x", severity: "high" },
        codeReviewRoundCounter: { workItemId: ISSUE_REF.id, kind: "ticket", completedRounds: 99 },
      } as Partial<FullSessionState>),
      stages, risk: "low", nextAction: "IMPLEMENT",
    });
    expect(d.counter?.completedRounds).toBe(1);
    expect(d.shouldPark).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What actually happens when it fires
// ---------------------------------------------------------------------------

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-21",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", `${TICKET}.json`), JSON.stringify({
    id: TICKET, displayId: "T-901", title: "Non-converging", description: "A test.",
    type: "task", status: "inprogress", phase: "p1", order: 10,
    createdDate: "2026-08-21", completedDate: null, blockedBy: [],
  }));
}

function makeRecipe(cap: number): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: stagesWithCap(cap), dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
  } as unknown as ResolvedRecipe;
}

const BLOCKING = [
  { severity: "critical", category: "correctness", description: "Off-by-one in the retry bound", disposition: "open" },
  { severity: "major", category: "security", description: "Token logged at debug level", disposition: "open" },
  { severity: "suggestion", category: "style", description: "Rename this variable", disposition: "open" },
];

describe("the ceiling, end to end through the stage", () => {
  let root: string;
  let sDir: string;
  const CAP = 4;
  const CEILING = CAP + CODE_REVIEW_HARD_CEILING_GRACE; // 7

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ceiling-"));
    setupProject(root);
    sDir = join(root, ".story", "sessions", "s1");
    mkdirSync(sDir, { recursive: true });
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  async function reportRound(
    state: FullSessionState,
    verdict = "request_changes",
    findings: unknown[] = BLOCKING,
  ) {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, state, makeRecipe(CAP));
    const advance = await new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round",
      verdict,
      findings,
    } as never);
    return { advance, ctx };
  }

  function atRound(n: number, over: Partial<FullSessionState> = {}): FullSessionState {
    return makeState({
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: n - 1 },
      ...over,
    });
  }

  function issuesOnDisk(): Record<string, unknown>[] {
    return readdirSync(join(root, ".story", "issues"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(root, ".story", "issues", f), "utf-8")));
  }

  it("keeps reviewing below the ceiling", async () => {
    const { advance } = await reportRound(atRound(CEILING - 1));
    expect(advance.action).not.toBe("goto");
    expect(issuesOnDisk().length).toBe(0);
  });

  /**
   * HANDOVER, not PICK_TICKET, and for two independent reasons either of which
   * is sufficient. The working tree holds the parked item's uncommitted work
   * (IMPLEMENT ran, FINALIZE did not) and `dirtyFileHandling` is checked only
   * at session START -- so the next item would build on top of it. And the
   * transition table forbids the other route anyway.
   */
  it("parks to HANDOVER at the ceiling", async () => {
    const { advance } = await reportRound(atRound(CEILING));
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("HANDOVER");
  });

  /**
   * ISS-1032: an issue-fix session drives the SAME ceiling, through the SAME
   * CodeReviewStage.report() call, and parks via `parkCurrentIssue` (not
   * `parkCurrentTicket`) -- proving the dispatch in `escalateCeiling` and the
   * `{kind:"issue", workItemId}` escalation shape built in `report()`, not
   * just `decideCeiling`'s unit-level generalization.
   */
  it("an issue-fix session trips the same ceiling and parks the ISSUE, not a ticket", async () => {
    const ISSUE_ID = "i-ce111n9000000001";
    writeFileSync(join(root, ".story", "issues", `${ISSUE_ID}.json`), JSON.stringify({
      id: ISSUE_ID, title: "Non-converging fix", status: "resolved", severity: "high",
      components: [], impact: "test", resolution: "fixed in this session", location: [],
      discoveredDate: "2026-08-21", resolvedDate: "2026-08-21", relatedTickets: [],
      order: 10, phase: "p1",
    }));
    const issueState = atRound(CEILING, {
      ticket: undefined,
      currentIssue: { id: ISSUE_ID, displayId: "ISS-901", title: "Non-converging fix", severity: "high" },
      codeReviewRoundCounter: { workItemId: ISSUE_ID, kind: "issue", completedRounds: CEILING - 1 },
    } as Partial<FullSessionState>);
    const { advance, ctx } = await reportRound(issueState);

    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("HANDOVER");
    expect(ctx.state.currentIssue).toBeNull();

    const issueOnDisk = JSON.parse(readFileSync(join(root, ".story", "issues", `${ISSUE_ID}.json`), "utf-8"));
    expect(issueOnDisk.status).toBe("open");

    expect(ctx.state.pendingCeilingEscalation).toMatchObject({
      workItemId: ISSUE_ID, kind: "issue", completed: true,
    });
  });

  /**
   * The ceiling is the PIPELINE's decision, never an agent's. `park_item` is
   * refused outside `PARK_STAGES`, so widening `ParkOrigin` to carry
   * CODE_REVIEW did not hand agents a new way to abandon an implemented item --
   * which would leave a dirty tree behind on request.
   */
  it("is not something an agent can ask for", async () => {
    const { PARK_STAGES } = await import("../../src/autonomous/stages/park.js");
    expect(PARK_STAGES.has("CODE_REVIEW")).toBe(false);
    expect(PARK_STAGES.has("PLAN_REVIEW")).toBe(true);
  });

  it("routes somewhere the state machine actually permits", async () => {
    const { isValidTransition } = await import("../../src/autonomous/state-machine.js");
    expect(isValidTransition("CODE_REVIEW", "HANDOVER")).toBe(true);
    // The reason the ceiling cannot advance the queue instead: a park routed
    // here would throw AFTER mutating the ticket ledger.
    expect(isValidTransition("CODE_REVIEW", "PICK_TICKET")).toBe(false);
  });

  /**
   * Review artifacts live under `.story/sessions/`, which is gitignored, so a
   * park record pointing at one does not survive session cleanup, a moved
   * checkout, or another machine. The findings have to reach the LEDGER.
   */
  it("files the outstanding findings as issues, at mapped severities", async () => {
    await reportRound(atRound(CEILING));
    const issues = issuesOnDisk();
    expect(issues.length).toBe(2); // critical + major; the suggestion is exempt
    const severities = issues.map((i) => i.severity).sort();
    expect(severities).toEqual(["critical", "high"]);
  });

  /**
   * Filing a critical AS critical is not laundering the blocker. Rewriting its
   * disposition to push it through the deferral path would be, which is why
   * this uses the shared QUEUE and not `fileDeferredFindings`.
   */
  it("does not downgrade a critical into a deferral", async () => {
    await reportRound(atRound(CEILING));
    const critical = issuesOnDisk().find((i) => i.severity === "critical");
    expect(critical).toBeDefined();
    expect(String(critical?.title)).toContain("correctness");
  });

  it("excludes suggestions, matching the exemption the deferral path applies", async () => {
    await reportRound(atRound(CEILING));
    expect(issuesOnDisk().some((i) => String(i.title).includes("style"))).toBe(false);
  });

  /**
   * A terminal report must never show a forced-landing decision AND a ceiling
   * escalation: they say opposite things about why the item stopped.
   */
  it("clears any prior landing decision", async () => {
    const stale = {
      stage: "CODE_REVIEW", round: 3, maxReviewRounds: CAP,
      reason: "max_review_rounds_no_blocking",
      findingCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      timestamp: new Date().toISOString(),
    };
    const { ctx } = await reportRound(atRound(CEILING, { landingDecision: stale } as Partial<FullSessionState>));
    expect(ctx.state.landingDecision).toBeNull();
  });

  it("persists the round it stopped at", async () => {
    const { ctx } = await reportRound(atRound(CEILING));
    expect(ctx.state.codeReviewRoundCounter?.completedRounds).toBe(CEILING);
    expect(ctx.state.codeReviewRoundCounter?.workItemId).toBe(TICKET);
  });

  /**
   * IDEMPOTENCY. Persisting the round and filing the issues is not atomic, so
   * a resubmitted report must RESUME rather than be processed as another
   * round -- which would increment the counter again and retry the handover
   * from a different number.
   */
  it("a resubmitted report resumes rather than counting another round", async () => {
    const first = await reportRound(atRound(CEILING));
    expect(first.advance.action).toBe("goto");
    const afterFirst = first.ctx.state.codeReviewRoundCounter?.completedRounds;

    // The escalation is MARKED COMPLETED on success, so a genuine resubmit at
    // this point is a NEW round -- which is why the interesting case is the one
    // below, where the record is still unfinished.
    const stuck = makeState({
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: CEILING },
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", round: CEILING, ceiling: CEILING, maxReviewRounds: CAP,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 1, decidedAt: new Date().toISOString(),
      },
    } as Partial<FullSessionState>);
    const second = await reportRound(stuck);

    expect(second.advance.action).toBe("goto");
    expect((second.advance as { target: string }).target).toBe("HANDOVER");
    expect(second.ctx.state.codeReviewRoundCounter?.completedRounds).toBe(afterFirst);
  });

  /**
   * AN AMBIGUOUS ENCODING IS NOT FIXED BY A STRONGER HASH.
   *
   * The fingerprint input was the fields joined with colons, and a colon can
   * appear inside a field. These two findings are genuinely different and
   * produced the identical joined string:
   *
   *   category "security:auth" + description "Token leak"
   *   category "security"      + description "auth:Token leak"
   *
   * so the second was skipped as already queued, and the ceiling could park
   * having filed one issue for two blockers -- while its own report said both
   * reached the ledger. SHA-256 does not help: the inputs really are equal.
   */
  it("keeps two findings distinct when a delimiter appears inside a field", async () => {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, atRound(CEILING), makeRecipe(CAP));
    await new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round",
      verdict: "request_changes",
      findings: [
        { severity: "major", category: "security:auth", description: "Token leak", disposition: "open" },
        { severity: "major", category: "security", description: "auth:Token leak", disposition: "open" },
      ],
    } as never);

    expect(issuesOnDisk().length).toBe(2);
    expect(ctx.state.pendingCeilingEscalation?.fingerprints.length).toBe(2);
  });

  /**
   * "Outstanding" has to mean outstanding. The record's major count was the RAW
   * `majorCount`, which includes majors already addressed and majors explicitly
   * deferred -- so a report headed "still outstanding" named findings that were
   * fixed or consciously set aside, which is the opposite of what a reader
   * arriving at a stopped session needs from that number.
   */
  it("counts only genuinely unresolved majors, matching the rule used for criticals", async () => {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, atRound(CEILING), makeRecipe(CAP));
    await new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round",
      verdict: "request_changes",
      findings: [
        { severity: "critical", category: "correctness", description: "Still broken", disposition: "open" },
        { severity: "major", category: "perf", description: "Already fixed", disposition: "addressed" },
        { severity: "major", category: "style", description: "Consciously set aside", disposition: "deferred" },
        { severity: "major", category: "security", description: "Genuinely outstanding", disposition: "open" },
      ],
    } as never);

    const record = ctx.state.pendingCeilingEscalation!;
    expect(record.unresolvedCritical).toBe(1);
    expect(record.unresolvedMajor).toBe(1);
  });

  /**
   * WHAT GETS FILED is a narrower question than what stopped the session.
   *
   * `contested` means false positive -- `lesson-capture` reads it that way --
   * and `deferred` means valid but out of scope, which `fileDeferredFindings`
   * already files. A deny-list that excluded only `addressed` minted a
   * critical-severity ledger issue for a finding the session had explicitly
   * called not real, and a duplicate claim on one it had consciously set aside.
   *
   * The COUNTS deliberately do not follow: they mirror the engine's routing
   * rule, which treats a contested critical as unresolved, and it is that rule
   * which kept the session from landing. So this asserts the divergence rather
   * than assuming the two move together.
   */
  it("files open findings only, not contested false positives or deferred ones", async () => {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, atRound(CEILING), makeRecipe(CAP));
    await new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round",
      verdict: "request_changes",
      findings: [
        { severity: "critical", category: "correctness", description: "Genuinely still broken", disposition: "open" },
        { severity: "critical", category: "security", description: "Reviewer was wrong about this", disposition: "contested" },
        { severity: "major", category: "perf", description: "Also a false positive", disposition: "contested" },
        { severity: "major", category: "style", description: "Valid, out of scope", disposition: "deferred" },
        { severity: "major", category: "api", description: "Already fixed", disposition: "addressed" },
      ],
    } as never);

    const record = ctx.state.pendingCeilingEscalation!;
    // The escalation owns the one open finding, and only it.
    expect(record.findings.map((f) => f.description)).toEqual(["Genuinely still broken"]);
    expect(record.fingerprints.length).toBe(1);

    // Two issues on disk, from two DIFFERENT paths, which is the point. The
    // ceiling filed the open critical; `fileDeferredFindings` filed the
    // deferred major at its mapped `high`. Filing the deferred one here as
    // well would have been a second claim on it, by a path that calls it a
    // blocker.
    const all = issuesOnDisk();
    expect(all.length).toBe(2);
    const mine = (ctx.state.filedDeferrals ?? [])
      .filter((d) => record.fingerprints.includes(d.fingerprint))
      .map((d) => d.issueId);
    expect(mine.length).toBe(1);
    expect(all.find((i) => i.id === mine[0])?.severity).toBe("critical");
    expect(all.find((i) => i.id !== mine[0])?.severity).toBe("high");

    // Neither false positive reached the ledger under any severity.
    const text = JSON.stringify(all);
    expect(text).not.toContain("Reviewer was wrong about this");
    expect(text).not.toContain("Also a false positive");

    // And the counts follow the ROUTING rule, which is why they differ from the
    // filed set: the contested critical is what kept this session from landing.
    expect(record.unresolvedCritical).toBe(2);
    expect(record.unresolvedMajor).toBe(1);
  });

  /**
   * A resume must RE-FILE its recorded findings and land on the same issues.
   *
   * Seeded from the first round's REAL record -- its findings, its real
   * fingerprints, its real `filedDeferrals` -- because an escalation seeded
   * empty has nothing to re-file, and an unchanged issue count would then prove
   * only that nothing happened.
   */
  it("does not file the same finding twice across a resume", async () => {
    const { ctx: firstCtx } = await reportRound(atRound(CEILING));
    const afterFirst = issuesOnDisk().length;
    expect(afterFirst).toBe(2);

    const record = firstCtx.state.pendingCeilingEscalation!;
    expect(record.findings.length).toBe(2);
    expect(record.fingerprints.length).toBe(2);

    const originalIds = issuesOnDisk().map((i) => i.id).sort();

    // The POST-CREATE state write was lost: the issues exist in the ledger, the
    // record and its queue survive, but `filedDeferrals` never recorded them.
    // Keeping `filedDeferrals` instead would make the resume skip every
    // fingerprint at the state level and never consult `dedupeKey` at all --
    // which is what this test is for.
    const stuck = makeState({
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: CEILING },
      pendingCeilingEscalation: { ...record, completed: false },
      filedDeferrals: [],
      pendingDeferrals: record.fingerprints.map((fp, idx) => ({
        fingerprint: fp,
        severity: record.findings[idx]!.severity,
        category: record.findings[idx]!.category,
        description: record.findings[idx]!.description,
        reviewKind: "code" as const,
      })),
    } as Partial<FullSessionState>);
    const { advance } = await reportRound(stuck);

    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("HANDOVER");
    // Same COUNT and the same ISSUE IDS: the re-filing resolved back onto the
    // existing ledger issues rather than minting parallel ones.
    expect(issuesOnDisk().length).toBe(afterFirst);
    expect(issuesOnDisk().map((i) => i.id).sort()).toEqual(originalIds);
  });

  /**
   * A stale record from a PREVIOUS ticket must not park the current one. It is
   * dropped and the normal round path runs.
   */
  it("ignores an escalation recorded against a different ticket", async () => {
    const stale = makeState({
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: 0 },
      pendingCeilingEscalation: {
        workItemId: "t-someone-else", kind: "ticket", round: 9, ceiling: 9, maxReviewRounds: CAP,
        reason: "stale", unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(),
      },
    } as Partial<FullSessionState>);
    const { advance } = await reportRound(stale);
    expect(advance.action).not.toBe("goto");
  });

  /**
   * THE PLAN-REDIRECT VECTOR, driven rather than asserted about.
   *
   * A finding recommending PLAN takes the early-return branch at `:498`, which
   * has its own `writeState` and CLEARS `reviews.code` before leaving. A
   * ceiling read off `codeReviews.length` would therefore be reset to zero by
   * the very verdict most likely to be looping, and would never fire. Here the
   * redirect is refused: it parks instead.
   */
  it("parks at the ceiling even when the verdict redirects to PLAN", async () => {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, atRound(CEILING), makeRecipe(CAP));
    const advance = await new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round",
      verdict: "request_changes",
      findings: [{ ...BLOCKING[0], recommendedNextState: "PLAN" }, BLOCKING[1], BLOCKING[2]],
    } as never);

    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("HANDOVER");
    expect(issuesOnDisk().length).toBeGreaterThan(0);
    // The redirect branch is an early return with its own `writeState`, so
    // reaching the shared persistence block is the thing being pinned: the
    // escalation record only exists if the ceiling fell through to it.
    expect(ctx.state.codeReviewRoundCounter?.completedRounds).toBe(CEILING);
    // The DURABLE count, not `reviews.code.length + 1` -- which this very
    // branch clears, and which recovery clears too. A ceiling reached on the
    // fifteenth round reported as "round 1 of 7" reads as a bug in the ceiling
    // rather than as what stopped the session.
    expect(ctx.state.pendingCeilingEscalation?.round).toBe(CEILING);
  });

  /**
   * THE RECOVERY VECTOR. `RECOVERY_MAPPING.CODE_REVIEW` sets `resetCode: true`,
   * so any compaction out of this stage zeroes `reviews.code` -- and in a
   * session heading for sixty rounds, a compaction is close to certain. The
   * counter is a separate field the recovery write does not touch, so the
   * rounds already burned survive it.
   */
  it("parks at the ceiling after a recovery wiped the review history", async () => {
    const { RECOVERY_MAPPING } = await import("../../src/autonomous/guide.js");
    expect(RECOVERY_MAPPING.CODE_REVIEW?.resetCode).toBe(true);

    const recovered = atRound(CEILING, { reviews: { plan: [], code: [] } } as Partial<FullSessionState>);
    const { advance, ctx } = await reportRound(recovered);

    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("HANDOVER");
    // `roundNum` is display-only and derived from the wiped array, so it reads
    // as 1 here. The ceiling did not use it -- which is the point.
    expect(ctx.state.codeReviewRoundCounter?.completedRounds).toBe(CEILING);
  });

  /**
   * THE REDIRECT LOOP. A finding recommending PLAN takes the early return,
   * which has its own `writeState` and clears `reviews.code`. If that branch
   * did not advance the counter, a reviewer that keeps recommending PLAN would
   * loop forever at a count that never moved -- the same unbounded shape the
   * ceiling exists to close, reached by a different route.
   */
  it("advances the counter on a plan redirect that does not park", async () => {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, atRound(2), makeRecipe(CAP));
    const advance = await new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round",
      verdict: "request_changes",
      findings: [{ ...BLOCKING[0], recommendedNextState: "PLAN" }],
    } as never);

    expect(advance.action).toBe("back");
    expect((advance as { target: string }).target).toBe("PLAN");
    expect(ctx.state.reviews.code.length).toBe(0);
    expect(ctx.state.codeReviewRoundCounter?.completedRounds).toBe(2);
  });

  /**
   * The findings live on the RECORD as well as in the queue.
   *
   * They are QUEUED first, then copied into the decision, so a stop between the
   * two writes leaves the durable queue and no decision to resume -- and the
   * ordinary drain still files them. The copy is what makes the other side
   * self-contained: once a decision exists it carries its own findings, so a
   * resumed call that arrives with an empty payload can still file them rather
   * than parking the item having filed none of its blockers.
   */
  it("files from the record on a resume that carries no findings", async () => {
    const stuck = makeState({
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: CEILING },
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", round: CEILING, ceiling: CEILING, maxReviewRounds: CAP,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 1, decidedAt: new Date().toISOString(),
        findings: [
          { severity: "critical", category: "correctness", description: "Off-by-one in the retry bound" },
        ],
        fingerprints: [],
      },
    } as Partial<FullSessionState>);

    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, stuck, makeRecipe(CAP));
    // No findings at all in the payload: this is the resume case.
    const advance = await new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round", verdict: "request_changes", findings: [],
    } as never);

    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("HANDOVER");
    expect(issuesOnDisk().length).toBe(1);
    expect(issuesOnDisk()[0]?.severity).toBe("critical");
  });

  /**
   * THE CRASH WINDOW. `filedDeferrals` is session state written AFTER the issue
   * is created, so a stop between the two used to leave an issue in the ledger
   * that nothing recorded -- and the retry filed a second copy. The fingerprint
   * now travels as a durable dedupe key, so the retry gets the SAME issue back
   * instead of another one.
   */
  it("does not create a second issue when the post-create state write was lost", async () => {
    const { ctx: firstCtx } = await reportRound(atRound(CEILING));
    const first = issuesOnDisk();
    expect(first.length).toBe(2);
    // The REAL fingerprint of the critical, as the first round computed it.
    // Inventing one would only prove that a different key files a new issue.
    const fp = firstCtx.state.pendingCeilingEscalation?.fingerprints?.[0];
    expect(fp).toBeTruthy();

    // A MINIMAL synthetic fixture for the dedupe key alone: the issues exist on
    // disk, this session has no record of having filed them, and the queue is
    // still full. It is not the production crash state -- a real failure after
    // issue creation leaves the escalation's own findings and fingerprints
    // written -- and it is not trying to be. The faithful crash, fault-injected
    // at the state write itself, lives in `code-review-ceiling-e2e.test.ts`;
    // this one isolates the key from everything around it.
    const lostWrite = makeState({
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: CEILING },
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", round: CEILING, ceiling: CEILING, maxReviewRounds: CAP,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 1, decidedAt: new Date().toISOString(),
        findings: [], fingerprints: [],
      },
      filedDeferrals: [],
      pendingDeferrals: [
        { fingerprint: fp!, severity: "critical", category: "correctness", description: "Off-by-one in the retry bound", reviewKind: "code" },
      ],
    } as Partial<FullSessionState>);
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    await new CodeReviewStage().report(
      new StageContext(root, sDir, lostWrite, makeRecipe(CAP)),
      { completedAction: "code_review_round", verdict: "request_changes", findings: [] } as never,
    );

    expect(issuesOnDisk().length).toBe(first.length);
  });

  /**
   * THE SESSION SCOPE, which nothing else pins.
   *
   * The dedupe key exists to survive a crash between creating an issue and
   * recording that it was created -- always a retry within ONE session. Making
   * it global looked equivalent and is not: the dedupe lookup scans
   * `activeIssues`, which filters on `lifecycle` and NOT on status, so a
   * RESOLVED issue is still in that list. A finding that recurs months later,
   * after its original issue was fixed and closed, would resolve onto that
   * closed issue -- the queue marking it filed while no open issue for a live
   * blocker exists anywhere.
   *
   * Same finding, same ticket, different session: a NEW issue.
   */
  it("files a recurring finding again in a later session rather than reusing a closed issue", async () => {
    const { ctx: firstCtx } = await reportRound(atRound(CEILING));
    const firstIds = issuesOnDisk().map((i) => i.id).sort();
    expect(firstIds.length).toBe(2);

    // The original issues are resolved, exactly as a person would leave them.
    for (const file of readdirSync(join(root, ".story", "issues")).filter((f) => f.endsWith(".json"))) {
      const path = join(root, ".story", "issues", file);
      const issue = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...issue, status: "resolved" }));
    }

    // A LATER session hits the identical findings on the identical ticket.
    const laterSessionDir = join(root, ".story", "sessions", "s2");
    mkdirSync(laterSessionDir, { recursive: true });
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const later = makeState({
      sessionId: "s2",
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: CEILING - 1 },
    } as Partial<FullSessionState>);
    const laterCtx = new StageContext(root, laterSessionDir, later, makeRecipe(CAP));
    await new CodeReviewStage().report(laterCtx, {
      completedAction: "code_review_round", verdict: "request_changes", findings: BLOCKING,
    } as never);

    const allIds = issuesOnDisk().map((i) => i.id).sort();
    expect(allIds.length).toBe(4);
    // None of the new ids is one of the closed ones.
    expect(allIds.filter((id) => firstIds.includes(id)).sort()).toEqual(firstIds);
    // And the fingerprints really were identical -- otherwise this test would
    // pass for the trivial reason that it filed something different.
    expect(laterCtx.state.pendingCeilingEscalation?.fingerprints.sort())
      .toEqual(firstCtx.state.pendingCeilingEscalation?.fingerprints.sort());
  });

  /**
   * An escalation is TICKET-only, so an absent ticket is a non-match, not a
   * pass. Guarding on "both ids exist AND differ" let the record through
   * whenever the session held an issue or held nothing: filing completed, then
   * the park returned `retry` with no ticket to park, and every later report
   * resumed the same escalation. The current item could never progress.
   */
  it("does not resume an escalation while the session holds no ticket", async () => {
    const stranded = makeState({
      ticket: undefined,
      currentIssue: { id: "i-abc", displayId: "ISS-1", title: "x", severity: "high" },
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", round: 9, ceiling: 9, maxReviewRounds: CAP,
        reason: "earlier item", unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(),
        // Carries real findings on purpose: an empty record cannot tell a guard
        // that declines from one that resumes and finds nothing to do.
        findings: [{ severity: "critical", category: "correctness", description: "The earlier item's blocker" }],
        fingerprints: [],
      },
    } as Partial<FullSessionState>);
    const { advance, ctx } = await reportRound(stranded);
    // The escalation belongs to an item this session is no longer holding, and
    // parking "it" would be parking nothing. Ordinary issue-fix routing runs
    // instead, and the stale record is untouched rather than resumed.
    expect((advance as { target?: string }).target).not.toBe("HANDOVER");
    expect(ctx.state.pendingCeilingEscalation?.completed).toBeFalsy();
    expect(issuesOnDisk().length).toBe(0);
  });

  /**
   * Same ID, different KIND. The test above changes both id and kind at
   * once, so it would still pass if the resume guard accidentally stopped
   * checking `kind` and matched on id alone -- an issue and a ticket sharing
   * one id string is not a real-world case (separate id namespaces), but the
   * guard's own identity invariant (same as the round counter's) is that
   * kind is part of the identity, not an id-shape assumption.
   */
  it("does not resume an escalation whose id matches but whose kind does not", async () => {
    const mismatchedKind = makeState({
      ticket: undefined,
      currentIssue: { id: TICKET, displayId: "ISS-1", title: "x", severity: "high" },
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", round: 9, ceiling: 9, maxReviewRounds: CAP,
        reason: "earlier item", unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(),
        findings: [{ severity: "critical", category: "correctness", description: "The earlier item's blocker" }],
        fingerprints: [],
      },
    } as Partial<FullSessionState>);
    const { advance, ctx } = await reportRound(mismatchedKind);
    expect((advance as { target?: string }).target).not.toBe("HANDOVER");
    expect(ctx.state.pendingCeilingEscalation?.completed).toBeFalsy();
    expect(issuesOnDisk().length).toBe(0);
  });

  /**
   * A stale record from a previous item is KEPT, not deleted: it is the only
   * explanation of why that earlier item stopped, and the current item's
   * ceiling check ignores it on ticket identity anyway. This asserts the
   * retention only -- the findings it names were queued into `pendingDeferrals`
   * when it was written, and the guide-level drain that files them is covered
   * in the e2e suite, not here.
   */
  it("keeps a foreign-ticket escalation rather than discarding the evidence", async () => {
    const stale = makeState({
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: 0 },
      pendingCeilingEscalation: {
        workItemId: "t-someone-else", kind: "ticket", round: 9, ceiling: 9, maxReviewRounds: CAP,
        reason: "stale", unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(), findings: [], fingerprints: [],
      },
    } as Partial<FullSessionState>);
    const { ctx } = await reportRound(stale);
    expect(ctx.state.pendingCeilingEscalation?.workItemId).toBe("t-someone-else");
  });

  /**
   * THE ORDER OF THE TWO WRITES. Queue-then-decision, not the reverse.
   *
   * Neither order is atomic, so the question is which one fails safe.
   * Decision-then-queue could leave a record whose findings were never queued;
   * if the ticket then changed, the resume guard declines that record, and a
   * later ceiling overwrites the singleton -- taking the only copy of those
   * findings with it. This way the findings are durable first, and a lost
   * decision just means the next report is an ordinary round.
   */
  it("queues the findings durably before the decision is recorded", async () => {
    const { CodeReviewStage } = await import("../../src/autonomous/stages/code-review.js");
    const ctx = new StageContext(root, sDir, atRound(CEILING), makeRecipe(CAP));

    // The ORDER of the writes is the property, not the end state. Both
    // orderings leave the same state behind when neither write fails, so a
    // test that inspected only the result would stay green if the unsafe
    // ordering came back -- and the unsafe ordering is invisible until the
    // exact crash it loses findings in.
    const writes: { keys: string[]; queued: string[] }[] = [];
    const realWrite = ctx.writeState.bind(ctx);
    vi.spyOn(ctx, "writeState").mockImplementation((updates, opts) => {
      const pending = (updates as { pendingDeferrals?: { description: string }[] }).pendingDeferrals;
      writes.push({
        keys: Object.keys(updates),
        queued: (pending ?? []).map((d) => d.description),
      });
      return realWrite(updates, opts);
    });

    // MIXED on purpose. The escalation owns only the open findings, so a
    // `deferred` one is durable ONLY if it too is queued before the decision --
    // the ordinary call that would otherwise queue it sits after that write,
    // and a resume enters `escalateCeiling` and parks without processing the
    // report at all. An all-open report cannot see that window.
    await new CodeReviewStage().report(ctx, {
      completedAction: "code_review_round",
      verdict: "request_changes",
      findings: [
        ...BLOCKING,
        { severity: "major", category: "api", description: "Valid, out of scope", disposition: "deferred" },
      ],
    } as never);

    const decided = writes.findIndex((w) => w.keys.includes("pendingCeilingEscalation"));
    const queued = writes.findIndex((w) => w.keys.includes("pendingDeferrals"));
    expect(queued).toBeGreaterThanOrEqual(0);
    expect(decided).toBeGreaterThanOrEqual(0);
    expect(queued).toBeLessThan(decided);

    // BOTH sets durable BEFORE the decision write, read off the writes that
    // actually happened first -- the escalation's own blockers and this round's
    // deferred finding.
    const before = new Set(writes.slice(0, decided).flatMap((w) => w.queued));
    expect(before).toContain("Valid, out of scope");
    expect(before).toContain("Off-by-one in the retry bound");

    const descriptions = new Set([
      ...(ctx.state.filedDeferrals ?? []).map((d) => d.fingerprint),
      ...(ctx.state.pendingDeferrals ?? []).map((d) => d.fingerprint),
    ]);

    // The record names exactly what the queue carries, and names ONLY its own.
    const fps = ctx.state.pendingCeilingEscalation?.fingerprints ?? [];
    expect(fps.length).toBe(2);
    expect(fps.every((fp) => descriptions.has(fp))).toBe(true);

    // The deferred finding became its own issue, outside the escalation.
    const all = issuesOnDisk();
    expect(all.length).toBe(3);
    expect(JSON.stringify(all)).toContain("Valid, out of scope");
  });

  /**
   * `drainDeferrals` reports success only when the WHOLE session-wide queue
   * files. One unrelated older deferral whose creation keeps failing would
   * otherwise hold the session in CODE_REVIEW forever -- re-reviewing nothing,
   * having already filed every finding this ceiling exists to file.
   */
  it("parks once its own findings are filed, even with an unrelated deferral stuck", async () => {
    const withStuck = makeState({
      codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: CEILING - 1 },
      pendingDeferrals: [
        // A fingerprint past the 512-character bound on `dedupeKey`, so
        // `handleIssueCreate` refuses this entry every time and it stays queued
        // no matter how often the drain runs. A permanently-stuck entry is the
        // whole point; one that eventually files would prove nothing.
        { fingerprint: "x".repeat(600), severity: "major", category: "perf", description: "An older deferral", reviewKind: "code" },
      ],
    } as Partial<FullSessionState>);
    const { advance, ctx } = await reportRound(withStuck);

    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("HANDOVER");
    // The unrelated entry is left alone for the ordinary retry path.
    expect((ctx.state.pendingDeferrals ?? []).some((d) => d.fingerprint.length === 600)).toBe(true);
  });

  /**
   * The escalation records WHICH findings are its own, so the session report
   * can name its issues without claiming credit for deferrals filed earlier in
   * the session for unrelated reasons.
   */
  it("records the fingerprints of the findings it filed", async () => {
    const { ctx } = await reportRound(atRound(CEILING));
    const fps = ctx.state.pendingCeilingEscalation?.fingerprints ?? [];
    // The critical and the major. The suggestion is excluded, matching the one
    // exemption the deferral path shares.
    expect(fps.length).toBe(2);
    const filed = (ctx.state.filedDeferrals ?? []).filter((d) => fps.includes(d.fingerprint));
    expect(filed.length).toBe(2);
  });

  /**
   * A `reject` continues without landing whether or not anything is blocking,
   * so the ceiling can fire with zero findings outstanding. The reason is
   * written onto the TICKET's park record and read back out of the ledger
   * later, so "with blocking findings still outstanding" would be a durable
   * false statement about why that item stopped.
   */
  it("does not claim blockers exist when a reject with no findings trips it", async () => {
    const { advance, ctx } = await reportRound(atRound(CEILING), "reject", []);
    expect((advance as { target?: string }).target).toBe("HANDOVER");
    const record = ctx.state.pendingCeilingEscalation!;
    expect(record.unresolvedCritical).toBe(0);
    expect(record.findings).toEqual([]);
    expect(record.reason).not.toContain("blocking findings");
    expect(record.reason).toContain("without reaching a landable verdict");
  });

  it("still lands on approve at the ceiling rather than parking", async () => {
    const { advance } = await reportRound(atRound(CEILING), "approve");
    const target = (advance as { target?: string }).target;
    expect(target).not.toBe("HANDOVER");
    expect(issuesOnDisk().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe("the session report surfaces the escalation", () => {
  /**
   * It needs its own surfacing because nothing else renders it: the termination
   * reason is generic and `landingDecision` is not rendered at all. Without
   * this the single most consequential fact about the session would be
   * reachable only by reading state.json.
   */
  async function render(over: Partial<FullSessionState> = {}): Promise<string> {
    const { formatSessionReport } = await import("../../src/core/session-report-formatter.js");
    return formatSessionReport(
      {
        state: makeState({
        // THE REAL POST-PARK SHAPE. `parkCurrentTicket` clears both review
        // arrays and the draft ticket before the HANDOVER transition, so this
        // is what a completed ceiling session actually persists. Seeding a
        // review round here instead kept the formatter out of its empty-review
        // early return -- and that return was dropping the ceiling section
        // entirely, so every assertion below passed against a state that cannot
        // occur while the real one rendered nothing.
        reviews: { plan: [], code: [] },
        ticket: undefined,
        codeReviewRoundCounter: { workItemId: TICKET, kind: "ticket", completedRounds: 7 },
        pendingCeilingEscalation: {
          workItemId: TICKET, kind: "ticket", displayId: "T-901", round: 7, ceiling: 7, maxReviewRounds: 4,
          reason: "Code review reached its hard ceiling.",
          unresolvedCritical: 1, unresolvedMajor: 1,
          decidedAt: new Date().toISOString(), completed: true,
          fingerprints: ["f1"],
        },
        filedDeferrals: [
          { fingerprint: "f1", issueId: "ISS-9001" },
          // Filed earlier in the session for an unrelated deferral.
          { fingerprint: "unrelated", issueId: "ISS-9002" },
        ],
          ...over,
        } as Partial<FullSessionState>),
        events: { events: [], malformedCount: 0 },
        planContent: null,
        gitLog: null,
      } as never,
      "markdown" as never,
    );
  }

  /**
   * THE REJECT-ONLY STOP, which owns no findings at all.
   *
   * A `reject` continues without landing whether or not anything is blocking,
   * so the ceiling can fire with an empty escalation. Every sentence about
   * filing is then describing artifacts that do not exist -- and telling a
   * reader arriving at a stopped session that "findings may not have reached
   * the ledger" sends them looking for issues nobody ever meant to file.
   */
  const REJECT_ONLY = {
    workItemId: TICKET, kind: "ticket", displayId: "T-901", round: 7, ceiling: 7, maxReviewRounds: 4,
    reason: "Code review reached its hard ceiling without reaching a landable verdict.",
    unresolvedCritical: 0, unresolvedMajor: 0,
    decidedAt: new Date().toISOString(),
    findings: [], fingerprints: [],
  };

  it("does not claim findings are owed when a reject-only stop finished", async () => {
    const text = await render({
      pendingCeilingEscalation: { ...REJECT_ONLY, completed: true },
      filedDeferrals: [],
    } as Partial<FullSessionState>);
    expect(text).toContain("Round ceiling reached");
    expect(text).toContain("no open findings of its own to file");
    expect(text).toContain("this ceiling stop filed nothing of its own");
    expect(text).not.toContain("the filed issues carry");
  });

  /**
   * [codex round-2 finding] issues have no ticket claim and never sit at
   * `inprogress` -- their lifecycle is `resolved`/`open` plus an earmark. The
   * generalized ceiling report used to render ticket-specific lifecycle and
   * claim language unconditionally for an issue escalation too.
   */
  it("[ISS-1032/ISS-1049] an ISSUE escalation renders issue-appropriate lifecycle and outcome language, never the ticket's inprogress/claim wording", async () => {
    const finished = await render({
      ticket: undefined,
      currentIssue: null,
      codeReviewRoundCounter: { workItemId: "i-abc", kind: "issue", completedRounds: 7 },
      pendingCeilingEscalation: {
        workItemId: "i-abc", kind: "issue", displayId: "ISS-901", round: 7, ceiling: 7, maxReviewRounds: 4,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 1,
        decidedAt: new Date().toISOString(), completed: true,
        fingerprints: ["f1"],
      },
    } as Partial<FullSessionState>);
    expect(finished).toContain("Round ceiling reached");
    expect(finished).not.toContain("inprogress");
    expect(finished).not.toContain("claim was released");
    expect(finished).toContain("reopened to `open`");

    const unfinished = await render({
      ticket: undefined,
      currentIssue: null,
      codeReviewRoundCounter: { workItemId: "i-abc", kind: "issue", completedRounds: 7 },
      pendingCeilingEscalation: {
        workItemId: "i-abc", kind: "issue", displayId: "ISS-901", round: 7, ceiling: 7, maxReviewRounds: 4,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 1,
        decidedAt: new Date().toISOString(), completed: false,
        fingerprints: ["f1"],
      },
      filedDeferrals: [],
    } as Partial<FullSessionState>);
    expect(unfinished).toContain("This stop did not finish");
    expect(unfinished).not.toContain("may still be `inprogress`");
    expect(unfinished).toContain("may still show status `resolved`");
  });

  it("[codex round-3 finding #3] a completed ISSUE escalation's outcome note also covers a missing issue and an unproven resolution epoch, not only status drift or a foreign earmark", async () => {
    const finished = await render({
      ticket: undefined,
      currentIssue: null,
      codeReviewRoundCounter: { workItemId: "i-abc", kind: "issue", completedRounds: 7 },
      pendingCeilingEscalation: {
        workItemId: "i-abc", kind: "issue", displayId: "ISS-901", round: 7, ceiling: 7, maxReviewRounds: 4,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 1,
        decidedAt: new Date().toISOString(), completed: true,
        fingerprints: ["f1"],
      },
    } as Partial<FullSessionState>);
    expect(finished).toContain("reopened to `open`");
    expect(finished).toContain("the issue was missing");
    expect(finished).toContain("resolution epoch");
    expect(finished).not.toContain("its status drifted, or a foreign earmark was present");
  });

  it("does not claim findings are owed when a reject-only stop did not finish", async () => {
    const text = await render({
      pendingCeilingEscalation: { ...REJECT_ONLY, completed: false },
      filedDeferrals: [],
    } as Partial<FullSessionState>);
    expect(text).toContain("This stop did not finish");
    // The park is still what may be outstanding, so that half stays.
    expect(text).toContain("may still be `inprogress`");
    expect(text).toContain("no open findings of its own to file");
    expect(text).not.toContain("may not have reached the ledger");
  });

  /**
   * AND IT SAYS "of its own", not "nothing".
   *
   * A ceiling-triggering reject can carry `deferred` findings. Those are
   * deliberately not the escalation's -- the ordinary deferral path owns them --
   * so the record is empty while real issue work exists. Copy that generalised
   * from "this escalation owns nothing" to "nothing is owed to the ledger" was
   * false in exactly this case, and it is the case a reader is most likely to
   * be checking.
   */
  it("does not deny the ledger work a reject-only stop's deferred findings created", async () => {
    const withDeferred = {
      pendingCeilingEscalation: { ...REJECT_ONLY, completed: true },
      filedDeferrals: [{ fingerprint: "deferred-1", issueId: "ISS-9100" }],
    } as Partial<FullSessionState>;
    const done = await render(withDeferred);
    expect(done).toContain("no open findings of its own to file");
    expect(done).not.toContain("nothing about this stop is recorded as an issue");
    expect(done).not.toContain("nothing is owed to the ledger");

    const unfinished = await render({
      pendingCeilingEscalation: { ...REJECT_ONLY, completed: false },
      filedDeferrals: [],
      pendingDeferrals: [
        { fingerprint: "deferred-1", severity: "major", category: "api", description: "Valid, out of scope", reviewKind: "code" },
      ],
    } as Partial<FullSessionState>);
    expect(unfinished).toContain("no open findings of its own to file");
    expect(unfinished).not.toContain("nothing is owed to the ledger");
  });

  it("names the round, the ceiling, the item and the filed issues", async () => {
    const text = await render();
    expect(text).toContain("Round ceiling reached");
    expect(text).toContain("round 7");
    expect(text).toContain("T-901");
    expect(text).toContain("ISS-9001");
  });

  /**
   * `filedDeferrals` is SESSION-wide. Listing all of it under a "round ceiling"
   * heading would attribute unrelated work to this stop -- to a reader deciding
   * what review could not resolve, that is a wrong answer, not a verbose one.
   * The escalation records its own fingerprints so the list can be narrowed.
   */
  it("does not attribute unrelated deferrals to the ceiling", async () => {
    const text = await render();
    expect(text).not.toContain("ISS-9002");
  });

  it("says nothing was filed yet when the escalation has no fingerprints", async () => {
    const text = await render({
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", round: 7, ceiling: 7, maxReviewRounds: 4,
        reason: "Code review reached its hard ceiling.",
        unresolvedCritical: 1, unresolvedMajor: 1,
        decidedAt: new Date().toISOString(), completed: false, fingerprints: [],
      },
    } as Partial<FullSessionState>);
    expect(text).toContain("did not finish");
    expect(text).not.toContain("ISS-9001");
  });

  /**
   * The uncommitted tree is the fact a reader cannot infer from anything else
   * here, and it is why the session ended rather than moving on.
   */
  it("says the work is still uncommitted, which is why the session ended", async () => {
    expect(await render()).toContain("uncommitted");
  });

  /**
   * And it names BOTH triggers. `decideCeiling` fires on any round that would
   * continue rather than finalize, so a `reject` verdict trips it with zero
   * criticals outstanding -- a sentence blaming unresolved criticals would then
   * sit directly under a line reporting none of them.
   */
  it("explains why the cap alone did not bound this, for either trigger", async () => {
    const text = await render();
    expect(text).toContain("forced landing requires a non-blocking outcome");
    expect(text).toContain("reject verdicts");
    expect(text).not.toContain("requires nothing blocking");
  });

  it("renders nothing when no ceiling fired", async () => {
    const text = await render({ pendingCeilingEscalation: null } as Partial<FullSessionState>);
    expect(text).not.toContain("Round ceiling reached");
  });

  /**
   * ISS-1114: an empty-verdict park is NOT a round ceiling, and every clause of
   * the round-ceiling copy is false for it. That stop can happen on round 1, so
   * "stopped at round N of a ceiling of M (cap X plus grace)" names a limit that
   * was never reached; it carries zero findings by definition of the trigger, so
   * the outstanding-findings clause reports a count that cannot be nonzero; and
   * "the ceiling is what ends either loop" points a reader at a mechanism that
   * did not fire. What actually happened is that a reviewer stopped supplying
   * findings and did not resume after being asked.
   */
  it("[ISS-1114] renders an empty-verdict park as a reviewer failure, not a round ceiling", async () => {
    const text = await render({
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", displayId: "T-901", round: 1, ceiling: 7, maxReviewRounds: 4,
        trigger: "empty-verdict", repairAttempts: 2,
        reason: "Code review round 1 for T-901 ended with an incomplete verdict from codex.",
        unresolvedCritical: 0, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(), completed: true,
        findings: [], fingerprints: [],
      },
      filedDeferrals: [],
    } as Partial<FullSessionState>);

    expect(text).toContain("Review returned no findings to act on");
    expect(text).toContain("2 time(s)");
    expect(text).toContain("cannot distinguish");
    // The false clauses must be gone, not merely reworded around.
    expect(text).not.toContain("Round ceiling reached");
    expect(text).not.toContain("plus grace");
    expect(text).not.toContain("The cap alone does not bound this case");
    // Never claims the park LANDED: this head renders for unfinished records
    // too, and the unfinished branch below it says the item may still be
    // inprogress. "was parked" there would contradict this one two lines later.
    expect(text).not.toContain("the item was parked");
  });

  /**
   * The unfinished half of the same point. A crash between the escalation write
   * and the park leaves `completed: false`, and the report must not assert an
   * outcome that may not have happened.
   */
  it("[ISS-1114] does not claim an unfinished empty-verdict park landed", async () => {
    const text = await render({
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", displayId: "T-901", round: 1, ceiling: 7, maxReviewRounds: 4,
        trigger: "empty-verdict", repairAttempts: 2,
        reason: "Code review round 1 for T-901 ended with an incomplete verdict from codex.",
        unresolvedCritical: 0, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(), completed: false,
        findings: [], fingerprints: [],
      },
      filedDeferrals: [],
    } as Partial<FullSessionState>);

    expect(text).toContain("Review returned no findings to act on");
    expect(text).toContain("parking was requested");
    expect(text).not.toContain("the item was parked");
    // The existing unfinished-stop warning still fires, and now nothing above
    // it contradicts it.
    expect(text).toContain("may still be");
  });

  /**
   * The compatibility half. Every record written before `trigger` existed was a
   * round-ceiling park, so an ABSENT trigger has to render exactly as it did
   * before: an optional field added to a persisted schema must not change the
   * meaning of records already on disk.
   */
  it("[ISS-1114] renders a legacy record with no trigger exactly as a round ceiling", async () => {
    const text = await render();
    expect(text).toContain("Round ceiling reached");
    expect(text).toContain("plus grace");
    expect(text).toContain("The cap alone does not bound this case");
    expect(text).not.toContain("Review returned no findings to act on");
  });

  /**
   * An UNFINISHED escalation is if anything more important to surface: the
   * session is mid-park and some findings may not be filed yet.
   */
  it("still renders while the escalation is unfinished", async () => {
    const text = await render({
      pendingCeilingEscalation: {
        workItemId: TICKET, kind: "ticket", round: 7, ceiling: 7, maxReviewRounds: 4,
        reason: "x", unresolvedCritical: 1, unresolvedMajor: 0,
        decidedAt: new Date().toISOString(), completed: false,
      },
      filedDeferrals: [],
    } as Partial<FullSessionState>);
    expect(text).toContain("Round ceiling reached");
    // An unfinished stop makes no lifecycle claims. Filing happens before the
    // park, and the `completed` marker commits with the park transition, so an
    // unfinished record means either step may still be outstanding: the item
    // may still be `inprogress` and some findings may not have reached the
    // ledger. Saying otherwise would send the next reader looking for issues
    // that do not exist.
    expect(text).toContain("did not finish");
    expect(text).not.toContain("back to `open`");
  });
});
