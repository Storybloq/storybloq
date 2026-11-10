/**
 * T-538 S3a-2 commit 5: setup-verify's run in its own process group, from
 * spawn until the group is confirmed gone (ISS-1391's machinery, extracted
 * to process-group.ts and shared with setup-review).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processGroupSeams, runInGroup, type GroupControl, type GroupRunOptions } from "../../src/core/process-group.js";

const real = { ...processGroupSeams };
afterEach(() => { Object.assign(processGroupSeams, real); });
const realProbe = real.probe;

/** A fresh directory per test for readiness markers, removed after it. */
function markers(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "t538-pg-trap-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function run(script: string, over: Partial<GroupRunOptions> = {}) {
  let out = "";
  const started = Date.now();
  const r = await runInGroup({ command: "/bin/sh", args: ["-c", script], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, killGraceMs: 300, onData: (c) => { out += c.toString("utf-8"); }, ...over });
  return { ...r, out, ms: Date.now() - started };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runInGroup", () => {
  it("runs to exit, keeps the whole stream and confirms the group gone", async () => {
    const r = await run("echo first; echo second >&2; exit 3");
    expect(r).toMatchObject({ exitCode: 3, timedOut: false, spawnError: null, cleanup: "confirmed" });
    expect(r.out).toContain("first");
    expect(r.out).toContain("second");
  });

  it("stops a leader that ignores SIGTERM at the deadline with SIGKILL", async () => {
    // The trap is armed before the marker exists, and the deadline is far enough out that the marker always precedes it.
    const m = markers();
    try {
      const ready = join(m.dir, "trapped");
      const r = await run(`trap '' TERM; : > '${ready}'; sleep 30`, { timeoutMs: 1_500, killGraceMs: 300 });
      expect(existsSync(ready)).toBe(true);
      expect(r).toMatchObject({ timedOut: true, cleanup: "confirmed", signal: "SIGKILL" });
      expect(r.ms).toBeLessThan(6_000);
    } finally {
      m.done();
    }
  });

  it("stops a descendant still holding the pipes after the shell exits", async () => {
    const r = await run("sleep 30 & echo done", { killGraceMs: 300 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, cleanup: "confirmed" });
    expect(r.out).toContain("done");
    expect(r.ms).toBeLessThan(5_000);
  });

  it("keeps the deadline after the shell exits: a SIGTERM-proof leftover is killed at it, not after the grace", async () => {
    // The shell exits only once the background subshell has armed its trap and written the marker.
    const m = markers();
    try {
      const ready = join(m.dir, "trapped");
      const r = await run(`(trap '' TERM; : > '${ready}'; sleep 30) & while [ ! -e '${ready}' ]; do sleep 0.01; done; echo done`, { timeoutMs: 1_500, killGraceMs: 20_000 });
      expect(existsSync(ready)).toBe(true);
      expect(r).toMatchObject({ exitCode: 0, timedOut: true, cleanup: "confirmed" });
      expect(r.ms).toBeLessThan(10_000);
    } finally {
      m.done();
    }
  });

  it("a probe that answers EPERM through the bound leaves the cleanup unconfirmed", async () => {
    processGroupSeams.probe = () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
    const r = await run("echo hi");
    expect(r.cleanup).toBe("unconfirmed");
    expect(r.cleanupDetail).toMatch(/answered EPERM 2000 ms after the last signal/);
  });

  it("a transient EPERM (Darwin's answer for a group of zombies) is polled through to confirmed", async () => {
    let calls = 0;
    processGroupSeams.probe = (pgid) => {
      if (++calls <= 2) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      realProbe(pgid);
    };
    const r = await run("echo hi");
    expect(r.cleanup).toBe("confirmed");
    expect(calls).toBeGreaterThan(2);
  });

  it("a group that never goes leaves the cleanup unconfirmed at the bound", async () => {
    processGroupSeams.probe = () => {};
    const r = await run("echo hi");
    expect(r.cleanup).toBe("unconfirmed");
    expect(r.cleanupDetail).toMatch(/still present 2000 ms after the last signal/);
  });

  it("a spawn failure settles at once and leaves no signal handler behind", async () => {
    const before = process.listenerCount("SIGTERM");
    const r = await run("echo hi", { cwd: join(tmpdir(), "t538-no-such-dir-xyz") });
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(r.exitCode).toBeNull();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("a signal to the CLI kills the live group before the CLI ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t538-pg-signal-"));
    const pidFile = join(dir, "leader.pid");
    const worker = join(import.meta.dirname, "fixtures", "t538-group-signal-worker.ts");
    const child = spawn(process.execPath, ["--import", "tsx", worker, pidFile], { stdio: "ignore" });
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(pidFile) || readFileSync(pidFile, "utf-8").trim() === "") {
        if (Date.now() > deadline) throw new Error("the leader never started");
        await new Promise((r) => setTimeout(r, 20));
      }
      const leader = Number(readFileSync(pidFile, "utf-8").trim());
      const ended = new Promise<NodeJS.Signals | null>((r) => child.once("exit", (_c, s) => r(s)));
      child.kill("SIGTERM");
      expect(await ended).toBe("SIGTERM");
      const gone = Date.now() + 3_000;
      while (alive(leader) && Date.now() < gone) await new Promise((r) => setTimeout(r, 20));
      expect(alive(leader)).toBe(false);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The no-group path (Windows) through the platform seam: CI here is darwin
 * only, so a fake child stands in for the process, and the group probe is
 * made to fail the test if it is ever called.
 */
describe("runInGroup without process groups", () => {
  type Fake = { child: ChildProcess; signals: NodeJS.Signals[]; die: (sig: NodeJS.Signals | null, code?: number) => void };
  function fake(onSignal: (f: Fake, sig: NodeJS.Signals) => void): Fake {
    const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const f = { signals: [] as NodeJS.Signals[] } as Fake;
    Object.assign(ee, {
      pid: 999_999_001, stdin: null, stdout: new PassThrough(), stderr: new PassThrough(), unref: () => {},
      kill: (sig: NodeJS.Signals) => { f.signals.push(sig); onSignal(f, sig); return true; },
    });
    f.child = ee as unknown as ChildProcess;
    f.die = (sig, code) => {
      setImmediate(() => { ee.emit("exit", code ?? null, sig); setImmediate(() => ee.emit("close", code ?? null, sig)); });
    };
    return f;
  }
  function seam(f: Fake, detached: boolean[]): void {
    processGroupSeams.ownGroup = false;
    processGroupSeams.probe = () => { throw new Error("a negative-pid probe on the no-group path"); };
    processGroupSeams.spawn = ((_c: string, _a: readonly string[], o: { detached?: boolean }) => { detached.push(o.detached === true); return f.child; }) as unknown as typeof spawn;
  }

  it("signals the child itself at the deadline, SIGTERM then SIGKILL, and confirms once it exits", async () => {
    const f = fake((self, sig) => { if (sig === "SIGKILL") self.die("SIGKILL"); });
    const detached: boolean[] = [];
    seam(f, detached);
    const r = await run("ignored", { timeoutMs: 100, killGraceMs: 150 });
    expect(detached).toEqual([false]);
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(r).toMatchObject({ timedOut: true, signal: "SIGKILL", cleanup: "confirmed", cleanupDetail: null });
  });

  it("settles on SIGTERM alone when the child honours it", async () => {
    const f = fake((self, sig) => { if (sig === "SIGTERM") self.die("SIGTERM"); });
    seam(f, []);
    const r = await run("ignored", { timeoutMs: 100, killGraceMs: 5_000 });
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(r).toMatchObject({ timedOut: true, signal: "SIGTERM", cleanup: "confirmed" });
    expect(r.ms).toBeLessThan(3_000);
  });

  it("a child that never exits leaves the cleanup unconfirmed at the bound, never released while unsignalled", async () => {
    const f = fake(() => {});
    seam(f, []);
    const r = await run("ignored", { timeoutMs: 100, killGraceMs: 150 });
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(r).toMatchObject({ timedOut: true, cleanup: "unconfirmed" });
    expect(r.cleanupDetail).toBe("process 999999001 still running 2000 ms after the last signal");
  });

  it("a child that exits before the deadline is never signalled", async () => {
    const f = fake(() => {});
    seam(f, []);
    f.die(null, 0);
    const r = await run("ignored", { timeoutMs: 5_000 });
    expect(f.signals).toEqual([]);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, cleanup: "confirmed" });
  });
});

