import { join } from "node:path";
import { CONFIG_MAX_BYTES, readBoundedFile } from "./bounded-read.js";

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
