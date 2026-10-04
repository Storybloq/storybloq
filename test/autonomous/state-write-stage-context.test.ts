/**
 * ISS-958 S2: StageContext adopts a published-but-undurable state (policy A),
 * finalizeSession and the HANDOVER stage complete their terminal tails before
 * the typed error propagates (policy TC), and recoverPendingMutation reports
 * the conflict clear it published.
 *
 * Rows covered from the plan's terminal table: TP1 (handover: pid, mk, tel,
 * end, log, rm) and TP2-TP4 (finalizeSession only: pid, mk, tel, end; log and
 * rm are n/a). TP2-TP4 are driven through StageContext.finalizeSession
 * because that call is their entire tail: plan-review.ts:329/:1479 and
 * code-review.ts:1520 return their terminal result right after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { wrapFs } = await import("./_state-write-fault.js");
  return wrapFs(actual);
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateWriteUndurableError, readSession, writeSessionSync } from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { StageContext } from "../../src/autonomous/stages/types.js";
import { HandoverStage } from "../../src/autonomous/stages/handover.js";
import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { killSidecar } from "../../src/autonomous/liveness.js";
import type { ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { armFail, armUndurable, disarm, faultFired } from "./_state-write-fault.js";

const SIDECAR_PID = 987_654_321;
const roots: string[] = [];
let killSpy: MockInstance<typeof process.kill>;

beforeEach(() => {
  killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
});

afterEach(() => {
  disarm();
  killSpy.mockRestore();
  while (roots.length) {
    try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function armTyped(dir: string, nth = 1): void {
  armUndurable(
    (published) => new StateWriteUndurableError(published as FullSessionState, new Error("EIO: injected dir fsync failure")),
    (d) => readSession(d),
    { dir, nth },
  );
}

function recipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block", branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  } as unknown as ResolvedRecipe;
}

function setup(stateName = "IMPLEMENT"): { root: string; dir: string; state: FullSessionState } {
  const root = mkdtempSync(join(tmpdir(), "iss958-s2-"));
  roots.push(root);
  for (const sub of ["sessions", "tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss958-s2", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "iss958", date: "2026-10-04", phases: [], blockers: [],
  }));
  const sessionId = "bbbb0001-0000-4000-8000-000000000001";
  const dir = join(root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state = writeSessionSync(dir, {
    schemaVersion: 1, sessionId, recipe: "coding", state: stateName, revision: 3, status: "active",
    mode: "auto", reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: null, mergeBase: null },
    lease: { workspaceId: deriveWorkspaceId(root), lastHeartbeat: now, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null, compactPending: false,
    compactPreparedAt: null, resumeBlocked: false, terminationReason: null, waitingForRetry: false,
    lastGuideCall: now, startedAt: now, guideCallCount: 0, sidecarPid: SIDECAR_PID,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
  } as unknown as FullSessionState);
  return { root, dir, state };
}

function lines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const tDir = (dir: string) => join(dir, "telemetry");

function sigterms(): number {
  return killSpy.mock.calls.filter(([pid, sig]) => pid === SIDECAR_PID && sig === "SIGTERM").length;
}

function writeResumeMarkerFile(root: string): string {
  const p = join(root, ".claude", "rules", "autonomous-resume.md");
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  writeFileSync(p, "# resume\n");
  return p;
}

describe("ISS-958 S2: StageContext.writeState adopts the published state (policy A)", () => {
  it("a swallowed undurable write leaves ctx.state at the published revision, and the next write continues from it", () => {
    const { root, dir, state } = setup();
    const ctx = new StageContext(root, dir, state, recipe());

    armTyped(dir);
    let caught: unknown;
    try { ctx.writeState({ state: "PLAN" } as Partial<FullSessionState>); } catch (err) { caught = err; }
    expect(faultFired()).toBe(true);
    expect(caught).toBeInstanceOf(StateWriteUndurableError);
    expect(ctx.state.revision).toBe(state.revision + 1);
    expect(ctx.state.state).toBe("PLAN");

    disarm();
    const next = ctx.writeState({ state: "IMPLEMENT" } as Partial<FullSessionState>);
    expect(next.revision).toBe(state.revision + 2);
    expect(readSession(dir)!.revision).toBe(state.revision + 2);
  });

  it("a plain pre-rename failure leaves ctx.state unchanged", () => {
    const { root, dir, state } = setup();
    const ctx = new StageContext(root, dir, state, recipe());
    armFail({ dir });
    expect(() => ctx.writeState({ state: "PLAN" } as Partial<FullSessionState>)).toThrow(/injected rename failure/);
    expect(ctx.state).toEqual(state);
  });
});

describe("ISS-958 S2: finalizeSession completes its tail on an undurable publication (TP2-TP4)", () => {
  it("signals the sidecar, writes the shutdown marker, telemetry session_end and the ended marker once, then rethrows", () => {
    const { root, dir, state } = setup("PLAN_REVIEW");
    const marker = writeResumeMarkerFile(root);
    const ctx = new StageContext(root, dir, state, recipe());

    armTyped(dir);
    let caught: unknown;
    try {
      ctx.finalizeSession({ status: "completed", terminationReason: "normal" } as Partial<FullSessionState>);
    } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(StateWriteUndurableError);
    expect(readSession(dir)!.status).toBe("completed");
    expect(sigterms()).toBe(1);
    expect(readFileSync(join(tDir(dir), "shutdown"), "utf-8")).toBe("1");
    expect(readFileSync(join(tDir(dir), "alive"), "utf-8")).toBe("0");
    expect(lines(join(tDir(dir), "events.jsonl")).filter((e) => e.type === "session_end")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(tDir(dir), "ended"), "utf-8")).reason).toBe("normal");
    // n/a for this row: no events.log line, resume marker untouched.
    expect(lines(join(dir, "events.log")).filter((e) => e.type === "session_end")).toHaveLength(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("a plain pre-rename failure performs none of the tail", () => {
    const { root, dir, state } = setup("CODE_REVIEW");
    const ctx = new StageContext(root, dir, state, recipe());
    armFail({ dir });
    expect(() => ctx.finalizeSession({ status: "completed", terminationReason: "normal" } as Partial<FullSessionState>))
      .toThrow(/injected rename failure/);
    expect(sigterms()).toBe(0);
    expect(existsSync(join(tDir(dir), "shutdown"))).toBe(false);
    expect(existsSync(join(tDir(dir), "ended"))).toBe(false);
    expect(readSession(dir)!.status).toBe("active");
  });
});

describe("ISS-958 S2: the HANDOVER stage completes its own tail (TP1)", () => {
  it("on an undurable SESSION_END publication: every TP1 effect exactly once, then the typed error", async () => {
    const { root, dir, state } = setup("HANDOVER");
    const marker = writeResumeMarkerFile(root);
    const ctx = new StageContext(root, dir, state, recipe());

    armTyped(dir);
    await expect(new HandoverStage().report(ctx, { completedAction: "handover_written", handoverContent: "# done\n" } as never))
      .rejects.toBeInstanceOf(StateWriteUndurableError);

    const onDisk = readSession(dir)!;
    expect(onDisk.state).toBe("SESSION_END");
    expect(onDisk.status).toBe("completed");
    expect(sigterms()).toBe(1);
    expect(readFileSync(join(tDir(dir), "shutdown"), "utf-8")).toBe("1");
    expect(lines(join(tDir(dir), "events.jsonl")).filter((e) => e.type === "session_end")).toHaveLength(1);
    expect(existsSync(join(tDir(dir), "ended"))).toBe(true);
    const logEnds = lines(join(dir, "events.log")).filter((e) => e.type === "session_end");
    expect(logEnds).toHaveLength(1);
    expect(logEnds[0]!.rev).toBe(onDisk.revision);
    expect(existsSync(marker)).toBe(false);
  });

  it("on success the tail is unchanged: exactly one events.log session_end and the marker removed", async () => {
    const { root, dir, state } = setup("HANDOVER");
    const marker = writeResumeMarkerFile(root);
    const ctx = new StageContext(root, dir, state, recipe());
    await new HandoverStage().report(ctx, { completedAction: "handover_written", handoverContent: "# done\n" } as never);
    expect(lines(join(dir, "events.log")).filter((e) => e.type === "session_end")).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  it("on a plain pre-rename failure: no events.log line and the resume marker stays", async () => {
    const { root, dir, state } = setup("HANDOVER");
    const marker = writeResumeMarkerFile(root);
    const ctx = new StageContext(root, dir, state, recipe());
    armFail({ dir });
    await expect(new HandoverStage().report(ctx, { completedAction: "handover_written", handoverContent: "# done\n" } as never))
      .rejects.toThrow(/injected rename failure/);
    expect(lines(join(dir, "events.log")).filter((e) => e.type === "session_end")).toHaveLength(0);
    expect(existsSync(marker)).toBe(true);
  });
});

describe("ISS-958 5a: no TC site re-enters a terminal state (TP1-TP4)", () => {
  const terminal: Array<[string, (ctx: StageContext) => Promise<unknown>]> = [
    ["HANDOVER", (ctx) => new HandoverStage().report(ctx, { completedAction: "handover_written", handoverContent: "# done\n" } as never)],
    ["PLAN_REVIEW", async (ctx) => ctx.finalizeSession({ status: "completed", terminationReason: "normal" } as Partial<FullSessionState>)],
    ["CODE_REVIEW", async (ctx) => ctx.finalizeSession({ status: "completed", terminationReason: "normal" } as Partial<FullSessionState>)],
  ];

  it.each(terminal)("%s: report, resume and start on the published terminal state repeat no effect", async (stateName, finish) => {
    const { root, dir, state } = setup(stateName);
    armTyped(dir);
    await expect(finish(new StageContext(root, dir, state, recipe()))).rejects.toBeInstanceOf(StateWriteUndurableError);
    disarm();
    const published = readSession(dir)!;
    const counts = () => ({
      telemetry: lines(join(tDir(dir), "events.jsonl")).filter((e) => e.type === "session_end").length,
      log: lines(join(dir, "events.log")).filter((e) => e.type === "session_end").length,
      sigterms: sigterms(),
      ended: readFileSync(join(tDir(dir), "ended"), "utf-8"),
    });
    const before = counts();

    const reported = await handleAutonomousGuide(root, {
      action: "report", sessionId: published.sessionId, report: { completedAction: "noop" },
    } as never);
    expect(reported.isError).toBe(true);
    expect((reported.content[0] as { text: string }).text).toContain("Cannot report progress");
    const resumed = await handleAutonomousGuide(root, { action: "resume", sessionId: published.sessionId } as never);
    expect(resumed.isError).toBe(true);

    // A start selects only active sessions, so the terminal one is not revisited.
    let afterStart: ReturnType<typeof counts> | null = null;
    try {
      await handleAutonomousGuide(root, { action: "start", sessionId: null } as never);
      afterStart = counts();
    } finally {
      // process.kill is mocked here, and the original session records a fake
      // pid: signal only sidecars a new session spawned, through the real kill.
      killSpy.mockRestore();
      for (const name of readdirSync(join(root, ".story", "sessions"))) {
        if (name === published.sessionId) continue;
        try {
          const pid = (JSON.parse(readFileSync(join(root, ".story", "sessions", name, "state.json"), "utf-8")) as { sidecarPid?: number | null }).sidecarPid;
          if (typeof pid === "number" && pid > 0) killSidecar(pid);
        } catch { /* best-effort */ }
      }
    }

    expect(afterStart).toEqual(before);
    expect(readSession(dir)!.revision).toBe(published.revision);
    expect(readSession(dir)!.status).toBe(published.status);
  });
});

