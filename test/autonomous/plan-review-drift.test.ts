/**
 * ISS-598: the advisory scope-drift detector.
 *
 * Pure unit tests for the token-overlap heuristic itself, independent of the
 * PLAN_REVIEW stage wiring (covered separately in
 * plan-review-ceiling-drift-e2e.test.ts). Each test targets one of the
 * codex-review-round findings that shaped this module: the tri-state
 * classification (not binary), the truncation-disables-the-signal rule, the
 * no-signal-excluded-from-denominator rule, and the adjacency requirement in
 * `driftTriggered`.
 */
import { describe, it, expect } from "vitest";
import {
  extractSubjectTokens,
  buildRound1Baseline,
  classifyFinding,
  foldIntroducedFraction,
  driftTriggered,
  firstDriftTriggerRound,
  hashToken,
  DRIFT_FRACTION_THRESHOLD,
  DRIFT_CONSECUTIVE_ROUNDS,
  type DriftFinding,
  type DriftRoundEntry,
} from "../../src/autonomous/stages/plan-review-drift.js";

/** Baselines are sets of `hashToken` digests, never raw plan-text tokens (ISS-598 codex round 1, security). */
function hashedBaseline(tokens: readonly string[]): Set<string> {
  return new Set(tokens.map(hashToken));
}

