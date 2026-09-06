/**
 * ISS-1115 Run A: the round context packet, and the floor under it.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO PIN.
 *
 * 1. RESIDUALS COME FROM ARTIFACTS, NOT FROM STATE. `ReviewRecord` persists
 *    counts and no findings, and the PLAN redirect clears `reviews` and
 *    `lensReviewHistory` outright. The T-488 verdict artifacts survive that
 *    clear and carry the findings, so they are the only source that still
 *    answers "what was accepted" after a redirect. Generation tagging is what
 *    keeps a pre-redirect round from leaking into a post-redirect packet.
 *
 * 2. THE CAPTURE DIRECTIVE IS RESERVED, NOT NEGOTIABLE. A drop order with no
 *    floor ends at a review holding an accepted-residuals ledger and no
 *    instruction to fetch the code. That round would report itself "partial",
 *    which is true of the packet and false of the review, and would then enter
 *    the artifact spine with full identity and a real verdict. It also degrades
 *    toward the QUIETER outcome, since a reviewer that never captures a diff
 *    finds nothing, and a zero-finding round is the exact pathology ISS-1115
 *    was filed about.
 *
 *    What the floor actually is: `captureDirective` is a required field on the
 *    return type, is reserved before any section, yields to nothing, and is
 *    placed last in the assembled text. It is a RESERVATION. Nothing here can
 *    check that the caller passed a real instruction or that the reviewer obeys
 *    it, so these tests assert the reservation holds under every budget and
 *    claim nothing beyond that.
 */
import { describe, it, expect } from "vitest";
import { makeRuling } from "../core/test-factories.js";
import { buildCitationResolutionContext, resolveCitation } from "../../src/core/ruling.js";
import type { CitationResolution } from "../../src/core/ruling.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdictFilename, computeContentHash, type ReviewVerdictArtifact } from "../../src/autonomous/review-verdict.js";
import { buildReviewContextPacket } from "../../src/autonomous/review-context-packet.js";
import type { ReviewContextPacket } from "../../src/autonomous/review-context-packet.js";

function tmpSession(): string {
  const dir = mkdtempSync(join(tmpdir(), "packet-"));
  mkdirSync(join(dir, "telemetry", "reviews"), { recursive: true });
  return dir;
}

interface SeedOpts {
  readonly target?: string;
  readonly stage?: string;
  readonly round: number;
  readonly generation?: number;
  readonly verdict?: string;
  readonly findings?: readonly unknown[];
  readonly backendRunId?: string;
  readonly backendRunIdKind?: "codex-session" | "agent-dispatch" | "lens-review";
}

/** Write a real artifact, hashed the way the writer hashes it. */
function seedArtifact(sessionDir: string, o: SeedOpts): void {
  const target = o.target ?? "T-001";
  const stage = o.stage ?? "code";
  const generation = o.generation ?? 0;
  const findings = o.findings ?? [];
  const artifact = {
    target,
    stage,
    round: o.round,
    reviewer: "codex",
    verdict: o.verdict ?? "revise",
    findingsCount: findings.length,
    severityCounts: { critical: 0, major: findings.length, minor: 0, suggestion: 0 },
    startedAt: "2026-09-05T00:00:00.000Z",
    durationMs: 1000,
    summary: `round ${o.round}`,
    findings,
    timestamp: "2026-09-05T00:00:01.000Z",
    generation,
    ...(o.backendRunId === undefined ? {} : { backendRunId: o.backendRunId }),
    ...(o.backendRunIdKind === undefined ? {} : { backendRunIdKind: o.backendRunIdKind }),
  } as ReviewVerdictArtifact;
  const body = { ...artifact, _contentHash: computeContentHash(artifact) };
  writeFileSync(
    join(sessionDir, "telemetry", "reviews", verdictFilename(target, stage, o.round, generation)),
    JSON.stringify(body, null, 2),
    "utf-8",
  );
}

const finding = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  severity: "major",
  category: "correctness",
  description: `finding ${id}`,
  disposition: "open",
  ...extra,
});

const BIG_BUDGET = 1_000_000;
const base = {
  target: "T-001",
  stage: "code" as const,
  generation: 0,
  roundNum: 3,
  budget: BIG_BUDGET,
  captureDirective: "diff --git a/x b/x\n+line\n",
};

