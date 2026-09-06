/**
 * T-432: the scanner, the P2 metrics, and the renderer.
 *
 * The scanner needs a real tree because the property under test is what happens
 * when a read FAILS, and a mocked fs proves only that the mock was configured.
 * Failures are induced with chmod 000, so each test asserts against an actual
 * EACCES rather than a simulated one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanRoots,
  discoverFleetRoots,
  classifyLandingReason,
  LANDING_REASONS,
} from "../../src/core/review-stats-scan.js";
import { computeP1, computeP2 } from "../../src/core/review-stats.js";
import { renderValue, renderCoverage, renderOverlaps, handleReviewStats } from "../../src/cli/commands/review-stats.js";
import { metric, type MetricInput } from "../../src/core/review-stats-types.js";

let root: string;
const chmodded: string[] = [];

function sessionDir(sessionId: string): string {
  const d = join(root, ".story", "sessions", sessionId);
  mkdirSync(d, { recursive: true });
  return d;
}

function seedArtifact(sessionId: string, o: {
  target?: string; stage?: string; round?: number; verdict?: string;
  reviewer?: string; critical?: number; findings?: number; timestamp?: string;
  hash?: string; originClasses?: readonly unknown[]; body?: string;
  diffLines?: number;
} = {}): void {
  const dir = join(sessionDir(sessionId), "telemetry", "reviews");
  mkdirSync(dir, { recursive: true });
  const stage = o.stage ?? "code";
  const target = o.target ?? "T-001";
  const round = o.round ?? 1;
  const name = `${target}-${stage}-r${round}.json`;
  if (o.body !== undefined) {
    writeFileSync(join(dir, name), o.body, "utf-8");
    return;
  }
  writeFileSync(join(dir, name), JSON.stringify({
    target, stage, round,
    reviewer: o.reviewer ?? "codex",
    verdict: o.verdict ?? "approve",
    findingsCount: o.findings ?? 0,
    severityCounts: { critical: o.critical ?? 0, major: 0, minor: 0, suggestion: 0 },
    startedAt: "2026-09-05T00:00:00.000Z", durationMs: 1, summary: "s",
    findings: (o.originClasses ?? []).map((c) => ({ severity: "major", originClass: c })),
    timestamp: o.timestamp ?? `2026-09-05T00:00:0${round}.000Z`,
    _contentHash: o.hash ?? "h",
    ...(o.diffLines === undefined ? {} : { diffLines: o.diffLines }),
  }), "utf-8");
}

function seedState(sessionId: string, o: {
  landingReason?: string | null; risk?: string; realizedRisk?: string; body?: string;
} = {}): void {
  const d = sessionDir(sessionId);
  if (o.body !== undefined) { writeFileSync(join(d, "state.json"), o.body, "utf-8"); return; }
  writeFileSync(join(d, "state.json"), JSON.stringify({
    sessionId,
    ...(o.landingReason === undefined ? {} : {
      landingDecision: o.landingReason === null ? null : { reason: o.landingReason, round: 1 },
    }),
    ticket: {
      id: "T-001",
      ...(o.risk === undefined ? {} : { risk: o.risk }),
      ...(o.realizedRisk === undefined ? {} : { realizedRisk: o.realizedRisk }),
    },
  }), "utf-8");
}

function denyRead(path: string): void {
  chmodSync(path, 0o000);
  chmodded.push(path);
}

/**
 * Undo every denial NOW.
 *
 * A test that denies a DIRECTORY cannot `rmSync` its own tree afterwards: the
 * recursive delete needs to read the directory it just made unreadable, and
 * fails with the same EACCES the test was inducing. So restoration has to
 * happen inside the test's own `finally`, before the cleanup, not only in
 * `afterEach`.
 */
function restoreDenied(): void {
  for (const p of chmodded.splice(0)) {
    try { chmodSync(p, 0o755); } catch { /* already gone */ }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t432-scan-"));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
});
afterEach(() => {
  restoreDenied();
  rmSync(root, { recursive: true, force: true });
});

describe("scan states distinguish absence from failure", () => {
  it("EMPTY: the sessions directory does not exist at all", async () => {
    const bare = mkdtempSync(join(tmpdir(), "t432-bare-"));
    try {
      const r = await scanRoots([bare]);
      expect(r.report.state[`p1:${bare}`]).toBe("EMPTY");
      expect(r.report.failures).toHaveLength(0);
      // EMPTY is a fact about the root; UNAVAILABLE is a fact about the scan.
      // Only the second is a reason to withhold a total.
      const p1 = computeP1({ artifacts: r.p1, scan: r.report });
      expect(p1.metrics[0]!.records.total).toBe(0);
    } finally { rmSync(bare, { recursive: true, force: true }); }
  });

  it("COMPLETE: everything read", async () => {
    seedArtifact("s1"); seedState("s1");
    const r = await scanRoots([root]);
    expect(r.report.state[`p1:${root}`]).toBe("COMPLETE");
    expect(r.p1).toHaveLength(1);
  });

  it("UNAVAILABLE: the root's session listing failed, so nothing was read", async () => {
    seedArtifact("s1");
    denyRead(join(root, ".story", "sessions"));
    const r = await scanRoots([root]);
    expect(r.report.state[`p1:${root}`]).toBe("UNAVAILABLE");
    expect(r.report.failures[0]!.scope).toBe("root-discovery");
    const p1 = computeP1({ artifacts: r.p1, scan: r.report });
    // No population size, and no coverage percentage claimed over it.
    expect(p1.metrics[0]!.records.total).toBeNull();
  });
});

