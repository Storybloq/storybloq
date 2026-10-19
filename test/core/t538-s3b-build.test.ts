/**
 * T-538 S3b commit 3: `storybloq setup-verify` runs a BUILD establishment.
 * The approved command runs in its own process group against the spec's
 * deadline. Verified is exit 0 in time, nothing left in the group when it
 * exited, and the group confirmed gone: the ticket completes and only BUILD
 * is rebuilt. Every other outcome writes nothing and prints the run token for
 * a stop; without process groups nothing runs (unsupported, exit 4), and an
 * adapter is refused by name.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setupApply } from "../../src/core/setup-apply.js";
import { setupVerify, setupVerifySeams } from "../../src/core/setup-verify.js";
import { processGroupSeams } from "../../src/core/process-group.js";
import { comp, editTicket, payload, pinEnvironment, t, ticketFile, type PT } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 30_000 });
const { folder } = pinEnvironment("t538-s3b-build");

const realOwn = processGroupSeams.ownGroup;
afterEach(() => {
  processGroupSeams.ownGroup = realOwn;
  setupVerifySeams.afterRun = () => {};
  setupVerifySeams.buildExitObserved = () => {};
});

const TOKEN = /\(run ([0-9a-f]{16})\)\.$/;

const files = async (root: string) => ({
  ticket: await readFile(join(root, ".story", "tickets", "T-002.json"), "utf-8"),
  config: await readFile(join(root, ".story", "config.json"), "utf-8"),
});

type Stages = Record<string, { enabled?: boolean; command?: string }>;
const configOf = async (root: string) => JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8")) as {
  setupVerification: { components: Array<{ test: { status: string }; build: { status: string }; decision?: unknown }> };
  recipeOverrides: { stages: Stages };
};

const groupGone = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
};

/** A finished full-level setup whose BUILD runs `command`, established by T-002 behind the built scaffold T-001. */
async function ready(command: string, workdir = "."): Promise<string> {
  const root = await folder();
  const tickets: PT[] = [t("K2", []), t("K3", ["K2"], { establishes: { component: "app", stage: "build", scaffold: "K2" } }), t("K4", ["K3"])];
  const p = payload({ level: "full", tickets, components: [{ ...comp({ workdir }), build: { command, status: "pending", reason: "no build yet" } }] });
  expect((await setupApply(root, p)).exitCode).toBe(0);
  await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
  return root;
}

const setTimeoutMs = (root: string, ms: number) => editTicket(root, "T-002", (r) => {
  ((r.setup as { verification: { spec: { timeoutMs: number } } }).verification.spec).timeoutMs = ms;
});

describe("a verified BUILD", () => {
  it("completes the ticket, records the result without counts, and rebuilds only BUILD", async () => {
    const root = await ready("echo built");
    const before = await configOf(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r).toEqual({ exitCode: 0, lines: ["Verified: app build; stages on: BUILD"] });
    const ticket = await ticketFile(root, "T-002");
    expect(ticket.status).toBe("complete");
    const result = (ticket.setup as { verification: { result: Record<string, unknown> } }).verification.result;
    expect(result).toMatchObject({ status: "verified" });
    expect(result.counts).toBeUndefined();
    expect(result.tailDigest).toMatch(/^[0-9a-f]{64}$/);
    const after = await configOf(root);
    expect(after.setupVerification.components[0]!.build.status).toBe("verified");
    expect(after.setupVerification.components[0]!.test).toEqual(before.setupVerification.components[0]!.test);
    expect(after.recipeOverrides.stages.BUILD).toMatchObject({ enabled: true, command: "echo built" });
    const { BUILD: _a, ...restAfter } = after.recipeOverrides.stages;
    const { BUILD: _b, ...restBefore } = before.recipeOverrides.stages;
    expect(restAfter).toEqual(restBefore);
  });

  it("runs in the component's workdir with CI, NO_COLOR and FORCE_COLOR set", async () => {
    const root = await folder();
    await mkdir(join(root, "web"));
    const command = `[ "$(basename "$PWD")" = web ] && [ "$CI" = 1 ] && [ "$NO_COLOR" = 1 ] && [ "$FORCE_COLOR" = 0 ]`;
    const tickets: PT[] = [t("K2", []), t("K3", ["K2"], { establishes: { component: "app", stage: "build", scaffold: "K2" } })];
    expect((await setupApply(root, payload({ level: "full", tickets, components: [{ ...comp({ workdir: "web" }), build: { command, status: "pending", reason: "r" } }] }))).exitCode).toBe(0);
    await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
  });
});

