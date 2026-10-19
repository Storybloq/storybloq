/**
 * T-538 S3b commit 2: `runOwnedGroup`, the lifecycle BUILD and VERIFY share.
 * The command runs in its own process group with the pgid captured at spawn;
 * whatever the body returns or throws, the group is stopped (SIGTERM, SIGKILL
 * after the shutdown timeout) and confirmed gone by ESRCH within a bound. A
 * pid the leader leaves behind is seen at its exit. Without process groups
 * (Windows) nothing is spawned.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIRM_BOUND_MS, ownedGroupUnsupported, processGroupSeams, runOwnedGroup, type OwnedGroupOptions } from "../../src/core/process-group.js";

vi.setConfig({ testTimeout: 30_000 });

const realProbe = processGroupSeams.probe;
const realSpawn = processGroupSeams.spawn;
const realOwn = processGroupSeams.ownGroup;
const dirs: string[] = [];
afterEach(async () => {
  processGroupSeams.probe = realProbe;
  processGroupSeams.spawn = realSpawn;
  processGroupSeams.ownGroup = realOwn;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "t538-s3b-og-"));
  dirs.push(d);
  return d;
};

const opts = (script: string, cwd: string, over: Partial<OwnedGroupOptions> = {}): OwnedGroupOptions => ({
  command: "/bin/sh",
  args: ["-c", script],
  cwd,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  shutdownTimeoutMs: 1000,
  onData: () => {},
  ...over,
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** What `kill(-pgid, 0)` answers now: the error code, or "alive". */
const groupAnswer = (pgid: number): string => {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? String(err);
  }
};

/** Waits for a file the command writes once it is ready. */
async function readyFile(path: string): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const text = await readFile(path, "utf-8").catch(() => "");
    if (text.trim() !== "") return text.trim();
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${path} never written`);
}

describe("runOwnedGroup", () => {
  it("runs the body with the live group, then stops the whole group, a grandchild included, and confirms it gone", async () => {
    const dir = await scratch();
    const marker = join(dir, "grandchild");
    const r = await runOwnedGroup(opts(`sleep 30 & echo $! > ${marker}; sleep 30`, dir), async (g) => {
      const grandchild = Number(await readyFile(marker));
      expect(g.exited()).toBeNull();
      expect(g.probe()).toBe("alive");
      return { pgid: g.pgid, grandchild };
    });
    expect(r.kind).toBe("ran");
    if (r.kind !== "ran" || !r.value.ok) throw new Error("expected a value");
    expect(r.cleanup).toBe("confirmed");
    expect(r.cleanupDetail).toBeNull();
    expect(alive(r.value.value.grandchild)).toBe(false);
    expect(groupAnswer(r.value.value.pgid)).toBe("ESRCH");
  });

  it("stops the group when the body throws, and hands the error back", async () => {
    const dir = await scratch();
    const marker = join(dir, "leader");
    let pgid = 0;
    const r = await runOwnedGroup(opts(`echo $$ > ${marker}; sleep 30`, dir), async (g) => {
      pgid = g.pgid;
      await readyFile(marker);
      throw new Error("the body failed");
    });
    if (r.kind !== "ran") throw new Error("expected a run");
    expect(r.value).toEqual({ ok: false, error: new Error("the body failed") });
    expect(r.cleanup).toBe("confirmed");
    expect(groupAnswer(pgid)).toBe("ESRCH");
  });

  it("sees a pid the leader left behind at its exit, and none when it leaves nothing", async () => {
    const dir = await scratch();
    const left = await runOwnedGroup(opts("sleep 30 & exit 0", dir), async (g) => {
      await g.exit;
      return { exited: g.exited(), left: g.leftAtLeaderExit() };
    });
    if (left.kind !== "ran" || !left.value.ok) throw new Error("expected a value");
    expect(left.value.value).toEqual({ exited: { code: 0, signal: null }, left: true });
    expect(left.cleanup).toBe("confirmed");

    const clean = await runOwnedGroup(opts("exit 3", dir), async (g) => {
      expect(g.leftAtLeaderExit()).toBeNull();
      await g.exit;
      return { exited: g.exited(), left: g.leftAtLeaderExit() };
    });
    if (clean.kind !== "ran" || !clean.value.ok) throw new Error("expected a value");
    expect(clean.value.value).toEqual({ exited: { code: 3, signal: null }, left: false });
  });

  it("escalates to SIGKILL after the shutdown timeout for a member that ignores SIGTERM", async () => {
    const dir = await scratch();
    const marker = join(dir, "trapped");
    const started = Date.now();
    const r = await runOwnedGroup(opts(`trap '' TERM; echo ready > ${marker}; while :; do sleep 1; done`, dir, { shutdownTimeoutMs: 400 }), async () => {
      await readyFile(marker);
      return Date.now();
    });
    if (r.kind !== "ran" || !r.value.ok) throw new Error("expected a value");
    expect(r.cleanup).toBe("confirmed");
    expect(Date.now() - r.value.value).toBeGreaterThanOrEqual(350);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("is unconfirmed, naming the group, when the probe keeps finding it", async () => {
    const dir = await scratch();
    processGroupSeams.probe = () => {};
    const r = await runOwnedGroup(opts("exit 0", dir, { shutdownTimeoutMs: 100 }), async (g) => g.pgid);
    if (r.kind !== "ran" || !r.value.ok) throw new Error("expected a value");
    expect(r.cleanup).toBe("unconfirmed");
    expect(r.cleanupDetail).toBe(`process group ${r.value.value} still present ${CONFIRM_BOUND_MS} ms after the last signal`);
  });

  it("is unconfirmed, naming the answer, when the probe answers EPERM to the end", async () => {
    const dir = await scratch();
    processGroupSeams.probe = () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    const r = await runOwnedGroup(opts("exit 0", dir, { shutdownTimeoutMs: 100 }), async (g) => g.pgid);
    if (r.kind !== "ran" || !r.value.ok) throw new Error("expected a value");
    expect(r.cleanupDetail).toBe(`kill(-${r.value.value}, 0) answered EPERM ${CONFIRM_BOUND_MS} ms after the last signal`);
  });

  it("reports a command that cannot start, with no body run", async () => {
    const body = vi.fn(async () => 1);
    const r = await runOwnedGroup(opts("exit 0", join(tmpdir(), "t538-s3b-no-such-dir")), body);
    expect(r.kind).toBe("spawn-error");
    expect(body).not.toHaveBeenCalled();
  });

  it("holds the signal handler only while the group is live", async () => {
    const dir = await scratch();
    const before = process.listenerCount("SIGTERM");
    const r = await runOwnedGroup(opts("sleep 30", dir), async () => process.listenerCount("SIGTERM"));
    if (r.kind !== "ran" || !r.value.ok) throw new Error("expected a value");
    expect(r.value.value).toBe(before + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("spawns nothing without process groups, and says why", async () => {
    processGroupSeams.ownGroup = false;
    const spawn = vi.fn();
    processGroupSeams.spawn = spawn as unknown as typeof processGroupSeams.spawn;
    expect(ownedGroupUnsupported()).toBe("this platform has no process groups to own (Windows)");
    await expect(runOwnedGroup(opts("exit 0", tmpdir()), async () => 1)).rejects.toThrow(/no process groups to own/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
