import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startInboxWatcher, stopInboxWatcher } from "../../src/channel/inbox-watcher.js";

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

  it("processes bounded subset when inbox exceeds max depth", async () => {
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

    // Should have processed the first 50 events (bounded subset)
    expect(mock.notifications).toHaveLength(50);

    // 1 file should remain unprocessed
    const remaining = await readdir(inboxPath);
    expect(remaining.filter((f) => f.endsWith(".json")).length).toBe(1);
  });

  it("handles notification failure gracefully", async () => {
    await mkdir(inboxPath, { recursive: true });
    await writeEvent(inboxPath, "ticket_requested", { ticketId: "T-001" }, "2026-04-05T10:00:00.000Z");

    // Create a mock that throws on sendNotification
    const mock = {
      server: {
        sendNotification: async () => {
          throw new Error("Channel unavailable");
        },
      },
    };

    await startInboxWatcher(root, mock as any);

    // Event file should still be consumed even if notification fails
    const remaining = await readdir(inboxPath);
    expect(remaining.filter((f) => f.endsWith(".json"))).toHaveLength(0);
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

    // Write an event after the second start to verify it's functional
    await writeEvent(inboxPath, "pause_session", {}, "2026-04-05T10:00:00.000Z");
    // Give the fs watcher a moment to trigger
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The event should be processed by the second watcher
    const remaining = await readdir(inboxPath);
    const jsonFiles = remaining.filter((f) => f.endsWith(".json"));
    expect(jsonFiles).toHaveLength(0);
    expect(mock.notifications.length).toBeGreaterThanOrEqual(1);
  });

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
