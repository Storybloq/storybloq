/**
 * TEST and VERIFY refuse a report against positively-stale artifacts, and
 * fail open on everything unestablished (ISS-912).
 *
 * The probe runs BEFORE result parsing in both stages: a stale pass attests
 * to code that is not in the tree, and a stale fail sends IMPLEMENT chasing
 * phantom failures, so neither direction of the report is trustworthy.
 * The retry is bounded and the exhaustion path proceeds visibly -- the gate
 * never hard-blocks a project whose builder legitimately leaves old mtimes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe, isStageAdvance } from "../../../src/autonomous/stages/types.js";
import { TestStage } from "../../../src/autonomous/stages/test.js";
import { VerifyStage } from "../../../src/autonomous/stages/verify.js";
import { MAX_FRESHNESS_RETRIES } from "../../../src/autonomous/artifact-freshness.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { SessionStateSchema } from "../../../src/autonomous/session-types.js";
import { createSession } from "../../../src/autonomous/session.js";
import { readFileSync } from "node:fs";

const OLD = new Date(Date.now() - 120_000);
const NEW = new Date(Date.now() - 10_000);

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "storybloq-freshness-gate-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
});
afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function plant(rel: string, mtime: Date): void {
  const path = join(testRoot, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  utimesSync(path, mtime, mtime);
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "TEST", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

const FRESHNESS = { sourceGlobs: ["src/**"], outputGlobs: ["dist/**"] };

function makeRecipe(overrides: Partial<Record<string, Record<string, unknown>>> = {}): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "TEST", "CODE_REVIEW", "VERIFY", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {
      TEST: { enabled: true, command: "npm test", freshness: FRESHNESS },
      VERIFY: { enabled: true, endpoints: ["GET /api/x"] },
      ...overrides,
    },
    dirtyFileHandling: "block",
    branchStrategy: "current",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  } as ResolvedRecipe;
}

describe("TEST stage freshness gate", () => {
  const stage = new TestStage();

  it("refuses a green report against stale artifacts with a rebuild instruction, bounded", async () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", OLD);
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "tests_run", notes: "exit code: 0, all pass" });
    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("Stale Build Artifacts");
      expect(advance.instruction).toContain("npm run build");
      expect(advance.instruction).toContain("src/a.ts");
    }
    expect(ctx.state.testFreshnessRetryCount).toBe(1);
  });

  it("a stale FAIL is refused too -- phantom failures must not reach IMPLEMENT", async () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", OLD);
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "tests_run", notes: "exit code: 1, 3 fail" });
    expect(advance.action).toBe("retry");
  });

  it("exhaustion fails open on the pass path with a visible waiver, and resets the counter", async () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", OLD);
    const ctx = new StageContext(
      testRoot, sessionDir,
      makeState({ testFreshnessRetryCount: MAX_FRESHNESS_RETRIES } as Partial<FullSessionState>),
      makeRecipe(),
    );

    const advance = await stage.report(ctx, { completedAction: "tests_run", notes: "exit code: 0" });
    expect(advance.action).toBe("advance");
    if (advance.action === "advance" && "result" in advance) {
      expect(advance.result.instruction).toContain("Freshness NOT Established");
    } else {
      throw new Error("expected annotated advance");
    }
    expect(ctx.state.testFreshnessRetryCount).toBe(0);
  });

  it("fresh artifacts pass straight through untouched", async () => {
    plant("src/a.ts", OLD);
    plant("dist/a.js", NEW);
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "tests_run", notes: "exit code: 0" });
    expect(advance).toEqual({ action: "advance" });
  });

  it("unestablished (no build outputs) fails open AND clears prior retry debt -- a later stale report starts at attempt 1", async () => {
    plant("src/a.ts", NEW);
    // Debt from an earlier stale rejection in this session.
    const ctx = new StageContext(
      testRoot, sessionDir,
      makeState({ testFreshnessRetryCount: 1 } as Partial<FullSessionState>),
      makeRecipe(),
    );

    // No dist yet: unestablished, accepted, debt cleared.
    const accepted = await stage.report(ctx, { completedAction: "tests_run", notes: "exit code: 0" });
    expect(accepted).toEqual({ action: "advance" });
    expect(ctx.state.testFreshnessRetryCount).toBe(0);

    // Outputs appear stale later: the bound restarts at attempt 1, not 2.
    plant("dist/a.js", OLD);
    const rejected = await stage.report(ctx, { completedAction: "tests_run", notes: "exit code: 0" });
    expect(rejected.action).toBe("retry");
    if (rejected.action === "retry") {
      expect(rejected.instruction).toContain(`attempt 1/${MAX_FRESHNESS_RETRIES}`);
    }
    expect(ctx.state.testFreshnessRetryCount).toBe(1);
  });

  it("a config that no longer resolves also clears retry debt", async () => {
    const ctx = new StageContext(
      testRoot, sessionDir,
      makeState({ testFreshnessRetryCount: MAX_FRESHNESS_RETRIES } as Partial<FullSessionState>),
      makeRecipe({ TEST: { enabled: true, command: "npm test" } }),
    );
    const advance = await stage.report(ctx, { completedAction: "tests_run", notes: "exit code: 0" });
    expect(advance).toEqual({ action: "advance" });
    expect(ctx.state.testFreshnessRetryCount).toBe(0);
  });

  it("enter() names what the probe will and will not check", async () => {
    const active = await stage.enter(new StageContext(testRoot, sessionDir, makeState(), makeRecipe()));
    expect(isStageAdvance(active)).toBe(false);
    if (!isStageAdvance(active)) expect(active.instruction).toContain("Artifact freshness: checked");

    const inactive = await stage.enter(new StageContext(
      testRoot, sessionDir, makeState(),
      makeRecipe({ TEST: { enabled: true, command: "npm test" } }),
    ));
    if (!isStageAdvance(inactive)) expect(inactive.instruction).toContain("Artifact freshness: not checked");
  });
});

describe("VERIFY stage freshness gate", () => {
  const stage = new VerifyStage();

  it("probes BEFORE result parsing -- stale artifacts with unparseable notes still get the rebuild instruction", async () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", OLD);
    const ctx = new StageContext(
      testRoot, sessionDir,
      makeState({ state: "VERIFY" } as Partial<FullSessionState>),
      makeRecipe(),
    );

    const advance = await stage.report(ctx, { completedAction: "verify_done", notes: "not json at all" });
    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("Stale Build Artifacts");
      expect(advance.instruction).toContain("re-curl");
    }
    expect(ctx.state.verifyFreshnessRetryCount).toBe(1);
  });

  it("exhaustion fails open with a visible waiver on valid results, and resets the counter", async () => {
    plant("src/a.ts", NEW);
    plant("dist/a.js", OLD);
    const ctx = new StageContext(
      testRoot, sessionDir,
      makeState({ state: "VERIFY", verifyFreshnessRetryCount: MAX_FRESHNESS_RETRIES } as Partial<FullSessionState>),
      makeRecipe(),
    );

    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([{ endpoint: "GET /api/x", status: 200 }]),
    });
    expect(advance.action).toBe("advance");
    if (advance.action === "advance" && "result" in advance) {
      expect(advance.result.instruction).toContain("Freshness NOT Established");
    } else {
      throw new Error("expected annotated advance");
    }
    expect(ctx.state.verifyFreshnessRetryCount).toBe(0);
  });

  it("an unestablished probe clears VERIFY retry debt too", async () => {
    plant("src/a.ts", NEW);
    const ctx = new StageContext(
      testRoot, sessionDir,
      makeState({ state: "VERIFY", verifyFreshnessRetryCount: 1 } as Partial<FullSessionState>),
      makeRecipe(),
    );
    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([{ endpoint: "GET /api/x", status: 200 }]),
    });
    expect(advance).toEqual({ action: "advance" });
    expect(ctx.state.verifyFreshnessRetryCount).toBe(0);
  });

  it("falls back to the TEST stage's freshness block and passes fresh results through", async () => {
    plant("src/a.ts", OLD);
    plant("dist/a.js", NEW);
    const ctx = new StageContext(
      testRoot, sessionDir,
      makeState({ state: "VERIFY" } as Partial<FullSessionState>),
      makeRecipe(),
    );

    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([{ endpoint: "GET /api/x", status: 200 }]),
    });
    expect(advance).toEqual({ action: "advance" });
  });
});

describe("freshness counters are schema-bounded (nonnegative integers)", () => {
  /** A real, schema-valid state to mutate -- hand-built fixtures drift. */
  function realState(): Record<string, unknown> {
    const s = createSession(testRoot, "default", "ws-1");
    return JSON.parse(
      readFileSync(join(testRoot, ".story", "sessions", s.sessionId, "state.json"), "utf-8"),
    ) as Record<string, unknown>;
  }

  it("a negative counter fails the parse loudly instead of weakening the bound", () => {
    // A negative value satisfies `retries < MAX` forever, turning the bounded
    // fail-open gate into a hard block -- damage, not skew, so it names itself.
    const r = SessionStateSchema.safeParse({ ...realState(), testFreshnessRetryCount: -5 });
    expect(r.success).toBe(false);
    const v = SessionStateSchema.safeParse({ ...realState(), verifyFreshnessRetryCount: -1 });
    expect(v.success).toBe(false);
  });

  it("a fractional counter fails the parse", () => {
    const r = SessionStateSchema.safeParse({ ...realState(), testFreshnessRetryCount: 1.5 });
    expect(r.success).toBe(false);
  });

  it("valid values parse, and absence defaults to 0", () => {
    const base = realState();
    delete (base as Record<string, unknown>).testFreshnessRetryCount;
    const r = SessionStateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.testFreshnessRetryCount).toBe(0);
    const v = SessionStateSchema.safeParse({ ...realState(), verifyFreshnessRetryCount: 2 });
    expect(v.success).toBe(true);
  });
});
