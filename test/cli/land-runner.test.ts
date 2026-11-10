/**
 * ISS-1432 X2, X3: `runLandCommand` around a real landing. The board git
 * report is replaced with a spy so a report failure can be injected (X2) and
 * the report proven never called for a receipt failure (X3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

vi.mock("../../src/core/board-git-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/board-git-state.js")>();
  return { ...actual, reportBoardWrite: vi.fn(actual.reportBoardWrite) };
});

import { reportBoardWrite } from "../../src/core/board-git-state.js";
import { runLandCommand } from "../../src/cli/run.js";
import { handleLand } from "../../src/cli/commands/land.js";
import { landEnv } from "../../src/core/land.js";
import { cleanupTempDirs, isolateGit } from "../mcp/board-git-fixtures.js";
import { CLOCK, commit, fixture, remoteTip, type Fx } from "../core/land-fixtures.js";

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); vi.mocked(reportBoardWrite).mockClear(); });
afterEach(() => { restoreGit(); cleanupTempDirs(); });

const argv = { _: ["land"] };
const opts = (fx: Fx, item: string) => ({
  sha: "HEAD", repo: fx.repo, remote: "origin", branch: "main", boardRoot: fx.board, item,
  secretsScan: true, gitleaksPath: fx.gitleaks, baseEnv: fx.env, clock: () => CLOCK,
});

describe("runLandCommand (ISS-1432)", () => {
  it("X2: a report failure after a confirmed landing keeps exit 0 and says so", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    vi.mocked(reportBoardWrite).mockRejectedValueOnce(new Error("report broke"));
    const md = await runLandCommand(argv, "md", landEnv(fx.env), async () => handleLand(opts(fx, fx.ticket.display), "md"));
    expect(remoteTip(fx)).toBe(sha);
    expect(md.exitCode).toBe(0);
    expect(md.output).toContain(`LANDED ${sha}`);
    expect(md.output).toContain("git report unavailable: report broke");

    const fx2 = await fixture();
    commit(fx2, { "b.txt": "b\n" });
    vi.mocked(reportBoardWrite).mockRejectedValueOnce(new Error("report broke"));
    const json = await runLandCommand(argv, "json", landEnv(fx2.env), async () => handleLand(opts(fx2, fx2.ticket.display), "json"));
    expect(json.exitCode).toBe(0);
    expect((JSON.parse(json.output) as { data: { gitReport?: string } }).data.gitReport).toBe("git report unavailable: report broke");
  });

  it("X3: a receipt failure (exit 3) never runs the report", async () => {
    const fx = await fixture();
    const raw = JSON.parse(readFileSync(fx.ticket.path, "utf-8")) as Record<string, unknown>;
    writeFileSync(fx.ticket.path, JSON.stringify({ ...raw, landings: "x" }, null, 2));
    commit(fx, { "b.txt": "b\n" });
    const res = await runLandCommand(argv, "md", landEnv(fx.env), async () => handleLand(opts(fx, fx.ticket.display), "md"));
    expect(res.exitCode).toBe(3);
    expect(vi.mocked(reportBoardWrite)).not.toHaveBeenCalled();
  });
});
