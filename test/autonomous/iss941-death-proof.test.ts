/**
 * ISS-941 half 2: the start-path generic fallback supersede (guide.ts's
 * staleSessions loop, distinct from the T-250 finished-orphan pass) marks any
 * lease-expired session "superseded" on wall-clock elapsed time alone, with
 * no proof the owning process is actually dead. Most tests in this file MUST
 * fail against the parent commit -- the death-proof gate they exercise does
 * not exist yet, so a stale session with a live/unknown-liveness recorded pid
 * is superseded exactly like a genuinely dead one. Two tests are the
 * exception and are contract-preservation checks, not RED tests: the ESRCH
 * regression ("acceptance 3 regression") already passes against the parent
 * commit because a genuinely dead pid was always correctly superseded, and
 * the finished-orphan-with-alive-pid test ("T-250 contract untouched by the
 * new gate") pins that the T-250 pass's own supersede is unconditional on
 * liveness both before and after this change.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telemetryDirPath } from "../../src/autonomous/liveness.js";

// guide.ts's fallback loop calls readSessionResilient via the imported
// binding (session.ts's OWN internal callers -- findActiveSessionFull,
// findStaleSessions, findResumableSession -- call it as a same-module
// reference and are NOT affected by this mock, confirmed empirically: only
// the guide.ts call site is interceptable this way). That means targeting a
// directory here simulates exactly "the fallback pass's own re-read failed"
// without disturbing findStaleSessions' own earlier discovery of that same
// directory as stale.
const rereadOverride: { failForDir: string | null } = { failForDir: null };

vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  return {
    ...actual,
    readSessionResilient: (dir: string) => {
      if (rereadOverride.failForDir && dir === rereadOverride.failForDir) return null;
      return actual.readSessionResilient(dir);
    },
  };
});

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import {
  createSession,
  readSession,
  writeSessionSync,
} from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { __testing } from "../../src/autonomous/liveness.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function setupProjectTree(root: string): void {
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "iss941-death-proof-fixture",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: {
      stages: {
        WRITE_TESTS: { enabled: false },
        TEST: { enabled: false },
        BUILD: { enabled: false },
        VERIFY: { enabled: false },
      },
    },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "iss941",
    date: "2026-08-04",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test phase" }],
    blockers: [],
  }));
  run("git init -q -b main", root);
  run("git config user.email test@test.com", root);
  run("git config user.name Test", root);
  writeFileSync(join(root, "README.md"), "# fixture\n");
  run("git add .", root);
  run("git commit -q -m initial", root);
}

function writeIssue(root: string, id: string, status: "open" | "resolved"): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id,
    title: `Issue ${id}`,
    status,
    severity: "medium",
    components: [],
    impact: "test",
    resolution: status === "resolved" ? "fixed in fixture" : null,
    location: [],
    discoveredDate: "2026-08-04",
    resolvedDate: status === "resolved" ? "2026-08-04" : null,
    relatedTickets: [],
    order: 10,
    phase: "p1",
  }));
}

function commitOnMain(root: string, marker: string): string {
  writeFileSync(join(root, `${marker}.txt`), `${marker}\n`);
  run(`git add ${marker}.txt`, root);
  run(`git commit -q -m "${marker}"`, root);
  return run("git rev-parse HEAD", root);
}

/**
 * Pre-seed a session's telemetry dir with an `alive` timestamp and a fake
 * `sidecar.pid`, so a regression that lets `writeShutdownMarker` run against
 * a session the death-proof pass must not touch is directly observable:
 * `writeShutdownMarker` overwrites `alive` to "0", writes `shutdown`, and
 * unlinks `sidecar.pid` (liveness.ts). The zero-writes oracle on the SESSION
 * record alone (`readSession(dir)` equality) cannot see any of that -- these
 * files live outside state.json.
 */
function seedTelemetry(dir: string): { aliveContent: string; pidContent: string } {
  const tDir = telemetryDirPath(dir);
  mkdirSync(tDir, { recursive: true });
  const aliveContent = String(Date.now());
  const pidContent = String(process.pid);
  writeFileSync(join(tDir, "alive"), aliveContent);
  writeFileSync(join(tDir, "sidecar.pid"), pidContent);
  return { aliveContent, pidContent };
}

