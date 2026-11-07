import { fork, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  acquireHardenedLock,
  releaseHardenedLock,
  tryAcquireHardenedLock,
} from "../../src/bus/lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempLock(): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "bus-lock-"));
  roots.push(root);
  return { root, lockPath: join(root, "locks", "test.lock") };
}

function waitForMessage<T>(child: ChildProcess, predicate: (message: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: T): void => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`worker exited before expected message: code=${code} signal=${signal}`));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function worker(mode: "holder" | "contender", lockPath: string, counterPath: string): ChildProcess {
  const fixture = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url));
  return fork(fixture, [mode, lockPath, counterPath], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

describe("Storybloq Bus hardened lock", () => {
  it("does not break a live holder based on elapsed time", async () => {
    const { lockPath } = await tempLock();
    const first = await acquireHardenedLock(lockPath);
    await expect(acquireHardenedLock(lockPath, { timeoutMs: 60, pollMs: 5 }))
      .rejects.toMatchObject({ code: "lock_timeout" });
    await releaseHardenedLock(first);
  });

  it("recovers a positively dead holder", async () => {
    const { lockPath } = await tempLock();
    await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
    await writeFile(lockPath, JSON.stringify({
      pid: 99999999,
      token: "a".repeat(64),
      acquiredAt: new Date().toISOString(),
      processSignature: null,
    }), "utf-8");
    const handle = await acquireHardenedLock(lockPath, { timeoutMs: 1000 });
    await releaseHardenedLock(handle);
  });

  it("wedges safely on an unreadable lock instead of guessing", async () => {
    const { lockPath } = await tempLock();
    await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
    await writeFile(lockPath, "not-json", "utf-8");
    await expect(acquireHardenedLock(lockPath, { timeoutMs: 100 }))
      .rejects.toMatchObject({ code: "corrupt" });
  });

  it("classifies a live PID with a mismatched signature as dead on Linux, unknown on Darwin", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    await expect(__testing.inspectProcess(process.pid, "mismatched-process-signature"))
      .resolves.toBe(process.platform === "darwin" ? "unknown" : "dead");
  });

  it("rejects a lock-file symlink without touching its target", async () => {
    const { root, lockPath } = await tempLock();
    await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
    const target = join(root, "lock-target.json");
    await writeFile(target, "target remains unchanged", "utf-8");
    await symlink(target, lockPath);

    await expect(acquireHardenedLock(lockPath, { timeoutMs: 100 }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await readFile(target, "utf-8")).toBe("target remains unchanged");
  });

  it("does not recursively break an abandoned reaper guard", async () => {
    const { lockPath } = await tempLock();
    await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
    const dead = {
      pid: 99999999,
      token: "b".repeat(64),
      acquiredAt: new Date().toISOString(),
      processSignature: null,
    };
    await writeFile(lockPath, JSON.stringify(dead), "utf-8");
    await writeFile(`${lockPath}.reap`, JSON.stringify({ ...dead, token: "c".repeat(64) }), "utf-8");
    await expect(acquireHardenedLock(lockPath, { timeoutMs: 80, pollMs: 5 }))
      .rejects.toMatchObject({ code: "lock_timeout" });
    expect(await readFile(lockPath, "utf-8")).toContain("99999999");
  });

  describe("tryAcquireHardenedLock (single-attempt, non-blocking)", () => {
    it("acquires a free lock on the first attempt", async () => {
      const { lockPath } = await tempLock();
      const handle = await tryAcquireHardenedLock(lockPath);
      expect(handle).not.toBeNull();
      await releaseHardenedLock(handle!);
    });

    it("returns the busy sentinel for a live holder without throwing", async () => {
      // Non-waiting is structural (tryAcquireHardenedLock has no poll loop, unlike the deadline
      // variant), so this asserts the observable contract -- a null sentinel, never a throw --
      // rather than a flaky wall-clock bound.
      const { lockPath } = await tempLock();
      const held = await acquireHardenedLock(lockPath);
      const busy = await tryAcquireHardenedLock(lockPath);
      expect(busy).toBeNull();
      await releaseHardenedLock(held);
    });

    it("reclaims a positively dead holder and acquires", async () => {
      const { lockPath } = await tempLock();
      await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
      await writeFile(lockPath, JSON.stringify({
        pid: 99999999,
        token: "a".repeat(64),
        acquiredAt: new Date().toISOString(),
        processSignature: null,
      }), "utf-8");
      const handle = await tryAcquireHardenedLock(lockPath);
      expect(handle).not.toBeNull();
      await releaseHardenedLock(handle!);
    });

    it("returns busy without reclaiming when the reaper guard is held", async () => {
      const { lockPath } = await tempLock();
      await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
      const dead = {
        pid: 99999999,
        token: "b".repeat(64),
        acquiredAt: new Date().toISOString(),
        processSignature: null,
      };
      await writeFile(lockPath, JSON.stringify(dead), "utf-8");
      await writeFile(`${lockPath}.reap`, JSON.stringify({ ...dead, token: "c".repeat(64) }), "utf-8");
      const busy = await tryAcquireHardenedLock(lockPath);
      expect(busy).toBeNull();
      expect(await readFile(lockPath, "utf-8")).toContain("99999999");
    });

    it("wedges (throws) on an unreadable lock instead of guessing", async () => {
      const { lockPath } = await tempLock();
      await import("node:fs/promises").then((fs) => fs.mkdir(dirname(lockPath), { recursive: true }));
      await writeFile(lockPath, "not-json", "utf-8");
      await expect(tryAcquireHardenedLock(lockPath)).rejects.toMatchObject({ code: "corrupt" });
    });

    it("lets exactly one of two sequential contenders acquire", async () => {
      const { lockPath } = await tempLock();
      const first = await tryAcquireHardenedLock(lockPath);
      const second = await tryAcquireHardenedLock(lockPath);
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      await releaseHardenedLock(first!);
      const third = await tryAcquireHardenedLock(lockPath);
      expect(third).not.toBeNull();
      await releaseHardenedLock(third!);
    });

    it("lets exactly one of two CONCURRENTLY racing contenders acquire (atomic link)", async () => {
      const { lockPath } = await tempLock();
      // Both start together: the link() is the atomic arbiter, so exactly one gets a handle and
      // the other sees EEXIST from a live (this-process) holder -> null. No throw, no double-grant.
      const [a, b] = await Promise.all([
        tryAcquireHardenedLock(lockPath),
        tryAcquireHardenedLock(lockPath),
      ]);
      const handles = [a, b].filter((h) => h !== null);
      expect(handles).toHaveLength(1);
      // The winner's lock is releasable and the path is immediately reusable afterward.
      await releaseHardenedLock(handles[0]!);
      const again = await tryAcquireHardenedLock(lockPath);
      expect(again).not.toBeNull();
      await releaseHardenedLock(again!);
    });

    it("removes its published lock when a post-link step fails (leaves no live-caller lock)", async () => {
      const { lockPath } = await tempLock();
      // Force a failure AFTER the primary link publishes but BEFORE sync completes: the
      // ownership-verified cleanup must remove the just-published lock so it is not left naming
      // this still-live process (which would wedge every later contender as "busy").
      __testing.setAfterPrimaryLinkHook(async () => { throw new Error("forced post-link failure"); });
      try {
        await expect(tryAcquireHardenedLock(lockPath)).rejects.toMatchObject({ code: "io_error" });
      } finally {
        __testing.setAfterPrimaryLinkHook(null);
      }
      // The published lock was cleaned up, so the path is absent and a fresh contender acquires it.
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      const recovered = await tryAcquireHardenedLock(lockPath);
      expect(recovered).not.toBeNull();
      await releaseHardenedLock(recovered!);
    });
  });

  it("serializes forty contenders after a SIGKILL without duplicate sequence 1", async () => {
    const { root, lockPath } = await tempLock();
    const counterPath = join(root, "counter.txt");
    const holder = worker("holder", lockPath, counterPath);
    await waitForMessage<{ type: string }>(holder, (message) => message.type === "ready");
    await new Promise<void>((resolve) => {
      holder.once("exit", () => resolve());
      holder.kill("SIGKILL");
    });

    const children = Array.from({ length: 40 }, () => worker("contender", lockPath, counterPath));
    let results: number[];
    try {
      results = await Promise.all(children.map(async (child) => {
        const message = await waitForMessage<{ type: string; seq?: number; message?: string }>(
          child,
          (candidate) => candidate.type === "done" || candidate.type === "error",
        );
        if (message.type === "error") throw new Error(message.message);
        return message.seq!;
      }));
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }

    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(await readFile(counterPath, "utf-8")).toBe("40");
  }, 60_000);
});
