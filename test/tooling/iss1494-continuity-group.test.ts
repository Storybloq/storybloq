/**
 * ISS-1494: the continuity runner signals and probes its process groups through the ISS-1469 group handle, and
 * the static negative-pid scan covers scripts/ as well as src/.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupHandle, processGroupSeams } from "../../src/core/process-group.js";
import { outsideProbe, signalGroup } from "../../scripts/continuity-run.js";

const real = { ...processGroupSeams };
const cleanups: Array<() => void> = [];
afterEach(() => {
  Object.assign(processGroupSeams, real);
  while (cleanups.length > 0) cleanups.pop()!();
});

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number, ms = 2_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await pause(10);
  return !alive(pid);
}
/** Every send that reaches the handle's raw seam, whoever made it. */
function countSends(): Array<[number, NodeJS.Signals]> {
  const sends: Array<[number, NodeJS.Signals]> = [];
  processGroupSeams.send = (pgid, sig) => { sends.push([pgid, sig]); real.send(pgid, sig); };
  return sends;
}
/** A real leader in its own group with a second member; the member's pid is written to `log`. */
function group(log: string): ChildProcess {
  const child = spawn("/bin/sh", ["-c", `sleep 30 & echo $! > '${log}'; wait`], { stdio: "ignore", detached: true });
  cleanups.push(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } });
  return child;
}
async function member(log: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    try { const n = Number(readFileSync(log, "utf-8").trim()); if (n > 0) return n; } catch { /* not yet */ }
    await pause(10);
  }
  throw new Error("the group's member never started");
}
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "iss1494-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the continuity stop path goes through the group handle (ISS-1494)", () => {
  it("an absence the handle has seen: signalGroup's SIGTERM and SIGKILL send nothing to the group, and only the child itself is stopped", async () => {
    const dir = scratch();
    const child = group(join(dir, "member"));
    const other = await member(join(dir, "member"));
    const sends = countSends();
    processGroupSeams.probe = () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };
    expect(groupHandle(child, true).probe()).toBe("gone");
    processGroupSeams.probe = real.probe;
    const closed = new Promise((r) => child.once("close", r));
    signalGroup(child, "SIGTERM");
    signalGroup(child, "SIGKILL");
    await closed;
    expect(sends).toEqual([]);
    // The leader went through Node's own handle; its group's other member was never signalled.
    expect(alive(other)).toBe(true);
  });

  it("a SIGKILL that went out is final: the survivors' second SIGKILL sends nothing more to the group", async () => {
    const dir = scratch();
    const child = group(join(dir, "member"));
    const other = await member(join(dir, "member"));
    const sends = countSends();
    signalGroup(child, "SIGKILL");
    expect(await gone(other)).toBe(true);
    signalGroup(child, "SIGKILL");
    expect(sends).toEqual([[child.pid!, "SIGKILL"]]);
  });

  it("outsideProbe stops its command's whole group through the handle and waits it out", async () => {
    const dir = scratch();
    const log = join(dir, "member");
    const sends = countSends();
    // The listener sees the token only after the probe has started, as it would in a run.
    const received: Buffer[] = [];
    setTimeout(() => received.push(Buffer.from("seen-1494")), 150);
    expect(await outsideProbe(`echo 'seen-1494' > /dev/null; sleep 30 & echo $! > '${log}'; wait`, dir, { PATH: "/usr/bin:/bin" }, received)).toBe(true);
    expect(sends.map(([, s]) => s)).toEqual(["SIGKILL"]);
    expect(alive(Number(readFileSync(log, "utf-8").trim()))).toBe(false);
  });
});

describe("the handle is settled when its owner returns (ISS-1494 Codex round 1)", () => {
  it("outsideProbe: the group signal fails, the leader exits, the group answers alive then EPERM; after it returns, no probe runs", async () => {
    const dir = scratch();
    const log = join(dir, "member");
    processGroupSeams.send = () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
    let probes = 0;
    processGroupSeams.probe = () => { if (++probes > 2) throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
    const received: Buffer[] = [];
    setTimeout(() => received.push(Buffer.from("seen-1494")), 100);
    const ok = await outsideProbe(`echo 'seen-1494' > /dev/null; sleep 30 & echo $! > '${log}'; wait`, dir, { PATH: "/usr/bin:/bin" }, received);
    const left = Number(readFileSync(log, "utf-8").trim());
    cleanups.push(() => { try { process.kill(left, "SIGKILL"); } catch { /* gone */ } });
    expect(ok).toBe(true);
    // The member outlived the failed group signal, so a watch left armed would keep probing.
    expect(alive(left)).toBe(true);
    const first = probes;
    await pause(150);
    expect(probes).toBe(first);
  }, 10_000);
});

describe("the negative-pid scan covers scripts/ (ISS-1494)", () => {
  const ROOT = join(__dirname, "..", "..", "scripts");
  /** Runs inside the eval container, where it cannot import src/: its own pid namespace is the whole world. Reported to the pen for a ruling. */
  const ALLOWED: Record<string, number> = { [join("eval-container", "envelope.mjs")]: 1 };
  function sources(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) for (const [k, v] of sources(p)) out.set(k, v);
      else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name)) out.set(p.slice(ROOT.length + 1), readFileSync(p, "utf-8"));
    }
    return out;
  }
  /** Negative-pid kill calls and rawGroupSend references per file, comments stripped. */
  function scan(files: Map<string, string>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [file, text] of files) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      const n = (code.match(/process\.kill\(\s*-[^)]*\)/g) ?? []).length + (code.match(/\brawGroupSend\b/g) ?? []).length;
      if (n > 0) out[file] = n;
    }
    return out;
  }

  it("scripts/ holds no negative-pid kill and no raw group send outside the one allowed container file", () => {
    expect(scan(sources(ROOT))).toEqual(ALLOWED);
  });

  it("the planted negative: a raw group kill in a script fails the scan", () => {
    const files = sources(ROOT);
    files.set("continuity-run.ts", `${files.get("continuity-run.ts")!}\nexport function planted(pid: number): void { process.kill(-pid, "SIGTERM"); }\n`);
    expect(scan(files)).toEqual({ ...ALLOWED, "continuity-run.ts": 1 });
  });
});
