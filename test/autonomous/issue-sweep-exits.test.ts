/**
 * T-486 U4-1: the three ways the issue sweep finishes an issue it acquired,
 * and the one way it lets go of an issue it cannot finish.
 *
 *  - fixed: resolved with no kind, a stale kind, or the kind `fixed`;
 *  - disposed: resolved as wontfix, duplicate, superseded or not_reproducible,
 *    with the resolution text and (for a duplicate) a target that resolves;
 *  - deferred: still open or inprogress with a non-actionable disposition and
 *    its evidence (reason, ref, bound to that disposition);
 *  - conflicted: another session holds it, or it carries merge conflicts. It
 *    is listed with the reason, never written, and the sweep goes on.
 *
 * Driven through the guide's report, so recovery runs first as in
 * production. Two rows call the stage directly:
 *  - T12b: a merge conflict anywhere on the board makes the guide's start and
 *    report refuse before any stage runs (conflicts-guard, for every stage).
 *    The sweep's own handling of `_conflicts` is reached on two paths only:
 *    a resume that recovers a pending release (guide-level row T12r in
 *    issue-sweep-step-recovery.test.ts), and a conflict that lands after the
 *    guide's check and before the sweep lock. This row pins the stage's side.
 *  - T16s: the stage's pending-marker refusal sits behind recovery, which
 *    always settles or blocks first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
  gitUserEmail: vi.fn().mockResolvedValue("me@example.com"),
}));

// Pass-through: keeps every release intent the sweep writes, so T4 and T6 can
// compare the released file with the marker's own postimage fingerprint.
const hoisted = vi.hoisted(() => ({ releaseMarkers: [] as Array<Record<string, unknown>> }));
vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  return {
    ...actual,
    writeSessionSync: (dir: string, state: Parameters<typeof actual.writeSessionSync>[1]) => {
      const m = (state as unknown as { pendingProjectMutation?: Record<string, unknown> | null }).pendingProjectMutation;
      if (m && m.type === "issue_sweep_step" && m.variant === "release") hoisted.releaseMarkers.push(m);
      return actual.writeSessionSync(dir, state);
    },
  };
});

import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { IssueSweepStage, sweepStepPendingText } from "../../src/autonomous/stages/issue-sweep.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";
import {
  OTHER_SESSION, setupProject, writeIssue, issueText, readIssue, acquiredBy, resolvedAs, deferredAs,
  readState, stateText, plant, report, resume, loadedFingerprint,
} from "./_issue-sweep-harness.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t486-u41-exits-"));
  setupProject(root);
  hoisted.releaseMarkers = [];
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

function assigned(holderSession: string): Record<string, unknown> {
  return {
    stage: "assigned", reservedBy: { client: "claude", id: "some-task" }, arrangementId: "a-0123456789abcdef",
    since: new Date().toISOString(), holderRole: "worker", holderSession,
  };
}

/**
 * The released file is the marker's postimage: its earmark is written as null
 * (what the release helper writes), and its fingerprint read back equals the
 * marker's releasePost, the parity recovery relies on (R-fp).
 */
async function expectReleasedAsMarked(id: string): Promise<void> {
  const markers = hoisted.releaseMarkers.filter((m) => m.current === id);
  expect(markers).toHaveLength(1);
  const after = readIssue(root, id);
  expect("earmark" in after).toBe(true);
  expect(after.earmark).toBeNull();
  expect(await loadedFingerprint(root, id)).toBe(markers[0]!.releasePost);
}

/** The sweep with ISS-001 acquired by this session and an optional queue behind it. */
function sweepOn(remaining: string[] = []) {
  return { current: "ISS-001", remaining, resolved: [] as string[] };
}

