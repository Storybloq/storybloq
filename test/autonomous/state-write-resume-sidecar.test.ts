/**
 * ISS-958 S3, exception (iv): handleResume keeps a sidecar a resume write
 * already published.
 *
 * Before ISS-958 the resume catch killed the freshly spawned sidecar on ANY
 * failure. Once a resume write has published `sidecarPid`, the session owns
 * that sidecar, so a later failure (plain or typed) must leave it running,
 * and so must a published-but-undurable resume write itself. A failure
 * before anything is published still kills it, as before.
 *
 * The spawn and kill are mocked so the test observes exactly which pid the
 * catch signals; git is mocked as in handle-resume.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { wrapFs } = await import("./_state-write-fault.js");
  return wrapFs(actual);
});

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
}));

const SIDECAR_PID = 987654321;
const killed: Array<number | null | undefined> = [];

vi.mock("../../src/autonomous/liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/liveness.js")>();
  return {
    ...actual,
    spawnAliveSidecarFor: (sessionDir: string) => ({ kind: "spawned", pid: SIDECAR_PID, dir: actual.telemetryDirPath(sessionDir) }),
    killSidecar: (pid: number | null | undefined) => { killed.push(pid); },
  };
});

/** Set to throw from the first removeResumeMarker after a resume write. */
const later: { fail: null | (() => never) } = { fail: null };

vi.mock("../../src/autonomous/resume-marker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/resume-marker.js")>();
  return {
    ...actual,
    removeResumeMarker: (root: string) => {
      const f = later.fail;
      if (f) { later.fail = null; f(); }
      return actual.removeResumeMarker(root);
    },
  };
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitHead } from "../../src/autonomous/git-inspector.js";
import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import {
  StateWriteUndurableError,
  createSession,
  prepareForCompact,
  readSession,
  writeSessionSync,
} from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { armFail, armUndurable, disarm, faultFired } from "./_state-write-fault.js";

let root: string;

function setupProject(dir: string): void {
  const story = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "iss958-s3-resume", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-10-04",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(story, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-10-04",
    blockedBy: [], parentTicket: null,
  }));
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function createCompactSession(): { id: string; dir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const dir = join(root, ".story", "sessions", session.sessionId);
  const working = writeSessionSync(dir, {
    ...session,
    state: "PLAN",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123", itemBaseHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  prepareForCompact(dir, working, { expectedHead: "abc123" });
  return { id: session.sessionId, dir };
}

function armTyped(dir: string): void {
  armUndurable(
    (published) => new StateWriteUndurableError(published as FullSessionState, new Error("EIO: injected dir fsync failure")),
    (d) => readSession(d),
    { dir },
  );
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss958-s3-resume-"));
  setupProject(root);
  killed.length = 0;
  later.fail = null;
  vi.mocked(gitHead).mockResolvedValue({ ok: true, data: { hash: "abc123", branch: "main" } });
});

afterEach(() => {
  disarm();
  later.fail = null;
  rmSync(root, { recursive: true, force: true });
});

const branches = [
  { name: "main (HEAD matches)", head: "abc123" },
  { name: "drift (HEAD changed)", head: "def456" },
] as const;

describe.each(branches)("ISS-958 S3: handleResume sidecar, $name branch", ({ head }) => {
  beforeEach(() => {
    vi.mocked(gitHead).mockResolvedValue({ ok: true, data: { hash: head, branch: "main" } });
  });

  it("an undurable resume write keeps the published sidecar and surfaces the typed error", async () => {
    const { id, dir } = createCompactSession();
    armTyped(dir);
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id });
    expect(faultFired()).toBe(true);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("durability");
    expect(readSession(dir)!.sidecarPid).toBe(SIDECAR_PID);
    expect(killed).not.toContain(SIDECAR_PID);
  });

  it("a pre-rename failure kills the sidecar, as before", async () => {
    const { id, dir } = createCompactSession();
    armFail({ dir });
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id });
    expect(faultFired()).toBe(true);
    expect(result.isError).toBe(true);
    expect(readSession(dir)!.state).toBe("COMPACT");
    expect(killed).toContain(SIDECAR_PID);
  });

  it("a plain failure after a successful resume write keeps the sidecar (deliberate change)", async () => {
    const { id, dir } = createCompactSession();
    later.fail = () => { throw new Error("EIO: injected later failure"); };
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("injected later failure");
    expect(readSession(dir)!.sidecarPid).toBe(SIDECAR_PID);
    expect(killed).not.toContain(SIDECAR_PID);
  });

  it("a typed failure after a successful resume write keeps the sidecar", async () => {
    const { id, dir } = createCompactSession();
    later.fail = () => {
      throw new StateWriteUndurableError({ ...readSession(dir)!, sidecarPid: undefined } as FullSessionState, new Error("EIO: injected"));
    };
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id });
    expect(result.isError).toBe(true);
    expect(readSession(dir)!.sidecarPid).toBe(SIDECAR_PID);
    expect(killed).not.toContain(SIDECAR_PID);
  });
});

describe("ISS-958 S3: the fixture reaches both resume branches", () => {
  it("drift recovery writes the drift event and main resume does not", async () => {
    const a = createCompactSession();
    vi.mocked(gitHead).mockResolvedValue({ ok: true, data: { hash: "def456", branch: "main" } });
    await handleAutonomousGuide(root, { action: "resume", sessionId: a.id });
    expect(readFileSync(join(a.dir, "events.log"), "utf-8")).toContain("resume_conflict");
  });
});
