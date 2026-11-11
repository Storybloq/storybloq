/**
 * ISS-1469: one group handle per owned child. Every signal and probe of a child's process group goes
 * through it, and it latches: once the group has been seen absent (any probe answering ESRCH, the signal
 * itself answering ESRCH), or a SIGKILL has gone out, or the run has settled, nothing more is sent to that
 * number by anyone holding the child. A positive-pid ESRCH (the leader reaped) alone does not latch.
 *
 * The accepted residual is pinned too, in rows labelled as such: a switch from the original group to a
 * foreign one with no absence seen in between is signalled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn as realSpawnFn, type ChildProcess, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalate, groupHandle, processGroupSeams, runInGroup, runOwnedGroup, signalGroup, type GroupProbe, type GroupRunOptions, type GroupSignal } from "../../src/core/process-group.js";
import { probeBackend, probeCodexStart, runReviewer } from "../../src/core/setup-review-backends.js";

const real = { ...processGroupSeams };
const realKill = process.kill.bind(process);
const cleanups: Array<() => void> = [];

afterEach(() => {
  Object.assign(processGroupSeams, real);
  vi.restoreAllMocks();
  while (cleanups.length > 0) cleanups.pop()!();
});

const esrch = (): never => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };
const eperm = (): never => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PID = 999_999_469;

/** Every negative-pid, non-zero kill: delivered ones are recorded; one to the fake group is not delivered, and `throwFor` decides a failing one. */
function watchKill(opts: { throwFor?: (sig: string | number) => string | null } = {}): { sent: Array<[number, string | number]>; outsideSend: number[] } {
  const sent: Array<[number, string | number]> = [];
  const outsideSend: number[] = [];
  let inSend = false;
  const send = processGroupSeams.send;
  processGroupSeams.send = (pgid, sig) => {
    inSend = true;
    try { send(pgid, sig); } finally { inSend = false; }
  };
  vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
    if (pid < 0 && sig !== 0) {
      if (!inSend) outsideSend.push(pid);
      const code = Math.abs(pid) === PID ? opts.throwFor?.(sig ?? "SIGTERM") ?? null : null;
      if (code) throw Object.assign(new Error(code), { code });
      sent.push([pid, sig ?? "SIGTERM"]);
      if (Math.abs(pid) === PID) return true;
    }
    if (Math.abs(pid) === PID) return true;
    return realKill(pid, sig as NodeJS.Signals);
  }) as typeof process.kill);
  return { sent, outsideSend };
}

type Fake = ChildProcess & EventEmitter;
function fakeChild(): Fake {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(ee, { pid: PID, stdin: null, stdout: new PassThrough(), stderr: new PassThrough(), unref: () => {}, kill: () => true, exitCode: null, signalCode: null });
  return ee as unknown as Fake;
}
function fakeRun(): Fake {
  const child = fakeChild();
  processGroupSeams.ownGroup = true;
  processGroupSeams.spawn = (() => child) as unknown as typeof spawn;
  return child;
}
function run(over: Partial<GroupRunOptions> = {}) {
  return runInGroup({ command: "ignored", args: [], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, killGraceMs: 150, ...over });
}
function newExitListener(start: () => void): () => void {
  const before = new Set(process.listeners("exit"));
  start();
  const added = process.listeners("exit").filter((l) => !before.has(l));
  expect(added).toHaveLength(1);
  return added[0] as () => void;
}
const alive = (pid: number): boolean => { try { realKill(pid, 0); return true; } catch { return false; } };

/** A real process in its own group, standing in for a group that is not ours. */
function plantGroup(): ChildProcess {
  const c = realSpawnFn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  cleanups.push(() => { try { realKill(-c.pid!, "SIGKILL"); } catch { /* gone */ } });
  return c;
}
async function gone(pid: number, ms = 1_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await pause(10);
  return !alive(pid);
}

