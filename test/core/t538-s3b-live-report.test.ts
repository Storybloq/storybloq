/**
 * T-538 S3b commit 6: the live setup report adds a line per setup checkpoint
 * (ready, or waiting on its open blockers) and a line per recipe stage the
 * level uses (on and why, or off and why). The historical report stays the
 * bytes frozen at finalization.
 */
import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { setupApply, setupReport } from "../../src/core/setup-apply.js";
import { setupVerify } from "../../src/core/setup-verify.js";
import { SID, comp, editTicket, payload, pinEnvironment, t, type PT } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 30_000 });
const { folder } = pinEnvironment("t538-s3b-live");

const REPLAY = join(import.meta.dirname, "fixtures", "t538-replay.sh");
const live = async (root: string) => (await setupReport(root, SID)).lines;
const frozen = async (root: string) => (await setupReport(root, SID, { historical: true })).lines;
const stateLines = (lines: readonly string[]) => lines.filter((l) => l.startsWith("Verification:") || l.startsWith("Checkpoint:"));

async function applied(p: Record<string, unknown>): Promise<string> {
  const root = await folder();
  expect((await setupApply(root, p)).exitCode).toBe(0);
  return root;
}

describe("the live verification lines", () => {
  it("a pending stage names its open establishment ticket, then reads on (verified); the frozen report never carries either", async () => {
    const root = await applied(payload({ components: [comp({ command: `sh ${REPLAY} vitest-pass` })] }));
    const before = await frozen(root);
    expect(stateLines(await live(root))).toEqual(["Verification: TEST: off (pending: T-002 open)"]);
    await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
    expect(stateLines(await live(root))).toEqual(["Verification: TEST: on (verified)"]);
    expect(await frozen(root)).toEqual(before);
    expect(stateLines(before)).toEqual([]);
  });

  it("a left-off stage says so", async () => {
    const unreadable = `sh ${REPLAY} jest-pass`;
    const root = await applied(payload({ components: [comp({ command: unreadable })] }));
    await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
    const run = /\(run ([0-9a-f]{16})\)\.$/.exec((await setupVerify(root, { ticket: "T-002" })).lines[0]!)![1]!;
    expect((await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "later", run })).exitCode).toBe(0);
    expect(stateLines(await live(root))).toEqual(["Verification: TEST: off (left off)"]);
  });

  it("the full level has a line per stage; an established stage is on, and VERIFY where it does not apply is off by level", async () => {
    const established = { ...comp(), test: { command: "npm test", status: "established", runner: "vitest", wrapper: "npm" } };
    const root = await applied(payload({ level: "full", components: [established], tickets: [t("K2", [])] }));
    expect(stateLines(await live(root))).toEqual([
      "Verification: WRITE_TESTS: on (established)",
      "Verification: TEST: on (established)",
      "Verification: BUILD: off (level)",
      "Verification: VERIFY: off (level)",
    ]);
  });

  it("a minimal setup has none", async () => {
    const root = await applied(payload({ level: "minimal", components: [{ ...comp(), test: null }], tickets: [t("K2", [])] }));
    expect(stateLines(await live(root))).toEqual([]);
  });
});

describe("the live checkpoint lines", () => {
  it("waits on the checkpoint's open blockers, then reads ready", async () => {
    const tickets: PT[] = [t("K2", []), t("K3", ["K2"], { establishes: { component: "app", stage: "test", scaffold: "K2" } }), t("K4", ["K3"])];
    const checkpoints = [{ key: "K5", title: "Accept sign in", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: ["K4"] }];
    const root = await applied(payload({ tickets, checkpoints }));
    const before = await frozen(root);
    expect(stateLines(await live(root))).toContain("Checkpoint: Accept sign in (acceptance, owner Sam): waiting on T-001");
    await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
    expect(stateLines(await live(root))).toContain("Checkpoint: Accept sign in (acceptance, owner Sam): ready");
    expect(stateLines(await frozen(root))).toEqual([]);
    expect(await frozen(root)).toEqual(before);
  });
});
