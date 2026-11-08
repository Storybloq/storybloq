/**
 * ISS-1457: the setup reviewer runs under a supervisor that stops the
 * reviewer's whole group when the CLI dies at any point, and never signals
 * that group after the run completed. Needs the built supervisor
 * (dist/setup-review-supervisor.js); a real stand-in CLI process is SIGKILLed
 * at each phase.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_CAP_BYTES, runSupervised, supervisorEntry, supervisorSeams } from "../../src/core/setup-review-supervisor.js";
import { makeScratchDir, removeScratchDirs } from "../helpers/setup-review-fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const ENTRY = supervisorEntry();
const HARNESS = join(import.meta.dirname, "fixtures", "setup-review-supervisor-cli.mjs");
const realSeams = { ...supervisorSeams };
const spawned: ChildProcess[] = [];
const pids: number[] = [];

afterEach(() => {
  Object.assign(supervisorSeams, realSeams);
  for (const c of spawned.splice(0)) {
    try { c.kill("SIGKILL"); } catch { /* gone */ }
  }
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  removeScratchDirs();
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}
const readPid = (file: string): number | null => (existsSync(file) && readFileSync(file, "utf-8").trim() ? Number(readFileSync(file, "utf-8").trim()) : null);

/** The stand-in CLI, its relayed lines, and the supervisor's pid. */
function cli(phase: "ready" | "start" | "started" | "completed" | "saturated" | "stdin", script: string, signalLog: string) {
  const child = spawn(process.execPath, [HARNESS, ENTRY, phase, "/bin/sh", JSON.stringify(["-c", script]), signalLog], { stdio: ["ignore", "pipe", "inherit"] });
  spawned.push(child);
  const lines: Array<Record<string, unknown>> = [];
  let buf = "";
  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (c: string) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  const supPid = (): number | null => (lines.find((l) => l.type === "supervisor")?.pid as number | undefined) ?? null;
  const seen = (type: string): boolean => lines.some((l) => l.type === type);
  return { child, lines, supPid, seen };
}

