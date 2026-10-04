/**
 * T-486 7c (H1-H5): the old-dist harness fails closed where it must. Required
 * mode turns a missing dist into a failing run that names `compat:fetch`;
 * plain mode skips with the reason; a tarball whose sha does not match the pin
 * is never used; and the publish and preflight paths both set required mode.
 * The preflight check reads the workspace's scripts/preflight.sh, which the
 * public projection does not carry: absent, it skips with the reason, and in
 * required mode fails. Needs no dist of its own.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OLD_DISTS, compatRequired, findOldDist, requireOldDists, tarballName } from "./old-dists.js";

const PKG = join(__dirname, "..", "..");
const PREFLIGHT = join(PKG, "..", "scripts", "preflight.sh");

/**
 * The preflight script's compat-required stage line, or why it cannot be
 * read: absent (the public projection ships storybloq/ only) skips with the
 * reason, and in required mode throws.
 */
function preflightStage(path: string, env: NodeJS.ProcessEnv): { line: string | undefined } | { skip: string } {
  if (!existsSync(path)) {
    const reason = `${path} is absent (a projection without the workspace scripts)`;
    if (compatRequired(env)) throw new Error(`STORYBLOQ_COMPAT_REQUIRED=1: ${reason}`);
    return { skip: `skipped: ${reason}` };
  }
  return { line: readFileSync(path, "utf-8").split("\n").find((l) => l.includes('run_stage "compat-required"')) };
}

let h5: { line: string | undefined } | { skip: string } | { error: unknown };
try {
  h5 = preflightStage(PREFLIGHT, process.env);
} catch (error) {
  h5 = { error };
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "t486-harness-"));
  dirs.push(d);
  return d;
}

function vitestOn(file: string, extra: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (!("STORYBLOQ_COMPAT_REQUIRED" in extra)) delete env.STORYBLOQ_COMPAT_REQUIRED;
  return spawnSync(join(PKG, "node_modules", ".bin", "vitest"), ["run", "--maxWorkers=1", file], { cwd: PKG, env, encoding: "utf-8", timeout: 240_000 });
}

describe("old-dist harness", () => {
  it("H1: required mode with an empty dist directory fails the compat file, naming compat:fetch", () => {
    const r = vitestOn("test/compat/checkpoint-merge-old-cli.test.ts", { STORYBLOQ_COMPAT_REQUIRED: "1", STORYBLOQ_OLD_DIST_DIR: temp() });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("npm run compat:fetch");
  }, 300_000);

  it("H2: plain mode with an empty dist directory passes, skipping with the reason", () => {
    const r = vitestOn("test/compat/checkpoint-merge-old-cli.test.ts", { STORYBLOQ_OLD_DIST_DIR: temp() });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/skipped/i);
  }, 300_000);

  it("H3: a tarball whose sha does not match its pin is refused, and throws in required mode", () => {
    const dir = temp();
    const pin = OLD_DISTS[0]!;
    writeFileSync(join(dir, tarballName(pin.version)), "not the published tarball");
    mkdirSync(join(dir, pin.version, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, pin.version, "node_modules", ".bin", "storybloq"), "#!/bin/sh\n");
    const found = findOldDist(pin.version, { STORYBLOQ_OLD_DIST_DIR: dir });
    expect(found.ok).toBe(false);
    expect(!found.ok && found.reason).toContain(`expected ${pin.sha256}`);
    expect(requireOldDists([pin.version], { STORYBLOQ_OLD_DIST_DIR: dir }).skip).toMatch(/^skipped: .*expected/);
    expect(() => requireOldDists([pin.version], { STORYBLOQ_OLD_DIST_DIR: dir, STORYBLOQ_COMPAT_REQUIRED: "1" })).toThrow(/compat:fetch/);
  });

  it("H4: prepublishOnly runs the suite in required mode, after the build", () => {
    const scripts = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")).scripts as Record<string, string>;
    expect(scripts.prepublishOnly).toMatch(/npm run build && STORYBLOQ_COMPAT_REQUIRED=1 npm test$/);
    expect(scripts["compat:fetch"]).toBe("bash scripts/compat-fetch.sh");
  });

  it.skipIf("skip" in h5)(`H5: preflight declares compat-required as a gating stage over test/compat${"skip" in h5 ? ` (${h5.skip})` : ""}`, () => {
    if ("error" in h5) throw h5.error;
    const line = "line" in h5 ? h5.line : undefined;
    expect(line).toBeDefined();
    expect(line).toMatch(/run_stage "compat-required" runnable /);
    expect(line).toContain("STORYBLOQ_COMPAT_REQUIRED=1");
    expect(line).toMatch(/ test\/compat$/);
  });

  it("H5: an absent preflight script skips with the reason in plain mode", () => {
    const absent = join(temp(), "preflight.sh");
    expect(preflightStage(absent, {})).toEqual({ skip: `skipped: ${absent} is absent (a projection without the workspace scripts)` });
  });

  it("H5: an absent preflight script fails in required mode", () => {
    const absent = join(temp(), "preflight.sh");
    expect(() => preflightStage(absent, { STORYBLOQ_COMPAT_REQUIRED: "1" })).toThrow(`STORYBLOQ_COMPAT_REQUIRED=1: ${absent} is absent`);
  });

  it("compat:fetch reads the same pins this harness checks", () => {
    const script = readFileSync(join(PKG, "scripts", "compat-fetch.sh"), "utf-8");
    expect(script).toContain("test/compat/old-dists.json");
    expect(script).toContain("--ignore-scripts");
    expect(script).toContain("--userconfig /dev/null");
  });
});