describe("ISS-1115: residuals come from artifacts", () => {
  it("recovers prior rounds' findings from artifacts", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("F1", { disposition: "deferred" })] });
    seedArtifact(dir, { round: 2, findings: [finding("F2", { disposition: "addressed" })] });

    const packet = buildReviewContextPacket({ ...base, sessionDir: dir, projectRoot: dir });

    expect(packet.priorRounds.map((r) => r.round)).toEqual([1, 2]);
    expect(packet.text).toContain("F1");
    expect(packet.text).toContain("F2");
  });

  it("reads ONLY the current generation, so a pre-redirect round cannot leak in", () => {
    const dir = tmpSession();
    // Generation 0: what was reviewed before a PLAN redirect.
    seedArtifact(dir, { round: 1, generation: 0, findings: [finding("STALE")] });
    seedArtifact(dir, { round: 2, generation: 0, findings: [finding("ALSO_STALE")] });
    // Generation 1: after the redirect. Round numbers restart.
    seedArtifact(dir, { round: 1, generation: 1, findings: [finding("CURRENT")] });

    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, generation: 1, roundNum: 2,
    });

    expect(packet.priorRounds).toHaveLength(1);
    expect(packet.text).toContain("CURRENT");
    expect(packet.text).not.toContain("STALE");
  });

  it("ignores other targets and other stages", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("MINE")] });
    seedArtifact(dir, { round: 1, target: "T-999", findings: [finding("OTHER_TARGET")] });
    seedArtifact(dir, { round: 1, stage: "plan", findings: [finding("OTHER_STAGE")] });

    const packet = buildReviewContextPacket({ ...base, sessionDir: dir, projectRoot: dir });

    expect(packet.text).toContain("MINE");
    expect(packet.text).not.toContain("OTHER_TARGET");
    expect(packet.text).not.toContain("OTHER_STAGE");
  });

  it("reports PARTIAL and names the gap when a round's artifact is missing", () => {
    const dir = tmpSession();
    // Rounds 1 and 3 present, round 2 dropped by the pre-T-488 collision defect.
    seedArtifact(dir, { round: 1, findings: [finding("F1")] });
    seedArtifact(dir, { round: 3, findings: [finding("F3")] });

    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, roundNum: 4,
    });

    expect(packet.completeness).toBe("partial");
    // Naming the gap is the point. A reviewer told "these are the accepted
    // residuals" when a round is missing may treat a live defect as settled.
    expect(packet.omissions.join(" ")).toContain("2");
    expect(packet.text).toMatch(/incomplete|missing|could not/i);
  });

  it("reports COMPLETE when every prior round is present", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("F1")] });
    seedArtifact(dir, { round: 2, findings: [finding("F2")] });

    const packet = buildReviewContextPacket({ ...base, sessionDir: dir, projectRoot: dir });

    expect(packet.completeness).toBe("complete");
    expect(packet.omissions).toEqual([]);
  });

  it("round 1 has no prior rounds and is complete, not partial", () => {
    const dir = tmpSession();
    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, roundNum: 1,
    });
    expect(packet.completeness).toBe("complete");
    expect(packet.priorRounds).toEqual([]);
  });
});

describe("ISS-1115 item 3: codex session continuity", () => {
  it("recovers the plan-review codex session id from state when state is intact", () => {
    const dir = tmpSession();
    const packet = buildReviewContextPacket({
      ...base,
      sessionDir: dir,
      projectRoot: dir,
      planReviews: [{ round: 1, codexSessionId: "sess-from-state" }],
    });
    expect(packet.priorCodexSessionId).toBe("sess-from-state");
  });

  it("recovers it from the ARTIFACT when a redirect cleared state", () => {
    const dir = tmpSession();
    // The redirect emptied reviews.plan[]; the artifact is untouched.
    seedArtifact(dir, {
      round: 1, stage: "plan",
      backendRunId: "sess-from-artifact", backendRunIdKind: "codex-session",
    });

    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, planReviews: [],
    });

    expect(packet.priorCodexSessionId).toBe("sess-from-artifact");
  });

  it("does not mistake a non-codex run id for a codex session", () => {
    const dir = tmpSession();
    seedArtifact(dir, {
      round: 1, stage: "plan",
      backendRunId: "agent-123", backendRunIdKind: "agent-dispatch",
    });
    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, planReviews: [],
    });
    expect(packet.priorCodexSessionId).toBeUndefined();
  });
});

