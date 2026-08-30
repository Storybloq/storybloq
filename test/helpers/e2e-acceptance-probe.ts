/**
 * ISS-1091 (F10): audited-path mutation gate for the e2e CLI-subprocess suite.
 *
 * A recursive before/after snapshot of `~/.claude` in full is unsound: that
 * tree is actively written by the very Claude Code sessions running this
 * suite (transcripts, tasks, session logs), so a full-tree hash races its own
 * writers by construction and is heavy, unbounded I/O on every check.
 *
 * Instead this audits an explicit, NAMED list of paths, built by calling the
 * actual production path-computing functions (not by hand-duplicating what
 * they return) -- so a future change to what one of those functions returns
 * flows into this list automatically, and e2e-acceptance-probe.test.ts pins
 * that the list still matches those functions.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { skillTargets, codexConfigPath as skillMarkerCodexConfigPath } from "../../src/core/skill-version-marker.js";
import { codexConfigPath as setupSkillCodexConfigPath, codexHooksPath } from "../../src/cli/commands/setup-skill.js";
import { cachePath } from "../../src/core/update-check.js";
import { limitLedgerPath, wakerLockPath } from "../../src/core/limit-ledger.js";

export type AuditedPathKind = "dir" | "file";

/**
 * P1: HARD-FAIL paths are only ever written by version-skew refresh or drift
 * reconcile (rare by design once commit 5's upgrade-only fix ships) -- a
 * change there means a real isolation gap. WARN-ONLY paths (update-check
 * cache, limit ledger, waker lock) are legitimately written by concurrent
 * LIVE Claude Code sessions/hooks on this machine independent of this test
 * run (ISS-978: the globally-symlinked storybloq binary means ordinary CLI
 * traffic from other sessions writes these during any long suite run) -- a
 * hard throw on those paths would fail the suite for the exact
 * publish-environment-flakiness class this run exists to eliminate.
 */
export type AuditedPathSeverity = "hard" | "warn";

export interface AuditedPath {
  readonly label: string;
  readonly path: string;
  readonly kind: AuditedPathKind;
  readonly severity: AuditedPathSeverity;
}

export { skillMarkerCodexConfigPath, setupSkillCodexConfigPath };

/**
 * The complete list of real-HOME-adjacent paths `preCommandHousekeeping` can
 * write. `limitLedgerPath`/`wakerLockPath` are included as a defense-in-depth
 * cross-check that STORYBLOQ_GLOBAL_DIR isolation actually held (this probe
 * itself runs with no env override, so it reads the REAL machine's ledger
 * path) -- under a correctly-isolated fixture those two entries should never
 * move, since every fixture-spawned child points its own STORYBLOQ_GLOBAL_DIR
 * elsewhere; when they DO move it's attributed to live concurrent traffic
 * (warn), not blamed on this suite's isolation (hard-fail).
 */
export function auditedPaths(): AuditedPath[] {
  return [
    ...skillTargets().map((target) => ({
      label: `skill dir (${target.id})`,
      path: target.dir,
      kind: "dir" as const,
      severity: "hard" as const,
    })),
    { label: "codex config.toml", path: setupSkillCodexConfigPath(), kind: "file" as const, severity: "hard" as const },
    { label: "codex hooks.json", path: codexHooksPath(), kind: "file" as const, severity: "hard" as const },
    { label: "claude settings.json", path: join(homedir(), ".claude", "settings.json"), kind: "file" as const, severity: "hard" as const },
    { label: "update-check cache", path: cachePath(), kind: "file" as const, severity: "warn" as const },
    { label: "limit ledger", path: limitLedgerPath(), kind: "file" as const, severity: "warn" as const },
    { label: "waker lock", path: wakerLockPath(), kind: "file" as const, severity: "warn" as const },
  ];
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashDirRecursive(dir: string): string {
  const hash = createHash("sha256");
  function walk(current: string): void {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = full.slice(dir.length);
      if (entry.isSymbolicLink()) {
        hash.update(`L:${rel}\n`);
      } else if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`);
        walk(full);
      } else {
        hash.update(`F:${rel}:${hashFile(full)}\n`);
      }
    }
  }
  if (existsSync(dir)) walk(dir);
  return hash.digest("hex");
}

function snapshotOne(entry: AuditedPath): string | null {
  if (!existsSync(entry.path)) return null;
  return entry.kind === "dir" ? hashDirRecursive(entry.path) : hashFile(entry.path);
}

export type AuditedSnapshot = Record<string, string | null>;

export function snapshotAuditedPaths(paths: AuditedPath[] = auditedPaths()): AuditedSnapshot {
  const snapshot: AuditedSnapshot = {};
  for (const entry of paths) {
    snapshot[entry.label] = snapshotOne(entry);
  }
  return snapshot;
}

export interface AuditedPathDiff {
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** Diffs two snapshots. Checks both directions -- a path absent before but present after is caught, not just a changed one. Empty array = no mutation detected. */
export function diffAuditedPaths(before: AuditedSnapshot, after: AuditedSnapshot): AuditedPathDiff[] {
  const labels = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: AuditedPathDiff[] = [];
  for (const label of labels) {
    const b = before[label] ?? null;
    const a = after[label] ?? null;
    if (b !== a) diffs.push({ label, before: b, after: a });
  }
  return diffs;
}

export interface ClassifiedDiffs {
  readonly hard: AuditedPathDiff[];
  readonly warn: AuditedPathDiff[];
}

/**
 * P1: splits diffs by severity. `strict` promotes every warn-only diff to
 * hard (STORYBLOQ_E2E_PROBE_STRICT=1, the ship-time quiet-window check).
 * Pure and side-effect-free so it's testable without touching the global
 * snapshot file the real probe wiring reads/writes.
 */
export function classifyDiffs(diffs: AuditedPathDiff[], paths: AuditedPath[], strict: boolean): ClassifiedDiffs {
  const severityByLabel = new Map(paths.map((p) => [p.label, p.severity]));
  const warn = strict ? [] : diffs.filter((d) => severityByLabel.get(d.label) === "warn");
  const hard = diffs.filter((d) => !warn.includes(d));
  return { hard, warn };
}
