/**
 * T-489 wake entry chain safety.
 *
 * A wake entry appends through `thread-<id>.lock` with a fresh fold INSIDE the
 * lock. The failure this guards against is not theoretical: the two participants
 * hold DIFFERENT endpoint locks, so an endpoint-locked append racing a peer's
 * reply computes the same `seq` and `prevHash`, publishes a conflicting entry and
 * quarantines the thread. Catching the error afterwards cannot unpublish it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWakeEntry,
  foldBusThread,
  initializeBus,
  joinEndpoint,
  sendBusMessage,
} from "../../src/bus/index.js";
import { initProject } from "../../src/core/init.js";
import { withHardenedLock } from "../../src/bus/lock.js";
import { resolveBusPaths } from "../../src/bus/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function twoEndpointThread(): Promise<{
  root: string;
  threadId: string;
  fromEndpointId: string;
  toEndpointId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "t489-wake-entry-"));
  roots.push(root);
  await initProject(root, { name: "t489-wake" });
  await initializeBus(root);
  const a = (
    await joinEndpoint(root, { client: "claude", clientTaskId: "task-a", surface: "claude_cli" })
  ).endpoint;
  const b = (
    await joinEndpoint(root, { client: "codex", clientTaskId: "task-b", surface: "codex_cli" })
  ).endpoint;
  const sent = await sendBusMessage(root, {
    endpointId: a.endpointId,
    clientTaskId: "task-a",
    to: b.endpointId,
    threadKind: "question",
    body: "first message",
    messageKind: "question",
    severity: "info",
    refs: { ciRun: "ci-t489-wake" },
    idempotencyKey: randomUUID(),
  });
  return {
    root,
    threadId: sent.threadId,
    fromEndpointId: a.endpointId,
    toEndpointId: b.endpointId,
  };
}

function wakePayload(endpointId: string, batchCursor: number, action: "requested" | "failed") {
  return {
    wakeId: randomUUID(),
    endpointId,
    // ALWAYS 1 in this cut. The schema's 1..3 range is preserved untouched for a
    // future cut that adds retries.
    attempt: 1 as const,
    batchCursor,
    action,
    ...(action === "failed" ? { reason: "version:absent" } : {}),
  };
}

describe("T-489 wake entry appends safely on the hash chain", () => {
  it("lands with a contiguous seq and leaves the thread verified", async () => {
    const { root, threadId, toEndpointId } = await twoEndpointThread();
    const before = await foldBusThread(root, threadId);
    expect(before.integrity).toBe("verified");

    await appendWakeEntry(root, threadId, wakePayload(toEndpointId, 1, "requested"));

    const after = await foldBusThread(root, threadId);
    expect(after.integrity).toBe("verified");
    expect(after.validThroughSeq).toBe(before.validThroughSeq + 1);
  });

  it("does NOT advance hopCount", async () => {
    // fold.ts increments hopCount only inside `entry.type === "message"`. Pinned
    // rather than assumed: a wake that consumed a hop would silently shorten every
    // conversation it touched.
    const { root, threadId, toEndpointId } = await twoEndpointThread();
    const before = await foldBusThread(root, threadId);

    await appendWakeEntry(root, threadId, wakePayload(toEndpointId, 1, "requested"));
    await appendWakeEntry(root, threadId, wakePayload(toEndpointId, 1, "failed"));

    const after = await foldBusThread(root, threadId);
    expect(after.hopCount).toBe(before.hopCount);
    expect(after.integrity).toBe("verified");
  });

  it("preserves existing message pointers", async () => {
    const { root, threadId, toEndpointId } = await twoEndpointThread();
    const before = await foldBusThread(root, threadId);
    const messagesBefore = before.messages.map((m) => m.messageId);

    await appendWakeEntry(root, threadId, wakePayload(toEndpointId, 1, "requested"));

    const after = await foldBusThread(root, threadId);
    expect(after.messages.map((m) => m.messageId)).toEqual(messagesBefore);
  });

  it("keeps the chain contiguous and verified under CONCURRENT wake appends", async () => {
    const { root, threadId, toEndpointId } = await twoEndpointThread();
    const before = await foldBusThread(root, threadId);

    // Without the thread lock and the fresh fold inside it, these compute the same
    // seq/prevHash and quarantine the thread.
    await Promise.all([
      appendWakeEntry(root, threadId, wakePayload(toEndpointId, 1, "requested")),
      appendWakeEntry(root, threadId, wakePayload(toEndpointId, 2, "failed")),
      appendWakeEntry(root, threadId, wakePayload(toEndpointId, 3, "failed")),
    ]);

    const after = await foldBusThread(root, threadId);
    expect(after.integrity).toBe("verified");
    expect(after.validThroughSeq).toBe(before.validThroughSeq + 3);
    expect(after.hopCount).toBe(before.hopCount);
  });

  it("keeps the chain verified when a wake races a real message append", async () => {
    const { root, threadId, toEndpointId, fromEndpointId } = await twoEndpointThread();
    const before = await foldBusThread(root, threadId);

    // REPEATED deliberately. A single race is not a reliable probe: the colliding
    // interleaving is a narrow window, and a wake appending under a lock OTHER than
    // the thread lock passed a one-shot version of this test every time. Repeating
    // the race is what makes the assertion bind on the lock choice rather than on
    // luck. Both participants send, so the wake races an append from each side.
    const ROUNDS = 8;
    for (let i = 0; i < ROUNDS; i++) {
      const sender = i % 2 === 0 ? toEndpointId : fromEndpointId;
      const recipient = i % 2 === 0 ? fromEndpointId : toEndpointId;
      const task = i % 2 === 0 ? "task-b" : "task-a";
      await Promise.all([
        appendWakeEntry(root, threadId, wakePayload(toEndpointId, i + 1, "requested")),
        sendBusMessage(root, {
          endpointId: sender,
          clientTaskId: task,
          to: recipient,
          threadId,
          body: `status ${String(i)} racing the wake`,
          // NON-actionable on purpose: `reply` counts toward the hop cap, and at
          // eight rounds the thread parks mid-loop, which would make this test
          // fail for a reason that has nothing to do with lock discipline.
          messageKind: "status",
          severity: "info",
          idempotencyKey: randomUUID(),
        }),
      ]);
      const mid = await foldBusThread(root, threadId);
      expect(mid.integrity).toBe("verified");
    }

    const after = await foldBusThread(root, threadId);
    expect(after.integrity).toBe("verified");
    expect(after.validThroughSeq).toBe(before.validThroughSeq + ROUNDS * 2);
    // The status messages ARE messages, so they appear in the message list; the
    // wakes do not.
    expect(after.messages.length).toBe(before.messages.length + ROUNDS);
  });

  it("BLOCKS on the thread lock specifically, not on a lock of its own", async () => {
    // Racing two appends cannot prove which lock is held: the colliding window is
    // narrow enough that a wake using its OWN lock passed an 8-round race every
    // time. So assert the lock IDENTITY directly. Hold `thread-<id>.lock`, and the
    // append must not finish until it is released. A wake on any other lock sails
    // straight through and this fails.
    const { root, threadId, toEndpointId } = await twoEndpointThread();
    const paths = await resolveBusPaths(root);

    let finished = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const lockHeld = withHardenedLock(join(paths.locks, `thread-${threadId}.lock`), async () => {
      // Signal that the lock is genuinely held before the append starts.
      lockAcquired();
      await held;
    });
    let lockAcquiredResolve!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquiredResolve = resolve;
    });
    function lockAcquired(): void {
      lockAcquiredResolve();
    }
    await acquired;

    const append = appendWakeEntry(root, threadId, wakePayload(toEndpointId, 1, "requested"))
      .then(() => {
        finished = true;
      });

    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
    } finally {
      // Release in `finally`, or a FAILING assertion leaves the lock held and the
      // append pending while afterEach deletes the root: the teardown then fails
      // too, precisely when the test has caught a real regression and its message
      // matters most.
      release();
      await lockHeld;
      await append.catch(() => undefined);
    }
    expect(finished).toBe(true);

    const after = await foldBusThread(root, threadId);
    expect(after.integrity).toBe("verified");
  });

  it("refuses an invalid thread id rather than writing somewhere unexpected", async () => {
    const { root, toEndpointId } = await twoEndpointThread();
    await expect(
      appendWakeEntry(root, "../escape", wakePayload(toEndpointId, 1, "requested")),
    ).rejects.toThrow();
  });
});