// T-538 commit 1 (plan 5.1): a stop the caller can ask for, and the leader's stdin as a pipe it feeds.
describe("runInGroup control (T-538 5.1)", () => {
  /** Runs `script` with a control handle; `use` gets the handle once, right after spawn. */
  async function controlled(script: string, use: (c: GroupControl) => void, over: Partial<GroupRunOptions> = {}) {
    let handle: GroupControl | null = null;
    let calls = 0;
    const r = await run(script, { control: (c) => { calls += 1; handle = c; use(c); }, ...over });
    return { ...r, handle: handle as GroupControl | null, calls };
  }

  it("stop from a data callback ends the group with SIGTERM, not at the deadline", async () => {
    let c: GroupControl | null = null;
    const r = await run("echo ready; sleep 30", {
      timeoutMs: 20_000, killGraceMs: 300,
      control: (h) => { c = h; },
      onData: (chunk) => { if (chunk.toString("utf-8").includes("ready")) c!.stop(); },
    });
    expect(r).toMatchObject({ timedOut: false, spawnError: null, cleanup: "confirmed", signal: "SIGTERM" });
    expect(r.ms).toBeLessThan(5_000);
  });

  it("the callback is called once, and stop twice sends one SIGTERM to a leader that ignores it, then SIGKILL after the grace", async () => {
    const m = markers();
    try {
      const terms = join(m.dir, "terms");
      const ready = join(m.dir, "ready");
      let c: GroupControl | null = null;
      let calls = 0;
      const r = await run(`trap 'echo t >> "${terms}"' TERM; : > '${ready}'; echo ready; while :; do sleep 0.05; done`, {
        timeoutMs: 20_000, killGraceMs: 600,
        control: (h) => { calls += 1; c = h; },
        onData: (chunk) => { if (chunk.toString("utf-8").includes("ready")) { c!.stop(); c!.stop(); } },
      });
      expect(calls).toBe(1);
      expect(r).toMatchObject({ timedOut: false, cleanup: "confirmed", signal: "SIGKILL" });
      expect(readFileSync(terms, "utf-8").trim().split("\n")).toEqual(["t"]);
      expect(r.ms).toBeLessThan(8_000);
    } finally {
      m.done();
    }
  });

  it("stop after the leader's exit does nothing more and never throws", async () => {
    let c: GroupControl | null = null;
    const r = await run("echo hi; exit 4", { control: (h) => { c = h; }, onLeaderExit: () => { c!.stop(); c!.stop(); } });
    expect(r).toMatchObject({ exitCode: 4, timedOut: false, spawnError: null, cleanup: "confirmed" });
    expect(r.inputError).toBeUndefined();
    expect(() => c!.stop()).not.toThrow();
  });

  it("feeds the leader's stdin: written lines arrive, endInput closes it, and nothing is reported", async () => {
    const r = await controlled("cat; echo end", (c) => {
      expect(c.write(Buffer.from("one\n"))).toBe(true);
      expect(c.write(Buffer.from("two\n"))).toBe(true);
      c.endInput();
    });
    expect(r.calls).toBe(1);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, cleanup: "confirmed" });
    expect(r.out).toBe("one\ntwo\nend\n");
    expect(r.inputError).toBeUndefined();
  });

  it("a write after endInput is swallowed, never delivered, and reported once", async () => {
    const r = await controlled("cat; echo end", (c) => {
      c.write(Buffer.from("kept\n"));
      c.endInput();
      expect(() => c.write(Buffer.from("late\n"))).not.toThrow();
      expect(c.write(Buffer.from("later\n"))).toBe(false);
    });
    expect(r.out).toBe("kept\nend\n");
    expect(r.inputError).toBe("write after endInput");
  });

  it("a write after exit is swallowed and reported once", async () => {
    let c: GroupControl | null = null;
    let threw = false;
    const r = await run("exit 0", {
      control: (h) => { c = h; },
      onLeaderExit: () => { try { c!.write(Buffer.from("x")); c!.write(Buffer.from("y")); } catch { threw = true; } },
    });
    expect(threw).toBe(false);
    expect(r).toMatchObject({ exitCode: 0, cleanup: "confirmed" });
    expect(r.inputError).toBe("write after exit");
  });

  it("a leader that never reads: past 1 MiB queued write answers false, past 8 MiB the group is stopped as stdin overflow", async () => {
    const answers: boolean[] = [];
    const r = await controlled("echo ready; sleep 30", (c) => {
      answers.push(c.write(Buffer.alloc(1536 * 1024, 97)));
      answers.push(c.write(Buffer.alloc(8 * 1024 * 1024, 98)));
    }, { timeoutMs: 20_000, killGraceMs: 300 });
    expect(answers).toEqual([false, false]);
    expect(r.inputError).toBe("stdin overflow");
    expect(r).toMatchObject({ timedOut: false, cleanup: "confirmed", signal: "SIGTERM" });
    expect(r.ms).toBeLessThan(8_000);
  });

  it("a leader that closed its stdin: the broken pipe is swallowed and reported", async () => {
    let c: GroupControl | null = null;
    const r = await run("exec 0<&-; echo closed; sleep 1", {
      control: (h) => { c = h; },
      onData: (chunk) => { if (chunk.toString("utf-8").includes("closed")) { c!.write(Buffer.alloc(256 * 1024, 99)); } },
    });
    expect(r).toMatchObject({ exitCode: 0, cleanup: "confirmed" });
    expect(r.inputError).toBe("EPIPE");
  });

  it("a control callback that throws stops the group and settles as a spawn error", async () => {
    const r = await controlled("sleep 30", () => { throw new Error("boom"); }, { timeoutMs: 20_000, killGraceMs: 300 });
    expect(r.spawnError).toBe("control: boom");
    expect(r).toMatchObject({ timedOut: false, cleanup: "confirmed" });
    expect(r.ms).toBeLessThan(5_000);
  });

  it.each([["null", null, "control: null"], ["undefined", undefined, "control: undefined"], ["a string", "plain", "control: plain"]] as const)("a control callback that throws %s still stops the group and settles as a spawn error (F6)", async (_n, thrown, text) => {
    const r = await controlled("sleep 30", () => { throw thrown; }, { timeoutMs: 20_000, killGraceMs: 300 });
    expect(r.spawnError).toBe(text);
    expect(r).toMatchObject({ timedOut: false, cleanup: "confirmed" });
    expect(r.ms).toBeLessThan(5_000);
  });

  it("stdin and control together are a spawn error, and nothing is started", async () => {
    let spawned = 0;
    processGroupSeams.spawn = ((...a: Parameters<typeof spawn>) => { spawned += 1; return spawn(...a); }) as typeof spawn;
    const r = await run("sleep 30", { stdin: Buffer.from("x"), control: () => {} });
    expect(spawned).toBe(0);
    expect(r.spawnError).toMatch(/stdin and control are mutually exclusive/);
    expect(r.cleanup).toBe("confirmed");
  });
});
