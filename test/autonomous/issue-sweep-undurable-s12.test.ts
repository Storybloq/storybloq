/**
 * T-486 U4-3 (row S12): the sweep's outcome write is published but not proven
 * durable.
 *
 * The release path writes twice: W1 records the release intent before the
 * ledger write, W2 records the outcome and clears the intent after it. Either
 * can fail after its rename landed (ISS-958's StateWriteUndurableError). The
 * report must surface that error, never swallow it, and the next entry must
 * record the outcome exactly once whether the published state survived or
 * not. The failure is the real writer's: the hook throws at ISS-958's own
 * "state:renamed" seam, and `lose` then puts back the bytes state.json held
 * before that write, as a power loss would.
 *
 * Every case runs a clean control in its own root first; the issue's bytes
 * after the fault and its recovery must equal the control's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Loose = Record<string, unknown>;
type Hook = {
  when: (prev: Loose | null, next: Loose) => boolean;
  mode: "undurable" | "after";
  lose?: boolean;
  /** Runs once the hooked write has done its part: after it, or in the undurable catch before the rethrow. */
  fn?: () => void;
};

const hoisted = vi.hoisted(() => ({
  hooks: [] as Hook[],
  ledgerWrites: [] as string[],
  seam: "state:renamed",
  spawns: 0,
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

vi.mock("../../src/autonomous/liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/liveness.js")>();
  return {
    ...actual,
    // No sidecar may write under telemetry/ while a case runs; the shape is
    // the one a failed spawn returns.
    spawnAliveSidecarFor: (sessionDir: string, generationId?: unknown) => {
      hoisted.spawns++;
      const location = actual.resolveTelemetryLocation(sessionDir, generationId);
      if (location.kind === "unusable") return { kind: "unusable" as const, reason: location.reason };
      return { kind: "spawned" as const, pid: null, dir: location.dir };
    },
  };
});

vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  const { readFileSync: read, writeFileSync: write, existsSync: exists } = await import("node:fs");
  const { join: j } = await import("node:path");
  return {
    ...actual,
    writeSessionSync: (dir: string, state: Parameters<typeof actual.writeSessionSync>[1]) => {
      const path = j(dir, "state.json");
      const prevText = exists(path) ? read(path, "utf-8") : null;
      const prev = prevText === null ? null : JSON.parse(prevText) as Record<string, unknown>;
      const at = hoisted.hooks.findIndex((h) => h.when(prev, state as unknown as Record<string, unknown>));
      if (at < 0) return actual.writeSessionSync(dir, state);
      const [hook] = hoisted.hooks.splice(at, 1);
      if (hook!.mode === "after") {
        const written = actual.writeSessionSync(dir, state);
        hook!.fn?.();
        return written;
      }
      const seams = actual.__stateWriteTesting;
      const original = seams.at;
      seams.at = (point: string) => {
        if (point === hoisted.seam) throw new Error("simulated durability failure");
        original(point);
      };
      try {
        return actual.writeSessionSync(dir, state);
      } catch (err) {
        if (hook!.lose && prevText !== null) write(path, prevText);
        hook!.fn?.();
        throw err;
      } finally {
        seams.at = original;
      }
    },
  };
});

vi.mock("../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-loader.js")>();
  return {
    ...actual,
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
  setupProject, writeIssue, issueText, readIssue, acquiredBy, deferredAs,
  readState, stateText, eventsOfType, treeDigest, plant, report, resume, type GuideCall,
} from "./_issue-sweep-harness.js";

const roots: string[] = [];

function freshRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `t486-u43-${tag}-`));
  setupProject(r);
  roots.push(r);
  return r;
}

beforeEach(() => {
  hoisted.hooks = [];
  hoisted.ledgerWrites = [];
  hoisted.seam = "state:renamed";
  hoisted.spawns = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date());
});

afterEach(() => {
  vi.useRealTimers();
  for (const r of roots.splice(0)) {
    killSidecarsInRoot(r);
    rmSync(r, { recursive: true, force: true });
  }
});

const marker = (s: Loose | null) => (s?.pendingProjectMutation ?? null) as Loose | null;
const isStep = (s: Loose | null, variant: string) => marker(s)?.type === "issue_sweep_step" && marker(s)?.variant === variant;
/** W1: the write that records the release intent. */
const releaseIntent = (_prev: Loose | null, next: Loose) => isStep(next, "release");
/** W2: the write that clears a release marker, the outcome's commit point. */
const outcomeCommit = (prev: Loose | null, next: Loose) => isStep(prev, "release") && marker(next) === null;

const writesTo = (id: string) => hoisted.ledgerWrites.filter((w) => w === id).length;

function patchState(dir: string, patch: Partial<FullSessionState> | Loose): void {
  writeSessionSync(dir, { ...readState(dir), ...patch } as FullSessionState);
}

function compact(dir: string): void {
  patchState(dir, { state: "COMPACT", preCompactState: "ISSUE_SWEEP", compactPending: true, compactPreparedAt: new Date().toISOString() });
}

