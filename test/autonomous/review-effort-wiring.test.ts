import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Side-effect import: populates the stage registry so findNextStage walks the
// REAL stages. Without it the traversal assertions below would pass vacuously.
import "../../src/autonomous/stages/index.js";

import { findNextStage } from "../../src/autonomous/stages/registry.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { resolveRecipe } from "../../src/autonomous/recipes/loader.js";
import { isValidTransition } from "../../src/autonomous/state-machine.js";
import { analyzeSessionDiagnostics, dialCodeReviewMaxRounds } from "../../src/autonomous/session-diagnostics.js";
import { PlanReviewStage } from "../../src/autonomous/stages/plan-review.js";
import { CodeReviewStage } from "../../src/autonomous/stages/code-review.js";
import { SessionStateSchema, type FullSessionState } from "../../src/autonomous/session-types.js";
import {
  effectiveReviewEffort,
  normalizeReviewEffortSource,
  reviewEffortForTicket,
  sessionEffortFromState,
} from "../../src/autonomous/review-effort.js";

/**
 * T-461, the dial wired into the session.
 *
 * The load-bearing property is that `off` actually removes the review stages
 * from the walk without stranding the walker: findNextStage honors skip(), but
 * processAdvance then asserts the transition, so a skipped stage without its
 * replacement edge throws instead of advancing.
 */

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PLAN", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(pipeline: string[], stages: Record<string, Record<string, unknown>> = {}): ResolvedRecipe {
  return {
    id: "coding",
    pipeline,
    postComplete: [],
    stages,
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
    reviewEffort: {
      level: "size-mapped",
      source: "default",
      explicitKnobs: { codeReviewMaxRounds: false, planReviewBackends: false, codeReviewBackends: false },
    },
  } as ResolvedRecipe;
}

describe("resolveRecipe review effort", () => {
  it("defaults to size-mapped and mutates no stage config", () => {
    // The back-compat anchor: a project that never touches the dial gets the
    // same resolvedStages it always got.
    const recipe = resolveRecipe("coding");
    expect(recipe.reviewEffort.level).toBe("size-mapped");
    expect(recipe.reviewEffort.source).toBe("default");
    expect(recipe.stages).toEqual(resolveRecipe("coding").stages);
    expect((recipe.stages.CODE_REVIEW as Record<string, unknown>).maxReviewRounds).toBe(12);
  });

  it("records a pinned level with its provenance", () => {
    expect(resolveRecipe("coding", { reviewEffort: "light", reviewEffortSource: "start-call" }).reviewEffort)
      .toMatchObject({ level: "light", source: "start-call" });
    expect(resolveRecipe("coding", { reviewEffort: "thorough" }).reviewEffort)
      .toMatchObject({ level: "thorough", source: "project" });
  });

  it("fails a malformed pin closed to standard rather than to size mapping", () => {
    // Reading a typo as "no pin" would hand a low-risk chore to light, which
    // is LESS review than the project gets today.
    expect(resolveRecipe("coding", { reviewEffort: "quick" }).reviewEffort.level).toBe("standard");
    // A config that literally contains `"reviewEffort": null` is the same case.
    expect(resolveRecipe("coding", { reviewEffort: null as unknown as string }).reviewEffort.level)
      .toBe("standard");
    expect(resolveRecipe("coding").reviewEffort.level).toBe("size-mapped");
  });

  it("reports provenance from presence, so a typo is not disguised as no override", () => {
    // Both fall closed to standard; only one of them is the project's own doing,
    // and the disclosure has to be able to tell a reader which.
    expect(resolveRecipe("coding", { reviewEffort: "quick" }).reviewEffort.source).toBe("project");
    expect(resolveRecipe("coding").reviewEffort.source).toBe("default");
  });

  it("distinguishes a project-set knob from the identical recipe-shipped one", () => {
    // coding.json ships maxReviewRounds: 12. After the merge that is
    // indistinguishable from a project setting 12, which is why provenance is
    // recorded separately: the dial may supersede one and never the other.
    expect(resolveRecipe("coding").reviewEffort.explicitKnobs.codeReviewMaxRounds).toBe(false);
    expect(resolveRecipe("coding", { stages: { CODE_REVIEW: { maxReviewRounds: 12 } } })
      .reviewEffort.explicitKnobs.codeReviewMaxRounds).toBe(true);
    expect(resolveRecipe("coding", { stages: { PLAN_REVIEW: { backends: ["codex"] } } })
      .reviewEffort.explicitKnobs).toMatchObject({ planReviewBackends: true, codeReviewBackends: false });
  });
});

