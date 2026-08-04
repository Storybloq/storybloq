import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { readFile, writeFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// inspectProcessIdentitySync is spied on (not mocked away) to prove the
// module-level identity cache actually avoids redundant calls, while every
// other limit-lock export stays real.
const identitySpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/core/limit-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/limit-lock.js")>();
  const inspectProcessIdentitySync = ((pid: number, sig: string | null) => {
    identitySpy.calls += 1;
    return actual.inspectProcessIdentitySync(pid, sig);
  }) as typeof actual.inspectProcessIdentitySync;
  return { ...actual, inspectProcessIdentitySync };
});

// ISS-942 942.1: a controllable one-shot override on verifyProjectLockOwnership
// (checkProjectLockFencing's ONLY dependency in project-loader.ts) so tests can
// drive REAL, lock-acquiring call sites (writeTicket, deleteTicket, team-mode
// handover creation) through a genuine ownership-loss failure without racing a
// real steal and without the reentrant-acquisition deadlock that tampering the
// on-disk lock file from an OUTER withProjectLock would cause for a call site
// that acquires its own lock. Defaults to delegating to the real
// implementation, so every other test (including direct
// verifyProjectLockOwnership calls elsewhere in this file) is unaffected.
const fencingOverride = vi.hoisted(() => ({ failNextN: 0 }));
vi.mock("../../src/core/project-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-lock.js")>();
  const verifyProjectLockOwnership = ((handle: unknown) => {
    if (fencingOverride.failNextN > 0) {
      fencingOverride.failNextN -= 1;
      return false;
    }
    return actual.verifyProjectLockOwnership(handle as Parameters<typeof actual.verifyProjectLockOwnership>[0]);
  }) as typeof actual.verifyProjectLockOwnership;
  return { ...actual, verifyProjectLockOwnership };
});

