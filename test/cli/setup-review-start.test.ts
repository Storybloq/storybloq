/**
 * ISS-1456: the gate passes only a reviewer that shows it can start here, not
 * one that only prints a version, and when none can, gate, run and status
 * name the reason. The fake codex answers the start probe the ways codex
 * 0.163.0 was seen to (test/helpers/setup-review-fakes.ts, FAKE_CODEX_PROBE).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { supervisorEntry, supervisorSeams } from "../../src/core/setup-review-supervisor.js";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { handleSetupReviewGate, handleSetupReviewRun, handleSetupReviewStatus, type SetupReviewIo, type SetupReviewResult } from "../../src/cli/commands/setup-review.js";
import { projectKeyFor, recordShape, SKIPPED_LINE, STOP_LINES, storeSeams } from "../../src/core/setup-review.js";
import { CHARACTERISED_CODEX_VERSIONS, CODEX_ISOLATION_FLAGS, codexArgs, inferredReasons, probeCodexStart, probeReviewer, startProbeSeams } from "../../src/core/setup-review-backends.js";
import { processGroupSeams, signalGroup } from "../../src/core/process-group.js";
import { makeFakeBin, makeScratchDir, removeScratchDirs, REVIEW_PACKET, scratchDirsCreated, type FakeBin } from "../helpers/setup-review-fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const STOP = STOP_LINES.join("\n");
const FAST = { attemptMs: 1_500, totalMs: 4_000, killGraceMs: 200 };
const realListen = startProbeSeams.listen;
const realSignal = startProbeSeams.signal;
const realGroupProbe = processGroupSeams.probe;
/** Scheduling slack on an absolute bound: timers, a reap, a listener close. */
const SLACK_MS = 150;
const realWriteProbe = storeSeams.writeProbe;

let project: string;
let store: string;
/** ISS-1457: the home is outside the project, as CODEX_HOME inside it is refused. */
let home: string;
let tmpRoot: string;
let fake: FakeBin;
let spawnLog: string;
let probeLog: string;
let extraEnv: Record<string, string>;

function env(): NodeJS.ProcessEnv {
  return {
    PATH: fake.path, STORYBLOQ_SETUP_REVIEW_DIR: store, FAKE_LOG: fake.log, FAKE_STDIN_DIR: fake.stdinDir,
    FAKE_SPAWN_LOG: spawnLog, FAKE_PROBE_LOG: probeLog, HOME: home, TMPDIR: tmpRoot, ...extraEnv,
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
  home = makeScratchDir("sr-start-home-");
  tmpRoot = makeScratchDir("sr-start-tmp-");
  store = makeScratchDir("sr-start-store-");
  fake = makeFakeBin(["codex"]);
  spawnLog = join(fake.dir, "..", "spawns.jsonl");
  probeLog = join(fake.dir, "..", "probes.jsonl");
  extraEnv = {};
});

