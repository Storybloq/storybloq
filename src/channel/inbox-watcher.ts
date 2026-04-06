/**
 * Channel inbox watcher.
 *
 * Watches .story/channel-inbox/ for event files written by the Mac app,
 * validates them, and sends them as MCP channel notifications to Claude Code.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, unlink, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ChannelEventSchema, isValidInboxFilename, formatChannelContent, formatChannelMeta } from "./events.js";

const INBOX_DIR = "channel-inbox";
const FAILED_DIR = ".failed";
const MAX_INBOX_DEPTH = 50;
const MAX_FAILED_FILES = 20;
const DEBOUNCE_MS = 100;
const MAX_PERMISSION_RETRIES = 15;

let watcher: FSWatcher | null = null;
const permissionRetryCount = new Map<string, number>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Starts watching .story/channel-inbox/ for event files.
 * Sends validated events as MCP channel notifications.
 */
export async function startInboxWatcher(root: string, server: McpServer): Promise<void> {
  const inboxPath = join(root, ".story", INBOX_DIR);

  // Close existing watcher if called again (prevents FSWatcher leak)
  if (watcher) {
    watcher.close();
    watcher = null;
    permissionRetryCount.clear();
  }

  // Ensure inbox directory exists
  await mkdir(inboxPath, { recursive: true });

  // Recover stale .processing files from interrupted previous runs (startup only)
  await recoverStaleProcessingFiles(inboxPath);

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
  permissionRetryCount.clear();
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

// MARK: - Stale Processing Recovery (startup only)

async function recoverStaleProcessingFiles(inboxPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(inboxPath);
  } catch {
    return;
  }
  for (const f of entries) {
    if (f.endsWith(".processing")) {
      const originalName = f.slice(0, -".processing".length);
      try {
        await rename(join(inboxPath, f), join(inboxPath, originalName));
        process.stderr.write(`claudestory: recovered stale processing file: ${f}\n`);
      } catch {
        // Best effort -- file may have been cleaned up
      }
    }
  }
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
  const processingPath = join(inboxPath, `${filename}.processing`);

  // Step 1.5: Atomic claim -- rename to .processing before reading.
  // If another poll cycle runs concurrently, the rename will fail for the loser.
  try {
    await rename(filePath, processingPath);
  } catch {
    return; // Another handler already claimed this file
  }

  // Step 2: Read file (from .processing path)
  let raw: string;
  try {
    raw = await readFile(processingPath, "utf-8");
  } catch {
    return; // File may have been deleted between rename and readFile
  }

  // Step 3: Parse and validate immediately (no intermediate routing)
  // Note: after atomic claim, moveToFailed uses the .processing filename
  const processingFilename = `${filename}.processing`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`claudestory: invalid JSON in channel event ${filename}\n`);
    await moveToFailed(inboxPath, processingFilename, filename);
    return;
  }

  const result = ChannelEventSchema.safeParse(parsed);
  if (!result.success) {
    process.stderr.write(`claudestory: invalid channel event schema in ${filename}: ${result.error.message}\n`);
    await moveToFailed(inboxPath, processingFilename, filename);
    return;
  }

  const event = result.data;

  // Step 4: Format and send channel notification
  try {
    if (event.event === "permission_response") {
      // Permission responses use a dedicated notification method with direct params
      await server.server.sendNotification({
        method: "notifications/claude/channel/permission" as any,
        params: {
          requestId: event.payload.requestId,
          behavior: event.payload.behavior,
        },
      });
    } else {
      const content = formatChannelContent(event);
      const meta = formatChannelMeta(event);
      await server.server.sendNotification({
        method: "notifications/claude/channel" as any,
        params: { content, meta },
      });
    }
    process.stderr.write(`claudestory: sent channel event ${event.event}\n`);
    // Clear retry tracking on success
    permissionRetryCount.delete(filename);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (event.event === "permission_response") {
      // Permission verdicts must not be silently dropped, but cap retries to prevent inbox stagnation.
      const retries = (permissionRetryCount.get(filename) ?? 0) + 1;
      permissionRetryCount.set(filename, retries);
      if (retries >= MAX_PERMISSION_RETRIES) {
        process.stderr.write(`claudestory: permission notification failed after ${retries} retries, quarantining: ${msg}\n`);
        permissionRetryCount.delete(filename);
        await moveToFailed(inboxPath, processingFilename, filename);
        return;
      }
      // Rename back to .json so it's picked up on the next cycle
      try {
        await rename(processingPath, filePath);
      } catch (renameErr: unknown) {
        // Rename-back failed -- quarantine to prevent permanent orphan as .processing
        const renameMsg = renameErr instanceof Error ? renameErr.message : String(renameErr);
        process.stderr.write(`claudestory: rename-back failed for ${filename}, quarantining: ${renameMsg}\n`);
        permissionRetryCount.delete(filename);
        await moveToFailed(inboxPath, processingFilename, filename);
        return;
      }
      process.stderr.write(`claudestory: permission notification failed (attempt ${retries}/${MAX_PERMISSION_RETRIES}), keeping for retry: ${msg}\n`);
      return;
    }
    // Other channel notifications may fail if channels are not available (gated, no OAuth, etc.)
    // This is expected -- log and continue. The event is still consumed.
    process.stderr.write(`claudestory: channel notification failed (expected if channels unavailable): ${msg}\n`);
  }

  // Step 5: Delete consumed event file (.processing)
  try {
    await unlink(processingPath);
  } catch {
    // Best effort -- file may already be gone
  }
}

// MARK: - Failed File Handling

async function moveToFailed(inboxPath: string, sourceFilename: string, destFilename?: string): Promise<void> {
  const failedDir = join(inboxPath, FAILED_DIR);
  const targetName = destFilename ?? sourceFilename;
  try {
    await mkdir(failedDir, { recursive: true });
    await rename(join(inboxPath, sourceFilename), join(failedDir, targetName));
  } catch (err: unknown) {
    // Best effort -- if we can't move it, try to delete it
    try {
      await unlink(join(inboxPath, sourceFilename));
    } catch {
      // Give up
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`claudestory: failed to move ${sourceFilename} to .failed/: ${msg}\n`);
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

  // Filter to .json before guard -- non-JSON entries (.DS_Store etc.) must not inflate the count
  const sorted = files.filter((f) => f.endsWith(".json")).sort();
  if (sorted.length <= MAX_FAILED_FILES) return;

  // Delete oldest to stay under cap
  const toDelete = sorted.slice(0, sorted.length - MAX_FAILED_FILES);
  for (const f of toDelete) {
    try {
      await unlink(join(failedDir, f));
    } catch {
      // Best effort
    }
  }
}