describe("failures are classified by SCOPE, not by which call failed", () => {
  it("a RECORD failure leaves a fully-read session in the same root authoritative", async () => {
    seedArtifact("good", { round: 1 });
    seedArtifact("bad", { round: 1 });
    denyRead(join(root, ".story", "sessions", "bad", "telemetry", "reviews", "T-001-code-r1.json"));

    const r = await scanRoots([root]);

    expect(r.report.failures.map((f) => f.scope)).toEqual(["record"]);
    expect(r.report.failures[0]!.sessionId).toBe("bad");
    // The good session's artifact survives. A record failure suppresses one
    // record, not a session and not a root.
    expect(r.p1.map((a) => a.sessionId)).toEqual(["good"]);
    expect(r.report.state[`p1:${root}`]).toBe("PARTIAL");
  });

  it("a malformed record is a RECORD failure, not a silent skip", async () => {
    seedArtifact("s1", { body: "{ not json" });
    const r = await scanRoots([root]);
    expect(r.report.failures[0]!.scope).toBe("record");
    expect(r.p1).toHaveLength(0);
  });

  it("a record missing a required field is a failure, never a record with blank fields", async () => {
    // Admitting it with empty strings would put a record with no target into a
    // grouping keyed on target, inventing a group.
    seedArtifact("s1", { body: JSON.stringify({ round: 1, verdict: "approve" }) });
    const r = await scanRoots([root]);
    expect(r.report.failures[0]!.reason).toBe("missing required field");
    expect(r.p1).toHaveLength(0);
  });

  it("failing to list ONE KNOWN SESSION's reviews leaves SIBLING sessions authoritative", async () => {
    seedArtifact("sibling", { round: 1 });
    seedArtifact("blocked", { round: 1 });
    denyRead(join(root, ".story", "sessions", "blocked", "telemetry", "reviews"));

    const r = await scanRoots([root]);

    // KNOWN-SESSION, not root-discovery: this hides no other session, so the
    // root's other sessions are not downgraded. Splitting on the failed
    // OPERATION would have filed both listing failures alike.
    expect(r.report.failures.map((f) => f.scope)).toEqual(["known-session"]);
    expect(r.report.failures[0]!.sessionId).toBe("blocked");
    expect(r.p1.map((a) => a.sessionId)).toEqual(["sibling"]);
  });

  it("an UNCLASSIFIABLE ENTRY in the root listing is ROOT-DISCOVERY scope", async () => {
    // A failed stat leaves a NAME that may or may not be a session, so whole
    // sessions may be invisible: the uncertainty reaches the root, not a record.
    seedArtifact("visible");
    mkdirSync(join(root, ".story", "sessions", "opaque"));
    denyRead(join(root, ".story", "sessions"));
    // Re-open the listing but not the entries, so readdir succeeds and stat fails.
    chmodSync(join(root, ".story", "sessions"), 0o444);

    const r = await scanRoots([root]);

    expect(r.report.failures.length).toBeGreaterThan(0);
    expect(new Set(r.report.failures.map((f) => f.scope))).toEqual(new Set(["root-discovery"]));
    chmodSync(join(root, ".story", "sessions"), 0o755);
  });

  it("a FAILED P2 STATE READ leaves P1 for the SAME SESSION complete", async () => {
    // The point of classifying by affected population. P1 never reads state, so
    // suppressing its reconstruction for sharing a session id would discard good
    // evidence over an unrelated defect.
    seedArtifact("s1", { round: 1 });
    seedState("s1");
    denyRead(join(root, ".story", "sessions", "s1", "state.json"));

    const r = await scanRoots([root]);

    expect(r.report.failures[0]!.affects).toEqual(["p2"]);
    expect(r.report.state[`p1:${root}`]).toBe("COMPLETE");
    expect(r.report.state[`p2:${root}`]).toBe("UNAVAILABLE");
    expect(r.p1).toHaveLength(1);

    // THE WHOLE REPORT, exactly as the command builds it. An earlier version of
    // this test hand-filtered the state down to the `p1:` key before passing it
    // in, so it asserted the property on an input production never constructs
    // and passed while `computeP1` was in fact reducing over every key --
    // meaning a failed state.json read really did mark P1 unavailable.
    const p1 = computeP1({ artifacts: r.p1, scan: r.report });
    expect(p1.metrics[0]!.scanState).toBe("COMPLETE");
    expect(p1.metrics[0]!.records.total).toBe(1);
    expect(p1.metrics[0]!.conditional).toBe(false);

    // and the P2 metrics DO carry the failure, because it is theirs
    const p2 = computeP2({ sessions: r.p2, scan: r.report }, classifyLandingReason);
    expect(p2.metrics[0]!.scanState).toBe("UNAVAILABLE");
    expect(p2.metrics[0]!.records.total).toBeNull();
  });

  it("a session with NO reviews directory is CONFIRMED ABSENCE, not failed discovery", async () => {
    // The two are opposite conclusions from the same empty result: confirmed
    // absence says the session ran no reviews, failed discovery says we do not
    // know. Only the first may be described as "no available artifacts".
    seedState("quiet");
    const r = await scanRoots([root]);
    expect(r.report.failures).toHaveLength(0);
    expect(r.p1).toHaveLength(0);
    expect(r.report.state[`p1:${root}`]).toBe("EMPTY");
    // and the session's state was still read, so P2 is complete for it
    expect(r.p2).toHaveLength(1);
    expect(r.report.state[`p2:${root}`]).toBe("COMPLETE");
  });

  it("and the CONVERSE: a P1 record failure leaves P2 complete", async () => {
    seedArtifact("s1", { round: 1 });
    seedState("s1", { risk: "low", realizedRisk: "high" });
    denyRead(join(root, ".story", "sessions", "s1", "telemetry", "reviews", "T-001-code-r1.json"));

    const r = await scanRoots([root]);

    const p2 = computeP2({ sessions: r.p2, scan: r.report }, classifyLandingReason);
    expect(p2.metrics[0]!.scanState).toBe("COMPLETE");
    expect(p2.metrics[0]!.records.total).toBe(1);
    // PARTIAL, not UNAVAILABLE: the reviews directory WAS listed and one file
    // in it failed, so something was read. The two are different answers and
    // only UNAVAILABLE means nothing was read.
    const p1 = computeP1({ artifacts: r.p1, scan: r.report });
    expect(p1.metrics[0]!.scanState).toBe("PARTIAL");
    expect(p1.metrics[0]!.records.total).toBeNull();
  });

  it("a missing state.json is absence, not a failure", async () => {
    seedArtifact("s1");
    const r = await scanRoots([root]);
    expect(r.report.failures).toHaveLength(0);
    expect(r.p2).toHaveLength(0);
  });
});