describe("ISS-958 S2: recoverPendingMutation adopts a published conflict clear (guide.ts catch, policy A)", () => {
  function plantConflict(): { root: string; dir: string; state: FullSessionState } {
    const { root, dir, state } = setup("IMPLEMENT");
    writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Ticket", description: "", type: "task", status: "complete", phase: null, order: 10,
      createdDate: "2026-10-04", completedDate: "2026-10-04", blockedBy: [],
    }));
    const withMarker = writeSessionSync(dir, {
      ...state,
      pendingProjectMutation: { type: "ticket_update", target: "T-001", value: "inprogress", expectedCurrent: "open", transitionId: "txn-958" },
    } as FullSessionState);
    return { root, dir, state: withMarker };
  }

  it("an undurable marker clear is reported as recovered at the published revision with the marker cleared", async () => {
    const { __recoveryTesting } = await import("../../src/autonomous/guide.js");
    const { root, dir, state } = plantConflict();

    armTyped(dir);
    const result = await __recoveryTesting.recoverPendingMutation(dir, state, root);
    expect(faultFired()).toBe(true);
    expect(result.kind).toBe("recovered");
    const got = (result as { state: FullSessionState }).state;
    expect(got.pendingProjectMutation).toBeNull();
    expect(got.revision).toBe(state.revision + 1);
    expect(readSession(dir)!.pendingProjectMutation).toBeNull();
    expect(lines(join(dir, "events.log")).filter((e) => e.type === "mutation_conflict")).toHaveLength(1);
  });

  it("a plain pre-rename failure keeps today's rule: the stale state comes back with the marker set", async () => {
    const { __recoveryTesting } = await import("../../src/autonomous/guide.js");
    const { root, dir, state } = plantConflict();

    armFail({ dir });
    const result = await __recoveryTesting.recoverPendingMutation(dir, state, root);
    expect(result.kind).toBe("recovered");
    expect((result as { state: FullSessionState }).state).toEqual(state);
    expect(readSession(dir)!.pendingProjectMutation).not.toBeNull();
  });
});
