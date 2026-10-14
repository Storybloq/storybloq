import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

/**
 * ISS-1376: the autonomous start with a baseline that times out, overflows
 * or is configured with a bad timeout, driven through the real start. The
 * test command is a small node script, so no case waits for real minutes.
 */

const NODE = JSON.stringify(process.execPath);
const posix = process.platform !== "win32";

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

/** A one-ticket project whose TEST / WRITE_TESTS stages run `fixture.cjs`. */
function buildProject(fixture: string, stages: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "iss1376-start-"));
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(root, "fixture.cjs"), fixture);
  writeFileSync(join(root, ".gitignore"), ".story/sessions/\n");
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "iss1376-start-fixture",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: {
      stages: {
        BUILD: { enabled: false },
        VERIFY: { enabled: false },
        ...stages,
      },
    },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "iss1376-start",
    date: "2026-10-14",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test phase" }],
    blockers: [],
  }));
  writeFileSync(join(story, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001",
    title: "Baseline fixture ticket",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    description: "",
    createdDate: "2026-10-14",
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

const COMMAND = `exec ${NODE} fixture.cjs`;
const writeTests = (extra: Record<string, unknown> = {}) => ({
  WRITE_TESTS: { enabled: true, command: COMMAND, ...extra },
  TEST: { enabled: false },
});
const testOnly = (extra: Record<string, unknown> = {}) => ({
  WRITE_TESTS: { enabled: false },
  TEST: { enabled: true, command: COMMAND, ...extra },
});

const createdRoots: string[] = [];
afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    killSidecarsInRoot(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function start(fixture: string, stages: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const root = buildProject(fixture, stages);
  createdRoots.push(root);
  const result = await handleAutonomousGuide(root, {
    action: "start",
    sessionId: null,
    mode: "auto",
    clientTaskId: "iss1376-start-task",
  });
  return { isError: Boolean(result.isError), text: (result.content[0] as { text: string }).text };
}

const SLEEP_3S = "setTimeout(() => {}, 3000);\n";

describe.skipIf(!posix)("ISS-1376: the start and its test baseline", { timeout: 30000 }, () => {
  it("G1: WRITE_TESTS refuses a baseline that runs past its configured timeout, naming the setting", async () => {
    const r = await start(SLEEP_3S, writeTests({ testTimeoutMs: 500 }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("timed out after");
    expect(r.text).toContain("testTimeoutMs");
    expect(r.text).toContain("currently 500 ms");
    expect(r.text).not.toContain("Configure a test reporter");
  });

  it("G2: WRITE_TESTS refuses an interrupted baseline even though counts printed before the timeout", async () => {
    const r = await start("console.log('5 passed 1 failed');\n" + SLEEP_3S, writeTests({ testTimeoutMs: 500 }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("timed out after");
  });

  it("G3: WRITE_TESTS starts over a fast suite within its timeout", async () => {
    const r = await start("console.log('Tests 1 failed | 3 passed'); process.exit(1);\n", writeTests({ testTimeoutMs: 10000 }));
    expect(r.isError, r.text).toBe(false);
  });

  it("G4: TEST only starts over a timed-out baseline and warns, naming stages.TEST.testTimeoutMs", async () => {
    const r = await start(SLEEP_3S, testOnly({ testTimeoutMs: 500 }));
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("**Warning:** test baseline timed out");
    expect(r.text).toContain("stages.TEST.testTimeoutMs");
  });

  it("G5: TEST only refuses a timeout of 0 and names the key", async () => {
    const r = await start(SLEEP_3S, testOnly({ testTimeoutMs: 0 }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("stages.TEST.testTimeoutMs");
  });

  it("G6: WRITE_TESTS refuses a baseline whose output passed the capture limit, naming 5 MiB", async () => {
    const r = await start(
      "const b = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < 6; i++) process.stdout.write(b);\n" + SLEEP_3S,
      writeTests({ testTimeoutMs: 10000 }),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("5 MiB");
  });
});
