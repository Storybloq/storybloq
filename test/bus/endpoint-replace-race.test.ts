// ISS-940: joinEndpoint's --replace path and refreshEndpointForSessionStart both
// read-decide-write the same endpoints/<id>.json under disjoint locks (endpoints.lock
// vs endpoint-<id>.lock), letting a concurrent refresh's unconditional rename clobber
// a just-landed retire, or vice versa. All 7 tests fail against the parent commit
// (1265924a), confirmed empirically via git-stash bisection: pre-fix, joinEndpoint
// never acquires endpoint-<id>.lock at all, and endpoints.ts/lock.ts have no
// __testing export, so every test that calls one of this fix's new test seams
// (setProcessDetectionOverride, setAfterEndpointReadHook, setAfterReplaceReadHook,
// setAfterBusyAcquireAttemptHook) before its core assertion fails via a TypeError on
// that missing setter; the remaining tests (mocked/real timeout, generic acquisition
// error, release-error recovery) fail via a behavioral mismatch instead, because
// pre-fix the replace path never contends on an inner lock at all and so always
// succeeds immediately regardless of the failure injected. Do not read this as a
// claim about which specific mechanism fires for which specific test line -- both
// buckets are real and re-verified whenever this file changes; see the RED-bisection
// note in the ISS-940 resolution for the full per-test breakdown.
//
// Uses mkdtemp temp-root fixtures throughout; never touches a real .story/bus/.

import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initProject } from "../../src/core/init.js";
import { BusError } from "../../src/bus/errors.js";
import {
  initializeBus,
  joinEndpoint,
  listEndpoints,
  refreshEndpointForSessionStart,
  type BusEndpoint,
} from "../../src/bus/index.js";
import { __testing as endpointsTesting } from "../../src/bus/endpoints.js";
import { __testing as lockTesting, acquireHardenedLock, releaseHardenedLock } from "../../src/bus/lock.js";

// Selective override state consulted by the vi.mock factory below. All null (inert,
// full pass-through to the real implementation) unless a specific test sets them.
let timeoutMockTargetPath: string | null = null;
let genericErrorTargetPath: string | null = null;
// The EXACT object thrown by the mock (never reconstructed), so a test can assert
// identity preservation rather than just a matching message.
let genericErrorToThrow: (Error & { marker?: string }) | null = null;
let releaseErrorTargetPath: string | null = null;
let releaseHardenedLockCallCount = 0;

vi.mock("../../src/bus/lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bus/lock.js")>();
  return {
    ...actual,
    acquireHardenedLock: async (
      lockPath: string,
      options?: Parameters<typeof actual.acquireHardenedLock>[1],
    ) => {
      if (timeoutMockTargetPath && lockPath === timeoutMockTargetPath) {
        throw new BusError("lock_timeout", `mocked timeout for ${lockPath}`);
      }
      if (genericErrorTargetPath && lockPath === genericErrorTargetPath && genericErrorToThrow) {
        throw genericErrorToThrow;
      }
      return actual.acquireHardenedLock(lockPath, options);
    },
    releaseHardenedLock: async (handle: Parameters<typeof actual.releaseHardenedLock>[0]) => {
      releaseHardenedLockCallCount++;
      await actual.releaseHardenedLock(handle);
      if (releaseErrorTargetPath && handle.lockPath === releaseErrorTargetPath) {
        throw new Error("synthetic release failure");
      }
    },
  };
});

const roots: string[] = [];

