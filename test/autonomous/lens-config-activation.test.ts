import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LENSES } from "@storybloq/lenses";
import { handlePrepare } from "../../src/autonomous/lens-harness/prepare.js";

const ALL_LENS_NAMES = Object.keys(LENSES);

/**
 * T-461 phase 1(c): `lensConfig.lenses` and `lensConfig.maxLenses` were
 * documented in SKILL.md and read by NOTHING. prepare.ts called activate() and
 * used the result as-is.
 *
 * The behavior that needs the most protection is the misconfiguration one. A
 * filter that produces an empty set must NOT be honored: misspelling the lens
 * names would otherwise silently turn off lens review entirely, and no config
 * mistake may buy less review than the project has today. That is the same
 * fail-closed rule the review-effort dial applies to its own values.
 */

let root: string;

function writeConfig(lensConfig: unknown): void {
  const story = join(root, ".story");
  mkdirSync(story, { recursive: true });
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "lens-config-fixture",
    type: "npm",
    language: "typescript",
    ...(lensConfig === undefined ? {} : { recipeOverrides: { lensConfig } }),
  }));
}

function prepare() {
  return handlePrepare({
    stage: "CODE_REVIEW",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n",
    changedFiles: ["src/a.ts"],
    projectRoot: root,
  });
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lens-config-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("lensConfig activation", () => {
  it("activates the registry's own set when no lensConfig is present", () => {
    writeConfig(undefined);
    const baseline = prepare().metadata.activeLenses;
    // The baseline every other assertion is measured against. If this were
    // empty the whole suite would pass vacuously.
    expect(baseline.length).toBeGreaterThan(1);
  });

  it("restricts activation to the configured lenses", () => {
    writeConfig(undefined);
    const baseline = [...prepare().metadata.activeLenses];
    const keep = baseline.slice(0, 2);

    writeConfig({ lenses: keep });
    const out = prepare();
    expect([...out.metadata.activeLenses].sort()).toEqual([...keep].sort());
    // Dropped lenses are DISCLOSED, not silently absent.
    for (const dropped of baseline.slice(2)) {
      expect(out.metadata.skippedLenses).toContain(dropped);
      expect(out.metadata.activationReasons[dropped]).toBe("excluded: lensConfig");
    }
  });

  it("caps activation at maxLenses, preserving order", () => {
    writeConfig(undefined);
    const baseline = [...prepare().metadata.activeLenses];

    writeConfig({ maxLenses: 2 });
    const out = prepare();
    expect(out.metadata.activeLenses).toEqual(baseline.slice(0, 2));
    for (const dropped of baseline.slice(2)) {
      expect(out.metadata.activationReasons[dropped]).toBe("excluded: maxLenses cap");
    }
  });

  it("applies the filter first and the cap second", () => {
    writeConfig(undefined);
    const baseline = [...prepare().metadata.activeLenses];
    if (baseline.length < 3) return;

    writeConfig({ lenses: baseline.slice(0, 3), maxLenses: 2 });
    const out = prepare();
    expect(out.metadata.activeLenses).toEqual(baseline.slice(0, 2));
    expect(out.metadata.activationReasons[baseline[2]!]).toBe("excluded: maxLenses cap");
  });

  it("IGNORES a filter that would leave no lenses at all", () => {
    // The load-bearing case. Misspelling every name must not disable review.
    writeConfig(undefined);
    const baseline = [...prepare().metadata.activeLenses];

    writeConfig({ lenses: ["not-a-lens", "also-not-a-lens"] });
    const out = prepare();
    expect(out.metadata.activeLenses).toEqual(baseline);
  });

  it("IGNORES a filter with even ONE unknown name, rather than narrowing to the rest", () => {
    // The subtler half, and the one an empty-result guard alone would miss:
    // ["security", "securty"] has a NON-empty intersection, so a naive guard
    // lets it through and one typo silently drops every other active lens.
    writeConfig(undefined);
    const baseline = [...prepare().metadata.activeLenses];
    expect(baseline.length).toBeGreaterThan(1);

    writeConfig({ lenses: [baseline[0]!, `${baseline[0]}-typo`] });
    expect(prepare().metadata.activeLenses).toEqual(baseline);
  });

  it("accepts a known lens that is simply not active for this change", () => {
    // The other side: a valid name that did not activate is NOT a typo, so it
    // must not disable the filter. Otherwise a legitimate config stops working
    // the moment the changed files stop activating one of its lenses.
    writeConfig(undefined);
    const baseline = [...prepare().metadata.activeLenses];
    const inactive = ALL_LENS_NAMES.find((l) => !baseline.includes(l));
    if (!inactive) return;

    writeConfig({ lenses: [baseline[0]!, inactive] });
    expect(prepare().metadata.activeLenses).toEqual([baseline[0]!]);
  });

  it.each([
    ["an empty lenses array", { lenses: [] }],
    ["a non-array lenses", { lenses: "security" }],
    ["a lenses array with a non-string", { lenses: ["security", 7] }],
    ["maxLenses of 0", { maxLenses: 0 }],
    ["a negative maxLenses", { maxLenses: -1 }],
    ["a non-integer maxLenses", { maxLenses: 2.5 }],
    ["maxLenses above the documented range", { maxLenses: 99 }],
    ["a non-object lensConfig", "auto"],
    ["an array lensConfig", []],
  ])("falls back to full activation for %s", (_label, lensConfig) => {
    writeConfig(undefined);
    const baseline = [...prepare().metadata.activeLenses];

    writeConfig(lensConfig);
    expect(prepare().metadata.activeLenses).toEqual(baseline);
  });

  it("survives a project with no config file at all", () => {
    // No writeConfig call: the directory exists, .story/config.json does not.
    expect(() => prepare()).not.toThrow();
    expect(prepare().metadata.activeLenses.length).toBeGreaterThan(0);
  });
});
