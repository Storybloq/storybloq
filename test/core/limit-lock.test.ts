import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, statSync, existsSync, utimesSync, symlinkSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";

// The node:fs namespace is not spy-able under ESM, so intercept writeSync/readSync
// via hoisted control flags. Each delegates to the real call unless a test opts in
// to a one-shot SHORT write (to exercise renewLimitLock's completion loop) or a
// one-shot SHORT read (to exercise readLockBody's completion loop).
const writeCtl = vi.hoisted(() => ({
  shortWriteOnce: false,
  shortReadOnce: false,
  calls: 0,
  reads: 0,
  // Fire-once hooks to inject a concurrent renewal/steal INSIDE a single fs op,
  // making the renew/steal interleaving race deterministic.
  onWriteOnce: null as null | (() => void),
  onReadOnce: null as null | (() => void),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, position?: number) => {
    writeCtl.calls += 1;
    if (writeCtl.onWriteOnce) {
      const cb = writeCtl.onWriteOnce;
      writeCtl.onWriteOnce = null;
      cb();
    }
    if (writeCtl.shortWriteOnce && typeof length === "number" && length > 1) {
      writeCtl.shortWriteOnce = false;
      return actual.writeSync(fd, buffer, offset, 1, position); // one byte, forcing the loop
    }
    return actual.writeSync(fd, buffer as never, offset as never, length as never, position as never);
  }) as typeof actual.writeSync;
  const readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset?: number, length?: number, position?: number) => {
    writeCtl.reads += 1;
    if (writeCtl.onReadOnce) {
      const cb = writeCtl.onReadOnce;
      writeCtl.onReadOnce = null;
      cb();
    }
    if (writeCtl.shortReadOnce && typeof length === "number" && length > 1) {
      writeCtl.shortReadOnce = false;
      return actual.readSync(fd, buffer, offset, 1, position); // one byte, forcing the loop
    }
    return actual.readSync(fd, buffer as never, offset as never, length as never, position as never);
  }) as typeof actual.readSync;
  return { ...actual, default: { ...actual, writeSync, readSync }, writeSync, readSync };
});
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLimitLock,
  releaseLimitLock,
  verifyLockOwnership,
  renewLimitLock,
  withLimitLock,
  LimitLockError,
} from "../../src/core/limit-lock.js";
import { safeUnlinkLock } from "../../src/autonomous/liveness.js";

