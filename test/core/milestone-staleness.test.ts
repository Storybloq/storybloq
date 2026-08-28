import { describe, it, expect } from "vitest";
import {
  projectMilestoneStaleness,
  milestoneHedgeNote,
  MILESTONE_EXPECTED_CADENCE_SECONDS,
} from "../../src/core/milestone-staleness.js";
import type { MilestoneReadEvent } from "../../src/presence/types.js";

const NOW = Date.parse("2026-01-01T00:15:00.000Z");

function milestone(at: string, kind = "implementing"): MilestoneReadEvent {
  return { kind, at };
}

describe("projectMilestoneStaleness", () => {
  it("returns exactly the raw-facts shape, no more", () => {
    const projection = projectMilestoneStaleness(milestone("2026-01-01T00:00:00.000Z"), NOW);
    expect(projection).toEqual({
      kind: "implementing",
      at: "2026-01-01T00:00:00.000Z",
      elapsedSeconds: 900,
      expectedCadenceSeconds: 900,
      selfReported: true,
      clockAnomaly: false,
    });
  });

  it("is a permanent marker, never a computed verdict -- selfReported is always true", () => {
    const projection = projectMilestoneStaleness(milestone("2026-01-01T00:00:00.000Z"), NOW);
    expect(projection.selfReported).toBe(true);
  });

  it("clamps elapsed to 0 and sets clockAnomaly for a future timestamp beyond tolerance", () => {
    const future = new Date(NOW + 5 * 60_000).toISOString();
    const projection = projectMilestoneStaleness(milestone(future), NOW);
    expect(projection.elapsedSeconds).toBe(0);
    expect(projection.clockAnomaly).toBe(true);
  });

  it("uses MILESTONE_EXPECTED_CADENCE_SECONDS as the fixed cadence, matching the arrangement schema having no cadence field", () => {
    expect(MILESTONE_EXPECTED_CADENCE_SECONDS).toBe(900);
  });
});

describe("milestoneHedgeNote", () => {
  it("is null at exactly the cadence boundary", () => {
    const projection = projectMilestoneStaleness(milestone("2026-01-01T00:00:00.000Z"), NOW);
    expect(projection.elapsedSeconds).toBe(900);
    expect(milestoneHedgeNote(projection)).toBeNull();
  });

  it("fires one second past the cadence boundary", () => {
    const projection = projectMilestoneStaleness(milestone("2026-01-01T00:00:00.000Z"), NOW + 1000);
    expect(projection.elapsedSeconds).toBe(901);
    expect(milestoneHedgeNote(projection)).toBe("may be worth checking");
  });

  it("never fires when clockAnomaly is set, however large a positive elapsed a caller might construct by hand", () => {
    // Constructing the anomalous+large-elapsed combination directly (not
    // reachable through projectMilestoneStaleness itself) to pin the rule at
    // the function boundary: clockAnomaly always wins.
    const contrived = {
      kind: "implementing",
      at: "irrelevant",
      elapsedSeconds: 999_999,
      expectedCadenceSeconds: MILESTONE_EXPECTED_CADENCE_SECONDS,
      selfReported: true as const,
      clockAnomaly: true,
    };
    expect(milestoneHedgeNote(contrived)).toBeNull();
  });

  it("is null well before the cadence boundary", () => {
    const projection = projectMilestoneStaleness(milestone("2026-01-01T00:14:00.000Z"), NOW);
    expect(projection.elapsedSeconds).toBe(60);
    expect(milestoneHedgeNote(projection)).toBeNull();
  });
});
