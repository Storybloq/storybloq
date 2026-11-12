/**
 * T-538 commit 4 follow-up: the recording wrapper (onboarding-eval-groups.ts runInGroup) forwards all three
 * onSpawn arguments, so a caller through it gets the run's working group probe, as with the core runInGroup.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUPS_FILE_ENV, readGroups, runInGroup } from "../../scripts/onboarding-eval-groups.js";

const saved = process.env[GROUPS_FILE_ENV];
let dir: string | null = null;
afterEach(() => {
  if (saved === undefined) delete process.env[GROUPS_FILE_ENV]; else process.env[GROUPS_FILE_ENV] = saved;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe.skipIf(process.platform === "win32")("the groups wrapper's onSpawn", () => {
  it("passes the probe through: alive while the group runs, gone once it is confirmed gone, and the launch is recorded", async () => {
    dir = mkdtempSync(join(tmpdir(), "t538-gp-"));
    const file = join(dir, "run.groups.jsonl");
    process.env[GROUPS_FILE_ENV] = file;
    let probe: (() => string) | undefined;
    let during: string | undefined;
    let pgid = 0;
    const g = await runInGroup({
      command: "/bin/sleep", args: ["0.3"], cwd: dir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000,
      onSpawn: (id, _signal, p) => { pgid = id; probe = p; during = typeof p === "function" ? p() : undefined; },
    });
    expect(typeof probe).toBe("function");
    expect(during).toBe("alive");
    expect(g.cleanup).toBe("confirmed");
    expect(probe!()).toBe("gone");
    expect(pgid).toBeGreaterThan(1);
    expect(readGroups(file)).toEqual({ groups: [], unresolved: [], problems: [] });
  });
});