describe("ISSUE_SWEEP exits: fixed (T-486 U4 T4)", () => {
  it("releases the issue (own earmark and acquisition removed), records it once, and completes", async () => {
    const { sessionId, dir } = plant(root, sweepOn());
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), earmark: assigned(sessionId), status: "resolved", resolution: "Fixed it.", resolvedDate: "2026-10-16" });

    const r = await report(root, sessionId);
    expect(r.thrown).toBeNull();

    const after = readIssue(root, "ISS-001");
    expect(after.status).toBe("resolved");
    await expectReleasedAsMarked("ISS-001");
    expect(after.sweepAcquisition).toBeUndefined();
    expect(after.resolution).toBe("Fixed it.");
    const s = readState(dir);
    expect(s.issueSweepState?.resolved).toEqual(["ISS-001"]);
    expect(s.issueSweepState?.current).toBeNull();
    expect(s.pendingProjectMutation).toBeNull();
  });
});

describe("ISSUE_SWEEP exits: disposed (T-486 U4 T5)", () => {
  for (const kind of ["wontfix", "superseded", "not_reproducible"]) {
    it(`records ${kind} under disposed, not resolved`, async () => {
      const { sessionId, dir } = plant(root, sweepOn());
      writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedAs(kind, `Closed as ${kind}.`) });

      await report(root, sessionId);

      const s = readState(dir).issueSweepState!;
      expect(s.disposed).toEqual([{ id: "ISS-001", kind }]);
      expect(s.resolved).toEqual([]);
      expect(s.current).toBeNull();
      expect(readIssue(root, "ISS-001").sweepAcquisition).toBeUndefined();
    });
  }

  for (const [target, label] of [["T-001", "a ticket"], ["ISS-009", "an issue"]] as const) {
    it(`accepts a duplicate of ${label} (R-dup)`, async () => {
      writeIssue(root, "ISS-009");
      const { sessionId, dir } = plant(root, sweepOn());
      writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedAs("duplicate", `Same as ${target}.`, { duplicateOf: target }) });

      await report(root, sessionId);

      const s = readState(dir).issueSweepState!;
      expect(s.disposed).toEqual([{ id: "ISS-001", kind: "duplicate" }]);
      expect(s.current).toBeNull();
    });
  }

  const badTargets: Array<[string, string, (r: string) => void, RegExp]> = [
    ["missing", "ISS-404", () => {}, /duplicateOf: --duplicate-of ISS-404 names no ticket or issue/],
    ["deleted", "ISS-008", (r) => writeIssue(r, "ISS-008", { lifecycle: "deleted", deletedAt: "2026-10-01T00:00:00Z", deletedBy: "test" }), /duplicateOf: --duplicate-of ISS-008 is deleted/],
    ["ambiguous", "ISS-050", (r) => {
      writeFileSync(join(r, ".story", "issues", "i-aaaaaaaaaaaaaaaa.json"), JSON.stringify({ id: "i-aaaaaaaaaaaaaaaa", displayId: "ISS-050", title: "a", status: "open", severity: "low", components: [], impact: "x", resolution: null, location: [], discoveredDate: "2026-10-16", resolvedDate: null, relatedTickets: [] }));
      writeFileSync(join(r, ".story", "issues", "i-bbbbbbbbbbbbbbbb.json"), JSON.stringify({ id: "i-bbbbbbbbbbbbbbbb", displayId: "ISS-050", title: "b", status: "open", severity: "low", components: [], impact: "x", resolution: null, location: [], discoveredDate: "2026-10-16", resolvedDate: null, relatedTickets: [] }));
    }, /duplicateOf: --duplicate-of ISS-050 is ambiguous/],
    ["the issue itself", "ISS-001", () => {}, /duplicateOf: --duplicate-of cannot name the issue itself/],
  ];
  for (const [name, target, seed, text] of badTargets) {
    it(`retries a duplicate whose target is ${name}, with the resolver's text, and writes nothing`, async () => {
      seed(root);
      const { sessionId, dir } = plant(root, sweepOn());
      writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedAs("duplicate", "Dup.", { duplicateOf: target }) });
      const before = issueText(root, "ISS-001");

      const r = await report(root, sessionId);

      expect(r.text).toMatch(text);
      expect(issueText(root, "ISS-001")).toBe(before);
      const s = readState(dir).issueSweepState!;
      expect(s.current).toBe("ISS-001");
      expect(s.disposed ?? []).toEqual([]);
    });
  }

  it("counts a stale stored kind as fixed (R5)", async () => {
    const { sessionId, dir } = plant(root, sweepOn());
    // Bound to other text: the kind is stale, so it does not count.
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedAs("wontfix", "Old text."), resolution: "Fixed after all." });

    await report(root, sessionId);

    const s = readState(dir).issueSweepState!;
    expect(s.resolved).toEqual(["ISS-001"]);
    expect(s.disposed ?? []).toEqual([]);
  });
});