describe("every absence latches (ISS-1469 V2)", () => {
  it("L1: a lifecycle probe sees ESRCH, a foreign group then takes the number, and a queued stop before the next watch tick sends nothing", async () => {
    let state: "alive" | "gone" = "alive";
    processGroupSeams.probe = () => { if (state === "gone") esrch(); };
    processGroupSeams.leader = () => {};
    const k = watchKill();
    const child = fakeRun();
    let pending!: ReturnType<typeof run>;
    const stopOnExit = newExitListener(() => { pending = run(); });
    setImmediate(() => child.emit("exit", 0, null));
    await pause(20);
    expect(k.sent).toEqual([[-PID, "SIGTERM"]]);
    // The leftovers die on that SIGTERM; the stop's own wait loop then probes the group gone.
    state = "gone";
    await pause(80);
    // A foreign group now answers for the number, and a stop queued before any further tick runs.
    state = "alive";
    stopOnExit();
    expect(k.sent).toEqual([[-PID, "SIGTERM"]]);
    expect(groupHandle(child).signal("SIGKILL")).toBe("released");
    expect(k.sent).toEqual([[-PID, "SIGTERM"]]);
    child.emit("close", 0, null);
    const r = await pending;
    expect(r).toMatchObject({ cleanup: "confirmed", signalledAfterLeaderExit: { pgid: PID, signals: ["SIGTERM"] } });
  });

  it("L1 on an owned group: leftAtLeaderExit sees the group gone, a foreign group then takes the number, and the stop sends nothing", async () => {
    let state: "alive" | "gone" = "gone";
    processGroupSeams.probe = () => { if (state === "gone") esrch(); };
    processGroupSeams.leader = () => {};
    const k = watchKill();
    const child = fakeChild();
    processGroupSeams.spawn = (() => { setImmediate(() => child.emit("spawn")); return child; }) as unknown as typeof spawn;
    setTimeout(() => child.emit("exit", 0, null), 5);
    const r = await runOwnedGroup({ command: "ignored", args: [], cwd: tmpdir(), env: {}, shutdownTimeoutMs: 100, onData: () => {} }, async (g) => {
      await g.exit;
      expect(g.leftAtLeaderExit()).toBe(false);
      // Synchronously after the exit's own probe: no watch tick has run.
      state = "alive";
      return "body done";
    });
    expect(k.sent).toEqual([]);
    expect(r).toMatchObject({ kind: "ran", value: { ok: true, value: "body done" } });
  });

  it("L2: the signal itself answers ESRCH, a foreign group then takes the number, and a queued stop sends nothing", async () => {
    let failSend = true;
    processGroupSeams.probe = () => {};
    processGroupSeams.leader = () => {};
    const k = watchKill({ throwFor: () => (failSend ? "ESRCH" : null) });
    const child = fakeRun();
    let pending!: ReturnType<typeof run>;
    const stopOnExit = newExitListener(() => { pending = run(); });
    setImmediate(() => child.emit("exit", 0, null));
    await pause(20);
    expect(k.sent).toEqual([]);
    failSend = false;
    stopOnExit();
    expect(groupHandle(child).signal("SIGTERM")).toBe("released");
    expect(k.sent).toEqual([]);
    child.emit("close", 0, null);
    const r = await pending;
    expect(r.signalledAfterLeaderExit).toBeUndefined();
  }, 10_000);

  it("L3: a positive-pid ESRCH alone, with the group still alive, does not latch: each signal is sent", () => {
    processGroupSeams.probe = () => {};
    processGroupSeams.leader = esrch;
    const k = watchKill();
    const h = groupHandle(fakeChild(), true);
    expect(h.signal("SIGTERM")).toBe("sent");
    expect(h.disarmed).toBe(false);
    expect(h.signal("SIGTERM")).toBe("sent");
    expect(k.sent).toEqual([[-PID, "SIGTERM"], [-PID, "SIGTERM"]]);
  });

  it("L4: the run disarms before it releases its callbacks; after it settles nothing is sent, and no watch is left", async () => {
    let state: "alive" | "eperm" = "eperm";
    let probes = 0;
    processGroupSeams.probe = () => { probes++; if (state === "eperm") eperm(); };
    processGroupSeams.leader = () => {};
    const k = watchKill();
    const child = fakeRun();
    const duringRelease: string[] = [];
    processGroupSeams.onRelease = (c) => {
      if (c !== child) return;
      // A group that answers alive now, signalled synchronously while the callbacks are released.
      state = "alive";
      duringRelease.push(groupHandle(c).signal("SIGKILL"));
    };
    setImmediate(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
    const r = await run();
    expect(r).toMatchObject({ cleanup: "unconfirmed" });
    expect(duringRelease).toEqual(["released"]);
    expect(k.sent).toEqual([]);
    // After settle, separately: still released, and no watch keeps probing.
    expect(groupHandle(child).signal("SIGTERM")).toBe("released");
    const seen = probes;
    await pause(150);
    expect(probes).toBe(seen);
    expect(k.sent).toEqual([]);
  }, 10_000);

  it("W1: the gone-watch latches between escalate's SIGTERM and its SIGKILL, so a foreign group in the gap gets nothing", async () => {
    let state: "alive" | "gone" = "alive";
    processGroupSeams.probe = () => { if (state === "gone") esrch(); };
    processGroupSeams.leader = () => {};
    const k = watchKill();
    const child = fakeChild();
    let gaveUp = false;
    const cancel = escalate(child, 30, 250, () => {}, () => { gaveUp = true; });
    cleanups.push(cancel);
    child.emit("exit", 0, null);
    await pause(60);
    expect(k.sent).toEqual([[-PID, "SIGTERM"]]);
    state = "gone";
    await pause(120);
    state = "alive";
    await pause(250);
    expect(k.sent).toEqual([[-PID, "SIGTERM"]]);
    await pause(300);
    expect(gaveUp).toBe(true);
  });
});

describe("a SIGKILL that went out is final for every holder (ISS-1469 R4)", () => {
  it("K1: escalate's SIGKILL, then a second stop, its exit listener and the signal handler's default stop: exactly one SIGKILL", async () => {
    processGroupSeams.probe = () => {};
    processGroupSeams.leader = () => {};
    const k = watchKill();
    const child = fakeChild();
    let stopOnExit!: () => void;
    let cancel!: () => void;
    stopOnExit = newExitListener(() => { cancel = escalate(child, 20, 30, () => {}, () => {}); });
    cleanups.push(() => cancel());
    await pause(120);
    expect(k.sent).toEqual([[-PID, "SIGTERM"], [-PID, "SIGKILL"]]);
    signalGroup(child, "SIGKILL");
    stopOnExit();
    signalGroup(child, "SIGTERM");
    expect(k.sent).toEqual([[-PID, "SIGTERM"], [-PID, "SIGKILL"]]);
  });

  it("K2 and K3: after the deadline's SIGKILL, the signal handed to the caller (cliGone's) and the parent-exit cleanup during confirm send nothing", async () => {
    let state: "alive" | "gone" = "alive";
    processGroupSeams.probe = () => { if (state === "gone") esrch(); };
    processGroupSeams.leader = () => {};
    const k = watchKill();
    fakeRun();
    let handed!: GroupSignal;
    let probe!: GroupProbe;
    let pending!: ReturnType<typeof run>;
    const stopOnExit = newExitListener(() => { pending = run({ timeoutMs: 20, killGraceMs: 40, onSpawn: (_id, s, p) => { handed = s; probe = p; } }); });
    await pause(150);
    expect(k.sent).toEqual([[-PID, "SIGTERM"], [-PID, "SIGKILL"]]);
    expect(handed("SIGKILL")).toBe("released");
    stopOnExit();
    expect(k.sent).toEqual([[-PID, "SIGTERM"], [-PID, "SIGKILL"]]);
    expect(probe()).toBe("alive");
    state = "gone";
    expect(probe()).toBe("gone");
    const r = await pending;
    expect(r.timedOut).toBe(true);
  });

  it("K4: a stop through the signal handler's default SIGKILL first, then escalate's queued timeout: exactly one SIGKILL", async () => {
    processGroupSeams.probe = () => {};
    processGroupSeams.leader = () => {};
    const k = watchKill();
    const child = fakeChild();
    const cancel = escalate(child, 30, 30, () => {}, () => {});
    cleanups.push(cancel);
    signalGroup(child, "SIGKILL");
    await pause(120);
    expect(k.sent).toEqual([[-PID, "SIGKILL"]]);
  });
});

describe("a leader reaped before its exit notice (ISS-1469 R1)", () => {
  it("N1: kill(leader, 0) answers ESRCH and the group probe answers gone: escalate's signals send nothing and the handle latches", async () => {
    processGroupSeams.probe = esrch;
    processGroupSeams.leader = esrch;
    const k = watchKill();
    const child = fakeChild();
    const cancel = escalate(child, 20, 30, () => {}, () => {});
    cleanups.push(cancel);
    await pause(120);
    expect(k.sent).toEqual([]);
    expect(groupHandle(child).disarmed).toBe(true);
  });

  it("N2: the leader reaped, its group still holding a real leftover: the signal is sent and the leftover is stopped", async () => {
    const leftover = plantGroup();
    processGroupSeams.leader = esrch;
    const k = watchKill();
    const child = Object.assign(fakeChild(), { pid: leftover.pid });
    const h = groupHandle(child as Fake, true);
    expect(h.signal("SIGTERM")).toBe("sent");
    expect(k.sent).toEqual([[-leftover.pid!, "SIGTERM"]]);
    expect(await gone(leftover.pid!)).toBe(true);
  });
});

describe("ACCEPTED RESIDUAL (ISS-1469): this signal reaches a foreign group by design", () => {
  it("AR-a: reuse before the first gone observation, with kill(leader, 0) answered by a replacement: the foreign group receives the signal", async () => {
    const foreign = plantGroup();
    processGroupSeams.leader = () => {};
    const child = Object.assign(fakeChild(), { pid: foreign.pid });
    expect(groupHandle(child as Fake, true).signal("SIGTERM")).toBe("sent");
    expect(await gone(foreign.pid!)).toBe(true);
  });

  it("AR-b: reuse before the first gone observation, kill(leader, 0) answering ESRCH and the group probe answering alive for the foreign group: it receives the signal", async () => {
    const foreign = plantGroup();
    processGroupSeams.leader = esrch;
    const child = Object.assign(fakeChild(), { pid: foreign.pid });
    expect(groupHandle(child as Fake, true).signal("SIGTERM")).toBe("sent");
    expect(await gone(foreign.pid!)).toBe(true);
  });
});

describe("one path for every group signal (ISS-1469 acceptance c)", () => {
  const SRC = join(__dirname, "..", "..", "src");
  function sources(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) for (const [k, v] of sources(p)) out.set(k, v);
      else if (name.endsWith(".ts")) out.set(p.slice(SRC.length + 1), readFileSync(p, "utf-8"));
    }
    return out;
  }
  /** Every `process.kill(-...)` call in the sources, as file and the call's text, and every rawGroupSend use outside its two homes. */
  /** Every rawGroupSend reference, comments excluded, counted per file: only its definition with the handle's own use, and the start probe's import with its seam default. */
  const RAW_ALLOWED: Record<string, number> = { [join("core", "process-group.ts")]: 2, [join("core", "setup-review-backends.ts")]: 2 };
  function rawCounts(files: Map<string, string>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [file, text] of files) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const n = (code.match(/\brawGroupSend\b/g) ?? []).length;
      if (n > 0) out[file] = n;
    }
    return out;
  }
  function scan(files: Map<string, string>): { kills: string[]; raw: string[] } {
    const kills: string[] = [];
    const raw: string[] = [];
    for (const [file, text] of files) {
      // Calls only: a comment or a message naming `kill(-pgid, 0)` is not a signal path.
      for (const m of text.matchAll(/process\.kill\(\s*-[^)]*\)/g)) kills.push(`${file}: ${m[0]}`);
      if (/\brawGroupSend\b/.test(text) && file !== join("core", "process-group.ts") && file !== join("core", "setup-review-backends.ts")) raw.push(file);
    }
    return { kills, raw };
  }

  it("src/ holds exactly one group send and one group probe, both the handle's seams, and the raw send is used nowhere else", () => {
    const { kills, raw } = scan(sources(SRC));
    expect(kills.sort()).toEqual([`${join("core", "process-group.ts")}: process.kill(-pgid, 0)`, `${join("core", "process-group.ts")}: process.kill(-pgid, signal)`]);
    expect(raw).toEqual([]);
    expect(rawCounts(sources(SRC))).toEqual(RAW_ALLOWED);
    // The start probe's send seam is called once, inside the callback it hands the handle, and the handle is the only caller of that callback.
    const backends = sources(SRC).get(join("core", "setup-review-backends.ts"))!;
    expect(backends.match(/startProbeSeams\.signal\(/g)).toHaveLength(1);
    expect(backends.match(/\bsend\(/g)).toBeNull();
    expect(backends.match(/groupHandle\(target\)\.signal\(sig, send\)/g)).toHaveLength(1);
  });

  it("the planted negative: a second negative-pid signal path fails the scan", () => {
    const files = sources(SRC);
    const p = join("core", "setup-review-supervisor.ts");
    files.set(p, `${files.get(p)!}\nexport function planted(pid: number): void { process.kill(-pid, "SIGTERM"); }\n`);
    expect(scan(files).kills).toContain(`${p}: process.kill(-pid, "SIGTERM")`);
    expect(scan(files).kills).toHaveLength(3);
  });

  it("runInGroup, runOwnedGroup, runReviewer, probeBackend and the start probe send every group signal through the handle's seam", async () => {
    const k = watchKill();
    const dir = mkdtempSync(join(tmpdir(), "iss1469-route-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stubborn = `(trap '' TERM; exec sleep 30) & echo $! > '${join(dir, "left")}'`;
    // runInGroup: the leader exits at once, its leftover ignores SIGTERM.
    const r1 = await runInGroup({ command: "/bin/sh", args: ["-c", `${stubborn}; sleep 0.1`], cwd: dir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, killGraceMs: 200 });
    expect(r1).toMatchObject({ cleanup: "confirmed" });
    // runOwnedGroup: the body returns while the group runs.
    const r2 = await runOwnedGroup({ command: "/bin/sh", args: ["-c", "sleep 30"], cwd: dir, env: { PATH: "/usr/bin:/bin" }, shutdownTimeoutMs: 200, onData: () => {} }, async () => "ok");
    expect(r2).toMatchObject({ kind: "ran", cleanup: "confirmed" });
    // runReviewer, and probeBackend through a fake codex: both time out with a stubborn leftover.
    const r3 = await runReviewer("/bin/sh", ["-c", `${stubborn}; sleep 30`], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, input: "x", timeoutMs: 100, killGraceMs: 200 });
    expect(r3.timedOut).toBe(true);
    const bin = join(dir, "bin");
    rmSync(bin, { force: true, recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), `#!/bin/sh\n${stubborn}\nsleep 30\n`);
    chmodSync(join(bin, "codex"), 0o755);
    expect(await probeBackend("codex", { PATH: `${bin}:/usr/bin:/bin` }, { timeoutMs: 100, killGraceMs: 200 })).toBeNull();
    // The start probe: a codex that never reaches the listener.
    const exec = join(dir, "exec");
    mkdirSync(exec);
    const start = await probeCodexStart(exec, { PATH: `${bin}:/usr/bin:/bin` }, { attemptMs: 200, totalMs: 1_500, killGraceMs: 100 });
    expect(start.ok).toBe(false);
    expect(k.outsideSend).toEqual([]);
    expect(k.sent.length).toBeGreaterThanOrEqual(6);
    expect(await gone(Number(readFileSync(join(dir, "left"), "utf-8")))).toBe(true);
  }, 30_000);
});

describe("a disarmed handle stops every production caller (ISS-1469 Codex round 1)", () => {
  /** Counts every send that reaches the raw seam, whoever calls it. */
  function countSends(): Array<[number, NodeJS.Signals]> {
    const sends: Array<[number, NodeJS.Signals]> = [];
    const send = processGroupSeams.send;
    processGroupSeams.send = (pgid, sig) => { sends.push([pgid, sig]); send(pgid, sig); };
    return sends;
  }
  /** A real leader that exits at once, leaving a SIGTERM-proof child in its group that holds its pipes; the child's pid is appended to `log`. */
  const leaveChild = (log: string): string => `(trap '' TERM; exec sleep 30) & echo $! >> '${log}'; exit 0`;
  const pidsIn = (log: string): number[] => readFileSync(log, "utf-8").split("\n").filter(Boolean).map(Number);
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "iss1469-disarmed-"));
    cleanups.push(() => {
      const log = join(dir, "left");
      try { for (const pid of pidsIn(log)) { try { realKill(pid, "SIGKILL"); } catch { /* gone */ } } } catch { /* no log */ }
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }
  /** The first probe of any group answers ESRCH, every later one answers for real: the absence is observed once, through the handle, so only the latch can hold a later signal back. */
  function absentOnce(): void {
    let used = false;
    processGroupSeams.probe = (pgid) => { if (!used) { used = true; esrch(); } real.probe(pgid); };
  }
  /** The forced absence: the group probe answers ESRCH until `restore`, then answers for real, so only the latch can hold a signal back. */
  function absentUntilRestored(): { restore: () => void } {
    processGroupSeams.probe = esrch;
    return { restore: () => { processGroupSeams.probe = real.probe; } };
  }

  it("runInGroup: an absence seen first, then the deadline's stop, the signal handed out and the exit cleanup send nothing", async () => {
    processGroupSeams.leader = () => {};
    const sends = countSends();
    const child = fakeRun();
    const absent = absentUntilRestored();
    expect(groupHandle(child, true).probe()).toBe("gone");
    absent.restore();
    processGroupSeams.probe = () => {};
    let handed!: GroupSignal;
    let pending!: ReturnType<typeof run>;
    const stopOnExit = newExitListener(() => { pending = run({ timeoutMs: 20, killGraceMs: 30, onSpawn: (_id, sig) => { handed = sig; } }); });
    await pause(100);
    expect(handed("SIGKILL")).toBe("released");
    stopOnExit();
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    await pending;
    expect(sends).toEqual([]);
  }, 10_000);

  it("runOwnedGroup: an absence seen by the body's probe, then stopOwned, sends nothing", async () => {
    const sends = countSends();
    let pgid = 0;
    const r = await runOwnedGroup({ command: "/bin/sleep", args: ["30"], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, shutdownTimeoutMs: 100, onData: () => {} }, async (g) => {
      pgid = g.pgid;
      const absent = absentUntilRestored();
      expect(g.probe()).toBe("gone");
      absent.restore();
      expect(g.probe()).toBe("alive");
      return "ok";
    });
    expect(sends).toEqual([]);
    expect(r).toMatchObject({ kind: "ran", cleanup: "unconfirmed" });
    // The group the latch left running ends here, so its exit notice lands inside this row.
    realKill(-pgid, "SIGKILL");
    expect(await gone(pgid)).toBe(true);
    await pause(50);
  }, 10_000);

  it("escalate through runReviewer: an absence seen by the gone-watch after the leader's exit (its first probe), then the timeout's SIGTERM and SIGKILL, send nothing", async () => {
    const sends = countSends();
    const dir = scratch();
    absentOnce();
    const r = await runReviewer("/bin/sh", ["-c", leaveChild(join(dir, "left"))], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, input: "", timeoutMs: 1_500, killGraceMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(sends).toEqual([]);
    expect(pidsIn(join(dir, "left")).every(alive)).toBe(true);
  }, 10_000);

  it("escalate through probeBackend: the same, through a fake codex", async () => {
    const sends = countSends();
    const dir = scratch();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), `#!/bin/sh\n${leaveChild(join(dir, "left"))}\n`);
    chmodSync(join(bin, "codex"), 0o755);
    absentOnce();
    expect(await probeBackend("codex", { PATH: `${bin}:/usr/bin:/bin` }, { timeoutMs: 1_500, killGraceMs: 100 })).toBeNull();
    expect(sends).toEqual([]);
    expect(pidsIn(join(dir, "left")).every(alive)).toBe(true);
  }, 10_000);

  it("startAttempt: an absence seen by the first probe after codex exits, then the attempt's SIGTERM, its stop and its finish send nothing to that group", async () => {
    const sends = countSends();
    const dir = scratch();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Each codex logs its own pid (its group) first, then leaves the child that holds its stderr.
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho $$ >> '${join(dir, "leaders")}'\n${leaveChild(join(dir, "left"))}\n`);
    chmodSync(join(bin, "codex"), 0o755);
    absentOnce();
    const exec = join(dir, "exec");
    mkdirSync(exec);
    const r = await probeCodexStart(exec, { PATH: `${bin}:/usr/bin:/bin` }, { attemptMs: 1_500, totalMs: 2_000, killGraceMs: 100 });
    expect(r.ok).toBe(false);
    const first = pidsIn(join(dir, "leaders"))[0]!;
    expect(sends.filter(([pgid]) => pgid === first)).toEqual([]);
    expect(alive(pidsIn(join(dir, "left"))[0]!)).toBe(true);
  }, 10_000);
});

describe("S3: a reviewer's leader exits while a grandchild holds its pipes (ISS-1469)", () => {
  it("escalate's SIGTERM and SIGKILL reach the grandchild through the handle, and nothing is left", async () => {
    const k = watchKill();
    const dir = mkdtempSync(join(tmpdir(), "iss1469-s3-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const left = join(dir, "left");
    const r = await runReviewer("/bin/sh", ["-c", `(trap '' TERM; exec sleep 30) & echo $! > '${left}'; echo hi`], { cwd: dir, env: { PATH: "/usr/bin:/bin" }, input: "", timeoutMs: 150, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(k.sent.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(k.outsideSend).toEqual([]);
    expect(await gone(Number(readFileSync(left, "utf-8")))).toBe(true);
  });
});

describe("owned groups keep their workload verdicts (ISS-1469 R3)", () => {
  it("a clean run: no leftover at the leader's exit, confirmed, and well under the shutdown timeout", async () => {
    const started = Date.now();
    const r = await runOwnedGroup({ command: "/bin/sh", args: ["-c", "exit 0"], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, shutdownTimeoutMs: 3_000, onData: () => {} }, async (g) => {
      await g.exit;
      return g.leftAtLeaderExit();
    });
    expect(r).toMatchObject({ kind: "ran", value: { ok: true, value: false }, cleanup: "confirmed" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("a run that leaves a child behind: the leftover is seen at the leader's exit and stopped", async () => {
    const r = await runOwnedGroup({ command: "/bin/sh", args: ["-c", "sleep 30 & exit 0"], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, shutdownTimeoutMs: 500, onData: () => {} }, async (g) => {
      await g.exit;
      return g.leftAtLeaderExit();
    });
    expect(r).toMatchObject({ kind: "ran", value: { ok: true, value: true }, cleanup: "confirmed" });
  });
});
