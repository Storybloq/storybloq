/**
 * T-424: Per-project limitResume config, read cheaply from .story/config.json.
 *
 * Hook + waker hot paths read through this helper (raw JSON + clamping) so a
 * malformed config can never crash detection. The zod ConfigSchema in
 * models/config.ts carries the same shape for validation and documentation.
 * Precedence: global kill switch (~/.claude/storybloq/config.json) >
 * project enabled:false > default on.
 */

import { join } from "node:path";
import { CONFIG_MAX_BYTES, readBoundedFile } from "./bounded-read.js";

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


function intOr(value: unknown, fallback: number, bounds: { min: number; max: number }): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max
    ? value
    : fallback;
}


function readConfigBounded(path: string): string | null {
  return readBoundedFile(path, CONFIG_MAX_BYTES);
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