afterEach(async () => {
  endpointsTesting.setAfterEndpointReadHook(null);
  endpointsTesting.setAfterReplaceReadHook(null);
  endpointsTesting.setProcessDetectionOverride(null);
  lockTesting.setAfterBusyAcquireAttemptHook(null);
  timeoutMockTargetPath = null;
  genericErrorTargetPath = null;
  genericErrorToThrow = null;
  releaseErrorTargetPath = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(name: string): Promise<string> {
  // Realpath immediately: resolveBusPaths canonicalizes the project root (macOS
  // tmpdir() lives under a /var symlink to /private/var), and this file does direct
  // string comparisons against lock paths built from `root` (afterBusyAcquireAttemptHook
  // filtering, releaseHardenedLock's handle.lockPath in the mock) that must match the
  // canonical form the production code actually computes and passes around.
  const root = await realpath(await mkdtemp(join(tmpdir(), `${name}-`)));
  roots.push(root);
  return root;
}

// Builds a fixture with exactly one active endpoint, "incumbent", whose recorded pid
// is positively dead -- matching the existing "leaves the incumbent active..." (R16)
// test's convention in endpoints-hooks.test.ts for a --replace-eligible offline proof.
async function buildRaceFixture(nameHint: string): Promise<{
  root: string;
  incumbent: BusEndpoint;
  incumbentTaskId: string;
  lockPath: string;
}> {
  const root = await tempRoot(nameHint);
  await initProject(root, { name: nameHint });
  await initializeBus(root);
  const incumbentTaskId = "claude-task-incumbent";
  const joined = (await joinEndpoint(root, {
    client: "claude",
    clientTaskId: incumbentTaskId,
    surface: "claude_cli",
  })).endpoint;
  const endpointPath = join(root, ".story", "bus", "endpoints", `${joined.endpointId}.json`);
  const onDisk = JSON.parse(await readFile(endpointPath, "utf-8"));
  const incumbent: BusEndpoint = {
    ...onDisk,
    state: "attached",
    processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
  };
  await writeFile(endpointPath, JSON.stringify(incumbent, null, 2) + "\n", "utf-8");
  const lockPath = join(root, ".story", "bus", "locks", `endpoint-${joined.endpointId}.lock`);
  return { root, incumbent, incumbentTaskId, lockPath };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("ISS-940: endpoint-registry replace vs. SessionStart refresh race", () => {
  it("B-first: a concurrent replace conflicts against a refresh that lands first, and does not clobber it", async () => {
    const { root, incumbent, incumbentTaskId, lockPath } = await buildRaceFixture("bus-replace-race-bfirst");

    endpointsTesting.setProcessDetectionOverride(async () => ({ surface: incumbent.surface, process: null }));

    const refreshReachedRead = deferred();
    const refreshGate = deferred();
    endpointsTesting.setAfterEndpointReadHook(async (endpointId) => {
      if (endpointId !== incumbent.endpointId) return;
      refreshReachedRead.resolve();
      await refreshGate.promise;
    });

    const refreshPromise = refreshEndpointForSessionStart(root, incumbent.endpointId, incumbentTaskId);
    await refreshReachedRead.promise;

    let busySignaled = false;
    const busySignal = deferred();
    lockTesting.setAfterBusyAcquireAttemptHook(async (path) => {
      if (path !== lockPath || busySignaled) return;
      busySignaled = true;
      busySignal.resolve();
    });

    const replacePromise = joinEndpoint(root, {
      client: "claude",
      clientTaskId: "claude-replace-task",
      surface: "claude_cli",
      replace: incumbent.endpointId,
    });

    // Proves replace's real acquireHardenedLock call has run and found the lock busy,
    // NOT merely that it was scheduled -- the barrier this fix's plan review required.
    await busySignal.promise;

    let replaceSettled = false;
    replacePromise.then(() => { replaceSettled = true; }, () => { replaceSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replaceSettled).toBe(false);

    refreshGate.resolve();

    await expect(refreshPromise).resolves.toMatchObject({ retiredAt: null, state: "unknown" });
    await expect(replacePromise).rejects.toMatchObject({ code: "conflict" });

    const mailboxes = await readdir(join(root, ".story", "bus", "mailboxes"));
    expect(mailboxes).toEqual([incumbent.endpointId]);
    const { endpoints } = await listEndpoints(root);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.retiredAt).toBeNull();
  });

  it("A-first: a concurrent refresh is blocked by an in-flight replace, and cannot resurrect the retired incumbent", async () => {
    const { root, incumbent, incumbentTaskId, lockPath } = await buildRaceFixture("bus-replace-race-afirst");

    const replaceReachedRead = deferred();
    const replaceGate = deferred();
    endpointsTesting.setAfterReplaceReadHook(async (endpointId) => {
      if (endpointId !== incumbent.endpointId) return;
      replaceReachedRead.resolve();
      await replaceGate.promise;
    });

    const replacePromise = joinEndpoint(root, {
      client: "claude",
      clientTaskId: "claude-replace-task",
      surface: "claude_cli",
      replace: incumbent.endpointId,
    });
    await replaceReachedRead.promise;

    let busySignaled = false;
    const busySignal = deferred();
    lockTesting.setAfterBusyAcquireAttemptHook(async (path) => {
      if (path !== lockPath || busySignaled) return;
      busySignaled = true;
      busySignal.resolve();
    });

    const refreshPromise = refreshEndpointForSessionStart(root, incumbent.endpointId, incumbentTaskId);
    await busySignal.promise;

    let refreshSettled = false;
    refreshPromise.then(() => { refreshSettled = true; }, () => { refreshSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshSettled).toBe(false);

    replaceGate.resolve();

    await expect(replacePromise).resolves.toMatchObject({ existing: false });
    await expect(refreshPromise).rejects.toMatchObject({ code: "unauthorized" });

    const { endpoints } = await listEndpoints(root);
    expect(endpoints.filter((endpoint) => !endpoint.retiredAt)).toHaveLength(1);
    const retired = endpoints.find((endpoint) => endpoint.endpointId === incumbent.endpointId);
    expect(retired?.retiredAt ?? null).not.toBeNull();
  });

  it("a mocked lock_timeout on the inner acquisition maps to conflict, never calls release, and cleans up the orphaned mailbox", async () => {
    const { root, incumbent, lockPath } = await buildRaceFixture("bus-replace-race-timeout-mock");
    timeoutMockTargetPath = lockPath;
    releaseHardenedLockCallCount = 0;

    await expect(joinEndpoint(root, {
      client: "claude",
      clientTaskId: "claude-replace-task",
      surface: "claude_cli",
      replace: incumbent.endpointId,
    })).rejects.toMatchObject({ code: "conflict" });

    expect(releaseHardenedLockCallCount).toBe(0);
    const mailboxes = await readdir(join(root, ".story", "bus", "mailboxes"));
    expect(mailboxes).toEqual([incumbent.endpointId]);
  });

  it("a non-timeout acquisition failure on the inner lock is rethrown unmodified, never calls release, and cleans up the orphaned mailbox", async () => {
    const { root, incumbent, lockPath } = await buildRaceFixture("bus-replace-race-generic-error");
    genericErrorTargetPath = lockPath;
    // A distinct object with a custom property, not just a message string, so the
    // assertion below can prove the exact thrown object (not a lookalike with the
    // same message) propagates untouched, including metadata a real caller might
    // attach for diagnostics.
    const injectedError = Object.assign(new Error("synthetic non-timeout acquisition failure"), {
      marker: "iss940-generic-acquisition-error",
    });
    genericErrorToThrow = injectedError;
    releaseHardenedLockCallCount = 0;

    let caught: unknown;
    try {
      await joinEndpoint(root, {
        client: "claude",
        clientTaskId: "claude-replace-task",
        surface: "claude_cli",
        replace: incumbent.endpointId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(injectedError);
    expect((caught as { marker?: string }).marker).toBe("iss940-generic-acquisition-error");

    expect(releaseHardenedLockCallCount).toBe(0);
    const mailboxes = await readdir(join(root, ".story", "bus", "mailboxes"));
    expect(mailboxes).toEqual([incumbent.endpointId]);
    const { endpoints } = await listEndpoints(root);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.retiredAt).toBeNull();
  });

  it(
    "a real 15s lock timeout on the inner acquisition also maps to conflict (guards against mock drift)",
    async () => {
      const { root, incumbent, lockPath } = await buildRaceFixture("bus-replace-race-timeout-real");
      const held = await acquireHardenedLock(lockPath);
      try {
        await expect(joinEndpoint(root, {
          client: "claude",
          clientTaskId: "claude-replace-task",
          surface: "claude_cli",
          replace: incumbent.endpointId,
        })).rejects.toMatchObject({ code: "conflict" });
      } finally {
        await releaseHardenedLock(held);
      }
    },
    25_000,
  );

  it("a --replace join on one endpoint does not block a concurrent refresh on an unrelated endpoint (lock granularity)", async () => {
    const root = await tempRoot("bus-replace-race-granularity");
    await initProject(root, { name: "bus-replace-race-granularity" });
    await initializeBus(root);
    const unrelatedTaskId = "claude-task-unrelated";
    const unrelated = (await joinEndpoint(root, {
      client: "claude",
      clientTaskId: unrelatedTaskId,
      surface: "claude_cli",
    })).endpoint;
    const incumbentTaskId = "claude-task-incumbent";
    const incumbentJoined = (await joinEndpoint(root, {
      client: "claude",
      clientTaskId: incumbentTaskId,
      surface: "claude_cli",
    })).endpoint;
    const incumbentPath = join(root, ".story", "bus", "endpoints", `${incumbentJoined.endpointId}.json`);
    const onDisk = JSON.parse(await readFile(incumbentPath, "utf-8"));
    await writeFile(incumbentPath, JSON.stringify({
      ...onDisk,
      state: "attached",
      processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
    }, null, 2) + "\n", "utf-8");

    // Force a deterministic `process: null` for the unrelated refresh so its outcome
    // never depends on real OS process ancestry (which host process is actually
    // running this test suite). The claude_cli/claude pairing used throughout this
    // file already can't hit the surface-mismatch conflict on its own (the real
    // detector's own fallback is claude_cli whenever ancestry doesn't match), so this
    // override is belt-and-suspenders determinism, not a correctness requirement.
    endpointsTesting.setProcessDetectionOverride(async () => ({ surface: "claude_cli", process: null }));

    // Gate replacement inside its critical section (after the incumbent read, still
    // holding endpoint-<incumbentId>.lock) and prove the unrelated refresh completes
    // while replacement remains gated -- not merely that both were started together,
    // which an accidentally-globalized lock would also satisfy.
    const replaceReachedRead = deferred();
    const replaceGate = deferred();
    endpointsTesting.setAfterReplaceReadHook(async (endpointId) => {
      if (endpointId !== incumbentJoined.endpointId) return;
      replaceReachedRead.resolve();
      await replaceGate.promise;
    });

    const replacePromise = joinEndpoint(root, {
      client: "claude",
      clientTaskId: "claude-replace-task-granularity",
      surface: "claude_cli",
      replace: incumbentJoined.endpointId,
    });
    await replaceReachedRead.promise;

    let replaceSettled = false;
    replacePromise.then(() => { replaceSettled = true; }, () => { replaceSettled = true; });

    const refreshPromise = refreshEndpointForSessionStart(root, unrelated.endpointId, unrelatedTaskId);
    await expect(refreshPromise).resolves.toMatchObject({ retiredAt: null });
    // The unrelated refresh resolved above; if endpoint locks were accidentally
    // globalized, replacement would still be blocked on its own gate at this point too
    // (both would hang together), so this alone would not distinguish the bug. The
    // real distinguishing assertion is that refreshPromise settled without needing
    // replaceGate released -- proven by reaching this line at all, since replaceGate
    // is resolved only below, after the refresh has already resolved.
    expect(replaceSettled).toBe(false);

    replaceGate.resolve();
    await expect(replacePromise).resolves.toMatchObject({ existing: false });
  });

  it("still creates the successor after retirement even when releasing the incumbent's lock fails", async () => {
    const { root, incumbent } = await buildRaceFixture("bus-replace-race-release-error");
    releaseErrorTargetPath = join(root, ".story", "bus", "locks", `endpoint-${incumbent.endpointId}.lock`);

    await expect(joinEndpoint(root, {
      client: "claude",
      clientTaskId: "claude-replace-task",
      surface: "claude_cli",
      replace: incumbent.endpointId,
    })).rejects.toThrow("synthetic release failure");

    const { endpoints } = await listEndpoints(root);
    const retiredIncumbent = endpoints.find((endpoint) => endpoint.endpointId === incumbent.endpointId);
    expect(retiredIncumbent?.retiredAt ?? null).not.toBeNull();
    const successor = endpoints.find((endpoint) => endpoint.endpointId !== incumbent.endpointId);
    expect(successor).toBeDefined();
    expect(successor?.retiredAt ?? null).toBeNull();
    const mailboxes = await readdir(join(root, ".story", "bus", "mailboxes"));
    expect(mailboxes.sort()).toEqual([incumbent.endpointId, successor!.endpointId].sort());

    releaseErrorTargetPath = null;

    const rejoin = await joinEndpoint(root, {
      client: "claude",
      clientTaskId: successor!.clientTaskId,
      surface: "claude_cli",
    });
    expect(rejoin.existing).toBe(true);
    expect(rejoin.endpoint.endpointId).toBe(successor!.endpointId);
  });
});
