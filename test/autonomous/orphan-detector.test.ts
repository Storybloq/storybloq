/**
 * ISS-383: unit + integration coverage for the hoisted orphan-check API.
 *
 * - isOrphanCandidate: cheap, IO-free metadata precheck
 * - isFinishedOrphan(ctx): same answer as the no-ctx form when given a
 *   pre-loaded project state + HEAD sha, so callers can hoist loadProject +
 *   gitHeadHash out of a per-session loop.
 */
import { describe, expect, it, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isFinishedOrphan,
  isOrphanCandidate,
  type OrphanCheckContext,
} from "../../src/autonomous/orphan-detector.js";
import { appendEvent, createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { loadProject } from "../../src/core/project-loader.js";
import { gitHeadHash } from "../../src/autonomous/git-inspector.js";

const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeStateLike(overrides: Partial<FullSessionState>): FullSessionState {
  // Minimum shape isOrphanCandidate touches: mode, targetWork, lease.expiresAt.
  // Cast through unknown — the precheck only reads four fields, so we don't
  // need a full FullSessionState here.
  return {
    mode: "auto",
    targetWork: ["ISS-1"],
    lease: { expiresAt: new Date(Date.now() - 120 * 60 * 1000).toISOString() },
    ...overrides,
  } as unknown as FullSessionState;
}

describe("isOrphanCandidate (cheap, IO-free precheck)", () => {
  it("returns true for an auto-mode session with targetWork and a buffer-expired lease", () => {
    expect(isOrphanCandidate(makeStateLike({}))).toBe(true);
  });

  it("returns false when mode is not auto", () => {
    expect(isOrphanCandidate(makeStateLike({ mode: "guided" as FullSessionState["mode"] }))).toBe(false);
    expect(isOrphanCandidate(makeStateLike({ mode: "review" as FullSessionState["mode"] }))).toBe(false);
    expect(isOrphanCandidate(makeStateLike({ mode: "plan" as FullSessionState["mode"] }))).toBe(false);
  });

  it("returns false when targetWork is empty or missing", () => {
    expect(isOrphanCandidate(makeStateLike({ targetWork: [] }))).toBe(false);
    expect(
      isOrphanCandidate(makeStateLike({ targetWork: undefined as unknown as string[] })),
    ).toBe(false);
  });

  it("returns false when the lease expiresAt is missing or unparseable", () => {
    expect(
      isOrphanCandidate(makeStateLike({ lease: { expiresAt: "" } as FullSessionState["lease"] })),
    ).toBe(false);
    expect(
      isOrphanCandidate(makeStateLike({ lease: { expiresAt: "not a date" } as FullSessionState["lease"] })),
    ).toBe(false);
    expect(
      isOrphanCandidate(makeStateLike({ lease: undefined as unknown as FullSessionState["lease"] })),
    ).toBe(false);
  });

  it("returns false when the lease is inside the 60-minute debris buffer", () => {
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(
      isOrphanCandidate(
        makeStateLike({ lease: { expiresAt: recent } as FullSessionState["lease"] }),
      ),
    ).toBe(false);
  });
});

describe("isFinishedOrphan with hoisted ctx (ISS-383)", () => {
  function buildResolvedFixture(): { root: string; dir: string; state: FullSessionState } {
    const root = mkdtempSync(join(tmpdir(), "iss383-"));
    createdRoots.push(root);
    const story = join(root, ".story");
    mkdirSync(join(story, "tickets"), { recursive: true });
    mkdirSync(join(story, "issues"), { recursive: true });
    mkdirSync(join(story, "notes"), { recursive: true });
    mkdirSync(join(story, "lessons"), { recursive: true });
    mkdirSync(join(story, "handovers"), { recursive: true });
    mkdirSync(join(story, "sessions"), { recursive: true });
    writeFileSync(
      join(story, "config.json"),
      JSON.stringify({
        version: 2,
        schemaVersion: 1,
        project: "iss383-fixture",
        type: "npm",
        language: "typescript",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      }),
    );
    writeFileSync(
      join(story, "roadmap.json"),
      JSON.stringify({
        title: "iss383",
        date: "2026-04-11",
        phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "" }],
        blockers: [],
      }),
    );
    writeFileSync(
      join(story, "issues", "ISS-9001.json"),
      JSON.stringify({
        id: "ISS-9001",
        title: "Resolved fixture",
        status: "resolved",
        severity: "low",
        components: [],
        impact: "fixture",
        resolution: "fixed",
        location: [],
        discoveredDate: "2026-04-11",
        resolvedDate: "2026-04-11",
        relatedTickets: [],
        order: 10,
        phase: "p1",
      }),
    );

    run("git init -q -b main", root);
    run("git config user.email t@t.com", root);
    run("git config user.name t", root);
    writeFileSync(join(root, "README.md"), "# fixture\n");
    run("git add .", root);
    run("git commit -q -m initial", root);
    writeFileSync(join(root, "ISS_9001.txt"), "fix\n");
    run("git add ISS_9001.txt", root);
    run('git commit -q -m "fix ISS-9001"', root);
    const head = run("git rev-parse HEAD", root);

    const wsId = deriveWorkspaceId(root);
    const session = createSession(root, "coding", wsId);
    const dir = join(story, "sessions", session.sessionId);
    const expiresAt = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    const state: FullSessionState = {
      ...session,
      mode: "auto",
      targetWork: ["ISS-9001"],
      lease: { ...session.lease, expiresAt },
    };
    writeSessionSync(dir, state);
    appendEvent(dir, {
      rev: 1,
      type: "commit",
      timestamp: new Date().toISOString(),
      data: { commitHash: head, issueId: "ISS-9001" },
    });

    return { root, dir, state };
  }

  it("returns the same answer with and without an explicit ctx", async () => {
    const { root, dir, state } = buildResolvedFixture();

    // Without ctx — current callers' single-call path.
    const withoutCtx = await isFinishedOrphan(state, dir, root);
    expect(withoutCtx).toBe(true);

    // With ctx — hoisted path. Pre-load project + HEAD once and pass them in.
    const { state: projectState } = await loadProject(root);
    const headResult = await gitHeadHash(root);
    expect(headResult.ok).toBe(true);
    const ctx: OrphanCheckContext = {
      projectState,
      headSha: headResult.ok ? headResult.data : "",
    };
    const withCtx = await isFinishedOrphan(state, dir, root, ctx);
    expect(withCtx).toBe(true);
  });

  it("respects the cheap precheck before consuming ctx", async () => {
    const { root, dir, state } = buildResolvedFixture();

    // Stale ctx, but the state's mode disqualifies it before ctx is read.
    const fakeCtx = { projectState: {} as never, headSha: "deadbeef" } as OrphanCheckContext;
    const notAuto = { ...state, mode: "review" as FullSessionState["mode"] };
    expect(await isFinishedOrphan(notAuto, dir, root, fakeCtx)).toBe(false);
  });
});
