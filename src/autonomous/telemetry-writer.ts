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
  let release: (() => void) | undefined;
  try {
    // INSIDE the guarded region. A mkdir failure outside it escaped the
    // wrapper as a throw, which at the call sites suppressed everything after
    // the lock attempt -- the exact one-failure-must-not-suppress violation
    // this wrapper's `undefined` return exists to prevent. An unmakeable
    // directory is the same fact as an untakeable lock: the caller cannot
    // proceed, and learns it the same way.
    mkdirSync(tDir, { recursive: true });
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

/** What the transition-scoped form decided. The two-argument form returns nothing. */
export type EndedMarkerOutcome =
  | "written"
  | "repaired"
  | "already-correct"
  | "refused-foreign"
  | "refused-unowned"
  | "refused-unreadable";

/**
 * The exact historical cancellation marker, and nothing broader.
 *
 * Defined as a CLOSED shape rather than described, because it is the only
 * artifact the first pass may overwrite without proof of ownership. A merely
 * parseable timestamp would admit values the legacy writer never emitted, and
 * an extra field means something else wrote it.
 */
function isClosedLegacyShape(value: unknown, reason: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "timestamp") return false;
  const rec = value as { reason: unknown; timestamp: unknown };
  if (rec.reason !== reason) return false;
  if (typeof rec.timestamp !== "string") return false;
  return isCanonicalInstant(rec.timestamp);
}

/**
 * The canonical four-digit-year `toISOString()` grammar.
 *
 * The round trip alone is NOT enough: `new Date(t).toISOString() === t` also
 * holds for expanded-year forms such as `+275760-09-13T00:00:00.000Z`, which
 * the historical writer could never have emitted. The regex pins the shape and
 * the round trip pins that it is a real instant.
 */
function isCanonicalInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

// Advisory only: state.json is the source of truth for session termination.
// Callers MUST invoke only after writeSessionSync with state: "SESSION_END".
//
// T-450 step 6a: an optional third argument makes this transition-scoped. The
// two-argument form is UNCHANGED, return value included, because every other
// termination path uses it and none of them is in that step's scope.
//
// Why extended here rather than wrapped in a new function: the step 5
// characterization suite mocks this module BY PATH and pins `markEnded` in the
// shipped call order. A separate writer would never be observed by that spy,
// and "markEnded never ran" would fail deterministically.
//
// Why the transition form classifies OWNERSHIP on every pass, including the
// first: holding the session lock prevents a concurrent write, but it does not
// make another transition's durable evidence ours. Overwriting a marker that
// carries a different transition id would destroy exactly the conflict this
// classification exists to surface.
export function markEnded(sessionDir: string, reason: string): void;
export function markEnded(
  sessionDir: string,
  reason: string,
  transition: {
    readonly transitionId: string;
    readonly endedAt: string;
    readonly mode: "first-pass" | "recovery";
  },
): EndedMarkerOutcome;
export function markEnded(
  sessionDir: string,
  reason: string,
  transition?: {
    readonly transitionId: string;
    readonly endedAt: string;
    readonly mode: "first-pass" | "recovery";
  },
): EndedMarkerOutcome | void {
  if (!transition) {
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
    // BYTE-IDENTICAL to the shipped function, return value included.
    return;
  }

  let outcome: EndedMarkerOutcome = "refused-unreadable";
  try {
    const result = withTelemLock(sessionDir, (): EndedMarkerOutcome => {
      const tDir = telemetryDirPath(sessionDir);
      const target = join(tDir, "ended");

      let existing: unknown;
      let present = false;
      try {
        existing = JSON.parse(readFileSync(target, "utf-8"));
        present = true;
      } catch (err) {
        // ENOENT is ABSENCE, which is recoverable and ordinary. Anything else
        // is a file we could not read, which proves nothing about ownership in
        // either direction and must never be treated as absence.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "refused-unreadable";
      }

      const write = (): void => {
        mkdirSync(tDir, { recursive: true });
        atomicWrite(target, JSON.stringify(
          { reason, timestamp: transition.endedAt, transitionId: transition.transitionId },
          null,
          2,
        ) + "\n");
      };

      if (!present) { write(); return "written"; }

      const rec = (existing && typeof existing === "object" && !Array.isArray(existing))
        ? existing as Record<string, unknown>
        : null;
      if (!rec) return "refused-foreign";

      const owner = rec.transitionId;
      if (typeof owner === "string") {
        if (owner !== transition.transitionId) return "refused-foreign";
        // `already-correct` requires the EXACT key set, not merely the three
        // expected values. An owned marker carrying extra keys is not the
        // canonical artifact, and calling it correct here while the completion
        // reader that commit B2 adds rejects it would strand recovery in a loop:
        // refusing to repair something that is never accepted.
        const keys = Object.keys(rec).sort().join(",");
        if (keys === "reason,timestamp,transitionId"
          && rec.timestamp === transition.endedAt
          && rec.reason === reason) {
          return "already-correct";
        }
        write();
        return "repaired";
      }

      // No transition id. The first pass may adopt the exact legacy shape,
      // because it provably runs before this transition has written any marker
      // of its own. By recovery time that reasoning is gone: an
      // identifier-free marker could belong to anyone.
      if (transition.mode === "first-pass" && isClosedLegacyShape(rec, reason)) {
        write();
        return "written";
      }
      return transition.mode === "first-pass" ? "refused-foreign" : "refused-unowned";
    });
    if (result !== undefined) outcome = result;
  } catch {
    // best-effort -- never throw
  }
  return outcome;
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
