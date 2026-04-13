import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { telemetryDirPath } from "./liveness.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelemetryLayer = "guide" | "mcp" | "os" | "review" | "artifact";

export interface TelemetryEvent {
  ts: string;
  layer: TelemetryLayer;
  type: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENT_BYTES = 4096;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_LINE_COUNT = 10_000;
const LOCK_OPTIONS = { stale: 10_000 };

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let truncationCount = 0;

export function getTruncationCount(): number {
  return truncationCount;
}

export function resetTruncationCount(): void {
  truncationCount = 0;
}

// ---------------------------------------------------------------------------
// Internal: locking
// ---------------------------------------------------------------------------

// Single-writer invariant is enforced by session lease. This lock protects
// against rare overlap during lease expiry, orphan recovery, or operator error.
export function withTelemLock<T>(sessionDir: string, fn: () => T): T | undefined {
  const tDir = telemetryDirPath(sessionDir);
  mkdirSync(tDir, { recursive: true });
  let release: (() => void) | undefined;
  try {
    release = lockfile.lockSync(tDir, LOCK_OPTIONS);
  } catch {
    return undefined;
  }
  try {
    return fn();
  } finally {
    try {
      release();
    } catch {
      /* ignore unlock errors */
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: rotation
// ---------------------------------------------------------------------------

function countLinesFromFile(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function readLineCount(metaPath: string, eventsFilePath: string): number {
  try {
    const val = readFileSync(metaPath, "utf-8").trim();
    const n = Number(val);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {
    // Sidecar missing or unreadable -- rebuild from actual file
  }
  const rebuilt = countLinesFromFile(eventsFilePath);
  try {
    writeFileSync(metaPath, String(rebuilt), "utf-8");
  } catch {
    /* best-effort */
  }
  return rebuilt;
}

function writeLineCount(metaPath: string, count: number): void {
  try {
    writeFileSync(metaPath, String(count), "utf-8");
  } catch {
    /* best-effort */
  }
}

function rotateIfNeeded(eventsFilePath: string, metaPath: string): boolean {
  let size: number;
  try {
    size = statSync(eventsFilePath).size;
  } catch {
    return false; // ENOENT or other -- nothing to rotate
  }

  const lineCount = readLineCount(metaPath, eventsFilePath);
  const shouldRotate = size >= MAX_FILE_BYTES || lineCount >= MAX_LINE_COUNT;
  if (!shouldRotate) return false;

  const rotated = `${eventsFilePath}.1`;
  try {
    unlinkSync(rotated);
  } catch {
    /* may not exist */
  }
  try {
    renameSync(eventsFilePath, rotated);
  } catch {
    return false; // rename failed -- leave sidecar untouched
  }
  writeLineCount(metaPath, 0);
  return true;
}

// ---------------------------------------------------------------------------
// Internal: atomic write helper
// ---------------------------------------------------------------------------

function atomicWrite(targetPath: string, content: string): void {
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// writeEvent
// ---------------------------------------------------------------------------

export function writeEvent(sessionDir: string, event: TelemetryEvent): void {
  try {
    let line = JSON.stringify(event);
    if (Buffer.byteLength(line, "utf-8") > MAX_EVENT_BYTES) {
      const originalSize = Buffer.byteLength(line, "utf-8");
      const truncated: TelemetryEvent = {
        ...event,
        data: { _truncated: true, _originalSize: originalSize },
      };
      line = JSON.stringify(truncated);
      truncationCount++;
    }

    const tDir = telemetryDirPath(sessionDir);
    mkdirSync(tDir, { recursive: true });
    const eventsFile = join(tDir, "events.jsonl");
    const metaFile = join(tDir, "events.jsonl.lines");

    withTelemLock(sessionDir, () => {
      rotateIfNeeded(eventsFile, metaFile);
      const preAppendCount = readLineCount(metaFile, eventsFile);
      appendFileSync(eventsFile, line + "\n", "utf-8");
      writeLineCount(metaFile, preAppendCount + 1);
    });
  } catch {
    // best-effort -- never throw
  }
}

// ---------------------------------------------------------------------------
// writeCheckpoint
// ---------------------------------------------------------------------------

export function writeCheckpoint(
  sessionDir: string,
  stage: string,
  state: Record<string, unknown>,
  revision: number,
): void {
  try {
    withTelemLock(sessionDir, () => {
      const cpDir = join(telemetryDirPath(sessionDir), "checkpoints");
      mkdirSync(cpDir, { recursive: true });
      const target = join(cpDir, `${stage.toUpperCase()}.json`);

      // Stale-writer guard: refuse to overwrite newer revision
      try {
        const existing = JSON.parse(readFileSync(target, "utf-8"));
        if (
          typeof existing._revision === "number" &&
          existing._revision >= revision
        ) {
          return;
        }
      } catch {
        // File doesn't exist or is malformed -- proceed with write
      }

      const payload = { ...state, _revision: revision };
      const content = JSON.stringify(payload, null, 2) + "\n";
      atomicWrite(target, content);
    });
  } catch {
    // best-effort -- never throw
  }
}

// ---------------------------------------------------------------------------
// markEnded
// ---------------------------------------------------------------------------

// Advisory only: state.json is the source of truth for session termination.
// Callers MUST invoke only after writeSessionSync with state: "SESSION_END".
export function markEnded(sessionDir: string, reason: string): void {
  try {
    withTelemLock(sessionDir, () => {
      const tDir = telemetryDirPath(sessionDir);
      mkdirSync(tDir, { recursive: true });
      const target = join(tDir, "ended");
      const content = JSON.stringify(
        { reason, timestamp: new Date().toISOString() },
        null,
        2,
      ) + "\n";
      atomicWrite(target, content);
    });
  } catch {
    // best-effort -- never throw
  }
}

// ---------------------------------------------------------------------------
// readEndedMarker
// ---------------------------------------------------------------------------

export function readEndedMarker(
  sessionDir: string,
): { reason: string; timestamp: string } | null {
  try {
    const raw = readFileSync(
      join(telemetryDirPath(sessionDir), "ended"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).reason === "string" &&
      typeof (parsed as Record<string, unknown>).timestamp === "string"
    ) {
      return {
        reason: (parsed as Record<string, unknown>).reason as string,
        timestamp: (parsed as Record<string, unknown>).timestamp as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}
