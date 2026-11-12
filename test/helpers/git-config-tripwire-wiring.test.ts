/**
 * ISS-1220: proves the tripwire is actually WIRED, not merely correct.
 *
 * The unit tests exercise `compareConfig` directly, so they stay green even if
 * `test/setup.ts` never registers its `afterAll` -- which is exactly the
 * mutant the acceptance criteria require to go red. The only honest proof is
 * to run a real child vitest whose setup file is the real `test/setup.ts`, let
 * a test inside it modify the watched config, and assert the CHILD RUN FAILS.
 *
 * The watched path is redirected to a synthetic file via
 * STORYBLOQ_ISS1220_CONFIG_PATH so nothing here goes near the real repository.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const REAL_SETUP = join(PKG_ROOT, "test", "setup.ts");

// ISS-1497: each test starts a child vitest run, which cannot fit the default
// 5 s test timeout. Measured cold starts, alone, 5 runs at load 28: 7.6 to
// 8.9 s. CHILD_RUN_MS is about 6 times the slowest, for a loaded machine.
const CHILD_RUN_MS = 60_000;

/** Builds a throwaway vitest project whose setupFiles is the real setup.ts. */
function scaffold(body: string): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "iss1220-wiring-"));
  const configPath = join(dir, "synthetic-git-config");
  writeFileSync(configPath, "[core]\n\tbare = false\n", "utf-8");

  // A PLAIN OBJECT, with no imports: a config file in a temp dir cannot
  // resolve "vitest/config" from this project's node_modules, and importing it
  // fails with MODULE_NOT_FOUND before the run even starts.
  writeFileSync(
    join(dir, "vitest.config.ts"),
    `export default { test: { root: ${JSON.stringify(dir)}, include: ["probe.test.ts"], setupFiles: [${JSON.stringify(REAL_SETUP)}] } };\n`,
    "utf-8",
  );
  writeFileSync(join(dir, "probe.test.ts"), body, "utf-8");
  return { dir, configPath };
}

/**
 * The child runs with cwd = the package root so `vitest` and `vite` resolve
 * from this project's own node_modules; `--config` and the config's own `root`
 * point it at the throwaway project. Running with cwd = the tmp dir instead
 * makes npx fetch a separate vite, which fails for reasons that have nothing
 * to do with the tripwire.
 */
function runChild(dir: string, configPath: string): { status: number | null; output: string } {
  const r = spawnSync("npx", ["vitest", "run", "--maxWorkers=1", "--config", join(dir, "vitest.config.ts")], {
    cwd: PKG_ROOT,
    encoding: "utf-8",
    env: { ...process.env, STORYBLOQ_ISS1220_CONFIG_PATH: configPath, CI: "1" },
    timeout: 180_000,
  });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

describe("ISS-1220 tripwire wiring", () => {
  it("CONTROL: a child run that leaves the watched config alone passes", () => {
    const { dir, configPath } = scaffold(
      `import { it, expect } from "vitest";\n` + `it("touches nothing", () => { expect(1).toBe(1); });\n`,
    );
    const { status, output } = runChild(dir, configPath);
    expect(status, `control run should pass:\n${output}`).toBe(0);
  }, CHILD_RUN_MS);

  it("a child run whose test writes to the watched config FAILS with the ISS-1220 diff", () => {
    // Without the control above, a child that failed for an unrelated reason
    // (a bad scaffold, a missing dep) would look identical to the tripwire firing.
    const { dir, configPath } = scaffold(
      `import { it } from "vitest";\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `it("writes the incident's own shape into the watched config", () => {\n` +
        `  writeFileSync(${JSON.stringify("")} + process.env.STORYBLOQ_ISS1220_CONFIG_PATH, "[core]\\n\\tbare = true\\n[user]\\n\\temail = t@t.t\\n", "utf-8");\n` +
        `});\n`,
    );
    const { status, output } = runChild(dir, configPath);

    expect(status, `expected the child run to FAIL, output:\n${output}`).not.toBe(0);
    expect(output).toContain("ISS-1220");
    expect(output).toContain("git config changed during the test run");
  }, CHILD_RUN_MS);
});
