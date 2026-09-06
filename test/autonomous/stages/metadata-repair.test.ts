/**
 * ISS-1115 3.3a/3.3b: metadata repair, at the STAGE.
 *
 * WHY NOT IN THE PACKET TESTS, where the first draft put it. The packet builder
 * reads historical artifacts; it never sees the current report and cannot
 * control landing. A repair result computed there would pass its unit test
 * while the unlabelled report landed anyway -- the fix-the-helper-leave-the-
 * caller shape this run produced four times. So the repair is a TRANSITION and
 * is tested as one, through `stage.report`.
 *
 * THE CASE THAT MATTERS MOST IS THE LENS ONE. The report handler has four
 * backends, not the three the packet has, and `LensFindingSchema` is `.strict()`
 * with no `originClass`, so a lens round can never satisfy a mandatory label.
 * Without the exemption every lens round loops forever: a fleet stop, not a
 * degradation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import { readFileSync, readdirSync } from "node:fs";
import { roundBlockerPredicate } from "../../../src/autonomous/review-identity.js";
import { outstandingCeilingFindings } from "../../../src/autonomous/stages/code-review-ceiling.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { verdictFilename, computeContentHash, type ReviewVerdictArtifact } from "../../../src/autonomous/review-verdict.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 1,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    currentIssue: null, resolvedIssues: [],
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    landingDecision: null, currentReviewStartedAt: now,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: { CODE_REVIEW: { maxReviewRounds: 5 } },
    dirtyFileHandling: "block", branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
  };
}

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const d of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(storyDir, d), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-09-05",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  // T-494: the plan-pin guard resolves the session's ticket in the ledger and
  // fails closed when it cannot, so the ticket the session names must exist.
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-08-01",
    completedDate: null, blockedBy: [],
  }));
}

function seedArtifact(sessionDir: string, o: {
  round: number; stage?: string; findings?: readonly unknown[];
  backendRunId?: string; backendRunIdKind?: string;
}): void {
  const stage = o.stage ?? "code";
  const findings = o.findings ?? [];
  const artifact = {
    target: "T-001", stage, round: o.round, reviewer: "codex", verdict: "revise",
    findingsCount: findings.length,
    severityCounts: { critical: 0, major: findings.length, minor: 0, suggestion: 0 },
    startedAt: "2026-09-05T00:00:00.000Z", durationMs: 1, summary: "s",
    findings, timestamp: "2026-09-05T00:00:01.000Z", generation: 0,
    ...(o.backendRunId === undefined ? {} : { backendRunId: o.backendRunId }),
    ...(o.backendRunIdKind === undefined ? {} : { backendRunIdKind: o.backendRunIdKind }),
  } as ReviewVerdictArtifact;
  const dir = join(sessionDir, "telemetry", "reviews");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, verdictFilename("T-001", stage, o.round, 0)),
    JSON.stringify({ ...artifact, _contentHash: computeContentHash(artifact) }),
    "utf-8",
  );
}


const UNLABELLED = {
  id: "F1", severity: "major", category: "correctness",
  description: "a real defect that must not be lost", disposition: "open",
};
const LABELLED = { ...UNLABELLED, originClass: "unchanged", sinceRound: 1 };

const round = (verdict: string, findings: readonly unknown[]) =>
  ({ completedAction: "code_review_round", verdict, findings }) as never;
const planRound = (verdict: string, findings: readonly unknown[]) =>
  ({ completedAction: "plan_review_round", verdict, findings }) as never;

function artifacts(sessionDir: string): Record<string, unknown>[] {
  const dir = join(sessionDir, "telemetry", "reviews");
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

describe("ISS-1115 3.3a: the repair is a transition, not a value", () => {
  let testRoot: string; let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-repair-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("ROUND 1 does not ask for a label", async () => {
    // The control for the round condition. If this ever fails the gate has
    // become a blanket requirement, which the item does not ask for.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const advance = await stage.report(ctx, round("revise", [UNLABELLED]));

    expect(advance.action).not.toBe("retry");
    expect(ctx.state.reviews.code).toHaveLength(1);
  });

  it("ROUND 2 unlabelled asks for a repair, and does NOT record the round", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, round("revise", [LABELLED]));
    const advance = await stage.report(ctx, round("revise", [UNLABELLED]));

    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("originClass");
      // A repair, not another review. Inviting a fresh review here would turn
      // the label requirement into a way to relitigate findings.
      expect(advance.instruction).toMatch(/Do not drop, add or reword any finding/);
    }
    // Refused payloads leave no round and no artifact behind to be replayed.
    expect(ctx.state.reviews.code).toHaveLength(1);
    expect(artifacts(sessionDir)).toHaveLength(1);
  });

  it("PERSISTS THE ATTEMPT BEFORE RETRYING, so a crash cannot refund the bound", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, round("revise", [LABELLED]));
    await stage.report(ctx, round("revise", [UNLABELLED]));

    // Written with `writeState`, so it is durable at the moment the retry is
    // issued rather than staged behind a downstream write that may not happen.
    const attempts = (ctx.state.reviewRepairAttempts ?? []) as { trigger?: string }[];
    expect(attempts.filter((a) => a.trigger === "provenance")).toHaveLength(1);
  });

  it("SURVIVES A RELOAD: the attempt is still spent after the state round-trips", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, round("revise", [LABELLED]));
    await stage.report(ctx, round("revise", [UNLABELLED]));

    // Rebuild the context from the persisted state, the way a resumed session
    // does. If `trigger` were stripped by the schema the bound would silently
    // reset and the round could loop, which is the F7 class in the field this
    // whole gate depends on.
    const reloaded = new StageContext(testRoot, sessionDir, ctx.state, makeRecipe());
    const advance = await reloaded.state.reviewRepairAttempts
      ? await stage.report(reloaded, round("revise", [UNLABELLED]))
      : null;

    expect(advance!.action).not.toBe("retry");
    expect((reloaded.state.reviewRepairAttempts ?? []).filter(
      (a: { trigger?: string }) => a.trigger === "provenance")).toHaveLength(1);
  });

  it("IS BOUNDED AT ONE: a second unlabelled report is not retried again", async () => {
    // Unbounded rejection stalls a round with no round consumed and no exit,
    // which is worse than the missing label. Asserted on the specific outcome,
    // because "did not retry" is also what a broken check produces -- so the
    // round has to actually be RECORDED.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, round("revise", [LABELLED]));
    await stage.report(ctx, round("revise", [UNLABELLED]));
    const second = await stage.report(ctx, round("revise", [UNLABELLED]));

    expect(second.action).not.toBe("retry");
    expect(ctx.state.reviews.code).toHaveLength(2);
  });

  it("NEVER DISCARDS THE FINDING, at either end of the bound", async () => {
    // An unlabelled finding is still an evidenced defect. Dropping one over a
    // metadata problem is precisely the quiet failure this item exists to stop.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, round("revise", [LABELLED]));
    await stage.report(ctx, round("revise", [UNLABELLED]));
    await stage.report(ctx, round("revise", [UNLABELLED]));

    const last = artifacts(sessionDir).find((a) => a.round === 2)!;
    expect(JSON.stringify(last.findings)).toContain("a real defect that must not be lost");
  });
});

/**
 * The hole Codex found in review: the gate's `unresolved` verdict was computed
 * and then dropped. Both stages handled `repair` and `exempt` and nothing else,
 * so a reviewer that was asked for labels twice and supplied none could settle
 * a finding `addressed` and land it -- the laundering the labels exist to
 * prevent, reached by declining to answer instead of by lying.
 *
 * The step-5 comment claimed the opposite ("after the bound, the round proceeds
 * and its findings are UNRESOLVED, so landing blocks"), which is what makes
 * this worth its own describe: the prose was right and the code did not do it,
 * and the tests as written could not tell the difference because they all used
 * `open` findings, which block on disposition alone.
 */