describe("ISSUE_SWEEP exits: deferred (T-486 U4 T6 to T8)", () => {
  it("T6: reopens the issue, clears this session's earmark and acquisition, and records the deferral", async () => {
    const { sessionId, dir } = plant(root, sweepOn());
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), earmark: assigned(sessionId), ...deferredAs("owner_gated", "Needs the owner's call on pricing.", "T-001") });

    await report(root, sessionId);

    const after = readIssue(root, "ISS-001");
    expect(after.status).toBe("open");
    await expectReleasedAsMarked("ISS-001");
    expect(after.sweepAcquisition).toBeUndefined();
    expect(after.disposition).toBe("owner_gated");
    const s = readState(dir).issueSweepState!;
    expect(s.deferred).toEqual([{ id: "ISS-001", disposition: "owner_gated", reason: "Needs the owner's call on pricing.", ref: "T-001" }]);
    expect(s.resolved).toEqual([]);
    expect(s.current).toBeNull();
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ["T7: no reason", deferredAs("owner_gated", undefined, "T-001"), /without a valid dispositionReason/],
    ["T8: no ref", deferredAs("owner_gated", "A reason.", undefined), /without a valid dispositionRef/],
    ["T8: an id ref naming nothing", deferredAs("owner_gated", "A reason.", "ISS-404"), /dispositionRef: --ref ISS-404 names no ticket, issue, note, lesson or ruling/],
    ["T8: evidence bound to another disposition", deferredAs("owner_gated", "A reason.", "T-001", "escalate_only"), /the evidence was written for disposition escalate_only, not owner_gated/],
  ];
  for (const [name, fields, text] of refusals) {
    it(`${name}: retries naming the gap and writes nothing`, async () => {
      const { sessionId, dir } = plant(root, sweepOn());
      writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...fields });
      const before = issueText(root, "ISS-001");

      const r = await report(root, sessionId);

      expect(r.text).toMatch(text);
      expect(issueText(root, "ISS-001")).toBe(before);
      const s = readState(dir).issueSweepState!;
      expect(s.current).toBe("ISS-001");
      expect(s.deferred ?? []).toEqual([]);
    });
  }
});

describe("ISSUE_SWEEP exits: conflicted (T-486 U4 T12)", () => {
  it("lists a resolved issue another session earmarked, never writes it, and acquires the next issue", async () => {
    const { sessionId, dir } = plant(root, sweepOn(["ISS-002"]));
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16", earmark: assigned(OTHER_SESSION) });
    writeIssue(root, "ISS-002");
    const before = issueText(root, "ISS-001");

    const r = await report(root, sessionId);

    expect(issueText(root, "ISS-001")).toBe(before);
    const s = readState(dir).issueSweepState!;
    expect(s.conflicted).toEqual([{ id: "ISS-001", reason: `earmarked for session ${OTHER_SESSION} (role worker)` }]);
    expect(s.resolved).toEqual([]);
    expect(s.current).toBe("ISS-002");
    expect(readIssue(root, "ISS-002").status).toBe("inprogress");
    expect(r.text).toContain("Fix **ISS-002**");
  });
});

function recipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: ["ISSUE_SWEEP", "HANDOVER"],
    stages: { ISSUE_SWEEP: { enabled: true } },
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
  } as unknown as ResolvedRecipe;
}

function stageCtx(dir: string): StageContext {
  return new StageContext(root, dir, readState(dir), recipe());
}

const CONFLICTS = [{ fieldPath: "/title", field: "title", kind: "field", base: "x", ours: "a", theirs: "b" }];

