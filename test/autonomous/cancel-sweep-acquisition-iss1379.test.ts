/**
 * ISS-1379: cancel never ends a session that still holds an issue-sweep step
 * or an issue the sweep acquired.
 *
 * An unconfirmed sweep step (its lock failed) refuses the cancel with the
 * marker intact, as start, report and resume already do. After recovery,
 * every issue stamped with this session's sweepAcquisition is released
 * inside the sweep lock, or the cancel refuses when ownership cannot be
 * settled: a merge conflict on our issue, or an issue file that cannot be
 * read or parsed. An issue earmarked to someone else keeps its stamp and is
 * reported. Issues of other sessions are never touched.
 *
 * Faults are injected at the two project locks (fail N times, or run a hook
 * before the Nth sweep lock) and counted at the issue and ticket write seams.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Loose = Record<string, unknown>;

const hoisted = vi.hoisted(() => ({
  sweepLockFailures: 0,
  sweepLockCalls: 0,
  beforeSweepLock: new Map<number, () => void>(),
  lockFailures: 0,
  lockFailuresConsumed: 0,
  issueWrites: [] as string[],
  ticketWrites: [] as string[],
  crashAfterIssueWrite: 0,
}));

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

vi.mock("../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-loader.js")>();
  return {
    ...actual,
    withProjectLockForIssueSweep: async (...args: Parameters<typeof actual.withProjectLockForIssueSweep>) => {
      hoisted.sweepLockCalls++;
      hoisted.beforeSweepLock.get(hoisted.sweepLockCalls)?.();
      if (hoisted.sweepLockFailures > 0) {
        hoisted.sweepLockFailures--;
        throw new Error("simulated sweep lock failure");
      }
      return actual.withProjectLockForIssueSweep(...args);
    },
    withProjectLock: async (...args: Parameters<typeof actual.withProjectLock>) => {
      if (hoisted.lockFailures > 0) {
        hoisted.lockFailures--;
        hoisted.lockFailuresConsumed++;
        throw new Error("simulated project lock failure");
      }
      return actual.withProjectLock(...args);
    },
    writeIssueUnlocked: async (...args: Parameters<typeof actual.writeIssueUnlocked>) => {
      hoisted.issueWrites.push(args[0].id);
      const written = await actual.writeIssueUnlocked(...args);
      if (hoisted.crashAfterIssueWrite > 0) {
        hoisted.crashAfterIssueWrite--;
        throw new Error("simulated crash after an issue write");
      }
      return written;
    },
    writeTicketUnlocked: async (...args: Parameters<typeof actual.writeTicketUnlocked>) => {
      hoisted.ticketWrites.push(args[0].id);
      return actual.writeTicketUnlocked(...args);
    },
  };
});

import { writeSessionSync } from "../../src/autonomous/session.js";
import { sweepStepPendingText } from "../../src/autonomous/stages/issue-sweep.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { localDateOf } from "../../src/core/local-date.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";
import {
  OTHER_SESSION, setupProject, writeIssue, issueText, readIssue, acquiredBy, loadedFingerprint,
  readState, stateText, eventsOfType, plant, resume, cancel,
} from "./_issue-sweep-harness.js";

let root: string;
const NOW = new Date(2026, 9, 17, 12, 0, 0);
const TODAY = localDateOf(NOW);
const PENDING = sweepStepPendingText("simulated sweep lock failure");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), "iss1379-"));
  setupProject(root);
  hoisted.sweepLockFailures = 0;
  hoisted.sweepLockCalls = 0;
  hoisted.beforeSweepLock = new Map();
  hoisted.lockFailures = 0;
  hoisted.lockFailuresConsumed = 0;
  hoisted.issueWrites = [];
  hoisted.ticketWrites = [];
  hoisted.crashAfterIssueWrite = 0;
});

afterEach(() => {
  vi.useRealTimers();
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

/** An earmark assigned to a session, as the earmark schema requires it. */
function earmarkFor(holderSession: string): Loose {
  return {
    stage: "assigned", reservedBy: { client: "claude", id: "pen-task-1" }, arrangementId: "a-0123456789abcdef",
    since: "2026-10-16T00:00:00.000Z", holderRole: "worker", holderSession,
  };
}

const CONFLICTS = [{ fieldPath: "/title", field: "title", kind: "field", base: "x", ours: "a", theirs: "b" }];
const issuePath = (id: string) => join(root, ".story", "issues", `${id}.json`);
const ticketPath = (id: string) => join(root, ".story", "tickets", `${id}.json`);