afterEach(() => {
  startProbeSeams.listen = realListen;
  startProbeSeams.signal = realSignal;
  processGroupSeams.probe = realGroupProbe;
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

  it("a second request after the latch changes nothing: both are answered, the pass latches once, and the stop starts once", async () => {
    const respLog = join(fake.dir, "..", "responses.log");
    const signals: string[] = [];
    // The real stop, held back so codex can make its second request first.
    startProbeSeams.signal = (child, sig) => { signals.push(sig); setTimeout(() => signalGroup(child, sig), 400); };
    extraEnv = { FAKE_CODEX_PROBE: "reach-twice", FAKE_RESP_LOG: respLog };
    expect(await probeCodexStart(makeScratchDir("sr-start-exec-"), env(), FAST)).toEqual({ ok: true });
    expect(readFileSync(respLog, "utf-8")).toBe("1\n2\n");
    expect(signals).toEqual(["SIGKILL"]);
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

  it("a codex that never answers is stopped at each attempt's bound, and both attempts and their stops end by the total bound", async () => {
    const started = Date.now();
    const r = await codexStart("hang");
    expect(r).toMatchObject({ ok: false, code: "probe-inconclusive", detail: expect.stringContaining("no start within") });
    expect(probes()).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(FAST.totalMs + SLACK_MS);
    for (const p of probes()) expect(alive(p.pid)).toBe(false);
  });

  it("a late inconclusive first attempt, then a codex that ignores SIGTERM: the retry and its stop are clamped to the total bound", async () => {
    // Today's grace periods would carry the second attempt past the total: 1.4 s + 1.5 s + 0.4 s.
    // The first attempt ends at a deadline this row sets from its own start, not from the fake's (load-dependent)
    // start, and the retry is counted where the probe stops it, so the row needs no spare wall-clock room.
    const limits = { attemptMs: 1_500, totalMs: 3_000, killGraceMs: 400 };
    const started = Date.now();
    extraEnv = { FAKE_CODEX_PROBE: "late-then-stubborn", FAKE_LATE_UNTIL: String(started + 1_400) };
    const sent: Array<[number | undefined, NodeJS.Signals]> = [];
    const realSignal = startProbeSeams.signal;
    startProbeSeams.signal = (child, sig) => {
      sent.push([child.pid, sig]);
      realSignal(child, sig);
    };
    const r = await probeCodexStart(makeScratchDir("sr-start-exec-"), env(), limits);
    expect(r).toMatchObject({ ok: false, code: "probe-inconclusive" });
    // Two distinct attempts: the fake tells them apart by its own probe log (the first line is the first
    // attempt), and each logs its pid. The second, which ignores SIGTERM, is the one the probe had to stop:
    // SIGTERM at its clamped bound, then SIGKILL.
    const attempts = probes();
    expect(attempts).toHaveLength(2);
    const [first, second] = attempts.map((p) => p.pid);
    expect(first).not.toBe(second);
    const toSecond = sent.filter(([pid]) => pid === second).map(([, sig]) => sig);
    expect(toSecond.slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(limits.totalMs + SLACK_MS);
    for (const p of probes()) expect(alive(p.pid)).toBe(false);
  });

  it("a grace period longer than the time left is clamped, so it does not take the start window: a codex that reaches the listener after 300 ms passes", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "slow-reach", FAKE_LATE_MS: "300" };
    const started = Date.now();
    expect(await probeCodexStart(makeScratchDir("sr-start-exec-"), env(), { attemptMs: 1_000, totalMs: 1_200, killGraceMs: 1_000 })).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(1_200 + SLACK_MS);
    expect(probes()).toHaveLength(1);
  });

  it("a listener that never becomes ready ends at the total bound, and codex is never started", async () => {
    startProbeSeams.listen = () => { /* never ready */ };
    const started = Date.now();
    const r = await probeCodexStart(makeScratchDir("sr-start-exec-"), env(), { attemptMs: 500, totalMs: 800, killGraceMs: 100 });
    expect(r).toMatchObject({ ok: false, code: "probe-inconclusive" });
    expect(Date.now() - started).toBeLessThan(800 + SLACK_MS);
    expect(spawns()).toEqual([]);
  });

  it("a codex that exits without a request is stopped with its whole group: a child it left behind is gone", async () => {
    const orphans = join(fake.dir, "..", "orphans.log");
    extraEnv = { FAKE_CODEX_PROBE: "orphan", FAKE_ORPHAN_LOG: orphans };
    const pids = (): number[] => (existsSync(orphans) ? readFileSync(orphans, "utf-8").split("\n").filter(Boolean).map(Number) : []);
    try {
      const r = await probeCodexStart(makeScratchDir("sr-start-exec-"), env(), FAST);
      expect(r).toMatchObject({ ok: false, code: "probe-inconclusive", detail: expect.stringContaining("exited with status 1") });
      expect(pids()).toHaveLength(2);
      const until = Date.now() + 1_000;
      while (pids().some(alive) && Date.now() < until) await new Promise((res) => setTimeout(res, 25));
      for (const pid of pids()) expect(alive(pid)).toBe(false);
    } finally {
      for (const pid of pids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  });

  describe("after codex exits, its group is signalled only when a probe in the same step finds it alive (ISS-1457 round 2)", () => {
    // A codex that exits at once without a request: every attempt ends on its close, after its exit.
    async function silentRun(answer: () => void): Promise<{ r: Awaited<ReturnType<typeof probeCodexStart>>; sent: Array<[number | undefined, NodeJS.Signals]> }> {
      const sent: Array<[number | undefined, NodeJS.Signals]> = [];
      // Recorded, never delivered: the leader is gone and the group id may already be someone else's.
      startProbeSeams.signal = (child, sig) => { sent.push([child.pid, sig]); };
      processGroupSeams.probe = answer;
      const r = await codexStart("silent");
      return { r, sent };
    }
    const fail = (code: string) => (): never => { throw Object.assign(new Error(code), { code }); };

    it("a group seen gone gets no signal at all", async () => {
      const { r, sent } = await silentRun(fail("ESRCH"));
      expect(r).toMatchObject({ ok: false, code: "probe-inconclusive" });
      expect(probes().length).toBeGreaterThanOrEqual(1);
      expect(sent).toEqual([]);
    });

    it("a group still alive gets exactly one SIGKILL per attempt", async () => {
      const { sent } = await silentRun(() => {});
      const pids = probes().map((p) => p.pid);
      expect(pids.length).toBeGreaterThanOrEqual(1);
      expect(sent).toEqual(pids.map((pid) => [pid, "SIGKILL"]));
    });

    it("a group that answers EPERM gets no signal, and the attempt names it", async () => {
      const { r, sent } = await silentRun(fail("EPERM"));
      expect(sent).toEqual([]);
      const last = probes().at(-1)!.pid;
      expect((r as { detail: string }).detail).toContain(`process group ${last} answered EPERM after codex exited, so it was not signalled`);
    });

    // ISS-1470: through the production signal, with only the kill itself failing: the probe answers alive,
    // and the kill's own answer decides what the attempt says.
    it.each([
      ["EPERM", (pid: number) => `process group ${pid} could not be signalled after codex exited (EPERM)`],
      ["ESRCH", (pid: number) => `process group ${pid} was already gone when it was signalled after codex exited`],
    ])("the production signal reports a kill that fails with %s after an alive probe, never as sent", async (code, text) => {
      processGroupSeams.probe = () => {};
      const realKill = process.kill.bind(process);
      const tried: Array<[number, string | number | undefined]> = [];
      vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
        if (pid < 0 && sig !== 0) { tried.push([pid, sig]); throw Object.assign(new Error(code), { code }); }
        return realKill(pid, sig as NodeJS.Signals);
      }) as typeof process.kill);
      try {
        const r = await codexStart("silent");
        const last = probes().at(-1)!.pid;
        expect(tried).toContainEqual([-last, "SIGKILL"]);
        expect((r as { detail: string }).detail).toContain(text(last));
        expect((r as { detail: string }).detail).not.toContain("answered");
      } finally {
        vi.restoreAllMocks();
      }
    });
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

describe("codex starts only with what it loads shut off (ISS-1457)", () => {
  const probeSpawns = (): number => spawns().filter((x) => x.args.some((a) => a.startsWith("model_providers.storybloq_probe="))).length;

  it("every codex launch carries the three isolation flags, the hook-trust bypass never, and no -c naming mcp_servers", () => {
    const args = codexArgs("/s/schema.json", "/s/out.json", ["-c", 'model_provider="storybloq_probe"']);
    expect(CODEX_ISOLATION_FLAGS).toEqual(["--ignore-user-config", "--ignore-rules", "--disable", "hooks", "--disable", "plugins"]);
    for (const flag of ["--ignore-user-config", "--ignore-rules"]) expect(args).toContain(flag);
    const disabled = args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []));
    expect(disabled.sort()).toEqual(["hooks", "plugins"]);
    expect(args.filter((a, i) => args[i - 1] === "-c" && /mcp_servers/.test(a))).toEqual([]);
    expect(args.some((a) => /trust|bypass|dangerously/.test(a))).toBe(false);
    expect(args).not.toContain("--strict-config");
    expect(CHARACTERISED_CODEX_VERSIONS).toEqual(["0.163.0"]);
  });

  it("the start probe launches with the isolation flags too", async () => {
    expect(await codexStart("reach")).toEqual({ ok: true });
    const [launch] = spawns().filter((x) => x.args.some((a) => a.startsWith("model_providers.storybloq_probe=")));
    for (const flag of CODEX_ISOLATION_FLAGS) expect(launch!.args).toContain(flag);
  });

  it("the characterised version with every flag and feature reaches the start probe", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "reach" };
    expect(await probeReviewer("codex", env(), makeScratchDir("sr-start-exec-"), FAST)).toEqual({ state: "startup-capable", backend: "codex", version: "codex-cli 0.163.0" });
    expect(spawns().map((x) => x.args.slice(0, 2).join(" ")).slice(0, 3)).toEqual(["--version", "exec --help", "features list"]);
    expect(probeSpawns()).toBe(1);
  });

  it.each([
    ["a newer version", { FAKE_CODEX_VERSION: "0.164.0" }, /isolation is proven only for codex 0\.163\.0, not 0\.164\.0/],
    ["an older version", { FAKE_CODEX_VERSION: "0.162.9" }, /not 0\.162\.9/],
    ["a version with no number", { FAKE_CODEX_VERSION: "dev" }, /not dev/],
    ["a pre-release of the characterised version", { FAKE_CODEX_VERSION: "0.163.0-alpha.1" }, /not 0\.163\.0-alpha\.1/],
    ["a custom build of the characterised version", { FAKE_CODEX_VERSION: "0.163.0-custom" }, /not 0\.163\.0-custom/],
    ["the version with words after it", { FAKE_CODEX_VERSION: "0.163.0 (patched)" }, /isolation is proven only/],
    ["garbage", { FAKE_CODEX_VERSION_RAW: "Segmentation fault 0.163.0\n" }, /not "Segmentation fault 0\.163\.0"/],
    ["a second line after the version", { FAKE_CODEX_VERSION_RAW: "codex-cli 0.163.0\nwarning: unofficial build\n" }, /isolation is proven only/],
    ["help without --skip-git-repo-check, every isolation flag listed", { FAKE_CODEX_HELP_DROP: "--skip-git-repo-check" }, /does not list --skip-git-repo-check/],
    ["help without --output-schema", { FAKE_CODEX_HELP_DROP: "--output-schema" }, /does not list --output-schema/],
    ["help without --ephemeral", { FAKE_CODEX_HELP_DROP: "--ephemeral" }, /does not list --ephemeral/],
    ["help without --sandbox", { FAKE_CODEX_HELP_DROP: "--sandbox" }, /does not list --sandbox/],
    ["help without -o and its long form", { FAKE_CODEX_HELP_DROP: "-o" }, /does not list -o/],
    ["help with --output-last-message but no -o", { FAKE_CODEX_HELP_NOSHORT: "-o" }, /does not list -o/],
    ["help with --sandbox but no -s", { FAKE_CODEX_HELP_NOSHORT: "-s" }, /does not list -s/],
    ["help without --ignore-user-config", { FAKE_CODEX_HELP_DROP: "--ignore-user-config" }, /codex exec --help does not list --ignore-user-config/],
    ["help without --ignore-rules", { FAKE_CODEX_HELP_DROP: "--ignore-rules" }, /does not list --ignore-rules/],
    ["help without --disable", { FAKE_CODEX_HELP_DROP: "--disable" }, /does not list --disable/],
    ["a failed help call", { FAKE_CODEX_HELP_FAIL: "1" }, /codex exec --help did not answer/],
    ["features without hooks", { FAKE_CODEX_FEATURES_DROP: "hooks" }, /codex features list does not name hooks/],
    ["features without plugins", { FAKE_CODEX_FEATURES_DROP: "plugins" }, /does not name plugins/],
    ["a failed features call", { FAKE_CODEX_FEATURES_FAIL: "1" }, /codex features list did not answer/],
  ])("%s is isolation-unverified, and codex is never started", async (_name, vars, detail) => {
    extraEnv = { FAKE_CODEX_PROBE: "reach", ...vars };
    const r = await probeReviewer("codex", env(), makeScratchDir("sr-start-exec-"), FAST);
    expect(r).toEqual({ state: "unavailable", reason: { backend: "codex", code: "isolation-unverified", detail: expect.stringMatching(detail) } });
    expect(probeSpawns()).toBe(0);
    expect(probes()).toEqual([]);
  });

  it("a feature named only inside a longer name does not count", async () => {
    // plugin_hooks stays listed while plugins is dropped.
    extraEnv = { FAKE_CODEX_PROBE: "reach", FAKE_CODEX_FEATURES_DROP: "plugins" };
    expect(await probeReviewer("codex", env(), makeScratchDir("sr-start-exec-"), FAST)).toMatchObject({ state: "unavailable", reason: { code: "isolation-unverified" } });
  });

  it("the gate names the reason, offers no reviewer, and gives no sandbox hint", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "reach", FAKE_CODEX_VERSION: "0.164.0" };
    const r = await handleSetupReviewGate(io(), {});
    const out = r.stdout.split("\n");
    expect(out[1]).toBe("Reviewer probe: none available");
    expect(out[2]).toMatch(/^Reviewer unavailable: codex: isolation is proven only for codex 0\.163\.0, not 0\.164\.0; claude: /);
    expect(r.stdout).not.toMatch(/from a terminal outside the agent/);
    expect(reviews()).toBe(0);
    expect(probeSpawns()).toBe(0);
  });
});

