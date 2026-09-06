/**
 * ISS-1115 Run A, D4/D5: finding provenance is THREE AXES, and the laundering
 * guard sits on the origin axis where a disposition cannot reach it.
 *
 * The axes, and why they are not one field:
 *   STATE       `disposition`   open | addressed | contested | deferred
 *   PROVENANCE  `origin`        introduced | pre-existing      (vs the PR base)
 *   PROVENANCE  `originClass`   new | reintroduced | unchanged | introduced-by-fix
 *                               (vs prior rounds)
 *
 * `sinceRound` is a separate NUMBER rather than a parameter baked into an enum
 * value. `unchanged-since-round-4` would give the field an unbounded value
 * space that no one can enumerate and would force every reader to parse an
 * integer out of a string.
 *
 * THE GUARD. A finding whose originClass is `reintroduced` blocks REGARDLESS of
 * its disposition. If the guard read disposition at all, marking a finding
 * `addressed` would be enough to launder a real regression back through the
 * gate. Putting it on the origin axis makes that unreachable rather than
 * merely disallowed, which is the same move as making the packet's diff a
 * required field instead of a droppable section.
 *
 * CONSERVATIVE READS. Persisted values are bare strings (T-328: an enum on a
 * persisted field does not drop a bad value, it makes the whole session
 * unreadable), so anything can arrive here. An unrecognised value is read at
 * its NOISIEST setting, never its quietest: unknown origin reads `introduced`,
 * unknown disposition reads `open`. Both mean "still live".
 */
import { describe, it, expect } from "vitest";
import {
  readFindingOrigin,
  readFindingDisposition,
  readFindingOriginClass,
  readSinceRound,
  findingIsBlockedByOrigin,
  readOriginClassSlot,
  classifyFindingProvenance,
  FINDING_ORIGINS,
  FINDING_ORIGIN_CLASSES,
} from "../../src/autonomous/review-identity.js";

describe("D4: origin reads conservatively", () => {
  it("reads the recognised values", () => {
    expect(readFindingOrigin("introduced")).toBe("introduced");
    expect(readFindingOrigin("pre-existing")).toBe("pre-existing");
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["a typo", "pre existing"],
    ["a value from a newer build", "introduced-upstream"],
    ["the wrong type", 7],
    ["an object", { origin: "pre-existing" }],
  ])("reads %s as `introduced`, the noisier reading", (_label, value) => {
    // `pre-existing` is the quieter reading: it says the diff did not cause
    // this. Defaulting an unreadable value to it would let a corrupt field
    // excuse a finding the change actually introduced.
    expect(readFindingOrigin(value)).toBe("introduced");
  });
});

describe("D4: disposition reads conservatively", () => {
  it("reads the recognised values", () => {
    for (const d of ["open", "addressed", "contested", "deferred"]) {
      expect(readFindingDisposition(d)).toBe(d);
    }
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a typo", "adressed"],
    ["a value from a newer build", "confirmed-fixed"],
    ["the wrong type", 3],
  ])("reads %s as `open`, the noisier reading", (_label, value) => {
    // Every other disposition means "settled" in some way. Guessing settled
    // from a value we cannot read is how a live finding disappears.
    expect(readFindingDisposition(value)).toBe("open");
  });
});

describe("D4: originClass and sinceRound are independent fields", () => {
  it("reads the recognised classes", () => {
    for (const c of FINDING_ORIGIN_CLASSES) {
      expect(readFindingOriginClass(c)).toBe(c);
    }
  });

  it("returns undefined for an unreadable class rather than guessing one", () => {
    // Unlike origin and disposition there is no safe default here: inventing
    // `reintroduced` would block everything unknown, and inventing `new` would
    // silently clear a genuine re-raise. Absent is the honest answer.
    for (const v of [undefined, null, "", "unchanged-since-round-4", 5, {}]) {
      expect(readFindingOriginClass(v)).toBeUndefined();
    }
  });

  it("reads sinceRound as a number, independent of originClass", () => {
    expect(readSinceRound(4)).toBe(4);
    // The parameter lives in its own field, so it survives without the class
    // and the class survives without it. Neither parses the other.
    expect(readSinceRound(4)).toBe(4);
    expect(readFindingOriginClass("unchanged")).toBe("unchanged");
  });

  it.each([
    ["absent", undefined],
    ["a string", "4"],
    ["a parseable-looking string", "round 4"],
    ["negative", -1],
    ["zero", 0],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s rather than coercing it", (_label, value) => {
    expect(readSinceRound(value)).toBeUndefined();
  });

  it("never encodes the round inside the class value", () => {
    // The shape this decomposition exists to forbid.
    for (const c of FINDING_ORIGIN_CLASSES) {
      expect(c).not.toMatch(/\d/);
      expect(c).not.toContain("since");
    }
  });
});