describe("extractSubjectTokens", () => {
  it("extracts identifier-shaped tokens of at least 4 characters, lowercased (codex round 2: case-insensitive by construction)", () => {
    const { tokens } = extractSubjectTokens("Add a GuardAction to the navigation reducer");
    expect(tokens.has("guardaction")).toBe(true);
    expect(tokens.has("navigation")).toBe(true);
    expect(tokens.has("reducer")).toBe(true);
    // "Add" and "the" are too short / filtered.
    expect(tokens.has("add")).toBe(false);
  });

  it("filters common English stopwords even when they are 4+ characters", () => {
    const { tokens } = extractSubjectTokens("This should never make instead without already");
    expect(tokens.size).toBe(0);
  });

  it("is not truncated for ordinary-length text", () => {
    expect(extractSubjectTokens("a short plan about widgets").truncated).toBe(false);
  });

  it("flags truncation when the character-scan limit is hit", () => {
    const long = "widgetModule ".repeat(3000); // far past MAX_SCAN_CHARS
    expect(extractSubjectTokens(long).truncated).toBe(true);
  });

  /**
   * Codex round 3: a very long text can stay UNDER the token cap in its
   * scanned prefix while dropping later content past the character-scan
   * limit -- so truncation must be flagged by EITHER cap independently, not
   * just the token cap.
   */
  it("flags truncation from the character cap even when distinct tokens never approach the token cap", () => {
    const repeatedSingleToken = "widgetModule ".repeat(3000); // one repeated token, huge char count
    const result = extractSubjectTokens(repeatedSingleToken, { maxTokens: 500 });
    // A boundary cut can split the final repetition into its own partial
    // token, so this pins "did not blow up" rather than an exact count.
    expect(result.tokens.size).toBeLessThanOrEqual(2);
    expect(result.tokens.has("widgetmodule")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("flags truncation when the token cap is hit even under the char-scan limit", () => {
    const manyDistinct = Array.from({ length: 50 }, (_, i) => `uniqueToken${i}xyz`).join(" ");
    const result = extractSubjectTokens(manyDistinct, { maxTokens: 10 });
    expect(result.tokens.size).toBe(10);
    expect(result.truncated).toBe(true);
  });
});

describe("buildRound1Baseline", () => {
  it("returns the plan's subject tokens as hash digests, never the raw substrings", () => {
    const baseline = buildRound1Baseline("Implement the RetryQueue for the SyncEngine module");
    // ISS-598 codex round 1 (security): plan.md can legitimately contain
    // secret-shaped values, so nothing extracted from it may be persisted
    // verbatim -- the stored tokens must be one-way digests.
    expect(baseline.tokens).toContain(hashToken("RetryQueue"));
    expect(baseline.tokens).toContain(hashToken("SyncEngine"));
    expect(baseline.tokens).not.toContain("RetryQueue");
    expect(baseline.tokens).not.toContain("SyncEngine");
    expect(baseline.truncated).toBe(false);
  });
});

describe("classifyFinding", () => {
  const baseline = hashedBaseline(["RetryQueue", "SyncEngine", "navigation"]);

  it("classifies a finding whose subject exists in the baseline as baseline", () => {
    expect(classifyFinding({ description: "The RetryQueue never times out" }, baseline)).toBe("baseline");
  });

  it("classifies a finding whose subject is absent from the baseline as introduced", () => {
    expect(classifyFinding({ description: "The GuardAction citation chain is unbounded" }, baseline)).toBe("introduced");
  });

  it("also draws a signal from the file field, combined with description", () => {
    expect(classifyFinding({ file: "SyncEngine.ts", description: "generic issue here" }, baseline)).toBe("baseline");
  });

  /**
   * ISS-598 codex round 1 (correctness): every file in a project typically
   * shares directory segments the plan text almost certainly also mentions
   * (the project name, "src", the module directory...). Tokenizing the full
   * path would let an entirely new file classify as "baseline" purely off a
   * shared parent directory -- silently defeating the detector on nearly
   * every real finding. Only the basename may contribute tokens.
   */
  it("ignores shared directory segments in a file path, classifying by basename alone", () => {
    const projectBaseline = hashedBaseline(["storybloq", "autonomous", "stages", "RetryQueue"]);
    // "storybloq"/"autonomous"/"stages" are directory segments this baseline
    // happens to share -- but the actual FILE ("brand-new-widget.ts") and its
    // description are both genuinely new.
    const finding = { file: "storybloq/src/autonomous/stages/brand-new-widget.ts", description: "Introduces an unbounded citation chain" };
    expect(classifyFinding(finding, projectBaseline)).toBe("introduced");
  });

  /**
   * ISS-598 codex round 2 (correctness): codex-review.ts's native-codex path
   * folds `file:line` into `description` and never sets the structured `file`
   * field at all -- the primary production shape for a native-codex review.
   * Directory segments embedded in that PROSE must be stripped exactly like a
   * structured `file`'s full path is, or the basename-only fix never engages
   * on this path.
   */
  it("strips directory segments embedded in description prose, matching structured-file basename handling", () => {
    const projectBaseline = hashedBaseline(["storybloq", "autonomous", "stages", "RetryQueue"]);
    const nativeShapedFinding = {
      description: "storybloq/src/autonomous/stages/brand-new-widget.ts:42: Introduces an unbounded citation chain",
    };
    expect(classifyFinding(nativeShapedFinding, projectBaseline)).toBe("introduced");
  });

  /**
   * ISS-598 codex round 2 (correctness): a basename alone can still leak
   * near-zero-signal generic tokens (`test`, `json`, an extension...) that
   * the plan text mentions for unrelated reasons. A shared generic word must
   * not be enough on its own; only a real basename-STEM match should be.
   */
  it("does not classify as baseline on a shared generic filename word alone", () => {
    const projectBaseline = hashedBaseline(["test", "json", "config"]);
    const finding = { file: "brand-new-widget.test.ts", description: "Introduces an unbounded citation chain" };
    expect(classifyFinding(finding, projectBaseline)).toBe("introduced");
  });

  it("still classifies as baseline on a genuine basename-stem match, as a positive control for the generic-word test above", () => {
    const projectBaseline = hashedBaseline(["test", "json", "RetryQueue"]);
    const finding = { file: "RetryQueue.test.ts", description: "flaky under load" };
    expect(classifyFinding(finding, projectBaseline)).toBe("baseline");
  });

  /**
   * ISS-598 codex round 2 (test coverage): hashToken's own lowercasing is
   * exercised by every other test through identical-case fixtures. This pins
   * that a baseline built from one casing still matches a differently-cased
   * finding, independent of hashToken's internals.
   */
  it("matches case-insensitively: a baseline built from one casing matches a finding in a different casing", () => {
    const mixedCaseBaseline = hashedBaseline(["RetryQueue"]);
    expect(classifyFinding({ description: "the retryqueue keeps stalling" }, mixedCaseBaseline)).toBe("baseline");
    expect(classifyFinding({ description: "the RETRYQUEUE keeps stalling" }, mixedCaseBaseline)).toBe("baseline");
  });

  it("classifies generic prose with no extractable tokens as no-signal", () => {
    expect(classifyFinding({ description: "this is bad" }, baseline)).toBe("no-signal");
  });

  /**
   * Codex round 2: an unproven non-match from a TRUNCATED scan must not count
   * as "introduced" -- the scanned prefix simply never got a chance to find
   * a real match.
   */
  it("classifies a finding as no-signal, not introduced, when its own subject text was truncated with no match found", () => {
    const longNoMatch = "uniqueword ".repeat(3000); // truncates, none of it in baseline
    expect(classifyFinding({ description: longNoMatch }, baseline)).toBe("no-signal");
  });

  it("still classifies as baseline when a match is found within a truncated scan", () => {
    const longWithMatch = "SyncEngine " + "uniqueword ".repeat(3000);
    expect(classifyFinding({ description: longWithMatch }, baseline)).toBe("baseline");
  });
});

describe("foldIntroducedFraction", () => {
  const baseline = hashedBaseline(["RetryQueue", "SyncEngine"]);

  it("computes the fraction of introduced findings among signal-bearing ones", () => {
    const findings: DriftFinding[] = [
      { description: "RetryQueue bug" },       // baseline
      { description: "GuardAction missing" },  // introduced
      { description: "CitationChain unbounded" }, // introduced
      { description: "SyncEngine race" },      // baseline
    ];
    expect(foldIntroducedFraction(findings, baseline)).toBe(0.5);
  });

  /**
   * Codex round 2: null (not 0) when nothing is signal-bearing -- "no drift
   * detected" and "nothing to measure" are different facts, and the caller
   * must not record a history entry for the latter.
   */
  it("returns null, not zero, when no finding carries a signal", () => {
    const findings: DriftFinding[] = [{ description: "this is bad" }, { description: "fix it" }];
    expect(foldIntroducedFraction(findings, baseline)).toBeNull();
  });

  it("returns null for an empty findings array", () => {
    expect(foldIntroducedFraction([], baseline)).toBeNull();
  });

  it("excludes no-signal findings from the denominator rather than treating them as baseline", () => {
    const findings: DriftFinding[] = [
      { description: "GuardAction missing" }, // introduced
      { description: "this is bad" },         // no-signal, excluded
    ];
    // If no-signal were folded into the denominator as non-introduced, this
    // would read 0.5; correctly excluded, it reads 1.0.
    expect(foldIntroducedFraction(findings, baseline)).toBe(1);
  });

  it("returns 1 when every signal-bearing finding is introduced", () => {
    const findings: DriftFinding[] = [
      { description: "GuardAction missing" },
      { description: "CitationChain unbounded" },
    ];
    expect(foldIntroducedFraction(findings, baseline)).toBe(1);
  });

  it("returns 0 when every signal-bearing finding matches the baseline", () => {
    const findings: DriftFinding[] = [{ description: "RetryQueue bug" }, { description: "SyncEngine race" }];
    expect(foldIntroducedFraction(findings, baseline)).toBe(0);
  });
});

describe("driftTriggered", () => {
  it("is false with fewer than DRIFT_CONSECUTIVE_ROUNDS entries", () => {
    expect(driftTriggered([{ round: 1, fraction: 0.9 }])).toBe(false);
  });

  it("fires when the last N consecutive rounds are all at or above threshold", () => {
    const history: DriftRoundEntry[] = [
      { round: 1, fraction: 0.9 },
      { round: 2, fraction: 0.7 },
    ];
    expect(driftTriggered(history)).toBe(true);
  });

  it("does not fire when only one of the last N rounds is above threshold", () => {
    const history: DriftRoundEntry[] = [
      { round: 1, fraction: 0.3 },
      { round: 2, fraction: 0.9 },
    ];
    expect(driftTriggered(history)).toBe(false);
  });

  it("fires exactly at the threshold boundary (>=)", () => {
    const history: DriftRoundEntry[] = [
      { round: 1, fraction: DRIFT_FRACTION_THRESHOLD },
      { round: 2, fraction: DRIFT_FRACTION_THRESHOLD },
    ];
    expect(driftTriggered(history)).toBe(true);
  });

  /**
   * Codex round 3: a no-signal round contributes NO history entry at all, so
   * a naive "last two entries" check would treat two non-consecutive
   * qualifying rounds as consecutive. The adjacency check on `round` closes
   * this.
   */
  it("does not fire across a gap left by an omitted no-signal round", () => {
    const history: DriftRoundEntry[] = [
      { round: 1, fraction: 0.9 },
      // round 2 had no signal-bearing findings and contributed no entry
      { round: 3, fraction: 0.9 },
    ];
    expect(driftTriggered(history)).toBe(false);
  });

  it("fires across three genuinely consecutive qualifying rounds", () => {
    const history: DriftRoundEntry[] = [
      { round: 5, fraction: 0.6 },
      { round: 6, fraction: 0.8 },
      { round: 7, fraction: 1.0 },
    ];
    expect(driftTriggered(history)).toBe(true);
  });
});

describe("firstDriftTriggerRound", () => {
  it("returns null when drift never triggered", () => {
    const history: DriftRoundEntry[] = [{ round: 1, fraction: 0.2 }, { round: 2, fraction: 0.1 }];
    expect(firstDriftTriggerRound(history)).toBeNull();
  });

  it("returns the round of the earliest qualifying window, not the latest", () => {
    const history: DriftRoundEntry[] = [
      { round: 1, fraction: 0.9 },
      { round: 2, fraction: 0.9 }, // earliest trigger: round 2
      { round: 3, fraction: 0.9 },
      { round: 4, fraction: 0.9 },
    ];
    expect(firstDriftTriggerRound(history)).toBe(2);
  });

  it("skips a non-consecutive false start and finds the real first trigger", () => {
    const history: DriftRoundEntry[] = [
      { round: 1, fraction: 0.9 },
      // gap at round 2 (no-signal, omitted)
      { round: 3, fraction: 0.2 }, // breaks any adjacency with round 1
      { round: 4, fraction: 0.9 },
      { round: 5, fraction: 0.9 }, // first real trigger: round 5
    ];
    expect(firstDriftTriggerRound(history)).toBe(5);
  });
});
