import { describe, it, expect } from "vitest";
import {
  LIGHT_CODE_REVIEW_MAX_ROUNDS,
  effectiveReviewEffort,
  effortBackends,
  effortCodeReviewMaxRounds,
  effortDepthSentence,
  effortMinRounds,
  lensOnlyAtLight,
  mapIssueSeverityToEffort,
  mapSizeToEffort,
  normalizeReviewEffort,
  normalizeReviewEffortDefault,
  reviewEffortForIssue,
  reviewEffortForTicket,
  sessionEffortFromState,
  type SessionEffort,
} from "../../src/autonomous/review-effort.js";

/**
 * T-461, the dial itself.
 *
 * The level table is the contract, so it is asserted as a table. The single
 * most important property here is that `standard` is today's behavior: every
 * other level is a deviation someone asked for, and `standard` is what a
 * session that never touches the dial must keep getting.
 */

describe("normalizeReviewEffort", () => {
  it("accepts the four levels", () => {
    for (const level of ["off", "light", "standard", "thorough"] as const) {
      expect(normalizeReviewEffort(level)).toBe(level);
    }
  });

  it("fails closed to standard on anything malformed", () => {
    // Opposite direction from reviewRiskForTicket, which fails closed to high.
    // Risk failing closed buys more review; effort failing closed buys today's.
    for (const bad of [null, undefined, "", "LIGHT", "quick", 3, {}, [], true]) {
      expect(normalizeReviewEffort(bad), `value=${JSON.stringify(bad)}`).toBe("standard");
    }
  });

  it("distinguishes an absent session default from a malformed one", () => {
    // Absent means no pin, which is the size-mapped default. A typo must NOT
    // read as "no pin": size mapping can be lighter than standard, so that
    // would quietly buy less review than the project has today.
    expect(normalizeReviewEffortDefault(undefined)).toBe("size-mapped");
    expect(normalizeReviewEffortDefault("size-mapped")).toBe("size-mapped");
    expect(normalizeReviewEffortDefault("thorough")).toBe("thorough");
    // null is WRITTEN, not absent: `meta unset` deletes the key, so a null in
    // the file is a value someone put there, and it is not a level.
    for (const bad of [null, "nonsense", "quick", "", 3, {}]) {
      expect(normalizeReviewEffortDefault(bad), `value=${JSON.stringify(bad)}`).toBe("standard");
    }
  });

  it("keeps a typo'd project override from lightening a chore", () => {
    const session = sessionEffortFromState({ resolvedReviewEffort: { level: "quick", source: "project" } });
    expect(session.level).toBe("standard");
    expect(reviewEffortForTicket({ type: "chore" }, session).level).toBe("standard");
  });
});

describe("mapSizeToEffort", () => {
  it("maps the full matrix", () => {
    const cases: [unknown, "low" | "medium" | "high", string][] = [
      ["chore", "low", "light"],
      ["chore", "medium", "standard"],
      ["chore", "high", "thorough"],
      ["task", "low", "standard"],
      ["task", "medium", "standard"],
      ["task", "high", "thorough"],
      ["feature", "low", "standard"],
      ["feature", "high", "thorough"],
      [undefined, "low", "standard"],
    ];
    for (const [type, risk, expected] of cases) {
      expect(mapSizeToEffort(type, risk), `${String(type)}/${risk}`).toBe(expected);
    }
  });

  it("never maps the DEFAULT ticket type down, which would move the whole fleet off standard", () => {
    expect(mapSizeToEffort("task", "low")).toBe("standard");
  });

  it("maps issue severity so criticals do not triple the cost of the least-changed path", () => {
    expect(mapIssueSeverityToEffort("critical")).toBe("standard");
    expect(mapIssueSeverityToEffort("high")).toBe("standard");
    expect(mapIssueSeverityToEffort("medium")).toBe("light");
    expect(mapIssueSeverityToEffort("low")).toBe("light");
  });

  it("fails everything it does not recognize closed to standard, not to light", () => {
    // Only the two severities that MEAN small buy light. Written the obvious
    // way (critical || high ? standard : light) this reads identically for real
    // inputs while handing every malformed one LESS review than today.
    for (const bad of [undefined, null, "", "nonsense", "Medium", "sev-low", 7, {}, []]) {
      expect(mapIssueSeverityToEffort(bad), `severity=${JSON.stringify(bad)}`).toBe("standard");
    }
  });

  it("carries the fail-closed direction through issue resolution", () => {
    // The consequence, not just the mapper: an issue whose severity was typo'd
    // gets today's review rather than a cheap one.
    expect(reviewEffortForIssue({ severity: "medum" }))
      .toEqual({ level: "standard", source: "size-mapped" });
    expect(reviewEffortForIssue({}))
      .toEqual({ level: "standard", source: "size-mapped" });
    // A real low severity still maps down, so the guard did not flatten it.
    expect(reviewEffortForIssue({ severity: "low" }))
      .toEqual({ level: "light", source: "size-mapped" });
  });
});

