import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { readSession } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

/**
 * T-328 / D1: backward compatibility for the legacy "none" spelling, driven
 * through the real entry points rather than through the parser.
 *
 * Unit-testing parseBranchStrategy proves the mapping exists. It does not prove
 * that a project sitting on disk today, whose config and state.json both say
 * "none", still starts and resumes after the upgrade. Two zod schemas run ahead
 * of any normalization the guide does, so that has to be exercised end to end.
 *
 * Migration semantics being asserted (deliberately NOT byte-for-byte
 * immutability, which would contradict how the guide saves state): reading an
 * old file does not rewrite it, and what must hold across a save is that the
 * MEANING is preserved and that unrelated fields survive the round trip.
 *
 * ISS-902 amended which spelling that save may use. This file originally
 * asserted that an ordinary save persists the canonical "current"; persisting
 * it is what bricked in-flight sessions for every reader shipped before T-328,
 * so the no-op strategy now persists the legacy "none" and normalizes back on
 * read. The assertion below is that replacement, not a weakened version of the
 * old one: canonical in memory, legacy on disk.
 */

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function currentBranch(root: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd: root }).toString().trim();
}

/** execFileSync, not execSync: `--format=%(refname:short)` is shell syntax. */
function branchNames(root: string): string[] {
  return execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: root })
    .toString().trim().split("\n").filter(Boolean);
}

/** A project whose config carries the pre-T-328 spelling. */
function buildLegacyProject(): string {
  const root = mkdtempSync(join(tmpdir(), "t328-compat-"));
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "t328-compat-fixture",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: {
      // The spelling every project written before this ticket carries.
      branchStrategy: "none",
      stages: {
        WRITE_TESTS: { enabled: false },
        TEST: { enabled: false },
        BUILD: { enabled: false },
        VERIFY: { enabled: false },
      },
    },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "t328-compat",
    date: "2026-07-28",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test phase" }],
    blockers: [],
  }));
  writeFileSync(join(story, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001",
    title: "Legacy config ticket",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    description: "",
    createdDate: "2026-07-28",
    completedDate: null,
    blockedBy: [],
    parentTicket: null,
  }));
  run("git init -q -b main", root);
  run("git config user.email test@test.com", root);
  run("git config user.name Test", root);
  run("git add .", root);
  run("git commit -q -m fixture", root);
  return root;
}

function sessions(root: string): FullSessionState[] {
  const dir = join(root, ".story", "sessions");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readSession(join(dir, d.name)))
    .filter((s): s is FullSessionState => s !== null);
}

function onlySession(root: string): FullSessionState {
  const all = sessions(root);
  expect(all.length).toBe(1);
  return all[0]!;
}

function statePath(root: string, sessionId: string): string {
  return join(root, ".story", "sessions", sessionId, "state.json");
}

const createdRoots: string[] = [];
function track(root: string): string {
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    killSidecarsInRoot(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("T-328: legacy 'none' config still starts a session", () => {
  it("resolves the legacy config spelling to canonical current", async () => {
    const root = track(buildLegacyProject());
    const result = await handleAutonomousGuide(root, {
      action: "start",
      sessionId: null,
      mode: "auto",
      clientTaskId: "t328-compat-task",
    });
    expect(result.isError).toBeFalsy();
    expect(onlySession(root).resolvedBranchStrategy).toBe("current");
  });

  it("does not change branches, because current means leave git alone", async () => {
    const root = track(buildLegacyProject());
    // Start on a FEATURE branch. Starting on main would make this test unable
    // to tell "left the branch alone" from "resolved legacy none to the new
    // main strategy and switched to main", since both end on main.
    run("git checkout -q -b feature/not-main", root);
    const before = currentBranch(root);
    expect(before).toBe("feature/not-main");
    await handleAutonomousGuide(root, {
      action: "start",
      sessionId: null,
      mode: "auto",
      clientTaskId: "t328-compat-task",
    });
    expect(currentBranch(root), "legacy none did not leave the branch alone").toBe(before);
    // No branch was created either -- "current" is a no-op, not a quiet rename.
    expect(branchNames(root).sort()).toEqual(["feature/not-main", "main"]);
  });
});

describe("T-328: a session persisted with the legacy value stays readable", () => {
  /**
   * The brick case, from the other direction. session-types.ts gates every
   * session read through safeParse, so this is what an in-flight session
   * upgraded mid-run actually hits.
   */
  it("normalizes a persisted 'none' to current without losing unrelated fields", async () => {
    const root = track(buildLegacyProject());
    await handleAutonomousGuide(root, {
      action: "start",
      sessionId: null,
      mode: "auto",
      clientTaskId: "t328-compat-task",
    });
    const started = onlySession(root);

    // Rewrite the file the way a pre-upgrade CLI left it, and plant a sentinel
    // in an unrelated field so a schema change that drops data is visible.
    const path = statePath(root, started.sessionId);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.resolvedBranchStrategy = "none";
    raw.guideCallCount = 7;
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const reread = readSession(join(root, ".story", "sessions", started.sessionId));
    expect(reread, "a legacy state.json became unreadable").not.toBeNull();
    expect(reread!.resolvedBranchStrategy).toBe("current");
    expect(reread!.guideCallCount).toBe(7);
    expect(reread!.sessionId).toBe(started.sessionId);
  });

  it("resumes a legacy session and keeps the effective strategy at current", async () => {
    const root = track(buildLegacyProject());
    await handleAutonomousGuide(root, {
      action: "start",
      sessionId: null,
      mode: "auto",
      clientTaskId: "t328-compat-task",
    });
    const started = onlySession(root);
    const branchBefore = currentBranch(root);

    // Park the session at the COMPACT boundary, which is the only state resume
    // accepts, and leave it carrying the legacy spelling as a pre-upgrade CLI
    // would have written it.
    const path = statePath(root, started.sessionId);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.resolvedBranchStrategy = "none";
    raw.__sentinel = "do-not-lose-me";
    raw.state = "COMPACT";
    raw.compactPending = true;
    raw.preCompactState = "PICK_TICKET";
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const resumed = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: started.sessionId,
      clientTaskId: "t328-compat-task",
    });
    expect(resumed.isError, "resume rejected a legacy session").toBeFalsy();
    expect(currentBranch(root)).toBe(branchBefore);

    // Read the RAW file, not readSession: the schema transform normalizes on
    // read, so going through it would pass no matter which spelling was
    // written. ISS-902: the next ordinary save must persist the LEGACY
    // spelling, because that is the only value a pre-T-328 reader accepts.
    const persisted = JSON.parse(readFileSync(path, "utf-8"));
    expect(persisted.resolvedBranchStrategy).toBe("none");
    // ...and it must still round-trip to canonical in memory, so nothing above
    // the encode boundary has to know disk and RAM disagree.
    expect(readSession(join(root, ".story", "sessions", started.sessionId))!
      .resolvedBranchStrategy).toBe("current");
    // And an unrelated field must survive that save untouched.
    expect(persisted.__sentinel).toBe("do-not-lose-me");
  });
});
