/**
 * T-488 D10: the content hash classifies EXHAUSTIVELY, at compile time.
 *
 * The rule this file exists to keep true: identity is WHAT THE ROUND WAS;
 * excluded is how it was produced and what it cost.
 *
 * The real guarantee is not in these assertions. It is in
 * `satisfies Record<keyof ReviewVerdictArtifact, HashDecision>` in
 * review-verdict.ts: adding an optional property to the artifact or finding
 * type without classifying it FAILS COMPILATION, with no fixture to update and
 * nothing for an author to remember. That matters because the previous
 * exclusion-list destructure silently defaulted a new field to *included*,
 * which is exactly the case the acceptance criterion promises to catch, and a
 * hand-built "fully populated" fixture is no better -- every field here is
 * optional, so forgetting to populate one leaves a union assertion green.
 *
 * What these tests add is the runtime half: the maps actually drive the hash,
 * and every classification is honoured in both directions.
 */
import { describe, it, expect } from "vitest";
import {
  HASH_DECISIONS,
  computeContentHash,
  parseVerdictFilename,
  verdictFilename,
  type ReviewVerdictArtifact,
} from "../../src/autonomous/review-verdict.js";

function makeArtifact(overrides: Partial<ReviewVerdictArtifact> = {}): ReviewVerdictArtifact {
  return {
    target: "T-001",
    stage: "code",
    round: 1,
    reviewer: "codex",
    verdict: "approve",
    findingsCount: 0,
    severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    startedAt: "2026-09-05T12:00:00.000Z",
    durationMs: 1000,
    summary: "ok",
    findings: [],
    timestamp: "2026-09-05T12:01:00.000Z",
    ...overrides,
  };
}

describe("hash classification maps", () => {
  it("classifies every artifact key, with no key left undecided", () => {
    // The compile-time `satisfies` is what enforces this; the runtime check
    // catches the one thing it cannot -- a map entry deleted without the type
    // changing, which would leave the key silently INCLUDED.
    const populated = makeArtifact({
      unresolvedCriticalCount: 0, reviewId: "r", reviewerPath: "lenses-verified", effort: "standard",
      workItemId: "T-001", kind: "ticket", reviewAttemptId: "a", itemAttemptId: "b",
      backendRunId: "s", backendRunIdKind: "codex-session", backendTurnId: "t",
      backend: "codex", normalizerVersion: 1, generation: 0, payloadConsistent: true,
      reviewerIdentity: { source: "unknown", evidence: "none" },
      implementer: { source: "unknown", evidence: "none" },
      artifactStatus: "written",
    });
    for (const key of Object.keys(populated)) {
      expect(HASH_DECISIONS.artifact[key], `unclassified artifact key: ${key}`).toBeDefined();
    }
  });

  it("classifies every finding key", () => {
    const finding = {
      id: "F-1", severity: "critical", category: "c", description: "d",
      disposition: "open", recommendedNextState: "PLAN", rawSeverity: "blocking",
    };
    for (const key of Object.keys(finding)) {
      expect(HASH_DECISIONS.finding[key], `unclassified finding key: ${key}`).toBeDefined();
    }
  });

  it("keeps production metadata out and identity in, as the Gate 0 rule states", () => {
    const excluded = Object.entries(HASH_DECISIONS.artifact)
      .filter(([, d]) => d === "excluded").map(([k]) => k).sort();
    expect(excluded).toEqual([
      "artifactStatus", "backendRunId", "backendRunIdKind", "backendTurnId",
      "durationMs", "effort", "implementer", "itemAttemptId", "normalizerVersion",
      "reviewAttemptId", "reviewId", "reviewerIdentity", "reviewerPath", "timestamp",
    ]);
  });
});

describe("excluded fields do not perturb the hash", () => {
  const base = makeArtifact();
  const baseHash = computeContentHash(base);

  it.each([
    ["timestamp", { timestamp: "2027-01-01T00:00:00.000Z" }],
    ["durationMs", { durationMs: 999_999 }],
    ["reviewId", { reviewId: "some-review" }],
    ["reviewerPath", { reviewerPath: "lenses-unverified" as const }],
    ["effort", { effort: "thorough" }],
    ["reviewAttemptId", { reviewAttemptId: "attempt-1" }],
    ["itemAttemptId", { itemAttemptId: "item-1" }],
    ["backendRunId", { backendRunId: "sess-1" }],
    ["backendRunIdKind", { backendRunIdKind: "codex-session" as const }],
    ["backendTurnId", { backendTurnId: "turn-1" }],
    ["normalizerVersion", { normalizerVersion: 1 }],
    ["artifactStatus", { artifactStatus: "written" as const }],
    ["reviewerIdentity", { reviewerIdentity: { model: "m", source: "explicit-pin" as const, evidence: "configured" as const } }],
    ["implementer", { implementer: { model: "n", source: "explicit-pin" as const, evidence: "configured" as const } }],
  ])("%s", (_name, patch) => {
    expect(computeContentHash(makeArtifact(patch))).toBe(baseHash);
  });

  it("two attempts with identical findings hash IDENTICALLY, which is why identity matching exists", () => {
    // Not an accident to be tolerated -- it is the direct consequence of
    // excluding attempt ids, and it is exactly why an `exists` result may never
    // be adopted on a hash match alone.
    const a = makeArtifact({ reviewAttemptId: "a", itemAttemptId: "x" });
    const b = makeArtifact({ reviewAttemptId: "b", itemAttemptId: "y" });
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });
});