/** A pid that is certainly dead: a child that already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  return r.pid!;
}

// captureProcessSignatureSync returns a signature only on Darwin/Linux; elsewhere
// it is null and identity is "unknown" (lease-governed). Baseline assertions must
// branch on this so the suite passes on every platform.
const SIG_SUPPORTED = process.platform === "darwin" || process.platform === "linux";

describe("limit-lock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-limit-lock-"));
    lockPath = join(dir, "test.lock");
    writeCtl.shortWriteOnce = false;
    writeCtl.shortReadOnce = false;
    writeCtl.onWriteOnce = null;
    writeCtl.onReadOnce = null;
  });

  afterEach(() => {
    writeCtl.onWriteOnce = null;
    writeCtl.onReadOnce = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires and releases", () => {
    const handle = acquireLimitLock(lockPath);
    expect(handle).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    const body = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(body.pid).toBe(process.pid);
    if (SIG_SUPPORTED) expect(body.processSignature).toBeTruthy();
    else expect(body.processSignature).toBeNull();
    releaseLimitLock(handle!);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not steal from a verified-alive holder", () => {
    const first = acquireLimitLock(lockPath);
    expect(first).not.toBeNull();
    const second = acquireLimitLock(lockPath, { deadlineMs: 200, pollMs: 20 });
    expect(second).toBeNull();
    releaseLimitLock(first!);
  });

  it("steals from a dead holder immediately", () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid(), token: "t0", acquiredAt: Date.now(), renewedAt: Date.now(), processSignature: null }),
      { mode: 0o600 },
    );
    const handle = acquireLimitLock(lockPath, { deadlineMs: 500 });
    expect(handle).not.toBeNull();
    releaseLimitLock(handle!);
  });

  it("steals on PID reuse (live pid, mismatched signature)", () => {
    // A mismatched signature only proves PID reuse where signatures exist. On
    // platforms without them, identity is "unknown" and the lease governs, so
    // a freshly-renewed lock is NOT stolen inside the deadline.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: "t0",
        acquiredAt: Date.now(),
        renewedAt: Date.now(),
        processSignature: "darwin:not-our-signature",
      }),
      { mode: 0o600 },
    );
    const handle = acquireLimitLock(lockPath, { deadlineMs: 500 });
    if (SIG_SUPPORTED) {
      expect(handle).not.toBeNull(); // mismatch => confirmed PID reuse => steal
      releaseLimitLock(handle!);
    } else {
      expect(handle).toBeNull(); // unknown identity + live lease => no steal
    }
  });

  it("honors the lease for an unknown-identity holder", () => {
    // pid alive (ours) but no recorded signature -> identity unknown.
    const fresh = { pid: process.pid, token: "t0", acquiredAt: Date.now(), renewedAt: Date.now(), processSignature: null };
    writeFileSync(lockPath, JSON.stringify(fresh), { mode: 0o600 });
    expect(acquireLimitLock(lockPath, { deadlineMs: 200, leaseMs: 10_000 })).toBeNull();

    const stale = { ...fresh, acquiredAt: Date.now() - 60_000, renewedAt: Date.now() - 60_000 };
    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify(stale), { mode: 0o600 });
    const handle = acquireLimitLock(lockPath, { deadlineMs: 500, leaseMs: 10_000 });
    expect(handle).not.toBeNull();
    releaseLimitLock(handle!);
  });

  it("treats a far-future lease timestamp as bogus and steals", () => {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        token: "t0",
        acquiredAt: Date.now() + 3_600_000,
        renewedAt: Date.now() + 3_600_000,
        processSignature: null,
      }),
      { mode: 0o600 },
    );
    const handle = acquireLimitLock(lockPath, { deadlineMs: 500 });
    expect(handle).not.toBeNull();
    releaseLimitLock(handle!);
  });

  it("waits out a fresh unreadable body, breaks an old one", () => {
    writeFileSync(lockPath, "not json", { mode: 0o600 });
    expect(acquireLimitLock(lockPath, { deadlineMs: 200 })).toBeNull();
    // Same corrupt body, but old mtime.
    const past = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath, past, past);
    const handle = acquireLimitLock(lockPath, { deadlineMs: 500 });
    expect(handle).not.toBeNull();
    releaseLimitLock(handle!);
  });

  it("fencing: ownership verification fails after the lock is stolen", () => {
    const handle = acquireLimitLock(lockPath);
    expect(verifyLockOwnership(handle!)).toBe(true);
    // Simulate a steal: replace the lock file with a new holder's body.
    unlinkSync(lockPath);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "other", acquiredAt: Date.now(), renewedAt: Date.now(), processSignature: null }),
      { mode: 0o600 },
    );
    expect(verifyLockOwnership(handle!)).toBe(false);
    // Release must NOT unlink the successor's lock.
    releaseLimitLock(handle!);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("renews the lease on a FRESH inode (rename), advancing renewedAt and updating the handle", () => {
    // Renewal publishes a new inode so a contender that inspected the old inode
    // fails its final inode fence. The body content (token) carries over; the
    // handle's inode tracks the freshly published file.
    const handle = acquireLimitLock(lockPath)!;
    const inoBefore = statSync(lockPath).ino;
    const bodyBefore = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(renewLimitLock(handle)).toBe(true);
    const after = JSON.parse(readFileSync(lockPath, "utf-8"));
    const inoAfter = statSync(lockPath).ino;
    expect(inoAfter).not.toBe(inoBefore); // inode swapped by the rename
    expect(handle.inode).toBe(inoAfter); // handle tracks the new inode
    expect(after.renewedAt).toBeGreaterThanOrEqual(bodyBefore.renewedAt);
    expect(after.token).toBe(bodyBefore.token);
    releaseLimitLock(handle);
  });

  it("refuses to renew a lost lock", () => {
    const handle = acquireLimitLock(lockPath);
    unlinkSync(lockPath);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "other", acquiredAt: Date.now(), renewedAt: Date.now(), processSignature: null }),
      { mode: 0o600 },
    );
    expect(renewLimitLock(handle!)).toBe(false);
    releaseLimitLock(handle!);
  });

  // ---- singleton renew/steal race (both sides fenced) ----

  it("safeUnlinkLock's renewedAt fence ABORTS a steal when the body was rewritten in place with a newer renewedAt", () => {
    // Defense in depth for the body-content fence: production renewal now swaps
    // the inode (covered by the fresh-inode tests below), but safeUnlinkLock also
    // fences on renewedAt so that even a same-inode body rewrite between a
    // contender's inspect and its unlink is caught. Isolate that fence here by
    // rewriting the body in place (O_TRUNC keeps the inode) with a newer renewedAt.
    const handle = acquireLimitLock(lockPath)!;
    const ino = statSync(lockPath).ino;
    const tOld = JSON.parse(readFileSync(lockPath, "utf-8")).renewedAt;
    const tNow = tOld + 5_000;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: handle.token, acquiredAt: tOld, renewedAt: tNow, processSignature: null }),
      { mode: 0o600 },
    );
    expect(statSync(lockPath).ino).toBe(ino); // same inode, only the body changed

    // Stale steal decision (carries the OLD renewedAt) must abort, NOT unlink.
    const r = safeUnlinkLock(lockPath, ino, handle.token, tOld);
    expect(r).toEqual({ unlinked: false, reason: "raced" });
    expect(existsSync(lockPath)).toBe(true);

    // A matching renewedAt (no intervening rewrite) still unlinks normally.
    const r2 = safeUnlinkLock(lockPath, ino, handle.token, tNow);
    expect(r2).toEqual({ unlinked: true });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a stealable lock RENEWED on a FRESH inode between inspect and unlink is NOT acquired by the contender", () => {
    // Round-11 end-to-end guard. Plant a stealable holder (unknown identity +
    // expired lease) with a REAL handle. As the contender's inspectHolder READS
    // the old body, the holder runs the real renewLimitLock, which publishes a
    // FRESH inode. The contender's safeUnlinkLock then does its final lstat, sees
    // the new inode (!= the one it inspected), and backs off (reason "raced"); it
    // re-inspects, now sees a fresh lease, polls, and fails to acquire.
    const handle = acquireLimitLock(lockPath)!;
    const tOld = Date.now() - 10 * 60_000; // well past the default lease
    // Downgrade IN PLACE (O_TRUNC keeps the inode, so handle.inode stays valid)
    // to a stealable posture: unknown identity + expired lease, same token.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: handle.token, acquiredAt: tOld, renewedAt: tOld, processSignature: null }),
      { mode: 0o600 },
    );

    // The FIRST body read during this acquire (inspectHolder's readLockBody)
    // triggers the REAL renewal, which writes a temp file and renames it over the
    // path -> a fresh inode. The contender's inspect fd still reads the old inode.
    let renewed = false;
    writeCtl.onReadOnce = () => {
      renewed = renewLimitLock(handle);
    };

    const contender = acquireLimitLock(lockPath, { deadlineMs: 250, pollMs: 20 });
    expect(renewed).toBe(true); // renewal completed on a fresh inode
    expect(contender).toBeNull(); // never stole the freshly-renewed lock
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).ino).toBe(handle.inode); // the renewed (new) inode
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe(handle.token);
    releaseLimitLock(handle);
  });

  it("renewLimitLock STEPS DOWN (returns false) when a contender steals the path mid-renew", () => {
    // Renewal writes its new body to a temp file, then re-verifies ownership
    // (path inode == the inode it read) before the atomic rename. If a contender
    // swaps the path to a new inode during the temp write, the pre-rename
    // re-verify detects it, the temp file is cleaned up, and renewal returns
    // false -- so the ex-holder never clobbers the successor (singleton guarantee).
    const handle = acquireLimitLock(lockPath)!;
    const originalIno = statSync(lockPath).ino;

    // As the holder writes its renewal (to the temp file), a contender swaps the
    // path to a NEW inode.
    writeCtl.onWriteOnce = () => {
      unlinkSync(lockPath);
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, token: "successor", acquiredAt: Date.now(), renewedAt: Date.now(), processSignature: null }),
        { mode: 0o600 },
      );
    };

    expect(renewLimitLock(handle)).toBe(false); // detected the steal, stood down
    // The successor's lock is intact and was never clobbered by the ex-holder.
    expect(statSync(lockPath).ino).not.toBe(originalIno);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("successor");
  });

  it("NEVER blind-unlinks a holder it cannot fence by inode (null-inode steal fix)", () => {
    // Reproduces the null-fence steal: inspectHolder cannot read an inode (here a
    // symlink -> ELOOP under O_NOFOLLOW) AND the mtime break window has elapsed.
    // Pre-fix this returned state:"steal" with a null inode, so
    // safeUnlinkLock(path, null, null, null) skipped every fence and
    // unconditionally unlinked whatever was at the path -- letting a contender
    // evict a live lock (dual ownership). The fix POLLS whenever there is no
    // inode to fence, so the path is never broken and the contender fails.
    const target = join(dir, "target");
    writeFileSync(target, "x");
    const oldSecs = Date.now() / 1000 - 120; // 2 min old -> past UNREADABLE_BREAK_MS
    utimesSync(target, oldSecs, oldSecs);
    symlinkSync(target, lockPath); // lockPath -> symlink; O_NOFOLLOW open = ELOOP
    const contender = acquireLimitLock(lockPath, { deadlineMs: 150, pollMs: 20 });
    expect(contender).toBeNull(); // never stole
    expect(existsSync(lockPath)).toBe(true);
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true); // symlink intact, not unlinked
  });

  it("withLimitLock runs the fn and always releases", () => {
    const out = withLimitLock(lockPath, () => 42);
    expect(out).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
    expect(() =>
      withLimitLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("withLimitLock throws LimitLockError when held elsewhere", () => {
    const handle = acquireLimitLock(lockPath);
    expect(() => withLimitLock(lockPath, () => 1, { deadlineMs: 150 })).toThrow(LimitLockError);
    releaseLimitLock(handle!);
  });

  it("renewLimitLock completes a short (partial) writeSync, leaving a valid body", () => {
    // fs.writeSync may return fewer bytes than requested. The renew loop must
    // issue the remainder; a single unchecked write would truncate the live
    // lock body into invalid JSON that every subsequent reader rejects.
    const handle = acquireLimitLock(lockPath);
    expect(handle).not.toBeNull();
    const callsBefore = writeCtl.calls;
    writeCtl.shortWriteOnce = true;
    try {
      expect(renewLimitLock(handle!)).toBe(true);
      // The loop issued more than one writeSync (the short one + the remainder).
      expect(writeCtl.calls - callsBefore).toBeGreaterThan(1);
    } finally {
      writeCtl.shortWriteOnce = false;
    }
    const body = JSON.parse(readFileSync(lockPath, "utf-8")); // valid, not truncated
    expect(body.token).toBe(handle!.token);
    expect(body.pid).toBe(process.pid);
    releaseLimitLock(handle!);
  });

  it("verifyLockOwnership tolerates a short (partial) readSync, reading the whole body", () => {
    // fs.readSync may return fewer bytes than requested. A single unchecked read
    // would leave the buffer tail zero-filled and JSON.parse would throw on the
    // trailing NULs -- making a live, valid lock look corrupt (misclassified,
    // then stolen). The read loop must fetch the remainder.
    const handle = acquireLimitLock(lockPath);
    expect(handle).not.toBeNull();
    const readsBefore = writeCtl.reads;
    writeCtl.shortReadOnce = true;
    try {
      expect(verifyLockOwnership(handle!)).toBe(true); // parsed correctly despite the short read
      expect(writeCtl.reads - readsBefore).toBeGreaterThan(1); // the short read + the remainder
    } finally {
      writeCtl.shortReadOnce = false;
    }
    releaseLimitLock(handle!);
  });

  it("does not steal a fresh unsupported-platform holder (unknown identity, lease honored)", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, token: "t0", acquiredAt: Date.now(), renewedAt: Date.now(), processSignature: null }),
        { mode: 0o600 },
      );
      // Fresh + unknown identity -> lease holds, no steal.
      expect(acquireLimitLock(lockPath, { deadlineMs: 200, leaseMs: 10_000 })).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});
