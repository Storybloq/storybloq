import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/core/session-intel/push.js", () => ({
  cliBannerFor: vi.fn(() => ({ stdout: "", stderr: "" })),
  cliStatusPushesFor: vi.fn(() => ({ stdout: [], stderr: [] })),
}));
import { cliBannerFor, cliStatusPushesFor } from "../../src/core/session-intel/push.js";
import { configureCliNotifications, runReadCommand } from "../../src/cli/run.js";
import { initProject } from "../../src/core/init.js";

const roots: string[] = [];
afterEach(async () => {
  configureCliNotifications(true);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("local reads never sample inherited client presence; ordinary reads retain their banner", async () => {
  const root = await mkdtemp(join(tmpdir(), "storybloq-local-notify-"));
  roots.push(root);
  await initProject(root, { name: "Bound" });
  process.env.STORYBLOQ_PROJECT_ROOT = root;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  configureCliNotifications(false);
  await runReadCommand("json", () => ({ output: "{}" }));
  await runReadCommand("json", () => ({ output: "{}" }), { usageAdvisory: true });
  expect(cliBannerFor).not.toHaveBeenCalled();
  expect(cliStatusPushesFor).not.toHaveBeenCalled();
  configureCliNotifications(true);
  await runReadCommand("json", () => ({ output: "{}" }));
  expect(cliBannerFor).toHaveBeenCalledOnce();
});