describe("ISS-1115: project rules reach the packet", () => {
  it("carries RULES.md and REVIEW.md when both are present", () => {
    const dir = tmpSession();
    writeFileSync(join(dir, "RULES.md"), "RULE ONE: no em dashes.", "utf-8");
    writeFileSync(join(dir, "REVIEW.md"), "## Security\nBlocking: blocking\n", "utf-8");

    const packet = buildReviewContextPacket({ ...base, sessionDir: dir, projectRoot: dir });

    expect(packet.text).toContain("RULE ONE");
    expect(packet.text).toContain("Blocking: blocking");
  });

  it("omits the rules section cleanly when neither file exists", () => {
    const dir = tmpSession();
    const packet = buildReviewContextPacket({ ...base, sessionDir: dir, projectRoot: dir });
    expect(packet.sections.some((s) => s.id === "project-rules")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE FLOOR
// ───────────────────────────────────────────────────────────────────────────

describe("ISS-1115 F2: the capture directive is not droppable", () => {
  const directive = "diff --git a/big b/big\n" + "+x\n".repeat(200);

  it("returns the FULL directive even when the budget cannot fit anything else", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("F1")] });
    writeFileSync(join(dir, "RULES.md"), "rules text here", "utf-8");

    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, budget: 10,
    });

    expect(packet.captureDirective).toBe(directive);
    expect(packet.text).toContain(directive);
    expect(packet.sections).toEqual([]);
    // "none" describes the PACKET CONTEXT. It never describes the code.
    expect(packet.completeness).toBe("none");
  });

  it("still ships the WHOLE mandatory payload at a budget of 1", () => {
    // The withdrawn promise was "degrades to exactly today's instruction". It
    // could not coexist with the requirement that omissions always reach the
    // reviewer, and this is the half that survived: a budget too small to
    // describe the review truthfully is not a licence to describe it
    // untruthfully. Optional sections vanish; the disclosure does not.
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("F1")] });

    const starved = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, budget: 1,
    });

    expect(starved.sections).toEqual([]);
    expect(starved.text).toContain(directive);
    expect(starved.text).toContain("REPORTING RULE");
    expect(starved.text).toContain("CONTEXT COMPLETENESS");
    // And it is allowed to exceed, which is the honest outcome rather than a
    // silently truncated caveat.
    expect(starved.text.length).toBeGreaterThan(1);
  });

});