function patchState(dir: string, patch: Loose): void {
  writeSessionSync(dir, { ...readState(dir), ...patch } as unknown as FullSessionState);
}

/** A sweep session cancel may end: the ticket cap is reached, so the soft gate stands down. */
function sweepSession(sweep: Loose | null): { sessionId: string; dir: string } {
  const planted = plant(root, sweep as never);
  patchState(planted.dir, { config: { ...readState(planted.dir).config, maxTicketsPerSession: 1 } });
  return planted;
}

function editIssue(id: string, change: Loose): void {
  writeFileSync(issuePath(id), JSON.stringify({ ...JSON.parse(readFileSync(issuePath(id), "utf-8")), ...change }, null, 2) + "\n");
}

function withoutConflicts(id: string): void {
  const { _conflicts: _gone, ...rest } = JSON.parse(readFileSync(issuePath(id), "utf-8")) as Loose;
  writeFileSync(issuePath(id), JSON.stringify(rest, null, 2) + "\n");
}

/** A pending release of ISS-001 (acquired by us, then resolved) that never reached the ledger. */
async function pendingRelease(sessionId: string, extra: Loose = {}): Promise<Loose> {
  const resolvedFields = { status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16" };
  writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedFields });
  const releasePre = await loadedFingerprint(root, "ISS-001");
  writeIssue(root, "ISS-001", resolvedFields);
  const releasePost = await loadedFingerprint(root, "ISS-001");
  writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedFields, ...extra });
  return {
    type: "issue_sweep_step", variant: "release", transitionId: "issue-sweep-release-iss1379", current: "ISS-001",
    outcome: "fixed", entry: { id: "ISS-001" }, releasePre, releasePost,
  };
}

/** An acquisition of ISS-001 that reached the ledger, as its marker records it. */
async function landedAcquire(sessionId: string): Promise<Loose> {
  writeIssue(root, "ISS-001");
  const pre = await loadedFingerprint(root, "ISS-001");
  writeIssue(root, "ISS-001", acquiredBy(sessionId));
  const post = await loadedFingerprint(root, "ISS-001");
  return { type: "issue_sweep_step", variant: "acquire", transitionId: "issue-sweep-acquire-fixture", next: { id: "ISS-001", pre, post }, after: [] };
}

function expectActive(dir: string): void {
  const s = readState(dir) as unknown as Loose;
  expect(s.state).toBe("ISSUE_SWEEP");
  expect(s.cancellation ?? null).toBeNull();
}

function expectEnded(dir: string): void {
  expect((readState(dir) as unknown as Loose).state).toBe("SESSION_END");
}

/** Released by this session: reopened when the sweep held it in progress, every hold removed. */
function expectReleasedOpen(id: string, sessionId: string): void {
  const issue = readIssue(root, id);
  expect(issue.status).toBe("open");
  expect(issue.sweepAcquisition).toBeUndefined();
  const earmark = issue.earmark as Loose | null | undefined;
  expect(earmark?.holderSession === sessionId).toBe(false);
  expect(issue.updatedDate).toBe(TODAY);
}

/** A second session's sweep acquires the released issue. */
async function expectPickable(id: string): Promise<void> {
  const second = plant(root, { current: null, remaining: [id], resolved: [] }, { compact: true });
  await resume(root, second.sessionId);
  expect((readIssue(root, id).sweepAcquisition as Loose | undefined)?.sessionId).toBe(second.sessionId);
}

