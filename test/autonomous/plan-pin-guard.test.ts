/**
 * T-494 scope 3: the plan-pin guard, at all THREE acceptance points.
 *
 * The rule under test is stated on what the guard gates, not on where a file
 * happens to be written: it runs before ANY path that accepts a plan, whether
 * that path pins it, completes on it, or both. An earlier revision of this
 * design anchored the guard to the snapshot writes and claimed that covered
 * every case. It did not. The landing branch's plan-only completion finalizes
 * and returns BEFORE any snapshot, so an ungated plan-only session would have
 * ended having accepted a plan that never met a guard. That case is site B
 * below, and it is the reason this file drives whole stage reports rather than
 * only the helper.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../src/autonomous/stages/plan-review.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleRulingCreate, handleRulingSupersede } from "../../src/cli/commands/ruling.js";
import { guardPlanNamesCitedRulings } from "../../src/autonomous/plan-pin-guard.js";
import * as planPinGuardModule from "../../src/autonomous/plan-pin-guard.js";
import { writeRulingUnlocked } from "../../src/core/ruling-loader.js";
import { makeRuling } from "../core/test-factories.js";

const CALLER = "test-task";
const stage = new PlanReviewStage();
const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function newProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t494-pin-guard-"));
  tempDirs.push(root);
  await initProject(root, { name: "test" });
  await handleTicketCreate(
    { title: "Cited ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "md",
    root,
  );
  return root;
}

/** Creates a ruling and attaches the citation to T-001. Returns its id. */
async function cite(root: string, text: string): Promise<string> {
  const result = await handleRulingCreate(
    { text, attribution: "owner-direct", date: "2026-09-06", scopeTags: [], cites: ["T-001"], clientTaskId: CALLER },
    "json",
    root,
  );
  return JSON.parse(result.output).data.id as string;
}

