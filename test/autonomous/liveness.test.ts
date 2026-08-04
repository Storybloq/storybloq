/**
 * T-260: Liveness infrastructure tests.
 *
 * Tests the four liveness mechanisms: sidecar heartbeat, lastMcpCall touch,
 * binary fingerprint, and Claude Code session ID capture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, utimesSync, symlinkSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn as spawnChild, execSync } from "node:child_process";

import {
  telemetryDirPath,
  spawnAliveSidecar,
  killSidecar,
  writeShutdownMarker,
  touchLastMcpCallFile,
  readLastMcpCall,
  readAliveTimestamp,
  computeBinaryFingerprint,
  captureClaudeCodeSessionId,
  __testing,
} from "../../src/autonomous/liveness.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Liveness infrastructure (T-260)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "liveness-test-"));
    sessionDir = join(tmpDir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  describe("telemetryDirPath", () => {
    it("returns telemetry subdirectory of session dir", () => {
      expect(telemetryDirPath(sessionDir)).toBe(join(sessionDir, "telemetry"));
    });
  });

  describe("spawnAliveSidecar", () => {
    let pid: number | undefined;

    afterEach(() => {
      if (pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
        pid = undefined;
      }
    });

    it("writes alive file within 2 seconds with 200ms interval", async () => {
      const tDir = telemetryDirPath(sessionDir);
      pid = spawnAliveSidecar(tDir, 200);
      expect(pid).toBeGreaterThan(0);

      const aliveFile = join(tDir, "alive");
      for (let i = 0; i < 20; i++) {
        if (existsSync(aliveFile)) break;
        await sleep(100);
      }
      expect(existsSync(aliveFile)).toBe(true);
      const content = readFileSync(aliveFile, "utf-8").trim();
      const ts = Number(content);
      expect(ts).toBeGreaterThan(0);
    });

    it("stops writing when killed", async () => {
      const tDir = telemetryDirPath(sessionDir);
      pid = spawnAliveSidecar(tDir, 200);

      const aliveFile = join(tDir, "alive");
      let found = false;
      for (let i = 0; i < 30; i++) {
        if (existsSync(aliveFile)) { found = true; break; }
        await sleep(100);
      }
      expect(found).toBe(true);

      killSidecar(pid);
      pid = undefined;
      await sleep(500);

      const before = readFileSync(aliveFile, "utf-8").trim();
      await sleep(600);
      const after = readFileSync(aliveFile, "utf-8").trim();
      expect(after).toBe(before);
    });

    it("exits when shutdown marker is written", async () => {
      const tDir = telemetryDirPath(sessionDir);
      pid = spawnAliveSidecar(tDir, 200);
      await sleep(500);

      writeShutdownMarker(sessionDir);
      await sleep(500);

      const aliveFile = join(tDir, "alive");
      const content = readFileSync(aliveFile, "utf-8").trim();
      expect(content).toBe("0");
      pid = undefined;
    });
  });

  describe("killSidecar", () => {
    it("handles null pid gracefully", () => {
      expect(() => killSidecar(null)).not.toThrow();
    });

    it("handles undefined pid gracefully", () => {
      expect(() => killSidecar(undefined)).not.toThrow();
    });

    it("handles invalid pid (ESRCH) gracefully", () => {
      expect(() => killSidecar(999999999)).not.toThrow();
    });
  });

  describe("writeShutdownMarker", () => {
    it("writes shutdown file and sets alive to 0", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "12345");

      writeShutdownMarker(sessionDir);

      expect(existsSync(join(tDir, "shutdown"))).toBe(true);
      expect(readFileSync(join(tDir, "alive"), "utf-8").trim()).toBe("0");
    });
  });

  describe("touchLastMcpCallFile", () => {
    it("writes ISO timestamp to telemetry/lastMcpCall", () => {
      touchLastMcpCallFile(sessionDir);

      const tDir = telemetryDirPath(sessionDir);
      const content = readFileSync(join(tDir, "lastMcpCall"), "utf-8").trim();
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("readLastMcpCall", () => {
    it("reads back a written timestamp", () => {
      touchLastMcpCallFile(sessionDir);
      const result = readLastMcpCall(sessionDir);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("returns null when file is missing", () => {
      expect(readLastMcpCall(sessionDir)).toBeNull();
    });
  });

  describe("readAliveTimestamp", () => {
    it("reads back an epoch timestamp", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");

      expect(readAliveTimestamp(sessionDir)).toBe(1712847600000);
    });

    it("returns null for '0' (shutdown)", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "0");

      expect(readAliveTimestamp(sessionDir)).toBeNull();
    });

    it("returns null when file is missing", () => {
      expect(readAliveTimestamp(sessionDir)).toBeNull();
    });

    it("returns null when shutdown marker exists even if alive has a valid timestamp", () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      writeFileSync(join(tDir, "alive"), "1712847600000");
      writeFileSync(join(tDir, "shutdown"), "1");

      expect(readAliveTimestamp(sessionDir)).toBeNull();
    });
  });

  describe("computeBinaryFingerprint", () => {
    it("returns an object with mtime and sha256 strings", () => {
      const result = computeBinaryFingerprint();
      // May be null in dev mode without build, but if present, must have correct shape
      if (result !== null) {
        expect(result.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  describe("captureClaudeCodeSessionId", () => {
    const originalEnv = process.env.CLAUDE_CODE_SESSION_ID;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.CLAUDE_CODE_SESSION_ID = originalEnv;
      } else {
        delete process.env.CLAUDE_CODE_SESSION_ID;
      }
    });

    it("returns env var value when set", () => {
      process.env.CLAUDE_CODE_SESSION_ID = "test-uuid-abc";
      expect(captureClaudeCodeSessionId()).toBe("test-uuid-abc");
    });

    it("returns null when env var is not set", () => {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      expect(captureClaudeCodeSessionId()).toBeNull();
    });
  });
});

// ============================================================================
// T-283: spawnAliveSidecar dedup with interprocess lock
// ============================================================================

const describePosix = process.platform === "win32" ? describe.skip : describe;

function waitForAliveContent(tDir: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      try {
        const v = readFileSync(join(tDir, "alive"), "utf-8").trim();
        if (v) return resolve(v);
      } catch { /* not yet */ }
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      try {
        process.kill(pid, 0);
      } catch (e: any) {
        if (e && e.code === "ESRCH") return resolve(true);
      }
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

