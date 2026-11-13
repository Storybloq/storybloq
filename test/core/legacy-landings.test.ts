import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectLegacyLandings, LEGACY_LANDING_ID_REGEX } from "../../src/core/legacy-landings.js";
import { canonicalJson } from "../../src/core/canonical-json.js";

/** C-v4.1 3.5: legacy `landings` metadata, read-only views with stable lm- ids. */

const ENTRY = {
  sha: "a".repeat(40), remote: "origin", remoteUrl: "git@example.invalid:x.git", branch: "main",
  priorTip: "b".repeat(40), landedAt: "2026-01-01T00:00:00.000Z", steps: [{ step: "push", outcome: "ok" }],
};

describe("projectLegacyLandings", () => {
  it("reads none when the record has no landings", () => {
    expect(projectLegacyLandings({})).toEqual([]);
    expect(() => projectLegacyLandings({ landings: "not an array" })).toThrow(/landings is not an array/);
  });

  it("gives a stable lm- id: sha256 over canonicalJson, 16 hex characters", () => {
    const [view] = projectLegacyLandings({ landings: [ENTRY] });
    const expected = `lm-${createHash("sha256").update(canonicalJson(ENTRY)).digest("hex").slice(0, 16)}`;
    expect(view).toMatchObject({ source: "land-metadata", id: expected, sha: ENTRY.sha, branch: "main", landedAt: ENTRY.landedAt });
    expect(LEGACY_LANDING_ID_REGEX.test(view!.id)).toBe(true);
    // Key order on disk does not change the id.
    const reordered = Object.fromEntries(Object.entries(ENTRY).reverse());
    expect(projectLegacyLandings({ landings: [reordered] })[0]!.id).toBe(expected);
  });

  it("reads a missing field as unavailable and never defaults it", () => {
    const [view] = projectLegacyLandings({ landings: [{ sha: ENTRY.sha }] });
    expect(view).toMatchObject({ sha: ENTRY.sha, remote: "unavailable", branch: "unavailable", priorTip: "unavailable", landedAt: "unavailable" });
  });

  it("never claims current reachability", () => {
    const [view] = projectLegacyLandings({ landings: [ENTRY] });
    expect(view!.reachability).toBe("unavailable");
  });

  it("deduplicates identical entries by their legacy id, keeping first-seen order", () => {
    const other = { ...ENTRY, sha: "c".repeat(40) };
    const views = projectLegacyLandings({ landings: [ENTRY, other, { ...ENTRY }] });
    expect(views.map((v) => v.sha)).toEqual([ENTRY.sha, other.sha]);
  });

  it("skips elements that are not objects", () => {
    expect(projectLegacyLandings({ landings: [7, null, ENTRY] }).map((v) => v.sha)).toEqual([ENTRY.sha]);
  });
});

describe("review fixes, round 3: a present non-array landings value is refused, never shown as none", () => {
  it.each([["an object", { a: 1 }], ["a string", "landings"], ["null", null]])("refuses landings held as %s", (_l, value) => {
    expect(() => projectLegacyLandings({ id: "T-001", landings: value })).toThrow(/landings is not an array/);
  });

  it("an absent landings field is an empty view", () => {
    expect(projectLegacyLandings({ id: "T-001" })).toEqual([]);
  });
});

