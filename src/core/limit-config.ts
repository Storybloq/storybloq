/**
 * T-424: Per-project limitResume config, read cheaply from .story/config.json.
 *
 * Hook + waker hot paths read through this helper (raw JSON + clamping) so a
 * malformed config can never crash detection. The zod ConfigSchema in
 * models/config.ts carries the same shape for validation and documentation.
 * Precedence: global kill switch (~/.claude/storybloq/config.json) >
 * project enabled:false > default on.
 */

import * as fs from "node:fs";
import { join } from "node:path";

export interface LimitResumeConfig {
  enabled: boolean;
  plainMode: "notify" | "headless";
  /** Autonomous-only: explicit per-project opt-in to wake bypass-posture sessions headlessly. */
  inheritBypass: boolean;
  maxAttempts: number;
  staggerMs: number;
  maxConcurrent: number;
  /** 0 = inactivity-based child termination disabled (opt-in). */
  childInactivityMs: number;
  fallbackResetMs: number;
  notify: boolean;
}

export const DEFAULT_LIMIT_RESUME_CONFIG: LimitResumeConfig = {
  enabled: true,
  plainMode: "notify",
  inheritBypass: false,
  maxAttempts: 5,
  staggerMs: 20_000,
  maxConcurrent: 2,
  childInactivityMs: 0,
  fallbackResetMs: 18_000_000, // 5h
  notify: true,
};

/**
 * Upper bounds mirror the zod schema in models/config.ts. Repository-controlled
 * config must not be able to defeat the waker's safety guarantees: an
 * effectively-unbounded maxConcurrent removes the child cap, a huge staggerMs
 * overflows Node timers into an immediate delay, and a huge fallbackResetMs
 * schedules a record past the supported reset horizon.
 */
export const LIMIT_CONFIG_BOUNDS = {
  maxAttempts: { min: 0, max: 100 },
  staggerMs: { min: 0, max: 600_000 },              // 10min
  maxConcurrent: { min: 1, max: 16 },
  childInactivityMs: { min: 0, max: 86_400_000 },   // 24h (the attempt safety cap)
  fallbackResetMs: { min: 60_000, max: 691_200_000 }, // 8d (the reset clamp horizon)
} as const;

const CONFIG_MAX_BYTES = 262_144;

function intOr(value: unknown, fallback: number, bounds: { min: number; max: number }): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max
    ? value
    : fallback;
}

/**
 * Bounded, non-blocking read for hook/waker hot paths: a special-file (FIFO,
 * device) or oversized replacement must not hang or balloon the caller.
 * Symlinks are followed via explicit realpath resolution (a legitimately
 * symlinked config still reads; the O_NOFOLLOW open on the RESOLVED path keeps
 * a swap-to-symlink race from re-introducing traversal).
 */
export function readBoundedFile(path: string, maxBytes = CONFIG_MAX_BYTES): string | null {
  let target = path;
  try {
    target = fs.realpathSync(path);
  } catch {
    return null; // absent or unresolvable
  }
  let fd: number | null = null;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes || st.size <= 0) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function readConfigBounded(path: string): string | null {
  return readBoundedFile(path, CONFIG_MAX_BYTES);
}

/**
 * ISS-1012: is the Stop hook allowed to do status work in this project?
 *
 * Hot-path sibling of readLimitResumeConfig: same bounded raw read, same
 * crash-proof posture, and fails ENABLED on every uncertainty (absent config,
 * unreadable, malformed JSON, non-boolean value) so a broken config can never
 * silently blind the Mac app. Only an explicit `false` disables.
 *
 * Symlink policy is readBoundedFile's -- a legitimately symlinked
 * `.story/config.json` IS honored, because config is USER input. Note the
 * deliberate asymmetry with the status.json read in autonomous/status-writer.ts,
 * which REFUSES a symlink: that path is a generated artifact, where a link is a
 * defect to overwrite rather than a choice to respect.
 */
export function isStopHookStatusWriteEnabled(projectRoot: string): boolean {
  try {
    const body = readConfigBounded(join(projectRoot, ".story", "config.json"));
    if (body === null) return true;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const raw = parsed?.statusWriter;
    if (!raw || typeof raw !== "object") return true;
    return (raw as Record<string, unknown>).stopHook !== false;
  } catch {
    return true;
  }
}

export function readLimitResumeConfig(projectRoot: string): LimitResumeConfig {
  const d = DEFAULT_LIMIT_RESUME_CONFIG;
  const b = LIMIT_CONFIG_BOUNDS;
  let raw: unknown;
  try {
    const body = readConfigBounded(join(projectRoot, ".story", "config.json"));
    if (body === null) return { ...d };
    const parsed = JSON.parse(body) as Record<string, unknown>;
    raw = parsed?.limitResume;
  } catch {
    return { ...d };
  }
  if (!raw || typeof raw !== "object") return { ...d };
  const c = raw as Record<string, unknown>;
  return {
    enabled: c.enabled !== false,
    plainMode: c.plainMode === "headless" ? "headless" : "notify",
    inheritBypass: c.inheritBypass === true,
    maxAttempts: intOr(c.maxAttempts, d.maxAttempts, b.maxAttempts),
    staggerMs: intOr(c.staggerMs, d.staggerMs, b.staggerMs),
    maxConcurrent: intOr(c.maxConcurrent, d.maxConcurrent, b.maxConcurrent),
    childInactivityMs: intOr(c.childInactivityMs, d.childInactivityMs, b.childInactivityMs),
    fallbackResetMs: intOr(c.fallbackResetMs, d.fallbackResetMs, b.fallbackResetMs),
    notify: c.notify !== false,
  };
}