function sessionDirIn(root: string, plan: string): string {
  const dir = join(root, ".story", "sessions", "test-session");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plan.md"), plan);
  return dir;
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000494",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", title: "Cited ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

/** A clean approve, the report shape that reaches the landing branch. */
const APPROVE = { completedAction: "plan_review_round", verdict: "approve", findings: [] } as const;

/** Approved-plan snapshots land beside plan.md as `plan-approved-<sha>.md`. */
function snapshotCount(sessionDir: string): number {
  return existsSync(sessionDir)
    ? readdirSync(sessionDir).filter((f) => f.startsWith("plan-approved-")).length
    : 0;
}

describe("the guard's table, per citation status", () => {
  it("passes an item that cites nothing, with no message at all", async () => {
    const root = await newProject();
    const verdict = await guardPlanNamesCitedRulings(root, "T-001", "# Plan\n\nNo rulings here.");
    expect(verdict).toEqual({ ok: true });
  });

  it("requires the CURRENT id, and names the id it is missing", async () => {
    const root = await newProject();
    const id = await cite(root, "Rulings reach agents by citation, not by paste.");

    const missing = await guardPlanNamesCitedRulings(root, "T-001", "# Plan\n\nDo the thing.");
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.instruction).toContain(id);

    const named = await guardPlanNamesCitedRulings(root, "T-001", `# Plan\n\nPer ${id}, do the thing.`);
    expect(named).toEqual({ ok: true });
  });

  it("on a STALE citation, demands the successor and names what it supersedes", async () => {
    const root = await newProject();
    const oldId = await cite(root, "The original decision.");
    const superseded = await handleRulingSupersede(
      oldId,
      { text: "The decision that replaced it.", attribution: "owner-direct", date: "2026-09-06", clientTaskId: CALLER },
      "json",
      root,
    );
    const newId = JSON.parse(superseded.output).data.id as string;

    // The item still cites the OLD id -- that is what makes it stale -- so a
    // plan naming only what the item cites must NOT pass. `current` is the id
    // the renderer actually showed the agent, and the current ruling binds.
    const onlyOld = await guardPlanNamesCitedRulings(root, "T-001", `# Plan\n\nPer ${oldId}, do the thing.`);
    expect(onlyOld.ok).toBe(false);
    expect(onlyOld.ok === false && onlyOld.instruction).toContain(newId);
    expect(onlyOld.ok === false && onlyOld.instruction).toContain(oldId);

    expect(await guardPlanNamesCitedRulings(root, "T-001", `# Plan\n\nPer ${newId}.`)).toEqual({ ok: true });
  });

  it("REFUSES a citation that is missing from the ledger", async () => {
    const root = await newProject();
    const id = await cite(root, "About to be deleted.");
    rmSync(join(root, ".story", "rulings", `${id}.json`));

    const verdict = await guardPlanNamesCitedRulings(root, "T-001", `# Plan\n\nPer ${id}.`);
    // Naming the id does NOT rescue it: a forward reference is a legal
    // transient state for the ledger and never for a pin.
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.instruction).toContain("missing from the ledger");
  });

  it("REFUSES a branch, naming the competing successors", async () => {
    const root = await newProject();
    const oldId = await cite(root, "The contested decision.");
    // Two rulings both claiming to supersede the same predecessor. Written
    // directly because `ruling supersede` refuses to create this state.
    for (const suffix of ["a", "b"]) {
      const rival = makeRuling({
        id: `r-000000000000000${suffix === "a" ? 1 : 2}`,
        text: `Rival ${suffix}.`,
        supersedes: oldId,
      });
      await writeRulingUnlocked(rival, root);
    }
    const verdict = await guardPlanNamesCitedRulings(root, "T-001", `# Plan\n\nPer ${oldId}.`);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.instruction).toContain("competing successors");
  });

  it("REFUSES a supersede CYCLE, naming the chain", async () => {
    const root = await newProject();
    const citedId = await cite(root, "The cited decision.");
    // Two rulings superseding each other, with the cited one inside the loop.
    // Written directly: `ruling supersede` will not create this state.
    const other = "r-000000000000cyc1";
    await writeRulingUnlocked(makeRuling({ id: other, supersedes: citedId }), root);
    const cited = JSON.parse(readFileSync(join(root, ".story", "rulings", `${citedId}.json`), "utf-8"));
    await writeRulingUnlocked({ ...cited, supersedes: other }, root);

    const verdict = await guardPlanNamesCitedRulings(root, "T-001", `# Plan\n\nPer ${citedId}.`);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.instruction).toContain("cycle");
  });

  it("REFUSES a citation whose record cannot be read", async () => {
    const root = await newProject();
    const id = await cite(root, "About to be corrupted.");
    writeFileSync(join(root, ".story", "rulings", `${id}.json`), "{ not json");

    const verdict = await guardPlanNamesCitedRulings(root, "T-001", `# Plan\n\nPer ${id}.`);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.instruction).toContain("could not be read");
  });

  it("FAILS CLOSED when the item itself cannot be resolved", async () => {
    const root = await newProject();
    const verdict = await guardPlanNamesCitedRulings(root, "T-404", "# Plan");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.instruction).toContain("Escalate");
  });

  it("passes an id-only mention, which is what this gate actually proves", async () => {
    // THE HONESTY TEST, and it asserts a WEAKNESS on purpose. An id in a plan
    // proves the id was mentioned, not that the ruling was read or followed:
    // a plan can copy ids straight out of the review packet's own truncation
    // markers and pass here. Pinned so no later reader mistakes this gate for
    // evidence of compliance. Substantive compliance is the review's job.
    const root = await newProject();
    const id = await cite(root, "A decision this plan will completely ignore.");
    expect(await guardPlanNamesCitedRulings(root, "T-001", id)).toEqual({ ok: true });
  });
});

describe("site C: the landing that pins a plan into IMPLEMENT", () => {
  it("refuses to land, and writes NO snapshot, when the plan omits a cited ruling", async () => {
    const root = await newProject();
    const id = await cite(root, "A decision the plan ignores.");
    const dir = sessionDirIn(root, "# Plan\n\nDo the thing.\n");
    const ctx = new StageContext(root, dir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, APPROVE);
    expect(advance.action).toBe("retry");
    expect((advance as { instruction: string }).instruction).toContain(id);
    // Nothing is written on a refusal: no pin exists for a plan that was
    // never accepted.
    expect(snapshotCount(dir)).toBe(0);
  });

  it("lands once the plan names it", async () => {
    const root = await newProject();
    const id = await cite(root, "A decision the plan honours.");
    const dir = sessionDirIn(root, `# Plan\n\nPer ${id}, do the thing.\n`);
    const ctx = new StageContext(root, dir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, APPROVE);
    expect(advance.action).toBe("advance");
    expect(snapshotCount(dir)).toBeGreaterThan(0);
  });
});