describe("an unparseable timestamp collapses to null at the boundary", () => {
  it("so it cannot reach compute as a string that sorts but means nothing", async () => {
    seedArtifact("s1", { round: 1, timestamp: "not a date" });
    const r = await scanRoots([root]);
    expect(r.p1[0]!.timestamp).toBeNull();
    // and therefore disqualifies its group from every order-dependent metric
    const p1 = computeP1({ artifacts: r.p1, scan: r.report });
    const rounds = p1.metrics.find((m) => m.id === "rounds-per-segment")!;
    expect(rounds.segments!.excludedGroups).toBe(1);
    expect(rounds.segments!.segmentTotal).toBeNull();
  });
});

describe("session ids under more than one root", () => {
  it("MATCHING STORED HASHES is reported as a claim, not as a confirmed copy", async () => {
    const other = mkdtempSync(join(tmpdir(), "t432-other-"));
    try {
      const save = root;
      seedArtifact("shared", { hash: "same" });
      root = other; mkdirSync(join(other, ".story", "sessions"), { recursive: true });
      seedArtifact("shared", { hash: "same" });
      root = save;

      const r = await scanRoots([root, other]);
      expect(r.overlaps).toHaveLength(1);
      expect(r.overlaps[0]!.agreement).toBe("matching-stored-hashes");
      // Both copies remain in the population: reported, never deduplicated.
      expect(r.p1).toHaveLength(2);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it("DIFFERING content under one session id is an unresolved overlap", async () => {
    const other = mkdtempSync(join(tmpdir(), "t432-other2-"));
    try {
      const save = root;
      seedArtifact("shared", { hash: "aaa" });
      root = other; mkdirSync(join(other, ".story", "sessions"), { recursive: true });
      seedArtifact("shared", { hash: "bbb" });
      root = save;
      const r = await scanRoots([root, other]);
      expect(r.overlaps[0]!.agreement).toBe("differing");
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it("a single root reports no overlaps", async () => {
    seedArtifact("s1");
    const r = await scanRoots([root]);
    expect(r.overlaps).toHaveLength(0);
  });
});

describe("fleet discovery", () => {
  it("finds only directories carrying .story/ and fails alone on a bad root", async () => {
    const fleet = mkdtempSync(join(tmpdir(), "t432-fleet-"));
    try {
      mkdirSync(join(fleet, "a", ".story"), { recursive: true });
      mkdirSync(join(fleet, "b"), { recursive: true });
      writeFileSync(join(fleet, "loose-file.txt"), "x");
      const d = await discoverFleetRoots(fleet);
      expect(d.roots).toEqual([join(fleet, "a")]);
      expect(d.failures).toHaveLength(0);
    } finally { rmSync(fleet, { recursive: true, force: true }); }
  });

  it("an unreadable fleet directory yields a root-discovery failure, not an empty success", async () => {
    const d = await discoverFleetRoots(join(root, "does-not-exist"));
    expect(d.roots).toHaveLength(0);
    expect(d.failures[0]!.scope).toBe("root-discovery");
  });
});

describe("P2 metrics", () => {
  const scan = (state = "COMPLETE" as const) => ({
    roots: ["/r"], startedAt: "t0", finishedAt: "t1", atomic: false as const,
    failures: [], readFailures: 0, state: { "p2:/r": state },
  });

  it("ABSENT landingDecision is UNKNOWN, not a no-landing", async () => {
    // The field is cleared on ceiling escalation, so a session that landed can
    // end with nothing recorded. Counting absence as a non-landing would turn a
    // gap in the record into evidence about the run.
    const r = computeP2({
      sessions: [
        { root: "/r", sessionId: "a", landingField: "absent" as const, landingReason: null, risk: null, realizedRisk: null },
        { root: "/r", sessionId: "b", landingField: "present" as const, landingReason: "max_review_rounds_no_blocking", risk: null, realizedRisk: null },
      ],
      scan: scan(),
    }, classifyLandingReason);
    const m = r.metrics.find((x) => x.id === "sessions-with-recorded-landing")!;
    expect(m.numerator).toBe(1);
    // The DENOMINATOR excludes the absent one. Counting it would make the
    // metric say "50% of sessions landed" over one session that did and one we
    // know nothing about, which is the claim the note forbids.
    expect(m.denominator).toBe(1);
    expect(m.records.missing).toBe(1);
    expect(m.records.invalid).toBe(0);
    expect(m.note).toContain("Absence is UNKNOWN");
  });

  it("an UNRECOGNISED reason is invalid, and never counted as a landing", async () => {
    const r = computeP2({
      sessions: [
        { root: "/r", sessionId: "a", landingField: "present" as const, landingReason: "because I said so", risk: null, realizedRisk: null },
      ],
      scan: scan(),
    }, classifyLandingReason);
    const m = r.metrics.find((x) => x.id === "sessions-with-recorded-landing")!;
    expect(m.numerator).toBe(0);
    // Present but unclassifiable still counts in the denominator: we know a
    // decision was recorded, only not which kind.
    expect(m.denominator).toBe(1);
    expect(m.records.invalid).toBe(1);
    expect(m.records.missing).toBe(0);
  });

  it("the landing table holds the slug the writer actually emits", () => {
    // Every one of the 10 fleet sessions carrying `landingDecision` holds this
    // slug. An earlier table matched two PROSE strings found by grepping for
    // reason literals; those belong to `pendingCeilingEscalation`, a different
    // record, so the table classified nothing. A grep found the string; only
    // the data found the record it lives on.
    expect(LANDING_REASONS.map(([id]) => id)).toEqual(["max-review-rounds-no-blocking"]);
    expect(classifyLandingReason("max_review_rounds_no_blocking"))
      .toBe("max-review-rounds-no-blocking");
    expect(classifyLandingReason(null)).toBeNull();
  });

  it("does NOT classify a pendingCeilingEscalation reason as a landing", () => {
    // The two records are different and their vocabularies are different. A
    // table that matched both would report a park as a landing.
    expect(classifyLandingReason(
      "Code review reached its hard ceiling of 8 rounds without reaching a landable verdict.",
    )).toBeNull();
  });

  it("realized risk is denominated in sessions carrying BOTH fields", async () => {
    // A session missing either cannot disagree with itself, so it is missing,
    // not an agreement.
    const r = computeP2({
      sessions: [
        { root: "/r", sessionId: "a", landingField: "absent" as const, landingReason: null, risk: "low", realizedRisk: "high" },
        { root: "/r", sessionId: "b", landingField: "absent" as const, landingReason: null, risk: "low", realizedRisk: "low" },
        { root: "/r", sessionId: "c", landingField: "absent" as const, landingReason: null, risk: "low", realizedRisk: null },
      ],
      scan: scan(),
    }, classifyLandingReason);
    const m = r.metrics.find((x) => x.id === "realized-risk-differs")!;
    expect(m.numerator).toBe(1);
    expect(m.denominator).toBe(2);
    expect(m.records.missing).toBe(1);
  });

  it("a PARTIAL P2 scan publishes over readable sessions and withholds the total", async () => {
    const r = computeP2({
      sessions: [
        { root: "/r", sessionId: "a", landingField: "absent" as const, landingReason: null, risk: "low", realizedRisk: "high" },
      ],
      scan: scan("PARTIAL"),
    }, classifyLandingReason);
    for (const m of r.metrics) {
      expect(m.records.total).toBeNull();
      expect(m.conditional).toBe(true);
    }
  });
});

describe("rendering reads; it never computes", () => {
  // `MetricInput`, the distributive form, and WITH its segment accounting. The
  // earlier fixture used a non-distributive `Omit<Metric, "value">` and declared
  // `unit: "segment"` with no `segments`, so it violated the contract the union
  // now enforces -- vitest transpiles without typechecking, so only tsc sees it.
  const base = {
    id: "x", label: "X", unit: "segment", kind: "mean", provenance: "reconstructed",
    population: "p1", scanState: "COMPLETE", numerator: 215, denominator: 170,
    conditional: false, records: { total: 215, readable: 215, missing: 0, invalid: 0 },
    segments: {
      eligibleSegments: 170, excludedGroups: 0, suppressedSessions: 0,
      suppressedArtifacts: 0, segmentTotal: 170,
    },
  } satisfies MetricInput;

  it("a MEAN is never rendered as a percentage", () => {
    // The live run printed `126.5%` for rounds per segment before `kind`
    // existed. A share above 100% tells a reader the tool is broken.
    expect(renderValue(metric(base))).toBe("1.26 per segment");
  });

  it("a PROPORTION renders as a percentage", () => {
    expect(renderValue(metric({ ...base, kind: "proportion", numerator: 1, denominator: 2 })))
      .toBe("50.0%");
  });

  it("a null value renders '-', for both kinds", () => {
    expect(renderValue(metric({ ...base, denominator: 0 }))).toBe("-");
    expect(renderValue(metric({ ...base, kind: "proportion", denominator: 0 }))).toBe("-");
  });

  it("an unknown total renders no coverage percentage", () => {
    const m = metric({
      ...base,
      records: { total: null, readable: 12, missing: 0, invalid: 0 },
    });
    expect(renderCoverage(m)).toBe("12 readable / total unknown");
    expect(renderCoverage(m)).not.toContain("%");
  });
});

describe("segment accounting reports the POPULATION, not the eligible subset", () => {
  it("a metric with narrower eligibility does not shrink the segment total", async () => {
    // Every metric here has its own eligibility. Reporting `eligible` as the
    // population would give a different population size per metric over
    // identical data.
    seedArtifact("s1", { target: "T-1", round: 1, timestamp: "2026-09-05T00:00:01.000Z" });
    seedArtifact("s1", { target: "T-1", round: 2, timestamp: "2026-09-05T00:00:02.000Z" });
    seedArtifact("s1", { target: "T-2", round: 5, timestamp: "2026-09-05T00:00:03.000Z" });

    const r = await scanRoots([root]);
    const p1 = computeP1({ artifacts: r.p1, scan: r.report });
    const diff = p1.metrics.find((m) => m.id === "diff-lines-first-surviving-review")!;

    // No seeded artifact carries diffLines, so NOTHING is eligible: eligibility
    // needs both a surviving round 1 and a usable measurement on it. An earlier
    // version asserted `eligibleSegments === 1` beside a denominator of 0,
    // which enforced the very mismatch it should have caught -- advertising a
    // segment as eligible while excluding it from the denominator.
    expect(diff.segments!.eligibleSegments).toBe(0);
    expect(diff.denominator).toBe(0);
    expect(diff.value).toBeNull();
    // ...but there are still TWO segments.
    expect(diff.segments!.segmentTotal).toBe(2);
    // And the record-level `missing` counts RECORDS, not segments.
    expect(diff.records.missing).toBe(3);
  });

  it("with a usable measurement, eligibility and the denominator agree", async () => {
    // The partner case. One round-1 segment carries diffLines and one does not,
    // so exactly one is eligible and the denominator is the same one.
    seedArtifact("s1", { target: "T-1", round: 1, diffLines: 120,
      timestamp: "2026-09-05T00:00:01.000Z" });
    seedArtifact("s1", { target: "T-2", round: 1,
      timestamp: "2026-09-05T00:00:02.000Z" });

    const r = await scanRoots([root]);
    const diff = computeP1({ artifacts: r.p1, scan: r.report })
      .metrics.find((m) => m.id === "diff-lines-first-surviving-review")!;

    expect(diff.segments!.eligibleSegments).toBe(1);
    expect(diff.denominator).toBe(1);
    expect(diff.numerator).toBe(120);
    expect(diff.value).toBe(120);
    expect(diff.segments!.segmentTotal).toBe(2);
    // The note states BOTH conditions rather than only the round-1 one.
    expect(diff.note).toContain("usable diffLines value");
  });
});

describe("a failed discovery never reads as an empty one", () => {
  const ctx = (r: string) => ({ root: r, format: "json", state: {}, warnings: [], handoversDir: "" }) as never;

  it("an unreadable fleet directory yields UNKNOWN totals, not a definitive zero", async () => {
    // With no roots there are no per-root state entries, and an empty state
    // reduces to EMPTY -- "scanned, nothing there". That would let the command
    // report `0 of 0` over a directory it could not open, which is the exact
    // shape of "an unavailable read became a number".
    const res = await handleReviewStats({ fleet: join(root, "no-such-dir") }, ctx(root));
    const json = JSON.parse(res.output);

    for (const m of json.p1.metrics) {
      expect(m.scanState).toBe("UNAVAILABLE");
      expect(m.records.total).toBeNull();
      expect(m.conditional).toBe(true);
    }
    expect(json.scan.failures[0].scope).toBe("root-discovery");
  });

  it("a readable but empty fleet directory DOES report a definitive zero", async () => {
    // The contrast that makes the case above meaningful: here the scan
    // succeeded and there genuinely is nothing.
    const empty = mkdtempSync(join(tmpdir(), "t432-emptyfleet-"));
    try {
      const res = await handleReviewStats({ fleet: empty }, ctx(root));
      const json = JSON.parse(res.output);
      expect(json.scan.failures).toHaveLength(0);
      expect(json.p1.metrics[0].records.total).toBe(0);
      expect(json.p1.metrics[0].scanState).toBe("EMPTY");
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe("a malformed state file is INVALID, never evidence of absence", () => {
  it("a state that is not an object is a record failure, not a readable record", () => {
    // A cast admits a string or an array as a "readable record" whose every
    // field then reads as absent, turning a malformed file into evidence about
    // the session it describes.
    seedState("s1", { body: '"just a string"' });
    return scanRoots([root]).then((r) => {
      expect(r.p2).toHaveLength(0);
      expect(r.report.failures[0]!.reason).toBe("state is not an object");
      expect(r.report.failures[0]!.affects).toEqual(["p2"]);
    });
  });

  it("an array state is refused too", async () => {
    seedState("s1", { body: "[]" });
    const r = await scanRoots([root]);
    expect(r.p2).toHaveLength(0);
    expect(r.report.failures[0]!.reason).toBe("state is not an object");
  });

  it("landingDecision present but MALFORMED is invalid, not absent", async () => {
    // Absent is unknown and stays out of the denominator. Malformed means
    // something IS there and cannot be read, so it belongs in the denominator
    // and in `invalid`; collapsing it into absent drops a record we know exists.
    seedState("s1", { body: JSON.stringify({ landingDecision: "corrupt" }) });
    const r = await scanRoots([root]);
    expect(r.p2[0]!.landingField).toBe("malformed");

    const p2 = computeP2({ sessions: r.p2, scan: r.report }, classifyLandingReason);
    const m = p2.metrics.find((x) => x.id === "sessions-with-recorded-landing")!;
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBe(0);
    expect(m.records.invalid).toBe(1);
    expect(m.records.missing).toBe(0);
  });

  it("landingDecision: null is ABSENT, because that is the schema's own default", async () => {
    seedState("s1", { landingReason: null });
    const r = await scanRoots([root]);
    expect(r.p2[0]!.landingField).toBe("absent");
  });

  it("a present decision whose reason is not a string is invalid, not counted", async () => {
    seedState("s1", { body: JSON.stringify({ landingDecision: { reason: 42 } }) });
    const r = await scanRoots([root]);
    expect(r.p2[0]!.landingField).toBe("present");
    expect(r.p2[0]!.landingReason).toBeNull();
    const m = computeP2({ sessions: r.p2, scan: r.report }, classifyLandingReason)
      .metrics.find((x) => x.id === "sessions-with-recorded-landing")!;
    expect(m.records.invalid).toBe(1);
    expect(m.numerator).toBe(0);
  });
});

describe("overlap classification across THREE roots", () => {
  const seedIn = (dir: string, sessionId: string, o: Parameters<typeof seedArtifact>[1]) => {
    const save = root;
    root = dir;
    mkdirSync(join(dir, ".story", "sessions"), { recursive: true });
    seedArtifact(sessionId, o);
    root = save;
  };

  it("a file shared by only TWO of three roots is still compared", async () => {
    // Intersecting across ALL roots dropped such a file from the comparison
    // entirely, so two roots disagreeing about it could be reported as
    // matching, or as sharing no files at all.
    const b = mkdtempSync(join(tmpdir(), "t432-3b-"));
    const c = mkdtempSync(join(tmpdir(), "t432-3c-"));
    try {
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      seedIn(b, "shared", { target: "T-1", hash: "zzz" });
      seedIn(c, "shared", { target: "T-9", hash: "qqq" });

      const r = await scanRoots([root, b, c]);
      const o = r.overlaps[0]!;
      expect(o.sharedFiles).toBe(1);
      expect(o.differingFiles).toBe(1);
      expect(o.agreement).toBe("differing");
    } finally {
      rmSync(b, { recursive: true, force: true });
      rmSync(c, { recursive: true, force: true });
    }
  });

  it("a MISSING hash is unknown, never a disagreement", async () => {
    // Absent evidence cannot establish that two copies differ.
    const b = mkdtempSync(join(tmpdir(), "t432-3d-"));
    try {
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      const save = root; root = b;
      mkdirSync(join(b, ".story", "sessions"), { recursive: true });
      seedArtifact("shared", { target: "T-1", body: JSON.stringify({
        target: "T-1", stage: "code", round: 1, reviewer: "codex", verdict: "approve",
        findingsCount: 0, severityCounts: { critical: 0 }, findings: [],
        timestamp: "2026-09-05T00:00:01.000Z",
      }) });
      root = save;

      const r = await scanRoots([root, b]);
      const o = r.overlaps[0]!;
      expect(o.unknownFiles).toBe(1);
      expect(o.differingFiles).toBe(0);
      expect(o.agreement).toBe("unknown");
    } finally { rmSync(b, { recursive: true, force: true }); }
  });

  it("no pairwise shared filename is `no-shared-files`", async () => {
    const b = mkdtempSync(join(tmpdir(), "t432-3e-"));
    try {
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      seedIn(b, "shared", { target: "T-2", hash: "bbb" });
      const r = await scanRoots([root, b]);
      expect(r.overlaps[0]!.agreement).toBe("no-shared-files");
      expect(r.overlaps[0]!.sharedFiles).toBe(0);
    } finally { rmSync(b, { recursive: true, force: true }); }
  });
});

describe("evidence is not lost, and not overstated", () => {
  it("known hashes establish DIFFERING even beside a missing one", () => {
    // With ["aaa", "bbb", null] the two known hashes already establish that
    // these copies differ. The third being unreadable cannot invalidate that.
    const a = mkdtempSync(join(tmpdir(), "t432-ev-a-"));
    const b = mkdtempSync(join(tmpdir(), "t432-ev-b-"));
    const c = mkdtempSync(join(tmpdir(), "t432-ev-c-"));
    const save = root;
    return (async () => {
      try {
        for (const [dir, hash] of [[a, "aaa"], [b, "bbb"]] as const) {
          root = dir;
          mkdirSync(join(dir, ".story", "sessions"), { recursive: true });
          seedArtifact("shared", { target: "T-1", hash });
        }
        root = c;
        mkdirSync(join(c, ".story", "sessions"), { recursive: true });
        seedArtifact("shared", { target: "T-1", body: JSON.stringify({
          target: "T-1", stage: "code", round: 1, reviewer: "codex", verdict: "approve",
          findingsCount: 0, severityCounts: { critical: 0 }, findings: [],
          timestamp: "2026-09-05T00:00:01.000Z",
        }) });
        root = save;

        const r = await scanRoots([a, b, c]);
        const o = r.overlaps[0]!;
        expect(o.differingFiles).toBe(1);
        expect(o.unknownFiles).toBe(1);
        // Established disagreement is stronger than an unread copy, so it wins.
        expect(o.agreement).toBe("differing");
      } finally {
        root = save;
        for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
      }
    })();
  });

  it("an UNREADABLE copy still counts as a shared filename", async () => {
    // A filename entering the map only after a successful parse let an
    // unreadable copy vanish, so an observed shared filename could be reported
    // as `no-shared-files`.
    const b = mkdtempSync(join(tmpdir(), "t432-ev-d-"));
    const save = root;
    try {
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      root = b;
      mkdirSync(join(b, ".story", "sessions"), { recursive: true });
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      root = save;
      denyRead(join(b, ".story", "sessions", "shared", "telemetry", "reviews", "T-1-code-r1.json"));

      const r = await scanRoots([root, b]);
      const o = r.overlaps[0]!;
      expect(o.sharedFiles).toBe(1);
      expect(o.agreement).not.toBe("no-shared-files");
      expect(o.unknownFiles).toBe(1);
    } finally {
      root = save;
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("a directory holding a regular FILE named .story is NOT a root", async () => {
    // It was accepted as one, and its sessions listing then failed with ENOTDIR
    // and was reported as an unavailable population -- making otherwise complete
    // fleet statistics conditional over an entry that determinately is not a
    // project.
    const fleet = mkdtempSync(join(tmpdir(), "t432-notroot-"));
    try {
      mkdirSync(join(fleet, "real", ".story", "sessions"), { recursive: true });
      mkdirSync(join(fleet, "fake"), { recursive: true });
      writeFileSync(join(fleet, "fake", ".story"), "not a directory", "utf-8");

      const d = await discoverFleetRoots(fleet);
      expect(d.roots).toEqual([join(fleet, "real")]);
      expect(d.failures).toHaveLength(0);
    } finally { rmSync(fleet, { recursive: true, force: true }); }
  });
});

describe("overlap membership is session IDENTITY, not the artifact map", () => {
  const seedIn = (dir: string, sessionId: string, o: Parameters<typeof seedArtifact>[1]) => {
    const save = root;
    root = dir;
    mkdirSync(join(dir, ".story", "sessions"), { recursive: true });
    seedArtifact(sessionId, o);
    root = save;
  };

  it("a DENIED artifact listing does not erase the sharing that was observed", async () => {
    // Membership came from the hash map, which a root entered only when its
    // reviews directory enumerated. So a session copied into two roots with one
    // listing denied was reported as NO OVERLAP AT ALL: the sharing was
    // withheld because of what could not be read about it, when the session
    // directory existing in both roots is what establishes it.
    const b = mkdtempSync(join(tmpdir(), "t432-ov-a-"));
    const save = root;
    try {
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      seedIn(b, "shared", { target: "T-1", hash: "aaa" });
      denyRead(join(b, ".story", "sessions", "shared", "telemetry", "reviews"));

      const r = await scanRoots([root, b]);
      expect(r.overlaps).toHaveLength(1);
      expect(r.overlaps[0]!.roots).toHaveLength(2);
      expect(r.overlaps[0]!.holdersWithUnreadListing).toBe(1);
      // NOT `no-shared-files`, which asserts an absence: the shared filenames
      // could be exactly the ones this holder could not enumerate.
      expect(r.overlaps[0]!.agreement).toBe("unknown");
    } finally { restoreDenied(); root = save; rmSync(b, { recursive: true, force: true }); }
  });

  it("an ABSENT reviews directory is determinate, so `no-shared-files` stands", async () => {
    // Absent and unreadable are different answers here too. This copy
    // demonstrably holds no artifacts, so finding no shared filename is a fact
    // about the copies rather than about the scan.
    const b = mkdtempSync(join(tmpdir(), "t432-ov-b-"));
    const save = root;
    try {
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      mkdirSync(join(b, ".story", "sessions", "shared"), { recursive: true });

      const r = await scanRoots([root, b]);
      expect(r.overlaps).toHaveLength(1);
      expect(r.overlaps[0]!.holdersWithUnreadListing).toBe(0);
      expect(r.overlaps[0]!.agreement).toBe("no-shared-files");
    } finally { root = save; rmSync(b, { recursive: true, force: true }); }
  });

  it("an unread listing cannot soften an ESTABLISHED disagreement", async () => {
    const b = mkdtempSync(join(tmpdir(), "t432-ov-c-"));
    const c = mkdtempSync(join(tmpdir(), "t432-ov-d-"));
    const save = root;
    try {
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      seedIn(b, "shared", { target: "T-1", hash: "bbb" });
      seedIn(c, "shared", { target: "T-1", hash: "ccc" });
      denyRead(join(c, ".story", "sessions", "shared", "telemetry", "reviews"));

      const r = await scanRoots([root, b, c]);
      const o = r.overlaps[0]!;
      expect(o.roots).toHaveLength(3);
      expect(o.holdersWithUnreadListing).toBe(1);
      expect(o.differingFiles).toBe(1);
      expect(o.agreement).toBe("differing");
    } finally {
      restoreDenied();
      root = save;
      for (const d of [b, c]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("a session whose listing FAILED is not evidence that anything was read", async () => {
    // Membership needs every discovered session, and reading the population's
    // "anything read" test off that same map would report PARTIAL -- which
    // promises a usable numerator -- over a root where no artifact listing
    // enumerated at all.
    seedArtifact("s1");
    denyRead(join(root, ".story", "sessions", "s1", "telemetry", "reviews"));
    const r = await scanRoots([root]);
    expect(r.report.state[`p1:${root}`]).toBe("UNAVAILABLE");
  });

  it("the unread-listing count is on the rendered line, not folded into the label", async () => {
    const b = mkdtempSync(join(tmpdir(), "t432-ov-e-"));
    const save = root;
    try {
      seedArtifact("shared", { target: "T-1", hash: "aaa" });
      seedIn(b, "shared", { target: "T-1", hash: "aaa" });
      denyRead(join(b, ".story", "sessions", "shared", "telemetry", "reviews"));

      const r = await scanRoots([root, b]);
      const out = renderOverlaps(r.overlaps, 2).join("\n");
      // `unknown` says the comparison did not settle; only this says a whole
      // copy's filenames were never enumerated.
      expect(out).toContain("1 of them with an unread artifact listing");
    } finally { restoreDenied(); root = save; rmSync(b, { recursive: true, force: true }); }
  });
});
