/**
 * ISS-1456: the gate passes only a reviewer that shows it can start here, not
 * one that only prints a version, and when none can, gate, run and status
 * name the reason. The fake codex answers the start probe the ways codex
 * 0.163.0 was seen to (test/helpers/setup-review-fakes.ts, FAKE_CODEX_PROBE).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { handleSetupReviewGate, handleSetupReviewRun, handleSetupReviewStatus, type SetupReviewIo, type SetupReviewResult } from "../../src/cli/commands/setup-review.js";
import { projectKeyFor, recordShape, SKIPPED_LINE, STOP_LINES, storeSeams } from "../../src/core/setup-review.js";
import { inferredReasons, probeCodexStart, probeReviewer, startProbeSeams } from "../../src/core/setup-review-backends.js";
import { makeFakeBin, makeScratchDir, removeScratchDirs, REVIEW_PACKET, scratchDirsCreated, type FakeBin } from "../helpers/setup-review-fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const STOP = STOP_LINES.join("\n");
const FAST = { attemptMs: 1_500, totalMs: 4_000, killGraceMs: 200 };
const realListen = startProbeSeams.listen;
const realWriteProbe = storeSeams.writeProbe;

let project: string;
let store: string;
let fake: FakeBin;
let spawnLog: string;
let probeLog: string;
let extraEnv: Record<string, string>;

function env(): NodeJS.ProcessEnv {
  return {
    PATH: fake.path, STORYBLOQ_SETUP_REVIEW_DIR: store, FAKE_LOG: fake.log, FAKE_STDIN_DIR: fake.stdinDir,
    FAKE_SPAWN_LOG: spawnLog, FAKE_PROBE_LOG: probeLog, HOME: project, ...extraEnv,
  };
}

function io(stdin?: string): SetupReviewIo {
  return {
    cwd: project, env: env(),
    stdin: () => {
      if (stdin === undefined) throw new Error("stdin must not be read");
      return Buffer.from(stdin);
    },
    deps: { timeoutMs: 2_000, killGraceMs: 200, probeLimits: FAST },
  };
}

const lines = (path: string): Array<Record<string, unknown>> =>
  existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const spawns = (): Array<{ name: string; args: string[] }> => lines(spawnLog) as never;
const probes = (): Array<{ cwd: string; key: string | null; pid: number }> => lines(probeLog) as never;
const reviews = (): number => fake.invocations().length;
const setupIdOf = (r: SetupReviewResult): string => /^Setup id: (SS-[0-9a-f]{8})$/m.exec(r.stdout)![1]!;
const setupJson = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(store, projectKeyFor(project), id, "setup.json"), "utf-8"));
const recordsOf = (id: string): Array<Record<string, unknown>> => {
  const dir = join(store, projectKeyFor(project), id, "records");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("SR-")).map((n) => JSON.parse(readFileSync(join(dir, n, "record.json"), "utf-8"))) : [];
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: refused`), { code });

beforeEach(() => {
  project = makeScratchDir("sr-start-project-");
  store = makeScratchDir("sr-start-store-");
  fake = makeFakeBin(["codex"]);
  spawnLog = join(fake.dir, "..", "spawns.jsonl");
  probeLog = join(fake.dir, "..", "probes.jsonl");
  extraEnv = {};
});

afterEach(() => {
  startProbeSeams.listen = realListen;
  storeSeams.writeProbe = realWriteProbe;
  removeScratchDirs();
});

afterAll(() => {
  expect(scratchDirsCreated().filter((dir) => existsSync(dir))).toEqual([]);
});

async function codexStart(probe: string): Promise<Awaited<ReturnType<typeof probeCodexStart>>> {
  extraEnv = { FAKE_CODEX_PROBE: probe };
  const execDir = makeScratchDir("sr-start-exec-");
  return probeCodexStart(execDir, env(), FAST);
}

describe("the codex start probe (ISS-1456)", () => {
  it("passes only on a request to its own listener carrying its nonce, in the private directory, and stops codex at once", async () => {
    const execDir = makeScratchDir("sr-start-exec-");
    extraEnv = { FAKE_CODEX_PROBE: "reach" };
    const started = Date.now();
    expect(await probeCodexStart(execDir, env(), FAST)).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(FAST.attemptMs);
    const [p] = probes();
    expect(probes()).toHaveLength(1);
    expect(p!.cwd).toBe(realpathSync(execDir));
    expect(p!.key).toBe("set");
    expect(alive(p!.pid)).toBe(false);
    expect(reviews()).toBe(0);
  });

  it("a second request after the latch changes nothing", async () => {
    expect(await codexStart("reach-twice")).toEqual({ ok: true });
    expect(probes()).toHaveLength(1);
  });

  it("the fatal start line is sandbox-start-denied", async () => {
    expect(await codexStart("fatal")).toMatchObject({ ok: false, code: "sandbox-start-denied", detail: expect.stringContaining("failed to initialize in-process app-server client") });
  });

  it("connection noise and a request without the nonce do not outweigh the fatal line", async () => {
    expect(await codexStart("noise-then-fatal")).toMatchObject({ ok: false, code: "sandbox-start-denied" });
  });

  it("waiting for network is network-denied, without waiting out the bound", async () => {
    const started = Date.now();
    expect(await codexStart("netwait")).toMatchObject({ ok: false, code: "network-denied" });
    expect(Date.now() - started).toBeLessThan(FAST.attemptMs);
    expect(probes()).toHaveLength(1);
  });

  it("an unknown flag is flags-unsupported", async () => {
    expect(await codexStart("badflag")).toMatchObject({ ok: false, code: "flags-unsupported" });
  });

  it.each(["silent", "nononce", "wrongroute"])("%s proves nothing: one retry, then probe-inconclusive, never a pass", async (mode) => {
    const r = await codexStart(mode);
    expect(r).toMatchObject({ ok: false, code: "probe-inconclusive" });
    expect(probes()).toHaveLength(2);
    if (mode !== "silent") expect((r as { detail: string }).detail).toMatch(/requests without this check's nonce: POST \/v1\//);
  });

  it("a first attempt that proves nothing and a second that reaches the listener passes", async () => {
    expect(await codexStart("flaky")).toEqual({ ok: true });
    expect(probes()).toHaveLength(2);
  });

  it("a codex that never answers is stopped at each attempt's bound, and the retry stays inside the total bound", async () => {
    const started = Date.now();
    const r = await codexStart("hang");
    expect(r).toMatchObject({ ok: false, code: "probe-inconclusive", detail: expect.stringContaining("no start within") });
    expect(probes()).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(FAST.totalMs + 3 * FAST.killGraceMs + 1_000);
    for (const p of probes()) expect(alive(p.pid)).toBe(false);
  });

  it("no retry when it would pass the total bound", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "hang" };
    const r = await probeCodexStart(makeScratchDir("sr-start-exec-"), env(), { attemptMs: 1_000, totalMs: 1_500, killGraceMs: 200 });
    expect(r).toMatchObject({ ok: false, code: "probe-inconclusive" });
    expect(probes()).toHaveLength(1);
  });

  it.each([
    ["EPERM", /networking is denied in this sandbox/],
    ["EACCES", /networking is denied in this sandbox/],
    ["EADDRNOTAVAIL", /could not open its local listener \(EADDRNOTAVAIL\)/],
  ])("a listener that cannot bind (%s) is probe-listener-failed, and codex is never started", async (code, detail) => {
    startProbeSeams.listen = (server) => { setImmediate(() => server.emit("error", errno(code))); };
    const r = await codexStart("reach");
    expect(r).toMatchObject({ ok: false, code: "probe-listener-failed" });
    expect((r as { detail: string }).detail).toMatch(detail);
    expect(spawns()).toEqual([]);
  });

  it.each(["reach", "fatal", "netwait", "silent", "hang"])("the listener is closed after a %s probe", async (mode) => {
    const servers: Server[] = [];
    startProbeSeams.listen = (server, ready) => { servers.push(server); realListen(server, ready); };
    await codexStart(mode);
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) expect(server.listening).toBe(false);
  });
});

describe("claude's verdict (ISS-1456)", () => {
  beforeEach(() => {
    fake = makeFakeBin(["claude"]);
  });

  it("the sandbox network marker makes claude unavailable, inferred, without starting it", async () => {
    extraEnv = { CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" };
    const r = await probeReviewer("claude", env(), makeScratchDir("sr-start-exec-"), FAST);
    expect(r).toEqual({ state: "unavailable", reason: { backend: "claude", code: "network-disabled-inferred", detail: expect.stringMatching(/inferred from CODEX_SANDBOX_NETWORK_DISABLED=1/) } });
    expect(spawns()).toEqual([]);
  });

  it.each([{}, { CODEX_SANDBOX: "seatbelt" }, { CODEX_SANDBOX_NETWORK_DISABLED: "0" }])("claude stays startable with %j", async (markers) => {
    extraEnv = markers as Record<string, string>;
    expect(await probeReviewer("claude", env(), makeScratchDir("sr-start-exec-"), FAST)).toEqual({ state: "startup-capable", backend: "claude", version: "9.9.9 (Claude Code)" });
  });

  it("an old claude is flags-unsupported, and a missing one version-failed", async () => {
    extraEnv = { FAKE_CLAUDE_OLD: "1" };
    expect(await probeReviewer("claude", env(), makeScratchDir("sr-start-exec-"), FAST)).toMatchObject({ state: "unavailable", reason: { code: "flags-unsupported" } });
    fake = makeFakeBin([]);
    expect(await probeReviewer("claude", env(), makeScratchDir("sr-start-exec-"), FAST)).toMatchObject({ state: "unavailable", reason: { code: "version-failed" } });
  });

  it("inferredReasons reads only the network marker", () => {
    expect(inferredReasons({ CODEX_SANDBOX: "seatbelt" })).toEqual([]);
    expect(inferredReasons({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }).map((r) => r.code)).toEqual(["network-disabled-inferred"]);
  });
});

describe("gate, run and status agree (ISS-1456)", () => {
  it("a codex that only prints a version is not offered: the gate stops with the reason, and the probe line is unchanged", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "fatal" };
    const r = await handleSetupReviewGate(io(), {});
    const id = setupIdOf(r);
    expect(r.exitCode).toBe(0);
    const out = r.stdout.split("\n");
    expect(out[1]).toBe("Reviewer probe: none available");
    expect(out[2]).toMatch(/^Reviewer unavailable: codex: cannot start inside this sandbox \(Error: failed to initialize/);
    expect(out[3]).toMatch(/from a terminal outside the agent/);
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(setupJson(id)).toMatchObject({ probe: null, unavailable: { reasons: [{ backend: "codex", code: "sandbox-start-denied" }, { backend: "claude", code: "version-failed" }] } });
  });

  it("names every backend's reason, codex then claude", async () => {
    fake = makeFakeBin(["codex", "claude"]);
    extraEnv = { FAKE_CODEX_PROBE: "netwait", CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" };
    const r = await handleSetupReviewGate(io(), {});
    expect(r.stdout).toMatch(/^Reviewer unavailable: codex: cannot reach its model from here \(ERROR: Reconnecting\.\.\. waiting for network\); claude: network disabled in this sandbox, inferred/m);
    expect((setupJson(setupIdOf(r)).unavailable as { reasons: Array<{ code: string }> }).reasons.map((x) => x.code)).toEqual(["network-denied", "network-disabled-inferred"]);
  });

  it("run probes the same way: no reviewer starts, the reason is printed, nothing is recorded", async () => {
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    extraEnv = { FAKE_CODEX_PROBE: "fatal" };
    const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toMatch(/^Reviewer probe: none available\nReviewer unavailable: codex: cannot start inside this sandbox/);
    expect(reviews()).toBe(0);
    expect(recordsOf(id)).toEqual([]);
    const forced = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id, backend: "codex" });
    expect(forced.exitCode).toBe(2);
    expect(forced.stdout).toMatch(/Reviewer unavailable: codex: cannot start inside this sandbox/);
    expect(reviews()).toBe(0);
  });

  it("a later passing gate clears the stored reasons", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "fatal" };
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    extraEnv = {};
    const again = await handleSetupReviewGate(io(), { setup: id });
    expect(again.stdout).toContain("Reviewer probe: codex codex-cli 9.9.9\n");
    expect(setupJson(id)).not.toHaveProperty("unavailable");
  });

  it("status of an unreviewed revision repeats the gate's reasons", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "fatal" };
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    const st = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(st.exitCode).toBe(4);
    expect(st.stdout).toMatch(/\nReviewer unavailable: codex: cannot start inside this sandbox/);
  });

  it("a start the sandbox denies after a passing probe is a failed record with the reason, readable by today's reader, using no round", async () => {
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    extraEnv = { FAKE_CODEX_MODE: "fatal" };
    const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toMatch(/\nReviewer unavailable: codex: cannot start inside this sandbox/);
    const [rec] = recordsOf(id);
    expect(rec).toMatchObject({ state: "failed", failure: "exit", reasonCode: "sandbox-start-denied" });
    expect(recordShape(rec, rec!.recordId as string)).not.toBeNull();
    const st = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(st.stdout).toMatch(/Independent review: failed for revision [0-9a-f]{12}, invocation SR-[0-9a-f]{8}\nReviewer unavailable: codex: cannot start/);
    extraEnv = {};
    const ok = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(ok.exitCode).toBe(0);
    expect(recordsOf(id).find((r) => r.state === "completed")).toMatchObject({ round: 1 });
  });

  it("a reason code that is not a string makes the record unreadable", () => {
    const base = { state: "failed", recordId: "SR-00000001", setupId: "SS-00000001", cycle: 1, revisionSha256: "a".repeat(64), backend: "codex", backendVersion: "v", startedAt: "t", endedAt: "t", failure: "exit", exitCode: 1, outputSha256: null, error: "e" };
    expect(recordShape({ ...base, reasonCode: "sandbox-start-denied" }, "SR-00000001")).not.toBeNull();
    expect(recordShape({ ...base, reasonCode: 7 }, "SR-00000001")).toBeNull();
  });
});

describe("a store this process may not write (ISS-1456)", () => {
  it.each(["EPERM", "EACCES", "EROFS"])("%s: the gate starts nothing, writes nothing, and names the store and the inferred reasons", async (code) => {
    fake = makeFakeBin(["codex", "claude"]);
    extraEnv = { CODEX_SANDBOX_NETWORK_DISABLED: "1" };
    storeSeams.writeProbe = () => { throw errno(code); };
    const r = await handleSetupReviewGate(io(), {});
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toMatch(/^Setup id: SS-[0-9a-f]{8}\nReviewer probe: none available\nReviewer unavailable: review store: cannot be written from here \(/);
    expect(r.stdout).toContain(`(${code})`);
    expect(r.stdout).toMatch(/; claude: network disabled in this sandbox, inferred/);
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(spawns()).toEqual([]);
    expect(readdirSync(store)).toEqual([]);
  });

  it("a directory the user cannot write is unwritable too, with no seam", async () => {
    const locked = join(store, "locked");
    mkdirSync(locked, { mode: 0o500 });
    const e = { ...env(), STORYBLOQ_SETUP_REVIEW_DIR: join(locked, "store") };
    const r = await handleSetupReviewGate({ ...io(), env: e }, {});
    chmodSync(locked, 0o700);
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toMatch(/review store: cannot be written from here \(EACCES\)/);
    expect(spawns()).toEqual([]);
  });

  it("any other error stays a storage failure", async () => {
    storeSeams.writeProbe = () => { throw errno("EIO"); };
    const r = await handleSetupReviewGate(io(), {});
    expect(r.exitCode).toBe(6);
    expect(spawns()).toEqual([]);
  });

  it("run of an existing setup starts nothing when the store turns unwritable", async () => {
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    rmSync(spawnLog, { force: true });
    storeSeams.writeProbe = () => { throw errno("EPERM"); };
    const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toMatch(/^Reviewer probe: none available\nReviewer unavailable: review store: cannot be written from here \(EPERM\)/);
    expect(spawns()).toEqual([]);
    expect(recordsOf(id)).toEqual([]);
  });

  it("skip is printed, not recorded, and exits 0; with a writable store it is recorded as before", async () => {
    storeSeams.writeProbe = () => { throw errno("EPERM"); };
    const gate = await handleSetupReviewGate(io(), {});
    const id = setupIdOf(gate);
    const skip = await handleSetupReviewStatus(io(), { setup: id, skipped: true });
    expect(skip).toEqual({ stdout: `Reviewer probe: none available\n${SKIPPED_LINE}\nSetup review: not recorded, the review store is outside this sandbox.\n`, exitCode: 0 });
    expect(readdirSync(store)).toEqual([]);
    storeSeams.writeProbe = realWriteProbe;
    const real = setupIdOf(await handleSetupReviewGate(io(), {}));
    const recorded = await handleSetupReviewStatus(io(), { setup: real, skipped: true });
    expect(recorded.stdout).not.toContain("not recorded");
    expect(setupJson(real)).toHaveProperty("skipped");
  });
});
