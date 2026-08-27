/**
 * ISS-598: corpus characterization, NOT a correctness gate.
 *
 * Replays the scope-drift heuristic (plan-review-drift.ts) against the
 * preserved real-incident corpus at
 * `.story/evidence/iss-598-rn-navigation-t066/findings.json` (337 findings
 * across the rounds that actually happened for this ticket) and reports what
 * the detector would have said. This is deliberately NOT an assertion that
 * the detector's precision is validated -- Gate-1 shipped it advisory-only
 * for exactly that reason (plan-review-drift.ts's module docblock) -- so
 * nothing here fails the suite over a threshold or a specific fraction. It
 * exists so a human auditing whether to promote the signal to automatic
 * enforcement later has a concrete, reproducible characterization to read
 * instead of re-deriving one from the raw corpus by hand.
 *
 * The corpus does not preserve the round-1 plan.md text, so there is no true
 * baseline to replay against. As the best available proxy, this uses the
 * EARLIEST recorded round's own finding vocabulary as a stand-in baseline --
 * an approximation, not a faithful reconstruction, and the test says so in
 * its output rather than presenting the numbers as validated precision.
 *
 * That proxy turns out to read as near-zero drift across every later round in
 * this corpus (logged in full below), which is itself a useful, honest
 * result: it is an artifact of the proxy, not a negative finding about the
 * heuristic. Review findings in this incident keep re-litigating the SAME
 * contested entities round after round, so a baseline built from round 2's
 * own finding text already contains most of what round 19 cites -- the real
 * detector's round-1 PLAN TEXT baseline would not. Promoting this signal to
 * automatic enforcement needs characterization against a live run's real
 * plan.md baseline, not this corpus.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractSubjectTokens,
  foldIntroducedFraction,
  driftTriggered,
  firstDriftTriggerRound,
  hashToken,
  type DriftRoundEntry,
} from "../../src/autonomous/stages/plan-review-drift.js";

interface CorpusFinding {
  readonly round: number | null;
  readonly file?: string;
  readonly description: string;
}

interface Corpus {
  readonly issue: string;
  readonly totalFindings: number;
  readonly findings: readonly CorpusFinding[];
}

const CORPUS_PATH = join(
  process.cwd(), "..", ".story", "evidence", "iss-598-rn-navigation-t066", "findings.json",
);

describe("ISS-598 corpus characterization (non-gating)", () => {
  it("replays the drift heuristic against the real T-066 incident and reports what it would have said", () => {
    let corpus: Corpus;
    try {
      corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
    } catch {
      // The evidence file lives outside this package (workspace .story/,
      // gitignored session-adjacent path) and may not be present in every
      // checkout or CI shape. Characterization is informational, so an
      // absent corpus skips rather than fails.
      console.log("[ISS-598 characterization] corpus not found at", CORPUS_PATH, "-- skipping.");
      return;
    }

    // Codex round 2 (test quality): a corpus that PARSES but is empty or
    // degenerate must not silently pass every downstream check by producing
    // an empty history -- that reads as "characterized" when nothing ran.
    // These pin that the file this test actually found is the real corpus,
    // not an accidental empty/malformed stand-in.
    expect(corpus.findings.length).toBeGreaterThan(0);

    const byRound = new Map<number, CorpusFinding[]>();
    for (const f of corpus.findings) {
      if (f.round == null) continue; // cannot be assigned to a replay round without corpus round metadata
      if (!byRound.has(f.round)) byRound.set(f.round, []);
      byRound.get(f.round)!.push(f);
    }
    const rounds = Array.from(byRound.keys()).sort((a, b) => a - b);
    // At least one round beyond the proxy-baseline round is required to
    // measure anything at all; without this, `history` stays permanently
    // empty and every assertion below passes vacuously.
    expect(rounds.length).toBeGreaterThan(1);

    // Proxy baseline: the earliest recorded round's own vocabulary. Real
    // plan.md text at round 1 is not in the corpus, so this is the closest
    // available stand-in, not a faithful reconstruction. Hashed and
    // basename-only, matching classifyFinding's real behavior (ISS-598 codex
    // round 1) -- a baseline built any other way would not characterize what
    // the shipped detector actually does.
    const earliest = rounds[0];
    const baselineTokens = new Set<string>();
    for (const f of byRound.get(earliest) ?? []) {
      const basename = f.file?.split(/[\\/]/).pop();
      const { tokens } = extractSubjectTokens([basename, f.description].filter(Boolean).join(" "));
      for (const t of tokens) baselineTokens.add(hashToken(t));
    }

    const history: DriftRoundEntry[] = [];
    for (const round of rounds) {
      if (round === earliest) continue; // the baseline round itself is not measured against itself
      const findings = byRound.get(round)!;
      const fraction = foldIntroducedFraction(findings, baselineTokens);
      if (fraction !== null) history.push({ round, fraction });
    }

    const wouldHaveFiredAt = firstDriftTriggerRound(history);

    console.log(`[ISS-598 characterization] issue=${corpus.issue} totalFindings=${corpus.totalFindings}`);
    console.log(`[ISS-598 characterization] proxy baseline built from round ${earliest} (${baselineTokens.size} tokens)`);
    console.log("[ISS-598 characterization] per-round fold-introduced fraction:",
      history.map((h) => `r${h.round}=${h.fraction.toFixed(2)}`).join(", "));
    console.log("[ISS-598 characterization] would first have triggered at round:", wouldHaveFiredAt ?? "never");
    console.log("[ISS-598 characterization] triggered on final available history:", driftTriggered(history));
    console.log(
      "[ISS-598 characterization] LIMITATION: this proxy baseline reads as near-zero drift across every " +
      "later round, which is a property of the PROXY, not evidence the heuristic misses this incident. " +
      "Review findings keep re-litigating the SAME contested entities (resolveOptionalMarker, driver.ts, " +
      "Alerts.ts...) round after round, so a baseline built from round 2's own finding text already " +
      "contains most of what later rounds cite. The real detector compares against round-1 PLAN TEXT, " +
      "which would not yet name entities the plan review process itself later invented -- exactly the " +
      "distinction this corpus cannot replay without the real plan.md snapshot, which was not preserved. " +
      "A promote-to-automatic decision needs a live run's real baseline, not this proxy.",
    );

    // Structural-only: the replay must complete and produce a well-formed
    // history, not crash on real, messy production text. No assertion on the
    // fraction values or the trigger round themselves -- that is exactly the
    // "not validated for precision" fact plan-review-drift.ts's docblock
    // states, and this test exists to document the numbers, not to pass or
    // fail based on them.
    for (const entry of history) {
      if (entry.fraction < 0 || entry.fraction > 1 || Number.isNaN(entry.fraction)) {
        throw new Error(`malformed fraction at round ${entry.round}: ${entry.fraction}`);
      }
    }
  });
});
