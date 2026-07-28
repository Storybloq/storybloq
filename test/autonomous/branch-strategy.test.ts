import { describe, expect, it } from "vitest";

/**
 * T-328 / D1: one decode boundary for `branchStrategy`.
 *
 * Before this ticket the value's union was declared independently in seven
 * places. The point of these tests is NOT to check that a parser exists -- it is
 * to make a PARTIAL widening fail. Adding "main" to five of the seven sites and
 * forgetting the sixth is the realistic mistake, so every consumer is asserted
 * on its own rather than through one shared set-equality check, which would be
 * tautological once they all import the same constant.
 *
 * The site that matters most is SessionStateSchema: it gates persisted session
 * reads through safeParse, so an un-widened enum there does not drop the field,
 * it makes the whole session unreadable.
 */

import {
  BRANCH_STRATEGIES,
  ACCEPTED_BRANCH_STRATEGY_INPUTS,
  DEFAULT_BRANCH_STRATEGY,
  parseBranchStrategy,
  type BranchStrategy,
} from "../../src/autonomous/branch-strategy.js";
import { ConfigSchema } from "../../src/models/config.js";
import { SessionStateSchema } from "../../src/autonomous/session-types.js";
import { resolveRecipe } from "../../src/autonomous/recipes/loader.js";

/** The legacy spelling. Accepted forever, never canonical, never newly written. */
const LEGACY_ALIAS = "none";

/** Every spelling a consumer must accept from outside. */
const ACCEPTED = ["current", "per-ticket", "main", LEGACY_ALIAS] as const;

describe("branch-strategy: canonical vs accepted value sets", () => {
  it("exposes exactly three canonical values", () => {
    expect([...BRANCH_STRATEGIES].sort()).toEqual(["current", "main", "per-ticket"]);
  });

  it("accepts the legacy alias as input but never lists it as canonical", () => {
    // These two sets are deliberately different. A test asserting they are equal
    // would be wrong, not merely weak: "none" must keep parsing forever while
    // never being a value the code compares against or writes.
    expect(ACCEPTED_BRANCH_STRATEGY_INPUTS).toContain(LEGACY_ALIAS);
    expect(BRANCH_STRATEGIES as readonly string[]).not.toContain(LEGACY_ALIAS);
    expect([...ACCEPTED_BRANCH_STRATEGY_INPUTS].sort()).toEqual([...ACCEPTED].sort());
  });

  it("defaults to current, the canonical spelling of the released behavior", () => {
    expect(DEFAULT_BRANCH_STRATEGY).toBe("current");
    expect(BRANCH_STRATEGIES).toContain(DEFAULT_BRANCH_STRATEGY);
  });
});

