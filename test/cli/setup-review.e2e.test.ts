/**
 * T-536: `storybloq setup-review` through the BUILT bundle (`npm run build`
 * must have produced a current dist/cli.js): the registration, the
 * housekeeping skip, the unavailable gate's exact text, and the skip path with
 * standard input held open, so a client that never closes stdin cannot hang it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PATH, E2ECliFixture } from "../helpers/e2e-cli.js";
import { STOP_LINES } from "../../src/core/setup-review.js";

vi.setConfig({ testTimeout: 30_000 });

let fixture: E2ECliFixture;
let project: string;
let store: string;

beforeAll(async () => {
  fixture = await E2ECliFixture.create();
  project = mkdtempSync(join(tmpdir(), "sr-e2e-project-"));
  store = mkdtempSync(join(tmpdir(), "sr-e2e-store-"));
});
afterAll(async () => {
  await fixture.cleanup();
  rmSync(project, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

/** Runs the bundle with stdin left OPEN (never written, never ended) and a PATH with no reviewer on it (node's own directory can hold a real one). */
function runOpenStdin(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: project,
      stdio: ["pipe", "pipe", "pipe"],
      env: fixture.env({ PATH: ["/usr/bin", "/bin"].join(":"), STORYBLOQ_SETUP_REVIEW_DIR: store }),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out; stdout so far:\n${stdout}`)); }, 15_000);
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("close", (code) => {
      clearTimeout(timer);
      fixture.recordResult({ stdout, stderr });
      resolve({ code, stdout, stderr });
    });
  });
}

describe("setup-review via the built CLI (T-536)", () => {
  it("prints the unconditional stop from the gate when no reviewer can start, then completes the owner's skip with stdin held open", async () => {
    const gate = await runOpenStdin(["setup-review", "gate"]);
    expect(gate.code).toBe(0);
    const id = /^Setup id: (SS-[0-9a-f]{8})$/m.exec(gate.stdout)![1]!;
    expect(gate.stdout.startsWith(`Setup id: ${id}\nReviewer probe: none available\n`)).toBe(true);
    expect(gate.stdout.trimEnd().endsWith(STOP_LINES.join("\n"))).toBe(true);
    const skipped = await runOpenStdin(["setup-review", "status", "--setup", id, "--skipped"]);
    expect(skipped).toMatchObject({ code: 0, stdout: "Reviewer probe: none available\nIndependent review: skipped at the owner's request\n" });
    fixture.assertNoHousekeepingNotices();
  });

  it("lists the command in the reference", async () => {
    const { COMMANDS } = await import("../../src/cli/commands/reference.js");
    expect(COMMANDS.find((c) => c.name === "setup-review")?.usage).toBe("storybloq setup-review <gate|run|status> [--setup <id>] [--backend <codex|claude>] [--new-cycle --reason <text>] [--skipped]");
  });
});