describe("a BUILD that does not verify writes nothing and prints its run", () => {
  it("a nonzero exit is failed, with the tail", async () => {
    const root = await ready("echo boom; exit 2");
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toMatch(/^Verification failed: app build: exited with code 2\. T-002 stays as it was \(run [0-9a-f]{16}\)\.$/);
    expect(r.lines).toContain("  | boom");
    expect(await files(root)).toEqual(before);
  });

  it("a timeout is failed, and leaves no process in the group", async () => {
    const root = await ready("echo $$ > leader.pid; sleep 30");
    await setTimeoutMs(root, 300);
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toMatch(/^Verification failed: app build: timed out after 300 ms\. T-002 stays as it was \(run [0-9a-f]{16}\)\.$/);
    expect(groupGone(Number(await readFile(join(root, "leader.pid"), "utf-8")))).toBe(true);
    expect(await files(root)).toEqual(before);
  });

  it("an exit observed after the deadline is a timeout, even an exit 0 that came first", async () => {
    const root = await ready("exit 0");
    await setTimeoutMs(root, 300);
    setupVerifySeams.buildExitObserved = () => {
      const until = Date.now() + 400;
      while (Date.now() < until) { /* the event loop is held across the deadline */ }
    };
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.lines[0]).toMatch(/^Verification failed: app build: timed out after 300 ms\. T-002 stays as it was \(run [0-9a-f]{16}\)\.$/);
    expect(await files(root)).toEqual(before);
  });

  it("a pid left in the group at exit is cleanup-failed, even though the stop then removes it", async () => {
    const root = await ready("sleep 30 & echo $! > left.pid; exit 0");
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toMatch(/^Verification failed: app build: cleanup failed: a process it started was still in its group when it exited\. T-002 stays as it was \(run [0-9a-f]{16}\)\.$/);
    const left = Number(await readFile(join(root, "left.pid"), "utf-8"));
    expect(() => process.kill(left, 0)).toThrow();
    expect(await files(root)).toEqual(before);
  });

  it("a command that cannot start is failed", async () => {
    const root = await ready("echo never", "missing");
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toMatch(/^Verification failed: app build: the command could not start \(.+\)\. T-002 stays as it was \(run [0-9a-f]{16}\)\.$/);
  });

  it("a change during the run is stale (exit 5)", async () => {
    const root = await ready("echo built");
    setupVerifySeams.afterRun = async () => { await editTicket(root, "T-002", (r) => { r.status = "inprogress"; }); };
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(5);
    expect((await configOf(root)).setupVerification.components[0]!.build.status).toBe("pending");
  });
});