// At the stage: see the header for the two production paths that reach it.
describe("ISSUE_SWEEP exits: merge conflicts, at the stage (T-486 U4 T12b)", () => {
  it("lists a conflicted resolved issue once, skips a conflicted candidate, and acquires the next eligible issue", async () => {
    const { sessionId, dir } = plant(root, { current: "ISS-001", remaining: ["ISS-003", "ISS-002"], resolved: [] });
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16", _conflicts: CONFLICTS });
    writeIssue(root, "ISS-002");
    writeIssue(root, "ISS-003", { _conflicts: CONFLICTS });
    const before1 = issueText(root, "ISS-001");
    const before3 = issueText(root, "ISS-003");

    const advance = await new IssueSweepStage().report(stageCtx(dir), { completedAction: "issue_fixed" });

    expect(advance.action).toBe("retry");
    expect(issueText(root, "ISS-001")).toBe(before1);
    expect(issueText(root, "ISS-003")).toBe(before3);
    const s = readState(dir).issueSweepState!;
    expect(s.conflicted).toEqual([{ id: "ISS-001", reason: "unresolved merge conflicts" }]);
    expect(s.current).toBe("ISS-002");
    expect(s.remaining).toEqual([]);
    expect(readIssue(root, "ISS-002").status).toBe("inprogress");
  });

  it("does not list the same conflicted issue twice across two reports, and clears current", async () => {
    const { sessionId, dir } = plant(root, sweepOn());
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16", _conflicts: CONFLICTS });
    const before = issueText(root, "ISS-001");
    const stage = new IssueSweepStage();

    expect((await stage.report(stageCtx(dir), { completedAction: "issue_fixed" })).action).toBe("goto");
    await stage.report(stageCtx(dir), { completedAction: "issue_fixed" });

    const s = readState(dir).issueSweepState!;
    expect(s.conflicted).toEqual([{ id: "ISS-001", reason: "unresolved merge conflicts" }]);
    expect(s.current).toBeNull();
    expect(issueText(root, "ISS-001")).toBe(before);
  });
});

describe("ISSUE_SWEEP refuses to act past a pending step (T-486 U4 T16s)", () => {
  it("enter and report retry with the pending text and write nothing", async () => {
    const marker = { type: "issue_sweep_step", variant: "acquire", transitionId: "t", next: { id: "ISS-002", pre: "a", post: "b" }, after: [] };
    const { sessionId, dir } = plant(root, { current: null, remaining: ["ISS-002"], resolved: [] }, { marker });
    writeIssue(root, "ISS-002");
    const stateBefore = stateText(dir);
    const issueBefore = issueText(root, "ISS-002");
    expect(sessionId).toBeTruthy();
    const stage = new IssueSweepStage();

    const entered = await stage.enter(stageCtx(dir));
    const reported = await stage.report(stageCtx(dir), { completedAction: "issue_fixed" });

    for (const r of [entered, reported]) {
      expect((r as { action?: string }).action).toBe("retry");
      expect((r as { instruction?: string }).instruction).toBe(sweepStepPendingText("a sweep step is still pending"));
    }
    expect(stateText(dir)).toBe(stateBefore);
    expect(issueText(root, "ISS-002")).toBe(issueBefore);
  });
});

