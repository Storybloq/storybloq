/**
 * T-432: the honesty properties, asserted on the STRUCTURED RESULT.
 *
 * WHY NOT ON RENDERED TEXT. A renderer can print "some groups were excluded"
 * while the number beside it was computed as though they were not. Four rounds
 * of plan review turned on exactly that gap, so the invariants below read
 * numerator, denominator and counts directly and the renderer is tested
 * separately for reading them faithfully.
 *
 * The one property NOT tested here is population isolation, and deliberately:
 * `computeP1` takes `P1Input`, which has no field a state array or an event
 * could arrive through, so pooling is a type error. A test would be weaker than
 * the signature.
 */
import { describe, it, expect } from "vitest";
import {
  computeP1,
  computeMonthly,
  computeSessionRounds,
  nearestRank,
  normalizeBackend,
  isOrderIndeterminate,
  segmentAll,
  RECOGNISED_ORIGIN_CLASSES,
  type Backend,
} from "../../src/core/review-stats.js";
import type { P1Artifact, ScanReport, ScanState } from "../../src/core/review-stats-types.js";
import { renderValue } from "../../src/cli/commands/review-stats.js";

function scan(state: Record<string, ScanState> = { "p1:root": "COMPLETE" }): ScanReport {
  return {
    roots: ["/root"],
    startedAt: "2026-09-05T00:00:00.000Z",
    finishedAt: "2026-09-05T00:00:10.000Z",
    atomic: false,
    failures: [],
    readFailures: 0,
    state,
  };
}

let seq = 0;
function art(over: Partial<P1Artifact> = {}): P1Artifact {
  seq += 1;
  // `epochMs` DERIVES from whatever timestamp the case sets, so a fixture
  // cannot accidentally pin an instant that disagrees with the string beside
  // it. A case that wants them to disagree passes `epochMs` explicitly.
  const base: P1Artifact = {
    root: "/root",
    sessionId: "s1",
    fileName: `f${seq}.json`,
    target: "T-001",
    stage: "code",
    round: 1,
    verdict: "approve",
    reviewerRaw: "codex",
    findingsCount: 0,
    criticalCount: 0,
    timestamp: `2026-09-05T00:00:00.${String(seq).padStart(3, "0")}Z`,
    epochMs: null,
    contentHash: "h",
    originClasses: [],
    diffLines: null,
    ...over,
  };
  const explicit = Object.prototype.hasOwnProperty.call(over, "epochMs");
  if (explicit) return base;
  return {
    ...base,
    epochMs: base.timestamp === null ? null : Date.parse(base.timestamp),
  };
}

const by = (r: ReturnType<typeof computeP1>, id: string) =>
  r.metrics.find((m) => m.id === id)!;

describe("backend normalization, value by value", () => {
  // Every one of these is a real string measured in the fleet.
  const cases: readonly (readonly [string, Backend])[] = [
    ["agent", "agent"],
    ["codex", "codex"],
    ["lenses", "lenses"],
    ["gemini", "gemini"],
    ["manual", "manual"],
    ["storybloq-lenses", "lenses"],
    ["multi-lens", "lenses"],
    ["codex-bridge", "codex"],
    ["agent (code-reviewer)", "agent"],
    ["agent (feature-dev:code-reviewer)", "agent"],
    ["feature-dev:code-reviewer", "agent"],
    // More than one backend in one round: cannot enter a single-backend rate.
    ["codex+agent", "composite"],
    ["agent+lenses", "composite"],
    ["lenses+codex", "composite"],
    ["codex+lenses", "composite"],
    ["codex + adversarial Opus agent (dual)", "composite"],
    ["codex-bridge (gemini)", "composite"],
    ["codex-bridge (published) via gemini", "composite"],
  ];
  for (const [raw, expected] of cases) {
    it(`"${raw}" -> ${expected}`, () => {
      expect(normalizeBackend(raw)).toBe(expected);
    });
  }

  it("an unknown SINGLE backend is `other`, never `composite`", () => {
    // The two mean different things: `other` is one backend we have no bucket
    // for, `composite` is more than one in one round. Collapsing them would put
    // an attributable round into the unattributable bucket.
    expect(normalizeBackend("some-new-reviewer")).toBe("other");
    expect(normalizeBackend("")).toBe("other");
  });

  it("composite never appears in a single-backend rate", () => {
    const r = computeP1({
      artifacts: [art({ reviewerRaw: "codex" }), art({ reviewerRaw: "codex+agent" })],
      scan: scan(),
    });
    expect(r.backends.composite).toBe(1);
    expect(r.backends.codex).toBe(1);
    // and it is not silently added to either single backend
    expect(r.backends.agent).toBeUndefined();
  });
});