describe("per-item resolution", () => {
  const pinned = (level: "off" | "light" | "standard" | "thorough"): SessionEffort =>
    ({ level, source: "start-call" });

  it("prefers explicit item metadata over both the session pin and size mapping", () => {
    const resolved = reviewEffortForTicket({ type: "chore", reviewEffort: "thorough" }, pinned("light"));
    expect(resolved).toEqual({ level: "thorough", source: "item" });
  });

  it("lets a ticket recover thorough over a session pinned to light", () => {
    // This is why the dial never writes into resolvedStages: the base values a
    // thorough item needs would already be gone.
    expect(reviewEffortForTicket({ reviewEffort: "thorough" }, pinned("light")).level).toBe("thorough");
  });

  it("falls to the session pin before size mapping", () => {
    const resolved = reviewEffortForTicket({ type: "chore" }, pinned("thorough"));
    expect(resolved).toEqual({ level: "thorough", source: "start-call" });
  });

  it("size-maps when nothing is pinned", () => {
    expect(reviewEffortForTicket({ type: "chore" }, { level: "size-mapped", source: "default" }))
      .toEqual({ level: "light", source: "size-mapped" });
    expect(reviewEffortForTicket({ type: "task" })).toEqual({ level: "standard", source: "size-mapped" });
  });

  it("fails a malformed explicit item value closed to standard rather than size-mapping it", () => {
    // Size mapping would send a malformed chore to light; failing closed must win.
    expect(reviewEffortForTicket({ type: "chore", reviewEffort: "quick" }))
      .toEqual({ level: "standard", source: "item" });
  });

  it("treats an item's written null as malformed, not as an absent override", () => {
    // `storybloq ticket meta set T-1 reviewEffort null` JSON.parses to a real
    // null, and `meta unset` deletes the key instead, so a null in the file is
    // always something someone wrote. Reading it as "no override" would send
    // this chore to light -- less review than the same ticket gets today.
    expect(reviewEffortForTicket({ type: "chore", reviewEffort: null }))
      .toEqual({ level: "standard", source: "item" });
    expect(reviewEffortForIssue({ severity: "low", reviewEffort: null }))
      .toEqual({ level: "standard", source: "item" });
    // The absent case still size-maps, so the guard did not disable the mapping.
    expect(reviewEffortForTicket({ type: "chore" }))
      .toEqual({ level: "light", source: "size-mapped" });
    expect(reviewEffortForIssue({ severity: "low" }))
      .toEqual({ level: "light", source: "size-mapped" });
  });

  it("resolves issues by the same precedence", () => {
    expect(reviewEffortForIssue({ severity: "low", reviewEffort: "thorough" }))
      .toEqual({ level: "thorough", source: "item" });
    expect(reviewEffortForIssue({ severity: "critical" }))
      .toEqual({ level: "standard", source: "size-mapped" });
    expect(reviewEffortForIssue({ severity: "low" }, pinned("off")))
      .toEqual({ level: "off", source: "start-call" });
  });

  it("reads a ticket's risk metadata through the existing fail-closed path", () => {
    // reviewRiskForTicket fails closed to high, so a malformed risk maps up.
    expect(reviewEffortForTicket({ type: "chore", reviewRisk: "nonsense" }).level).toBe("thorough");
  });
});