/** How many times `id` appears across the sweep's outcome lists. */
function outcomesOf(dir: string, id: string): number {
  const s = readState(dir).issueSweepState!;
  return s.resolved.filter((r) => r === id).length
    + (s.disposed ?? []).filter((d) => d.id === id).length
    + (s.deferred ?? []).filter((d) => d.id === id).length;
}

type Outcome = { name: string; fields: (sessionId: string) => Loose };
const OUTCOMES: Outcome[] = [
  { name: "fixed", fields: (sid) => ({ ...acquiredBy(sid), status: "resolved", resolution: "Fixed.", resolvedDate: "2026-10-16" }) },
  { name: "deferred", fields: (sid) => ({ ...acquiredBy(sid), ...deferredAs("owner_gated", "Owner decides.", "T-001") }) },
];

/** ISS-001 acquired by this session and finished by the agent; ISS-002 behind it. */
function fixture(root: string, outcome: Outcome): { sessionId: string; dir: string } {
  const planted = plant(root, { current: "ISS-001", remaining: ["ISS-002"], resolved: [] });
  writeIssue(root, "ISS-001", outcome.fields(planted.sessionId));
  writeIssue(root, "ISS-002");
  return planted;
}

/** ISS-001's bytes after one clean report, in a root of its own. */
async function controlBytes(outcome: Outcome): Promise<string> {
  const root = freshRoot("control");
  const { sessionId } = fixture(root, outcome);
  const r = await report(root, sessionId);
  expect(r.isError).toBe(false);
  expect(r.text).toContain("Fix **ISS-002**");
  const bytes = issueText(root, "ISS-001");
  hoisted.ledgerWrites = [];
  hoisted.spawns = 0;
  return bytes;
}

/** The sweep's queue and outcome lists, an absent list read as empty (the resume writes them all out). */
function listsOf(s: FullSessionState): Loose {
  const w = s.issueSweepState!;
  return {
    remaining: w.remaining, current: w.current, resolved: w.resolved,
    disposed: w.disposed ?? [], deferred: w.deferred ?? [], conflicted: w.conflicted ?? [],
  };
}

/** Every file under telemetry/, by relative path, to its text. */
function telemetryFiles(dir: string): Record<string, string> {
  return Object.fromEntries(Object.keys(treeDigest(dir)).map((k) => [k, readFileSync(join(dir, k), "utf-8")]));
}

function errorText(r: GuideCall): string {
  return `${r.text}\n${r.thrown?.name ?? ""} ${r.thrown?.message ?? ""}`;
}

/** Finishes ISS-002 the way the agent would, keeping the sweep's acquisition. */
function fixIss002(root: string): void {
  const p = join(root, ".story", "issues", "ISS-002.json");
  writeFileSync(p, JSON.stringify({ ...readIssue(root, "ISS-002"), status: "resolved", resolution: "Fixed too.", resolvedDate: "2026-10-16" }, null, 2) + "\n");
}

type Case = {
  id: string;
  title: string;
  write: "W1" | "W2";
  lose: boolean;
  /** The crash image, checked before the next entry. */
  crashed: (ctx: { root: string; dir: string; before: string; atW1: string | null }) => void;
};

const CASES: Case[] = [
  {
    id: "S12a", title: "W1 undurable, the published intent kept", write: "W1", lose: false,
    crashed: ({ dir }) => {
      expect(writesTo("ISS-001")).toBe(0);
      expect(isStep(readState(dir) as unknown as Loose, "release")).toBe(true);
    },
  },
  {
    id: "S12b", title: "W1 undurable, the published intent lost", write: "W1", lose: true,
    crashed: ({ dir, before }) => {
      expect(writesTo("ISS-001")).toBe(0);
      expect(stateText(dir)).toBe(before);
    },
  },
  {
    id: "S12c", title: "W2 undurable, the published outcome kept", write: "W2", lose: false,
    crashed: ({ dir }) => {
      expect(writesTo("ISS-001")).toBe(1);
      const s = readState(dir);
      expect(s.pendingProjectMutation ?? null).toBeNull();
      expect(s.issueSweepState?.current).toBeNull();
      expect(outcomesOf(dir, "ISS-001")).toBe(1);
    },
  },
  {
    id: "S12d", title: "W2 undurable, the published outcome lost", write: "W2", lose: true,
    crashed: ({ dir, atW1 }) => {
      expect(writesTo("ISS-001")).toBe(1);
      expect(atW1).not.toBeNull();
      expect(stateText(dir)).toBe(atW1);
      expect(isStep(readState(dir) as unknown as Loose, "release")).toBe(true);
    },
  },
];

