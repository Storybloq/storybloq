/**
 * ISS-865: a caller-supplied Bus id never reaches a lock path unchecked. The lock
 * primitive mkdirs dirname(lockPath) and contends on lockPath before anything else,
 * so a thread or endpoint id with traversal segments could create directories and
 * touch lock files anywhere on disk. These tests import no lock-path helper: every
 * expected path is spelled with a literal join, so the file runs unchanged against
 * the code before the fix.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  acquireHardenedLock, releaseHardenedLock, __testing as lockTesting, type HardenedLockHandle,
} from "../../src/bus/lock.js";
import { resolveBusPaths } from "../../src/bus/paths.js";
import { sendBusMessage, updateBusThread } from "../../src/bus/store.js";
import { acquireWaiter, cleanupWaiter, type WaiterIdentity } from "../../src/bus/wait.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { ExitCode } from "../../src/core/output-formatter.js";
import { runBusCli } from "./cli-harness.js";
import { createBusFixture, createIssue, type BusFixture } from "./helpers.js";
import { toolSchema } from "../mcp/tool-schema-helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  lockTesting.setAfterBusyAcquireAttemptHook(null);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Setup {
  readonly fx: BusFixture;
  readonly threadId: string;
  readonly locks: string;
  readonly escapeDir: string;
  readonly evil: string;
}

async function setup(): Promise<Setup> {
  const fx = await createBusFixture("iss865");
  dirs.push(fx.root);
  const issueId = await createIssue(fx.root, "low");
  const sent = await sendBusMessage(fx.root, {
    endpointId: fx.reviewer.endpointId,
    clientTaskId: fx.reviewerTaskId,
    threadKind: "question",
    toRole: "implementer",
    messageKind: "question",
    severity: "low",
    body: "Lock path containment fixture",
    refs: { issue: issueId },
    idempotencyKey: "iss865-fixture",
  });
  const outside = await mkdtemp(join(tmpdir(), "iss865-outside-"));
  dirs.push(outside);
  const escapeDir = join(outside, "escape");
  // The fused first segment `thread-..` is absorbed and the remaining `..` clamp at /,
  // so the lock path lands at <escapeDir>/x.lock.
  const evil = `${"../".repeat(64)}${escapeDir.slice(1)}/x`;
  const locks = (await resolveBusPaths(fx.root)).locks;
  return { fx, threadId: sent.threadId!, locks, escapeDir, evil };
}

function identity(): WaiterIdentity {
  return { waiterId: randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), argvMarkers: [] };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`deadline: ${what}`)), ms); });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function busError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error("expected a rejection");
}

describe("Bus lock path containment (ISS-865)", () => {
  it("the probe id targets the escape path through every lock name it reaches", async () => {
    const { locks, escapeDir, evil } = await setup();
    for (const prefix of ["thread", "waiter", "waiter-guard"]) {
      expect(normalize(join(locks, `${prefix}-${evil}.lock`))).toBe(join(escapeDir, "x.lock"));
    }
  });

  it("A1: updateBusThread rejects a traversal thread id before any lock path exists", async () => {
    const { fx, locks, escapeDir, evil } = await setup();
    const before = readdirSync(locks).sort();
    const err = await busError(updateBusThread(fx.root, {
      endpointId: fx.reviewer.endpointId, clientTaskId: fx.reviewerTaskId, threadId: evil, action: "park", reason: "r",
    }));
    expect(err.code).toBe("invalid_input");
    expect(err.message).toBe("Invalid Bus thread id");
    expect(existsSync(escapeDir)).toBe(false);
    expect(readdirSync(locks).sort()).toEqual(before);
  });

  it("A2: the CLI rejects the same id with invalid_input and leaves the escape path absent", async () => {
    const { fx, escapeDir, evil } = await setup();
    const run = await runBusCli(fx.root, [
      "bus", "thread", "update", evil, "--action", "park", "--reason", "r",
      "--client", "claude", "--task-id", fx.reviewerTaskId, "--format", "json",
    ]);
    expect(JSON.parse(run.stdout).error?.code).toBe("invalid_input");
    expect(run.exitCode).toBe(ExitCode.USER_ERROR);
    expect(existsSync(escapeDir)).toBe(false);
  });

  it("A2: the MCP handler rejects the same id even past its schema, and the schema rejects it too", async () => {
    const { fx, escapeDir, evil } = await setup();
    const tools = new Map<string, { config: { inputSchema?: unknown }; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>();
    registerAllTools({ registerTool: (name: string, config: { inputSchema?: unknown }, handler: never) => tools.set(name, { config, handler }) } as never, fx.root);
    const tool = tools.get("storybloq_bus_thread_update")!;
    const args = { endpointId: fx.reviewer.endpointId, clientTaskId: fx.reviewerTaskId, threadId: evil, action: "park", reason: "r" };
    expect(toolSchema(tool.config.inputSchema).safeParse(args).success).toBe(false);
    const reply = await tool.handler(args);
    expect(reply.isError).toBe(true);
    expect(JSON.parse(reply.content[0]!.text).error.code).toBe("invalid_input");
    expect(existsSync(escapeDir)).toBe(false);
  });

  describe("A3: valid ids still contend on the exact legacy lock names", () => {
    const DEADLINE_MS = 10_000;
    const TEST_TIMEOUT_MS = 3 * DEADLINE_MS;

    /**
     * Holds the exact expected lock, starts the operation, and requires the operation's
     * first busy attempt to land on that exact path before it settles. Settling first, or
     * no exact-path busy signal within the deadline, fails with the test's own message.
     */
    async function contend(expected: string, run: () => Promise<unknown>): Promise<void> {
      const held = await acquireHardenedLock(expected);
      const observed: string[] = [];
      const busy = deferred();
      lockTesting.setAfterBusyAcquireAttemptHook(async (lockPath) => {
        observed.push(lockPath);
        if (lockPath === expected) busy.resolve();
      });
      let released = false;
      let operation: Promise<unknown> | undefined;
      try {
        operation = run();
        const settled = operation.then(
          () => "the operation completed before contending on the exact lock",
          (err: unknown) => `the operation rejected before contending on the exact lock: ${(err as Error)?.message ?? String(err)}`,
        );
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(`no exact-path busy signal on ${expected} within ${DEADLINE_MS}ms`), DEADLINE_MS);
        });
        const first = await Promise.race([busy.promise.then(() => "busy"), settled, deadline]).finally(() => clearTimeout(timer));
        expect(first).toBe("busy");
        expect(observed[0]).toBe(expected);
        await releaseHardenedLock(held);
        released = true;
        await within(operation, DEADLINE_MS, "completion after release");
      } finally {
        lockTesting.setAfterBusyAcquireAttemptHook(null);
        if (!released) await releaseHardenedLock(held).catch(() => undefined);
        // Drain the operation so nothing outlives the test.
        if (operation) await operation.catch(() => undefined);
      }
    }

    it("(a) the thread lock", async () => {
      const { fx, threadId, locks } = await setup();
      await contend(join(locks, `thread-${threadId}.lock`), () => updateBusThread(fx.root, {
        endpointId: fx.reviewer.endpointId, clientTaskId: fx.reviewerTaskId, threadId, action: "park", reason: "r",
      }));
    }, TEST_TIMEOUT_MS);

    it("(b) the endpoint lock", async () => {
      const { fx, threadId, locks } = await setup();
      await contend(join(locks, `endpoint-${fx.reviewer.endpointId}.lock`), () => updateBusThread(fx.root, {
        endpointId: fx.reviewer.endpointId, clientTaskId: fx.reviewerTaskId, threadId, action: "park", reason: "r",
      }));
    }, TEST_TIMEOUT_MS);

    it("(c) the waiter guard", async () => {
      const { fx, locks } = await setup();
      const paths = await resolveBusPaths(fx.root);
      const me = identity();
      await contend(join(locks, `waiter-guard-${fx.reviewer.endpointId}.lock`), () => acquireWaiter(paths, fx.reviewer.endpointId, me));
      expect(existsSync(join(locks, `waiter-${fx.reviewer.endpointId}.lock`))).toBe(true);
      await cleanupWaiter(paths, fx.reviewer.endpointId, me);
    }, TEST_TIMEOUT_MS);
  });

  describe("A6: the exported waiter functions are the second entry", () => {
    const A6C_DEADLINE_MS = 20_000;

    it("(a) acquireWaiter rejects a traversal endpoint id and creates nothing outside", async () => {
      const { fx, escapeDir, evil } = await setup();
      const paths = await resolveBusPaths(fx.root);
      const err = await busError(acquireWaiter(paths, evil, identity()));
      expect(err.code).toBe("invalid_input");
      expect(existsSync(escapeDir)).toBe(false);
    });

    it("(b) acquireWaiter rejects a single-component malformed endpoint id", async () => {
      const { fx, locks } = await setup();
      const paths = await resolveBusPaths(fx.root);
      const err = await busError(acquireWaiter(paths, "not-a-uuid", identity()));
      expect(err.code).toBe("invalid_input");
      expect(readdirSync(locks).filter((name) => name.includes("not-a-uuid"))).toEqual([]);
    });

    it("(c) cleanupWaiter makes no lock attempt outside the Bus and leaves a foreign lock untouched", async () => {
      const { fx, escapeDir, evil } = await setup();
      const paths = await resolveBusPaths(fx.root);
      await mkdir(escapeDir, { recursive: true });
      const foreign = join(escapeDir, "x.lock");
      let held: HardenedLockHandle | null = await acquireHardenedLock(foreign);
      const bytes = readFileSync(foreign);
      const inode = statSync(foreign).ino;
      const external: string[] = [];
      lockTesting.setAfterBusyAcquireAttemptHook(async (lockPath) => {
        if (lockPath.startsWith(paths.busRoot)) return;
        external.push(lockPath);
        // Let the old code finish: release the foreign lock on its first external attempt.
        if (held) { const h = held; held = null; await releaseHardenedLock(h); }
      });
      try {
        await within(cleanupWaiter(paths, evil, identity()), A6C_DEADLINE_MS, "cleanupWaiter");
        expect(external).toEqual([]);
        expect(readFileSync(foreign).equals(bytes)).toBe(true);
        expect(statSync(foreign).ino).toBe(inode);
      } finally {
        lockTesting.setAfterBusyAcquireAttemptHook(null);
        if (held) await releaseHardenedLock(held).catch(() => undefined);
      }
    }, 2 * A6C_DEADLINE_MS);
  });
});
