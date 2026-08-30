/**
 * `config set-overrides` REJECTS an unknown flag (T-469).
 *
 * This is not a style test. The Mac app's Dev-ID build shells out to whatever
 * global `storybloq` happens to be installed, which may predate `--deep`. It
 * sends `--deep` unconditionally and relies on an older CLI REFUSING the flag,
 * because the alternative -- a CLI that accepts and ignores it -- would perform
 * a SHALLOW merge while the app believed it had performed a deep one, silently
 * deleting `stages.PLAN_REVIEW` and `stages.CODE_REVIEW` on every settings save.
 * That is the exact defect T-469 exists to remove, and strict mode is the only
 * thing standing between us and reintroducing it against old clients.
 *
 * So: if a future refactor drops `.strict()` (src/cli/index.ts) or moves this
 * command out from under it, this test must fail rather than the Mac app
 * quietly corrupting configs in the field.
 *
 * Runs against the BUILT bundle, like the other e2e suites here, because the
 * defect surface is the yargs registration and root middleware that
 * handler-level tests bypass entirely.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2ECliFixture, runE2ECli } from "../helpers/e2e-cli.js";

vi.setConfig({ testTimeout: 30_000 });

// ISS-1091: isolated HOME/CODEX_HOME/STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME.
let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

// Returns stdout only (fix direction d) on both the success and failure path.
function run(cwd: string, ...args: string[]): { code: number; out: string } {
  const result = runE2ECli(fixture, args, { cwd });
  return { code: result.status ?? 1, out: result.stdout };
}

const created: string[] = [];

/** A temp project per test, removed afterwards so runs do not litter tmpdir. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "strict-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("config set-overrides strict-mode contract", () => {
  it("rejects an unknown flag with a structured invalid_input naming the argument", () => {
    const dir = tempDir();
    const { out } = run(dir, "config", "set-overrides", "--bogusflag", "xyz", "--format", "json");
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe("invalid_input");
    expect(parsed.error.message).toContain("Unknown argument");
    expect(parsed.error.message).toContain("bogusflag");
  });

  it("accepts --deep, so the app can tell an old CLI from a new one by that rejection alone", () => {
    // The positive half matters as much as the negative one: if BOTH old and
    // new CLIs rejected `--deep`, the app's capability check would be a
    // permanent false negative and every Dev-ID settings write would fail.
    const dir = tempDir();
    const { out } = run(dir, "config", "set-overrides", "--deep", "--json", "{}", "--format", "json");
    const parsed = JSON.parse(out);
    // No project here, so it fails on THAT, not on the flag.
    expect(JSON.stringify(parsed)).not.toContain("Unknown argument");
  });

  it("rejects an unknown flag on the shallow path too", () => {
    const dir = tempDir();
    const { out } = run(dir, "config", "set-overrides", "--json", "{}", "--nope", "--format", "json");
    expect(JSON.parse(out).error.message).toContain("Unknown argument");
  });
});
