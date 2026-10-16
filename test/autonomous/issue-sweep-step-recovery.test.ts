/**
 * T-486 U4-1: every issue-sweep step is recorded before it touches the ledger
 * and settled by the next guide call if the process dies in between.
 *
 * A release records `{current, outcome, entry, releasePre, releasePost}`, an
 * acquisition records `{next: {id, pre, post}, after}`. Recovery reads the
 * issue's fingerprint inside the sweep lock: the postimage means the step
 * landed, the preimage means it did not, anything else is a foreign change
 * and is never adopted or overwritten.
 *
 * Faults are injected at the session write (a crash before or after a chosen
 * write), at the issue write seam (to know when the ledger was written) and at
 * the sweep lock (fail N times). Everything else is the production path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Loose = Record<string, unknown>;
type Hook = { when: (prev: Loose | null, next: Loose) => boolean; mode: "crash-before" | "crash-after" | "after"; fn?: () => void };

const hoisted = vi.hoisted(() => ({
  hooks: [] as Hook[],
  ledgerWrites: [] as string[],
  sweepLockFailures: 0,
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

vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  const { readFileSync: read, existsSync: exists } = await import("node:fs");
  const { join: j } = await import("node:path");
  return {
    ...actual,
    writeSessionSync: (dir: string, state: Parameters<typeof actual.writeSessionSync>[1]) => {
      const path = j(dir, "state.json");
      const prev = exists(path) ? JSON.parse(read(path, "utf-8")) as Record<string, unknown> : null;
      const at = hoisted.hooks.findIndex((h) => h.when(prev, state as unknown as Record<string, unknown>));
      if (at < 0) return actual.writeSessionSync(dir, state);
      const [hook] = hoisted.hooks.splice(at, 1);
      if (hook!.mode === "crash-before") {
        hook!.fn?.();
        throw new Error("simulated crash before a session write");
      }
      const written = actual.writeSessionSync(dir, state);
      hook!.fn?.();
      if (hook!.mode === "crash-after") throw new Error("simulated crash after a session write");
      return written;
    },
  };
});

vi.mock("../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-loader.js")>();
  return {
    ...actual,
    withProjectLockForIssueSweep: async (...args: Parameters<typeof actual.withProjectLockForIssueSweep>) => {
      if (hoisted.sweepLockFailures > 0) {
        hoisted.sweepLockFailures--;
        throw new Error("simulated sweep lock failure");
      }
      return actual.withProjectLockForIssueSweep(...args);
    },
    writeIssueUnlocked: async (...args: Parameters<typeof actual.writeIssueUnlocked>) => {
      hoisted.ledgerWrites.push(args[0].id);
      return actual.writeIssueUnlocked(...args);
    },
  };
});

import { writeSessionSync } from "../../src/autonomous/session.js";
import { telemetryDirPath } from "../../src/autonomous/liveness.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";
import {
  setupProject, writeIssue, issueText, readIssue, acquiredBy, deferredAs, resolvedAs, loadedFingerprint,
  readState, eventsOfType, treeDigest, plant, report, resume, cancel,
} from "./_issue-sweep-harness.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t486-u41-recovery-"));
  setupProject(root);
  hoisted.hooks = [];
  hoisted.ledgerWrites = [];
  hoisted.sweepLockFailures = 0;
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

const marker = (s: Loose | null) => (s?.pendingProjectMutation ?? null) as Loose | null;
const isStep = (s: Loose | null, variant: string) => marker(s)?.type === "issue_sweep_step" && marker(s)?.variant === variant;
const sweepOf = (s: Loose | null) => (s?.issueSweepState ?? null) as Loose | null;

/** The write that clears a release marker: the outcome's commit point. */
const outcomeCommit = (prev: Loose | null, next: Loose) => isStep(prev, "release") && marker(next) === null;
/** The write that records an acquisition and clears its marker. */
const acquisitionRecord = (id: string) => (prev: Loose | null, next: Loose) =>
  isStep(prev, "acquire") && marker(next) === null && sweepOf(next)?.current === id;

