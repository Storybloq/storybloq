/**
 * Channel inbox watcher.
 *
 * Watches .story/channel-inbox/ for event files written by the Mac app,
 * validates them, and sends them as MCP channel notifications to Claude Code.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, unlink, rename, mkdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChannelEventSchema, isValidInboxFilename, formatChannelContent, formatChannelMeta } from "./events.js";

const INBOX_DIR = "channel-inbox";
const FAILED_DIR = ".failed";
const MAX_INBOX_DEPTH = 50;
const MAX_FAILED_FILES = 20;
const DEBOUNCE_MS = 100;

let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Starts watching .story/channel-inbox/ for event files.
 * Sends validated events as MCP channel notifications.
 */
export async function startInboxWatcher(root: string, server: McpServer): Promise<void> {
  const inboxPath = join(root, ".story", INBOX_DIR);

  // Ensure inbox directory exists
  await mkdir(inboxPath, { recursive: true });

  // Process any existing files on startup
  await processInbox(inboxPath, server);

  // Watch for new files
  try {
    watcher = watch(inboxPath, (eventType) => {
      if (eventType === "rename") {
        // "rename" fires for both creation and deletion on macOS
        scheduleDebouncedProcess(inboxPath, server);
      }
    });

    watcher.on("error", (err) => {
      process.stderr.write(`claudestory: channel inbox watcher error: ${err.message}\n`);
      // Watcher died; fall back to periodic polling
      startPollingFallback(inboxPath, server);
    });

    process.stderr.write(`claudestory: channel inbox watcher started at ${inboxPath}\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`claudestory: failed to start inbox watcher, using polling fallback: ${msg}\n`);
    startPollingFallback(inboxPath, server);
  }
}

/**
 * Stops the inbox watcher. Called on process shutdown.
 */
export function stopInboxWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// MARK: - Debounce

function scheduleDebouncedProcess(inboxPath: string, server: McpServer): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    processInbox(inboxPath, server).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`claudestory: inbox processing error: ${msg}\n`);
    });
  }, DEBOUNCE_MS);
}

// MARK: - Polling Fallback

let pollInterval: ReturnType<typeof setInterval> | null = null;

function startPollingFallback(inboxPath: string, server: McpServer): void {
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    processInbox(inboxPath, server).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`claudestory: poll processing error: ${msg}\n`);
    });
  }, 2000);
}

// MARK: - Inbox Processing

async function processInbox(inboxPath: string, server: McpServer): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(inboxPath);
  } catch {
    return; // Directory may not exist yet
  }

  // Filter to valid JSON files (exclude .failed/ directory and hidden files)
  const eventFiles = entries
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort(); // Process in timestamp order

  // Backpressure: skip if inbox is overloaded
  if (eventFiles.length > MAX_INBOX_DEPTH) {
    process.stderr.write(
      `claudestory: channel inbox has ${eventFiles.length} files (max ${MAX_INBOX_DEPTH}), skipping until consumer catches up\n`,
    );
    return;
  }

  for (const filename of eventFiles) {
    await processEventFile(inboxPath, filename, server);
  }

  // Housekeeping: trim .failed/ directory
  await trimFailedDirectory(inboxPath);
}

async function processEventFile(inboxPath: string, filename: string, server: McpServer): Promise<void> {
  // Step 1: Validate filename (path traversal protection)
  if (!isValidInboxFilename(filename)) {
    process.stderr.write(`claudestory: rejecting invalid inbox filename: ${filename}\n`);
    await moveToFailed(inboxPath, filename);
    return;
  }

  const filePath = join(inboxPath, filename);

  // Step 2: Read file
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return; // File may have been deleted between readdir and readFile
  }

  // Step 3: Parse and validate immediately (no intermediate routing)
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`claudestory: invalid JSON in channel event ${filename}\n`);
    await moveToFailed(inboxPath, filename);
    return;
  }

  const result = ChannelEventSchema.safeParse(parsed);
  if (!result.success) {
    process.stderr.write(`claudestory: invalid channel event schema in ${filename}: ${result.error.message}\n`);
    await moveToFailed(inboxPath, filename);
    return;
  }

  const event = result.data;

  // Step 4: Format and send channel notification
  const content = formatChannelContent(event);
  const meta = formatChannelMeta(event);

  try {
    await server.server.sendNotification({
      method: "notifications/claude/channel" as any,
      params: { channel: "claudestory", content, meta },
    });
    process.stderr.write(`claudestory: sent channel event ${event.event}\n`);
  } catch (err: unknown) {
    // Channel notifications may fail if channels are not available (gated, no OAuth, etc.)
    // This is expected -- log and continue. The event is still consumed.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`claudestory: channel notification failed (expected if channels unavailable): ${msg}\n`);
  }

  // Step 5: Delete consumed event file
  try {
    await unlink(filePath);
  } catch {
    // Best effort -- file may already be gone
  }
}

// MARK: - Failed File Handling

async function moveToFailed(inboxPath: string, filename: string): Promise<void> {
  const failedDir = join(inboxPath, FAILED_DIR);
  try {
    await mkdir(failedDir, { recursive: true });
    await rename(join(inboxPath, filename), join(failedDir, filename));
  } catch (err: unknown) {
    // Best effort -- if we can't move it, try to delete it
    try {
      await unlink(join(inboxPath, filename));
    } catch {
      // Give up
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`claudestory: failed to move ${filename} to .failed/: ${msg}\n`);
  }
}

async function trimFailedDirectory(inboxPath: string): Promise<void> {
  const failedDir = join(inboxPath, FAILED_DIR);
  let files: string[];
  try {
    files = await readdir(failedDir);
  } catch {
    return; // .failed/ may not exist
  }

  if (files.length <= MAX_FAILED_FILES) return;

  // Sort by name (timestamp-based) and delete oldest
  const sorted = files.filter((f) => f.endsWith(".json")).sort();
  const toDelete = sorted.slice(0, sorted.length - MAX_FAILED_FILES);
  for (const f of toDelete) {
    try {
      await unlink(join(failedDir, f));
    } catch {
      // Best effort
    }
  }
}
