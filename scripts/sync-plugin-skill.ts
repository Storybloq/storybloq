#!/usr/bin/env tsx
/**
 * Generates `plugins/storybloq/skills/story/` from `src/skill/` (ISS-834).
 *
 * The Codex plugin marketplace's `plugin add` COPIES a plugin's own
 * `source.path` directory into its own cache rather than referencing the
 * marketplace checkout in place (confirmed empirically -- a relative
 * symlink pointing outside `plugins/storybloq/` was silently dropped by
 * that copy). So the plugin's skill copy must be a real, generated file
 * tree inside `plugins/storybloq/`, mirrored from the single canonical
 * source at `src/skill/`, never a second hand-maintained fork.
 *
 * Default mode writes the mirror, deleting stale target files so removals
 * propagate. `--check` diffs without writing and exits non-zero on drift --
 * a release-time convenience wrapper; the vitest drift test
 * (test/core/skill-sync-check.test.ts) is the gate of record, since it runs
 * in the default `npm test` suite and this script does not.
 *
 * Write mode's exact guarantee: the whole source tree is validated and read
 * into memory first (a symlink or special file anywhere in `src/skill/`
 * aborts before the existing mirror has been touched); the mirror is built
 * in the sibling `.story.new` and swapped in with two renames through the
 * sibling `.story.old`. The only unsafe window is between those two renames,
 * where no `story/` exists; a kill there is recovered by the next run of
 * this script (it renames `.story.old` back before it even reads the source) or
 * by `git checkout` of the tracked mirror. The sibling names are stable, not
 * per-pid, so that recovery is deterministic; the cost is that concurrent
 * runs of this generator are unsupported by design, which is the right
 * trade for a release-time script.
 *
 * Usage:
 *   npx tsx scripts/sync-plugin-skill.ts            # write the mirror
 *   npx tsx scripts/sync-plugin-skill.ts --check     # diff only, exit 1 on drift
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoSymlinkOnPath,
  diffSkillTrees,
  formatSkillTreeDiff,
  isSkillTreeDiffClean,
  listRegularFiles,
} from "../src/core/skill-sync-check.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(pkgRoot, "src", "skill");
const SKILLS_DIR = join(pkgRoot, "plugins", "storybloq", "skills");
const TARGET = join(SKILLS_DIR, "story");

function sync(): void {
  // 1. Guard every destination path we are about to write through, rename,
  //    or delete: the mirror itself and both siblings, walked component by
  //    component from pkgRoot (no symlinked ancestor, nothing outside the
  //    repo). This runs BEFORE the recovery step below, so an unguarded path
  //    is never renamed back into place. The siblings live beside TARGET so
  //    the renames stay on one filesystem.
  const fresh = join(SKILLS_DIR, ".story.new");
  const retired = join(SKILLS_DIR, ".story.old");
  assertNoSymlinkOnPath(pkgRoot, TARGET);
  assertNoSymlinkOnPath(pkgRoot, fresh);
  assertNoSymlinkOnPath(pkgRoot, retired);

  // 2. Recover an interrupted previous swap BEFORE touching the source. This
  //    is the one deliberate exception to validate-before-update: the parked
  //    mirror at `retired` is a known-good copy, and restoring it must not
  //    depend on the current source tree being readable, or an unrelated
  //    source error would strand it. A kill between the two renames in step 5
  //    leaves the mirror at `retired` and nothing at TARGET: put it back. A
  //    kill between the second rename and the final rm leaves both: the
  //    retired copy is then just debris. A leftover `fresh` is always debris
  //    (it is rebuilt from scratch below).
  if (!existsSync(TARGET) && existsSync(retired)) {
    renameSync(retired, TARGET);
    process.stderr.write(`recovered interrupted swap: ${retired} -> ${TARGET}\n`);
  } else if (existsSync(retired)) {
    rmSync(retired, { recursive: true, force: true });
  }
  rmSync(fresh, { recursive: true, force: true });

  // 3. Validate and read the ENTIRE source. listRegularFiles throws on any
  //    symlink or special file (including a symlinked root), so a bad source
  //    aborts here, with the existing mirror (restored above if it had been
  //    parked) untouched.
  const files = listRegularFiles(SOURCE);
  if (!files.includes("SKILL.md")) {
    throw new Error(`refusing to sync: ${SOURCE} has no SKILL.md, so it is not a skill tree`);
  }
  const contents = new Map<string, Buffer>();
  for (const rel of files) contents.set(rel, readFileSync(join(SOURCE, rel)));

  // 4. Build the complete mirror in the fresh sibling.
  try {
    mkdirSync(fresh, { recursive: true });
    for (const [rel, buf] of contents) {
      const destPath = join(fresh, rel);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, buf);
    }

    // 5. Swap: retire the old mirror by rename, move the new one into place,
    //    and only then delete the retired copy. If the second rename fails
    //    the retired copy goes back; if THAT rename fails too, both paths and
    //    both errors are reported and the original error is rethrown (the
    //    mirror is then at `retired`, which step 3 restores on the next run).
    if (existsSync(TARGET)) renameSync(TARGET, retired);
    try {
      renameSync(fresh, TARGET);
    } catch (err: unknown) {
      if (existsSync(retired)) {
        try {
          renameSync(retired, TARGET);
        } catch (rollbackErr: unknown) {
          process.stderr.write(
            `swap failed AND rollback failed: mirror is at ${retired}, not ${TARGET}. ` +
              `swap error: ${String(err)}; rollback error: ${String(rollbackErr)}. ` +
              `Re-run this script to recover, or git checkout the tracked mirror.\n`,
          );
        }
      }
      throw err;
    }
    rmSync(retired, { recursive: true, force: true });
  } catch (err: unknown) {
    // `fresh` may already have been renamed to TARGET by the time an error
    // reaches here; force:true makes that a no-op rather than a failure.
    rmSync(fresh, { recursive: true, force: true });
    throw err;
  }
  process.stderr.write(`synced ${SOURCE} -> ${TARGET} (${files.length} files)\n`);
}

function check(): void {
  const diff = diffSkillTrees(SOURCE, TARGET);
  if (isSkillTreeDiffClean(diff)) {
    process.stderr.write("skill plugin copy is in sync\n");
    return;
  }
  process.stderr.write("skill plugin copy is OUT OF SYNC:\n");
  process.stderr.write(formatSkillTreeDiff(diff) + "\n");
  process.stderr.write("run: npx tsx scripts/sync-plugin-skill.ts\n");
  process.exitCode = 1;
}

if (process.argv.includes("--check")) {
  check();
} else {
  sync();
}
