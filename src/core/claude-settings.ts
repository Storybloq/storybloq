/**
 * T-499: the ONE reader for Claude Code's `autoCompactWindow` setting.
 *
 * Claude Code merges settings from several files; for this one key the order
 * that matters is user < project < project-local, last DEFINED wins. Managed
 * (policy) settings live outside the user's reach and are not read: a value
 * set only there reports as ABSENT, and the capture records that honestly
 * rather than guessing a window.
 *
 * Every read is bounded and non-blocking (`readBoundedFile`: realpath, then
 * O_NOFOLLOW on the resolved target). A malformed file is skipped, not fatal:
 * a syntax error in `settings.local.json` must not erase a value the user
 * set at the user level.
 *
 * WHEN this is read matters more than how: Claude Code takes the value at
 * PROCESS start, so the capture path (`session intel-start`) reads it once
 * per process era and never again for that era. Nothing else should call
 * this on a hot path.
 */

import { join } from "node:path";
import { readBoundedFileDetailed } from "./bounded-read.js";
import { defaultSettingsPath } from "./hook-migration.js";

export type AutoCompactWindowSource = "user" | "project" | "local";

export interface AutoCompactWindowReading {
  readonly value: number;
  readonly source: AutoCompactWindowSource;
}

/**
 * T-502: one layer's three-valued reading. Declared here, beside the reader,
 * so `core/health` depends on this module and not the other way round.
 */
export interface AutoCompactWindowLayer {
  readonly source: AutoCompactWindowSource;
  readonly path: string;
  readonly kind: "absent" | "ok" | "indeterminate";
  readonly value?: number;
}

/** The three layers in precedence order, lowest FIRST. */
export interface AutoCompactWindowDiagnostic {
  readonly layers: readonly AutoCompactWindowLayer[];
}

/**
 * Sanity bounds on the setting itself. A window under 10k tokens or over 10M
 * is not a value Claude Code would honour, and a nonsense value must not
 * become a high-confidence ceiling.
 */
export const AUTO_COMPACT_WINDOW_BOUNDS = { min: 10_000, max: 10_000_000 } as const;

const SETTINGS_MAX_BYTES = 1024 * 1024;

/** The three layers, lowest precedence first. Exported so a test can name them. */
export function autoCompactWindowLayers(
  projectRoot: string,
  userSettingsPath: string = defaultSettingsPath(),
): ReadonlyArray<{ readonly source: AutoCompactWindowSource; readonly path: string }> {
  return [
    { source: "user", path: userSettingsPath },
    { source: "project", path: join(projectRoot, ".claude", "settings.json") },
    { source: "local", path: join(projectRoot, ".claude", "settings.local.json") },
  ];
}

/**
 * T-502: the three-valued form of the same read. `absent` means the file is
 * missing or the key is not set; `ok` means a valid integer inside the
 * bounds; `indeterminate` means the content could not be established --
 * unreadable, over the 1 MiB cap, a non-regular file, unparseable JSON, a
 * non-object document, or a value of the wrong type or out of bounds.
 *
 * The distinction exists because `storybloq health` must never turn "I could
 * not read your settings" into "your window is fine". The layers are returned
 * lowest precedence FIRST, so a consumer takes the last `ok` and can then ask
 * whether anything ABOVE it was indeterminate.
 */
export function readAutoCompactWindowDiagnostic(
  projectRoot: string,
  userSettingsPath?: string,
): AutoCompactWindowDiagnostic {
  const layers = autoCompactWindowLayers(projectRoot, userSettingsPath).map((layer) => {
    const reading = readWindowLayer(layer.path);
    return { source: layer.source, path: layer.path, ...reading };
  });
  return { layers };
}

function readWindowLayer(path: string): { kind: "absent" | "ok" | "indeterminate"; value?: number } {
  // `readBoundedFileDetailed`, not `existsSync` plus `readBoundedFile`: only a
  // genuinely missing path is absent, so an inaccessible parent directory or a
  // symlink loop reports as indeterminate instead of behaving like a file the
  // user never wrote.
  const read = readBoundedFileDetailed(path, SETTINGS_MAX_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "indeterminate") return { kind: "indeterminate" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { kind: "indeterminate" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "indeterminate" };
  const value = (parsed as Record<string, unknown>).autoCompactWindow;
  if (value === undefined) return { kind: "absent" };
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return { kind: "indeterminate" };
  if (value < AUTO_COMPACT_WINDOW_BOUNDS.min || value > AUTO_COMPACT_WINDOW_BOUNDS.max) {
    return { kind: "indeterminate" };
  }
  return { kind: "ok", value };
}

/**
 * Null means "no layer defines a valid value" -- the caller stores
 * `captureKind: "absent"`, never a default.
 *
 * T-502: now a wrapper over the diagnostic reader, which keeps the two
 * readers from drifting. The contract here is unchanged: an indeterminate
 * layer contributes nothing, so a syntax error in `settings.local.json`
 * still cannot erase a value set at the user level.
 */
export function readAutoCompactWindow(
  projectRoot: string,
  userSettingsPath?: string,
): AutoCompactWindowReading | null {
  let reading: AutoCompactWindowReading | null = null;
  for (const layer of readAutoCompactWindowDiagnostic(projectRoot, userSettingsPath).layers) {
    if (layer.kind === "ok" && layer.value !== undefined) {
      reading = { value: layer.value, source: layer.source };
    }
  }
  return reading;
}