describe("ordering eligibility is decided on the whole group, before segmentation", () => {
  it("a TIE with IDENTICAL VERDICTS still disqualifies the group", () => {
    // The case an earlier draft missed by checking only whether a tie changed
    // the last verdict. Two tied rounds with the same verdict give one segment
    // in one ordering and two in the reverse, so the SEGMENT COUNT is
    // order-dependent even though the last verdict is not.
    const t = "2026-09-05T00:00:01.000Z";
    const group = [
      art({ round: 1, verdict: "revise", timestamp: t }),
      art({ round: 2, verdict: "revise", timestamp: t }),
    ];
    expect(isOrderIndeterminate(group)).toBe(true);

    const seg = segmentAll(group);
    expect(seg.segments).toHaveLength(0);
    expect(seg.excludedGroups).toBe(1);
  });

  it("an UNDATED record disqualifies its whole group, not just its own segment", () => {
    // Assigning it to a segment would already have assumed the order in
    // question, and its true position could move OTHER boundaries.
    const group = [
      art({ round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
      art({ round: 2, timestamp: null }),
      art({ round: 3, timestamp: "2026-09-05T00:00:03.000Z" }),
    ];
    const seg = segmentAll(group);
    expect(seg.excludedGroups).toBe(1);
    expect(seg.segments).toHaveLength(0);
    // The records are still readable and still counted as records.
    expect(seg.excludedArtifacts).toBe(3);
  });

  it("a MISSING ROUND disqualifies its group, because the break rule is on rounds", () => {
    // Otherwise the sentinel decides: a null round sorts as -Infinity, which
    // never breaks after it and always breaks before it, so the segment count
    // would be a property of the sentinel rather than of the data.
    const group = [
      art({ round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
      art({ round: null, timestamp: "2026-09-05T00:00:02.000Z" }),
    ];
    expect(isOrderIndeterminate(group)).toBe(true);
    expect(segmentAll(group).excludedGroups).toBe(1);
  });

  it("a clean monotonic run is ONE segment", () => {
    const seg = segmentAll([
      art({ round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
      art({ round: 2, timestamp: "2026-09-05T00:00:02.000Z" }),
      art({ round: 3, timestamp: "2026-09-05T00:00:03.000Z" }),
    ]);
    expect(seg.segments).toHaveLength(1);
    expect(seg.excludedGroups).toBe(0);
  });

  it("an OVERWRITE ordering 2,1 breaks into two segments", () => {
    // Round 1 rewritten after round 2 survives. The convention produces a
    // break; the plan is explicit that this is a convention and not evidence
    // that a redirect occurred.
    const seg = segmentAll([
      art({ round: 2, timestamp: "2026-09-05T00:00:01.000Z" }),
      art({ round: 1, timestamp: "2026-09-05T00:00:02.000Z" }),
    ]);
    expect(seg.segments).toHaveLength(2);
  });

  it("INTERLEAVED sessions A,B,A do not split A's increasing run", () => {
    // Session is part of the grouping key, so B cannot cut A in half. Before
    // that, ordering across sessions produced three segments for two runs.
    const seg = segmentAll([
      art({ sessionId: "A", round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
      art({ sessionId: "B", round: 1, timestamp: "2026-09-05T00:00:02.000Z" }),
      art({ sessionId: "A", round: 2, timestamp: "2026-09-05T00:00:03.000Z" }),
    ]);
    expect(seg.segments).toHaveLength(2);
    const a = seg.segments.find((s) => s.sessionId === "A")!;
    expect(a.artifacts).toHaveLength(2);
  });
});

describe("INVARIANT: absence is never zero", () => {
  it("an empty denominator gives a null rate, not 0", () => {
    // The whole point of the deliverable. A 0% re-raise rate over no labels
    // would read as "this backend never re-raises".
    const r = computeP1({ artifacts: [art({ originClasses: [] })], scan: scan() });
    const m = by(r, "re-raise-rate");
    expect(m.denominator).toBe(0);
    expect(m.value).toBeNull();
  });

  it("holds for every metric with a zero denominator", () => {
    const r = computeP1({ artifacts: [], scan: scan() });
    for (const m of r.metrics) {
      if (m.denominator === 0 || m.denominator === null) expect(m.value).toBeNull();
    }
  });
});

describe("INVARIANT: missingness moves coverage, never the rate", () => {
  it("adding UNLABELLED findings leaves the re-raise rate untouched", () => {
    // Revision 2 of the plan had this backwards and would have let unlabelled
    // findings dilute the rate: more unlabelled findings, lower re-raise rate,
    // on no new evidence.
    const base = [art({ originClasses: ["reintroduced", "new"] })];
    const before = by(computeP1({ artifacts: base, scan: scan() }), "re-raise-rate");

    const after = by(computeP1({
      artifacts: [...base, art({ originClasses: [null, undefined] })],
      scan: scan(),
    }), "re-raise-rate");

    expect(after.numerator).toBe(before.numerator);
    expect(after.denominator).toBe(before.denominator);
    expect(after.value).toBe(before.value);
    // Coverage moved, and only coverage.
    expect(after.records.missing).toBeGreaterThan(before.records.missing);
  });

  it("adding an UNRECOGNISED label leaves the rate untouched and counts it invalid", () => {
    // An unreadable label must not be silently counted as a non-re-raise.
    const base = [art({ originClasses: ["reintroduced"] })];
    const before = by(computeP1({ artifacts: base, scan: scan() }), "re-raise-rate");

    const after = by(computeP1({
      artifacts: [...base, art({ originClasses: ["sort-of-new", 7] })],
      scan: scan(),
    }), "re-raise-rate");

    expect(after.value).toBe(before.value);
    expect(after.denominator).toBe(before.denominator);
    expect(after.records.invalid).toBe(2);
  });

  it("metric 4's record counts are in FINDINGS, its own unit", () => {
    // Every other metric has one record per artifact. This one has one per
    // finding, and reporting the artifact count as `readable` beside a
    // finding-count `missing` would put two units in one accounting.
    const r = computeP1({
      artifacts: [
        art({ originClasses: ["new", "reintroduced", null] }),
        art({ originClasses: ["bogus"] }),
      ],
      scan: scan(),
    });
    const m = by(r, "re-raise-rate");
    expect(m.unit).toBe("finding");
    expect(m.records.readable).toBe(4);
    expect(m.records.total).toBe(4);
    expect(m.records.missing).toBe(1);
    expect(m.records.invalid).toBe(1);
    // and the two artifacts are NOT what this metric counts
    expect(m.records.readable).not.toBe(2);
  });

  it("the recognised set is closed", () => {
    expect([...RECOGNISED_ORIGIN_CLASSES].sort()).toEqual(
      ["introduced-by-fix", "new", "reintroduced", "unchanged"],
    );
  });
});

describe("INVARIANT: records and segments never share a denominator", () => {
  it("an excluded group makes the segment total unknown, on a fully readable scan", () => {
    // Unreadability and indeterminate chronology are different defects. Only
    // the first is a scan problem, so this must be null even at COMPLETE.
    const t = "2026-09-05T00:00:01.000Z";
    const r = computeP1({
      artifacts: [
        art({ target: "T-1", round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
        art({ target: "T-1", round: 2, timestamp: "2026-09-05T00:00:02.000Z" }),
        art({ target: "T-2", round: 1, timestamp: t }),
        art({ target: "T-2", round: 2, timestamp: t }),
      ],
      scan: scan(),
    });
    const m = by(r, "rounds-per-segment");

    expect(m.scanState).toBe("COMPLETE");
    expect(m.segments!.excludedGroups).toBe(1);
    expect(m.segments!.segmentTotal).toBeNull();
    // Neither the artifacts nor the excluded group entered the segment count.
    expect(m.segments!.eligibleSegments).toBe(1);
    expect(m.records.readable).toBe(4);
  });

  it("several artifacts per segment do not inflate the segment denominator", () => {
    const r = computeP1({
      artifacts: [
        art({ round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
        art({ round: 2, timestamp: "2026-09-05T00:00:02.000Z" }),
        art({ round: 3, timestamp: "2026-09-05T00:00:03.000Z" }),
      ],
      scan: scan(),
    });
    const m = by(r, "rounds-per-segment");
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBe(3);
    expect(m.segments!.segmentTotal).toBe(1);
  });
});

describe("INVARIANT: an incomplete scan never yields a population total", () => {
  it("PARTIAL nulls the total and marks the rate conditional", () => {
    const r = computeP1({
      artifacts: [art({ originClasses: ["new"] }), art({ originClasses: ["new"] })],
      scan: scan({ "p1:root": "PARTIAL" }),
    });
    for (const m of r.metrics) {
      expect(m.records.total).toBeNull();
      expect(m.conditional).toBe(true);
      // Readable is still reported, so the numerator stays usable. Asserted as
      // "something was read" rather than "two artifacts": metric 4 is
      // denominated in FINDINGS, and pinning every metric to the artifact count
      // is the unit mixing this suite exists to forbid.
      expect(m.records.readable).toBeGreaterThan(0);
    }
    // The artifact-denominated metrics do carry the artifact count.
    expect(by(r, "zero-critical-rounds").records.readable).toBe(2);
  });

  it("UNAVAILABLE nulls the total too", () => {
    const r = computeP1({ artifacts: [], scan: scan({ "p1:root": "UNAVAILABLE" }) });
    for (const m of r.metrics) expect(m.records.total).toBeNull();
  });

  it("COMPLETE reports the total and is not conditional", () => {
    const r = computeP1({ artifacts: [art({ originClasses: ["new"] })], scan: scan() });
    for (const m of r.metrics) {
      // The invariant is that a COMPLETE scan KNOWS its population size, not
      // that every population is the same size.
      expect(m.records.total).not.toBeNull();
      expect(m.records.total).toBe(m.records.readable);
      expect(m.conditional).toBe(false);
    }
    expect(by(r, "zero-critical-rounds").records.total).toBe(1);
    // one artifact, one finding: same number here, different populations
    expect(by(r, "re-raise-rate").records.total).toBe(1);
  });

  it("incompleteness PROPAGATES: one partial population makes the aggregate partial", () => {
    const r = computeP1({
      artifacts: [art()],
      scan: scan({ "p1:rootA": "COMPLETE", "p1:rootB": "PARTIAL" }),
    });
    expect(by(r, "zero-critical-rounds").scanState).toBe("PARTIAL");
  });
});

describe("INVARIANT: provenance is declared and honest", () => {
  it("every metric declares a provenance in the enum", () => {
    const r = computeP1({ artifacts: [art()], scan: scan() });
    for (const m of r.metrics) {
      expect(["observed", "derived", "reconstructed"]).toContain(m.provenance);
      expect(m.population).toBe("p1");
    }
  });

  it("EVERY segment-denominated metric declares `reconstructed`", () => {
    // A segment is a reconstruction, so anything denominated in segments depends
    // on one, however observed its numerator field is. This invariant is what
    // caught two metrics in this very module labelled `observed` and `derived`
    // while both were counting reconstructed segments: presenting a
    // reconstruction as an observation is the exact failure the deliverable
    // exists to prevent.
    const r = computeP1({
      artifacts: [
        art({ round: 1, diffLines: 10, timestamp: "2026-09-05T00:00:01.000Z" }),
        art({ round: 2, timestamp: "2026-09-05T00:00:02.000Z" }),
      ],
      scan: scan(),
    });
    const segmentDenominated = r.metrics.filter((m) => m.unit === "segment");
    expect(segmentDenominated.length).toBeGreaterThan(0);
    for (const m of segmentDenominated) expect(m.provenance).toBe("reconstructed");
    // And the converse: nothing carrying `segments` accounting escapes the rule.
    for (const m of r.metrics) {
      if (m.segments !== undefined) expect(m.provenance).toBe("reconstructed");
    }
  });

  it("the reconstruction rule is carried with the numbers, not left in docs", () => {
    const r = computeP1({ artifacts: [art()], scan: scan() });
    expect(r.reconstructionRule).toContain("segmentation convention");
    expect(r.reconstructionRule).toContain("not evidence");
  });
});

describe("no completion is claimed", () => {
  it("the last-verdict metric is named for what it measures", () => {
    const r = computeP1({ artifacts: [art()], scan: scan() });
    const m = by(r, "segments-last-verdict-not-approve");
    expect(m.label).toContain("last surviving verdict");
    expect(m.label.toLowerCase()).not.toContain("forced landing");
    expect(m.note).toContain("No completion is established");
    expect(m.provenance).toBe("reconstructed");
  });

  it("counts a non-approve last verdict, as of scan", () => {
    const r = computeP1({
      artifacts: [
        art({ target: "T-1", round: 1, verdict: "revise", timestamp: "2026-09-05T00:00:01.000Z" }),
        art({ target: "T-1", round: 2, verdict: "revise", timestamp: "2026-09-05T00:00:02.000Z" }),
        art({ target: "T-2", round: 1, verdict: "approve", timestamp: "2026-09-05T00:00:03.000Z" }),
      ],
      scan: scan(),
    });
    const m = by(r, "segments-last-verdict-not-approve");
    expect(m.numerator).toBe(1);
    expect(m.denominator).toBe(2);
  });
});

describe("INDEPENDENT EXPECTED VALUES", () => {
  it("hand-computed numerators and denominators, so a subtree compare cannot hide a pooled result", () => {
    const r = computeP1({
      artifacts: [
        art({ criticalCount: 0, findingsCount: 0, verdict: "revise", round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
        art({ criticalCount: 2, findingsCount: 3, verdict: "revise", round: 2, timestamp: "2026-09-05T00:00:02.000Z" }),
        art({ criticalCount: 0, findingsCount: 1, verdict: "approve", round: 3, timestamp: "2026-09-05T00:00:03.000Z" }),
      ],
      scan: scan(),
    });
    // 2 of 3 rounds have zero criticals.
    expect(by(r, "zero-critical-rounds").numerator).toBe(2);
    expect(by(r, "zero-critical-rounds").denominator).toBe(3);
    // 2 rounds requested changes; 1 of them named nothing.
    expect(by(r, "zero-finding-revise-rounds").numerator).toBe(1);
    expect(by(r, "zero-finding-revise-rounds").denominator).toBe(2);
    // one segment, three rounds
    expect(by(r, "rounds-per-segment").numerator).toBe(3);
    expect(by(r, "rounds-per-segment").denominator).toBe(1);
  });
});

describe("diff lines needs evidence that round 1 survived", () => {
  it("a segment whose lowest surviving round is 2 is not counted", () => {
    const r = computeP1({
      artifacts: [
        art({ round: 2, diffLines: 100, timestamp: "2026-09-05T00:00:01.000Z" }),
        art({ round: 3, diffLines: 100, timestamp: "2026-09-05T00:00:02.000Z" }),
      ],
      scan: scan(),
    });
    const m = by(r, "diff-lines-first-surviving-review");
    expect(m.denominator).toBe(0);
    expect(m.value).toBeNull();
    expect(m.note).toContain("LOWEST SURVIVING round is 1");
  });
});

describe("the session-stage summary is P2 and says so", () => {
  const rounds = [
    { round: 1, verdict: "revise", findingCount: 0, criticalCount: 0 },
    { round: 2, verdict: "revise", findingCount: 3, criticalCount: 1 },
    { round: 3, verdict: "approve", findingCount: 0, criticalCount: 0 },
  ];

  it("declares population p2, never p1", () => {
    // A state row carries no target, so it can summarise a session and a stage
    // and can never speak for one work item. Labelling it p1 would put it in
    // the same namespace as the per-item artifacts.
    for (const m of computeSessionRounds({ stage: "code", rounds })) {
      expect(m.population).toBe("p2");
    }
  });

  it("labels every row as this session's own", () => {
    for (const m of computeSessionRounds({ stage: "code", rounds })) {
      expect(m.label).toContain("this session");
    }
  });

  it("hand-computed: 2 of 3 zero-critical, 1 of 2 change-requests naming nothing", () => {
    const [zeroCritical, zeroFinding] = computeSessionRounds({ stage: "code", rounds });
    expect([zeroCritical!.numerator, zeroCritical!.denominator]).toEqual([2, 3]);
    expect([zeroFinding!.numerator, zeroFinding!.denominator]).toEqual([1, 2]);
  });

  it("a stage with no change-request round has NO rate, not a zero one", () => {
    // 0% there would read as evidence that this session's reviewers always
    // named their findings.
    const [, zeroFinding] = computeSessionRounds({
      stage: "plan",
      rounds: [{ round: 1, verdict: "approve", findingCount: 0, criticalCount: 0 }],
    });
    expect(zeroFinding!.denominator).toBe(0);
    expect(zeroFinding!.value).toBeNull();
  });
});

describe("monthly rollups", () => {
  it("nearest-rank returns a value the data actually had", () => {
    // Interpolation would return a fractional count of rounds, a quantity no
    // segment can have.
    expect(nearestRank([1, 2, 3, 4], 50)).toBe(2);
    expect(nearestRank([1, 2, 3, 4], 90)).toBe(4);
    expect(nearestRank([1, 2, 3, 4], 100)).toBe(4);
    expect(nearestRank([7], 50)).toBe(7);
    expect(nearestRank([], 50)).toBeNull();
  });

  it("p0 does not fall off the bottom of the array", () => {
    // ceil(0) is 0, which would index -1 without the clamp.
    expect(nearestRank([5, 6], 0)).toBe(5);
  });

  it("a SEGMENT spanning a month boundary is assigned by its LAST timestamp", () => {
    // One rule for every segment metric, so two columns in one row are never
    // assigned differently.
    const r = computeMonthly({
      artifacts: [
        art({ round: 1, timestamp: "2026-05-31T23:00:00.000Z" }),
        art({ round: 2, timestamp: "2026-06-01T01:00:00.000Z" }),
      ],
      scan: scan(),
    }, 1);
    const may = r.rows.find((x) => x.month === "2026-05")!;
    const june = r.rows.find((x) => x.month === "2026-06")!;
    // The rounds land in their own months...
    expect(may.rounds).toBe(1);
    expect(june.rounds).toBe(1);
    // ...but the single segment lands only in June.
    expect(may.segments).toBe(0);
    expect(june.segments).toBe(1);
  });

  it("a month below the minimum WITHHOLDS percentiles and still reports its count", () => {
    const r = computeMonthly({
      artifacts: [art({ round: 1, timestamp: "2026-05-01T00:00:00.000Z" })],
      scan: scan(),
    }, 5);
    const row = r.rows[0]!;
    expect(row.segments).toBe(1);
    expect(row.belowMinimum).toBe(true);
    // Withheld, not zero. A `0` here would read as a measured median.
    expect(row.roundsPerSegmentP50).toBeNull();
    expect(row.roundsPerSegmentP90).toBeNull();
  });

  it("an undated round is counted as unassignable, never dropped into a month", () => {
    const r = computeMonthly({
      artifacts: [
        art({ round: 1, timestamp: null }),
        art({ round: 1, timestamp: "2026-05-01T00:00:00.000Z" }),
      ],
      scan: scan(),
    }, 1);
    expect(r.unassignableRounds).toBe(1);
    expect(r.rows.reduce((n, x) => n + x.rounds, 0)).toBe(1);
  });

  it("a COMPLETE scan with nothing excluded reports a DETERMINATE zero hidden", () => {
    // Always-null was manufactured uncertainty. Here the hidden count is known,
    // and it is zero; saying UNKNOWN is the same defect as saying zero when it
    // is unknown, mirrored.
    const r = computeMonthly({
      artifacts: [art({ round: 1, timestamp: "2026-05-01T00:00:00.000Z" })],
      scan: scan(),
    }, 1);
    expect(r.excludedGroups).toBe(0);
    expect(r.suppressedSessions).toBe(0);
    expect(r.segmentsHiddenByExclusion).toBe(0);
  });

  it("but an excluded group makes it UNKNOWN again", () => {
    const t = "2026-05-01T00:00:00.000Z";
    const r = computeMonthly({
      artifacts: [art({ round: 1, timestamp: t }), art({ round: 2, timestamp: t })],
      scan: scan(),
    }, 1);
    expect(r.excludedGroups).toBe(1);
    expect(r.segmentsHiddenByExclusion).toBeNull();
  });

  it("the assignment rules travel with the table", () => {
    const r = computeMonthly({ artifacts: [art()], scan: scan() }, 1);
    expect(r.rules).toContain("NEAREST-RANK");
    expect(r.rules).toContain("LAST determinable artifact timestamp");
  });

  it("the rules claim separate counting for ROUNDS only, never for segments", () => {
    // The text said "Rounds and segments with no determinable timestamp are
    // counted separately" and then, one sentence later, that the number of
    // hidden segments is UNKNOWN. Both cannot be true, and only `rounds` has a
    // field: an indeterminate group is EXCLUDED, and how many segments that hid
    // is exactly the unknown the next sentence names. The reassuring sentence
    // was the wrong one, which is the direction that matters.
    const t = "2026-05-01T00:00:00.000Z";
    const r = computeMonthly({
      artifacts: [art({ round: 1, timestamp: t }), art({ round: 2, timestamp: t })],
      scan: scan(),
    }, 1);
    expect(r.rules).toContain("Rounds with no determinable timestamp are counted separately");
    expect(r.rules).not.toContain("Rounds and segments with no determinable timestamp");
    expect(r.rules).not.toMatch(/segments with no determinable timestamp are counted/);
    // and the fields the text describes still say what it says
    expect(r.excludedGroups).toBe(1);
    expect(r.segmentsHiddenByExclusion).toBeNull();
    expect(r.unassignableRounds).toBe(0);
  });
});

describe("ordering compares INSTANTS, not the strings that spell them", () => {
  it("two spellings of ONE instant are a TIE and disqualify the group", () => {
    // `...T00:00:00Z` and `...T00:00:00.000Z` are the same moment and unequal
    // as text, so a string tie check misses a real tie and hands an
    // order-dependent group to segmentation as though it were orderable.
    const group = [
      art({ round: 1, timestamp: "2026-09-05T00:00:00Z" }),
      art({ round: 2, timestamp: "2026-09-05T00:00:00.000Z" }),
    ];
    expect(group[0]!.epochMs).toBe(group[1]!.epochMs);
    expect(isOrderIndeterminate(group)).toBe(true);
    expect(segmentAll(group).excludedGroups).toBe(1);
  });

  it("a timezone OFFSET that reverses lexical order still sorts chronologically", () => {
    // "2026-09-05T01:00:00+02:00" is 23:00 the previous day, so it sorts AFTER
    // "2026-09-04T23:30:00Z" lexically and BEFORE it chronologically. Lexical
    // ordering would put round 2 first and manufacture a segment break.
    const earlier = art({ round: 1, timestamp: "2026-09-05T01:00:00+02:00" });
    const later = art({ round: 2, timestamp: "2026-09-04T23:30:00Z" });
    expect(earlier.timestamp! > later.timestamp!).toBe(true);
    expect(earlier.epochMs! < later.epochMs!).toBe(true);

    const seg = segmentAll([later, earlier]);
    // One increasing run, so ONE segment. Lexical order gives 2 then 1, a break.
    expect(seg.segments).toHaveLength(1);
    expect(seg.segments[0]!.artifacts.map((a) => a.round)).toEqual([1, 2]);
  });
});

describe("a reconstruction is suppressed where a P1 read failed", () => {
  const failure = (sessionId: string) => ({
    root: "/root", scope: "record" as const, path: "/root/x.json",
    reason: "EACCES", sessionId, affects: ["p1"] as const,
  });

  it("the session with the unread artifact contributes NO segments", () => {
    // The missing record's unknown round and timestamp can move the boundaries
    // of the artifacts around it and change which verdict is last. That is a
    // defect in the reconstruction, not a reduction in its coverage, so
    // `conditional` is the wrong instrument and suppression is the right one.
    const r = computeP1({
      artifacts: [
        art({ sessionId: "good", round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
        art({ sessionId: "good", round: 2, timestamp: "2026-09-05T00:00:02.000Z" }),
        art({ sessionId: "torn", round: 1, timestamp: "2026-09-05T00:00:03.000Z" }),
      ],
      scan: { ...scan({ "p1:root": "PARTIAL" }), failures: [failure("torn")] },
    });
    const rounds = by(r, "rounds-per-segment");
    expect(rounds.segments!.suppressedSessions).toBe(1);
    expect(rounds.segments!.suppressedArtifacts).toBe(1);
    // Only the good session's single segment survives.
    expect(rounds.segments!.eligibleSegments).toBe(1);
    expect(rounds.numerator).toBe(2);
    // The population is unknown while anything is suppressed.
    expect(rounds.segments!.segmentTotal).toBeNull();
  });

  it("but its READABLE records still count for the order-INDEPENDENT metrics", () => {
    // Suppressing those too would discard good evidence over a defect that
    // does not touch them.
    const r = computeP1({
      artifacts: [
        art({ sessionId: "good", criticalCount: 0 }),
        art({ sessionId: "torn", criticalCount: 0 }),
      ],
      scan: { ...scan({ "p1:root": "PARTIAL" }), failures: [failure("torn")] },
    });
    const zeroCritical = by(r, "zero-critical-rounds");
    expect(zeroCritical.denominator).toBe(2);
    expect(zeroCritical.records.readable).toBe(2);
  });

  it("a session whose ONLY artifact was unreadable still counts as suppressed", () => {
    // Counted from the FAILURES, not from surviving artifacts. Counting from
    // survivors reported such a session as zero, which let `segmentTotal` be
    // published as complete while a failure hid an unknown number of segments.
    const r = computeP1({
      artifacts: [art({ sessionId: "good", round: 1, timestamp: "2026-09-05T00:00:01.000Z" })],
      scan: { ...scan({ "p1:root": "PARTIAL" }), failures: [failure("gone")] },
    });
    const rounds = by(r, "rounds-per-segment");
    expect(rounds.segments!.suppressedSessions).toBe(1);
    // No surviving artifact from it, so nothing was dropped...
    expect(rounds.segments!.suppressedArtifacts).toBe(0);
    // ...but the population is still unknown.
    expect(rounds.segments!.segmentTotal).toBeNull();
  });

  it("a ROOT-DISCOVERY failure does NOT suppress a fully scanned sibling session", () => {
    // An unclassifiable entry in the sessions listing means ADDITIONAL sessions
    // may be invisible. It cannot change a group keyed on a DIFFERENT session
    // id, because session identity is part of the grouping key. So the sibling
    // reconstructs correctly; what is lost is the POPULATION, not the segment.
    const r = computeP1({
      artifacts: [
        art({ root: "/a", sessionId: "scanned", round: 1, timestamp: "2026-09-05T00:00:01.000Z" }),
        art({ root: "/a", sessionId: "scanned", round: 2, timestamp: "2026-09-05T00:00:02.000Z" }),
      ],
      scan: {
        ...scan({ "p1:/a": "PARTIAL" }),
        failures: [{
          root: "/a", scope: "root-discovery", path: "/a/.story/sessions/opaque",
          reason: "EACCES", affects: ["p1"],
        }],
      },
    });
    const rounds = by(r, "rounds-per-segment");
    // The measurement SURVIVES. Suppressing it discarded a valid reconstruction
    // and could turn a supported rate into null.
    expect(rounds.segments!.eligibleSegments).toBe(1);
    expect(rounds.numerator).toBe(2);
    expect(rounds.value).toBe(2);
    expect(rounds.segments!.suppressedSessions).toBe(0);
    // But how many segments exist in this root is unknown.
    expect(rounds.segments!.segmentTotal).toBeNull();
    expect(rounds.conditional).toBe(true);
  });

  it("a wholly UNAVAILABLE root contributes no artifacts and no false total", () => {
    const r = computeP1({
      artifacts: [],
      scan: {
        ...scan({ "p1:/a": "UNAVAILABLE" }),
        failures: [{
          root: "/a", scope: "root-discovery", path: "/a/.story/sessions",
          reason: "EACCES", affects: ["p1"],
        }],
      },
    });
    const rounds = by(r, "rounds-per-segment");
    expect(rounds.segments!.eligibleSegments).toBe(0);
    expect(rounds.segments!.segmentTotal).toBeNull();
    expect(rounds.records.total).toBeNull();
  });

  it("the monthly rollup applies the SAME filter, so the two cannot disagree", () => {
    const input = {
      artifacts: [
        art({ sessionId: "good", round: 1, timestamp: "2026-05-01T00:00:00.000Z" }),
        art({ sessionId: "torn", round: 1, timestamp: "2026-05-02T00:00:00.000Z" }),
      ],
      scan: { ...scan({ "p1:root": "PARTIAL" }), failures: [failure("torn")] },
    };
    const monthly = computeMonthly(input, 1);
    expect(monthly.suppressedSessions).toBe(1);
    // Both rounds are still counted; only the segmentation is filtered.
    expect(monthly.rows[0]!.rounds).toBe(2);
    expect(monthly.rows[0]!.segments).toBe(1);
    // The hidden segment count is UNKNOWN, never reported as zero.
    expect(monthly.segmentsHiddenByExclusion).toBeNull();
    expect(monthly.rules).toContain("UNKNOWN");
  });
});

describe("aggregating scan states across roots", () => {
  it("one unavailable root beside a readable one is PARTIAL, not UNAVAILABLE", () => {
    // UNAVAILABLE means NOTHING was read. Returning it here would discard a
    // whole readable root's evidence because a different root failed.
    const r = computeP1({
      artifacts: [art()],
      scan: scan({ "p1:/a": "COMPLETE", "p1:/b": "UNAVAILABLE" }),
    });
    expect(by(r, "zero-critical-rounds").scanState).toBe("PARTIAL");
  });

  it("every root unavailable IS UNAVAILABLE", () => {
    const r = computeP1({
      artifacts: [],
      scan: scan({ "p1:/a": "UNAVAILABLE", "p1:/b": "UNAVAILABLE" }),
    });
    expect(by(r, "zero-critical-rounds").scanState).toBe("UNAVAILABLE");
  });

  it("a P2 state never reaches a P1 metric", () => {
    const r = computeP1({
      artifacts: [art()],
      scan: scan({ "p1:/a": "COMPLETE", "p2:/a": "UNAVAILABLE" }),
    });
    expect(by(r, "zero-critical-rounds").scanState).toBe("COMPLETE");
    expect(by(r, "zero-critical-rounds").records.total).toBe(1);
  });
});

describe("re-raise rate PER BACKEND, which is what ISS-1115 line 4 asks for", () => {
  it("two backends yield two different rates, and neither is the pooled one", () => {
    // The fleet-wide rate cannot answer the acceptance line: it pools every
    // backend into one number, so a backend that re-raises constantly and one
    // that never does are indistinguishable in it. Telling them apart is the
    // entire point of the line.
    const p1 = computeP1({
      artifacts: [
        art({ reviewerRaw: "codex", originClasses: ["reintroduced", "new"] }),
        art({ reviewerRaw: "lenses", originClasses: ["new", "new", "new", "new"] }),
      ],
      scan: scan(),
    });
    // Presence asserted BEFORE dereferencing: a missing row should fail as a
    // missing row, not as a TypeError on undefined that names nothing.
    expect(p1.metrics.map((m) => m.id)).toEqual(
      expect.arrayContaining(["re-raise-rate-codex", "re-raise-rate-lenses"]),
    );
    const codex = p1.metrics.find((m) => m.id === "re-raise-rate-codex")!;
    const lenses = p1.metrics.find((m) => m.id === "re-raise-rate-lenses")!;
    expect(codex.value).toBe(0.5);
    expect(lenses.value).toBe(0);
    expect(codex.value).not.toBe(lenses.value);
    // the pooled rate still exists and equals neither
    const all = p1.metrics.find((m) => m.id === "re-raise-rate")!;
    expect(all.numerator).toBe(1);
    expect(all.denominator).toBe(6);
  });

  it("a COMPOSITE round is its own row and enters NO single-backend rate", () => {
    // A reviewer field naming two backends cannot be assigned to either without
    // inventing the attribution. Dropping it would hide its findings; splitting
    // it would fabricate them.
    const p1 = computeP1({
      artifacts: [
        art({ reviewerRaw: "codex", originClasses: ["new"] }),
        art({ reviewerRaw: "codex-bridge (gemini)", originClasses: ["reintroduced"] }),
      ],
      scan: scan(),
    });
    expect(p1.metrics.map((m) => m.id)).toEqual(
      expect.arrayContaining(["re-raise-rate-codex", "re-raise-rate-composite"]),
    );
    const codex = p1.metrics.find((m) => m.id === "re-raise-rate-codex")!;
    const composite = p1.metrics.find((m) => m.id === "re-raise-rate-composite")!;
    // the composite round's re-raise is NOT in codex's numerator or denominator
    expect(codex.numerator).toBe(0);
    expect(codex.denominator).toBe(1);
    expect(composite.numerator).toBe(1);
    expect(composite.denominator).toBe(1);
    expect(composite.label).toContain("NO single-backend rate");
    // and there is no `gemini` row at all: that round was never assigned to it
    expect(p1.metrics.find((m) => m.id === "re-raise-rate-gemini")).toBeUndefined();
  });

  it("a backend with rounds but NO recognised labels renders a rate of nothing", () => {
    // The row is still emitted: the absence of labelling on a backend IS the
    // finding ISS-1115 is about, and a missing row reads as a backend with no
    // rounds. A 0% would read as a backend that never re-raises.
    const p1 = computeP1({
      artifacts: [art({ reviewerRaw: "agent", originClasses: [undefined, undefined] })],
      scan: scan(),
    });
    // The ROW must exist. Skipping a backend with no recognised labels is the
    // failure this pins, and it has to fail as "no row", not as a crash.
    expect(p1.metrics.map((m) => m.id)).toContain("re-raise-rate-agent");
    const agent = p1.metrics.find((m) => m.id === "re-raise-rate-agent")!;
    expect(agent.denominator).toBe(0);
    expect(agent.value).toBeNull();
    expect(renderValue(agent)).toBe("-");
    expect(agent.note).toContain("never evidence of no re-raises");
  });

  it("a backend with no rounds at all emits no row", () => {
    const p1 = computeP1({ artifacts: [art({ reviewerRaw: "codex" })], scan: scan() });
    expect(p1.metrics.find((m) => m.id === "re-raise-rate-manual")).toBeUndefined();
  });
});

describe("the monthly rollup does not read an UNKNOWN last verdict as an approve", () => {
  it("a segment with no readable last verdict is counted apart, not as an approval", () => {
    // The same defect as the zero-critical column, one column over. Returning
    // null only when EVERY verdict is unknown does not cover the mixed row:
    // with two segments, one ending approve and one unreadable, the row printed
    // Segments 2 and not-approve 0, and a reader subtracting lands on two
    // established approvals where only one exists.
    const t = (n: number) => `2026-05-0${n}T00:00:00.000Z`;
    const r = computeMonthly({
      artifacts: [
        // segment A: one round, verdict readable and approve
        art({ sessionId: "a", target: "T-1", round: 1, timestamp: t(1), verdict: "approve" }),
        // segment B: one round, verdict BLANK -- unreadable, not a rejection
        art({ sessionId: "b", target: "T-2", round: 1, timestamp: t(2), verdict: "" }),
      ],
      scan: scan(),
    }, 1);
    const row = r.rows.find((x) => x.month === "2026-05")!;
    expect(row.segments).toBe(2);
    expect(row.lastVerdictUnknown).toBe(1);
    // exactly one segment's verdict is established, and it IS an approve
    expect(row.lastVerdictNotApprove).toBe(0);
    expect(row.segments - row.lastVerdictUnknown).toBe(1);
    expect(r.rules).toContain("segments MINUS the unknown-verdict count");
  });
});

describe("the monthly rollup does not read an UNKNOWN critical count as a critical", () => {
  it("a null criticalCount is counted apart, never as a round that had criticals", () => {
    // `zeroCriticalRounds` was filtered out of `rounds`, so a reader
    // subtracting landed on "rounds that had criticals" -- which silently
    // included every round whose count could not be read. computeP1's own
    // zero-critical metric excludes nulls from its denominator, so the rollup
    // was contradicting the headline table over identical records.
    const t = "2026-05-01T00:00:00.000Z";
    const r = computeMonthly({
      artifacts: [
        art({ round: 1, timestamp: t, criticalCount: 0 }),
        art({ round: 2, timestamp: "2026-05-02T00:00:00.000Z", criticalCount: 3 }),
        art({ round: 3, timestamp: "2026-05-03T00:00:00.000Z", criticalCount: null }),
      ],
      scan: scan(),
    }, 1);
    const row = r.rows.find((x) => x.month === "2026-05")!;
    expect(row.rounds).toBe(3);
    expect(row.zeroCriticalRounds).toBe(1);
    expect(row.criticalsUnknown).toBe(1);
    // the readable denominator is rounds MINUS the unknowns, so exactly one
    // round is established to have had criticals -- not two
    expect(row.rounds - row.criticalsUnknown - row.zeroCriticalRounds).toBe(1);
  });

  it("it agrees with computeP1 over the same records", () => {
    // Two numbers describing one fact must not disagree; that is worse than
    // either alone.
    const artifacts = [
      art({ round: 1, timestamp: "2026-05-01T00:00:00.000Z", criticalCount: 0 }),
      art({ round: 2, timestamp: "2026-05-02T00:00:00.000Z", criticalCount: null }),
    ];
    const p1 = computeP1({ artifacts, scan: scan() });
    const headline = p1.metrics.find((m) => m.id === "zero-critical-rounds")!;
    const row = computeMonthly({ artifacts, scan: scan() }, 1).rows[0]!;
    expect(headline.denominator).toBe(1);
    expect(row.rounds - row.criticalsUnknown).toBe(headline.denominator);
    expect(row.zeroCriticalRounds).toBe(headline.numerator);
  });
});