describe("included fields do perturb the hash", () => {
  const baseHash = computeContentHash(makeArtifact());

  it.each([
    ["target", { target: "T-002" }],
    ["stage", { stage: "plan" }],
    ["round", { round: 2 }],
    ["reviewer", { reviewer: "agent" }],
    ["verdict", { verdict: "revise" }],
    ["findingsCount", { findingsCount: 1 }],
    ["severityCounts", { severityCounts: { critical: 1, major: 0, minor: 0, suggestion: 0 } }],
    ["unresolvedCriticalCount", { unresolvedCriticalCount: 1 }],
    ["startedAt", { startedAt: "2026-01-01T00:00:00.000Z" }],
    ["summary", { summary: "different" }],
    ["findings", { findings: [{ severity: "major" }] }],
    ["workItemId", { workItemId: "T-001" }],
    ["kind", { kind: "issue" as const }],
    ["backend", { backend: "codex" as const }],
    ["payloadConsistent", { payloadConsistent: false }],
    ["generation", { generation: 1 }],
  ])("%s", (_name, patch) => {
    expect(computeContentHash(makeArtifact(patch))).not.toBe(baseHash);
  });

  it("distinguishes round 1 of generation 2 from round 1 of generation 1", () => {
    // The westworld `08a52602` shape is the proof that treating these as one
    // round is the defect: twenty-one rounds ran and twelve artifacts survive.
    const g1 = makeArtifact({ round: 1, generation: 1 });
    const g2 = makeArtifact({ round: 1, generation: 2 });
    expect(computeContentHash(g1)).not.toBe(computeContentHash(g2));
  });

  it("carries a finding's rawSeverity into the hash", () => {
    const a = makeArtifact({ findings: [{ severity: "critical", rawSeverity: "blocking" }] });
    const b = makeArtifact({ findings: [{ severity: "critical", rawSeverity: "critical" }] });
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
});

describe("legacy artifacts keep their hashes", () => {
  it("an absent optional key never enters the canonical form", () => {
    // `canonicalize` iterates `Object.keys(...).sort()`, so a key that is not
    // there is not sorted in -- which is what makes every one of these new
    // fields free for artifacts written before them.
    const legacy = makeArtifact();
    const explicitlyUndefined = { ...legacy, generation: undefined, backend: undefined };
    expect(computeContentHash(explicitlyUndefined as ReviewVerdictArtifact))
      .toBe(computeContentHash(legacy));
  });

  it("a real pre-T-488 artifact hashes to the same value it always did", () => {
    // Pinned literal, not recomputed: a test that derives its expectation from
    // the same function it is testing cannot detect the function changing. The
    // value was taken by RUNNING the pre-T-488 `computeContentHash` at HEAD
    // 78405646 against this exact artifact, so it is measured rather than
    // asserted -- a hash written from memory would pass only by luck and would
    // have to be "corrected" to whatever the new code produced, which is the
    // opposite of a regression test.
    const pre488: ReviewVerdictArtifact = {
      target: "T-250", stage: "code", round: 1, reviewer: "codex", verdict: "approve",
      findingsCount: 0, severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
      startedAt: "2026-05-01T00:00:00.000Z", durationMs: 42, summary: "clean",
      findings: [], timestamp: "2026-05-01T00:01:00.000Z",
    };
    expect(computeContentHash(pre488))
      .toBe("4712220d34aa5355f721236a27a60c577aeaa99c7afc97b829b923563dc463b7");
  });
});

describe("verdict filenames", () => {
  it("generation 0 is byte-identical to the pre-T-488 name", () => {
    expect(verdictFilename("T-250", "code", 1)).toBe("T-250-code-r1.json");
    expect(verdictFilename("T-250", "code", 1, 0)).toBe("T-250-code-r1.json");
  });

  it("appends the generation as a SUFFIX, which is what keeps external globs working", () => {
    // Load-bearing, not tidy. Readers outside this repo glob `*-code-r*.json`.
    expect(verdictFilename("T-001", "code", 2, 1)).toBe("T-001-code-r2-g1.json");
    const glob = /^.*-code-r.*\.json$/;
    expect(glob.test("T-001-code-r2-g1.json")).toBe(true);
    // The infix form this replaced does NOT match, and would have hidden every
    // later generation from every existing reader.
    expect(glob.test("T-001-code-g1-r2.json")).toBe(false);
  });

  it("round-trips both forms through the parser", () => {
    expect(parseVerdictFilename("T-250-code-r1.json"))
      .toEqual({ target: "T-250", stage: "code", round: 1, generation: 0 });
    expect(parseVerdictFilename("T-250-code-r1-g3.json"))
      .toEqual({ target: "T-250", stage: "code", round: 1, generation: 3 });
    expect(parseVerdictFilename("ISS-378-plan-r2.json"))
      .toEqual({ target: "ISS-378", stage: "plan", round: 2, generation: 0 });
  });

  it("returns null for anything that is not a verdict artifact name", () => {
    expect(parseVerdictFilename("state.json")).toBeNull();
    expect(parseVerdictFilename("T-250-code.json")).toBeNull();
    expect(parseVerdictFilename("notes.md")).toBeNull();
  });

  it("keeps the existing slash sanitation", () => {
    expect(verdictFilename("T/250", "code", 1)).toBe("T-250-code-r1.json");
  });
});