describePosix("T-283 spawnAliveSidecar dedup + lock", () => {
  let tmpDir: string;
  let tDir: string;
  const spawnedPids: number[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "t283-"));
    tDir = join(tmpDir, "telemetry");
    mkdirSync(tDir, { recursive: true });
  });

  afterEach(async () => {
    const pids = spawnedPids.splice(0);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of pids) {
      try { process.kill(pid, 0); } catch { continue; }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone or not ours */ }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Test 1 -- U -- basic dedup
  it("#1 dedups prior sidecar: priorPid exits, newPid has signature", async () => {
    const priorPid = spawnAliveSidecar(tDir, 200);
    expect(priorPid).toBeGreaterThan(0);
    if (priorPid) spawnedPids.push(priorPid);
    // wait for it to be writing
    const v = await waitForAliveContent(tDir, 2000);
    expect(v).not.toBeNull();

    const newPid = spawnAliveSidecar(tDir, 200);
    expect(newPid).toBeGreaterThan(0);
    expect(newPid).not.toBe(priorPid);
    if (newPid) spawnedPids.push(newPid);

    const priorExited = await waitForProcessExit(priorPid!, 2000);
    expect(priorExited).toBe(true);

    const pidFileContent = readFileSync(join(tDir, "sidecar.pid"), "utf-8").trim();
    expect(Number(pidFileContent)).toBe(newPid);
    expect(__testing.hasSidecarSignature(newPid!)).toBe(true);
  });

  // Test 2 -- U -- PID reuse guard (unrelated process in sidecar.pid)
  it("#2 does NOT kill unrelated process when sidecar.pid points at it", async () => {
    const unrelated = spawnChild(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    unrelated.unref();
    const unrelatedPid = unrelated.pid!;
    spawnedPids.push(unrelatedPid);
    writeFileSync(join(tDir, "sidecar.pid"), String(unrelatedPid));

    const newPid = spawnAliveSidecar(tDir, 500);
    expect(newPid).toBeGreaterThan(0);
    if (newPid) spawnedPids.push(newPid);
    expect(newPid).not.toBe(unrelatedPid);

    // unrelated process must still be alive
    let stillAlive = true;
    try { process.kill(unrelatedPid, 0); } catch { stillAlive = false; }
    expect(stillAlive).toBe(true);

    const pidFile = readFileSync(join(tDir, "sidecar.pid"), "utf-8").trim();
    expect(Number(pidFile)).toBe(newPid);
  });

  // Test 3 -- U -- crash recovery (stale pid file)
  it("#3 recovers when sidecar.pid contains a stale PID", () => {
    writeFileSync(join(tDir, "sidecar.pid"), "999999");
    const newPid = spawnAliveSidecar(tDir, 500);
    expect(newPid).toBeGreaterThan(0);
    if (newPid) spawnedPids.push(newPid);
    const pidFile = readFileSync(join(tDir, "sidecar.pid"), "utf-8").trim();
    expect(Number(pidFile)).toBe(newPid);
  });

  // Test 4 -- U -- token-verified release
  it("#4 releaseSpawnLock does NOT unlink lock when token differs", () => {
    const handle = __testing.acquireSpawnLock(tDir);
    expect(handle).not.toBeNull();
    const lockPath = join(tDir, "sidecar.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "wrong", acquiredAt: Date.now() }));
    __testing.releaseSpawnLock(handle!);
    expect(existsSync(lockPath)).toBe(true);
    // cleanup (force unlink for afterEach rmSync)
  });

  // Test 5 -- U -- unsupported filesystem (EPERM)
  it("#5 EPERM on linkSync -> spawnAliveSidecar returns null, does not spawn", () => {
    const spy = vi.spyOn(__testing.fsApi, "linkSync").mockImplementationOnce(() => {
      const e: any = new Error("mock");
      e.code = "EPERM";
      throw e;
    });
    const result = spawnAliveSidecar(tDir, 500);
    expect(result).toBeNull();
    expect(existsSync(join(tDir, "sidecar.pid"))).toBe(false);
    spy.mockRestore();
  });

  // Test 6 -- U -- unsupported filesystem (EXDEV/ENOTSUP/ENOSYS)
  it.each(["EXDEV", "ENOTSUP", "ENOSYS"])("#6 %s on linkSync -> null without throw", (code) => {
    const spy = vi.spyOn(__testing.fsApi, "linkSync").mockImplementationOnce(() => {
      const e: any = new Error("mock");
      e.code = code;
      throw e;
    });
    expect(() => spawnAliveSidecar(tDir, 500)).not.toThrow();
    spy.mockRestore();
  });

  // Test 7 -- U -- genuine I/O error (ENOSPC rethrows)
  it("#7 ENOSPC on linkSync rethrows and cleans tmp", () => {
    const spy = vi.spyOn(__testing.fsApi, "linkSync").mockImplementation(() => {
      const e: any = new Error("disk full");
      e.code = "ENOSPC";
      throw e;
    });
    expect(() => spawnAliveSidecar(tDir, 500)).toThrow();
    spy.mockRestore();
    // tmp files should not be left behind
    const leftovers = require("node:fs").readdirSync(tDir).filter((f: string) => f.includes(".tmp."));
    expect(leftovers.length).toBe(0);
  });

  // Test 8 -- U -- teardown timing
  it("#8 writeShutdownMarker terminates sidecar and removes sidecar.pid", async () => {
    const pid = spawnAliveSidecar(tDir, 200);
    if (pid) spawnedPids.push(pid);
    await waitForAliveContent(tDir, 2000);

    const sessionDir = tmpDir;
    writeShutdownMarker(sessionDir);

    const aliveContent = await (async () => {
      for (let i = 0; i < 20; i++) {
        const v = readFileSync(join(tDir, "alive"), "utf-8").trim();
        if (v === "0") return v;
        await new Promise((r) => setTimeout(r, 100));
      }
      return readFileSync(join(tDir, "alive"), "utf-8").trim();
    })();
    expect(aliveContent).toBe("0");

    const exited = await waitForProcessExit(pid!, 2000);
    expect(exited).toBe(true);
    expect(existsSync(join(tDir, "sidecar.pid"))).toBe(false);
    expect(existsSync(join(tDir, "shutdown"))).toBe(true);
  });

  // Test 10 -- U -- I7 return-shape contract
  it("#10 spawnAliveSidecar type is number | null on EPERM mock path", () => {
    const spy = vi.spyOn(__testing.fsApi, "linkSync").mockImplementationOnce(() => {
      const e: any = new Error("mock");
      e.code = "EPERM";
      throw e;
    });
    const r: number | null = spawnAliveSidecar(tDir, 500);
    expect(r).toBeNull();
    spy.mockRestore();
  });

  // Test 11 -- U -- no-lock branch verifies alive AND ours
  it("#11 no-lock branch: stale sidecar.pid -> null; unrelated live pid -> null", () => {
    const spy = vi.spyOn(__testing.fsApi, "linkSync").mockImplementation(() => {
      const e: any = new Error();
      e.code = "EPERM";
      throw e;
    });
    // stale pid
    writeFileSync(join(tDir, "sidecar.pid"), "999999");
    expect(spawnAliveSidecar(tDir, 500)).toBeNull();

    // live but unrelated
    const unrelated = spawnChild(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    unrelated.unref();
    if (unrelated.pid) spawnedPids.push(unrelated.pid);
    writeFileSync(join(tDir, "sidecar.pid"), String(unrelated.pid));
    expect(spawnAliveSidecar(tDir, 500)).toBeNull();
    spy.mockRestore();
  });

  // Test 13 -- U -- shape validator rejects bad PID shapes
  it("#13 inspectExistingLock rejects NaN/0/neg/non-integer PID bodies as unreadable", () => {
    const lockPath = join(tDir, "sidecar.lock");
    const bad = [
      { pid: 0, token: "t", acquiredAt: Date.now() },
      { pid: -1, token: "t", acquiredAt: Date.now() },
      { pid: null, token: "t", acquiredAt: Date.now() },
      { pid: 3.14, token: "t", acquiredAt: Date.now() },
    ];
    for (const body of bad) {
      writeFileSync(lockPath, JSON.stringify(body));
      expect(__testing.inspectExistingLock(lockPath).state).toBe("unreadable");
    }
  });

  // Test 14 -- U -- symlink rejection
  it("#14 symlink at sidecar.lock -> unreadable (no target read)", () => {
    const lockPath = join(tDir, "sidecar.lock");
    symlinkSync("/etc/passwd", lockPath);
    expect(__testing.inspectExistingLock(lockPath).state).toBe("unreadable");
  });

  // Test 15 -- U -- unreadable-lock recovery after UNREADABLE_BREAK_MS
  it("#15 spawnAliveSidecar breaks persistently-unreadable old lock and spawns", () => {
    const lockPath = join(tDir, "sidecar.lock");
    writeFileSync(lockPath, "not json");
    const past = new Date(Date.now() - 60_000 - 1000);
    utimesSync(lockPath, past, past);
    const pid = spawnAliveSidecar(tDir, 500);
    if (pid) spawnedPids.push(pid);
    expect(pid).toBeGreaterThan(0);
  });

  // Test 16 -- U -- releaseSpawnLock inode fallback
  it("#16 releaseSpawnLock inode fallback removes lock when content corrupted", () => {
    const handle = __testing.acquireSpawnLock(tDir);
    expect(handle).not.toBeNull();
    const lockPath = join(tDir, "sidecar.lock");
    writeFileSync(lockPath, "corrupt bytes");
    __testing.releaseSpawnLock(handle!);
    expect(existsSync(lockPath)).toBe(false);
  });

  // Test 17 -- U -- PID-file publish failure -> null and no orphan
  it("#17 renameSync failure during writeSidecarPid -> null, child killed", async () => {
    let newPid: number | null = null;
    const origRename = __testing.fsApi.renameSync;
    const spy = vi.spyOn(__testing.fsApi, "renameSync").mockImplementation(((from: string, to: string) => {
      if (to.endsWith("sidecar.pid")) {
        throw Object.assign(new Error("mock"), { code: "ENOSPC" });
      }
      return origRename(from, to);
    }) as any);

    const r = spawnAliveSidecar(tDir, 500);
    expect(r).toBeNull();
    spy.mockRestore();
    // Verify no orphan sidecar survived the failed publish. killJustSpawnedChild
    // should have signalled the freshly-forked pid directly (bypassing the
    // signature gate which races the ps/proc write for a new child).
    await new Promise((r) => setTimeout(r, 800));
    if (process.platform !== "win32") {
      const psOut = execSync("ps -ef", { encoding: "utf-8" });
      const sentinelLines = psOut
        .split("\n")
        .filter((l) => l.includes("CLAUDESTORY_SIDECAR_V1") && l.includes(tDir));
      expect(sentinelLines.length).toBe(0);
    }
  });

  // Test 18 -- U -- Atomics.wait fallback
  it("#18 sleepMs fallback when Atomics.wait throws", () => {
    const orig = Atomics.wait;
    (Atomics as any).wait = () => { throw new Error("disabled"); };
    try {
      const start = Date.now();
      __testing.sleepMs(25);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(20);
    } finally {
      (Atomics as any).wait = orig;
    }
  });

  // Test 24 -- U -- spawnAliveSidecar null when killPriorSidecar returns false
  it("#24 kill-failure path -> null, no new spawn", () => {
    // Write a real live sentinel-matched sidecar
    const pid = spawnAliveSidecar(tDir, 500);
    if (pid) spawnedPids.push(pid);
    expect(pid).toBeGreaterThan(0);

    // Stub killPriorSidecar to return false (via test seam).
    // NB: we can't reliably spy on child_process.spawn here -- liveness.ts
    // imports it statically at module load, so vi.spyOn against the
    // node:child_process namespace wouldn't intercept the call. Instead we
    // assert the observable post-conditions: r is null, lock is released,
    // and sidecar.pid still points to the original pid (no rename occurred).
    const origKill = __testing.killPriorSidecar;
    (__testing as any).killPriorSidecar = () => false;
    try {
      const r = spawnAliveSidecar(tDir, 500);
      expect(r).toBeNull();
      expect(existsSync(join(tDir, "sidecar.lock"))).toBe(false);
      const content = readFileSync(join(tDir, "sidecar.pid"), "utf-8").trim();
      expect(Number(content)).toBe(pid);
    } finally {
      (__testing as any).killPriorSidecar = origKill;
    }
  });

  // Test 25 -- U -- EPERM on inspectExistingLock probe -> treated as dead
  //
  // EPERM from process.kill(pid,0) means the pid exists but we cannot
  // signal it (different uid). It cannot be our sidecar (we would have
  // been the spawner, hence same uid). Treat as dead for staleness
  // purposes to avoid a PID-reuse wedge where a recorded pid gets
  // recycled to another user and the lock becomes un-breakable.
  it("#25 EPERM on process.kill(pid,0) treated as dead for staleness", () => {
    const lockPath = join(tDir, "sidecar.lock");
    const livePid = process.pid;
    // acquiredAt > STALENESS_FLOOR_MS in the past -> holder-dead
    writeFileSync(lockPath, JSON.stringify({ pid: livePid, token: "x", acquiredAt: Date.now() - 10_000 }));
    const origKill = process.kill;
    (process as any).kill = (p: number, sig: number | string) => {
      if (sig === 0) { const e: any = new Error("no perm"); e.code = "EPERM"; throw e; }
      return origKill.call(process, p, sig);
    };
    try {
      expect(__testing.inspectExistingLock(lockPath).state).toBe("holder-dead");
    } finally {
      (process as any).kill = origKill;
    }

    // Same uid/pid but recent acquiredAt -> holder-grace (break delayed).
    writeFileSync(lockPath, JSON.stringify({ pid: livePid, token: "x", acquiredAt: Date.now() - 1_000 }));
    (process as any).kill = (p: number, sig: number | string) => {
      if (sig === 0) { const e: any = new Error("no perm"); e.code = "EPERM"; throw e; }
      return origKill.call(process, p, sig);
    };
    try {
      expect(__testing.inspectExistingLock(lockPath).state).toBe("holder-grace");
    } finally {
      (process as any).kill = origKill;
    }
  });

  // Test 26 -- U -- clock skew tolerance
  it("#26 acquiredAt in the future -> holder-grace, not holder-dead", () => {
    const lockPath = join(tDir, "sidecar.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "x", acquiredAt: Date.now() + 60_000 }));
    expect(__testing.inspectExistingLock(lockPath).state).toBe("holder-grace");
  });

  // Test 27 -- U -- observability gated by env var
  it("#27 livenessLog writes 'liveness:' prefix only when CLAUDESTORY_LIVENESS_DEBUG=1", () => {
    const origEnv = process.env.CLAUDESTORY_LIVENESS_DEBUG;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as any);
    const linkSpy = vi.spyOn(__testing.fsApi, "linkSync").mockImplementation(() => {
      const e: any = new Error(); e.code = "EPERM"; throw e;
    });
    try {
      delete process.env.CLAUDESTORY_LIVENESS_DEBUG;
      spawnAliveSidecar(tDir, 500);
      expect(writes.some((w) => w.startsWith("liveness:"))).toBe(false);

      writes.length = 0;
      process.env.CLAUDESTORY_LIVENESS_DEBUG = "1";
      spawnAliveSidecar(tDir, 500);
      expect(writes.some((w) => w.startsWith("liveness:"))).toBe(true);
    } finally {
      if (origEnv === undefined) delete process.env.CLAUDESTORY_LIVENESS_DEBUG;
      else process.env.CLAUDESTORY_LIVENESS_DEBUG = origEnv;
      spy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  // Test 28 -- U -- safeUnlinkLock rejects inode mismatch at fd-fstat step
  // Covers the primary inode guard: when a concurrent holder has swapped the
  // file (unlink + recreate) before we opened our fd, fstat sees the new
  // inode and rejects the break. The later lstat-before-unlink check is a
  // defence-in-depth for swaps happening AFTER fstat -- hard to exercise
  // deterministically without monkey-patching fs.lstatSync -- so it is not
  // covered here.
  it("#28 safeUnlinkLock refuses to unlink when expected inode does not match fd inode", () => {
    const lockPath = join(tDir, "sidecar.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "t1", acquiredAt: Date.now() }));
    const originalIno = statSync(lockPath).ino;

    // Simulate a concurrent holder swapping the file: unlink and recreate.
    // The new file will have a different inode on the same path.
    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "t1", acquiredAt: Date.now() }));
    const newIno = statSync(lockPath).ino;
    expect(newIno).not.toBe(originalIno);

    // Caller passes the ORIGINAL inode it observed during inspect. safeUnlinkLock
    // must refuse because the on-disk inode now differs.
    const result = __testing.safeUnlinkLock(lockPath, originalIno, "t1");
    expect(result.unlinked).toBe(false);
    if (!result.unlinked) expect(result.reason).toBe("raced");
    expect(existsSync(lockPath)).toBe(true);
  });

  // Test 29 -- U -- escalate lost-signature path (PID-reuse TOCTOU guard)
  it("#29 escalate returns 'lost-signature' and does NOT signal when hasSig returns false", () => {
    // Inject a hasSig callback that returns false so escalate must abort
    // before process.kill runs. Use a sentinel PID guaranteed not to belong
    // to this runner so a regression cannot SIGTERM the test process.
    const SENTINEL_PID = 999999;
    const killSpy = vi.spyOn(process, "kill");
    const calls: number[] = [];
    const fakeHasSig = (p: number): boolean => {
      calls.push(p);
      return false;
    };
    try {
      const result = __testing.escalate(SENTINEL_PID, "SIGTERM", fakeHasSig);
      expect(result).toBe("lost-signature");
      expect(calls).toEqual([SENTINEL_PID]);
      // The guard must prevent any kill invocation on the target pid.
      expect(killSpy).not.toHaveBeenCalledWith(SENTINEL_PID, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });
});