describe("the supervisor stops the reviewer when the CLI dies", () => {
  it("is built", () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  it("fd 3 ends with nothing ever written to it, the CLI killed before start: the supervisor exits and nothing is spawned", async () => {
    const dir = makeScratchDir("sr-sup-");
    const log = join(dir, "signals.log");
    const c = cli("ready", `echo $$ > ${dir}/leader; sleep 300`, log);
    expect(await until(() => c.seen("ready"), 5_000)).toBe(true);
    const sup = c.supPid()!;
    pids.push(sup);
    c.child.kill("SIGKILL");
    expect(await until(() => !alive(sup), 3_000)).toBe(true);
    expect(c.lines.filter((l) => l.type === "stdout" || l.type === "stderr")).toEqual([]);
    expect(existsSync(join(dir, "leader"))).toBe(false);
    expect(readFileSync(log, "utf-8")).toBe("exit-before-spawn\n");
  });

  it("killed as start is written, before the started ack is read: whatever started is gone and the supervisor exits", async () => {
    const dir = makeScratchDir("sr-sup-");
    const c = cli("start", `sleep 300 & echo $! > ${dir}/sleeper; wait`, join(dir, "signals.log"));
    expect(await until(() => c.supPid() !== null, 5_000)).toBe(true);
    const sup = c.supPid()!;
    pids.push(sup);
    expect(await until(() => c.child.exitCode !== null || c.child.signalCode !== null, 5_000)).toBe(true);
    expect(await until(() => !alive(sup), 4_000)).toBe(true);
    const sleeper = readPid(join(dir, "sleeper"));
    if (sleeper !== null) {
      pids.push(sleeper);
      expect(await until(() => !alive(sleeper), 1_000)).toBe(true);
    }
  });

  it("killed during the review: the group gets SIGKILL, is seen gone, and the supervisor exits", async () => {
    const dir = makeScratchDir("sr-sup-");
    const log = join(dir, "signals.log");
    const c = cli("started", `sleep 300 & echo $! > ${dir}/sleeper; wait`, log);
    expect(await until(() => c.seen("started") && readPid(join(dir, "sleeper")) !== null, 5_000)).toBe(true);
    const sleeper = readPid(join(dir, "sleeper"))!;
    const sup = c.supPid()!;
    pids.push(sleeper, sup);
    const pgid = c.lines.find((l) => l.type === "started")!.pgid as number;
    c.child.kill("SIGKILL");
    expect(await until(() => !alive(sleeper), 3_000)).toBe(true);
    expect(await until(() => !alive(sup), 3_000)).toBe(true);
    expect(readFileSync(log, "utf-8")).toBe(`SIGKILL -${pgid}\ngroup-gone\n`);
  });

  /** Kills the stand-in CLI once the reviewer's leader wrote its pid, and checks the whole group and the supervisor are gone. */
  async function killMidReview(phase: "saturated" | "stdin", script: (dir: string) => string): Promise<void> {
    const dir = makeScratchDir("sr-sup-");
    const log = join(dir, "signals.log");
    const c = cli(phase, script(dir), log);
    expect(await until(() => c.seen("started") && readPid(join(dir, "leader")) !== null, 15_000)).toBe(true);
    const leader = readPid(join(dir, "leader"))!;
    const sup = c.supPid()!;
    pids.push(leader, sup);
    await new Promise((r) => setTimeout(r, 300));
    c.child.kill("SIGKILL");
    expect(await until(() => !alive(leader), 4_000)).toBe(true);
    expect(await until(() => !alive(sup), 4_000)).toBe(true);
    expect(readFileSync(log, "utf-8")).toBe(`SIGKILL -${leader}\ngroup-gone\n`);
  }

  it("killed while the relay is backed up (10 MiB on each stream, the CLI no longer reading): the group is gone and the supervisor exits", async () => {
    await killMidReview("saturated", (dir) => `head -c 10485760 /dev/zero; head -c 10485760 /dev/zero >&2; echo $$ > ${dir}/leader; sleep 300`);
  });

  it("killed while a 5 MiB prompt is still being delivered to a reviewer that never reads it: the group is gone and the supervisor exits", async () => {
    await killMidReview("stdin", (dir) => `echo $$ > ${dir}/leader; sleep 300`);
  });

  it("killed after completion: nothing is signalled after completed, and nothing is left", async () => {
    const dir = makeScratchDir("sr-sup-");
    const log = join(dir, "signals.log");
    const c = cli("completed", `sleep 300 & echo $! > ${dir}/sleeper; exit 0`, log);
    expect(await until(() => c.seen("completed"), 10_000)).toBe(true);
    const sleeper = readPid(join(dir, "sleeper"))!;
    pids.push(sleeper);
    expect(alive(sleeper)).toBe(false);
    expect(c.lines.find((l) => l.type === "completed")).toMatchObject({ run: { exitCode: 0, cleanup: "confirmed" } });
    c.child.kill("SIGKILL");
    const sup = c.supPid()!;
    expect(await until(() => !alive(sup), 3_000)).toBe(true);
    expect(readFileSync(log, "utf-8")).toBe("completed\n");
  });
});

describe("runSupervised", () => {
  const node = (code: string): [string, string[]] => [process.execPath, ["-e", code]];

  it("keeps stdout and stderr apart, so a valid answer with diagnostics on stderr parses", async () => {
    const answer = JSON.stringify({ type: "result", structured_output: { verdict: "approve", findings: [] } });
    const [cmd, args] = node(`process.stderr.write("warning: something\\n"); process.stdout.write(${JSON.stringify(answer)});`);
    const r = await runSupervised(cmd, args, { cwd: makeScratchDir("sr-sup-"), env: { PATH: process.env.PATH ?? "" }, input: "", timeoutMs: 10_000, killGraceMs: 200 });
    expect(r).toMatchObject({ exitCode: 0, supervisorError: null, spawnError: null, cleanup: "confirmed", stderr: "warning: something\n", truncated: { stdout: false, stderr: false } });
    expect(r.stdout.toString("utf-8")).toBe(answer);
  });

  it("output written just before exit is not lost, and the prompt reaches stdin", async () => {
    const [cmd, args] = node(`let s = ""; process.stdin.on("data", (c) => s += c); process.stdin.on("end", () => { process.stdout.write(s + "x".repeat(200000), () => process.exit(0)); });`);
    const r = await runSupervised(cmd, args, { cwd: makeScratchDir("sr-sup-"), env: { PATH: process.env.PATH ?? "" }, input: "the packet\n", timeoutMs: 10_000, killGraceMs: 200 });
    expect(r.stdout.toString("utf-8")).toBe(`the packet\n${"x".repeat(200000)}`);
  });

  it("relays at most 1 MiB of a stream and says it dropped the rest", async () => {
    const [cmd, args] = node(`process.stdout.write("y".repeat(2 * 1024 * 1024));`);
    const r = await runSupervised(cmd, args, { cwd: makeScratchDir("sr-sup-"), env: { PATH: process.env.PATH ?? "" }, input: "", timeoutMs: 10_000, killGraceMs: 200 });
    expect(r.stdout.length).toBe(RELAY_CAP_BYTES);
    expect(r.truncated.stdout).toBe(true);
  });

  it("the reviewer holds no fd 3, so it never keeps the CLI's liveness pipe (the shell's own fd 3 is the control)", async () => {
    const script = "if [ -e /dev/fd/3 ]; then a=has3; else a=no3; fi; exec 3</dev/null; if [ -e /dev/fd/3 ]; then b=has3; else b=no3; fi; echo $a $b";
    const r = await runSupervised("/bin/sh", ["-c", script], { cwd: makeScratchDir("sr-sup-"), env: { PATH: process.env.PATH ?? "" }, input: "", timeoutMs: 10_000, killGraceMs: 200 });
    expect(r.stdout.toString("utf-8").trim()).toBe("no3 has3");
  });

  it("a supervisor that never says ready fails closed and is stopped", async () => {
    const dir = makeScratchDir("sr-sup-");
    const fakeEntry = join(dir, "silent.mjs");
    writeFileSync(fakeEntry, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    supervisorSeams.entry = () => fakeEntry;
    supervisorSeams.readyMs = 500;
    const r = await runSupervised("/bin/sh", ["-c", `echo started > ${dir}/reviewer`], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, input: "", timeoutMs: 10_000, killGraceMs: 200 });
    expect(r.supervisorError).toMatch(/no ready within 500 ms/);
    expect(existsSync(join(dir, "reviewer"))).toBe(false);
    const pid = readPid(join(dir, "pid"));
    if (pid !== null) {
      pids.push(pid);
      expect(await until(() => !alive(pid), 2_000)).toBe(true);
    }
  });

  it("a missing supervisor fails closed without starting the reviewer", async () => {
    const dir = makeScratchDir("sr-sup-");
    supervisorSeams.entry = () => join(dir, "nowhere.js");
    const r = await runSupervised("/bin/sh", ["-c", `echo started > ${dir}/reviewer`], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, input: "", timeoutMs: 10_000, killGraceMs: 200 });
    expect(r.supervisorError).toMatch(/missing/);
    expect(existsSync(join(dir, "reviewer"))).toBe(false);
  });
});
