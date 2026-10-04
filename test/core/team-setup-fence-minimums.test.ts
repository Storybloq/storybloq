/**
 * T-486 F4c: team setup raises the fence for EVERY capability minimum, not
 * only the rulings one. The shipped minimums are equal (both 1.16.0), so a
 * setup that passed only the rulings minimum would still read "raised" for
 * resolution kinds. Here the capability module is replaced so the two
 * minimums differ, and each fence outcome is asserted on its own.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixed for the file: a mocked module's constants are bound once. Only the
// CLI version, read through a function, changes per case.
const caps = vi.hoisted(() => ({ cli: "1.16.5" }));

vi.mock("../../src/core/team-capabilities.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/team-capabilities.js")>();
  return {
    ...real,
    RULING_LIFECYCLE_MIN_CLI_VERSION: "1.15.5",
    RESOLUTION_KIND_MIN_CLI_VERSION: "1.17.0",
    TEAM_FENCE_MINIMUMS: ["1.15.5", "1.17.0"],
    currentCliVersion: () => caps.cli,
  };
});

const { initProject } = await import("../../src/core/init.js");
const { teamSetup } = await import("../../src/core/team-setup.js");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function board(fence: string | null): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-fence-minimums-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await initProject(root, { name: "t486" });
  const path = join(root, ".story", "config.json");
  const config = JSON.parse(readFileSync(path, "utf-8"));
  config.team = fence === null ? { enabled: true } : { enabled: true, minCliVersion: fence };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return root;
}

const fenceOf = (root: string) => JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")).team.minCliVersion;

describe("team setup decides each differing capability minimum (T-486 F4c)", () => {
  it("defers the resolution-kind minimum this CLI cannot pass, after raising the rulings one", async () => {
    caps.cli = "1.16.5";
    const root = await board(null);
    const result = await teamSetup(root);
    expect(result.rulingFence).toBe("raised");
    expect(result.resolutionKindFence).toBe("deferred");
    expect(fenceOf(root)).toBe("1.16.5");
  });

  it("raises past the rulings minimum to the resolution-kind one", async () => {
    caps.cli = "1.17.2";
    const root = await board("1.15.0");
    const result = await teamSetup(root);
    expect(result.rulingFence).toBe("raised");
    expect(result.resolutionKindFence).toBe("raised");
    expect(fenceOf(root)).toBe("1.17.0");
  });
});