describe("an unconfirmed sweep step refuses the cancel (ISS-1379 step A)", () => {
  it("C1: a pending release whose lock fails refuses with every byte unchanged; the retry completes", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    patchState(dir, { pendingProjectMutation: await pendingRelease(sessionId) });
    const state = stateText(dir);
    const issue = issueText(root, "ISS-001");
    hoisted.sweepLockFailures = 1;

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(true);
    expect(r.text).toContain(PENDING);
    expect(hoisted.sweepLockFailures).toBe(0);
    expect(stateText(dir)).toBe(state);
    expect(issueText(root, "ISS-001")).toBe(issue);
    expect(hoisted.issueWrites).toEqual([]);
    expectActive(dir);

    // C1r: the lock heals.
    const again = await cancel(root, sessionId);

    expect(again.isError).toBe(false);
    expect(hoisted.issueWrites).toEqual(["ISS-001"]);
    const done = readIssue(root, "ISS-001");
    expect(done.status).toBe("resolved");
    expect(done.sweepAcquisition).toBeUndefined();
    expect(readState(dir).pendingProjectMutation ?? null).toBeNull();
    expectEnded(dir);
  });

  it("C1t: the refusal comes before the ticket release; the retry releases the ticket the session holds", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeFileSync(ticketPath("T-002"), JSON.stringify({
      id: "T-002", title: "Held", description: "Held by the session.", type: "task", status: "inprogress",
      phase: "p1", order: 20, createdDate: "2026-10-16", completedDate: null, blockedBy: [], claimedBySession: sessionId,
    }));
    patchState(dir, {
      ticket: { id: "T-002", title: "Held" },
      pendingProjectMutation: await pendingRelease(sessionId),
    });
    const ticket = readFileSync(ticketPath("T-002"), "utf-8");
    const state = stateText(dir);
    hoisted.sweepLockFailures = 1;

    const r = await cancel(root, sessionId);

    expect(r.text).toContain(PENDING);
    expect(readFileSync(ticketPath("T-002"), "utf-8")).toBe(ticket);
    expect(hoisted.ticketWrites).toEqual([]);
    expect(stateText(dir)).toBe(state);
    expectActive(dir);

    await cancel(root, sessionId);

    const released = JSON.parse(readFileSync(ticketPath("T-002"), "utf-8")) as Loose;
    expect(released.status).toBe("open");
    expect(released.claimedBySession).toBeUndefined();
    expect(hoisted.ticketWrites).toEqual(["T-002"]);
    expectEnded(dir);
  });

  it("C2: a landed acquisition whose lock fails refuses; the retry records and releases it, and it can be picked again", async () => {
    const { sessionId, dir } = sweepSession({ current: null, remaining: ["ISS-001"], resolved: [] });
    patchState(dir, { pendingProjectMutation: await landedAcquire(sessionId) });
    const state = stateText(dir);
    const issue = issueText(root, "ISS-001");
    hoisted.sweepLockFailures = 1;

    const r = await cancel(root, sessionId);

    expect(r.text).toContain(PENDING);
    expect(stateText(dir)).toBe(state);
    expect(issueText(root, "ISS-001")).toBe(issue);
    expectActive(dir);

    // C2r
    const again = await cancel(root, sessionId);

    expect(again.isError).toBe(false);
    expectReleasedOpen("ISS-001", sessionId);
    expect(eventsOfType(dir, "issue_sweep_cancel_release").map((e) => (e.data as Loose).id)).toEqual(["ISS-001"]);
    expectEnded(dir);
    await expectPickable("ISS-001");
  });

  it("C3: with the claim lost, a sweep marker is still recovered, never dropped", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeFileSync(ticketPath("T-002"), JSON.stringify({
      id: "T-002", title: "Taken", description: "Claimed by another.", type: "task", status: "inprogress",
      phase: "p1", order: 20, createdDate: "2026-10-16", completedDate: null, blockedBy: [], claimedBySession: OTHER_SESSION,
    }));
    patchState(dir, {
      ticket: { id: "T-002", title: "Taken" },
      claimEpoch: { ticketId: "T-002", sessionId, user: null, branch: null, since: null, establishedAt: "2026-10-16T00:00:00.000Z" },
      pendingProjectMutation: await pendingRelease(sessionId),
    });
    const state = stateText(dir);
    const issue = issueText(root, "ISS-001");
    hoisted.sweepLockFailures = 1;

    const r = await cancel(root, sessionId);

    expect(r.text).toContain(PENDING);
    expect(stateText(dir)).toBe(state);
    expect(issueText(root, "ISS-001")).toBe(issue);
    expectActive(dir);

    await cancel(root, sessionId);

    const done = readIssue(root, "ISS-001");
    expect(done.status).toBe("resolved");
    expect(done.sweepAcquisition).toBeUndefined();
    expect(hoisted.ticketWrites).toEqual([]);
    expectEnded(dir);
  });
});

