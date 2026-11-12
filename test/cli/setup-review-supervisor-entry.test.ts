/**
 * ISS-1497: the suite exercises the supervisor bundled from the current src,
 * whatever dist holds, while the product's own resolution is unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { supervisorEntry, supervisorSeams } from "../../src/core/setup-review-supervisor.js";
import { TEST_SUPERVISOR_ENV, useTestSupervisorEntry } from "../helpers/test-supervisor-entry.js";
import { makeFakeBin, removeScratchDirs } from "../helpers/setup-review-fakes.js";

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const DIST = join(PKG_ROOT, "dist");
const SRC_CORE = join(PKG_ROOT, "src", "core");

afterEach(() => removeScratchDirs());

describe("ISS-1497: the suite's supervisor comes from src, not dist", () => {
  it("under the suite the seam names the run's bundle: outside dist, present, and declared ESM by its .mjs extension", () => {
    const entry = supervisorSeams.entry();
    expect(entry).toBe(process.env[TEST_SUPERVISOR_ENV]);
    expect(entry.startsWith(DIST + sep)).toBe(false);
    expect(existsSync(entry)).toBe(true);
    expect(entry.endsWith(".mjs")).toBe(true);
  });

  it("in a package copy with no dist supervisor, a supervised fake review still completes", async () => {
    // A private copy of the supervisor module and its one local import: its supervisorEntry() resolves
    // against this temp package root, which has no dist, so the checkout's dist is never touched.
    const pkg = mkdtempSync(join(tmpdir(), "storybloq-sup-pkg-"));
    try {
      const core = join(pkg, "src", "core");
      mkdirSync(core, { recursive: true });
      for (const f of ["setup-review-supervisor.ts", "process-group.ts"]) copyFileSync(join(SRC_CORE, f), join(core, f));
      const copy = (await import(join(core, "setup-review-supervisor.ts"))) as typeof import("../../src/core/setup-review-supervisor.js");
      expect(existsSync(copy.supervisorEntry())).toBe(false);
      useTestSupervisorEntry(copy.supervisorSeams);
      const fake = makeFakeBin(["codex"]);
      const run = await copy.runSupervised("codex", ["--version"], { cwd: fake.stdinDir, env: { PATH: fake.path }, input: "", timeoutMs: 20_000 });
      expect(run).toMatchObject({ exitCode: 0, supervisorError: null, spawnError: null });
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }, 30_000);

  it("the product still resolves src/core's sibling first, then dist, without the seam", () => {
    const candidates = [join(SRC_CORE, "setup-review-supervisor.js"), join(DIST, "setup-review-supervisor.js")];
    expect(supervisorEntry()).toBe(candidates.find((p) => existsSync(p)) ?? candidates[0]);
  });
});
