/**
 * ISS-741: always-on inbox sweep + start/stop lifecycle.
 *
 * fs.watch on macOS can permanently miss the rename event for a file written
 * right after watcher (re)establishment, and the 2s polling fallback only
 * engages on watcher ERROR -- a silently missed event strands the file. The
 * watcher therefore runs an always-on low-frequency sweep (10s, unref'd) that
 * funnels through the same 100ms debounce.
 *
 * Lifecycle: a second startInboxWatcher call must clear every timer created
 * by the first start (sweep, polling fallback, debounce) -- they capture the
 * OLD root's inboxPath in their closures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startInboxWatcher,
  stopInboxWatcher,
  _inboxWatcherTimersForTest,
  _closeWatcherForTest,
} from "../../src/channel/inbox-watcher.js";

function createMockServer() {
  const notifications: Array<{ method: string; params: unknown }> = [];
  return {
    notifications,
    server: {
      sendNotification: async (msg: { method: string; params: unknown }) => {
        notifications.push(msg);
      },
    },
  };
}

async function writeEvent(inboxPath: string, event: string, timestamp: string): Promise<void> {
  const data = JSON.stringify({ event, timestamp, payload: {} });
  await writeFile(join(inboxPath, `${timestamp}-${event}.json`), data, "utf-8");
}

describe("inbox-watcher always-on sweep (ISS-741)", () => {
  let root: string;
  let inboxPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cw-sweep-"));
    inboxPath = join(root, ".story", "channel-inbox");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    stopInboxWatcher();
    await rm(root, { recursive: true, force: true });
  });

  it("starts an unref'd sweep interval on start and clears it on stop", async () => {
    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    const timers = _inboxWatcherTimersForTest();
    expect(timers.sweep).not.toBeNull();
    // The sweep must never keep the MCP server process alive.
    expect(timers.sweep!.hasRef()).toBe(false);

    stopInboxWatcher();
    expect(_inboxWatcherTimersForTest().sweep).toBeNull();
  });

  it("double-start clears the previous start's timers (sweep bound to the OLD root)", async () => {
    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);
    const firstSweep = _inboxWatcherTimersForTest().sweep;
    expect(firstSweep).not.toBeNull();

    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    // Second start (same process, new root) must clear the first sweep, not
    // leak an interval bound to the old root's closure.
    const root2 = await mkdtemp(join(tmpdir(), "cw-sweep2-"));
    try {
      await startInboxWatcher(root2, mock as any);
      const secondSweep = _inboxWatcherTimersForTest().sweep;
      expect(secondSweep).not.toBeNull();
      expect(secondSweep).not.toBe(firstSweep);
      expect(clearIntervalSpy.mock.calls.some(([handle]) => handle === firstSweep)).toBe(true);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  it("sweep consumes a file the FSWatcher missed", async () => {
    vi.useFakeTimers();
    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    // Simulate the ISS-741 failure mode: the watcher silently misses the
    // rename for a file written right after (re)establishment. Closing the
    // watcher guarantees no rename event fires, so only the sweep can recover.
    _closeWatcherForTest();
    await writeEvent(inboxPath, "pause_session", "2026-04-05T10:00:00.000Z");

    // Sweep tick (10s) schedules the debounced process; debounce fires at 100ms.
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(100);
    vi.useRealTimers();

    // processInbox runs on real I/O; wait for consumption.
    const deadline = Date.now() + 5_000;
    let jsonFiles: string[];
    do {
      jsonFiles = (await readdir(inboxPath)).filter((f) => f.endsWith(".json"));
      if (jsonFiles.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);

    expect(jsonFiles).toHaveLength(0);
    expect(mock.notifications.length).toBeGreaterThanOrEqual(1);
    // ISS-901: the sweep itself is fake-timer advanced, so this test is not
    // waiting 10s of wall clock. What remains real is the processInbox I/O
    // poll above, whose deadline is 5s -- exactly equal to vitest's default
    // testTimeout, leaving zero margin: the harness fires at the same instant
    // the test's own deadline would, so the poll can never actually spend the
    // budget it was given.
    //
    // Both paths measured. PASSING path (the sweep recovers the file, which is
    // the path this test exists to exercise): 67/69/71/73/81ms under 12 CPU
    // spinners (n=5, max 81ms).
    //
    // FAILING path, measured by mutation (skip the sweep advance so the file
    // is never consumed): end-to-end 5034ms, ending in the real assertion
    // "expected [Array(1)] to have a length of +0 but got 1". That 5034ms is
    // the whole bug in one number -- it lands 34ms past the 5000ms default
    // cap, so the harness killed this test immediately BEFORE its own
    // assertion could fire, converting a precise failure into "Test timed out
    // in 5000ms". 10s accommodates the measured 5.034s worst case with ~4.97s
    // of scheduler margin. The global 5s cap is unchanged.
  }, 10_000);
});