function patchState(dir: string, patch: Partial<FullSessionState> | Loose): void {
  writeSessionSync(dir, { ...readState(dir), ...patch } as FullSessionState);
}

function editForeign(id: string, change: Loose): () => void {
  return () => {
    const p = join(root, ".story", "issues", `${id}.json`);
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf-8")), ...change }, null, 2) + "\n");
  };
}

/** ISS-001 acquired by this session and fixed; the queue behind it. */
function fixedCurrent(remaining: string[]): { sessionId: string; dir: string } {
  const planted = plant(root, { current: "ISS-001", remaining, resolved: [] });
  writeIssue(root, "ISS-001", { ...acquiredBy(planted.sessionId), status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16" });
  for (const id of remaining) writeIssue(root, id);
  return planted;
}

/** An acquisition of `id` that reached the ledger, as its marker records it. */
async function landedAcquire(sessionId: string, id: string, after: string[]): Promise<Loose> {
  writeIssue(root, id);
  const pre = await loadedFingerprint(root, id);
  writeIssue(root, id, { status: "inprogress", sweepAcquisition: { sessionId, transitionId: "issue-sweep-acquire-landed" } });
  const post = await loadedFingerprint(root, id);
  return { type: "issue_sweep_step", variant: "acquire", transitionId: "issue-sweep-acquire-landed", next: { id, pre, post }, after };
}

describe("a crash between the steps of one report (T-486 U4)", () => {
  it("T9: after the outcome, before the acquire marker: nothing is left inprogress untracked and the next report acquires the next issue", async () => {
    const { sessionId, dir } = fixedCurrent(["ISS-002", "ISS-003"]);
    hoisted.hooks.push({ when: (_p, n) => isStep(n, "acquire"), mode: "crash-before" });

    const crashed = await report(root, sessionId);
    expect(crashed.isError).toBe(true);

    const mid = readState(dir);
    expect(mid.issueSweepState?.resolved).toEqual(["ISS-001"]);
    expect(mid.issueSweepState?.current).toBeNull();
    expect(mid.issueSweepState?.remaining).toEqual(["ISS-002", "ISS-003"]);
    expect(mid.pendingProjectMutation).toBeNull();
    expect(readIssue(root, "ISS-001").sweepAcquisition).toBeUndefined();
    expect(readIssue(root, "ISS-002").status).toBe("open");
    expect(readIssue(root, "ISS-003").status).toBe("open");

    const next = await report(root, sessionId);
    expect(next.text).toContain("Fix **ISS-002**");
    const s = readState(dir);
    expect(s.issueSweepState?.current).toBe("ISS-002");
    expect(s.issueSweepState?.resolved).toEqual(["ISS-001"]);
    expect(eventsOfType(dir, "issue_sweep_complete")).toHaveLength(0);
  });

  it("T10 (S7): a crash at the release intent leaves the issue file untouched", async () => {
    const { sessionId, dir } = fixedCurrent([]);
    const before = issueText(root, "ISS-001");
    hoisted.hooks.push({ when: (_p, n) => isStep(n, "release"), mode: "crash-before" });

    await report(root, sessionId);

    expect(issueText(root, "ISS-001")).toBe(before);
    expect(hoisted.ledgerWrites).toEqual([]);
    expect(readState(dir).issueSweepState?.current).toBe("ISS-001");
  });

  const releaseCases: Array<[string, (sessionId: string) => Loose, (s: NonNullable<FullSessionState["issueSweepState"]>) => void]> = [
    ["fixed", (sid) => ({ ...acquiredBy(sid), status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16" }),
      (s) => { expect(s.resolved).toEqual(["ISS-001"]); }],
    ["deferred", (sid) => ({ ...acquiredBy(sid), ...deferredAs("owner_gated", "Owner decides.", "T-001") }),
      (s) => { expect(s.deferred).toEqual([{ id: "ISS-001", disposition: "owner_gated", reason: "Owner decides.", ref: "T-001" }]); expect(s.resolved).toEqual([]); }],
  ];
  for (const [name, fields, recorded] of releaseCases) {
    it(`T10 (S8, R-fp): ${name}, a crash after the release and before the outcome is recorded exactly once on resume`, async () => {
      const { sessionId, dir } = plant(root, { current: "ISS-001", remaining: ["ISS-002"], resolved: [] });
      writeIssue(root, "ISS-001", fields(sessionId));
      writeIssue(root, "ISS-002");
      hoisted.hooks.push({ when: outcomeCommit, mode: "crash-before" });

      await report(root, sessionId);
      const mid = readState(dir);
      expect(isStep(mid as unknown as Loose, "release")).toBe(true);
      expect(mid.issueSweepState?.current).toBe("ISS-001");
      expect(readIssue(root, "ISS-001").sweepAcquisition).toBeUndefined();

      // The session is compacted before anyone reports again.
      patchState(dir, { state: "COMPACT", preCompactState: "ISSUE_SWEEP", compactPending: true, compactPreparedAt: new Date().toISOString() });
      const resumed = await resume(root, sessionId);

      expect(resumed.text).toContain("Fix **ISS-002**");
      const s = readState(dir);
      expect(s.pendingProjectMutation).toBeNull();
      expect(s.issueSweepState?.current).toBe("ISS-002");
      recorded(s.issueSweepState!);
      expect(eventsOfType(dir, "issue_sweep_conflict")).toHaveLength(0);
    });
  }

  it("T11 (S10): a foreign edit to the acquired issue during the crash is not adopted and not overwritten", async () => {
    const { sessionId, dir } = fixedCurrent(["ISS-002", "ISS-003"]);
    hoisted.hooks.push({ when: acquisitionRecord("ISS-002"), mode: "crash-before", fn: editForeign("ISS-002", { title: "Edited elsewhere" }) });

    await report(root, sessionId);
    const foreign = issueText(root, "ISS-002");
    hoisted.ledgerWrites = [];

    const next = await report(root, sessionId);

    expect(issueText(root, "ISS-002")).toBe(foreign);
    expect(hoisted.ledgerWrites).not.toContain("ISS-002");
    const conflicts = eventsOfType(dir, "issue_sweep_conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.data).toMatchObject({ next: "ISS-002", reason: "changed" });
    const s = readState(dir);
    expect(s.issueSweepState?.current).toBe("ISS-003");
    expect(next.text).toContain("Fix **ISS-003**");
  });

  it("T11b (M-prov): another session's plain open-to-inprogress acquisition of the same issue is not adopted", async () => {
    const { sessionId, dir } = fixedCurrent(["ISS-002", "ISS-003"]);
    // The crash is armed only once the acquire intent is on disk, so it hits
    // the next session write after the ledger step, not an earlier one.
    hoisted.hooks.push({ when: (_p, n) => isStep(n, "acquire"), mode: "after", fn: () => {
      editForeign("ISS-002", { status: "inprogress" })();
      hoisted.hooks.push({ when: () => true, mode: "crash-before" });
    } });

    await report(root, sessionId);
    expect(isStep(readState(dir) as unknown as Loose, "acquire")).toBe(true);
    const foreign = issueText(root, "ISS-002");
    hoisted.ledgerWrites = [];

    await report(root, sessionId);

    expect(issueText(root, "ISS-002")).toBe(foreign);
    expect(hoisted.ledgerWrites).not.toContain("ISS-002");
    const s = readState(dir);
    expect(s.issueSweepState?.current).not.toBe("ISS-002");
    expect(s.issueSweepState?.current).toBe("ISS-003");
  });

  for (const [name, remaining, rest] of [["mid-queue", ["ISS-002", "ISS-003"], ["ISS-003"]], ["last", ["ISS-002"], []]] as const) {
    it(`T15b (M-G1): ${name}, a crash after the acquire intent and before its ledger write keeps the candidate queued`, async () => {
      const { sessionId, dir } = fixedCurrent([...remaining]);
      hoisted.hooks.push({ when: (_p, n) => isStep(n, "acquire"), mode: "crash-after" });

      await report(root, sessionId);
      const mid = readState(dir);
      expect(mid.issueSweepState?.remaining).toEqual([...remaining]);
      expect(readIssue(root, "ISS-002").status).toBe("open");

      const next = await report(root, sessionId);

      expect(next.text).toContain("Fix **ISS-002**");
      const s = readState(dir);
      expect(s.pendingProjectMutation).toBeNull();
      expect(s.issueSweepState?.current).toBe("ISS-002");
      expect(s.issueSweepState?.remaining).toEqual([...rest]);
      expect(eventsOfType(dir, "issue_sweep_complete")).toHaveLength(0);
    });
  }
});

describe("a crash in the first acquisition (T-486 U4 T15)", () => {
  it("recovery adopts the first issue with the marker's queue, and the next report moves to the second", async () => {
    const { sessionId, dir } = plant(root, null, { compact: true });
    writeIssue(root, "ISS-001", { severity: "critical" });
    writeIssue(root, "ISS-002", { severity: "high" });
    hoisted.hooks.push({ when: () => hoisted.ledgerWrites.includes("ISS-001"), mode: "crash-before" });

    await resume(root, sessionId);
    const mid = readState(dir);
    expect(isStep(mid as unknown as Loose, "acquire")).toBe(true);
    expect(mid.issueSweepState?.remaining).toEqual(["ISS-001", "ISS-002"]);
    expect(readIssue(root, "ISS-001").status).toBe("inprogress");

    const first = await report(root, sessionId);
    expect(first.text).toContain("ISS-001 is still inprogress");
    const adopted = readState(dir);
    expect(adopted.pendingProjectMutation).toBeNull();
    expect(adopted.issueSweepState?.current).toBe("ISS-001");
    expect(adopted.issueSweepState?.remaining).toEqual(["ISS-002"]);

    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), severity: "critical", status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16" });
    const second = await report(root, sessionId);
    expect(second.text).toContain("Fix **ISS-002**");
    const s = readState(dir);
    expect(s.issueSweepState?.resolved).toEqual(["ISS-001"]);
    expect(s.issueSweepState?.current).toBe("ISS-002");
  });
});

describe("malformed markers (T-486 U4 T13)", () => {
  const release: Loose = {
    type: "issue_sweep_step", variant: "release", transitionId: "t", current: "ISS-001", outcome: "fixed",
    entry: { id: "ISS-001" }, releasePre: "a", releasePost: "b",
  };
  const acquire: Loose = {
    type: "issue_sweep_step", variant: "acquire", transitionId: "t", next: { id: "ISS-002", pre: "a", post: "b" }, after: [],
  };
  const without = (m: Loose, key: string): Loose => { const { [key]: _gone, ...rest } = m; return rest; };
  const cases: Array<[string, Loose]> = [
    ...["transitionId", "current", "outcome", "entry", "releasePre", "releasePost"].map((k) => [`release without ${k}`, without(release, k)] as [string, Loose]),
    ["release whose deferred entry has no reason", { ...release, outcome: "deferred", entry: { id: "ISS-001", disposition: "owner_gated", ref: "T-001" } }],
    ["release whose entry names another issue", { ...release, entry: { id: "ISS-002" } }],
    ...["transitionId", "next", "after"].map((k) => [`acquire without ${k}`, without(acquire, k)] as [string, Loose]),
    ...["id", "pre", "post"].map((k) => [`acquire whose next has no ${k}`, { ...acquire, next: without(acquire.next as Loose, k) }] as [string, Loose]),
    ["acquire whose after holds a non-id", { ...acquire, after: [7] }],
    ["an unknown variant", { ...acquire, variant: "teleport" }],
  ];
  for (const [name, bad] of cases) {
    it(`${name}: logged as a conflict, cleared, nothing written`, async () => {
      const { sessionId, dir } = plant(root, { current: "ISS-001", remaining: [], resolved: [] });
      writeIssue(root, "ISS-001", acquiredBy(sessionId));
      writeIssue(root, "ISS-002");
      patchState(dir, { pendingProjectMutation: bad });
      const before = [issueText(root, "ISS-001"), issueText(root, "ISS-002")];

      await report(root, sessionId);

      expect([issueText(root, "ISS-001"), issueText(root, "ISS-002")]).toEqual(before);
      expect(hoisted.ledgerWrites).toEqual([]);
      const conflicts = eventsOfType(dir, "issue_sweep_conflict");
      expect(conflicts.map((e) => (e.data as Loose).reason)).toEqual(["malformed-marker"]);
      const s = readState(dir);
      expect(s.pendingProjectMutation).toBeNull();
      expect(s.issueSweepState?.current).toBe("ISS-001");
    });
  }
});

describe("a referenced entity deleted after the release intent (T-486 U4-1 fixup)", () => {
  // The issue's fingerprint cannot see the entity it references, so the issue
  // still matches releasePre. The release is written only while the fresh
  // classification still gives the marker's outcome.
  const refCases: Array<[string, (sessionId: string) => Loose, RegExp]> = [
    ["a deferral whose ref is an issue", (sid) => ({ ...acquiredBy(sid), ...deferredAs("owner_gated", "Owner decides.", "ISS-050") }),
      /dispositionRef: --ref ISS-050 names no ticket, issue, note, lesson or ruling/],
    ["a duplicate", (sid) => ({ ...acquiredBy(sid), ...resolvedAs("duplicate", "Same as ISS-050.", { duplicateOf: "ISS-050" }) }),
      /duplicateOf: --duplicate-of ISS-050 names no ticket or issue/],
  ];
  const deleteTarget = () => rmSync(join(root, ".story", "issues", "ISS-050.json"));

  function expectNothingRecorded(dir: string, before: string): void {
    expect(issueText(root, "ISS-001")).toBe(before);
    expect(hoisted.ledgerWrites).not.toContain("ISS-001");
    const s = readState(dir);
    expect(s.pendingProjectMutation ?? null).toBeNull();
    expect(s.issueSweepState?.current).toBe("ISS-001");
    expect(s.issueSweepState?.resolved).toEqual([]);
    expect(s.issueSweepState?.disposed ?? []).toEqual([]);
    expect(s.issueSweepState?.deferred ?? []).toEqual([]);
    expect(s.issueSweepState?.conflicted ?? []).toEqual([]);
  }

  for (const [name, fields, refusal] of refCases) {
    it(`live (M-relive): ${name}, target deleted between the intent and the release lock`, async () => {
      const { sessionId, dir } = plant(root, { current: "ISS-001", remaining: ["ISS-002"], resolved: [] });
      writeIssue(root, "ISS-050");
      writeIssue(root, "ISS-001", fields(sessionId));
      writeIssue(root, "ISS-002");
      const before = issueText(root, "ISS-001");
      hoisted.hooks.push({ when: (_p, n) => isStep(n, "release"), mode: "after", fn: deleteTarget });

      const r = await report(root, sessionId);

      expect(r.text).toMatch(refusal);
      expectNothingRecorded(dir, before);
      expect(readIssue(root, "ISS-002").status).toBe("open");
    });

    it(`recovery (M-rerec): ${name}, target deleted between the intent and recovery`, async () => {
      const { sessionId, dir } = plant(root, { current: "ISS-001", remaining: ["ISS-002"], resolved: [] });
      writeIssue(root, "ISS-050");
      writeIssue(root, "ISS-001", fields(sessionId));
      writeIssue(root, "ISS-002");
      const before = issueText(root, "ISS-001");
      hoisted.hooks.push({ when: (_p, n) => isStep(n, "release"), mode: "crash-after" });
      await report(root, sessionId);
      expect(isStep(readState(dir) as unknown as Loose, "release")).toBe(true);
      deleteTarget();

      const r = await report(root, sessionId);

      expect(r.text).toMatch(refusal);
      expectNothingRecorded(dir, before);
      expect(readIssue(root, "ISS-002").status).toBe("open");
    });
  }
});

describe("cancel with a release pending (T-486 U4 T14)", () => {
  it("records the outcome, clears the marker, and recovery writes nothing under telemetry/", async () => {
    const { sessionId, dir } = plant(root, { current: "ISS-001", remaining: [], resolved: [] });
    const resolvedFields = { status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16" };
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedFields });
    const releasePre = await loadedFingerprint(root, "ISS-001");
    writeIssue(root, "ISS-001", resolvedFields);
    const releasePost = await loadedFingerprint(root, "ISS-001");
    // The sweep runs once the ticket cap is reached, so cancel's soft gate
    // (tickets remaining in a working state) stands down.
    patchState(dir, { config: { ...readState(dir).config, maxTicketsPerSession: 1 } });
    patchState(dir, { pendingProjectMutation: {
      type: "issue_sweep_step", variant: "release", transitionId: "issue-sweep-release-t14", current: "ISS-001",
      outcome: "fixed", entry: { id: "ISS-001" }, releasePre, releasePost,
    } });
    const telemetry = telemetryDirPath(dir);
    const before = treeDigest(telemetry);
    let atRecovery: Record<string, string> | null = null;
    let recoveredState: Loose | null = null;
    hoisted.hooks.push({ when: outcomeCommit, mode: "after", fn: () => {
      atRecovery = treeDigest(telemetry);
      recoveredState = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as Loose;
    } });

    await cancel(root, sessionId);

    expect(atRecovery).toEqual(before);
    expect(marker(recoveredState)).toBeNull();
    expect((sweepOf(recoveredState) as Loose).resolved).toEqual(["ISS-001"]);
    expect(readState(dir).pendingProjectMutation ?? null).toBeNull();
    expect(existsSync(dir)).toBe(true);
  });
});

describe("a resume reaches the sweep's conflict handling (T-486 U4 T12r)", () => {
  // The guide's start and report refuse any board with merge conflicts before
  // a stage runs; resume does not, and its recovery of a pending release
  // classifies the current issue inside the sweep lock.
  it("a pending release whose issue now carries merge conflicts is listed as conflicted, never written", async () => {
    const { sessionId, dir } = plant(root, { current: "ISS-001", remaining: ["ISS-002"], resolved: [] }, { compact: true });
    const resolvedFields = { status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16" };
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedFields });
    const releasePre = await loadedFingerprint(root, "ISS-001");
    writeIssue(root, "ISS-001", resolvedFields);
    const releasePost = await loadedFingerprint(root, "ISS-001");
    writeIssue(root, "ISS-001", { ...acquiredBy(sessionId), ...resolvedFields, _conflicts: [{ fieldPath: "/title", field: "title", kind: "field", base: "x", ours: "a", theirs: "b" }] });
    writeIssue(root, "ISS-002");
    patchState(dir, { pendingProjectMutation: {
      type: "issue_sweep_step", variant: "release", transitionId: "issue-sweep-release-t12r", current: "ISS-001",
      outcome: "fixed", entry: { id: "ISS-001" }, releasePre, releasePost,
    } });
    const before = issueText(root, "ISS-001");

    const r = await resume(root, sessionId);

    expect(issueText(root, "ISS-001")).toBe(before);
    const s = readState(dir);
    expect(s.pendingProjectMutation).toBeNull();
    expect(s.issueSweepState?.conflicted).toEqual([{ id: "ISS-001", reason: "unresolved merge conflicts" }]);
    expect(s.issueSweepState?.resolved).toEqual([]);
    expect(s.issueSweepState?.current).toBe("ISS-002");
    expect(r.text).toContain("Fix **ISS-002**");
  });
});

describe("an unconfirmed step blocks the call (T-486 U4 T16f3)", () => {
  it("a landed acquisition whose recovery cannot take the lock returns the pending error and changes nothing", async () => {
    const { sessionId, dir } = plant(root, { current: null, remaining: ["ISS-002", "ISS-003"], resolved: ["ISS-001"] });
    writeIssue(root, "ISS-003");
    const pending = await landedAcquire(sessionId, "ISS-002", ["ISS-003"]);
    patchState(dir, { pendingProjectMutation: pending });
    const markerBefore = JSON.stringify(readState(dir).pendingProjectMutation);
    const sweepBefore = JSON.stringify(readState(dir).issueSweepState);
    const issuesBefore = [issueText(root, "ISS-002"), issueText(root, "ISS-003")];
    hoisted.sweepLockFailures = 1;

    const r = await report(root, sessionId);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("The issue sweep's last step could not be confirmed (simulated sweep lock failure)");
    const s = readState(dir);
    expect(JSON.stringify(s.pendingProjectMutation)).toBe(markerBefore);
    expect(JSON.stringify(s.issueSweepState)).toBe(sweepBefore);
    expect([issueText(root, "ISS-002"), issueText(root, "ISS-003")]).toEqual(issuesBefore);
    expect(hoisted.ledgerWrites).toEqual([]);
    expect(eventsOfType(dir, "issue_sweep_complete")).toHaveLength(0);
  });
});

describe("resume keeps the sweep's record (T-486 U4 T22, T23)", () => {
  const lists = {
    disposed: [{ id: "ISS-004", kind: "wontfix" }],
    deferred: [{ id: "ISS-005", disposition: "owner_gated", reason: "Owner decides.", ref: "T-001" }],
  };

  it("T22 (M-G2): a COMPACT resume shows the current issue and acquires nothing", async () => {
    const { sessionId, dir } = plant(root, { current: "ISS-002", remaining: ["ISS-003"], resolved: ["ISS-001"], ...lists }, { compact: true });
    writeIssue(root, "ISS-002", acquiredBy(sessionId));
    writeIssue(root, "ISS-003");
    const before = [issueText(root, "ISS-002"), issueText(root, "ISS-003")];

    const r = await resume(root, sessionId);

    expect(r.text).toContain("Fix **ISS-002**");
    expect([issueText(root, "ISS-002"), issueText(root, "ISS-003")]).toEqual(before);
    expect(hoisted.ledgerWrites).toEqual([]);
    const s = readState(dir).issueSweepState!;
    expect(s).toMatchObject({ current: "ISS-002", remaining: ["ISS-003"], resolved: ["ISS-001"], ...lists, conflicted: [] });
  });

  it("T23: a resume that first recovers a landed acquisition shows that issue and keeps the earlier lists", async () => {
    const { sessionId, dir } = plant(root, { current: null, remaining: ["ISS-002", "ISS-003"], resolved: ["ISS-001"], ...lists }, { compact: true });
    writeIssue(root, "ISS-003");
    patchState(dir, { pendingProjectMutation: await landedAcquire(sessionId, "ISS-002", ["ISS-003"]) });

    const r = await resume(root, sessionId);

    expect(r.text).toContain("Fix **ISS-002**");
    const s = readState(dir);
    expect(s.pendingProjectMutation).toBeNull();
    expect(s.issueSweepState).toMatchObject({ current: "ISS-002", remaining: ["ISS-003"], resolved: ["ISS-001"], ...lists });
    expect(readIssue(root, "ISS-003").status).toBe("open");
  });
});