describe("resolving a BUILD", () => {
  it("a failed BUILD can be stopped with its run token, and the token goes stale after a change", async () => {
    const root = await ready("exit 1");
    const run = TOKEN.exec((await setupVerify(root, { ticket: "T-002" })).lines[0]!)![1]!;
    expect(await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "fix the build first", run })).toEqual({ exitCode: 0, lines: ["Decision recorded for T-002: stop. Nothing else changed."] });

    const other = await ready("exit 1");
    const stale = TOKEN.exec((await setupVerify(other, { ticket: "T-002" })).lines[0]!)![1]!;
    await editTicket(other, "T-002", (r) => { r.status = "inprogress"; });
    expect((await setupVerify(other, { ticket: "T-002", resolve: "stop", ownerWords: "x", run: stale })).exitCode).toBe(5);
  });

  it("with --run, a prerequisite reopened since the run is stale (exit 5), not a refusal, and nothing is written", async () => {
    const root = await ready("exit 1");
    const run = TOKEN.exec((await setupVerify(root, { ticket: "T-002" })).lines[0]!)![1]!;
    await editTicket(root, "T-001", (r) => { r.status = "open"; r.completedDate = null; });
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "x", run });
    expect(r.exitCode).toBe(5);
    expect(r.lines[0]).toMatch(/^Setup-verify stale: .*T-002 waits on T-001, which is not complete\..*; nothing was written\./);
    expect(await files(root)).toEqual(before);
  });

  it("with --run, a ticket that became terminal since the run is stale (exit 5), not a refusal, and nothing is written", async () => {
    const root = await ready("exit 1");
    const run = TOKEN.exec((await setupVerify(root, { ticket: "T-002" })).lines[0]!)![1]!;
    await editTicket(root, "T-002", (r) => { r.status = "complete"; r.completedDate = "2026-10-19"; });
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "x", run });
    expect(r.exitCode).toBe(5);
    expect(r.lines[0]).toMatch(/^Setup-verify stale: .*T-002 is complete without a verification result.*; nothing was written\./);
    expect(await files(root)).toEqual(before);
  });

  it("with --run, a ticket whose command changed since the run is stale (exit 5) with nothing written; a --ticket naming no ticket is still refused (exit 2)", async () => {
    const root = await ready("exit 1");
    const run = TOKEN.exec((await setupVerify(root, { ticket: "T-002" })).lines[0]!)![1]!;
    await editTicket(root, "T-002", (r) => {
      ((r.setup as { verification: { spec: { command: string } } }).verification.spec).command = "exit 2";
    });
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "x", run });
    expect(r.exitCode).toBe(5);
    expect(r.lines[0]).toMatch(/^Setup-verify stale: .*verification spec and the setup verification record disagree on the command.*; nothing was written\./);
    expect(await files(root)).toEqual(before);
    expect((await setupVerify(root, { ticket: "T-999", resolve: "stop", ownerWords: "x", run })).exitCode).toBe(2);
  });

  it("refuses an adapter by name: BUILD has no evidence to adapt", async () => {
    const root = await ready("exit 1");
    const run = TOKEN.exec((await setupVerify(root, { ticket: "T-002" })).lines[0]!)![1]!;
    const before = await files(root);
    expect(await setupVerify(root, { ticket: "T-002", resolve: "adapter", argv: ["make"], ownerWords: "x", run }))
      .toEqual({ exitCode: 2, lines: ["Setup-verify refused: --resolve adapter: a build stage has no evidence to adapt; its resolutions are leave-off and stop."] });
    expect(await files(root)).toEqual(before);
  });
});

describe("BUILD without process groups (Windows)", () => {
  it("is unsupported (exit 4) with nothing spawned, and leave-off answers it", async () => {
    const root = await ready("echo ran > ran.txt");
    processGroupSeams.ownGroup = false;
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(4);
    expect(r.lines[0]).toMatch(/^Setup-verify stopped: app's build stage cannot run here; nothing was written \(run [0-9a-f]{16}\)\.$/);
    expect(r.lines[1]).toBe("Ambiguity: verification unsupported · T-002 · observed this platform has no process groups to own (Windows); expected a platform that can own the build command's processes · resolutions: leave-off | stop");
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
    expect(await files(root)).toEqual(before);

    const stages = (await configOf(root)).recipeOverrides.stages;
    const left = await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "no builds on this machine", run: TOKEN.exec(r.lines[0]!)![1]! });
    expect(left).toEqual({ exitCode: 0, lines: ["Left off: app build; T-002 is complete and the stages are unchanged."] });
    const after = await configOf(root);
    expect(after.setupVerification.components[0]!.build.status).toBe("left-off");
    expect(after.recipeOverrides.stages).toEqual(stages);
  });
});