describe("ISS-1115: a gate that GAVE UP still blocks the round", () => {
  let testRoot: string; let sessionDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-gaveup-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  // Marked fixed by the reviewer, with no word on whether it is the same defect
  // returning. Disposition alone settles it; only provenance does not.
  const ADDRESSED_UNLABELLED = {
    id: "F9", severity: "major", category: "correctness",
    description: "the same defect, possibly for the third time", disposition: "addressed",
  };

  async function spendTheBound(ctx: StageContext, stage: CodeReviewStage) {
    await stage.report(ctx, round("revise", [LABELLED]));
    await stage.report(ctx, round("revise", [UNLABELLED]));
  }

  it("CODE: once the bound is spent, an addressed-but-unlabelled major no longer lands", async () => {
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await spendTheBound(ctx, stage);

    const advance = await stage.report(ctx, round("approve", [ADDRESSED_UNLABELLED]));

    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("Contradictory review payload");
      // And NOT another metadata repair: the bound is spent, and asking again
      // is the unbounded stall the bound exists to prevent.
      expect(advance.instruction).not.toContain("originClass");
    }
  });

  it("CODE: the identical finding lands when it carries a label", async () => {
    // The control. Without it, the assertion above is equally satisfied by a
    // stage that stopped landing anything at all after a spent repair.
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await spendTheBound(ctx, stage);

    const advance = await stage.report(ctx, round("approve", [
      { ...ADDRESSED_UNLABELLED, originClass: "unchanged", sinceRound: 1 },
    ]));

    expect(advance.action).not.toBe("retry");
  });

  it("CODE: the override reaches ONLY the findings the gate gave up on", async () => {
    // The scope test, and the one the first control could not be. That control
    // sends a fully labelled round, so its gate returns `ok` and the override
    // never runs -- it proves the stage still lands, not that the override is
    // narrow. Here the gate DOES give up (the major is unlabelled), and the
    // labelled-and-addressed critical beside it must still read as settled.
    // Widening the override to the whole round would quietly convert every
    // finding in it into a blocker.
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await spendTheBound(ctx, stage);

    await stage.report(ctx, round("revise", [
      { id: "C1", severity: "critical", category: "security", description: "settled, and it says so",
        disposition: "addressed", originClass: "unchanged", sinceRound: 1 },
      ADDRESSED_UNLABELLED,
    ]));

    const written = artifacts(sessionDir).find((a) => a.provenanceUnresolved != null)!;
    expect(written.unresolvedCriticalCount).toBe(0);
  });

  it("CODE: the round RECORDS that its provenance was never resolved", async () => {
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await spendTheBound(ctx, stage);
    await stage.report(ctx, round("revise", [ADDRESSED_UNLABELLED]));

    // A round that was checked and a round that was asked and never answered
    // are otherwise indistinguishable in the record, and only one is trustworthy.
    const written = artifacts(sessionDir).find((a) => a.provenanceUnresolved != null);
    expect(written).toBeTruthy();
    expect(JSON.stringify(written!.provenanceUnresolved)).toContain("unlabelled");
  });

  it("PLAN: the same round does not reach IMPLEMENT once the gate has given up", async () => {
    const stage = new PlanReviewStage();
    const state = makeState({ state: "PLAN_REVIEW" } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n", "utf-8");

    await stage.report(ctx, planRound("revise", [LABELLED]));
    await stage.report(ctx, planRound("revise", [UNLABELLED]));
    const advance = await stage.report(ctx, planRound("revise", [ADDRESSED_UNLABELLED]));

    // An all-addressed revise is the plan stage's clean landing. Here it must
    // not be one, because nothing established that the finding is settled.
    expect(advance.action).not.toBe("advance");
  });

  it("PLAN: and it DOES reach IMPLEMENT when the same finding is labelled", async () => {
    const stage = new PlanReviewStage();
    const state = makeState({ state: "PLAN_REVIEW" } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n", "utf-8");

    await stage.report(ctx, planRound("revise", [LABELLED]));
    await stage.report(ctx, planRound("revise", [UNLABELLED]));
    const advance = await stage.report(ctx, planRound("revise", [
      { ...ADDRESSED_UNLABELLED, originClass: "unchanged", sinceRound: 1 },
    ]));

    expect(advance.action).toBe("advance");
  });
});

/**
 * The SECOND hole Codex found: the ceiling skip.
 *
 * The stages used to suppress the metadata repair at the round ceiling and
 * leave the gate's verdict as `repair`, on the reasoning that an item on its
 * way to a human must not be held up for metadata. The reasoning was right and
 * the consequence was not: `repair` reads as an ordinary round to the blocking
 * predicate, so an unlabelled finding marked `addressed` counted as settled,
 * the round LANDED, and `decidePlanCeiling` exempts IMPLEMENT -- so the human
 * the ceiling exists to summon was never summoned. The comment claimed "the
 * unlabelled findings still reach the escalation", which is false for a round
 * that lands instead of escalating.
 *
 * The ceiling now lives INSIDE the gate: at the ceiling it asks for nothing and
 * returns `unresolved`, so the round blocks its way to a human.
 */
describe("ISS-1115: at the ceiling the gate asks nothing and settles nothing", () => {
  const PLAN_CEILING = 8;
  let testRoot: string; let sessionDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-ceil-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n", "utf-8");
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  const ADDRESSED_UNLABELLED_CRITICAL = {
    id: "F9", severity: "critical", category: "security",
    description: "unvalidated input reaches the query", disposition: "addressed",
  };

  it("PLAN: an addressed-but-unlabelled critical at the ceiling does not reach IMPLEMENT", async () => {
    const state = makeState({
      state: "PLAN_REVIEW",
      planReviewRoundCounter: { ticketId: "T-001", completedRounds: PLAN_CEILING - 1 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await new PlanReviewStage().report(
      ctx, planRound("approve", [ADDRESSED_UNLABELLED_CRITICAL]));

    // Landing here is the bug: IMPLEMENT is exempt from the ceiling park, so a
    // round that lands at the ceiling escapes escalation entirely.
    expect(advance.action).not.toBe("advance");
    // AND NOT A RETRY EITHER, which is the failure the first version of this
    // test could not see. `not.toBe("advance")` is satisfied by the
    // contradictory-approve bounce, which returns before the round is
    // recorded, before the artifact is written and before the escalation runs
    // -- so the reviewer loops on the same payload forever and the ceiling
    // stays stranded. Codex found that the test passed while the session hung.
    expect(advance.action).not.toBe("retry");
  });

  it("PLAN: that ceiling approve is CONSUMED: counter advances, reason recorded, park fires", async () => {
    const state = makeState({
      state: "PLAN_REVIEW",
      planReviewRoundCounter: { ticketId: "T-001", completedRounds: PLAN_CEILING - 1 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await new PlanReviewStage().report(ctx, planRound("approve", [ADDRESSED_UNLABELLED_CRITICAL]));

    // The durable counter moved, so the round cannot be replayed for free.
    expect(ctx.state.planReviewRoundCounter?.completedRounds).toBe(PLAN_CEILING);
    // The record says why this round could not be trusted...
    const written = artifacts(sessionDir).find((a) => a.provenanceUnresolved != null)!;
    expect(written).toBeTruthy();
    // ...and keeps the reviewer's ACTUAL verdict rather than a coerced one. The
    // routing is what changed, not what the reviewer said.
    expect(written.verdict).toBe("approve");
    // And the stop actually reached a human, with the finding that caused it.
    expect(ctx.state.pendingPlanCeilingEscalation).toBeTruthy();
    expect(JSON.stringify(ctx.state.pendingPlanCeilingEscalation?.findings))
      .toContain("unvalidated input reaches the query");
  });

  it("CODE: the same ceiling approve is consumed and parked, not bounced", async () => {
    const state = makeState({
      codeReviewRoundCounter: { workItemId: "T-001", kind: "ticket", completedRounds: 7 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await new CodeReviewStage().report(
      ctx, round("approve", [ADDRESSED_UNLABELLED_CRITICAL]));

    expect(advance.action).not.toBe("retry");
    expect(ctx.state.pendingCeilingEscalation).toBeTruthy();
    expect(JSON.stringify(ctx.state.pendingCeilingEscalation?.findings))
      .toContain("unvalidated input reaches the query");
  });

  it("PLAN: and it is NOT asked for a repair, because the ceiling does not stall", async () => {
    // The other half. The original skip existed for a real reason -- an item on
    // its way to a human must not be held for metadata -- and that must survive
    // the fix.
    const state = makeState({
      state: "PLAN_REVIEW",
      planReviewRoundCounter: { ticketId: "T-001", completedRounds: PLAN_CEILING - 1 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await new PlanReviewStage().report(
      ctx, planRound("revise", [ADDRESSED_UNLABELLED_CRITICAL]));

    if (advance.action === "retry") expect(advance.instruction).not.toContain("originClass");
    expect((ctx.state.reviewRepairAttempts ?? []).filter(
      (a: { trigger?: string }) => a.trigger === "provenance")).toHaveLength(0);
  });

  it("CODE: and the same is true when the report ALSO recommends replanning", async () => {
    // The payload shape that survived the first version of this fix: approve,
    // an unlabelled addressed critical, AND recommendedNextState "PLAN". The
    // code stage has TWO contradictory-approve guards, and exempting only the
    // first left this one bouncing the round before the routing branch was
    // reached. There is no plan-stage twin; that stage has one guard.
    const state = makeState({
      codeReviewRoundCounter: { workItemId: "T-001", kind: "ticket", completedRounds: 7 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await new CodeReviewStage().report(ctx, round("approve", [
      { ...ADDRESSED_UNLABELLED_CRITICAL, recommendedNextState: "PLAN" },
    ]));

    expect(advance.action).not.toBe("retry");
    expect(ctx.state.codeReviewRoundCounter?.completedRounds).toBe(8);
    expect(ctx.state.pendingCeilingEscalation).toBeTruthy();
    expect(JSON.stringify(ctx.state.pendingCeilingEscalation?.findings))
      .toContain("unvalidated input reaches the query");
  });

  /**
   * Gate 3, the pen's finding. `atCodeCeiling` was
   *
   *   repairKeyRound >= codeReviewHardCeiling(...) || repairKeyRound >= maxReviewRounds
   *
   * and both halves were wrong, in opposite directions.
   */
  function recipeWithCap(cap: number): ResolvedRecipe {
    return { ...makeRecipe(), stages: { CODE_REVIEW: { maxReviewRounds: cap } } };
  }

  it("CODE: an UNLIMITED-rounds project still gets asked for labels", async () => {
    // `maxReviewRounds: 0` is a legal configured value meaning unlimited:
    // configuredCodeReviewMaxRounds returns 0 for raw 0, codeReviewHardCeiling
    // returns 0 for that cap, and decideCeiling never parks because it guards
    // on `ceiling > 0`. Against a ceiling of 0 every comparison
    // `repairKeyRound >= 0` is true, so the gate treated EVERY round on such a
    // project as a ceiling round: never a repair request, always `unresolved`,
    // findings always blocking, an approve always stranded, and no park to end
    // it because the ceiling is 0. That is the fleet halt, on precisely the
    // configuration that opted out of ceilings.
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sessionDir, makeState(), recipeWithCap(0));

    await stage.report(ctx, round("revise", [LABELLED]));
    const advance = await stage.report(ctx, round("revise", [UNLABELLED]));

    expect(advance.action).toBe("retry");
    if (advance.action === "retry") expect(advance.instruction).toContain("originClass");
    expect((ctx.state.reviewRepairAttempts ?? []).filter(
      (a: { trigger?: string }) => a.trigger === "provenance")).toHaveLength(1);
  });

  it("CODE: inside the GRACE window the reviewer is still asked, because no park fires there", async () => {
    // Cap 5, hard ceiling 8. At round 5 the second clause fired, so the gate
    // stopped asking for labels. But decideCeiling parks only at the HARD
    // ceiling, and at the cap a change request lands via forcedLanding at
    // FINALIZE -- so "the item is on its way to a human" is false in this
    // window, and skipping the repair there just force-defers unlabelled
    // findings. Not asking is only justified where the park actually fires.
    const stage = new CodeReviewStage();
    const state = makeState({
      codeReviewRoundCounter: { workItemId: "T-001", kind: "ticket", completedRounds: 4 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, recipeWithCap(5));

    const advance = await stage.report(ctx, round("revise", [UNLABELLED]));

    expect(advance.action).toBe("retry");
    if (advance.action === "retry") expect(advance.instruction).toContain("originClass");
  });

  it("the ceiling reason is recorded, and is distinguishable from a spent repair", async () => {
    const state = makeState({
      state: "PLAN_REVIEW",
      planReviewRoundCounter: { ticketId: "T-001", completedRounds: PLAN_CEILING - 1 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await new PlanReviewStage().report(ctx, planRound("revise", [ADDRESSED_UNLABELLED_CRITICAL]));

    const written = artifacts(sessionDir).find((a) => a.provenanceUnresolved != null)!;
    expect(JSON.stringify(written.provenanceUnresolved)).toContain("round ceiling");
  });

  it("the escalation PROJECTION keeps the finding the counts say is outstanding", async () => {
    // Codex's second finding. The projection used the bare origin guard while
    // the counts used the round predicate, so a park record could say
    // `unresolvedCritical: 1` and list nothing -- the finding that stopped the
    // session missing from the record of why it stopped.
    const isBlocking = roundBlockerPredicate({
      kind: "unresolved", reasons: ["asked and never answered"],
    });

    const out = outstandingCeilingFindings([ADDRESSED_UNLABELLED_CRITICAL], isBlocking);

    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("critical");
  });

  it("a DEFERRED finding is not double-filed just because the round lost its labels", async () => {
    // The boundary the e2e ceiling suite caught. `deferred` is already filed by
    // the deferral path; adding it here on a missing label would file it twice,
    // once as an out-of-scope note and once as a ceiling blocker, on no
    // evidence that the deferral was wrong.
    const isBlocking = roundBlockerPredicate({ kind: "unresolved", reasons: ["gave up"] });
    const deferredUnlabelled = {
      severity: "major", category: "api", description: "valid, out of scope",
      disposition: "deferred",
    };

    expect(outstandingCeilingFindings([deferredUnlabelled], isBlocking)).toHaveLength(0);
  });

  it("but a deferred finding that was REINTRODUCED is filed, because that is evidence", async () => {
    // The other side of the same boundary: positive contradiction overrides the
    // deferral, absence of a label does not.
    const isBlocking = roundBlockerPredicate({ kind: "unresolved", reasons: ["gave up"] });
    const deferredReintroduced = {
      severity: "major", category: "api", description: "valid, out of scope",
      disposition: "deferred", originClass: "reintroduced",
    };

    expect(outstandingCeilingFindings([deferredReintroduced], isBlocking)).toHaveLength(1);
  });

  it("and the SAME projection drops it on an ordinary round", async () => {
    // The control: this is not "file everything addressed", it is "file what
    // this round's gate could not settle".
    const out = outstandingCeilingFindings(
      [ADDRESSED_UNLABELLED_CRITICAL], roundBlockerPredicate({ kind: "ok" }));

    expect(out).toHaveLength(0);
  });
});

describe("ISS-1115 3.3b: lenses are exempt, and the exemption is recorded", () => {
  let testRoot: string; let sessionDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-lens-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  /**
   * A REAL synthesized lens payload: no `originClass`, because the package's
   * schemas are `.strict()` and cannot carry one. Reporting `reviewer:
   * "lenses"` over a codex-shaped finding would test the label rather than the
   * payload, and the label is not what makes it a lens round.
   */
  const LENS_FINDING = {
    severity: "major", category: "security", description: "unvalidated input reaches the query",
    disposition: "open", lens: "security",
  };

  it("a round-2 LENS report passes untouched on the CODE stage", async () => {
    const stage = new CodeReviewStage();
    const state = makeState({
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await stage.report(ctx, { completedAction: "code_review_round", verdict: "revise", reviewer: "lenses", findings: [LENS_FINDING] } as never);
    const advance = await stage.report(ctx, { completedAction: "code_review_round", verdict: "revise", reviewer: "lenses", findings: [LENS_FINDING] } as never);

    // No repair, no retry, no stall. Without the exemption this loops forever
    // against a backend that cannot produce what is being demanded.
    expect(advance.action).not.toBe("retry");
    expect(ctx.state.reviews.code).toHaveLength(2);
  });

  it("a round-2 LENS report passes untouched on the PLAN stage too", async () => {
    const stage = new PlanReviewStage();
    const state = makeState({
      state: "PLAN_REVIEW",
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await stage.report(ctx, { ...planRound("revise", [LENS_FINDING]), reviewer: "lenses" } as never);
    const advance = await stage.report(ctx, { ...planRound("revise", [LENS_FINDING]), reviewer: "lenses" } as never);

    // NOT asserted as "action is not retry", which is what the first draft
    // wrote by copying the code-stage test. Plan review answers a revise
    // verdict WITH `retry` -- that is its normal path, not a repair -- so the
    // action alone cannot tell an exemption from the loop this test exists to
    // rule out. The two are told apart by what the retry SAYS and by whether
    // the round was consumed.
    expect(advance.action).toBe("retry");
    if (advance.action === "retry") expect(advance.instruction).not.toContain("originClass");
    expect(ctx.state.reviews.plan).toHaveLength(2);
  });

  it("but the PLAN stage does demand a label when the backend can carry one", async () => {
    // The positive control for the test above. Without it, "the plan stage did
    // not ask for a label" is equally satisfied by a plan stage where the gate
    // was never wired at all, and the lens assertion would prove nothing.
    const stage = new PlanReviewStage();
    const state = makeState({ state: "PLAN_REVIEW" } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await stage.report(ctx, planRound("revise", [LABELLED]));
    const advance = await stage.report(ctx, planRound("revise", [UNLABELLED]));

    expect(advance.action).toBe("retry");
    if (advance.action === "retry") expect(advance.instruction).toContain("originClass");
    // And the refused round is not recorded, same as on the code stage.
    expect(ctx.state.reviews.plan).toHaveLength(1);
  });

  it("WRITES the exemption onto the artifact rather than applying it silently", async () => {
    const stage = new CodeReviewStage();
    const state = makeState({
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await stage.report(ctx, { completedAction: "code_review_round", verdict: "revise", reviewer: "lenses", findings: [LENS_FINDING] } as never);

    const artifact = artifacts(sessionDir)[0]!;
    expect(artifact.provenanceExemption).toBeTruthy();
    expect(String(artifact.provenanceExemption)).toContain("lenses");
    expect(String(artifact.provenanceExemption)).toMatch(/cannot express originClass/);
  });

  it("does NOT write an exemption onto a round that was actually required to label", async () => {
    // The control. An exemption field present everywhere would be noise, and
    // one present nowhere would be the silent case this exists to prevent.
    const stage = new CodeReviewStage();
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    await stage.report(ctx, round("revise", [LABELLED]));

    expect(artifacts(sessionDir)[0]!.provenanceExemption).toBeUndefined();
  });
});
