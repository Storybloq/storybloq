/**
 * ISS-1305 (D9): proves test/setup.ts clears the project-root variables a
 * no-ledger duet worker hands every child (the launch exports
 * STORYBLOQ_PROJECT_ROOT=<the pen's board>). Only a child vitest whose setup
 * file is the real setup.ts, started WITH the variables set, can show the
 * scrub is wired; the control run without the setup file shows the probe
 * would see them. Same scaffold as the ISS-1220 wiring test.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const REAL_SETUP = join(PKG_ROOT, "test", "setup.ts");

// ISS-1497: each test starts a child vitest run, which cannot fit the default
// 5 s test timeout. Measured cold starts, alone, 5 runs at load 28: 7.6 to
// 8.9 s. CHILD_RUN_MS is about 6 times the slowest, for a loaded machine.
const CHILD_RUN_MS = 60_000;

// Module scope is read before any hook runs (the load-time scrub), and a value
// set there must still be gone when the first test starts (the beforeEach).
const PROBE = `import { it, expect } from "vitest";
const atLoad = [process.env.STORYBLOQ_PROJECT_ROOT, process.env.CLAUDESTORY_PROJECT_ROOT];
process.env.CLAUDESTORY_PROJECT_ROOT = "/set-at-module-scope";
it("inherits no project root", () => {
  expect(atLoad).toEqual([undefined, undefined]);
  expect(process.env.STORYBLOQ_PROJECT_ROOT).toBeUndefined();
  expect(process.env.CLAUDESTORY_PROJECT_ROOT).toBeUndefined();
  process.env.STORYBLOQ_PROJECT_ROOT = "/set-by-one-test";
});
it("a value one test sets does not reach the next", () => {
  expect(process.env.STORYBLOQ_PROJECT_ROOT).toBeUndefined();
});
`;

function runChild(setupFiles: string[]): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "iss1305-env-scrub-"));
  const configPath = join(dir, "synthetic-git-config");
  writeFileSync(configPath, "[core]\n\tbare = false\n", "utf-8");
  writeFileSync(
    join(dir, "vitest.config.ts"),
    `export default { test: { root: ${JSON.stringify(dir)}, include: ["probe.test.ts"], setupFiles: ${JSON.stringify(setupFiles)} } };\n`,
    "utf-8",
  );
  writeFileSync(join(dir, "probe.test.ts"), PROBE, "utf-8");
  const decoy = join(dir, "pen-board");
  const r = spawnSync("npx", ["vitest", "run", "--maxWorkers=1", "--config", join(dir, "vitest.config.ts")], {
    cwd: PKG_ROOT,
    encoding: "utf-8",
    env: { ...process.env, STORYBLOQ_ISS1220_CONFIG_PATH: configPath, CI: "1", STORYBLOQ_PROJECT_ROOT: decoy, CLAUDESTORY_PROJECT_ROOT: decoy },
    timeout: 180_000,
  });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

describe("ISS-1305 (D9): the suite never inherits a pen's board", () => {
  it("a child run started with both project-root variables set sees neither at module load, before a test or between tests", () => {
    const { status, output } = runChild([REAL_SETUP]);
    expect(status, output).toBe(0);
  }, CHILD_RUN_MS);

  it("CONTROL: without the setup file the same probe sees the inherited board and fails", () => {
    const { status, output } = runChild([]);
    expect(status, output).not.toBe(0);
    expect(output).toContain("inherits no project root");
  }, CHILD_RUN_MS);
});
