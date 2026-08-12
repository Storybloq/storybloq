import { describe, it, expect, afterEach, vi } from "vitest";

import { reviewBackendsForStage } from "../../src/autonomous/stages/codex-native.js";

/**
 * T-461 phase 1(a): `stages.PLAN_REVIEW.backends` and `stages.CODE_REVIEW.backends`
 * were documented in SKILL.md and orchestrator-mode.md and read by nothing.
 * Every stage called reviewBackendsForClient and ignored the resolved stage
 * config entirely.
 *
 * The half of this that needs the most protection is the LEGACY half. Sessions
 * frozen before T-461 persisted the recipe's own stage backends into
 * resolvedStages -- coding.json used to ship ["lenses", "codex", "agent"] there
 * -- and the stages of their era ignored them. Wiring the field up without a
 * gate would therefore not just fix a dead knob, it would reach back into every
 * in-flight session and change which reviewers run and what they cost. The
 * marker is what separates "a project asked for this" from "a recipe left this
 * lying in the state file".
 */

const MARKER = { level: "size-mapped", source: "default" };

afterEach(() => { vi.unstubAllEnvs(); });

describe("reviewBackendsForStage", () => {
  it("honors a project's per-stage backends once the session carries the marker", () => {
    const backends = reviewBackendsForStage("CODE_REVIEW", {
      config: { reviewBackends: ["codex", "agent"] },
      resolvedStages: { CODE_REVIEW: { backends: ["lenses"] } },
      resolvedReviewEffort: MARKER,
    });
    expect(backends).toEqual(["lenses"]);
  });

  it("resolves each stage independently", () => {
    const state = {
      config: { reviewBackends: ["codex", "agent"] },
      resolvedStages: {
        PLAN_REVIEW: { backends: ["agent"] },
        CODE_REVIEW: { backends: ["lenses", "codex"] },
      },
      resolvedReviewEffort: MARKER,
    };
    expect(reviewBackendsForStage("PLAN_REVIEW", state)).toEqual(["agent"]);
    expect(reviewBackendsForStage("CODE_REVIEW", state)).toEqual(["lenses", "codex"]);
  });

  it("falls back to the client list when only the OTHER stage is configured", () => {
    // The bug this guards: reading the stage key that happens to exist rather
    // than the one being resolved.
    expect(reviewBackendsForStage("PLAN_REVIEW", {
      config: { reviewBackends: ["codex", "agent"] },
      resolvedStages: { CODE_REVIEW: { backends: ["lenses"] } },
      resolvedReviewEffort: MARKER,
    })).toEqual(["codex", "agent"]);
  });

  // -------------------------------------------------------------------------
  // The legacy gate
  // -------------------------------------------------------------------------

  it("IGNORES persisted stage backends on a session frozen before the marker existed", () => {
    // The exact shape a pre-T-461 coding session carries: the old recipe's
    // backends sitting in resolvedStages, which its stages never read. Honoring
    // them on resume would add lenses to a running session's reviewers.
    const backends = reviewBackendsForStage("CODE_REVIEW", {
      config: { reviewBackends: ["codex", "agent"] },
      resolvedStages: { CODE_REVIEW: { backends: ["lenses", "codex", "agent"] } },
      // no resolvedReviewEffort: this is what makes it legacy
    });
    expect(backends).toEqual(["codex", "agent"]);
    expect(backends).not.toContain("lenses");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["a marker that lost its level", { source: "project" }],
    ["a marker whose level is not a string", { level: 7, source: "project" }],
    ["a marker whose level is null", { level: null, source: "project" }],
    ["a non-object marker", "size-mapped"],
    // handleStart never writes an invalid level or an unknown provenance, so
    // these are corruption on either side of the gate. When both branches are
    // corruption, prefer the mistake that cannot change a running session.
    ["a marker with an unrecognized level", { level: "quick", source: "project" }],
    ["a marker with an unrecognized provenance", { level: "light", source: "corrupt" }],
    ["a marker that lost its provenance", { level: "light" }],
  ])("treats %s as legacy, since it cannot prove the session is post-change", (_label, marker) => {
    // Presence is NOT proof. The session schema is deliberately permissive so a
    // corrupt record cannot brick a resume, which means it also admits these
    // shapes -- and accepting them here would revive a legacy session's frozen
    // recipe backends on the strength of a damaged field.
    const backends = reviewBackendsForStage("CODE_REVIEW", {
      config: { reviewBackends: ["codex", "agent"] },
      resolvedStages: { CODE_REVIEW: { backends: ["lenses"] } },
      resolvedReviewEffort: marker,
    });
    expect(backends).toEqual(["codex", "agent"]);
    expect(backends).not.toContain("lenses");
  });

  it.each([
    ["off", "start-call"],
    ["light", "project"],
    ["standard", "default"],
    ["thorough", "start-call"],
    ["size-mapped", "default"],
  ])("accepts every marker handleStart can actually write: %s / %s", (level, source) => {
    // The other side of the gate. Tightening it must not lock out a real
    // session, so every level x provenance combination handleStart can produce
    // is asserted to still honor the project's per-stage override.
    expect(reviewBackendsForStage("CODE_REVIEW", {
      config: { reviewBackends: ["codex", "agent"] },
      resolvedStages: { CODE_REVIEW: { backends: ["lenses"] } },
      resolvedReviewEffort: { level, source },
    })).toEqual(["lenses"]);
  });

  // -------------------------------------------------------------------------
  // Malformed per-stage config
  // -------------------------------------------------------------------------

  it.each([
    ["an empty array", []],
    ["a non-array", "lenses"],
    ["an array with a non-string", ["lenses", 7]],
    ["an array with an empty string", ["lenses", ""]],
    ["null", null],
  ])("falls back to the client list when the configured value is %s", (_label, configured) => {
    // Falls back WHOLE rather than filtering: a project that meant three
    // reviewers and typed one wrong should get its configured set or the
    // default, never a silently narrowed review it did not ask for.
    expect(reviewBackendsForStage("CODE_REVIEW", {
      config: { reviewBackends: ["codex", "agent"] },
      resolvedStages: { CODE_REVIEW: { backends: configured } },
      resolvedReviewEffort: MARKER,
    })).toEqual(["codex", "agent"]);
  });

  it("survives an absent resolvedStages entirely", () => {
    expect(reviewBackendsForStage("CODE_REVIEW", {
      config: { reviewBackends: ["codex", "agent"] },
      resolvedReviewEffort: MARKER,
    })).toEqual(["codex", "agent"]);
  });

  // -------------------------------------------------------------------------
  // Client selection still applies underneath
  // -------------------------------------------------------------------------

  it("keeps the codex client's own default when no per-stage override is set", () => {
    vi.stubEnv("STORYBLOQ_CLIENT", "codex");
    expect(reviewBackendsForStage("CODE_REVIEW", {
      config: { reviewBackends: ["codex", "agent"], codexReviewBackends: ["lenses"] },
      resolvedReviewEffort: MARKER,
    })).toEqual(["lenses"]);
  });

  it("lets an explicit per-stage override win on the codex client too", () => {
    // Deliberate: the per-stage key is a project-level statement, and the
    // client default exists to pick a sensible reviewer when nobody said.
    // Documented here because it is the one place the two rules meet.
    vi.stubEnv("STORYBLOQ_CLIENT", "codex");
    expect(reviewBackendsForStage("CODE_REVIEW", {
      config: { reviewBackends: ["codex", "agent"], codexReviewBackends: ["lenses"] },
      resolvedStages: { CODE_REVIEW: { backends: ["agent"] } },
      resolvedReviewEffort: MARKER,
    })).toEqual(["agent"]);
  });
});