describe("the issues this session's sweep holds are released or the cancel refuses (ISS-1379 step B)", () => {
  it("C2b: a lock failure in the release refuses; the retry finds the issue by its stamp", async () => {
    const { sessionId, dir } = sweepSession({ current: null, remaining: ["ISS-001"], resolved: [] });
    patchState(dir, { pendingProjectMutation: await landedAcquire(sessionId) });
    // Call 1 is recovery; the release's lock is call 2.
    hoisted.beforeSweepLock.set(2, () => { hoisted.sweepLockFailures = 1; });

    const r = await cancel(root, sessionId);

    expect(r.text).toContain(PENDING);
    expect(readIssue(root, "ISS-001").sweepAcquisition).toEqual(acquiredBy(sessionId).sweepAcquisition);
    expect(readState(dir).pendingProjectMutation ?? null).toBeNull();
    expectActive(dir);

    await cancel(root, sessionId);

    expectReleasedOpen("ISS-001", sessionId);
    expectEnded(dir);
  });

  it("C2c: an edit between recovery and the release is kept; the release changes only the hold", async () => {
    const { sessionId, dir } = sweepSession({ current: null, remaining: ["ISS-001"], resolved: [] });
    patchState(dir, { pendingProjectMutation: await landedAcquire(sessionId) });
    hoisted.beforeSweepLock.set(2, () => editIssue("ISS-001", { title: "Edited meanwhile", impact: "New impact" }));

    await cancel(root, sessionId);

    expectReleasedOpen("ISS-001", sessionId);
    const issue = readIssue(root, "ISS-001");
    expect(issue.title).toBe("Edited meanwhile");
    expect(issue.impact).toBe("New impact");
    expectEnded(dir);
  });

  it("C2x: an acquisition edited before recovery is still released, though recovery never set it current", async () => {
    const { sessionId, dir } = sweepSession({ current: null, remaining: ["ISS-001"], resolved: [] });
    patchState(dir, { pendingProjectMutation: await landedAcquire(sessionId) });
    editIssue("ISS-001", { title: "Edited before recovery" });
    hoisted.beforeSweepLock.set(2, () => { hoisted.sweepLockFailures = 1; });

    const r = await cancel(root, sessionId);

    expect(r.text).toContain(PENDING);
    expect(readState(dir).issueSweepState?.current ?? null).toBeNull();
    expect(readState(dir).pendingProjectMutation ?? null).toBeNull();
    expect(readIssue(root, "ISS-001").sweepAcquisition).toEqual(acquiredBy(sessionId).sweepAcquisition);
    expectActive(dir);

    await cancel(root, sessionId);

    expectReleasedOpen("ISS-001", sessionId);
    expect(readIssue(root, "ISS-001").title).toBe("Edited before recovery");
    expectEnded(dir);
  });

  it("C2y: a release that recovery lists as conflicted keeps refusing until the conflict is resolved", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    patchState(dir, { pendingProjectMutation: await pendingRelease(sessionId, { _conflicts: CONFLICTS }) });
    const issue = issueText(root, "ISS-001");

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("unresolved merge conflicts");
    expect(r.text).toContain("ISS-001");
    expect(readState(dir).issueSweepState?.current ?? null).toBeNull();
    expect(issueText(root, "ISS-001")).toBe(issue);
    expectActive(dir);
    const state = stateText(dir);

    const twice = await cancel(root, sessionId);

    expect(twice.text).toContain("unresolved merge conflicts");
    expect(stateText(dir)).toBe(state);
    expect(issueText(root, "ISS-001")).toBe(issue);

    withoutConflicts("ISS-001");
    await cancel(root, sessionId);

    const done = readIssue(root, "ISS-001");
    expect(done.status).toBe("resolved");
    expect(done.sweepAcquisition).toBeUndefined();
    expect(done.updatedDate).toBeUndefined();
    expectEnded(dir);
  });

  it("C2m: with no marker, our issue with merge conflicts refuses, again on retry, and is released once resolved", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), _conflicts: CONFLICTS });
    const issue = issueText(root, "ISS-001");
    const state = stateText(dir);

    for (let i = 0; i < 2; i++) {
      const r = await cancel(root, sessionId);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("unresolved merge conflicts");
      expect(issueText(root, "ISS-001")).toBe(issue);
      expect(stateText(dir)).toBe(state);
    }
    expectActive(dir);

    withoutConflicts("ISS-001");
    await cancel(root, sessionId);

    expectReleasedOpen("ISS-001", sessionId);
    expectEnded(dir);
  });

  it("C2n: the plain cancel in the middle of a sweep releases the current issue, and it can be picked again", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", acquiredBy(sessionId));

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(false);
    expectReleasedOpen("ISS-001", sessionId);
    expectEnded(dir);
    await expectPickable("ISS-001");
  });

  it("C2s: an issue the agent resolved keeps its status; only the hold and our earmark go, unstamped", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", {
      ...acquiredBy(sessionId), status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16",
      earmark: earmarkFor(sessionId),
    });

    await cancel(root, sessionId);

    const issue = readIssue(root, "ISS-001");
    expect(issue.status).toBe("resolved");
    expect(issue.sweepAcquisition).toBeUndefined();
    expect(issue.earmark ?? null).toBeNull();
    expect(issue.updatedDate).toBeUndefined();
    expectEnded(dir);
  });

  it("C2f: an issue another session's sweep holds is never touched", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", acquiredBy(OTHER_SESSION));
    const issue = issueText(root, "ISS-001");

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(false);
    expect(issueText(root, "ISS-001")).toBe(issue);
    expect(hoisted.issueWrites).toEqual([]);
    expect(eventsOfType(dir, "issue_sweep_cancel_release")).toEqual([]);
    expectEnded(dir);
  });

  it("C2e: our stamp with another session's assigned earmark is left as it is and reported", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", {
      ...acquiredBy(sessionId),
      earmark: earmarkFor(OTHER_SESSION),
    });
    const issue = issueText(root, "ISS-001");

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(false);
    expect(issueText(root, "ISS-001")).toBe(issue);
    expect(hoisted.issueWrites).toEqual([]);
    const conflicts = eventsOfType(dir, "issue_sweep_conflict");
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0]!.data as Loose).id).toBe("ISS-001");
    expect(String((conflicts[0]!.data as Loose).reason)).toMatch(/^earmarked for /);
    expect(r.text).toContain("ISS-001");
    expect(r.text).toMatch(/earmarked for /);
    expectEnded(dir);
  });

  it("C2v: two held issues, one with merge conflicts: the cancel refuses and neither is written", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", acquiredBy(sessionId));
    writeIssue(root, "ISS-003", { ...acquiredBy(sessionId), _conflicts: CONFLICTS });
    const one = issueText(root, "ISS-001");
    const three = issueText(root, "ISS-003");

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("ISS-003");
    expect(issueText(root, "ISS-001")).toBe(one);
    expect(issueText(root, "ISS-003")).toBe(three);
    expect(hoisted.issueWrites).toEqual([]);
    expectActive(dir);
  });
});