describe("ISS-1115 F2: shedding order", () => {
  const directive = "diff --git a/x b/x\n+line\n";

  function seedThreeRounds(dir: string): void {
    seedArtifact(dir, { round: 1, findings: [finding("OLDEST", { disposition: "deferred" })] });
    seedArtifact(dir, { round: 2, findings: [finding("MIDDLE", { disposition: "deferred" })] });
    seedArtifact(dir, { round: 3, findings: [finding("NEWEST", { disposition: "deferred" })] });
  }

  it("drops whole sections from the bottom and names each one dropped", () => {
    const dir = tmpSession();
    seedThreeRounds(dir);
    writeFileSync(join(dir, "RULES.md"), "R".repeat(400), "utf-8");

    const full = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 4,
    });
    // Squeeze to somewhere between "diff only" and "everything".
    const squeezed = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 4,
      budget: Math.floor(full.text.length * 0.5),
    });

    expect(squeezed.sections.length).toBeLessThan(full.sections.length);
    // "partial" when some context survived, "none" when none did. Both are
    // incomplete and both must say so; asserting one of them alone made this
    // test depend on where the 50 percent squeeze happened to land.
    expect(["partial", "none"]).toContain(squeezed.completeness);
    expect(squeezed.omissions.length).toBeGreaterThan(0);
    for (const o of squeezed.omissions) expect(squeezed.text).toContain(o);
    // Residuals are LAST to drop, so whatever survived must include them.
    const surviving = squeezed.sections.map((s) => s.id);
    if (surviving.length > 0) expect(surviving).toContain("accepted-residuals");
  });

  it("DROP ORDER IS A STRICT PREFIX: a lower section never survives a dropped higher one", () => {
    // The bug this pins: a greedy per-section fit drops the large, high-priority
    // residuals section and then keeps the small project-rules section in the
    // space that freed. The packet would ship rules while silently withholding
    // the residuals that outrank them, inverting the ordering the drop order
    // exists to express. Found by a test that was checking something else,
    // which is exactly why it needs a test of its own.
    const dir = tmpSession();
    seedThreeRounds(dir);
    writeFileSync(join(dir, "RULES.md"), "tiny", "utf-8");

    const full = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 4,
    });
    const residualsBody = full.sections.find((s) => s.id === "accepted-residuals")!.body;
    const rulesBody = full.sections.find((s) => s.id === "project-rules")!.body;
    // Room for the small low-priority section, nowhere near enough for the
    // high-priority one even with every residual entry shed.
    const budget = directive.length + rulesBody.length + 20;
    expect(budget - directive.length).toBeLessThan(residualsBody.length);

    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 4, budget,
    });

    expect(packet.sections.map((s) => s.id)).not.toContain("project-rules");
    expect(packet.sections).toEqual([]);
    expect(packet.completeness).toBe("none");
    // The mandatory payload survives the total collapse of optional context,
    // and it NAMES what collapsed. Asserting equality with the directive here
    // would be re-pinning the withdrawn promise.
    expect(packet.text).toContain(directive);
    expect(packet.text).toContain('section "accepted-residuals" dropped');
    expect(packet.text).toContain('section "project-rules" dropped');
  });

  it("sheds residual CONTENT oldest-first and says how many it dropped", () => {
    const dir = tmpSession();
    seedThreeRounds(dir);

    const full = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 4,
    });
    expect(full.text).toContain("OLDEST");

    // Budget derived from what the section actually renders to, not guessed:
    // just under the full residuals body, so exactly the oldest entry has to go.
    const residualsBody = full.sections.find((s) => s.id === "accepted-residuals")!.body;
    const oldestLine = residualsBody.split("\n").find((l) => l.includes("OLDEST"))!;
    const tight = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 4,
      budget: directive.length + residualsBody.length - Math.floor(oldestLine.length / 2),
    });

    // The newest residual is the one most likely still to matter, so the oldest
    // goes first and the section admits it rather than shrinking in silence.
    expect(tight.text).not.toContain("OLDEST");
    expect(tight.text).toMatch(/dropped|older|omitted/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HISTORY, NOT A RECONCILED LEDGER  (plan 3.3)
//
// Superseding was tried and withdrawn. There is no cross-round finding
// reference: `Finding.id` is optional, the native route synthesises a
// positional `codex-N`, and a content key over severity/category/text both
// collides and misses. So nothing here claims to know an entry's CURRENT
// status, and these tests pin that absence as hard as they pin the presence of
// the history itself.
// ───────────────────────────────────────────────────────────────────────────

describe("ISS-1115 3.3: prior acceptances render as history", () => {
  const directive = "diff --git a/x b/x\n+line\n";
  const withPacket = (dir: string, over: Record<string, unknown> = {}) =>
    buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, ...over,
    });

  it("marks every acceptance status unconfirmed and suppresses NO entry", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("A", { disposition: "deferred" })] });
    seedArtifact(dir, { round: 2, findings: [finding("B", { disposition: "contested" })] });

    const packet = withPacket(dir);

    // Two entries, two "status unconfirmed", no exceptions.
    const marks = packet.text.match(/Status unconfirmed/g) ?? [];
    expect(marks.length).toBe(2);
    // The absence is asserted over the WHOLE packet rather than per fixture:
    // a per-entry check passes while some other code path still emits one.
    expect(packet.text).not.toMatch(/do not re-raise (this|it|finding)/i);
    expect(packet.text).not.toMatch(/already accepted[,;]? do not/i);
  });

  it("states the reopening rule EXACTLY once, with all four grounds", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("A", { disposition: "deferred" })] });
    seedArtifact(dir, { round: 2, findings: [finding("B", { disposition: "deferred" })] });

    const text = withPacket(dir).text;

    expect((text.match(/HOW TO TREAT THE HISTORY BELOW/g) ?? []).length).toBe(1);
    for (const ground of [
      "new evidence",
      "changed relevant code or dependencies",
      "changed",
      "concrete error in the earlier rationale",
    ]) {
      expect(text).toContain(ground);
    }
    // Conditional in both directions (plan 3.3, gate 1 round 4 finding E).
    expect(text).toMatch(/already reopened needs no such grounds/i);
    expect(text).toMatch(/deferred is OUTSTANDING rather than accepted/i);
  });

  it("renders a reopened acceptance with BOTH rounds visible", () => {
    // Round 1 defers it, round 2 reopens it. With no reconciliation the packet
    // must not hide either fact: the reviewer is the one doing the reconciling
    // and cannot do it from half the history.
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("X", { disposition: "deferred" })] });
    seedArtifact(dir, { round: 2, findings: [finding("X", { disposition: "open" })] });
    seedArtifact(dir, { round: 3, findings: [finding("UNRELATED", { disposition: "deferred" })] });

    const reopened = withPacket(dir, { roundNum: 4 });

    expect(reopened.text).toContain("round 1");
    expect(reopened.text).toContain("finding X");
    // POSITIVE CONTROL: the same history WITHOUT the reopen still renders the
    // acceptance. Without this pair, "X is absent" also passes against a packet
    // that renders no history at all.
    const dir2 = tmpSession();
    seedArtifact(dir2, { round: 1, findings: [finding("X", { disposition: "deferred" })] });
    seedArtifact(dir2, { round: 3, findings: [finding("UNRELATED", { disposition: "deferred" })] });
    const notReopened = withPacket(dir2, { roundNum: 4 });
    expect(notReopened.text).toContain("finding X");

    // And the unrelated acceptance survives in BOTH, under the same budget, so
    // neither result can be produced by the section failing to render.
    expect(reopened.text).toContain("finding UNRELATED");
    expect(notReopened.text).toContain("finding UNRELATED");
  });

  it("renders owner-accepted-risk and valid-deferred with DIFFERENT meanings", () => {
    // "They differ" is satisfied by two wrong strings, so each is asserted for
    // its own content. An earlier version stored the distinction and rendered
    // both identically, which made the field decorative.
    const dir = tmpSession();
    seedArtifact(dir, {
      round: 1,
      findings: [
        finding("RISK", { disposition: "deferred", dispositionReason: "owner-accepted-risk" }),
        finding("WORK", { disposition: "deferred", dispositionReason: "valid-deferred" }),
      ],
    });

    const text = withPacket(dir).text;
    const riskLine = text.split("\n").findIndex((l) => l.includes("finding RISK"));
    const workLine = text.split("\n").findIndex((l) => l.includes("finding WORK"));
    const lines = text.split("\n");

    expect(lines[riskLine + 1]).toMatch(/accepted risk \(a decision that was taken\)/);
    expect(lines[workLine + 1]).toMatch(/POSTPONED and still outstanding/);
    // Postponed work must never read as a decision nobody took.
    expect(lines[workLine + 1]).not.toMatch(/accepted risk/);
  });

  it("shows an unrecognised disposition RAW and discloses how it is read", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("KNOWN", { disposition: "deferred" })] });
    seedArtifact(dir, {
      round: 2,
      findings: [finding("WEIRD", { disposition: "wontfix-approved" })],
    });

    const packet = withPacket(dir, { roundNum: 3 });
    const text = packet.text;

    // Storage preserves, interpretation is conservative, rendering shows both.
    // Preserving verbatim WITHOUT the effective reading was the actual defect:
    // a reviewer shown "wontfix-approved" alone reads it as an acceptance.
    expect(text).toContain("wontfix-approved");
    expect(text).toMatch(/unrecognised value, treated as open/);

    // AND it is not an acceptance. Reading it as `open` is what keeps it out of
    // the history block, which is the conservative direction: the packet would
    // rather under-report an acceptance than invent one.
    const history = packet.sections.find((s) => s.id === "accepted-residuals")!.body;
    expect(history).not.toContain("finding WEIRD");
    expect(history).toContain("finding KNOWN");
  });

  it("never presents `addressed` as an acceptance", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("CLAIMED", { disposition: "addressed" })] });
    seedArtifact(dir, { round: 2, findings: [finding("REAL", { disposition: "deferred" })] });

    const packet = withPacket(dir, { roundNum: 3 });
    const history = packet.sections.find((s) => s.id === "accepted-residuals")!.body;

    // "The worker says it is fixed" is a claim, not a confirmation. The control
    // proves the section renders at all.
    expect(history).not.toContain("finding CLAIMED");
    expect(history).toContain("finding REAL");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE MANDATORY PAYLOAD  (plan 3.1)