describe("state machine edges for reviewEffort off", () => {
  it("lets PLAN reach the stage after a skipped PLAN_REVIEW", () => {
    expect(isValidTransition("PLAN", "IMPLEMENT")).toBe(true);
    expect(isValidTransition("PLAN", "WRITE_TESTS")).toBe(true);
  });

  it("lets IMPLEMENT and TEST reach every stage that can follow a skipped CODE_REVIEW", () => {
    for (const from of ["IMPLEMENT", "TEST"] as const) {
      for (const to of ["VERIFY", "BUILD", "FINALIZE"] as const) {
        expect(isValidTransition(from, to), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it("negative: the table was widened additively, not loosened", () => {
    // If validation had simply been relaxed, these would pass too and the
    // positives above would prove nothing.
    expect(isValidTransition("PLAN", "COMPLETE")).toBe(false);
    expect(isValidTransition("PLAN", "FINALIZE")).toBe(false);
    expect(isValidTransition("TEST", "COMPLETE")).toBe(false);
    expect(isValidTransition("IMPLEMENT", "PLAN")).toBe(false);
    expect(isValidTransition("VERIFY", "PICK_TICKET")).toBe(false);
  });
});

describe("review stage skip()", () => {
  let testRoot: string;
  let sessionDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-effort-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  const ctxWith = (
    state: Partial<FullSessionState>,
    pipeline: string[] = ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    stages: Record<string, Record<string, unknown>> = {},
  ) => new StageContext(testRoot, sessionDir, makeState(state), makeRecipe(pipeline, stages));

  it("runs both review stages when the dial is untouched", () => {
    const ctx = ctxWith({});
    expect(new PlanReviewStage().skip(ctx)).toBe(false);
    expect(new CodeReviewStage().skip(ctx)).toBe(false);
  });

  it("runs both at every level except off", () => {
    for (const level of ["light", "standard", "thorough"] as const) {
      const ctx = ctxWith({ currentReviewEffort: level } as Partial<FullSessionState>);
      expect(new PlanReviewStage().skip(ctx), level).toBe(false);
      expect(new CodeReviewStage().skip(ctx), level).toBe(false);
    }
  });

  it("skips both at off", () => {
    const ctx = ctxWith({ currentReviewEffort: "off" } as Partial<FullSessionState>);
    expect(new PlanReviewStage().skip(ctx)).toBe(true);
    expect(new CodeReviewStage().skip(ctx)).toBe(true);
  });

  it("still runs the stage a tiered mode exists to produce", () => {
    const planMode = ctxWith({ currentReviewEffort: "off", mode: "plan" } as Partial<FullSessionState>);
    expect(new PlanReviewStage().skip(planMode)).toBe(false);
    expect(new CodeReviewStage().skip(planMode)).toBe(true);

    const reviewMode = ctxWith({ currentReviewEffort: "off", mode: "review" } as Partial<FullSessionState>);
    expect(new CodeReviewStage().skip(reviewMode)).toBe(false);
    expect(new PlanReviewStage().skip(reviewMode)).toBe(true);
  });

  it("honors a session pin for modes that never reach PICK_TICKET", () => {
    const ctx = ctxWith({
      resolvedReviewEffort: { level: "off", source: "start-call", explicitKnobs: { codeReviewMaxRounds: false, planReviewBackends: false, codeReviewBackends: false } },
    } as Partial<FullSessionState>);
    expect(new CodeReviewStage().skip(ctx)).toBe(true);
  });

  describe("walker traversal at off, across optional-stage combinations", () => {
    // The pipelines resolveRecipe can actually produce, since WRITE_TESTS,
    // TEST, VERIFY and BUILD are each independently insertable. A skipped
    // review stage must land on the first surviving stage in each.
    // Each optional stage carries its OWN skip() driven by stage config, so a
    // realistic combo has to enable it there as well as place it in the
    // pipeline -- which is exactly what resolveRecipe does.
    const WT = { WRITE_TESTS: { enabled: true, command: "npm test" } };
    const TS = { TEST: { enabled: true, command: "npm test" } };
    const VF = { VERIFY: { enabled: true, startCommand: "npm run dev", readinessUrl: "http://localhost:3000", endpoints: [] } };
    const BD = { BUILD: { enabled: true, command: "npm run build" } };

    const combos: [string, string[], Record<string, Record<string, unknown>>, string, string][] = [
      ["bare", ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"], {}, "PLAN", "IMPLEMENT"],
      ["write-tests", ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "WRITE_TESTS", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"], WT, "PLAN", "WRITE_TESTS"],
      ["test", ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "TEST", "CODE_REVIEW", "FINALIZE", "COMPLETE"], TS, "TEST", "FINALIZE"],
      ["verify", ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "VERIFY", "FINALIZE", "COMPLETE"], VF, "IMPLEMENT", "VERIFY"],
      ["build", ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "BUILD", "FINALIZE", "COMPLETE"], BD, "IMPLEMENT", "BUILD"],
      ["verify+build", ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "VERIFY", "BUILD", "FINALIZE", "COMPLETE"], { ...VF, ...BD }, "IMPLEMENT", "VERIFY"],
      ["all", ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "WRITE_TESTS", "IMPLEMENT", "TEST", "CODE_REVIEW", "VERIFY", "BUILD", "FINALIZE", "COMPLETE"], { ...WT, ...TS, ...VF, ...BD }, "TEST", "VERIFY"],
    ];

    for (const [label, pipeline, stages, from, expected] of combos) {
      it(`${label}: ${from} advances to ${expected} and the edge exists`, () => {
        const ctx = ctxWith({ currentReviewEffort: "off" } as Partial<FullSessionState>, pipeline, stages);
        const next = findNextStage(pipeline, from, ctx);
        expect(next.kind).toBe("found");
        expect(next.kind === "found" && next.stage.id).toBe(expected);
        // findNextStage picking a target is not enough: processAdvance asserts
        // the transition, so a missing edge throws instead of advancing.
        expect(isValidTransition(from as never, expected as never), `${from} -> ${expected}`).toBe(true);
      });
    }

    it("keeps the review stages in the walk at standard", () => {
      const pipeline = ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"];
      const ctx = ctxWith({ currentReviewEffort: "standard" } as Partial<FullSessionState>, pipeline);
      const next = findNextStage(pipeline, "PLAN", ctx);
      expect(next.kind === "found" && next.stage.id).toBe("PLAN_REVIEW");
    });
  });
});

/**
 * T-461 / T-328 doctrine: a dial field must never cost someone their session.
 *
 * SessionStateSchema gates persisted session READS. An enum there does not drop
 * a corrupt value, it fails the parse and makes the whole session unreadable, so
 * the resume dies instead of falling back to standard. These pin that the two
 * persisted dial fields stay permissive and that the fail-closed normalization
 * happens on read instead.
 */
describe("persisted dial fields survive corruption", () => {
  const persisted = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    sessionId: "00000000-0000-4000-8000-000000000461",
    recipe: "coding",
    state: "PICK_TICKET",
    revision: 1,
    status: "active",
    mode: "auto",
    lease: {
      workspaceId: "ws",
      lastHeartbeat: "2026-08-12T00:00:00.000Z",
      expiresAt: "2026-08-12T01:00:00.000Z",
    },
    lastGuideCall: "2026-08-12T00:00:00.000Z",
    startedAt: "2026-08-12T00:00:00.000Z",
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ...extra,
  });

  // Not just a wrong STRING: a hand-edit or a partial write puts whole wrong
  // TYPES in these fields, and forgiveNull alone admits null while still
  // failing the parse on a number or an object.
  it.each([
    ["an unrecognized string", "corrupt"],
    ["a number", 7],
    ["a boolean", true],
    ["an array", []],
    ["an object", {}],
  ])("still reads a session whose currentReviewEffort is %s", (_label, value) => {
    const parsed = SessionStateSchema.safeParse(persisted({ currentReviewEffort: value }));
    // The brick case: rejection here does not lose one field, it strands the
    // session. Losing a review level must never cost more than review depth.
    expect(parsed.success, "SessionStateSchema rejected a corrupt currentReviewEffort").toBe(true);
    if (parsed.success) {
      expect(effectiveReviewEffort(parsed.data as never, "CODE_REVIEW")).toBe("standard");
    }
  });

  it.each([
    ["an unrecognized string", "corrupt"],
    ["a number", 7],
    ["an object", {}],
  ])("still reads a session whose currentReviewEffortSource is %s", (_label, value) => {
    const parsed = SessionStateSchema.safeParse(persisted({
      currentReviewEffort: "light",
      currentReviewEffortSource: value,
    }));
    expect(parsed.success, "SessionStateSchema rejected a corrupt currentReviewEffortSource").toBe(true);
    if (parsed.success) {
      // The LEVEL is undamaged and must survive; only the provenance is lost.
      expect(effectiveReviewEffort(parsed.data as never, "CODE_REVIEW")).toBe("light");
      expect(normalizeReviewEffortSource(parsed.data.currentReviewEffortSource)).toBe("unknown");
    }
  });

  it("still reads a session whose ticket.type was corrupted, and does not size-map it down", () => {
    // ticket.type is a field this ticket ADDED, for size mapping. A non-string
    // must cost the mapping, not the session.
    const parsed = SessionStateSchema.safeParse(persisted({
      ticket: { id: "T-1", title: "x", claimed: true, type: 7 },
      // The marker is REQUIRED for this assertion to mean anything. Without it
      // the session reads as pre-dial and pins standard, so the last expect
      // below would pass no matter what the corrupt type did -- it would prove
      // the parse and nothing else.
      resolvedReviewEffort: { level: "size-mapped", source: "default" },
    }));
    expect(parsed.success, "SessionStateSchema rejected a corrupt ticket.type").toBe(true);
    if (parsed.success) {
      expect(parsed.data.ticket?.type).toBeUndefined();
      // Size mapping is genuinely live here: a real chore would resolve light.
      expect(reviewEffortForTicket({ type: "chore" }, sessionEffortFromState(parsed.data as never)).level)
        .toBe("light");
      // And the corrupt type is not "chore", so that item stays on standard.
      expect(reviewEffortForTicket({ ...parsed.data.ticket }, sessionEffortFromState(parsed.data as never)).level)
        .toBe("standard");
    }
  });

  it("keeps a resolvedIssuesMeta row whose dial fields are corrupted", () => {
    const parsed = SessionStateSchema.safeParse(persisted({
      resolvedIssuesMeta: [{ id: "ISS-1", reviewEffort: 7, source: {} }],
    }));
    expect(parsed.success, "SessionStateSchema rejected a corrupt resolvedIssuesMeta entry").toBe(true);
    // The row survives with its id: only the unreadable members are dropped.
    if (parsed.success) expect(parsed.data.resolvedIssuesMeta?.[0]?.id).toBe("ISS-1");
  });

  it.each([
    ["a non-array", {}],
    ["a string", "corrupt"],
    ["an entry whose id is not a string", [{ id: 7, reviewEffort: "standard", source: "default" }]],
  ])("discards resolvedIssuesMeta rather than stranding the session when it is %s", (_label, value) => {
    // This field is pure audit. Nothing resumes work from it, so damage to it
    // must cost the disclosure and never the session.
    const parsed = SessionStateSchema.safeParse(persisted({ resolvedIssuesMeta: value }));
    expect(parsed.success, "SessionStateSchema rejected a damaged audit array").toBe(true);
    if (parsed.success) expect(parsed.data.resolvedIssuesMeta).toEqual([]);
  });

  it("normalizes the corrupt value to standard at read time", () => {
    expect(effectiveReviewEffort({ currentReviewEffort: "corrupt" }, "CODE_REVIEW")).toBe("standard");
    expect(effectiveReviewEffort({ currentReviewEffort: "corrupt" }, "PLAN_REVIEW")).toBe("standard");
    // A real level is still honored, so the guard did not flatten everything.
    expect(effectiveReviewEffort({ currentReviewEffort: "off" }, "CODE_REVIEW")).toBe("off");
  });

  it("still reads a session whose resolvedReviewEffort marker was corrupted", () => {
    const parsed = SessionStateSchema.safeParse(persisted({
      resolvedReviewEffort: { level: "nonsense", source: "corrupt" },
    }));
    expect(parsed.success, "SessionStateSchema rejected a corrupt resolvedReviewEffort").toBe(true);
    if (parsed.success) {
      expect(effectiveReviewEffort(parsed.data as never, "CODE_REVIEW")).toBe("standard");
    }
  });

  // Every shape below reaches the fail-closed logic ONLY if the parse admits it
  // first. Two valid strings in a marker cannot prove that, which is why these
  // damage the record in the ways a hand-edit or a partial write actually
  // produces: fields gone, fields nulled, the knobs object the wrong type.
  it.each([
    ["marker with both fields missing", {}],
    ["marker with nulled fields", { level: null, source: null }],
    ["marker missing only its level", { source: "project" }],
    // The CONTAINER, not just its fields: permissive fields inside a strict
    // object still brick the session when the marker itself is damaged.
    ["marker damaged into a string", "corrupt"],
    ["marker damaged into an array", []],
    ["marker damaged into a number", 7],
  ])("recovers a session whose %s to standard", (_label, marker) => {
    const parsed = SessionStateSchema.safeParse(persisted({ resolvedReviewEffort: marker }));
    expect(parsed.success, "SessionStateSchema rejected a damaged marker instead of recovering").toBe(true);
    if (parsed.success) {
      // Recovery, not merely survival: the level is gone, so the item gets
      // today's review rather than dropping to a cheaper one.
      expect(effectiveReviewEffort(parsed.data as never, "CODE_REVIEW")).toBe("standard");
      expect(sessionEffortFromState(parsed.data as never).level).toBe("standard");
      expect(reviewEffortForTicket({ type: "chore" }, sessionEffortFromState(parsed.data as never)).level)
        .toBe("standard");
    }
  });

  it.each([
    ["a non-object explicitKnobs", { level: "light", source: "project", explicitKnobs: "corrupt" }],
    ["nulled knobs", { level: "light", source: "project", explicitKnobs: { codeReviewMaxRounds: null } }],
    ["a missing explicitKnobs", { level: "light", source: "project" }],
  ])("keeps the pinned level when only the knobs are damaged: %s", (_label, marker) => {
    // Damage confined to the knobs must not move the LEVEL. Forcing standard
    // here would be the mirror failure of the one above: it would silently
    // override a level the project deliberately chose.
    const parsed = SessionStateSchema.safeParse(persisted({ resolvedReviewEffort: marker }));
    expect(parsed.success, "SessionStateSchema rejected damaged knobs instead of recovering").toBe(true);
    if (parsed.success) {
      expect(sessionEffortFromState(parsed.data as never))
        .toEqual({ level: "light", source: "project" });
      // Knobs read as absent, which is the safe default: nothing is treated as
      // explicitly project-set, so the dial may still supersede recipe values.
      const knobs = parsed.data.resolvedReviewEffort?.explicitKnobs;
      expect(knobs?.codeReviewMaxRounds ?? false).toBe(false);
    }
  });

  it("reads a null marker as damaged rather than as a pre-dial session", () => {
    const parsed = SessionStateSchema.safeParse(persisted({ resolvedReviewEffort: null }));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(sessionEffortFromState(parsed.data as never))
        .toEqual({ level: "standard", source: "unknown" });
    }
    // Absence, by contrast, is the genuine legacy session.
    const absent = SessionStateSchema.safeParse(persisted({}));
    expect(absent.success).toBe(true);
    if (absent.success) {
      expect(sessionEffortFromState(absent.data as never))
        .toEqual({ level: "standard", source: "legacy" });
    }
  });
});

