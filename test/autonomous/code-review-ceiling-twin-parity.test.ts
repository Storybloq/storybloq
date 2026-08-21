import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_REVIEW_HARD_CEILING_GRACE } from "../../src/autonomous/stages/code-review-ceiling.js";
import { DEFAULT_CODE_REVIEW_MAX_ROUNDS } from "../../src/autonomous/session-diagnostics.js";
import { requiredRounds } from "../../src/autonomous/review-depth.js";

/**
 * The Mac panel QUOTES two of this engine's numbers back to the user (T-470).
 *
 * "Use the recipe default (12)" and "if blocking findings remain at round N+3
 * it stops" are not decoration: they are the only place a person is told what
 * the setting they are about to change will actually do. The panel cannot
 * import either number -- no runtime holds both languages -- so it hardcodes
 * them, and a hardcoded copy of someone else's constant is wrong the moment
 * that constant moves, with nothing failing on either side.
 *
 * The failure is silent by construction: change the grace to 5 here and every
 * suite stays green while the panel keeps promising a stop at N+3 that never
 * comes. So this reads the Swift source and compares.
 *
 * Read rather than imported for the same reason as the merge-table twin gate,
 * and inert in the public projection for the same reason: `Storybloq/storybloq`
 * carries `storybloq/` only.
 */

const here = resolve(fileURLToPath(import.meta.url), "..");
const panelPath = resolve(here, "../../../macos/claudestory/Views/Detail/AutonomousSettingsPanel.swift");
const recipePath = join(here, "../../src/autonomous/recipes/coding.json");

function swiftConstant(src: string, name: string): number {
  const m = new RegExp(`static let ${name}\\s*=\\s*(-?\\d+)`).exec(src);
  // A regex that matched nothing would otherwise report parity forever.
  expect(m, `could not find "static let ${name}" in the Swift panel`).not.toBeNull();
  return Number(m![1]);
}

const swiftPresent = existsSync(panelPath);

describe.skipIf(!swiftPresent)("the Mac panel quotes the engine's numbers", () => {
  it("uses the same ceiling grace the ceiling actually applies", () => {
    const src = readFileSync(panelPath, "utf-8");
    expect(swiftConstant(src, "codeReviewCeilingGrace")).toBe(CODE_REVIEW_HARD_CEILING_GRACE);
  });

  it("shows the recipe's own default cap in the toggle label", () => {
    const src = readFileSync(panelPath, "utf-8");
    const recipe = JSON.parse(readFileSync(recipePath, "utf-8")) as {
      stages?: { CODE_REVIEW?: { maxReviewRounds?: number } };
    };
    const recipeCap = recipe.stages?.CODE_REVIEW?.maxReviewRounds;
    // Pinned to the RECIPE, not to the engine fallback, because that is the
    // number a project without an override actually gets. They agree today;
    // this asserts both so a future divergence names which one moved.
    expect(recipeCap, "the coding recipe stopped setting a CODE_REVIEW cap").toBe(
      DEFAULT_CODE_REVIEW_MAX_ROUNDS,
    );
    expect(swiftConstant(src, "recipeCodeReviewMaxRounds")).toBe(recipeCap);
  });

  /**
   * The RISK FLOORS, which the panel now copies as a table.
   *
   * `effectiveCodeReviewMaxRounds` takes `max(cap, requiredRounds(risk))`, so
   * these numbers decide which stopping round the panel prints for a low cap.
   * The Swift tests derive their expectations from the copied table, so they
   * stay green if the engine's floors move and the panel starts quoting numbers
   * no session will use -- exactly the failure this gate exists to catch.
   */
  it("copies every risk floor the engine actually applies", () => {
    const src = readFileSync(panelPath, "utf-8");
    const decl = src.indexOf("requiredRoundsByRisk");
    expect(decl, "could not find the risk-floor table in the Swift panel").toBeGreaterThan(-1);
    // From the literal's opening bracket, not the identifier: the type
    // annotation `[(label: String, rounds: Int)]` closes a bracket first, and
    // slicing to that one produced an empty block that matched no rows.
    const start = src.indexOf("= [", decl);
    expect(start, "could not find the table literal").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("]", start));

    // EVERY tuple, not only the three labels this gate expects, and the label
    // pattern is ANY quoted string rather than `[a-zA-Z]+`: a row named
    // `"very-high"` or `"unknown_risk"` is a legal Swift entry the panel would
    // render, and a stricter pattern would skip it and leave `rows.length` at
    // three, reporting parity for a table the UI does not agree with. A
    // duplicate label is the same problem arriving as an overwrite.
    const re = /\("([^"]*)",\s*(-?\d+)\)/g;
    const rows: [string, number][] = [];
    for (let m = re.exec(block); m !== null; m = re.exec(block)) rows.push([m[1]!, Number(m[2])]);

    // Vacuous-pass guard: a regex that matched nothing would report parity
    // between two empty sets forever.
    expect(rows.length, "the Swift risk table parsed to no rows").toBe(3);
    expect(rows.map(([label]) => label)).toEqual(["low", "medium", "high"]);
    expect(Object.fromEntries(rows)).toEqual({
      low: requiredRounds("low"),
      medium: requiredRounds("medium"),
      high: requiredRounds("high"),
    });
  });
});

describe.skipIf(swiftPresent)("the panel parity gate", () => {
  it("is inert without the Mac app sources, which is the published-package case", () => {
    expect(swiftPresent).toBe(false);
  });
});
