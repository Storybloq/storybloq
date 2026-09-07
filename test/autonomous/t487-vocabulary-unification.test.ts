/**
 * T-487 step 2, workstream A: CPM and `@storybloq/lenses` carry ONE provenance
 * vocabulary instead of two copies that happen to agree today.
 *
 * Three properties, and they are NOT equal evidence. Each says which.
 */

import { describe, expect, it } from "vitest";

import { FindingOriginClassSchema, FindingOriginSchema } from "@storybloq/lenses";

import {
  evaluateProvenanceGate,
  FINDING_ORIGIN_CLASSES,
  FINDING_ORIGINS,
  readOriginClassSlot,
} from "../../src/autonomous/review-identity.js";

describe("T-487 A: the vocabularies are single-sourced", () => {
  /**
   * THE RED PROPERTY. Reference identity, not value equality: value equality
   * is satisfied by a second copy that agrees, which is exactly the state this
   * workstream removes. Only a re-export makes these the SAME array.
   *
   * Kills the mutant "keep CPM's literal and merely assert it matches lenses",
   * which is what the file did before this change and what a careless revert
   * would restore.
   */
  it("FINDING_ORIGINS IS the lenses enum's options array", () => {
    expect(FINDING_ORIGINS).toBe(FindingOriginSchema.options);
  });

  it("FINDING_ORIGIN_CLASSES IS the lenses enum's options array", () => {
    expect(FINDING_ORIGIN_CLASSES).toBe(FindingOriginClassSchema.options);
  });
});

describe("T-487 A: the drift fence", () => {
  /**
   * WEAKER EVIDENCE, and labelled so. These were green before this change and
   * are green after, so they prove nothing about the unification. Their job is
   * the OTHER direction: lenses now owns this vocabulary, so a reorder or a
   * rename there would silently change CPM's persisted values and its guard.
   * Asserted against INLINE literals rather than against the import, because a
   * fence that reads its expectation from the thing it is fencing is not one.
   */
  it("origins are exactly these two values, in this order", () => {
    expect([...FINDING_ORIGINS]).toEqual(["introduced", "pre-existing"]);
  });

  it("origin classes are exactly these four values, in this order", () => {
    expect([...FINDING_ORIGIN_CLASSES]).toEqual([
      "new",
      "reintroduced",
      "unchanged",
      "introduced-by-fix",
    ]);
  });
});

describe("T-487 A: the validation seam is unchanged", () => {
  /**
   * The point of using `.options` rather than switching the guard to
   * `.safeParse` is that `readOriginClassSlot` keeps its exact behaviour: a
   * recognised value, an unrecognised CLAIM, and an absence stay three
   * different answers (T-328). Green before and after by design; here so that
   * a later "tidy-up" to safeParse has to break a named test rather than a
   * comment.
   */
  it("recognises every declared class", () => {
    for (const value of FINDING_ORIGIN_CLASSES) {
      expect(readOriginClassSlot(value)).toEqual({ kind: "recognised", value });
    }
  });

  it("the one-hyphen near miss is UNRECOGNISED, not absent", () => {
    expect(readOriginClassSlot("re-introduced")).toEqual({
      kind: "unrecognised",
      raw: "re-introduced",
    });
  });

  it("absence stays absence", () => {
    expect(readOriginClassSlot(undefined)).toEqual({ kind: "absent" });
    expect(readOriginClassSlot(null)).toEqual({ kind: "absent" });
  });
});

describe("T-487 E: the lens provenance exemption states a TRUE reason", () => {
  /**
   * THE RED PROPERTY, and it is not cosmetic.
   *
   * The exemption's reason is RECORDED on the verdict artifact, so it is a
   * persisted claim a later reader will rely on, not a comment. Until
   * `@storybloq/lenses@0.5.0` it said the lens schemas "cannot express
   * originClass (strict schema)", which was true: they were `.strict()` and
   * declared no such field.
   *
   * Step 1 widened them. The schemas CAN express it now. The exemption is
   * still correct, because no lens EMITS provenance, but the reason it gives
   * is a different fact from the one it used to give, and a stale reason on a
   * persisted artifact is exactly the defect this ticket exists to prevent:
   * a claim that reads authoritative and is no longer true.
   *
   * Kills the mutant "reword the comment above the export and leave the
   * runtime string alone", which is what a comment-only reading of this
   * workstream would have produced.
   */
  it("no longer claims the lens schemas cannot express originClass", () => {
    const gate = evaluateProvenanceGate({
      roundNum: 2,
      backend: "lenses",
      findings: [{ severity: "major", category: "c", description: "d", disposition: "open" }],
      repairSpent: false,
      atCeiling: false,
    });
    expect(gate.kind).toBe("exempt");
    if (gate.kind !== "exempt") return;
    expect(gate.reason).not.toMatch(/cannot express/i);
    expect(gate.reason).not.toMatch(/strict schema/i);
  });

  it("names the reason that IS true: nothing emits it yet, and who owns that", () => {
    const gate = evaluateProvenanceGate({
      roundNum: 2,
      backend: "lenses",
      findings: [{ severity: "major", category: "c", description: "d", disposition: "open" }],
      repairSpent: false,
      atCeiling: false,
    });
    expect(gate.kind).toBe("exempt");
    if (gate.kind !== "exempt") return;
    expect(gate.reason).toMatch(/emit/i);
    expect(gate.reason).toMatch(/ISS-1138/);
  });

  // The membership of PROVENANCE_EXEMPT_BACKENDS is NOT re-fenced here. It is
  // already covered, and covered better, by "exempts NOBODY else" in
  // test/autonomous/provenance-gate.test.ts, which also asserts that every
  // non-exempt backend reaches `repair`. A duplicate here would add a passing
  // test and no coverage, and this item has already produced enough tests that
  // looked like evidence without being any.
});
