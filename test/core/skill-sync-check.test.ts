/**
 * ISS-834: `plugins/storybloq/skills/story/` must stay byte-identical to
 * `src/skill/` -- it is a generated mirror (R3), not a second
 * hand-maintained fork, and a real Codex install copies only the plugin's
 * own directory (a symlink out to `src/skill/` was confirmed dropped by
 * that copy). This is the gate of record: it runs in the default `npm
 * test` suite. `scripts/sync-plugin-skill.ts --check` is a convenience
 * wrapper around the same `diffSkillTrees` helper, not a separate
 * implementation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  assertNoSymlinkOnPath,
  diffSkillTrees,
  formatSkillTreeDiff,
  isSkillTreeDiffClean,
  listRegularFiles,
} from "../../src/core/skill-sync-check.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = join(pkgRoot, "src", "skill");
const TARGET = join(pkgRoot, "plugins", "storybloq", "skills", "story");

describe("plugin skill copy is a byte-identical mirror of src/skill/ (ISS-834)", () => {
  it("both trees are populated and carry SKILL.md (so equality below cannot pass vacuously)", () => {
    // Two empty trees diff as equal; that green would prove nothing. Pin the
    // canonical entry point on both sides and a non-empty source first.
    expect(existsSync(join(SOURCE, "SKILL.md"))).toBe(true);
    expect(existsSync(join(TARGET, "SKILL.md"))).toBe(true);
    expect(readdirSync(SOURCE).length).toBeGreaterThan(0);
  });

  it("has no missing, extra, or changed files", () => {
    const diff = diffSkillTrees(SOURCE, TARGET);
    expect(isSkillTreeDiffClean(diff), formatSkillTreeDiff(diff)).toBe(true);
  });
});

describe("assertNoSymlinkOnPath (the destination guard sync-plugin-skill.ts runs before rmSync)", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `storybloq-sync-guard-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes for a real nested directory", () => {
    mkdirSync(join(root, "plugins", "x", "skills", "story"), { recursive: true });
    expect(() => assertNoSymlinkOnPath(root, join(root, "plugins", "x", "skills", "story"))).not.toThrow();
  });

  it("passes when the trailing components do not exist yet (first generation)", () => {
    mkdirSync(join(root, "plugins"), { recursive: true });
    expect(() => assertNoSymlinkOnPath(root, join(root, "plugins", "x", "skills", "story"))).not.toThrow();
  });

  it("refuses when the final component is a symlink", () => {
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    mkdirSync(join(root, "plugins", "x", "skills"), { recursive: true });
    symlinkSync(join(root, "elsewhere"), join(root, "plugins", "x", "skills", "story"));
    expect(() => assertNoSymlinkOnPath(root, join(root, "plugins", "x", "skills", "story"))).toThrow(/symlink/);
  });

  it("refuses when an ANCESTOR component is a symlink (rmSync would otherwise recurse outside the tree)", () => {
    // plugins/x/skills -> elsewhere; the final `story` is a real directory,
    // so a final-component-only check passes while the resolved path lives
    // outside `root`.
    mkdirSync(join(root, "elsewhere", "story"), { recursive: true });
    mkdirSync(join(root, "plugins", "x"), { recursive: true });
    symlinkSync(join(root, "elsewhere"), join(root, "plugins", "x", "skills"));
    expect(() => assertNoSymlinkOnPath(root, join(root, "plugins", "x", "skills", "story"))).toThrow(/symlink/);
  });

  it("refuses a target outside the root even with no symlinks involved", () => {
    mkdirSync(join(root, "a"), { recursive: true });
    expect(() => assertNoSymlinkOnPath(join(root, "a"), join(root, "b", "c"))).toThrow(/outside/);
  });

  it("does not swallow non-ENOENT errors (a regular file where a directory component should be)", () => {
    mkdirSync(join(root, "plugins"), { recursive: true });
    writeFileSync(join(root, "plugins", "x"), "not a directory");
    // lstat on plugins/x/skills fails with ENOTDIR, not ENOENT: that is a
    // real fault to surface, not "does not exist yet".
    expect(() => assertNoSymlinkOnPath(root, join(root, "plugins", "x", "skills", "story"))).toThrow();
  });
});

describe("listRegularFiles refuses a symlinked ROOT, not just symlinked children", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `storybloq-sync-root-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("throws when the root itself is a directory symlink", () => {
    mkdirSync(join(root, "real"), { recursive: true });
    writeFileSync(join(root, "real", "SKILL.md"), "x");
    symlinkSync(join(root, "real"), join(root, "linked"));
    expect(() => listRegularFiles(join(root, "linked"))).toThrow(/symlink/);
    // The same tree through its real path is fine.
    expect(listRegularFiles(join(root, "real"))).toEqual(["SKILL.md"]);
  });

  it("throws when the root is a regular file", () => {
    writeFileSync(join(root, "file"), "x");
    expect(() => listRegularFiles(join(root, "file"))).toThrow(/non-directory/);
  });
});
