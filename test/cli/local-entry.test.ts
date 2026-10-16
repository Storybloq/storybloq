import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";

const probes = vi.hoisted(() => ({
  housekeeping: vi.fn(async () => {}),
  banner: vi.fn(() => ({ stdout: "", stderr: "" })),
  status: vi.fn(() => ({ stdout: [], stderr: [] })),
  update: vi.fn(() => true),
}));
vi.mock("../../src/cli/housekeeping.js", () => ({
  shouldSkipHousekeeping: () => false,
  preCommandHousekeeping: probes.housekeeping,
}));
vi.mock("../../src/core/session-intel/push.js", () => ({
  cliBannerFor: probes.banner, cliStatusPushesFor: probes.status,
}));
vi.mock("../../src/core/update-check.js", async (original) => ({
  ...await original<typeof import("../../src/core/update-check.js")>(),
  shouldEmitUpdateBanner: probes.update,
  readUpdateCacheSync: () => null,
  formatUpdateBanner: () => "",
}));
let root: string | undefined;
const originalArgv = process.argv;
const savedEnv = Object.fromEntries(["STORYBLOQ_PROJECT_ROOT", "CLAUDESTORY_PROJECT_ROOT", "STORYBLOQ_APPROVED_NODE_ROOTS"].map((key) => [key, process.env[key]]));
afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = 0;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it("the real local entry disables every notification boundary while ordinary dispatch keeps them", async () => {
  root = await mkdtemp(join(tmpdir(), "storybloq-local-entry-"));
  await initProject(root, { name: "Entry fixture" });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(process, "chdir").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.env.STORYBLOQ_PROJECT_ROOT = root;
  process.argv = [process.execPath, "cli.js", "--local-cli", "recap"];
  vi.resetModules();
  await import("../../src/cli/index.js");
  expect(process.exitCode ?? 0).toBe(0);
  expect(probes.housekeeping).not.toHaveBeenCalled();
  expect(probes.banner).not.toHaveBeenCalled();
  expect(probes.status).not.toHaveBeenCalled();
  expect(probes.update).not.toHaveBeenCalled();

  process.argv = [process.execPath, "cli.js", "recap"];
  vi.resetModules();
  await import("../../src/cli/index.js");
  expect(probes.housekeeping).toHaveBeenCalledOnce();
  expect(probes.banner).toHaveBeenCalledOnce();
  expect(probes.update).toHaveBeenCalledOnce();
});