// ISS-942 942.1: a one-shot, path-targeted override letting a single test
// force `stat` to fail with a specific error code, proving loadProject's
// .txn.json presence probe (R3) fails closed on a non-ENOENT stat error.
// Path-targeted (matched by suffix) rather than a bare next-call flag,
// because loadProject's own step 1 (`stat(wrapDir)`) runs first -- an
// untargeted override would misfire there instead of the intended probe.
// Not filesystem-permission-based (e.g. chmod) because permission checks are
// bypassed when the test process runs as root (common in CI containers),
// which would make that technique silently no-op rather than fail loudly.
const statOverride = vi.hoisted(() => ({ failPathSuffix: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = (async (path: unknown, opts?: unknown) => {
    if (statOverride.failPathSuffix && typeof path === "string" && path.endsWith(statOverride.failPathSuffix)) {
      statOverride.failPathSuffix = null;
      const err = new Error("ISS-942 942.1 simulated EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    return (actual.stat as (...a: unknown[]) => Promise<unknown>)(path, opts);
  }) as typeof actual.stat;
  return { ...actual, stat };
});

import {
  acquireProjectLockAsync,
  releaseProjectLock,
  verifyProjectLockOwnership,
  __projectLockTestHooks,
  type ProjectLockHandle,
} from "../../src/core/project-lock.js";
import {
  loadProject,
  writeTicket,
  writeTicketUnlocked,
  deleteTicket,
  runTransactionUnlocked,
  withProjectLock,
  fencedUnlink,
  fencedLink,
  atomicWrite,
  atomicCreate,
} from "../../src/core/project-loader.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { handleHandoverCreate } from "../../src/cli/commands/handover.js";

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  return r.pid!;
}

const SIG_SUPPORTED = process.platform === "darwin" || process.platform === "linux";

function writeLockBody(lockPath: string, body: Record<string, unknown>): void {
  writeFileSync(lockPath, JSON.stringify(body), { mode: 0o600 });
}

// --- low-level fixture project (mirrors project-loader.test.ts's shape) ---

const minimalConfig = {
  version: 2,
  project: "test",
  type: "npm",
  language: "typescript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
};

const minimalRoadmap = {
  title: "test",
  date: "2026-01-01",
  phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Desc." }],
  blockers: [],
};

function ticket(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Ticket ${id}`,
    description: "A test.",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    ...overrides,
  };
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "storybloq-plk-"));
  const wrapDir = join(root, ".story");
  await mkdir(join(wrapDir, "tickets"), { recursive: true });
  await mkdir(join(wrapDir, "issues"), { recursive: true });
  await writeFile(join(wrapDir, "config.json"), JSON.stringify(minimalConfig, null, 2));
  await writeFile(join(wrapDir, "roadmap.json"), JSON.stringify(minimalRoadmap, null, 2));
  return root;
}

describe("project-lock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-project-lock-"));
    lockPath = join(dir, ".lock");
    identitySpy.calls = 0;
    __projectLockTestHooks.duringSteal = null;
    __projectLockTestHooks.beforeStealUnlink = null;
    __projectLockTestHooks.beforeStealLink = null;
  });

  afterEach(() => {
    __projectLockTestHooks.duringSteal = null;
    __projectLockTestHooks.beforeStealUnlink = null;
    __projectLockTestHooks.beforeStealLink = null;
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- basic acquire/release/fence ----

  it("acquires and releases a fresh lock", async () => {
    const handle = await acquireProjectLockAsync(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    const body = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(body.pid).toBe(process.pid);
    if (SIG_SUPPORTED) expect(body.processSignature).toBeTruthy();
    else expect(body.processSignature).toBeNull();
    expect(verifyProjectLockOwnership(handle)).toBe(true);
    releaseProjectLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not steal from a verified-alive holder (never-steal-unknown/alive)", async () => {
    const first = await acquireProjectLockAsync(lockPath);
    await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(ProjectLoaderError);
    releaseProjectLock(first);
  });

  it("release does not clobber a successor's fresh lock (fencing)", async () => {
    const handle = await acquireProjectLockAsync(lockPath);
    // Simulate a steal: replace the lock body wholesale (new inode, new token).
    unlinkSync(lockPath);
    writeLockBody(lockPath, { pid: process.pid, token: "other", acquiredAt: Date.now(), processSignature: null });
    expect(verifyProjectLockOwnership(handle)).toBe(false);
    releaseProjectLock(handle);
    expect(existsSync(lockPath)).toBe(true); // successor's lock survives
  });

  // ---- SIGKILL reclaim (acceptance 4) ----

  it("steals from a dead holder immediately (SIGKILL reclaim regression)", async () => {
    writeLockBody(lockPath, { pid: deadPid(), token: "t0", acquiredAt: Date.now(), processSignature: null });
    const handle = await acquireProjectLockAsync(lockPath, { deadlineMs: 1000, pollMs: 20 });
    expect(handle).toBeTruthy();
    expect(verifyProjectLockOwnership(handle)).toBe(true);
    releaseProjectLock(handle);
  });

  // ---- never steals identity-unknown, regardless of elapsed time ----

  it("never steals identity-unknown, even long past any old lease window", async () => {
    // pid alive (ours) but no recorded signature -> identity "unknown".
    const old = Date.now() - 10 * 60_000;
    writeLockBody(lockPath, { pid: process.pid, token: "t0", acquiredAt: old, processSignature: null });
    await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out acquiring project lock/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("PID reuse (live but different pid, mismatched signature) is treated as dead and stolen -- platform gated", async () => {
    // Uses a REAL, non-self pid deliberately: this test targets the general
    // (non-self) pid-reuse path. The self-pid-specific variant (our own
    // current pid reused for a stale record with a mismatched signature) is
    // covered separately below.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    try {
      writeLockBody(lockPath, { pid: child.pid!, token: "pidreuse0", acquiredAt: Date.now(), processSignature: "darwin:not-our-signature" });
      if (SIG_SUPPORTED) {
        const handle = await acquireProjectLockAsync(lockPath, { deadlineMs: 1000, pollMs: 20 });
        expect(handle).toBeTruthy();
        releaseProjectLock(handle);
      } else {
        // No signature source: mismatch can't be proven, so identity is "unknown" -> never stolen.
        await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(ProjectLoaderError);
      }
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("self-pid record with a mismatched signature (our pid reused from a stale holder) is reclaimed, not treated as always-alive -- platform gated", async () => {
    // Directly proves the code-review fix: classifyIdentityCached's self-pid
    // shortcut must still compare signatures rather than unconditionally
    // returning "alive", or a lock stamped with our own current pid -- but
    // belonging to a since-dead prior process the OS happened to reuse our
    // pid from -- would be permanently unreclaimable.
    if (!SIG_SUPPORTED) return;
    writeLockBody(lockPath, {
      pid: process.pid,
      token: "self-pid-stale",
      acquiredAt: Date.now(),
      processSignature: "darwin:definitely-not-our-real-signature",
    });
    const handle = await acquireProjectLockAsync(lockPath, { deadlineMs: 1000, pollMs: 20 });
    expect(handle).toBeTruthy();
    releaseProjectLock(handle);
  });

  // ---- SIGSTOP/SIGCONT (acceptance 2) ----

  it("SIGSTOP'd live holder (verified-alive via a real matching signature) is never stolen; SIGCONT + release lets a contender through", async () => {
    const { spawn } = await import("node:child_process");
    const { captureProcessSignatureSync } = await import("../../src/core/limit-lock.js");
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const pid = child.pid!;
    try {
      // A real captured signature (not null) is what actually exercises the
      // "alive" classification (matching signature), rather than merely
      // duplicating the never-steal-"unknown" test with a null signature.
      const realSignature = SIG_SUPPORTED ? captureProcessSignatureSync(pid) : null;
      if (SIG_SUPPORTED) expect(realSignature).toBeTruthy(); // sanity: capture actually worked
      writeLockBody(lockPath, { pid, token: "holder", acquiredAt: Date.now(), processSignature: realSignature });
      if (SIG_SUPPORTED) {
        process.kill(pid, "SIGSTOP");
        try {
          await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 250, pollMs: 20 })).rejects.toThrow(ProjectLoaderError);
        } finally {
          process.kill(pid, "SIGCONT");
        }
      }
      // Holder releases voluntarily; a fresh acquire then succeeds.
      unlinkSync(lockPath);
      const handle = await acquireProjectLockAsync(lockPath, { deadlineMs: 500, pollMs: 20 });
      expect(handle).toBeTruthy();
      releaseProjectLock(handle);
    } finally {
      child.kill("SIGTERM");
    }
  });

  // ---- legacy directory lock: poll-then-throw, self-clearing ----

  it("legacy directory lock polls like ordinary contention, throws only after the deadline, never auto-removes", async () => {
    mkdirSync(lockPath); // proper-lockfile's directory format, no body
    const start = Date.now();
    await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/legacy-format lock/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150); // genuinely polled, not immediate
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).isDirectory()).toBe(true); // untouched
  });

  it("legacy directory lock removed mid-poll (simulated old-version release) lets the pending acquire succeed", async () => {
    mkdirSync(lockPath);
    const acquire = acquireProjectLockAsync(lockPath, { deadlineMs: 2000, pollMs: 20 });
    setTimeout(() => {
      rmSync(lockPath, { recursive: true, force: true }); // simulated old-version holder releasing
    }, 60);
    const handle = await acquire;
    expect(handle).toBeTruthy();
    expect(statSync(lockPath).isFile()).toBe(true);
    releaseProjectLock(handle);
  });

  // ---- steal-lock: single-winner serialization (acceptance 1) ----

  it("single-winner (in-process seam test): N concurrent stealers over one dead lock, steal-lock mutex admits one at a time", async () => {
    // Same-process bound: consecutive synchronous fs calls with no `await`
    // between them (e.g. attemptSteal's unlinkSync then linkSync) execute
    // atomically with respect to other same-process work, so this cannot
    // exercise the syscall-level interleaving a genuine cross-process race
    // could. What it DOES prove: the steal-lock mkdir mutex admits only one
    // concurrent async caller into the critical section at a time, and every
    // caller that returns a handle is immediately verifiable against the
    // then-current on-disk state. See the real spawned-OS-process test below
    // for the genuine cross-process proof.
    const N = 8;
    const results: Array<ProjectLockHandle | null> = [];
    const errors: unknown[] = [];
    writeLockBody(lockPath, { pid: deadPid(), token: "dead0", acquiredAt: Date.now(), processSignature: null });
    await Promise.all(
      Array.from({ length: N }, () =>
        acquireProjectLockAsync(lockPath, { deadlineMs: 3000, pollMs: 5 })
          .then((h) => results.push(h))
          .catch((e) => errors.push(e)),
      ),
    );
    // At most one true winner is verifiable against the CURRENT lock body at any time;
    // every non-throwing acquirer must, at the moment it returned, have actually held it.
    const verified = results.filter((h): h is ProjectLockHandle => h !== null);
    expect(verified.length).toBeGreaterThanOrEqual(1);
    // Verify final on-disk state matches exactly one of the returned handles' tokens.
    const finalBody = JSON.parse(readFileSync(lockPath, "utf-8"));
    const matchingFinal = verified.filter((h) => h.token === finalBody.token);
    expect(matchingFinal.length).toBe(1);
    for (const h of verified) releaseProjectLock(h);
  });

  it(
    "single-winner (real cross-process race): N genuinely separate OS processes over one dead lock, no double-grant ever observed",
    async () => {
      const { spawn } = await import("node:child_process");
      const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx");
      const workerPath = join(process.cwd(), "test", "core", "fixtures", "project-lock-race-worker.ts");
      const barrierPath = join(dir, "barrier");
      writeLockBody(lockPath, { pid: deadPid(), token: "dead0", acquiredAt: Date.now(), processSignature: null });

      const N = 4;
      // The eventual winner holds for HOLD_MS, well past every contender's own
      // acquisition DEADLINE_MS -- so whichever worker wins, every other
      // worker is still polling (and provably fails, never sneaking in during
      // a release) for the winner's ENTIRE hold. This is what makes
      // acquired.length === 1 a real single-winner proof rather than an
      // artifact of workers happening to run one after another.
      const HOLD_MS = 3000;
      const DEADLINE_MS = 1200;
      const resultPaths: string[] = [];
      const readyPaths: string[] = [];
      const exits: Promise<void>[] = [];
      for (let i = 0; i < N; i++) {
        const resultPath = join(dir, `result-${i}.json`);
        const readyPath = join(dir, `ready-${i}`);
        resultPaths.push(resultPath);
        readyPaths.push(readyPath);
        const child = spawn(
          tsxBin,
          [workerPath, lockPath, barrierPath, resultPath, readyPath, String(HOLD_MS), String(DEADLINE_MS)],
          { stdio: "ignore" },
        );
        exits.push(new Promise<void>((resolve) => child.once("exit", () => resolve())));
      }
      // Wait for every worker's own readiness signal (written before it enters
      // its barrier wait loop) rather than a fixed sleep -- a fixed delay
      // cannot guarantee a slow-to-cold-start worker is actually watching the
      // barrier yet, which would silently weaken contention under load.
      const readyDeadline = Date.now() + 10_000;
      while (!readyPaths.every((p) => existsSync(p))) {
        if (Date.now() > readyDeadline) throw new Error("workers did not all signal ready in time");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      writeFileSync(barrierPath, "go");
      await Promise.all(exits);

      const results = resultPaths.map((p) => JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>);
      const acquired = results.filter((r) => r.outcome === "acquired");
      const failed = results.filter((r) => r.outcome === "failed");
      // Exactly one real OS process ever held the lock across the whole race
      // window; every other genuinely-contending process must have failed
      // (timed out against a still-held lock), never quietly succeeded later.
      expect(acquired.length).toBe(1);
      expect(failed.length).toBe(N - 1);
      // The direct double-grant probe: the winner's own immediate on-disk
      // cross-check must have confirmed its handle. `verified: false` would
      // mean two real OS processes both believed they held the lock at once.
      expect(acquired[0].verified).toBe(true);
      expect(existsSync(`${lockPath}-steal`)).toBe(false); // steal-lock always released, across every worker
    },
    20_000,
  );

  it("steal-lock backoff: a fresh ordinary acquirer slipping into the unlink/link gap is never removed", async () => {
    // The "fresh acquirer" must be a REAL, non-self, live pid: our own pid would
    // hit the always-alive self shortcut on the outer loop's next inspect,
    // which conflates "back off from a fresh acquirer" with "never steal from
    // ourselves" and defeats the point of this test.
    const { spawn } = await import("node:child_process");
    const freshHolder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => freshHolder.once("spawn", () => resolve()));
    try {
      writeLockBody(lockPath, { pid: deadPid(), token: "dead0", acquiredAt: Date.now(), processSignature: null });
      let freshToken: string | null = null;
      __projectLockTestHooks.beforeStealLink = () => {
        // A fresh, ordinary acquirer wins the gap between the stealer's unlink and its own link.
        freshToken = "fresh-" + Math.random().toString(16).slice(2);
        writeLockBody(lockPath, { pid: freshHolder.pid!, token: freshToken, acquiredAt: Date.now(), processSignature: null });
      };
      // The fresh holder never releases, so the outer acquire must eventually
      // time out (correctly refusing to steal a live lock) -- but the fresh
      // lock must survive the stealer's unlink+link sequence untouched.
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 300, pollMs: 10 })).rejects.toThrow(ProjectLoaderError);
      const finalBody = JSON.parse(readFileSync(lockPath, "utf-8"));
      expect(finalBody.token).toBe(freshToken);
    } finally {
      freshHolder.kill("SIGTERM");
    }
  });

  it("steal-lock (.story/.lock-steal) releases on every exit branch of the critical section", async () => {
    const stealLockPath = `${lockPath}-steal`;

    // Branch 1: re-verification finds the record gone (voluntarily released).
    writeLockBody(lockPath, { pid: deadPid(), token: "d1", acquiredAt: Date.now(), processSignature: null });
    __projectLockTestHooks.duringSteal = () => {
      unlinkSync(lockPath); // vanished between the advisory read and the steal-lock
    };
    await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 500, pollMs: 10 })).resolves.toBeTruthy();
    expect(existsSync(stealLockPath)).toBe(false);
    // (the acquire above succeeded via an ordinary link once the path was empty;
    // clean up for the next branch)
    rmSync(lockPath, { force: true });

    // Branch 2: an unexpected exception mid-critical-section still releases.
    writeLockBody(lockPath, { pid: deadPid(), token: "d2", acquiredAt: Date.now(), processSignature: null });
    __projectLockTestHooks.duringSteal = () => {
      throw new Error("injected mid-steal failure");
    };
    await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 500, pollMs: 10 })).rejects.toThrow();
    expect(existsSync(stealLockPath)).toBe(false);
    rmSync(lockPath, { force: true });

    // Branch 3: EEXIST on our own link (a fresh acquirer wins the unlink/link gap).
    // Reproduced here directly (not merely inferred from the dedicated backoff
    // test above) so this test proves release on ITS OWN exercise of the branch.
    {
      const { spawn } = await import("node:child_process");
      const freshHolder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      await new Promise<void>((resolve) => freshHolder.once("spawn", () => resolve()));
      try {
        writeLockBody(lockPath, { pid: deadPid(), token: "d3", acquiredAt: Date.now(), processSignature: null });
        __projectLockTestHooks.beforeStealLink = () => {
          writeLockBody(lockPath, { pid: freshHolder.pid!, token: "fresh-branch3", acquiredAt: Date.now(), processSignature: null });
        };
        await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 300, pollMs: 10 })).rejects.toThrow(ProjectLoaderError);
        expect(existsSync(stealLockPath)).toBe(false);
      } finally {
        freshHolder.kill("SIGTERM");
        rmSync(lockPath, { force: true });
      }
    }

    // Branch 4: the happy path (successful steal) -- assert release there too.
    writeLockBody(lockPath, { pid: deadPid(), token: "d4", acquiredAt: Date.now(), processSignature: null });
    const handle = await acquireProjectLockAsync(lockPath, { deadlineMs: 500, pollMs: 10 });
    expect(existsSync(stealLockPath)).toBe(false);
    releaseProjectLock(handle);
  });

  it("stuck (non-reclaimable) steal-lock fails explicit and is never auto-healed", async () => {
    const stealLockPath = `${lockPath}-steal`;
    writeLockBody(lockPath, { pid: deadPid(), token: "dead0", acquiredAt: Date.now(), processSignature: null });
    mkdirSync(stealLockPath); // simulate a crash mid-steal, at any "age" (no identity to check)
    await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/lock-steal/);
    expect(existsSync(stealLockPath)).toBe(true); // never automatically reclaimed
    rmSync(stealLockPath, { recursive: true, force: true });
  });

  // ---- identity cache soundness ----

  it("module-level identity cache is shared across concurrent waiters (not one ps call each)", async () => {
    // Must be a real, non-self, live pid: the self-pid shortcut resolves
    // "alive" without ever calling inspectProcessIdentitySync at all, which
    // would make this test measure nothing.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    try {
      writeLockBody(lockPath, { pid: child.pid!, token: "shared-cache0", acquiredAt: Date.now(), processSignature: null });
      identitySpy.calls = 0;
      const results = await Promise.allSettled([
        acquireProjectLockAsync(lockPath, { deadlineMs: 150, pollMs: 10 }),
        acquireProjectLockAsync(lockPath, { deadlineMs: 150, pollMs: 10 }),
      ]);
      for (const r of results) expect(r.status).toBe("rejected"); // both poll out; identity is "unknown" (no recorded signature)
      // Two concurrent waiters, several poll iterations each -- but the cache
      // should keep the underlying identity-inspection call count far below
      // "once per poll per waiter" (i.e. shared, not duplicated per-waiter).
      expect(identitySpy.calls).toBeGreaterThan(0);
      expect(identitySpy.calls).toBeLessThan(6);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("a fresh acquisition's token is never matched by a stale cache entry from a reused pid", async () => {
    // Must be a real, non-self, live-then-killed pid: the self-pid path never
    // touches the shared identityCache Map at all (it's memoized separately
    // via ownSignature()), so it can't exercise token-vs-pid keying soundness.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const pid = child.pid!;
    try {
      // Prime the cache: token "stale-a" for this (live) pid, classified "unknown" -- never stolen.
      writeLockBody(lockPath, { pid, token: "stale-a", acquiredAt: Date.now(), processSignature: null });
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 150, pollMs: 20 })).rejects.toThrow(ProjectLoaderError);

      // The SAME pid now genuinely dies, and a fresh record uses a NEW token.
      // If the cache were keyed by pid (unsound under pid reuse) instead of
      // token, it would replay the stale "unknown" verdict cached above and
      // refuse to steal even though this pid is now provably dead.
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      writeLockBody(lockPath, { pid, token: "fresh-b", acquiredAt: Date.now(), processSignature: null });
      const handle = await acquireProjectLockAsync(lockPath, { deadlineMs: 1000, pollMs: 20 });
      expect(handle).toBeTruthy();
      releaseProjectLock(handle);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

describe("project-lock integration (project-loader.ts wiring)", () => {
  let testRoot: string;

  beforeEach(() => {
    fencingOverride.failNextN = 0;
    statOverride.failPathSuffix = null;
  });

  afterEach(async () => {
    // A leftover armed override would silently mask which fencing/stat check
    // a later test actually exercised (or let it pass for the wrong reason).
    expect(fencingOverride.failNextN).toBe(0);
    expect(statOverride.failPathSuffix).toBe(null);
    fencingOverride.failNextN = 0;
    statOverride.failPathSuffix = null;
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  });

  it("AsyncLocalStorage isolation: two concurrent withProjectLock calls on different roots each see only their own handle (forced ownership loss on A does not leak into B)", async () => {
    const rootA = await createProject();
    const rootB = await createProject();
    try {
      // ISS-942 942.1: the previous version of this test only asserted both
      // roots' writes succeed, which also passes under a module-global or
      // cross-wired handle store (a regression this test exists to catch).
      // Force root A's OWN ambient handle to lose ownership -- tamper ONLY
      // root A's on-disk lock file, concurrently with root B's untouched,
      // healthy write. If the ALS store were global rather than isolated per
      // async context, A's tampering would leak into B's concurrent write
      // (or vice versa); real per-context isolation confines the failure to A.
      const [aResult, bResult] = await Promise.allSettled([
        withProjectLock(rootA, { strict: false }, async () => {
          const lockPathA = join(rootA, ".story", ".lock");
          const bodyA = JSON.parse(await readFile(lockPathA, "utf-8"));
          await rm(lockPathA);
          await writeFile(lockPathA, JSON.stringify({ ...bodyA, token: "stolen-by-test-root-a" }));
          await writeTicketUnlocked(ticket("T-001"), rootA);
        }),
        withProjectLock(rootB, { strict: false }, async () => {
          await writeTicketUnlocked(ticket("T-002"), rootB);
        }),
      ]);
      expect(aResult.status).toBe("rejected");
      if (aResult.status === "rejected") {
        expect(aResult.reason).toBeInstanceOf(ProjectLoaderError);
      }
      expect(existsSync(join(rootA, ".story", "tickets", "T-001.json"))).toBe(false);
      expect(bResult.status).toBe("fulfilled");
      expect(existsSync(join(rootB, ".story", "tickets", "T-002.json"))).toBe(true);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it("voluntary self-release recovers correctly (own orphaned journal, never self-deadlocks)", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    const target = join(wrapDir, "tickets", "T-002.json");
    const tempPath = `${target}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(ticket("T-002"), null, 2));
    const journal = {
      entries: [{ op: "write", target, tempPath }],
      commitStarted: true,
      owner: { pid: process.pid, processSignature: null, episodeId: "prior-episode" },
    };
    await writeFile(join(wrapDir, ".txn.json"), JSON.stringify(journal));
    // Our own pid is definitionally alive; recovery must proceed anyway (lock
    // exclusivity, not journal-owner pid-liveness, authorizes recovery).
    const result = await loadProject(testRoot);
    expect(result.state.tickets.some((t) => t.id === "T-002")).toBe(true);
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(false);
    expect(existsSync(tempPath)).toBe(false);
  });

  it("episodeId is unique across two runTransactionUnlocked calls within one lock hold", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    const lockPath = join(wrapDir, ".lock");

    // A successful runTransactionUnlocked deletes its journal, so episodeId
    // isn't observable post-hoc. Force a mid-commit fencing failure on EACH
    // call instead, which leaves the journal (with owner.episodeId) behind --
    // then restore the lock body IN PLACE (writeFile truncates the existing
    // file rather than unlinking it, so the inode -- and thus the still-held
    // handle's fencing -- stays valid) before the next attempt.
    async function forceFailureAndCaptureEpisode(target: string, content: string): Promise<string | undefined> {
      const validBody = await readFile(lockPath, "utf-8");
      await writeFile(lockPath, JSON.stringify({ ...JSON.parse(validBody), token: "corrupted-for-test" }));
      await expect(runTransactionUnlocked(testRoot, [{ op: "write", target, content }])).rejects.toThrow(/Lock ownership lost/);
      const journal = JSON.parse(await readFile(join(wrapDir, ".txn.json"), "utf-8"));
      const episodeId: string | undefined = journal?.owner?.episodeId;
      await writeFile(lockPath, validBody); // restore, same inode
      await rm(join(wrapDir, ".txn.json"), { force: true });
      return episodeId;
    }

    let firstEpisode: string | undefined;
    let secondEpisode: string | undefined;
    await withProjectLock(testRoot, { strict: false }, async () => {
      firstEpisode = await forceFailureAndCaptureEpisode(join(wrapDir, "tickets", "T-010.json"), JSON.stringify(ticket("T-010")));
      secondEpisode = await forceFailureAndCaptureEpisode(join(wrapDir, "tickets", "T-011.json"), JSON.stringify(ticket("T-011")));
    });

    expect(firstEpisode).toBeTruthy();
    expect(secondEpisode).toBeTruthy();
    expect(firstEpisode).not.toBe(secondEpisode);
  });

  // ---- universal fencing coverage: all four choke points, real call sites ----

  async function forceOwnershipLossDuring(root: string, run: () => Promise<void>): Promise<unknown> {
    let caught: unknown;
    await withProjectLock(root, { strict: false }, async () => {
      const lockPath = join(root, ".story", ".lock");
      const body = JSON.parse(await readFile(lockPath, "utf-8"));
      await rm(lockPath);
      await writeFile(lockPath, JSON.stringify({ ...body, token: "stolen-by-test" }));
      try {
        await run();
      } catch (err) {
        caught = err;
      }
    }).catch((err) => {
      caught = caught ?? err;
    });
    return caught;
  }

  it("fenced choke point: atomicWrite (real site: writeTicket-shaped write) aborts on ownership loss", async () => {
    testRoot = await createProject();
    const target = join(testRoot, ".story", "tickets", "T-020.json");
    const err = await forceOwnershipLossDuring(testRoot, () => atomicWrite(target, JSON.stringify(ticket("T-020"))));
    expect(err).toBeInstanceOf(ProjectLoaderError);
    expect(existsSync(target)).toBe(false);
  });

  it("fenced choke point: atomicCreate (real site: createOnly ticket write) aborts on ownership loss", async () => {
    testRoot = await createProject();
    const target = join(testRoot, ".story", "tickets", "T-021.json");
    const err = await forceOwnershipLossDuring(testRoot, () => atomicCreate(target, JSON.stringify(ticket("T-021"))));
    expect(err).toBeInstanceOf(ProjectLoaderError);
    expect(existsSync(target)).toBe(false);
  });

  it("fenced choke point: fencedUnlink (real site: deleteTicket hard-delete path) aborts on ownership loss", async () => {
    testRoot = await createProject();
    const target = join(testRoot, ".story", "tickets", "T-022.json");
    await writeFile(target, JSON.stringify(ticket("T-022"), null, 2));
    const err = await forceOwnershipLossDuring(testRoot, () => fencedUnlink(target));
    expect(err).toBeInstanceOf(ProjectLoaderError);
    expect(existsSync(target)).toBe(true); // survives -- the delete never committed
  });

  it("fenced choke point: fencedLink (real site: team handover creation's publish step) aborts on ownership loss", async () => {
    testRoot = await createProject();
    const handoversDir = join(testRoot, ".story", "handovers");
    await mkdir(handoversDir, { recursive: true });
    const tempPath = join(handoversDir, ".tmp-test");
    const target = join(handoversDir, "2026-01-01T00-00-00Z-abcd-test.md");
    await writeFile(tempPath, "content");
    const err = await forceOwnershipLossDuring(testRoot, () => fencedLink(tempPath, target));
    expect(err).toBeInstanceOf(ProjectLoaderError);
    expect(existsSync(target)).toBe(false);
  });

  it("real end-to-end: deleteTicket physically removes on a healthy lock (fencing does not false-positive)", async () => {
    testRoot = await createProject();
    await writeTicket(ticket("T-030"), testRoot);
    const result = await deleteTicket("T-030", testRoot);
    expect(result.alreadyDeleted).toBe(false);
    expect(existsSync(join(testRoot, ".story", "tickets", "T-030.json"))).toBe(false);
  });

  // ---- ISS-942 942.1: the four choke-point tests above drive the primitives
  // (atomicWrite/atomicCreate/fencedUnlink/fencedLink) directly with synthetic
  // paths. These four drive the actual NAMED real call sites the test plan
  // requires (writeTicket, createOnly ticket creation, deleteTicket's
  // hard-delete path, team-mode handover creation) through the identical
  // ownership-loss failure, proving the ROUTING through each consumer, not
  // just the helper in isolation. writeTicket/deleteTicket/handleHandoverCreate
  // all acquire their OWN project lock, so forceOwnershipLossDuring's
  // tamper-the-on-disk-file-from-an-outer-lock technique would deadlock/time
  // out here (self-pid-held-lock reacquisition); the fencingOverride seam
  // (module-mocked verifyProjectLockOwnership) fails the NEXT fencing check
  // from inside the call site's own lock hold instead. ----

  it("real call site: writeTicket aborts on ownership loss (fencingOverride drives atomicWrite's routing)", async () => {
    testRoot = await createProject();
    fencingOverride.failNextN = 1;
    await expect(writeTicket(ticket("T-050"), testRoot)).rejects.toThrow(ProjectLoaderError);
    expect(existsSync(join(testRoot, ".story", "tickets", "T-050.json"))).toBe(false);
  });

  it("real call site: ticket creation with createOnly aborts on ownership loss (fencingOverride drives atomicCreate's routing)", async () => {
    testRoot = await createProject();
    const err = await forceOwnershipLossDuring(testRoot, () =>
      writeTicketUnlocked(ticket("T-051"), testRoot, { createOnly: true }),
    );
    expect(err).toBeInstanceOf(ProjectLoaderError);
    expect(existsSync(join(testRoot, ".story", "tickets", "T-051.json"))).toBe(false);
  });

  it("real call site: deleteTicket's hard-delete path aborts on ownership loss (fencingOverride drives fencedUnlink's routing)", async () => {
    testRoot = await createProject();
    await writeTicket(ticket("T-052"), testRoot);
    fencingOverride.failNextN = 1;
    await expect(deleteTicket("T-052", testRoot, { hard: true })).rejects.toThrow(ProjectLoaderError);
    expect(existsSync(join(testRoot, ".story", "tickets", "T-052.json"))).toBe(true); // survives -- the delete never committed
  });

  it("real call site: team-mode handover creation aborts on ownership loss (fencingOverride drives fencedLink's routing)", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    await writeFile(join(wrapDir, "config.json"), JSON.stringify({ ...minimalConfig, team: { enabled: true } }, null, 2));
    fencingOverride.failNextN = 1;
    await expect(handleHandoverCreate("Session content.", "test-slug", "md", testRoot)).rejects.toThrow(ProjectLoaderError);
    const handoversDir = join(wrapDir, "handovers");
    const published = readdirSync(handoversDir).filter((f) => f.endsWith(".md"));
    expect(published).toHaveLength(0); // the publish (fencedLink) step never committed
  });

  // ---- forward-recovery fails closed on genuine errors (3 shapes) ----

  it("forward recovery fails closed on a genuine rename error, preserving temp + journal", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    // Destination's parent directory deliberately does not exist -> rename fails.
    // The pre-fix code silently swallowed this and deleted the journal anyway.
    const target = join(wrapDir, "tickets", "missing-subdir", "T-040.json");
    const tempPath = join(wrapDir, "tickets", "T-040.json.99999.tmp");
    await writeFile(tempPath, JSON.stringify(ticket("T-040")));
    const journal = {
      entries: [{ op: "write", target, tempPath }],
      commitStarted: true,
    };
    await writeFile(join(wrapDir, ".txn.json"), JSON.stringify(journal));
    await expect(loadProject(testRoot)).rejects.toThrow(/Transaction recovery failed applying/);
    expect(existsSync(tempPath)).toBe(true); // temp preserved
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(true); // journal preserved
  });

  it("forward recovery does not misread a non-ENOENT stat failure as 'already applied'", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    const target = join(wrapDir, "tickets", "T-041.json");
    // A regular file sits where the temp path expects a directory component ->
    // the stat probe fails ENOTDIR, not ENOENT. The pre-fix `existsSync`-based
    // probe collapsed this into "false" (temp absent -> already applied),
    // silently discarding the journal even though the write was never applied.
    const blocker = join(wrapDir, "tickets", "T-041.json.blocker");
    await writeFile(blocker, "not a directory");
    const tempPath = join(blocker, "impossible.tmp");
    const journal = { entries: [{ op: "write", target, tempPath }], commitStarted: true };
    await writeFile(join(wrapDir, ".txn.json"), JSON.stringify(journal));
    await expect(loadProject(testRoot)).rejects.toThrow(/Transaction recovery failed probing/);
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(true); // journal preserved, not silently discarded
  });

  it("forward recovery does not swallow a non-ENOENT delete error as 'target already gone'", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    // A directory at the delete target makes unlink fail with EISDIR/EPERM, not ENOENT.
    const target = join(wrapDir, "tickets", "T-042-dir");
    await mkdir(target);
    const journal = { entries: [{ op: "delete", target }], commitStarted: true };
    await writeFile(join(wrapDir, ".txn.json"), JSON.stringify(journal));
    await expect(loadProject(testRoot)).rejects.toThrow(/Transaction recovery failed applying delete/);
    expect(existsSync(target)).toBe(true); // not silently treated as already-gone
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(true); // journal preserved
  });

  // ---- ISS-942 942.1: R1's proving test, plus a pin for doRecoverTransaction's
  // already-correct no-commit rollback arm (unpinned in the tree until now) ----

  it("runTransactionUnlocked's OWN commit-loop delete branch fails closed on a genuine non-ENOENT delete error, journal preserved (R1)", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    // A directory at the delete target makes unlink fail with EISDIR/EPERM, not
    // ENOENT. Before the 942.1 fix, this branch's bare `catch { /* Target may
    // already be gone */ }` swallowed the error, step 6 then removed the
    // journal, and the transaction reported success while the target silently
    // survived with no journal left to replay it.
    const target = join(wrapDir, "tickets", "T-044-dir");
    await mkdir(target);
    await expect(
      withProjectLock(testRoot, { strict: false }, () => runTransactionUnlocked(testRoot, [{ op: "delete", target }])),
    ).rejects.toThrow(/Failed to delete .* during transaction commit; journal preserved for retry/);
    expect(existsSync(target)).toBe(true); // not silently treated as already-gone
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(true); // journal preserved for retry
  });

  it("doRecoverTransaction's no-commit rollback arm fails closed on a genuine non-ENOENT temp-unlink error (pins already-correct behavior)", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    const target = join(wrapDir, "tickets", "T-043.json");
    // A directory sits at the prepared temp path -> unlink fails EISDIR/EPERM,
    // not ENOENT. commitStarted: false means the commit never began, so this
    // exercises the "safe to clean up" rollback arm, not forward recovery.
    const tempPath = join(wrapDir, "tickets", "T-043-tempdir");
    await mkdir(tempPath);
    const journal = { entries: [{ op: "write", target, tempPath }], commitStarted: false };
    await writeFile(join(wrapDir, ".txn.json"), JSON.stringify(journal));
    await expect(loadProject(testRoot)).rejects.toThrow(/Transaction recovery failed removing prepared temp/);
    expect(existsSync(tempPath)).toBe(true); // not silently treated as already-gone
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(true); // journal preserved for retry
  });

  it("loadProject's journal-presence probe fails closed on a non-ENOENT stat error instead of silently skipping recovery (R3)", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    // A real, valid, commitStarted:true journal is present -- if the probe
    // failure were silently swallowed (the pre-942.1 `existsSync` behavior),
    // this journal would be silently skipped and orphaned rather than recovered.
    const target = join(wrapDir, "tickets", "T-045.json");
    const tempPath = `${target}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(ticket("T-045")));
    await writeFile(
      join(wrapDir, ".txn.json"),
      JSON.stringify({ entries: [{ op: "write", target, tempPath }], commitStarted: true }),
    );
    statOverride.failPathSuffix = ".txn.json";
    await expect(loadProject(testRoot)).rejects.toThrow(/Failed to probe transaction journal presence/);
    expect(existsSync(join(wrapDir, ".txn.json"))).toBe(true); // journal untouched, not silently skipped
  });

  // ---- reconcile-shaped duplicate-mint under concurrent stale-lock contention ----

  it("two concurrent lock-holders racing a stale-but-dead lock never both mint the same next id", async () => {
    testRoot = await createProject();
    const wrapDir = join(testRoot, ".story");
    await writeFile(join(wrapDir, "tickets", "T-001.json"), JSON.stringify(ticket("T-001"), null, 2));
    // Hold the lock with a dead identity so both contenders must go through the steal path.
    const lockPath = join(wrapDir, ".lock");
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), token: "dead0", acquiredAt: Date.now(), processSignature: null }));

    async function mintNext(): Promise<string> {
      let minted = "";
      await withProjectLock(testRoot, { strict: false }, async ({ state }) => {
        const max = Math.max(0, ...state.tickets.map((t) => parseInt(t.id.replace("T-", ""), 10) || 0));
        const nextId = `T-${String(max + 1).padStart(3, "0")}`;
        await writeTicketUnlocked(ticket(nextId), testRoot, { createOnly: true });
        minted = nextId;
      });
      return minted;
    }

    const [a, b] = await Promise.all([mintNext(), mintNext()]);
    expect(a).not.toBe(b); // serialized by the lock -- the second mint saw the first's write
    const finalTickets = (await loadProject(testRoot)).state.tickets;
    const ids = finalTickets.map((t) => t.id).sort();
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });
});
