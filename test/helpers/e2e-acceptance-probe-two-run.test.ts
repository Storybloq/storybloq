/**
 * ISS-1420: two overlapping vitest runs with different HOMEs each pass their
 * own acceptance probe. Real child runs with the real global setup and setup
 * file, held together so both setups happen before either teardown.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup, teardown } from "../e2e-acceptance-probe.global.js";
import { CONFIG_SNAPSHOT_BASENAME, snapshotConfigAt } from "./git-config-tripwire.js";

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const REAL_SETUP = join(PKG_ROOT, "test", "setup.ts");
const REAL_GLOBAL = join(PKG_ROOT, "test", "e2e-acceptance-probe.global.ts");
const VITEST = join(PKG_ROOT, "node_modules", "vitest", "vitest.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway project: its one test says it is up, then waits for the other run. */
function scaffold(name: string, other: string, barrier: string): string {
  const dir = mkdtempSync(join(tmpdir(), `iss1420-${name}-`));
  dirs.push(dir);
  writeFileSync(
    join(dir, "vitest.config.ts"),
    `export default { test: { root: ${JSON.stringify(dir)}, include: ["probe.test.ts"], setupFiles: [${JSON.stringify(REAL_SETUP)}], globalSetup: [${JSON.stringify(REAL_GLOBAL)}] } };\n`,
  );
  writeFileSync(
    join(dir, "probe.test.ts"),
    `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
it("waits for the other run", async () => {
  writeFileSync(join(${JSON.stringify(barrier)}, ${JSON.stringify(name)}), String(process.env.STORYBLOQ_E2E_PROBE_DIR));
  const started = Date.now();
  while (!existsSync(join(${JSON.stringify(barrier)}, ${JSON.stringify(other)}))) {
    expect(Date.now() - started).toBeLessThan(120000);
    await new Promise((done) => setTimeout(done, 50));
  }
}, 130000);
`,
  );
  return dir;
}

function run(project: string, home: string, baseEnv: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [VITEST, "run", "--maxWorkers=1", "--config", join(project, "vitest.config.ts")], {
      cwd: PKG_ROOT,
      env: { ...baseEnv, HOME: home, CODEX_HOME: join(home, ".codex"), CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.once("close", (status) => done({ status, output }));
  });
}

describe("what teardown removes", () => {
  it("only the directory its own setup created, whatever the variable says by then", async () => {
    const base = mkdtempSync(join(tmpdir(), "iss1420-own-"));
    dirs.push(base);
    const foreign = join(base, "foreign");
    mkdirSync(foreign);
    vi.stubEnv("HOME", base);
    vi.stubEnv("CODEX_HOME", join(base, ".codex"));
    vi.stubEnv("STORYBLOQ_GLOBAL_DIR", join(base, "global"));
    const saved = process.env.STORYBLOQ_E2E_PROBE_DIR;
    try {
      await setup();
      const own = process.env.STORYBLOQ_E2E_PROBE_DIR!;
      expect(existsSync(own)).toBe(true);
      expect(own).not.toBe(saved);
      process.env.STORYBLOQ_E2E_PROBE_DIR = foreign;
      await teardown();
      expect(existsSync(foreign)).toBe(true);
      expect(existsSync(own)).toBe(false);

      await setup();
      const failing = process.env.STORYBLOQ_E2E_PROBE_DIR!;
      expect(readdirSync(failing)).toContain(CONFIG_SNAPSHOT_BASENAME);
      mkdirSync(join(base, ".codex"), { recursive: true });
      writeFileSync(join(base, ".codex", "config.toml"), "# changed\n");
      await expect(teardown()).rejects.toThrow(/real machine state changed/);
      expect(existsSync(failing), "a failing comparison still removes the directory").toBe(false);
    } finally {
      if (saved === undefined) delete process.env.STORYBLOQ_E2E_PROBE_DIR;
      else process.env.STORYBLOQ_E2E_PROBE_DIR = saved;
      vi.unstubAllEnvs();
    }
  });
});

describe("a worker's git config baseline", () => {
  it("comes from its own run's directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iss1420-baseline-"));
    dirs.push(dir);
    const watched = join(dir, "watched-config");
    writeFileSync(watched, "now\n");
    writeFileSync(join(dir, CONFIG_SNAPSHOT_BASENAME), JSON.stringify(snapshotConfigAt(watched)));
    writeFileSync(watched, "changed\n");
    writeFileSync(
      join(dir, "vitest.config.ts"),
      `export default { test: { root: ${JSON.stringify(dir)}, include: ["probe.test.ts"], setupFiles: [${JSON.stringify(REAL_SETUP)}] } };\n`,
    );
    writeFileSync(join(dir, "probe.test.ts"), `import { it } from "vitest";\nit("does nothing", () => {});\n`);
    const { STORYBLOQ_ISS1220_CONFIG_PATH: _unused, ...env } = process.env;
    const out = await run(dir, dir, { ...env, STORYBLOQ_E2E_PROBE_DIR: dir });
    expect(out.status).not.toBe(0);
    expect(out.output).toContain(watched);
  }, 120_000);
});

describe("two overlapping runs", () => {
  it("each pass their own probe, in their own snapshot directory, and leave nothing behind", async () => {
    const base = mkdtempSync(join(tmpdir(), "iss1420-base-"));
    dirs.push(base);
    const barrier = join(base, "barrier");
    mkdirSync(barrier);
    const homeA = join(base, "home-a");
    const homeB = join(base, "home-b");
    // HOMEs that differ in an audited path: comparing one against the other is a reported change.
    mkdirSync(join(homeA, ".codex"), { recursive: true });
    writeFileSync(join(homeA, ".codex", "config.toml"), "# a\n");
    mkdirSync(homeB, { recursive: true });

    // A fixed order, the one that shows the fault: A sets up, B sets up over it, A
    // tears down first and so compares its own HOME against whatever B left.
    const runA = run(scaffold("a", "b", barrier), homeA);
    const started = Date.now();
    while (!existsSync(join(barrier, "a"))) {
      expect(Date.now() - started, "run A never reached its test").toBeLessThan(120_000);
      await new Promise((done) => setTimeout(done, 50));
    }
    const runB = run(scaffold("b", "a-closed", barrier), homeB);
    const a = await runA;
    writeFileSync(join(barrier, "a-closed"), "");
    const b = await runB;

    expect(a.output).not.toContain("real machine state changed");
    expect(b.output).not.toContain("real machine state changed");
    expect(a.status, a.output).toBe(0);
    expect(b.status, b.output).toBe(0);

    const dirA = readFileSync(join(barrier, "a"), "utf-8");
    const dirB = readFileSync(join(barrier, "b"), "utf-8");
    expect(dirA).not.toBe("undefined");
    expect(dirB).not.toBe("undefined");
    expect(dirA).not.toBe(dirB);
    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(dirB)).toBe(false);
  }, 240_000);
});
