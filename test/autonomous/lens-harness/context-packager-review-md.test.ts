/**
 * T-487 Run A: REVIEW.md reaches every lens, and does NOT do so at RULES.md's
 * expense.
 *
 * THE BUDGET POINT, WHICH IS THE WHOLE REASON THIS FILE EXISTS. The packager
 * reads RULES.md through a hardcoded `.slice(0, 2000)`. This repository's
 * RULES.md is 3497 bytes, so lenses reviewing it have never seen section 5
 * onward: the JSON Schemas rules, the testing rules, and section 7, which is
 * titled "CLAUDE.md vs REVIEW.md vs RULES.md" and is therefore the section
 * defining what REVIEW.md is FOR. That truncation is ISS-1125 and is not fixed
 * here.
 *
 * What IS fixed here is not making it worse. Appending REVIEW.md into the same
 * 2000 characters would evict rules content that is already being lost, under a
 * change whose stated purpose is to give reviewers MORE context. So REVIEW.md
 * gets its own budget, and these tests pin that the two do not compete.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageContext } from "../../../src/autonomous/lens-harness/context-packager.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "packager-contract-"));
}

const opts = (projectRoot: string) => ({
  stage: "CODE_REVIEW" as const,
  diff: "diff --git a/a b/a\n+x\n",
  changedFiles: [] as readonly string[],
  activeLenses: ["clean-code"] as readonly string[],
  ticketDescription: "T-001 do a thing",
  projectRoot,
  tokenBudgetPerLens: 32000,
});

describe("T-487: REVIEW.md reaches the lens prompt", () => {
  it("carries REVIEW.md into projectRules, and therefore into sharedHeader", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "RULES.md"), "RULE ONE: no em dashes.", "utf-8");
    writeFileSync(join(root, "REVIEW.md"), "## Security\nBlocking: blocking\n", "utf-8");

    const ctx = packageContext(opts(root));

    expect(ctx.projectRules).toContain("RULE ONE");
    expect(ctx.projectRules).toContain("Blocking: blocking");
    // sharedHeader is what actually reaches every lens prompt; projectRules
    // reaching it is the only reason appending here has any effect at all.
    expect(ctx.sharedHeader).toContain("Blocking: blocking");
  });

  it("works with REVIEW.md present and RULES.md absent", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "REVIEW.md"), "## Security\nBlocking: blocking\n", "utf-8");

    const ctx = packageContext(opts(root));

    expect(ctx.projectRules).toContain("Blocking: blocking");
    expect(ctx.projectRules).toContain("no RULES.md");
  });

  it("is unchanged when REVIEW.md is absent", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "RULES.md"), "RULE ONE: no em dashes.", "utf-8");

    const ctx = packageContext(opts(root));

    expect(ctx.projectRules).toContain("RULE ONE");
    expect(ctx.projectRules).not.toContain("REVIEW.md");
  });

  it("carries a REVIEW.md that declares no principles, because lenses still benefit", () => {
    // Activation gating (D1) governs the POLICY. It does not govern whether a
    // reviewer gets to read the file: a checklist-style REVIEW.md is useful
    // review guidance even when it declares no blocking class.
    const root = tmpRoot();
    writeFileSync(join(root, "REVIEW.md"), "## Always flag\n\n- Force unwraps\n", "utf-8");

    expect(packageContext(opts(root)).projectRules).toContain("Force unwraps");
  });
});

describe("T-487: REVIEW.md does not consume RULES.md's budget", () => {
  // Marker characters chosen so they cannot appear in the section headers this
  // code adds ("## REVIEW.md (quality contract)", "[REVIEW.md truncated ...]").
  // Counting "R" measured my own headers as rules content and reported a
  // 2-character difference that had nothing to do with the budget.
  const bigRules = "Z".repeat(5000);
  const bigReview = "Q".repeat(5000);

  it("RULES.md gets the same number of characters with or without REVIEW.md", () => {
    const without = tmpRoot();
    writeFileSync(join(without, "RULES.md"), bigRules, "utf-8");

    const with_ = tmpRoot();
    writeFileSync(join(with_, "RULES.md"), bigRules, "utf-8");
    writeFileSync(join(with_, "REVIEW.md"), bigReview, "utf-8");

    const rulesChars = (s: string) => (s.match(/Z/g) ?? []).length;

    // The property: adding REVIEW.md evicts NOTHING from the rules text. If the
    // two shared one budget this count would drop, and review context would get
    // worse under a change that claims to improve it.
    expect(rulesChars(packageContext(opts(with_)).projectRules))
      .toBe(rulesChars(packageContext(opts(without)).projectRules));
  });

  it("a large REVIEW.md is bounded too, so it cannot swamp the prompt", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "RULES.md"), bigRules, "utf-8");
    writeFileSync(join(root, "REVIEW.md"), bigReview, "utf-8");

    const rules = packageContext(opts(root)).projectRules;

    // Its own budget, not an unbounded one: a 5000-character contract must not
    // be able to push out the rest of the shared header.
    expect((rules.match(/Q/g) ?? []).length).toBeLessThan(5000);
    expect((rules.match(/Q/g) ?? []).length).toBeGreaterThan(0);
  });

  it("says when it truncated the contract, rather than cutting in silence", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "REVIEW.md"), bigReview, "utf-8");

    const rules = packageContext(opts(root)).projectRules;

    // The silent half of ISS-1125 is the part that misleads: a reviewer reading
    // a partial rulebook with no marker cannot know it is partial. Not
    // repeating that mistake in the code this run adds.
    expect(rules).toMatch(/truncated/i);
  });
});