describe("parseBranchStrategy", () => {
  it.each(BRANCH_STRATEGIES)("round-trips the canonical value %s", (value) => {
    expect(parseBranchStrategy(value)).toBe(value);
  });

  it("maps the legacy none to current", () => {
    expect(parseBranchStrategy(LEGACY_ALIAS)).toBe("current");
  });

  it.each([
    ["unknown string", "trunk"],
    ["empty string", ""],
    ["wrong case", "Per-Ticket"],
    ["undefined", undefined],
    ["null", null],
    ["number", 1],
    ["object", { branchStrategy: "main" }],
    ["array", ["main"]],
  ])("returns null for %s", (_label, value) => {
    expect(parseBranchStrategy(value)).toBeNull();
  });

  it("never returns the legacy alias, whatever it is fed", () => {
    // Guards the invariant that "none" cannot escape the decode boundary.
    for (const input of [...ACCEPTED, "trunk", "", null, undefined]) {
      expect(parseBranchStrategy(input)).not.toBe(LEGACY_ALIAS);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-consumer acceptance. Each site asserted independently, so a site that
// forgets to widen fails its own case rather than hiding behind the others.
// ---------------------------------------------------------------------------

describe("consumer: ConfigSchema (project config)", () => {
  const config = (branchStrategy: unknown) => ({
    version: 2,
    schemaVersion: 1,
    project: "t328",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: { branchStrategy },
  });

  it.each(ACCEPTED)("accepts %s", (value) => {
    const parsed = ConfigSchema.safeParse(config(value));
    expect(parsed.success, `ConfigSchema rejected ${value}`).toBe(true);
  });

  it("rejects an unknown value", () => {
    expect(ConfigSchema.safeParse(config("trunk")).success).toBe(false);
  });
});

describe("consumer: SessionStateSchema (persisted session state)", () => {
  /**
   * Minimal state that satisfies the schema's required fields. Everything else
   * relies on schema defaults, which is what a real state.json leans on too.
   */
  const state = (resolvedBranchStrategy?: unknown) => ({
    schemaVersion: 1,
    sessionId: "00000000-0000-4000-8000-000000000328",
    recipe: "coding",
    state: "PICK_TICKET",
    revision: 1,
    status: "active",
    mode: "auto",
    lease: {
      workspaceId: "ws",
      lastHeartbeat: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-07-28T01:00:00.000Z",
    },
    lastGuideCall: "2026-07-28T00:00:00.000Z",
    startedAt: "2026-07-28T00:00:00.000Z",
    config: {
      maxTicketsPerSession: 5,
      compactThreshold: "high",
      reviewBackends: ["agent"],
    },
    ...(resolvedBranchStrategy === undefined ? {} : { resolvedBranchStrategy }),
  });

  it.each(ACCEPTED)("reads back a session persisted with %s", (value) => {
    const parsed = SessionStateSchema.safeParse(state(value));
    // This is the brick case: a rejection here does not lose a field, it makes
    // the entire session unreadable on its next read.
    expect(parsed.success, `SessionStateSchema rejected persisted ${value}`).toBe(true);
  });

  it("normalizes a persisted legacy none to current on read", () => {
    const parsed = SessionStateSchema.safeParse(state(LEGACY_ALIAS));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.resolvedBranchStrategy).toBe("current");
  });

  it("defaults to current when the field is absent", () => {
    const parsed = SessionStateSchema.safeParse(state(undefined));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.resolvedBranchStrategy).toBe("current");
  });

  it("rejects an unknown persisted value rather than silently defaulting", () => {
    // Silently defaulting would hide a corrupted or hand-edited state file.
    expect(SessionStateSchema.safeParse(state("trunk")).success).toBe(false);
  });
});

describe("consumer: resolveRecipe overrides", () => {
  it.each(ACCEPTED)("resolves override %s to a canonical value", (value) => {
    const recipe = resolveRecipe("coding", {
      branchStrategy: value as BranchStrategy,
    });
    expect(BRANCH_STRATEGIES).toContain(recipe.branchStrategy);
  });

  it("maps the legacy override to current", () => {
    const recipe = resolveRecipe("coding", { branchStrategy: LEGACY_ALIAS as BranchStrategy });
    expect(recipe.branchStrategy).toBe("current");
  });

  it.each(["main", "per-ticket"] as const)("preserves the canonical override %s", (value) => {
    expect(resolveRecipe("coding", { branchStrategy: value }).branchStrategy).toBe(value);
  });

  it("falls back to current with no override", () => {
    // The shipped coding.json carries the legacy spelling; whatever it says on
    // disk, what comes out of the loader must be canonical.
    expect(resolveRecipe("coding").branchStrategy).toBe("current");
  });

  it("ignores an unknown override instead of propagating it", () => {
    const recipe = resolveRecipe("coding", {
      branchStrategy: "trunk" as unknown as BranchStrategy,
    });
    expect(BRANCH_STRATEGIES).toContain(recipe.branchStrategy);
    expect(recipe.branchStrategy).toBe(DEFAULT_BRANCH_STRATEGY);
  });
});
