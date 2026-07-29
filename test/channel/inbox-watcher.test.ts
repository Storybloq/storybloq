import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startInboxWatcher,
  stopInboxWatcher,
  _inboxWatcherTimersForTest,
} from "../../src/channel/inbox-watcher.js";

/** Minimal mock of McpServer with notification capture. */
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

/** Write a valid channel event file to the inbox directory. */
async function writeEvent(
  inboxPath: string,
  event: string,
  payload: Record<string, unknown>,
  timestamp?: string,
): Promise<string> {
  const ts = timestamp ?? new Date().toISOString();
  const filename = `${ts}-${event}.json`;
  const data = JSON.stringify({ event, timestamp: ts, payload });
  await writeFile(join(inboxPath, filename), data, "utf-8");
  return filename;
}

describe("inbox-watcher", () => {
  let root: string;
  let inboxPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cw-test-"));
    inboxPath = join(root, ".story", "channel-inbox");
    // Don't create inbox dir -- startInboxWatcher should create it
  });

  afterEach(async () => {
    stopInboxWatcher();
    await rm(root, { recursive: true, force: true });
  });

  it("creates inbox directory if it does not exist", async () => {
    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);
    const entries = await readdir(join(root, ".story", "channel-inbox"));
    expect(entries).toBeDefined();
  });

  it("processes existing event files on startup", async () => {
    await mkdir(inboxPath, { recursive: true });
    await writeEvent(inboxPath, "ticket_requested", { ticketId: "T-001" }, "2026-04-05T10:00:00.000Z");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    // File should be consumed
    const remaining = await readdir(inboxPath);
    const jsonFiles = remaining.filter((f) => f.endsWith(".json"));
    expect(jsonFiles).toHaveLength(0);

    // Notification should have been sent
    expect(mock.notifications).toHaveLength(1);
    expect(mock.notifications[0].params).toHaveProperty("content");
  });

  it("deletes consumed event files", async () => {
    await mkdir(inboxPath, { recursive: true });
    await writeEvent(inboxPath, "pause_session", {}, "2026-04-05T10:00:01.000Z");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    const remaining = await readdir(inboxPath);
    expect(remaining.filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("moves invalid JSON to .failed/", async () => {
    await mkdir(inboxPath, { recursive: true });
    const filename = "2026-04-05T10:00:00.000Z-ticket_requested.json";
    await writeFile(join(inboxPath, filename), "NOT JSON{{{", "utf-8");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    // Original file gone from inbox
    const remaining = await readdir(inboxPath);
    expect(remaining.filter((f) => f.endsWith(".json"))).toHaveLength(0);

    // File moved to .failed/
    const failedDir = join(inboxPath, ".failed");
    const failed = await readdir(failedDir);
    expect(failed).toContain(filename);
  });

  it("moves invalid schema to .failed/", async () => {
    await mkdir(inboxPath, { recursive: true });
    const filename = "2026-04-05T10:00:00.000Z-ticket_requested.json";
    // Valid JSON but invalid schema (missing payload)
    await writeFile(join(inboxPath, filename), JSON.stringify({ event: "ticket_requested", timestamp: "2026-04-05T10:00:00Z" }), "utf-8");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    const failedDir = join(inboxPath, ".failed");
    const failed = await readdir(failedDir);
    expect(failed).toContain(filename);
  });

  it("rejects filenames with path traversal", async () => {
    await mkdir(inboxPath, { recursive: true });
    // Write a file with a dangerous name (simulating an attack)
    const badFilename = "..%2F..%2Fetc%2Fpasswd.json";
    await writeFile(join(inboxPath, badFilename), JSON.stringify({ event: "pause_session", timestamp: "2026-04-05T10:00:00Z", payload: {} }), "utf-8");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    // Should not have sent any notification
    expect(mock.notifications).toHaveLength(0);
  });

  it("processes multiple events in timestamp order", async () => {
    await mkdir(inboxPath, { recursive: true });
    await writeEvent(inboxPath, "ticket_requested", { ticketId: "T-002" }, "2026-04-05T10:00:02.000Z");
    await writeEvent(inboxPath, "ticket_requested", { ticketId: "T-001" }, "2026-04-05T10:00:01.000Z");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    expect(mock.notifications).toHaveLength(2);
    // First notification should be for T-001 (earlier timestamp)
    const firstContent = (mock.notifications[0].params as any).content as string;
    expect(firstContent).toContain("T-001");
  });

  it("drains all files when inbox exceeds max depth", async () => {
    await mkdir(inboxPath, { recursive: true });
    // Write 51 valid event files (exceeds MAX_INBOX_DEPTH of 50)
    const promises: Promise<string>[] = [];
    for (let i = 0; i < 51; i++) {
      const ts = `2026-04-05T10:00:${String(i).padStart(2, "0")}.000Z`;
      promises.push(writeEvent(inboxPath, "pause_session", {}, ts));
    }
    await Promise.all(promises);

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    // Should have processed all 51 events across 2 batches (50 + 1)
    expect(mock.notifications).toHaveLength(51);

    // No files should remain
    const remaining = await readdir(inboxPath);
    expect(remaining.filter((f) => f.endsWith(".json")).length).toBe(0);
  });

  it("retries non-permission events on notification failure", async () => {
    await mkdir(inboxPath, { recursive: true });
    await writeEvent(inboxPath, "ticket_requested", { ticketId: "T-001" }, new Date().toISOString());

    // Create a mock that throws on sendNotification
    const mock = {
      server: {
        sendNotification: async () => {
          throw new Error("Channel unavailable");
        },
      },
    };

    await startInboxWatcher(root, mock as any);

    // Event file should be renamed back to .json for retry (not consumed)
    const remaining = await readdir(inboxPath);
    expect(remaining.filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  it("quarantines expired non-permission events on notification failure", async () => {
    await mkdir(inboxPath, { recursive: true });
    // Event with timestamp >60s ago
    const expired = new Date(Date.now() - 120_000).toISOString();
    await writeEvent(inboxPath, "ticket_requested", { ticketId: "T-001" }, expired);

    const mock = {
      server: {
        sendNotification: async () => {
          throw new Error("Channel unavailable");
        },
      },
    };

    await startInboxWatcher(root, mock as any);

    // Expired event should be moved to .failed, not left for retry
    const remaining = await readdir(inboxPath);
    const jsonFiles = remaining.filter((f) => f.endsWith(".json"));
    expect(jsonFiles).toHaveLength(0);
    // Should be in .failed directory
    const failedDir = join(inboxPath, ".failed");
    const failed = await readdir(failedDir);
    expect(failed.length).toBe(1);
  });

  it("routes permission_response to notifications/claude/channel/permission", async () => {
    await mkdir(inboxPath, { recursive: true });
    await writeEvent(inboxPath, "permission_response", { requestId: "aBc12", behavior: "approve" }, "2026-04-05T10:00:00.000Z");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    expect(mock.notifications).toHaveLength(1);
    // Permission responses must use the permission-specific notification method
    expect(mock.notifications[0].method).toBe("notifications/claude/channel/permission");
    // Params should include requestId and behavior directly
    const params = mock.notifications[0].params as any;
    expect(params.requestId).toBe("aBc12");
    expect(params.behavior).toBe("approve");
  });

  it("routes regular events to notifications/claude/channel", async () => {
    await mkdir(inboxPath, { recursive: true });
    await writeEvent(inboxPath, "ticket_requested", { ticketId: "T-001" }, "2026-04-05T10:00:00.000Z");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    expect(mock.notifications).toHaveLength(1);
    expect(mock.notifications[0].method).toBe("notifications/claude/channel");
  });

  it("does not leak FSWatcher when startInboxWatcher is called twice", async () => {
    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);
    // Call again -- should close first watcher, not leak
    await startInboxWatcher(root, mock as any);

    // ISS-901: silence the always-on 10s sweep so ONLY the live FSWatcher can
    // satisfy the assertions below. They check that the file was consumed and
    // a notification landed, which the sweep can also accomplish -- so with a
    // local timeout long enough to let the sweep run, a broken or leaked
    // second watcher would still pass and this test would silently stop
    // testing what its name claims. The old 5s harness cap was enforcing that
    // by accident, not by design; disabling the sweep enforces it on purpose.
    // Sweep recovery stays covered by inbox-watcher-sweep.test.ts.
    const sweep = _inboxWatcherTimersForTest().sweep;
    if (sweep) clearInterval(sweep);

    // Write an event after the second start to verify it's functional
    await writeEvent(inboxPath, "pause_session", {}, "2026-04-05T10:00:00.000Z");

    // ISS-741 (was ISS-444): a fixed sleep loses the race under parallel
    // full-suite load (~50% failure rate observed at 1000ms). Poll until the
    // watcher consumes the file AND the notification lands (a poll landing in
    // the rename-to-.processing claim window sees zero .json files before the
    // notification is sent). ISS-901: this deadline was originally sized to
    // cover the always-on 10s sweep recovering a missed watcher event, but the
    // sweep is now cleared above so it cannot stand in for the watcher; what
    // the deadline buys today is a real assertion failure instead of a harness
    // timeout when the watcher genuinely does not deliver.
    const deadline = Date.now() + 15_000;
    let jsonFiles: string[];
    do {
      jsonFiles = (await readdir(inboxPath)).filter((f) => f.endsWith(".json"));
      if (jsonFiles.length === 0 && mock.notifications.length >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);

    // The event should be processed by the second watcher
    expect(jsonFiles).toHaveLength(0);
    expect(mock.notifications.length).toBeGreaterThanOrEqual(1);
    // ISS-901: this test polls to its own 15s deadline, but vitest's default
    // testTimeout is 5s, so it was killed a third of the way into the
    // tolerance it was deliberately given, and could not report a real
    // assertion when it lost the race.
    //
    // Why 20s, both paths measured. PASSING path (watcher delivers):
    // 158/159/160/165/212ms unloaded and 169/171/173/178/205ms under 12 CPU
    // spinners (n=10, max 212ms) -- nothing slow remains on a green run.
    //
    // The budget is sized for the FAILING run, and that is the number that
    // matters. Measured by mutation (close the watcher so it cannot deliver,
    // sweep already cleared): end-to-end 15050ms, ending in the real assertion
    // "expected [Array(1)] to have a length of +0 but got 1" rather than an
    // opaque "Test timed out in 5000ms". So 15.05s is the measured worst case
    // and 20s accommodates it with ~4.95s of scheduler margin. Under the old
    // 5s cap this failure mode could not report itself at all.
    //
    // Not a blanket raise: the global 5s cap is unchanged and still applies
    // everywhere else, so a genuinely slow operation stays visible.
  }, 20_000);

  it("recovers stale .processing files on startup", async () => {
    await mkdir(inboxPath, { recursive: true });
    // Simulate a stale .processing file left by a crashed previous run
    const staleFilename = "2026-04-05T10:00:00.000Z-ticket_requested.json.processing";
    const eventData = JSON.stringify({
      event: "ticket_requested",
      timestamp: "2026-04-05T10:00:00.000Z",
      payload: { ticketId: "T-099" },
    });
    await writeFile(join(inboxPath, staleFilename), eventData, "utf-8");

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    // The .processing file should have been recovered and processed
    const remaining = await readdir(inboxPath);
    const allFiles = remaining.filter((f) => !f.startsWith("."));
    expect(allFiles).toHaveLength(0);
    expect(mock.notifications).toHaveLength(1);
  });

  it("trims .failed/ directory beyond max", async () => {
    await mkdir(inboxPath, { recursive: true });
    const failedDir = join(inboxPath, ".failed");
    await mkdir(failedDir, { recursive: true });

    // Write 25 files to .failed/ (exceeds MAX_FAILED_FILES of 20)
    for (let i = 0; i < 25; i++) {
      const ts = `2026-04-05T10:${String(i).padStart(2, "0")}:00.000Z`;
      const filename = `${ts}-bad_event.json`;
      await writeFile(join(failedDir, filename), "bad", "utf-8");
    }

    const mock = createMockServer();
    await startInboxWatcher(root, mock as any);

    const remaining = await readdir(failedDir);
    expect(remaining.filter((f) => f.endsWith(".json")).length).toBeLessThanOrEqual(20);
  });
});
