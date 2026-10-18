/**
 * T-538 S3a-2 commit 5: setup-verify's run in its own process group, from
 * spawn until the group is confirmed gone (ISS-1391's machinery, extracted
 * to process-group.ts and shared with setup-review).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processGroupSeams, runInGroup, type GroupRunOptions } from "../../src/core/process-group.js";

const realProbe = processGroupSeams.probe;
afterEach(() => { processGroupSeams.probe = realProbe; });

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
    const r = await run("trap '' TERM; sleep 30", { timeoutMs: 300, killGraceMs: 300 });
    expect(r).toMatchObject({ timedOut: true, cleanup: "confirmed" });
    expect(r.ms).toBeLessThan(5_000);
  });

  it("stops a descendant still holding the pipes after the shell exits", async () => {
    const r = await run("sleep 30 & echo done", { killGraceMs: 300 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, cleanup: "confirmed" });
    expect(r.out).toContain("done");
    expect(r.ms).toBeLessThan(5_000);
  });

  it("keeps the deadline after the shell exits: a SIGTERM-proof leftover is killed at it, not after the grace", async () => {
    const r = await run("(trap '' TERM; sleep 30) & echo done", { timeoutMs: 400, killGraceMs: 20_000 });
    expect(r).toMatchObject({ exitCode: 0, timedOut: true, cleanup: "confirmed" });
    expect(r.ms).toBeLessThan(8_000);
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