describe("sessionEffortFromState", () => {
  it("pins a pre-dial session to standard rather than size-mapping it", () => {
    // A session frozen before the dial shipped never opted into size mapping.
    // Letting it size-map would move a legacy session the moment it resumed
    // and picked its next item, which is exactly what the frozen-recipe
    // doctrine forbids.
    expect(sessionEffortFromState({})).toEqual({ level: "standard", source: "legacy" });
    // A literal null is NOT this case: a pre-dial session omits the key, it
    // does not write null over it. Same standard level, honest provenance.
    expect(sessionEffortFromState({ resolvedReviewEffort: null })).toEqual({ level: "standard", source: "unknown" });

    // and therefore a legacy session's chore does NOT drop to light
    expect(reviewEffortForTicket({ type: "chore" }, sessionEffortFromState({})).level).toBe("standard");
  });

  it("discloses a pre-dial pin as legacy rather than attributing it to the project", () => {
    // The level is right either way; the SOURCE is what a reader acts on.
    // Saying "project" would send someone hunting for a config setting that
    // was never written, when the real reason is that the session predates
    // the dial.
    expect(reviewEffortForTicket({ type: "chore" }, sessionEffortFromState({})))
      .toEqual({ level: "standard", source: "legacy" });
    // A project that really did pin a level still reports project.
    expect(reviewEffortForTicket(
      { type: "chore" },
      sessionEffortFromState({ resolvedReviewEffort: { level: "light", source: "project" } }),
    )).toEqual({ level: "light", source: "project" });
  });

  it("does not let a corrupt post-dial record borrow the legacy label", () => {
    // The persisted source is a bare string, so a record can carry a provenance
    // this build does not know. Reporting that as `legacy` would say "no
    // setting exists to find" about a session that may well have one, making a
    // corrupt record indistinguishable from a genuinely pre-dial one.
    const corrupt = sessionEffortFromState({ resolvedReviewEffort: { level: "standard", source: "corrupt" } });
    expect(corrupt).toEqual({ level: "standard", source: "unknown" });
    expect(reviewEffortForTicket({ type: "chore" }, corrupt))
      .toEqual({ level: "standard", source: "unknown" });

    // The level still fails closed, so the corruption costs disclosure detail
    // and never review depth.
    const corruptLevel = sessionEffortFromState({ resolvedReviewEffort: { level: "quick", source: "corrupt" } });
    expect(corruptLevel).toEqual({ level: "standard", source: "unknown" });
  });

  it("treats a marker that lost its level as corrupt, not as an absent default", () => {
    // The boundary case between the two branches above. A bare undefined level
    // means "no pin" when it comes from a config key nobody wrote, but the
    // marker's presence proves a level WAS resolved at start, so its absence
    // here is corruption. Reading it as "no pin" would size-map this chore down
    // to light, which is the whole failure this contract exists to prevent.
    const missingLevel = sessionEffortFromState({ resolvedReviewEffort: { source: "project" } });
    expect(missingLevel).toEqual({ level: "standard", source: "project" });
    expect(reviewEffortForTicket({ type: "chore" }, missingLevel))
      .toEqual({ level: "standard", source: "project" });

    // A marker that lost BOTH fields is still standard, and unattributable.
    expect(sessionEffortFromState({ resolvedReviewEffort: {} }))
      .toEqual({ level: "standard", source: "unknown" });
  });

  it("size-maps only a session created with the dial", () => {
    const withMarker = sessionEffortFromState({ resolvedReviewEffort: { level: "size-mapped", source: "default" } });
    expect(withMarker).toEqual({ level: "size-mapped", source: "default" });
    expect(reviewEffortForTicket({ type: "chore" }, withMarker).level).toBe("light");
  });

  it("carries a pinned level and its provenance", () => {
    expect(sessionEffortFromState({ resolvedReviewEffort: { level: "thorough", source: "start-call" } }))
      .toEqual({ level: "thorough", source: "start-call" });
  });
});

describe("effectiveReviewEffort", () => {
  it("reads standard when nothing is set, which is what a pre-dial session must keep doing", () => {
    expect(effectiveReviewEffort({}, "PLAN_REVIEW")).toBe("standard");
    expect(effectiveReviewEffort({ currentReviewEffort: null }, "CODE_REVIEW")).toBe("standard");
  });

  it("prefers the item level over the session default", () => {
    const state = { currentReviewEffort: "thorough", resolvedReviewEffort: { level: "light" } };
    expect(effectiveReviewEffort(state, "CODE_REVIEW")).toBe("thorough");
  });

  it("falls back to a pinned session level for modes that never reach PICK_TICKET", () => {
    // plan/review/guided modes bypass PICK_TICKET, so no item level is written.
    expect(effectiveReviewEffort({ resolvedReviewEffort: { level: "thorough" } }, "PLAN_REVIEW")).toBe("thorough");
  });

  it("reads a size-mapped session default as standard when there is no item to map", () => {
    expect(effectiveReviewEffort({ resolvedReviewEffort: { level: "size-mapped" } }, "PLAN_REVIEW")).toBe("standard");
  });

  it("lifts off to light for the stage a mode exists to run, and only that stage", () => {
    const off = { currentReviewEffort: "off" };
    expect(effectiveReviewEffort({ ...off, mode: "plan" }, "PLAN_REVIEW")).toBe("light");
    expect(effectiveReviewEffort({ ...off, mode: "plan" }, "CODE_REVIEW")).toBe("off");
    expect(effectiveReviewEffort({ ...off, mode: "review" }, "CODE_REVIEW")).toBe("light");
    expect(effectiveReviewEffort({ ...off, mode: "review" }, "PLAN_REVIEW")).toBe("off");
    expect(effectiveReviewEffort({ ...off, mode: "auto" }, "CODE_REVIEW")).toBe("off");
  });

  it("never lets off reach round arithmetic on a forced run", () => {
    // The reason nothing may read currentReviewEffort directly.
    const effort = effectiveReviewEffort({ currentReviewEffort: "off", mode: "review" }, "CODE_REVIEW");
    expect(effortMinRounds(effort, "low")).toBeGreaterThan(0);
  });
});