// ───────────────────────────────────────────────────────────────────────────

describe("ISS-1115 3.1: the mandatory payload always ships", () => {
  const directive = "capture: git diff\n";

  it("carries the reporting rule on ROUND 1, where there is no history to nest it in", () => {
    // Round 1 is where a reviewer first learns to classify, and round 1 has no
    // residuals section. An earlier version nested the rule inside that
    // section, so it vanished on exactly the round that needed it most.
    const dir = tmpSession();

    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 1,
    });

    expect(packet.sections).toEqual([]);
    expect(packet.text).toContain("REPORTING RULE");
    expect(packet.text).toContain("originClass");
    expect(packet.text).toContain(directive);
  });

  it("puts every omission into TEXT, not only onto the field", () => {
    // A caveat that lives on a field no caller reads is not a caveat: every
    // caller injects `packet.text` alone.
    const dir = tmpSession();
    seedArtifact(dir, { round: 2, findings: [finding("F", { disposition: "deferred" })] });

    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 3,
    });

    expect(packet.omissions.length).toBeGreaterThan(0);
    for (const o of packet.omissions) expect(packet.text).toContain(o);
    expect(packet.text).toContain("CONTEXT COMPLETENESS: INCOMPLETE");
  });

  it("says COMPLETE, and says it explicitly, when nothing is missing", () => {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("F", { disposition: "deferred" })] });
    seedArtifact(dir, { round: 2, findings: [finding("G", { disposition: "deferred" })] });

    const packet = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 3,
    });

    expect(packet.completeness).toBe("complete");
    expect(packet.omissions).toEqual([]);
    expect(packet.text).toContain("CONTEXT COMPLETENESS: complete");
  });

  it("holds the LENGTH invariant at an exact boundary, both directions", () => {
    // The disclosure NAMES what was dropped, so it grows with every shedding
    // decision. Measuring it once before shedding and appending omissions
    // afterwards can exceed a budget the mandatory payload alone fitted inside.
    // Stated as a length so it is checkable rather than narrative.
    const dir = tmpSession();
    for (let r = 1; r <= 4; r++) {
      seedArtifact(dir, { round: r, findings: [finding(`F${r}`, { disposition: "deferred" })] });
    }
    writeFileSync(join(dir, "RULES.md"), "R".repeat(300), "utf-8");

    const full = buildReviewContextPacket({
      ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 5,
    });

    // Sweep every budget across the whole range, not a hand-picked one.
    for (let budget = 1; budget <= full.text.length + 5; budget += 7) {
      const p = buildReviewContextPacket({
        ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive,
        roundNum: 5, budget,
      });
      if (p.text.length > budget) {
        // Permitted ONLY when nothing optional survived: the overflow is the
        // mandatory payload itself, which is the stated honest outcome.
        expect(p.sections).toEqual([]);
      }
      // Whatever it chose, the payload it reports is the payload it assembled.
      for (const o of p.omissions) expect(p.text).toContain(o);
      expect(p.text).toContain(directive);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE PACKET VALIDATES WHAT IT READS  (plan 3.4)
//
// Each negative case starts from a COMPLETE, VALID history and proves it is
// ACCEPTED, then corrupts exactly one thing. Without the accepted baseline,
// "the finding is absent" also passes against a reader that rejects everything.
// ───────────────────────────────────────────────────────────────────────────

describe("ISS-1115 3.4: artifact validation", () => {
  const directive = "capture: git diff\n";
  const build = (dir: string) => buildReviewContextPacket({
    ...base, sessionDir: dir, projectRoot: dir, captureDirective: directive, roundNum: 3,
  });

  /** Seed a valid two-round history and assert the packet ACCEPTS it. */
  function validBaseline(): string {
    const dir = tmpSession();
    seedArtifact(dir, { round: 1, findings: [finding("KEEP", { disposition: "deferred" })] });
    seedArtifact(dir, { round: 2, findings: [finding("ALSO", { disposition: "deferred" })] });
    const packet = build(dir);
    expect(packet.completeness).toBe("complete");
    expect(packet.text).toContain("finding KEEP");
    return dir;
  }

  function rewrite(dir: string, round: number, mutate: (o: Record<string, unknown>) => void): void {
    const path = join(dir, "telemetry", "reviews", verdictFilename("T-001", "code", round, 0));
    const body = JSON.parse(readFileSync(path, "utf-8"));
    mutate(body);
    writeFileSync(path, JSON.stringify(body, null, 2), "utf-8");
  }

  it("rejects an artifact whose content hash does not verify", () => {
    const dir = validBaseline();
    rewrite(dir, 1, (b) => { b.summary = "tampered"; });   // hash now stale

    const packet = build(dir);

    expect(packet.text).not.toContain("finding KEEP");
    expect(packet.omissions.join("\n")).toMatch(/round 1: artifact rejected \(content hash does not verify\)/);
    expect(packet.completeness).not.toBe("complete");
    // The surviving round still renders, so the reader rejected ONE artifact
    // rather than failing shut.
    expect(packet.text).toContain("finding ALSO");
  });

  it("rejects a body whose identity contradicts its filename, with a VALID hash", () => {
    // Re-hashed after the mutation, so hash rejection cannot be what fires.
    // This is the case an earlier test design could not distinguish.
    const dir = validBaseline();
    rewrite(dir, 1, (b) => {
      delete b._contentHash;
      b.round = 99;
      b._contentHash = computeContentHash(b as ReviewVerdictArtifact);
    });

    const packet = build(dir);

    expect(packet.omissions.join("\n")).toMatch(/body identity contradicts filename \(round\)/);
    expect(packet.text).not.toContain("finding KEEP");
    expect(packet.text).toContain("finding ALSO");
  });

  it("rejects a generation mismatch specifically", () => {
    // Generation is the field the whole redirect boundary rests on, and an
    // earlier version of the identity check omitted it.
    const dir = validBaseline();
    rewrite(dir, 1, (b) => {
      delete b._contentHash;
      b.generation = 7;
      b._contentHash = computeContentHash(b as ReviewVerdictArtifact);
    });

    const packet = build(dir);

    expect(packet.omissions.join("\n")).toMatch(/body identity contradicts filename \(generation\)/);
    expect(packet.text).toContain("finding ALSO");
  });

  it("rejects a hash-VALID artifact whose findings is not an array", () => {
    // Hash validity proves nobody edited the file. It does not prove the file
    // was ever well formed.
    const dir = validBaseline();
    rewrite(dir, 1, (b) => {
      delete b._contentHash;
      b.findings = { nope: true };
      b._contentHash = computeContentHash(b as ReviewVerdictArtifact);
    });

    const packet = build(dir);

    expect(packet.omissions.join("\n")).toMatch(/round 1: artifact rejected \(findings is not an array\)/);
    expect(packet.text).toContain("finding ALSO");
  });

  it("does not consume backendRunId from a rejected artifact", () => {
    // The codex-session lookup goes through the SAME validated reader. An
    // earlier version had its own path, so an artifact the history side
    // rejected could still hand a session id to the reviewer.
    const dir = tmpSession();
    seedArtifact(dir, {
      round: 1, stage: "plan",
      backendRunId: "codex-sess-POISON", backendRunIdKind: "codex-session",
    });
    // Prove it WOULD have been consumed when valid.
    expect(build(dir).priorCodexSessionId).toBe("codex-sess-POISON");

    const path = join(dir, "telemetry", "reviews", verdictFilename("T-001", "plan", 1, 0));
    const body = JSON.parse(readFileSync(path, "utf-8"));
    body.summary = "tampered";
    writeFileSync(path, JSON.stringify(body, null, 2), "utf-8");

    expect(build(dir).priorCodexSessionId).toBeUndefined();
  });
});

describe("T-494: cited rulings in the packet", () => {
  const CAVEAT = "Attribution is a CLAIM";

  /** Builds N resolved citations whose ruling text is `size` characters. */
  function resolvedCitations(specs: { id: string; size: number }[]): CitationResolution[] {
    const rulings = specs.map((spec) =>
      makeRuling({ id: spec.id, text: "x".repeat(spec.size) }),
    );
    const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
    return specs.map((spec) => resolveCitation(spec.id, ctx));
  }

  function packetWith(citations: CitationResolution[], budget: number): ReviewContextPacket {
    const dir = tmpSession();
    return buildReviewContextPacket({
      ...base,
      budget,
      sessionDir: dir,
      projectRoot: dir,
      citedRulings: citations,
    });
  }

  it("places the block inside the MANDATORY payload, after the origin rule and before the disclosure", () => {
    const packet = packetWith(resolvedCitations([{ id: "r-0000000000000001", size: 20 }]), 16_000);
    const blockAt = packet.text.indexOf("## Cited Rulings");
    const disclosureAt = packet.text.indexOf("CONTEXT COMPLETENESS");
    const captureAt = packet.text.indexOf(base.captureDirective);
    expect(blockAt).toBeGreaterThan(-1);
    expect(blockAt).toBeLessThan(disclosureAt);
    expect(disclosureAt).toBeLessThan(captureAt);
  });

  it("is NEVER dropped, even at a budget that drops every optional section", () => {
    // The mandatory payload is what a reviewer is guaranteed. A ruling that
    // silently vanishes under budget pressure is the failure this scope exists
    // to prevent, so it must survive the smallest possible packet.
    const packet = packetWith(resolvedCitations([{ id: "r-0000000000000001", size: 20 }]), 1);
    expect(packet.text).toContain("## Cited Rulings");
    expect(packet.text).toContain("r-0000000000000001");
  });

  it("renders a stale citation with the CURRENT text and the superseded label", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001", text: "old decision" }),
      makeRuling({ id: "r-0000000000000002", text: "new decision", supersedes: "r-0000000000000001" }),
    ];
    const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
    const packet = packetWith([resolveCitation("r-0000000000000001", ctx)], 16_000);
    expect(packet.text).toContain("superseded by r-0000000000000002");
    expect(packet.text).toContain("new decision");
    expect(packet.text).not.toContain("old decision");
  });

  it("renders each non-resolved status as its own line rather than dropping it", () => {
    const ctx = buildCitationResolutionContext([], new Set(), "complete");
    const packet = packetWith([resolveCitation("r-0000000000000009", ctx)], 16_000);
    expect(packet.text).toContain("r-0000000000000009");
  });

  it("carries the anti-laundering caveat for every resolved citation", () => {
    const packet = packetWith(resolvedCitations([{ id: "r-0000000000000001", size: 20 }]), 16_000);
    expect(packet.text).toContain(CAVEAT);
  });

  // The plan's fixture table. The first two rows are the SAME input at two
  // budgets, which is what proves the cap is derived from the round's budget
  // rather than hardcoded.
  it("fixture: 3 rulings of 1500 at budget 16000 (cap 4000) keeps 2 texts and marks 1", () => {
    const packet = packetWith(
      resolvedCitations([
        { id: "r-0000000000000001", size: 1500 },
        { id: "r-0000000000000002", size: 1500 },
        { id: "r-0000000000000003", size: 1500 },
      ]),
      16_000,
    );
    expect(packet.text.match(/\[text truncated, read with ruling_get /g) ?? []).toHaveLength(1);
    expect(packet.omissions.some((o) => o.includes("1") && o.includes("ruling"))).toBe(true);
  });

  it("fixture: the SAME 3 rulings at budget 24000 (cap 6000) keep all 3 texts", () => {
    const packet = packetWith(
      resolvedCitations([
        { id: "r-0000000000000001", size: 1500 },
        { id: "r-0000000000000002", size: 1500 },
        { id: "r-0000000000000003", size: 1500 },
      ]),
      24_000,
    );
    expect(packet.text).not.toContain("[text truncated");
    expect(packet.omissions.filter((o) => o.includes("ruling"))).toEqual([]);
  });

  it("fixture: a ruling of EXACTLY the cap is included (the comparison is inclusive)", () => {
    const packet = packetWith(resolvedCitations([{ id: "r-0000000000000001", size: 4000 }]), 16_000);
    expect(packet.text).not.toContain("[text truncated");
  });

  it("fixture: a ruling of cap+1 gets the marker (the same boundary from the other side)", () => {
    const packet = packetWith(resolvedCitations([{ id: "r-0000000000000001", size: 4001 }]), 16_000);
    expect(packet.text).toContain("[text truncated, read with ruling_get r-0000000000000001]");
  });

  it("keeps the ALWAYS-present tier for a ruling whose text was dropped", () => {
    const packet = packetWith(resolvedCitations([{ id: "r-0000000000000001", size: 4001 }]), 16_000);
    expect(packet.text).toContain("r-0000000000000001");
    expect(packet.text).toContain("owner-direct");
    expect(packet.text).toContain("2026-08-27");
    expect(packet.text).toContain(CAVEAT);
  });

  it("includes texts in CITATION ORDER, all-or-nothing, not best-fit packing", () => {
    // A long first ruling must not starve the block into markers while a
    // shorter later one would have fitted: best-fit packing would reorder
    // rulings by length, and citation order is the order the recorder chose.
    const packet = packetWith(
      resolvedCitations([
        { id: "r-0000000000000001", size: 3900 },
        { id: "r-0000000000000002", size: 50 },
        { id: "r-0000000000000003", size: 50 },
      ]),
      16_000,
    );
    const firstAt = packet.text.indexOf("r-0000000000000001");
    const secondAt = packet.text.indexOf("r-0000000000000002");
    expect(firstAt).toBeLessThan(secondAt);
    expect(packet.text).not.toContain("[text truncated, read with ruling_get r-0000000000000001]");
  });

  it("names the truncated count in the disclosure through the existing omissions channel", () => {
    const packet = packetWith(resolvedCitations([{ id: "r-0000000000000001", size: 4001 }]), 16_000);
    expect(packet.text).toContain("CONTEXT COMPLETENESS: INCOMPLETE");
    expect(packet.omissions.some((o) => o.includes("ruling"))).toBe(true);
    expect(packet.completeness).toBe("partial");
  });

  it("changes nothing at all when no citations are passed", () => {
    const dir = tmpSession();
    const withField = buildReviewContextPacket({ ...base, sessionDir: dir, projectRoot: dir, citedRulings: [] });
    const without = buildReviewContextPacket({ ...base, sessionDir: dir, projectRoot: dir });
    expect(withField.text).toBe(without.text);
    expect(without.text).not.toContain("## Cited Rulings");
  });
});