function assertTelemetryUntouched(dir: string, seeded: { aliveContent: string; pidContent: string }): void {
  const tDir = telemetryDirPath(dir);
  expect(existsSync(join(tDir, "shutdown"))).toBe(false);
  expect(readFileSync(join(tDir, "alive"), "utf-8")).toBe(seeded.aliveContent);
  expect(readFileSync(join(tDir, "sidecar.pid"), "utf-8")).toBe(seeded.pidContent);
}

/** Allocate a pid known to be absent, verified rather than guessed. */
function deadPid(): number {
  for (let candidate = 900_000; candidate < 900_200; candidate++) {
    try { process.kill(candidate, 0); } catch (e: any) {
      if (e?.code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead pid for the fixture");
}

interface StaleSessionSpec {
  targetWork?: string[];
  mcpServerPid?: number | null;
}

interface Fixture {
  root: string;
  dirs: string[];
  ids: string[];
}

const createdRoots: string[] = [];

function buildStale(specs: StaleSessionSpec[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "iss941-death-proof-"));
  createdRoots.push(root);
  setupProjectTree(root);

  const workspaceId = deriveWorkspaceId(root);
  const dirs: string[] = [];
  const ids: string[] = [];
  for (const spec of specs) {
    const session = createSession(root, "coding", workspaceId);
    const dir = join(root, ".story", "sessions", session.sessionId);
    writeSessionSync(dir, {
      ...session,
      state: "IMPLEMENT",
      status: "active",
      compactPending: false,
      targetWork: spec.targetWork ?? [],
      mcpServerPid: spec.mcpServerPid ?? undefined,
      mcpGuideCallAt: spec.mcpServerPid ? new Date().toISOString() : undefined,
      lease: { ...session.lease, expiresAt: new Date(Date.now() - 90 * 60_000).toISOString() },
    } as FullSessionState);
    dirs.push(dir);
    ids.push(session.sessionId);
  }
  return { root, dirs, ids };
}

afterEach(() => {
  rereadOverride.failForDir = null;
  __testing.setProcessRole("cli");
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    killSidecarsInRoot(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ISS-941 half 2: death proof on the start-path fallback supersede", () => {
  it("supersedes a stale session when its recorded pid is provably dead (ESRCH) -- acceptance 3 regression", async () => {
    const fix = buildStale([{ targetWork: ["ISS-9001"], mcpServerPid: deadPid() }]);
    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBeFalsy();
    const state = readSession(fix.dirs[0]!);
    expect(state!.status).toBe("superseded");
  });

  it("refuses start when the recorded pid is alive", async () => {
    const fix = buildStale([{ targetWork: ["ISS-9002"], mcpServerPid: process.pid }]);
    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(String(process.pid));
    const state = readSession(fix.dirs[0]!);
    expect(state!.status).toBe("active");
  });

  it("refuses start when the pid probe fails with an unexpected error (unknown, not corroborating)", async () => {
    const original = __testing.probeApi.killProbe;
    __testing.probeApi.killProbe = () => { const e: any = new Error("EACCES"); e.code = "EACCES"; throw e; };
    try {
      const fix = buildStale([{ targetWork: ["ISS-9003"], mcpServerPid: 1234 }]);
      const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
      expect(result.isError).toBe(true);
      const state = readSession(fix.dirs[0]!);
      expect(state!.status).toBe("active");
    } finally {
      __testing.probeApi.killProbe = original;
    }
  });

  it("refuses start when no pid was recorded at all", async () => {
    const fix = buildStale([{ targetWork: ["ISS-9004"] }]);
    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);
    const state = readSession(fix.dirs[0]!);
    expect(state!.status).toBe("active");
  });

  it("mixed batch: one dead, one alive -- refuses start entirely with zero writes to EITHER session", async () => {
    const fix = buildStale([
      { targetWork: ["ISS-9005"], mcpServerPid: deadPid() },
      { targetWork: ["ISS-9006"], mcpServerPid: process.pid },
    ]);
    const s1Before = readSession(fix.dirs[0]!);
    const s2Before = readSession(fix.dirs[1]!);
    // Both sessions' telemetry must survive too -- the all-or-nothing
    // refusal must not run writeShutdownMarker against the dead-pid session
    // either, since the batch is refused before the write pass ever starts.
    const s1Telem = seedTelemetry(fix.dirs[0]!);
    const s2Telem = seedTelemetry(fix.dirs[1]!);
    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);
    const s1 = readSession(fix.dirs[0]!);
    const s2 = readSession(fix.dirs[1]!);
    // Zero writes to EITHER session -- not just status, the whole record.
    expect(s1).toEqual(s1Before);
    expect(s2).toEqual(s2Before);
    assertTelemetryUntouched(fix.dirs[0]!, s1Telem);
    assertTelemetryUntouched(fix.dirs[1]!, s2Telem);
  });

  it("refuses start when the fallback pass's own re-read fails after the initial scan observed the session (fail-closed, not fail-open)", async () => {
    const fix = buildStale([{ targetWork: ["ISS-9007"], mcpServerPid: deadPid() }]);
    const before = readSession(fix.dirs[0]!);
    const telem = seedTelemetry(fix.dirs[0]!);
    rereadOverride.failForDir = fix.dirs[0]!;
    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/could not be re-read|unresolved/i);
    const state = readSession(fix.dirs[0]!);
    expect(state).toEqual(before);
    assertTelemetryUntouched(fix.dirs[0]!, telem);
  });

  it("a verifiably finished orphan whose recorded pid probes alive is still auto-superseded, and start proceeds (T-250 contract untouched by the new gate)", async () => {
    const root = mkdtempSync(join(tmpdir(), "iss941-death-proof-orphan-"));
    createdRoots.push(root);
    setupProjectTree(root);
    writeIssue(root, "ISS-9008", "resolved");
    const commitHash = commitOnMain(root, "ISS_9008");

    const workspaceId = deriveWorkspaceId(root);
    const session = createSession(root, "coding", workspaceId);
    const dir = join(root, ".story", "sessions", session.sessionId);
    writeSessionSync(dir, {
      ...session,
      state: "IMPLEMENT",
      status: "active",
      compactPending: false,
      targetWork: ["ISS-9008"],
      mcpServerPid: process.pid, // alive -- must not matter to the orphan pass
      mcpGuideCallAt: new Date().toISOString(),
      completedTickets: [],
      lease: { ...session.lease, expiresAt: new Date(Date.now() - 90 * 60_000).toISOString() },
    } as FullSessionState);
    const { appendEvent } = await import("../../src/autonomous/session.js");
    appendEvent(dir, {
      rev: 1,
      type: "commit",
      timestamp: new Date().toISOString(),
      data: { commitHash, issueId: "ISS-9008" },
    });

    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null });
    expect(result.isError).toBeFalsy();
    const state = readSession(dir);
    expect(state!.status).toBe("superseded");
    expect(state!.terminationReason).toBe("auto_superseded_finished_orphan");
  });

  it("two directories share one sessionId; only one is a genuine finished orphan -- the other must not be silently skipped by the death-proof pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "iss941-death-proof-dupid-"));
    createdRoots.push(root);
    setupProjectTree(root);
    writeIssue(root, "ISS-9009", "resolved");
    const commitHash = commitOnMain(root, "ISS_9009");

    const workspaceId = deriveWorkspaceId(root);

    // Orphan directory: real sessionId, finished-orphan-eligible.
    const orphanSession = createSession(root, "coding", workspaceId);
    const orphanDir = join(root, ".story", "sessions", orphanSession.sessionId);
    writeSessionSync(orphanDir, {
      ...orphanSession,
      state: "IMPLEMENT",
      status: "active",
      compactPending: false,
      targetWork: ["ISS-9009"],
      completedTickets: [],
      lease: { ...orphanSession.lease, expiresAt: new Date(Date.now() - 90 * 60_000).toISOString() },
    } as FullSessionState);
    const { appendEvent } = await import("../../src/autonomous/session.js");
    appendEvent(orphanDir, {
      rev: 1,
      type: "commit",
      timestamp: new Date().toISOString(),
      data: { commitHash, issueId: "ISS-9009" },
    });

    // Sibling directory carrying the SAME sessionId, NOT finished-orphan-eligible
    // (different, unfinished target), with a live recorded pid.
    const siblingDir = join(root, ".story", "sessions", `${orphanSession.sessionId}-dup`);
    mkdirSync(siblingDir, { recursive: true });
    writeSessionSync(siblingDir, {
      ...orphanSession,
      state: "IMPLEMENT",
      status: "active",
      compactPending: false,
      targetWork: ["ISS-9099"],
      mcpServerPid: process.pid,
      mcpGuideCallAt: new Date().toISOString(),
      lease: { ...orphanSession.lease, expiresAt: new Date(Date.now() - 90 * 60_000).toISOString() },
    } as FullSessionState);

    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null });

    // The orphan directory legitimately gets superseded by the earlier,
    // unconditional finished-orphan pass. The sibling directory sharing its
    // id is a live blocker (alive pid, non-orphan-eligible target) that must
    // cause start to refuse entirely -- silently leaving it active while
    // start succeeds would be exactly the escaped-sibling bug this test
    // pins.
    expect(result.isError).toBe(true);
    const orphanState = readSession(orphanDir);
    const siblingState = readSession(siblingDir);
    expect(orphanState!.status).toBe("superseded");
    expect(orphanState!.terminationReason).toBe("auto_superseded_finished_orphan");
    expect(siblingState!.status).toBe("active");

    // The refusal must give a recovery path that actually reaches the
    // sibling -- "storybloq session stop <id>" resolves the id-named
    // directory (the orphan copy), NOT this basename-suffixed sibling, so
    // recommending it bare here would strand the operator on an unreachable
    // command. The message must name the sibling's real directory basename.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`${orphanSession.sessionId}-dup`);
    expect(text).toMatch(/does not match its recorded session id/i);
  });

  it("a duplicate-id sibling directory named with control/bidi characters and Markdown-shaped text cannot inject structure into the refusal (Codex code-review finding)", async () => {
    const root = mkdtempSync(join(tmpdir(), "iss941-death-proof-dupid-hostile-"));
    createdRoots.push(root);
    setupProjectTree(root);
    writeIssue(root, "ISS-9010", "resolved");
    const commitHash = commitOnMain(root, "ISS_9010");

    const workspaceId = deriveWorkspaceId(root);

    const orphanSession = createSession(root, "coding", workspaceId);
    const orphanDir = join(root, ".story", "sessions", orphanSession.sessionId);
    writeSessionSync(orphanDir, {
      ...orphanSession,
      state: "IMPLEMENT",
      status: "active",
      compactPending: false,
      targetWork: ["ISS-9010"],
      completedTickets: [],
      lease: { ...orphanSession.lease, expiresAt: new Date(Date.now() - 90 * 60_000).toISOString() },
    } as FullSessionState);
    const { appendEvent } = await import("../../src/autonomous/session.js");
    appendEvent(orphanDir, {
      rev: 1,
      type: "commit",
      timestamp: new Date().toISOString(),
      data: { commitHash, issueId: "ISS-9010" },
    });

    // Directory basename carrying: an ESC sequence (terminal repaint), a raw
    // newline (forged extra row), a bidi override (visual name spoof), and
    // Markdown-link-shaped text pointed at a javascript: scheme. `/` and NUL
    // cannot appear in a single path component, so this is otherwise a legal
    // basename on macOS/Linux.
    const hostileSuffix =
      "\u001b[31mFAKE\u001b[0m\n\u202E[click me](javascript:alert(1))";
    const siblingDir = join(root, ".story", "sessions", `${orphanSession.sessionId}${hostileSuffix}`);
    mkdirSync(siblingDir, { recursive: true });
    writeSessionSync(siblingDir, {
      ...orphanSession,
      state: "IMPLEMENT",
      status: "active",
      compactPending: false,
      targetWork: ["ISS-9098"],
      mcpServerPid: process.pid,
      mcpGuideCallAt: new Date().toISOString(),
      lease: { ...orphanSession.lease, expiresAt: new Date(Date.now() - 90 * 60_000).toISOString() },
    } as FullSessionState);

    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);
    expect(readSession(orphanDir)!.status).toBe("superseded");
    expect(readSession(siblingDir)!.status).toBe("active");

    const text = (result.content[0] as { text: string }).text;
    // Nothing from the hostile basename survives unescaped: no raw ESC, no
    // raw bidi override.
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202E");
    // Non-vacuous line-count pin (pen byte-review finding T-C): a filter for
    // lines starting "- " passes trivially even with a broken sanitizer,
    // since nothing in the hostile payload happens to start a line with
    // "- " on its own. Pin the EXACT structure instead -- intro line,
    // exactly one blocker bullet, closing line -- so the raw embedded
    // newline in the basename provably did not fabricate a 4th line.
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[autonomous_guide error\] Cannot start: the following stale session\(s\)/);
    expect(lines[1]).toMatch(/^- /);
    expect(lines[2]).toBe("Refusing to silently reclaim this workspace slot.");
    // No raw control byte from the hostile payload survives inside the
    // sanitized blocker line itself.
    expect(lines[1]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    // The Markdown link shape is neutralized (escaped brackets/parens), not
    // rendered as a live `[text](javascript:...)` link.
    expect(text).not.toMatch(/\[click me\]\(javascript:/);
  });
});
