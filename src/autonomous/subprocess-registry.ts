import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join, basename } from "node:path";
import { telemetryDirPath } from "./liveness.js";

export const SUBPROCESS_CATEGORIES = [
  "xcodebuild",
  "codex",
  "swift-test",
  "lens-review",
  "npm-test",
  "other",
] as const;

export type SubprocessCategory = (typeof SUBPROCESS_CATEGORIES)[number];

export interface SubprocessEntry {
  pid: number;
  cmd: string;
  category: SubprocessCategory;
  startedAt: string;
  stage: string;
}

export interface SubprocessSummary {
  pid: number;
  category: string;
  startedAt: string;
  stage: string;
}

export function subprocessesDir(sessionDir: string): string {
  return join(telemetryDirPath(sessionDir), "subprocesses");
}

export function sanitizeCmd(rawCmd: string): string {
  const trimmed = rawCmd.trim();
  if (!trimmed) return "unknown";
  const [firstToken = ""] = trimmed.split(/\s+/);
  const unquoted = firstToken.replace(/^["']|["']$/g, "");
  return basename(unquoted) || "unknown";
}

// ISS-431: Cache known subprocess dirs to skip redundant mkdirSync.
const _knownSubprocessDirs = new Set<string>();

export function registerSubprocess(sessionDir: string, entry: SubprocessEntry): void {
  const dir = subprocessesDir(sessionDir);
  if (!_knownSubprocessDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    _knownSubprocessDirs.add(dir);
  }
  const target = join(dir, `${entry.pid}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  // ISS-425: Wrap writeFileSync in try so tmp is cleaned up on write failure.
  // ISS-433: Use compact JSON (no pretty-print) for machine-only files.
  const content = JSON.stringify(entry) + "\n";
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export function unregisterSubprocess(sessionDir: string, pid: number): void {
  try {
    unlinkSync(join(subprocessesDir(sessionDir), `${pid}.json`));
  } catch {
    // ENOENT or dir missing -- idempotent
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

// ISS-420: Per-file parse extracted to flatten nesting in readSubprocessSummaries.
function parseSubprocessFile(filePath: string): SubprocessSummary | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number") return null;

    if (!isPidAlive(parsed.pid)) {
      try { unlinkSync(filePath); } catch { /* best-effort cleanup */ }
      return null;
    }

    return {
      pid: parsed.pid,
      category: parsed.category ?? "other",
      startedAt: parsed.startedAt ?? "",
      stage: parsed.stage ?? "unknown",
    };
  } catch {
    return null; // malformed JSON -- skip
  }
}

export function readSubprocessSummaries(sessionDir: string): SubprocessSummary[] {
  const dir = subprocessesDir(sessionDir);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const results: SubprocessSummary[] = [];
  for (const file of files) {
    const summary = parseSubprocessFile(join(dir, file));
    if (summary) results.push(summary);
  }
  return results;
}