describe("effortMinRounds", () => {
  it("keeps standard equal to requiredRounds, which is today", () => {
    expect(effortMinRounds("standard", "low")).toBe(1);
    expect(effortMinRounds("standard", "medium")).toBe(2);
    expect(effortMinRounds("standard", "high")).toBe(3);
  });

  it("floors light at one round and lifts thorough to at least two", () => {
    for (const risk of ["low", "medium", "high"] as const) {
      expect(effortMinRounds("light", risk)).toBe(1);
    }
    expect(effortMinRounds("thorough", "low")).toBe(2);
    expect(effortMinRounds("thorough", "medium")).toBe(2);
    expect(effortMinRounds("thorough", "high")).toBe(3);
  });
});

describe("effortBackends", () => {
  const full = ["lenses", "codex", "agent"];

  it("changes nothing at standard, off or thorough", () => {
    for (const level of ["standard", "thorough", "off"] as const) {
      expect(effortBackends(level, full)).toEqual(full);
    }
  });

  it("narrows light to a single fast reviewer, preferring codex", () => {
    expect(effortBackends("light", full)).toEqual(["codex"]);
    expect(effortBackends("light", ["agent", "codex"])).toEqual(["codex"]);
  });

  it("drops lenses at light when something else is configured", () => {
    expect(effortBackends("light", ["lenses", "agent"])).toEqual(["agent"]);
  });

  it("never invents a backend the project did not configure", () => {
    // A lenses-only project keeps lenses rather than getting a reviewer it
    // never asked for. Disclosed, not silently swapped.
    expect(effortBackends("light", ["lenses"])).toEqual(["lenses"]);
    expect(lensOnlyAtLight("light", ["lenses"])).toBe(true);
    expect(lensOnlyAtLight("light", ["lenses", "codex"])).toBe(false);
    expect(lensOnlyAtLight("standard", ["lenses"])).toBe(false);
    expect(effortBackends("light", ["agent"])).toEqual(["agent"]);
    expect(effortBackends("light", [])).toEqual([]);
  });
});

describe("effortCodeReviewMaxRounds", () => {
  it("leaves standard and thorough on the configured cap", () => {
    expect(effortCodeReviewMaxRounds("standard", "low", 12, false)).toBe(12);
    expect(effortCodeReviewMaxRounds("thorough", "low", 12, false)).toBe(12);
  });

  it("caps light without dropping below the risk minimum", () => {
    expect(effortCodeReviewMaxRounds("light", "low", 12, false)).toBe(LIGHT_CODE_REVIEW_MAX_ROUNDS);
    expect(effortCodeReviewMaxRounds("light", "high", 12, false)).toBe(LIGHT_CODE_REVIEW_MAX_ROUNDS);
    // A cap already lower than the light cap is not raised by the dial.
    expect(effortCodeReviewMaxRounds("light", "low", 2, false)).toBe(2);
  });

  it("lets an explicitly project-set cap beat the dial", () => {
    expect(effortCodeReviewMaxRounds("light", "low", 12, true)).toBe(12);
  });

  it("keeps an explicitly disabled cap unlimited at every level", () => {
    for (const level of ["off", "light", "standard", "thorough"] as const) {
      expect(effortCodeReviewMaxRounds(level, "high", 0, false), level).toBe(0);
    }
  });
});

describe("effortDepthSentence", () => {
  it("adds nothing at standard, so today's instruction stays byte-identical", () => {
    expect(effortDepthSentence("standard", "plan")).toBeNull();
    expect(effortDepthSentence("off", "code")).toBeNull();
  });

  it("names the depth and the deliberate flag at light and thorough", () => {
    expect(effortDepthSentence("light", "plan")).toContain("deliberate: false");
    expect(effortDepthSentence("thorough", "plan")).toContain("deliberate: true");
    expect(effortDepthSentence("thorough", "code")).toContain("regressions");
  });
});