describe("a release that reached disk before the cancel failed is never repeated (ISS-1379)", () => {
  it("C2w: the first cancel stays active after one release lands; the retry leaves it as it is and releases the other", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", acquiredBy(sessionId));
    writeIssue(root, "ISS-002", acquiredBy(sessionId));
    hoisted.crashAfterIssueWrite = 1;

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(true);
    expect(r.text).toContain(sweepStepPendingText("simulated crash after an issue write"));
    expect(hoisted.crashAfterIssueWrite).toBe(0);
    expect(hoisted.issueWrites).toEqual(["ISS-001"]);
    expectReleasedOpen("ISS-001", sessionId);
    expect(readIssue(root, "ISS-002").sweepAcquisition).toEqual(acquiredBy(sessionId).sweepAcquisition);
    expectActive(dir);
    const released = issueText(root, "ISS-001");
    hoisted.issueWrites = [];

    const again = await cancel(root, sessionId);

    expect(again.isError).toBe(false);
    expect(issueText(root, "ISS-001")).toBe(released);
    expect(hoisted.issueWrites).toEqual(["ISS-002"]);
    expectReleasedOpen("ISS-002", sessionId);
    expect(eventsOfType(dir, "issue_sweep_cancel_release").map((e) => (e.data as Loose).id)).toEqual(["ISS-002"]);
    expectEnded(dir);
  });
});