/**
 * T-461 phase 3: the CODE_REVIEW cap.
 *
 * The reason this is ONE function rather than two call sites is the desync it
 * prevents. The stage routes on this number; the diagnostics derive
 * `atOrPastCap`, the non-converging gate, the landable gate, the
 * `scope_expanded` threshold, and the figure a person reads in the health model
 * and the session report. If only the stage had become effort-aware, a light
 * session would route on 4 while every one of those still reported 12.
 */
describe("dialCodeReviewMaxRounds", () => {
  const marker = (explicit: boolean) => ({
    level: "size-mapped", source: "default",
    explicitKnobs: { codeReviewMaxRounds: explicit, planReviewBackends: false, codeReviewBackends: false },
  });

  it("keeps the configured cap at standard, which is the anchor", () => {
    expect(dialCodeReviewMaxRounds({ resolvedReviewEffort: marker(false) }, {}, "low")).toBe(12);
    expect(dialCodeReviewMaxRounds({ currentReviewEffort: "standard", resolvedReviewEffort: marker(false) }, {}, "low"))
      .toBe(12);
  });

  it("lowers the cap at light", () => {
    expect(dialCodeReviewMaxRounds({ currentReviewEffort: "light", resolvedReviewEffort: marker(false) }, {}, "low"))
      .toBe(4);
  });

  it("never lets the light cap starve a risky item below its minimum", () => {
    // requiredRounds(high) is 3, under the light cap of 4, so the clamp is not
    // what decides here -- but a configured cap of 1 must still be lifted.
    expect(dialCodeReviewMaxRounds(
      { currentReviewEffort: "light", resolvedReviewEffort: marker(false) },
      { CODE_REVIEW: { maxReviewRounds: 1 } },
      "high",
    )).toBe(3);
  });

  it("lets an explicitly project-set cap beat the dial", () => {
    // The project said 8. light must not quietly cut it to 4.
    expect(dialCodeReviewMaxRounds(
      { currentReviewEffort: "light", resolvedReviewEffort: marker(true) },
      { CODE_REVIEW: { maxReviewRounds: 8 } },
      "low",
    )).toBe(8);
    // Same number, but recipe-shipped rather than project-set: the dial may
    // supersede this one. That distinction is the whole point of explicitKnobs.
    expect(dialCodeReviewMaxRounds(
      { currentReviewEffort: "light", resolvedReviewEffort: marker(false) },
      { CODE_REVIEW: { maxReviewRounds: 8 } },
      "low",
    )).toBe(4);
  });

  it("keeps 0 meaning unlimited at every level", () => {
    for (const level of ["off", "light", "standard", "thorough"]) {
      expect(dialCodeReviewMaxRounds(
        { currentReviewEffort: level, resolvedReviewEffort: marker(false) },
        { CODE_REVIEW: { maxReviewRounds: 0 } },
        "high",
      ), `level=${level}`).toBe(0);
    }
  });

  /**
   * The light landing guard, from the diagnostics side.
   *
   * The stage spends the round after the light cap on the fix. The diagnostics
   * derive `atOrPastCap` from the same number, and if only the stage had learned
   * about the grace round, every light session would spend that round being
   * reported as landable-but-stuck while doing exactly what it was told.
   */
  const lightLoopState = (rounds: number) => ({
    ...makeState({ currentReviewEffort: "light", state: "IMPLEMENT" } as Partial<FullSessionState>),
    resolvedReviewEffort: marker(false),
    resolvedStages: {},
    reviews: {
      plan: [],
      code: Array.from({ length: rounds }, (_, i) => ({
        round: i + 1, reviewer: "agent", verdict: "revise",
        findingCount: 1, criticalCount: 0, unresolvedCriticalCount: 0,
        majorCount: 1, suggestionCount: 0, timestamp: new Date().toISOString(),
      })),
    },
  } as unknown as FullSessionState);

  it("does not report a session mid-grace-round as landable but stuck", () => {
    const codes = (rounds: number) =>
      analyzeSessionDiagnostics(lightLoopState(rounds), { events: [] }).diagnostics.map((d) => d.code);

    // Round 4 IS the light cap, and the stage has just routed it to IMPLEMENT
    // for its fix. Nothing is stuck.
    expect(codes(4)).toEqual([]);
    // Round 5 is the grace round: past the landing floor, still uncommitted, so
    // both warnings are due. This is the positive control -- without it the
    // assertion above would also pass on a build where these never fire.
    expect(codes(5)).toEqual(["code_review_non_converging", "landable_uncommitted"]);
  });

  it("keeps standard warning at its cap, since standard is the anchor", () => {
    const state = {
      ...lightLoopState(12),
      currentReviewEffort: "standard",
    } as FullSessionState;
    expect(analyzeSessionDiagnostics(state, { events: [] }).diagnostics.map((d) => d.code))
      .toEqual(["code_review_non_converging", "landable_uncommitted"]);
  });

  it("reports the same cap to the diagnostics that the stage routes on", () => {
    // The desync guard. These two must never be computed independently again.
    const state = {
      ...makeState({ currentReviewEffort: "light" } as Partial<FullSessionState>),
      resolvedReviewEffort: marker(false),
      resolvedStages: {},
    } as unknown as FullSessionState;
    const summary = analyzeSessionDiagnostics(state, { events: [] });
    expect(summary.maxReviewRounds).toBe(4);
    expect(summary.maxReviewRounds)
      .toBe(dialCodeReviewMaxRounds(state, state.resolvedStages, state.ticket?.risk));
  });
});
