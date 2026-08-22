/**
 * THE CLAIM THE MAC PANEL MAKES WHEN IT WRITES `auto` (T-471).
 *
 * The panel offers a checkbox per lens from a HARDCODED copy of the registry,
 * because it cannot import this package. When every box is ticked it writes
 * `"auto"` rather than the list it just built, and that substitution is only
 * safe if the two produce the identical review.
 *
 * They do today for a structural reason -- an explicit array becomes a `Set`
 * used to FILTER the activation array, so listing everything filters nothing,
 * and `maxLenses` then slices the same array either way -- but "structural
 * today" is exactly the kind of reasoning that stops being true without anyone
 * noticing. If the explicit path ever REORDERED (say, sorting by the config
 * list rather than filtering the activation array), the two would diverge in
 * which lenses a cap keeps, and the panel would be silently changing reviews
 * for every user who ticked every box.
 *
 * So this runs the real harness both ways.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LENSES } from "@storybloq/lenses";
import { handlePrepare } from "../../../src/autonomous/lens-harness/prepare.js";

const ALL_IDS = Object.keys(LENSES);

const TS_DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -0,0 +1,2 @@",
  "+export async function greet(name: string): Promise<string> {",
  '+  return "hello " + name;',
  "",
].join("\n");

let root: string;

function writeLensConfig(lensConfig: Record<string, unknown> | null): void {
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...(lensConfig ? { recipeOverrides: { lensConfig } } : {}),
  }));
}

function activeLenses(
  lensConfig: Record<string, unknown> | null,
  stage: "PLAN_REVIEW" | "CODE_REVIEW",
  changedFiles: string[],
): string[] {
  writeLensConfig(lensConfig);
  return [...handlePrepare({
    stage,
    diff: stage === "PLAN_REVIEW" ? "# Plan\n\nRefactor the greeter." : TS_DIFF,
    changedFiles,
    projectRoot: root,
  }).metadata.activeLenses];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lens-auto-parity-"));
  mkdirSync(join(root, ".story", "sessions", "sess-1"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "example.ts"), "export function greet() {}\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listing every lens is identical to `auto`", () => {
  /**
   * Two stages and two file sets, because they activate DIFFERENT subsets:
   * PLAN_REVIEW activates all nine, a TS diff activates a handful, and an empty
   * CODE_REVIEW activates none. A parity check run only against the full set
   * would pass on an implementation that ignored activation entirely.
   */
  const SUBSETS: [string, "PLAN_REVIEW" | "CODE_REVIEW", string[]][] = [
    ["a plan review, which activates everything", "PLAN_REVIEW", ["src/example.ts"]],
    ["a TypeScript diff, which activates a subset", "CODE_REVIEW", ["src/example.ts"]],
  ];

  for (const [label, stage, files] of SUBSETS) {
    it(`matches for ${label}`, () => {
      const auto = activeLenses({ lenses: "auto" }, stage, files);
      const explicit = activeLenses({ lenses: ALL_IDS }, stage, files);
      // ORDER, not just membership. The cap below slices off the front, so two
      // orderings with the same members are two different reviews under a cap.
      expect(explicit).toEqual(auto);
      // Vacuous-pass guard: an activation set of zero would make any two runs
      // trivially equal.
      expect(auto.length).toBeGreaterThan(0);
    });

    it(`matches for ${label} under every cap the harness honours`, () => {
      for (let cap = 1; cap <= 8; cap++) {
        const auto = activeLenses({ lenses: "auto", maxLenses: cap }, stage, files);
        const explicit = activeLenses({ lenses: ALL_IDS, maxLenses: cap }, stage, files);
        expect(explicit, `cap ${cap}`).toEqual(auto);
        expect(auto.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
      }
    });
  }

  /**
   * And an ABSENT `lensConfig` is the same again, which is what makes writing
   * `"auto"` rather than deleting the key a safe choice for the panel.
   */
  it("matches a config with no lensConfig at all", () => {
    const absent = activeLenses(null, "PLAN_REVIEW", ["src/example.ts"]);
    expect(activeLenses({ lenses: "auto" }, "PLAN_REVIEW", ["src/example.ts"])).toEqual(absent);
    expect(activeLenses({ lenses: ALL_IDS }, "PLAN_REVIEW", ["src/example.ts"])).toEqual(absent);
  });

  /**
   * The guard that gives the parity above its meaning: a PROPER subset really
   * does change the review. Without this, an implementation that ignored
   * `lenses` entirely would satisfy every assertion in this file.
   */
  it("is not vacuous: dropping one lens really does drop it", () => {
    const all = activeLenses({ lenses: "auto" }, "PLAN_REVIEW", ["src/example.ts"]);
    const dropped = all[all.length - 1]!;
    const narrowed = activeLenses(
      { lenses: ALL_IDS.filter((id) => id !== dropped) },
      "PLAN_REVIEW",
      ["src/example.ts"],
    );
    expect(narrowed).not.toContain(dropped);
    expect(narrowed).toEqual(all.filter((id) => id !== dropped));
  });

  /**
   * THE PANEL'S OTHER TWO SUBSTITUTIONS, both of which write `auto`.
   *
   * An empty selection and an empty array are the same state, and the panel
   * writes `auto` for it because `[]` on disk would display as "none" while the
   * harness ran everything. This pins the harness half of that.
   */
  it("treats an empty list as auto, which is why the panel never writes one", () => {
    const auto = activeLenses({ lenses: "auto" }, "PLAN_REVIEW", ["src/example.ts"]);
    expect(activeLenses({ lenses: [] }, "PLAN_REVIEW", ["src/example.ts"])).toEqual(auto);
  });

  /**
   * The UNDECIDABLE case the panel refuses to draw a grid for.
   *
   * One unknown id falls the WHOLE list back to auto, so `["security","securty"]`
   * runs every lens rather than just security. That is why the app must not
   * present the recognisable half as a tidy selection: doing so, and then saving
   * it, would narrow the review to exactly the thing the harness was ignoring.
   */
  it("falls a partially misspelled list back to auto, not to its readable half", () => {
    const auto = activeLenses({ lenses: "auto" }, "PLAN_REVIEW", ["src/example.ts"]);
    const typo = activeLenses({ lenses: ["security", "securty"] }, "PLAN_REVIEW", ["src/example.ts"]);
    expect(typo).toEqual(auto);
    expect(typo).not.toEqual(["security"]);
  });
});
