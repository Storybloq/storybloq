#!/usr/bin/env tsx
/**
 * ISS-834 C4: asserts an installed Codex plugin's skill payload matches the
 * canonical `src/skill/` source, content for content.
 *
 * Probe (b) (see plan-run10.md R3) showed that `codex plugin list --json`
 * can report a fully successful install while `skills/story/` is silently
 * empty underneath -- metadata assertions alone would not have caught that.
 * This script is the payload check: it reuses the same tree-diff helper the
 * repo's own drift test uses, pointed at a REAL installed cache directory
 * instead of the repo's two committed trees.
 *
 * Usage: npx tsx scripts/ci/assert-skill-payload.ts <sourceDir> <installedDir>
 */

import { diffSkillTrees, isSkillTreeDiffClean, formatSkillTreeDiff } from "../../src/core/skill-sync-check.js";

const [sourceDir, installedDir] = process.argv.slice(2);
if (!sourceDir || !installedDir) {
  process.stderr.write("usage: assert-skill-payload.ts <sourceDir> <installedDir>\n");
  process.exit(2);
}

const diff = diffSkillTrees(sourceDir, installedDir);
if (!isSkillTreeDiffClean(diff)) {
  process.stderr.write(`installed skill payload drifted from ${sourceDir}:\n${formatSkillTreeDiff(diff)}\n`);
  process.exit(1);
}

process.stderr.write(`installed skill payload at ${installedDir} matches ${sourceDir}\n`);