describe("D5: the laundering guard lives on the origin axis", () => {
  it("blocks a reintroduced finding whatever its disposition says", () => {
    for (const disposition of ["open", "addressed", "contested", "deferred"]) {
      expect(findingIsBlockedByOrigin({ originClass: "reintroduced", disposition })).toBe(true);
    }
  });

  it("blocks a reintroduced finding even at the lowest severity", () => {
    expect(findingIsBlockedByOrigin({
      originClass: "reintroduced", disposition: "addressed", severity: "suggestion",
    })).toBe(true);
  });

  it("does not block anything else", () => {
    for (const originClass of ["new", "unchanged", "introduced-by-fix"]) {
      expect(findingIsBlockedByOrigin({ originClass, disposition: "open" })).toBe(false);
    }
    expect(findingIsBlockedByOrigin({ disposition: "open" })).toBe(false);
    expect(findingIsBlockedByOrigin({})).toBe(false);
  });

  it("cannot be reached by a disposition alone", () => {
    // The property in one line: no disposition, on its own, makes the guard
    // fire or stops it firing.
    const withClass = ["open", "addressed", "contested", "deferred"]
      .map((d) => findingIsBlockedByOrigin({ originClass: "reintroduced", disposition: d }));
    const withoutClass = ["open", "addressed", "contested", "deferred"]
      .map((d) => findingIsBlockedByOrigin({ disposition: d }));
    expect(new Set(withClass)).toEqual(new Set([true]));
    expect(new Set(withoutClass)).toEqual(new Set([false]));
  });

  it("survives a non-object and a null without throwing", () => {
    for (const raw of [null, undefined, 4, "reintroduced", []]) {
      expect(findingIsBlockedByOrigin(raw)).toBe(false);
    }
  });

  it("BLOCKS a supplied-but-unrecognised originClass, without calling it reintroduced", () => {
    // The gate-1 defect, pinned. `re-introduced` with a hyphen used to read as
    // `undefined`, identical to absent, and sailed straight through the guard
    // built to stop it. Now it blocks -- and it blocks as UNRESOLVED, never as
    // a confirmed re-raise, because that is not known.
    for (const raw of ["re-introduced", "REINTRODUCED", "reintroduce", "unknown", ""]) {
      expect(findingIsBlockedByOrigin({ originClass: raw, disposition: "addressed" })).toBe(true);
      const p = classifyFindingProvenance({ originClass: raw });
      expect(p.condition).toBe("unresolved");
      expect(p.rawOriginClass).toBe(raw);
    }
  });

  it("keeps ABSENT and UNRECOGNISED apart, which is the whole point", () => {
    // Asserted as a pair in one test, because the defect was not that either
    // answer was wrong on its own: it was that they were the SAME answer.
    expect(classifyFindingProvenance({}).condition).toBe("unlabelled");
    expect(classifyFindingProvenance({ originClass: undefined }).condition).toBe("unlabelled");
    expect(classifyFindingProvenance({ originClass: "nonsense" }).condition).toBe("unresolved");
    expect(findingIsBlockedByOrigin({})).toBe(false);
    expect(findingIsBlockedByOrigin({ originClass: "nonsense" })).toBe(true);
  });

  it("treats a non-string claim as unrecognised rather than absent", () => {
    // A number or an object in that field is still a claim someone made and we
    // could not read. Calling it absent would let a malformed payload be
    // quieter than a well-formed wrong one.
    for (const raw of [4, { nope: true }, ["reintroduced"], true]) {
      expect(classifyFindingProvenance({ originClass: raw }).condition).toBe("unresolved");
    }
  });

  it("classifies the recognised non-reintroduced values as clean", () => {
    // The positive control for the two above: the classifier is not simply
    // answering "unresolved" to everything it is shown.
    for (const value of ["new", "unchanged", "introduced-by-fix"]) {
      expect(classifyFindingProvenance({ originClass: value }).condition).toBe("clean");
    }
    expect(classifyFindingProvenance({ originClass: "reintroduced" }).condition).toBe("reintroduced");
  });

  it("the slot reader reports all three kinds distinctly", () => {
    expect(readOriginClassSlot(undefined)).toEqual({ kind: "absent" });
    expect(readOriginClassSlot(null)).toEqual({ kind: "absent" });
    expect(readOriginClassSlot("new")).toEqual({ kind: "recognised", value: "new" });
    expect(readOriginClassSlot("bogus")).toEqual({ kind: "unrecognised", raw: "bogus" });
  });

  it("exposes the vocabularies it enforces", () => {
    expect([...FINDING_ORIGINS]).toEqual(["introduced", "pre-existing"]);
    expect([...FINDING_ORIGIN_CLASSES]).toEqual([
      "new", "reintroduced", "unchanged", "introduced-by-fix",
    ]);
  });
});
