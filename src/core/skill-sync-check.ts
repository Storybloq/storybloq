/**
 * ISS-834: compares the canonical skill source (`src/skill/`) against a
 * generated mirror (the Codex plugin's `skills/story/` copy, or an
 * installed plugin's cache copy) file by file.
 *
 * Shared by `scripts/sync-plugin-skill.ts` (both write mode and `--check`)
 * and the vitest drift test, so there is exactly one implementation of
 * "are these two trees equal" -- the vitest test is the gate of record; the
 * script's `--check` mode is a release-time convenience that calls this same
 * routine.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SkillTreeDiff {
  /** Relative paths present in the source but missing from the target. */
  missing: string[];
  /** Relative paths present in the target but not in the source. */
  extra: string[];
  /** Relative paths present in both, with different content. */
  changed: string[];
}

/**
 * Lists every regular file under `root`, relative to `root` and sorted,
 * refusing (not skipping) any symlink or special file it encounters. A
 * symlink inside the canonical `src/skill/` tree could reintroduce the
 * out-of-subtree dependency ISS-834's own symlink probe (R3) already found
 * unusable for the Codex distribution path.
 *
 * Exported so `scripts/sync-plugin-skill.ts` walks the source with this
 * exact routine instead of a second copy of it.
 */
export function listRegularFiles(root: string): string[] {
  // The root itself is checked no-follow too: a `src/skill` that has been
  // replaced by a directory symlink would otherwise be walked through, and
  // the mirror would carry whatever tree it points at.
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`refusing to sync through a symlink: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`refusing to sync a non-directory root: ${root}`);
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`refusing to sync through a symlink: ${full}`);
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`refusing to sync a non-regular file: ${full}`);
      }
      out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Destination guard run before any destructive write to `target`.
 *
 * Refuses (no-follow, component by component) if ANY path component between
 * `root` (exclusive) and `target` (inclusive) is a symlink, so a swapped-out
 * ancestor such as `plugins/storybloq/skills` cannot redirect a recursive
 * delete outside the repository; refuses a `target` that does not sit
 * beneath `root` at all; and refuses a `target` that exists as something
 * other than a directory. Components that do not exist yet (ENOENT) are
 * fine -- first generation creates them -- but every other `lstat` failure
 * (ENOTDIR, EACCES, EIO, ...) is rethrown rather than read as "absent".
 *
 * `root` itself is not walked: on macOS the temp roots tests use live under
 * `/var`, which is itself a symlink, and the guard's job is the tree BELOW
 * the package root, not the filesystem above it.
 */
export function assertNoSymlinkOnPath(root: string, target: string): void {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to write to ${target}: it is outside ${root}`);
  }
  const segments = rel.split(sep);
  let cur = rootAbs;
  for (let i = 0; i < segments.length; i++) {
    cur = join(cur, segments[i]!);
    let stat;
    try {
      stat = lstatSync(cur);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing deeper exists yet
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write through a symlinked path component: ${cur}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`refusing to write through a non-directory path component: ${cur}`);
    }
  }
}

/** Diffs `source` against `target`, both directory roots, file by file. */
export function diffSkillTrees(source: string, target: string): SkillTreeDiff {
  const sourceFiles = new Set(listRegularFiles(source));
  const targetFiles = new Set(listRegularFiles(target));

  const missing = [...sourceFiles].filter((f) => !targetFiles.has(f)).sort();
  const extra = [...targetFiles].filter((f) => !sourceFiles.has(f)).sort();
  const changed = [...sourceFiles]
    .filter((f) => targetFiles.has(f))
    .filter((f) => hashFile(join(source, f)) !== hashFile(join(target, f)))
    .sort();

  return { missing, extra, changed };
}

export function isSkillTreeDiffClean(diff: SkillTreeDiff): boolean {
  return diff.missing.length === 0 && diff.extra.length === 0 && diff.changed.length === 0;
}

export function formatSkillTreeDiff(diff: SkillTreeDiff): string {
  const lines: string[] = [];
  for (const f of diff.missing) lines.push(`missing: ${f}`);
  for (const f of diff.extra) lines.push(`extra:   ${f}`);
  for (const f of diff.changed) lines.push(`changed: ${f}`);
  return lines.join("\n");
}
