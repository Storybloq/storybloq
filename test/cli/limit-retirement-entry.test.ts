/**
 * T-534: the CLI entry to the usage-limit retirement. It never throws, costs
 * one lstat once the marker exists, and reports an incomplete retirement on
 * stderr unless the caller reports it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { retireLimitAutoResumeBestEffort, sessionAttentionNotes } from "../../src/cli/limit-retirement-entry.js";

let home: string;
let globalDir: string;
let stderr: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t534-entry-home-"));
  globalDir = join(home, "global");
  mkdirSync(join(home, ".claude"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("STORYBLOQ_GLOBAL_DIR", globalDir);
  // No current project: an explicit root without .story/ never walks up.
  vi.stubEnv("STORYBLOQ_PROJECT_ROOT", join(home, "no-project"));
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("retireLimitAutoResumeBestEffort", () => {
  it("retires a clean HOME once, then short-circuits on the marker", async () => {
    expect((await retireLimitAutoResumeBestEffort("1.16.0", { cwd: home })).kind).toBe("retired");
    const marker = readFileSync(join(globalDir, ".limit-retired-v1"), "utf-8");
    expect(JSON.parse(marker)).toMatchObject({ cliVersion: "1.16.0" });
    expect((await retireLimitAutoResumeBestEffort("1.16.1", { cwd: home })).kind).toBe("already");
    expect(readFileSync(join(globalDir, ".limit-retired-v1"), "utf-8")).toBe(marker);
    expect(stderr).toEqual([]);
  });

  it("reports an incomplete retirement on stderr, and stays quiet when the caller reports", async () => {
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "limit-ledger.json"), "{broken");

    const first = await retireLimitAutoResumeBestEffort("1.16.0", { cwd: home });
    expect(first.kind).toBe("incomplete");
    expect(stderr.join("")).toContain("did not finish");

    stderr.length = 0;
    const second = await retireLimitAutoResumeBestEffort("1.16.0", { cwd: home, report: "none" });
    expect(second.kind).toBe("incomplete");
    expect(stderr).toEqual([]);
  });

  it("names sessions it skipped on stderr, and returns them for a caller that reports", async () => {
    const seedLedger = () => {
      mkdirSync(globalDir, { recursive: true });
      const deadPid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid!;
      writeFileSync(join(globalDir, "limit-ledger.json"), JSON.stringify({
        schemaVersion: 1,
        records: {
          "claude:t1": {
            clientTaskId: "t1",
            projectRoot: join(home, "gone-project"),
            storybloqSessionId: "s1",
            attempt: { id: "a1", childPid: deadPid },
          },
        },
      }));
    };

    seedLedger();
    const reported = await retireLimitAutoResumeBestEffort("1.16.0", { cwd: home });
    expect(reported.kind).toBe("retired");
    const notes = sessionAttentionNotes(reported);
    expect(notes.some((n) => n.includes("gone-project") && n.includes("missing"))).toBe(true);
    expect(stderr.join("")).toContain("left untouched");
    expect(stderr.join("")).toContain("gone-project");
    // Routine cleanup notes never reach the user.
    expect(stderr.join("")).not.toContain("removed");

    rmSync(join(globalDir, ".limit-retired-v1"));
    stderr.length = 0;
    seedLedger();
    const silent = await retireLimitAutoResumeBestEffort("1.16.0", { cwd: home, report: "none" });
    expect(sessionAttentionNotes(silent).length).toBeGreaterThan(0);
    expect(stderr).toEqual([]);
  });
});