describe("site B: the plan-only completion, which writes no snapshot at all", () => {
  it("refuses to COMPLETE on a plan that omits a cited ruling", async () => {
    // THE CASE A SNAPSHOT-ANCHORED GUARD MISSES. This session finalizes and
    // returns before any snapshot is written, so a guard placed at the
    // snapshot never runs. With no snapshot, plan.md on disk IS the artifact
    // of record, and finalizing as `completed` blesses whatever it holds.
    const root = await newProject();
    const id = await cite(root, "A decision the plan ignores.");
    const dir = sessionDirIn(root, "# Plan\n\nDo the thing.\n");
    const ctx = new StageContext(root, dir, makeState({ mode: "plan" }), makeRecipe());

    const advance = await stage.report(ctx, APPROVE);
    expect(advance.action).toBe("retry");
    expect((advance as { instruction: string }).instruction).toContain(id);
    // The session did NOT end, which is the whole point: an unjudged plan
    // must not be blessed by a session completing on it.
    expect(ctx.state.status).toBe("active");
    expect(snapshotCount(dir)).toBe(0);
  });

  it("completes once the plan names it", async () => {
    const root = await newProject();
    const id = await cite(root, "A decision the plan honours.");
    const dir = sessionDirIn(root, `# Plan\n\nPer ${id}.\n`);
    const ctx = new StageContext(root, dir, makeState({ mode: "plan" }), makeRecipe());

    const advance = await stage.report(ctx, APPROVE);
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("SESSION_END");
  });
});

describe("a plan edited while its citations were being checked is refused, not accepted", () => {
  /**
   * The window ISS-1050 closed and T-494 reopens. The guard AWAITS -- it loads
   * the ledger and resolves the citation chain -- so the read that used to sit
   * immediately before the acceptance no longer does, and the comment that
   * justified it ("the snapshot captures exactly what is about to be
   * implemented") stopped being true the moment the guard went in front of it.
   * The re-read is what restores it. Injected by spying the guard itself,
   * because that IS the interval: anything landing during the guard is what
   * the comparison exists to catch.
   */
  function editDuringGuard(planPath: string) {
    return vi
      .spyOn(planPinGuardModule, "guardPlanNamesCitedRulings")
      .mockImplementation(async () => {
        writeFileSync(planPath, "# Plan -- EDITED mid-guard\n");
        return { ok: true } as const;
      });
  }

  it("site C: refuses to land, and pins nothing", async () => {
    const root = await newProject();
    await cite(root, "A decision.");
    const dir = sessionDirIn(root, "# Plan\n\nDo the thing.\n");
    const ctx = new StageContext(root, dir, makeState(), makeRecipe());
    const spy = editDuringGuard(join(dir, "plan.md"));

    const advance = await stage.report(ctx, APPROVE);
    spy.mockRestore();

    expect(advance.action).toBe("retry");
    expect((advance as { instruction: string }).instruction).toContain("plan.md changed");
    expect(snapshotCount(dir)).toBe(0);
  });

  it("site B: refuses to COMPLETE, so a session never blesses bytes it did not judge", async () => {
    // With no snapshot, plan.md on disk IS the artifact of record. An edit
    // landing during the guard would otherwise be blessed by the session
    // finalizing as `completed` -- the same failure as an unjudged pin, just
    // without a file to point at.
    const root = await newProject();
    await cite(root, "A decision.");
    const dir = sessionDirIn(root, "# Plan\n\nDo the thing.\n");
    const ctx = new StageContext(root, dir, makeState({ mode: "plan" }), makeRecipe());
    const spy = editDuringGuard(join(dir, "plan.md"));

    const advance = await stage.report(ctx, APPROVE);
    spy.mockRestore();

    expect(advance.action).toBe("retry");
    expect(ctx.state.status).toBe("active");
  });
});