// T-481 T7c: an issue the sweep already holds that starts to wait stays held.
// Resume and report return a waiting explanation, write nothing, invent no
// disposition and keep `current`; clearing the field restores normal flow.
describe("T-481 T7c: a held issue that starts to wait", () => {
  const outcomes: Array<[string, (sid: string) => Record<string, unknown>]> = [
    ["still in progress", (sid) => ({ ...acquiredBy(sid) })],
    ["resolved", (sid) => ({ ...acquiredBy(sid), status: "resolved", resolution: "Fixed it.", resolvedDate: "2026-10-16" })],
    ["deferred", (sid) => ({ ...acquiredBy(sid), ...deferredAs("owner_gated", "Owner decides.", "T-001") })],
  ];
  for (const wait of ["owner", "external"] as const) {
    for (const [name, fields] of outcomes) {
      it(`${wait}, ${name}: report explains the wait and changes nothing; once cleared it settles normally`, async () => {
        const { sessionId, dir } = plant(root, sweepOn());
        writeIssue(root, "ISS-001", { ...fields(sessionId), waitingOn: wait });
        const before = issueText(root, "ISS-001");

        const r = await report(root, sessionId);

        expect(r.thrown).toBeNull();
        expect(r.text).toContain("waitingOn");
        expect(r.text).toContain("storybloq issue update ISS-001 --waiting-on none");
        expect(issueText(root, "ISS-001")).toBe(before);
        const s = readState(dir);
        expect(s.issueSweepState?.current).toBe("ISS-001");
        expect(s.pendingProjectMutation).toBeNull();
        expect(s.issueSweepState?.resolved ?? []).toEqual([]);
        expect(s.issueSweepState?.deferred ?? []).toEqual([]);
        expect(hoisted.releaseMarkers).toHaveLength(0);

        if (name === "still in progress") return;
        const { waitingOn: _w, ...cleared } = { ...fields(sessionId) } as Record<string, unknown>;
        writeIssue(root, "ISS-001", cleared);
        await report(root, sessionId);
        const settled = readState(dir).issueSweepState!;
        expect(settled.current).toBeNull();
        if (name === "resolved") expect(settled.resolved).toEqual(["ISS-001"]);
        else expect(settled.deferred).toEqual([{ id: "ISS-001", disposition: "owner_gated", reason: "Owner decides.", ref: "T-001" }]);
      });
    }

    it(`${wait}: a resume of the held issue returns the waiting explanation, not work instructions`, async () => {
      const { sessionId, dir } = plant(root, sweepOn(), { compact: true });
      writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), waitingOn: wait });
      const before = issueText(root, "ISS-001");

      const r = await resume(root, sessionId);

      expect(r.text).toContain("waitingOn");
      expect(r.text).not.toContain("Fix **ISS-001**");
      expect(issueText(root, "ISS-001")).toBe(before);
      expect(readState(dir).issueSweepState?.current).toBe("ISS-001");

      writeIssue(root, "ISS-001", { ...acquiredBy(sessionId) });
      const again = await report(root, sessionId);
      expect(again.text).not.toContain("--waiting-on none");
    });
  }
});

// T-481 T7d (pen ruling): the deleted check comes before the wait check, so a
// held issue deleted while it waits takes the deleted path, never "waiting".
describe("T-481 T7d: a held issue deleted while it waits", () => {
  for (const wait of ["owner", "external"] as const) {
    it(`${wait}: report gives the deleted explanation, not the waiting one`, async () => {
      const { sessionId, dir } = plant(root, sweepOn());
      writeIssue(root, "ISS-001", {
        ...acquiredBy(sessionId), waitingOn: wait,
        lifecycle: "deleted", deletedAt: "2026-10-16T00:00:00Z", deletedBy: "test",
      });
      const before = issueText(root, "ISS-001");

      const r = await report(root, sessionId);

      expect(r.thrown).toBeNull();
      expect(r.text).toContain("was deleted (tombstoned)");
      expect(r.text).not.toContain("--waiting-on none");
      expect(issueText(root, "ISS-001")).toBe(before);
      expect(readState(dir).issueSweepState?.current).toBe("ISS-001");
    });
  }
});

// T-481 T7b (sweep): a waiting issue is never acquired, at the source filter
// or at the locked recheck.
describe("T-481 T7b: the sweep never acquires a waiting issue", () => {
  for (const wait of ["owner", "external"] as const) {
    it(`${wait}: a waiting issue in the queue is skipped and the next one is acquired`, async () => {
      const { sessionId, dir } = plant(root, { current: "ISS-001", remaining: ["ISS-002", "ISS-003"], resolved: [] });
      writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), status: "resolved", resolution: "Fixed it.", resolvedDate: "2026-10-16" });
      writeIssue(root, "ISS-002", { waitingOn: wait });
      writeIssue(root, "ISS-003");
      const before = issueText(root, "ISS-002");

      const r = await report(root, sessionId);

      expect(r.text).toContain("ISS-003");
      expect(issueText(root, "ISS-002")).toBe(before);
      expect(readState(dir).issueSweepState?.current).toBe("ISS-003");
    });
  }
});