describe("an issue file that cannot be read or parsed refuses the cancel (ISS-1379)", () => {
  it("C2j: our issue truncated after its session id refuses until the file is repaired", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", acquiredBy(sessionId));
    const good = issueText(root, "ISS-001");
    const cut = good.slice(0, good.indexOf(sessionId) + sessionId.length);
    writeFileSync(issuePath("ISS-001"), cut);

    for (let i = 0; i < 2; i++) {
      const r = await cancel(root, sessionId);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("ISS-001.json");
      expect(issueText(root, "ISS-001")).toBe(cut);
    }
    expectActive(dir);

    writeFileSync(issuePath("ISS-001"), good);
    await cancel(root, sessionId);

    expectReleasedOpen("ISS-001", sessionId);
    expectEnded(dir);
  });

  it("C2t: our issue truncated before its session id still refuses until the file is repaired", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", acquiredBy(sessionId));
    const good = issueText(root, "ISS-001");
    const cut = good.slice(0, good.indexOf(sessionId) - 1);
    expect(cut).not.toContain(sessionId);
    writeFileSync(issuePath("ISS-001"), cut);

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("ISS-001.json");
    expectActive(dir);

    writeFileSync(issuePath("ISS-001"), good);
    await cancel(root, sessionId);

    expectReleasedOpen("ISS-001", sessionId);
    expectEnded(dir);
  });

  it("C2u: an issue file that cannot be read refuses until it can", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", acquiredBy(sessionId));
    chmodSync(issuePath("ISS-001"), 0o000);
    try {
      const r = await cancel(root, sessionId);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("ISS-001.json");
      expectActive(dir);
    } finally {
      chmodSync(issuePath("ISS-001"), 0o644);
    }

    await cancel(root, sessionId);

    expectReleasedOpen("ISS-001", sessionId);
    expectEnded(dir);
  });

  it("C2k: an issue file that fails the schema refuses until it is fixed", async () => {
    const { sessionId, dir } = sweepSession({ current: "ISS-001", remaining: [], resolved: [] });
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), status: "not-a-status" });

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("ISS-001.json");
    expectActive(dir);

    editIssue("ISS-001", { status: "inprogress" });
    await cancel(root, sessionId);

    expectReleasedOpen("ISS-001", sessionId);
    expectEnded(dir);
  });

  it("C2z: an unrelated corrupt issue file refuses too, and the cancel completes once it is repaired", async () => {
    const { sessionId, dir } = sweepSession({ current: null, remaining: [], resolved: [] });
    writeIssue(root, "ISS-002");
    const good = issueText(root, "ISS-002");
    writeFileSync(issuePath("ISS-002"), good.slice(0, 20));

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("ISS-002.json");
    expectActive(dir);

    writeFileSync(issuePath("ISS-002"), good);
    const again = await cancel(root, sessionId);

    expect(again.isError).toBe(false);
    expect(issueText(root, "ISS-002")).toBe(good);
    expectEnded(dir);
  });
});

describe("markers outside the sweep keep today's behaviour (ISS-1379)", () => {
  it("C4: with the claim lost, a ticket marker is dropped and ticket recovery is never entered", async () => {
    const { sessionId, dir } = sweepSession(null);
    writeFileSync(ticketPath("T-002"), JSON.stringify({
      id: "T-002", title: "Taken", description: "Claimed by another.", type: "task", status: "inprogress",
      phase: "p1", order: 20, createdDate: "2026-10-16", completedDate: null, blockedBy: [], claimedBySession: OTHER_SESSION,
    }));
    patchState(dir, {
      ticket: { id: "T-002", title: "Taken" },
      claimEpoch: { ticketId: "T-002", sessionId, user: null, branch: null, since: null, establishedAt: "2026-10-16T00:00:00.000Z" },
      pendingProjectMutation: { type: "ticket_update", target: "T-002", field: "status", value: "inprogress", expectedCurrent: "open", transitionId: "t-iss1379-c4" },
    });
    const ticket = readFileSync(ticketPath("T-002"), "utf-8");

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(false);
    expect(hoisted.ticketWrites).toEqual([]);
    expect(eventsOfType(dir, "mutation_conflict")).toEqual([]);
    expect(readFileSync(ticketPath("T-002"), "utf-8")).toBe(ticket);
    expectEnded(dir);
  });

  it("C5: an issue_update marker whose lock fails ends the session with the marker kept", async () => {
    const { sessionId, dir } = sweepSession(null);
    writeIssue(root, "ISS-001");
    patchState(dir, {
      pendingProjectMutation: { type: "issue_update", target: "ISS-001", field: "status", value: "inprogress", expectedCurrent: "open", transitionId: "t-iss1379-c5" },
    });
    const issue = issueText(root, "ISS-001");
    hoisted.lockFailures = 1;

    const r = await cancel(root, sessionId);

    expect(r.isError).toBe(false);
    expect(hoisted.lockFailuresConsumed).toBe(1);
    expect(issueText(root, "ISS-001")).toBe(issue);
    expect((readState(dir).pendingProjectMutation as Loose | null)?.type).toBe("issue_update");
    expectEnded(dir);
  });
});