describe("nothing planted under HOME starts through the real launch builder (ISS-1457)", () => {
  const plant = (marker: string): void => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.sentinel]\ncommand = "/bin/sh"\nargs = ["-c", "touch ${marker}; sleep 20"]\n`);
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}.hook` }] }] } }));
  };

  it("the fake models the route: started without the flags, it runs what was planted", () => {
    const marker = join(home, "MARKER");
    plant(marker);
    // Its answer goes to a file under the scratch home, never to the package folder this suite runs in.
    const before = readdirSync(process.cwd()).sort();
    spawnSync(join(fake.dir, "codex"), ["exec", "-o", join(home, "out.json"), "-"], { cwd: home, env: { PATH: fake.path, HOME: home }, input: "" });
    expect(readdirSync(process.cwd()).sort()).toEqual(before);
    expect(existsSync(join(process.cwd(), "exec"))).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(`${marker}.hook`)).toBe(true);
  });

  it("gate and run start the probe and the review, and neither starts the planted server or hook", async () => {
    const marker = join(home, "MARKER");
    plant(marker);
    extraEnv = { FAKE_CODEX_PROBE: "reach" };
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(run.exitCode).toBe(0);
    expect(reviews()).toBe(1);
    expect(probes().length).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}.hook`)).toBe(false);
  });
});

describe("no reviewer starts from an untrusted place (ISS-1457)", () => {
  it("a CODEX_HOME inside the project skips codex with its reason, before any codex call", async () => {
    fake = makeFakeBin(["codex", "claude"]);
    extraEnv = { FAKE_CODEX_PROBE: "reach", CODEX_HOME: join(project, ".codex") };
    mkdirSync(join(project, ".codex"));
    const r = await handleSetupReviewGate(io(), {});
    expect(r.stdout).toMatch(/^Reviewer probe: claude 9\.9\.9 \(Claude Code\)$/m);
    expect((setupJson(setupIdOf(r)).probe as { backend: string }).backend).toBe("claude");
    expect(spawns().filter((x) => x.name === "codex")).toEqual([]);
  });

  it("a store reached through a link at or below it offers no reviewer and starts nothing", async () => {
    const realStore = makeScratchDir("sr-start-linked-");
    mkdirSync(join(realStore, "inner"));
    symlinkSync(join(realStore, "inner"), join(realStore, "via"));
    store = join(realStore, "via");
    extraEnv = { FAKE_CODEX_PROBE: "reach" };
    const r = await handleSetupReviewGate(io(), {});
    expect(r.stdout).toMatch(/^Reviewer probe: none available\nReviewer unavailable: review store: .*goes through a link/m);
    expect(spawns()).toEqual([]);
  });

  it("run refuses a staging folder that became untrusted after the probe, before the reviewer starts", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "reach" };
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    chmodSync(join(store, projectKeyFor(project)), 0o777);
    try {
      const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
      expect(reviews()).toBe(0);
      expect(run.stdout).toMatch(/Reviewer unavailable|untrusted location/);
    } finally {
      chmodSync(join(store, projectKeyFor(project)), 0o700);
    }
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

  it("a supervisor that cannot start is a failed record with its reason, and no reviewer runs (ISS-1457)", async () => {
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    supervisorSeams.entry = () => join(home, "no-supervisor.js");
    try {
      const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
      expect(run.exitCode).not.toBe(0);
      expect(reviews()).toBe(0);
      expect(recordsOf(id)[0]).toMatchObject({ state: "failed", failure: "spawn", reasonCode: "supervisor-failed" });
    } finally {
      supervisorSeams.entry = supervisorEntry;
    }
  });

  it("a later passing gate clears the stored reasons", async () => {
    extraEnv = { FAKE_CODEX_PROBE: "fatal" };
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    extraEnv = {};
    const again = await handleSetupReviewGate(io(), { setup: id });
    expect(again.stdout).toContain("Reviewer probe: codex codex-cli 0.163.0\n");
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

  it("a reviewer that answers and exits leaving a child in its group: the record names the group and each signal sent after its exit (ISS-1470)", async () => {
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    extraEnv = { FAKE_CODEX_MODE: "leave-child" };
    const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(run.exitCode).toBe(0);
    const [rec] = recordsOf(id);
    expect(rec).toMatchObject({ state: "completed", signalledAfterLeaderExit: { pgid: expect.any(Number), signals: ["SIGTERM", "SIGKILL"] } });
    expect(recordShape(rec, rec!.recordId as string)).not.toBeNull();
    const st = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(st.exitCode).toBe(0);
  });

  it("a record's post-exit signals are read only when well formed (ISS-1470)", () => {
    const base = { state: "failed", recordId: "SR-00000001", setupId: "SS-00000001", cycle: 1, revisionSha256: "a".repeat(64), backend: "codex", backendVersion: "v", startedAt: "t", endedAt: "t", failure: "exit", exitCode: 1, outputSha256: null, error: "e" };
    expect(recordShape({ ...base, signalledAfterLeaderExit: { pgid: 4242, signals: ["SIGTERM", "SIGKILL"] } }, "SR-00000001")).not.toBeNull();
    for (const bad of [null, [], { pgid: 0, signals: ["SIGTERM"] }, { pgid: 4242, signals: [] }, { pgid: 4242, signals: ["SIGHUP"] }, { pgid: "4242", signals: ["SIGTERM"] }]) {
      expect(recordShape({ ...base, signalledAfterLeaderExit: bad }, "SR-00000001")).toBeNull();
    }
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

  it("skip on a store that fails any other way is a storage failure, with an existing setup: nothing is written", async () => {
    const id = setupIdOf(await handleSetupReviewGate(io(), {}));
    const before = setupJson(id);
    storeSeams.writeProbe = () => { throw errno("EIO"); };
    const skip = await handleSetupReviewStatus(io(), { setup: id, skipped: true });
    expect(skip.exitCode).toBe(6);
    expect(skip.stdout).not.toContain(SKIPPED_LINE);
    expect(setupJson(id)).toEqual(before);
  });

  it("skip on a store that fails any other way is a storage failure, with no setup state at all", async () => {
    storeSeams.writeProbe = () => { throw errno("EIO"); };
    const skip = await handleSetupReviewStatus(io(), { setup: "SS-0000abcd", skipped: true });
    expect(skip.exitCode).toBe(6);
    expect(skip.stdout).not.toContain(SKIPPED_LINE);
  });
});
