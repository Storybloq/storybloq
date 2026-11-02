import { describe, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupApplySeams } from "../../src/core/setup-apply.js";
import { handleSetupApply } from "../../src/cli/commands/setup-apply.js";
import { collector } from "../../scripts/eval-fault-mcp.js";
import { it, ownSeam } from "./t538-seam-owner.js";

const SID = "SS-0123abcd";
const payload = { version: 1, setupId: SID, review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved"] }, ownerLabel: "Sam", project: { name: "demo", type: "npm", language: "typescript" },
  quality: { level: "full", verifyApplies: false, components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: null, verify: null }] },
  governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] }, git: { init: false, gitignore: [] },
  phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" }],
  tickets: [{ key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] }], checkpoints: [], issues: [], coverage: [{ requirement: "R1", text: "sign in", source: "brief", keys: ["K2"] }] };

const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538-owner-")));
const env = { PATH: process.env.PATH ?? "", HOME: dir, STORYBLOQ_SETUP_REVIEW_DIR: join(dir, "store") };
const logA = join(dir, "a.jsonl");
const logB = join(dir, "b.jsonl");
const none = () => { throw new Error("no kill expected"); };
const start = (name: string) => {
  const cwd = join(dir, name);
  mkdirSync(cwd);
  return handleSetupApply({ cwd, env, stdin: () => Buffer.from(JSON.stringify(payload)) }, {});
};
const steps = (f: string): string[] => readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { point?: string }).point ?? "").filter((p) => p.startsWith("step:"));

describe("a run its test abandoned", () => {
  let left: Promise<unknown>;
  let lateInstall: Promise<void>;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  it("is left paused in the middle of its steps", async () => {
    const collect = collector(logA, null, "cli", none);
    let reached!: () => void;
    const paused = new Promise<void>((r) => { reached = r; });
    let once = false;
    ownSeam(async (point, info) => {
      collect(point, info);
      if (!once && point.startsWith("step:")) { once = true; reached(); await gate; }
    });
    left = start("a");
    await paused;
    lateInstall = gate.then(() => ownSeam(() => { throw new Error("the abandoned test's seam ran"); }));
    expect(steps(logA)).toHaveLength(1);
  }, 60_000);

  it("cannot write into the next test's log or replace its seam, and that test's own run still logs", async () => {
    ownSeam(collector(logB, null, "cli", none));
    const installed = setupApplySeams.fault;
    release();
    await left;
    await lateInstall;
    expect(setupApplySeams.fault).toBe(installed);
    expect(steps(logB)).toEqual([]);
    expect(steps(logA)).toHaveLength(1);
    await start("b");
    expect(steps(logB)).toContain("step:validate");
  }, 60_000);
});