describe("the sweep's outcome write published but not proven durable (T-486 U4-3, S12)", () => {
  for (const c of CASES) {
    for (const outcome of OUTCOMES) {
      for (const entry of ["report", "compact-resume"] as const) {
        it(`${c.id}: ${c.title} (${outcome.name}, next entry by ${entry}): the report errors and the outcome is recorded exactly once`, async () => {
          const expected = await controlBytes(outcome);

          const root = freshRoot("fault");
          const { sessionId, dir } = fixture(root, outcome);
          const telemetry = telemetryDirPath(dir);
          const before = stateText(dir);
          let baseline = treeDigest(telemetry);
          let observed = 0;
          let observedDigest: Record<string, string> | null = null;
          const observe = () => { observed++; observedDigest = treeDigest(telemetry); };
          let atW1: string | null = null;

          if (c.write === "W1") {
            hoisted.hooks.push({ when: releaseIntent, mode: "undurable", lose: c.lose });
          } else {
            hoisted.hooks.push({ when: releaseIntent, mode: "after", fn: () => { atW1 = stateText(dir); } });
            hoisted.hooks.push({ when: outcomeCommit, mode: "undurable", lose: c.lose, ...(c.id === "S12c" && { fn: observe }) });
          }

          const failed = await report(root, sessionId);
          expect(failed.isError).toBe(true);
          expect(errorText(failed)).toMatch(/StateWriteUndurableError|durability barriers did not complete/);
          expect(hoisted.hooks.filter((h) => h.mode === "undurable")).toHaveLength(0);
          c.crashed({ root, dir, before, atW1 });

          // The designated observation for the cases whose outcome commit
          // succeeds on the next entry: the moment that commit lands.
          if (c.id !== "S12c") hoisted.hooks.push({ when: outcomeCommit, mode: "after", fn: observe });

          if (entry === "report") {
            const next = await report(root, sessionId);
            expect(next.text).toContain("Fix **ISS-002**");
          } else {
            compact(dir);
            const preResume = { telemetry: telemetryFiles(telemetry), issue: issueText(root, "ISS-001"), sweep: listsOf(readState(dir)) };
            const resumed = await resume(root, sessionId);
            expect(resumed.isError).toBe(false);
            expect(hoisted.spawns).toBeGreaterThan(0);
            if (c.id === "S12b") {
              const s = readState(dir);
              expect(s.pendingProjectMutation ?? null).toBeNull();
              expect(s.issueSweepState?.current).toBe("ISS-001");
              // The resume writes its own "session_resumed" telemetry event
              // (guide.ts emitTelemetry) before this outcome commits, so the
              // observation is measured from here: nothing the commit's report
              // does may add to it. The re-take is only sound when the resume
              // changed nothing else: that one appended line and its line count
              // under telemetry/, ISS-001 and the sweep's lists untouched.
              expect(eventsOfType(dir, "resumed")).toHaveLength(1);
              expect(issueText(root, "ISS-001")).toBe(preResume.issue);
              expect(listsOf(s)).toEqual(preResume.sweep);
              const postResume = telemetryFiles(telemetry);
              const changed = Object.keys({ ...preResume.telemetry, ...postResume })
                .filter((k) => preResume.telemetry[k] !== postResume[k]).sort();
              expect(changed).toEqual(["events.jsonl", "events.jsonl.lines"]);
              const oldLines = (preResume.telemetry["events.jsonl"] ?? "").split("\n").filter(Boolean);
              const newLines = postResume["events.jsonl"]!.split("\n").filter(Boolean);
              expect(newLines.slice(0, oldLines.length)).toEqual(oldLines);
              expect(newLines.slice(oldLines.length).map((l) => (JSON.parse(l) as Loose).type)).toEqual(["session_resumed"]);
              expect(Number(postResume["events.jsonl.lines"]!.trim())).toBe(newLines.length);
              baseline = treeDigest(telemetry);
              const after = await report(root, sessionId);
              expect(after.text).toContain("Fix **ISS-002**");
            } else {
              expect(resumed.text).toContain("Fix **ISS-002**");
            }
          }

          expect(observed).toBe(1);
          expect(observedDigest).toEqual(baseline);

          const s = readState(dir);
          expect(s.pendingProjectMutation ?? null).toBeNull();
          expect(s.issueSweepState?.current).toBe("ISS-002");
          expect(writesTo("ISS-001")).toBe(1);
          expect(writesTo("ISS-002")).toBe(1);
          expect(outcomesOf(dir, "ISS-001")).toBe(1);
          expect(issueText(root, "ISS-001")).toBe(expected);

          // The sweep completes once ISS-002 is finished, and only once.
          expect(eventsOfType(dir, "issue_sweep_complete")).toHaveLength(0);
          fixIss002(root);
          await report(root, sessionId);
          expect(eventsOfType(dir, "issue_sweep_complete")).toHaveLength(1);
          await report(root, sessionId);
          expect(eventsOfType(dir, "issue_sweep_complete")).toHaveLength(1);
          expect(outcomesOf(dir, "ISS-001")).toBe(1);
          expect(outcomesOf(dir, "ISS-002")).toBe(1);
          expect(existsSync(dir)).toBe(true);
          expect(readFileSync(join(root, ".story", "issues", "ISS-001.json"), "utf-8")).toBe(expected);
        });
      }
    }
  }
});
