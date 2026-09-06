/**
 * T-488 D3: the generation namespace is a fix for OBSERVED corruption.
 *
 * Mechanism: `roundNum` is `reviews.code.length + 1`, and a PLAN redirect
 * clears that array, so round 1 recurs, `verdictFilename` reproduces an
 * existing path, and `writeReviewVerdict` answers `exists` without writing.
 *
 * The confirmed instance is westworld session `08a52602`, single target T-030:
 * the `code_review` events run 1 through 9, restart, and run 1 through 12 --
 * twenty-one rounds -- while the reviews directory holds exactly twelve
 * artifacts, `T-030-code-r1` through `r12`, with a seven-hour gap between r9
 * and r10 marking the boundary. Nine rounds were dropped, and the twelve
 * survivors are a mixture of two generations under one numbering with nothing
 * on disk saying so.
 *
 * These tests are synthesized rather than replayed from that corpus: the
 * mechanism needs only a directory and a round number, and copying another
 * project's session into this repo would prove nothing extra.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GENERATION_COLLISION_BOUND,
  prepareReviewRound,
  scanForNextGeneration,
  writeRoundArtifact,
  type ItemAttempt,
  type ReviewRoundHost,
  type ReviewRoundIdentity,
} from "../../src/autonomous/review-identity.js";
import { computeContentHash, verdictFilename, type ReviewVerdictArtifact } from "../../src/autonomous/review-verdict.js";

const NOW = "2026-09-05T12:00:00.000Z";

/**
 * The narrowest host a round needs, so the lifecycle is exercised without
 * standing up a session. `writeState` merges the way `StageContext.writeState`
 * does, because half these tests are about what a LATER read sees.
 */
class FakeHost implements ReviewRoundHost {
  state: Record<string, unknown> = {};
  writes: Record<string, unknown>[] = [];
  constructor(readonly dir: string, initial: Record<string, unknown> = {}) {
    this.state = { ...initial };
  }
  writeState(updates: Record<string, unknown>): unknown {
    this.writes.push(updates);
    this.state = { ...this.state, ...updates };
    return this.state;
  }
}

function reviewsDirOf(sessionDir: string): string {
  return join(sessionDir, "telemetry", "reviews");
}

/**
 * Seeds an artifact with a CORRECT `_contentHash` unless the caller supplies
 * one deliberately. An artifact whose stored hash does not match its bytes is a
 * damaged artifact, and it must be possible to write one on purpose (the
 * tamper test below) without every other test accidentally writing one.
 */
function seedArtifact(
  sessionDir: string,
  name: string,
  payload: Partial<ReviewVerdictArtifact> & Record<string, unknown> = {},
): void {
  const dir = reviewsDirOf(sessionDir);
  mkdirSync(dir, { recursive: true });
  const { _contentHash: override, ...rest } = payload;
  const artifact = {
    target: "T-001", stage: "code", round: 1, reviewer: "codex", verdict: "approve",
    findingsCount: 0, severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    startedAt: NOW, durationMs: 1, summary: "seeded", findings: [], timestamp: NOW,
    ...rest,
  } as unknown as ReviewVerdictArtifact;
  writeFileSync(join(dir, name), JSON.stringify({
    ...artifact,
    _contentHash: override ?? computeContentHash(artifact),
  }, null, 2));
}

function names(sessionDir: string): string[] {
  try {
    return readdirSync(reviewsDirOf(sessionDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function makeArtifactBuilder(round: number, target = "T-001") {
  return (identity: ReviewRoundIdentity): ReviewVerdictArtifact => ({
    target, stage: "code", round, reviewer: "codex", verdict: "approve",
    findingsCount: 0, severityCounts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    startedAt: NOW, durationMs: 1, summary: "round", findings: [], timestamp: NOW,
    workItemId: identity.workItemId,
    kind: identity.kind,
    reviewAttemptId: identity.reviewAttemptId,
    itemAttemptId: identity.itemAttemptId,
    generation: identity.generation,
  });
}

function identityFor(overrides: Partial<ReviewRoundIdentity> = {}): ReviewRoundIdentity {
  return {
    workItemId: "T-001", kind: "ticket",
    reviewAttemptId: "attempt-1", itemAttemptId: "item-1",
    backend: "codex", normalizerVersion: 1, generation: 0, payloadConsistent: true,
    reviewerIdentity: { source: "unknown", evidence: "none" },
    implementer: { source: "unknown", evidence: "none" },
    ...overrides,
  };
}

describe("scanForNextGeneration", () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), "t488-gen-")); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  it("is 0 when no artifacts exist, which is the ordinary first round", () => {
    expect(scanForNextGeneration(reviewsDirOf(sessionDir), "T-001", "code")).toBe(0);
  });

  it("is 0 when the reviews directory does not exist at all", () => {
    expect(scanForNextGeneration(join(sessionDir, "nope"), "T-001", "code")).toBe(0);
  });

  it("is 1 when unsuffixed artifacts already exist for this target and stage", () => {
    seedArtifact(sessionDir, "T-001-code-r1.json");
    seedArtifact(sessionDir, "T-001-code-r2.json");
    expect(scanForNextGeneration(reviewsDirOf(sessionDir), "T-001", "code")).toBe(1);
  });

  it("clears the HIGHEST existing generation rather than assuming there is one", () => {
    seedArtifact(sessionDir, "T-001-code-r1.json");
    seedArtifact(sessionDir, "T-001-code-r1-g1.json");
    seedArtifact(sessionDir, "T-001-code-r3-g2.json");
    expect(scanForNextGeneration(reviewsDirOf(sessionDir), "T-001", "code")).toBe(3);
  });

  it("is scoped to the target, so another item's rounds do not advance this one", () => {
    seedArtifact(sessionDir, "T-999-code-r1.json");
    expect(scanForNextGeneration(reviewsDirOf(sessionDir), "T-001", "code")).toBe(0);
  });

  it("is scoped to the stage, so plan rounds do not advance code rounds", () => {
    seedArtifact(sessionDir, "T-001-plan-r1.json");
    expect(scanForNextGeneration(reviewsDirOf(sessionDir), "T-001", "code")).toBe(0);
  });

  it("ignores files that are not verdict artifacts", () => {
    mkdirSync(reviewsDirOf(sessionDir), { recursive: true });
    writeFileSync(join(reviewsDirOf(sessionDir), "notes.md"), "x");
    expect(scanForNextGeneration(reviewsDirOf(sessionDir), "T-001", "code")).toBe(0);
  });
});

describe("generation resolution during a round", () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), "t488-genres-")); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  const prepare = (host: FakeHost, arrayRound: number) => prepareReviewRound(host, {
    stage: "code",
    subject: { workItemId: "T-001", kind: "ticket" },
    target: "T-001",
    verdict: "approve", reviewer: "codex", summary: "s", findings: [],
    arrayRound, report: {}, nowIso: NOW,
  });

  it("AN ORDINARY ROUND 2 STAYS AT GENERATION 0 and does not advance", () => {
    // The over-broad rule an earlier revision had -- "generation is 0 and any
    // artifact exists" -- also describes exactly this: round 2 of a normal
    // attempt, which has just written its own r1 at generation 0. That rule
    // would have advanced the generation with no redirect anywhere. The scan is
    // therefore gated on the generation being UNINITIALIZED, and 0 is not.
    const host = new FakeHost(sessionDir);
    const first = prepare(host, 1);
    expect(first.identity.generation).toBe(0);
    host.writeState({ pendingReviewAttempt: null });
    seedArtifact(sessionDir, "T-001-code-r1.json");

    const second = prepare(host, 2);
    expect(second.identity.generation).toBe(0);
    expect((host.state.itemAttempt as ItemAttempt).generation).toBe(0);
  });

  it("a legacy session whose generation is genuinely ABSENT initializes to 1", () => {
    // A session already in flight when this shipped has artifacts on disk and
    // no attempt at all. Starting it at 0 would reproduce its own filenames.
    seedArtifact(sessionDir, "T-001-code-r1.json");
    seedArtifact(sessionDir, "T-001-code-r2.json");
    const host = new FakeHost(sessionDir);
    const prepared = prepare(host, 1);
    expect(prepared.identity.generation).toBe(1);
  });

  it("persists the resolved generation onto the attempt in the same write as the envelope", () => {
    // One number, two copies, written together. A stale copy is the
    // two-counter disagreement the design rules out.
    const host = new FakeHost(sessionDir);
    const prepared = prepare(host, 1);
    const write = host.writes.at(-1)!;
    expect((write.pendingReviewAttempt as { generation: number }).generation).toBe(prepared.identity.generation);
    expect((write.itemAttempt as ItemAttempt).generation).toBe(prepared.identity.generation);
  });

  it("a round whose own path is FREE still lands in the generation its epoch resolved", () => {
    // Round 1 of a new epoch collides and resolves to g1. Round 2's own path,
    // `T-001-code-r2.json`, is empty -- nothing forces it anywhere. It has to
    // INHERIT the resolved generation from the attempt, or one epoch's rounds
    // are split across two generations and stop reading as a single run.
    //
    // Written as a collision on round 1 ONLY, because a test where every round
    // collides independently passes whether inheritance works or not.
    seedArtifact(sessionDir, "T-001-code-r1.json", { reviewAttemptId: "previous-epoch" });
    const host = new FakeHost(sessionDir, {
      itemAttempt: { id: "item-1", workItemId: "T-001", kind: "ticket", startedAt: NOW, generation: 0 },
    });

    const r1 = prepare(host, 1);
    expect(r1.identity.generation).toBe(0);
    const wrote1 = writeRoundArtifact(host, {
      identity: r1.identity, envelope: r1.envelope,
      attempt: host.state.itemAttempt as ItemAttempt,
      buildArtifact: makeArtifactBuilder(1),
    });
    expect(wrote1.kind === "ok" && wrote1.identity.generation).toBe(1);
    expect((host.state.itemAttempt as ItemAttempt).generation).toBe(1);
    host.writeState({ pendingReviewAttempt: null });

    const r2 = prepare(host, 2);
    expect(r2.identity.generation).toBe(1);
    const wrote2 = writeRoundArtifact(host, {
      identity: r2.identity, envelope: r2.envelope,
      attempt: host.state.itemAttempt as ItemAttempt,
      buildArtifact: makeArtifactBuilder(2),
    });
    expect(wrote2.kind === "ok" && wrote2.artifactStatus).toBe("written");
    expect(names(sessionDir)).toEqual([
      "T-001-code-r1-g1.json", "T-001-code-r1.json", "T-001-code-r2-g1.json",
    ]);
  });

  it("a SUBJECTLESS lineage stays in ONE generation across its rounds", () => {
    // A round with neither a ticket nor a current issue has no attempt, so
    // there is nowhere to persist a resolved generation. Resolving it from the
    // directory each round made round 2 find round 1's artifact and land at 1,
    // and round 3 land at 2: every round of one lineage in its own generation,
    // with no redirect anywhere. A corpus reader applying the documented
    // meaning of the field would read three attempts where there was one.
    const host = new FakeHost(sessionDir);
    const generations: number[] = [];
    for (const round of [1, 2, 3]) {
      const prepared = prepareReviewRound(host, {
        stage: "code", subject: null, target: "unknown",
        verdict: "revise", reviewer: "codex", summary: `round ${round}`,
        findings: [], arrayRound: round, report: {}, nowIso: NOW,
      });
      generations.push(prepared.identity.generation);
      writeRoundArtifact(host, {
        identity: prepared.identity, envelope: prepared.envelope, attempt: null,
        // The SAME target the round resolved against. A builder writing some
        // other target would file the artifacts where the directory scan does
        // not look, and this test would pass without exercising the scan at
        // all -- which is how its first draft passed under the mutant.
        buildArtifact: makeArtifactBuilder(round, "unknown"),
      });
      host.writeState({ pendingReviewAttempt: null });
    }

    expect(generations).toEqual([0, 0, 0]);
    expect(names(sessionDir)).toEqual([
      "unknown-code-r1.json", "unknown-code-r2.json", "unknown-code-r3.json",
    ]);
  });

  it("two DIFFERENT subjectless rounds meeting at one path are still separated by the guard", () => {
    // The reason starting at 0 is safe. Subjectless rounds all share the
    // `unknown` filename stem, so two of them genuinely can collide -- and the
    // artifact sink resolves that the same way it resolves the plan-stage
    // reject, by identity rather than by having pre-allocated a number.
    const hostA = new FakeHost(sessionDir);
    const a = prepareReviewRound(hostA, {
      stage: "code", subject: null, target: "unknown",
      verdict: "revise", reviewer: "codex", summary: "lineage A",
      findings: [], arrayRound: 1, report: {}, nowIso: NOW,
    });
    writeRoundArtifact(hostA, {
      identity: a.identity, envelope: a.envelope, attempt: null,
      buildArtifact: makeArtifactBuilder(1, "unknown"),
    });

    const hostB = new FakeHost(sessionDir);
    const b = prepareReviewRound(hostB, {
      stage: "code", subject: null, target: "unknown",
      verdict: "revise", reviewer: "codex", summary: "lineage B",
      findings: [], arrayRound: 1, report: {}, nowIso: NOW,
    });
    expect(b.identity.generation).toBe(0);
    const wroteB = writeRoundArtifact(hostB, {
      identity: b.identity, envelope: b.envelope, attempt: null,
      buildArtifact: makeArtifactBuilder(1, "unknown"),
    });

    // B is not lost and does not overwrite A.
    expect(wroteB.kind === "ok" && wroteB.artifactStatus).toBe("written");
    expect(wroteB.kind === "ok" && wroteB.identity.generation).toBe(1);
    expect(names(sessionDir)).toEqual(["unknown-code-r1-g1.json", "unknown-code-r1.json"]);
  });

  it("freezes the generation on the envelope BEFORE any sink could change it", () => {
    // Allocation happens first, always: freezing an envelope and letting a
    // later collision guard renumber it would leave a replay using a different
    // generation from the artifact.
    const host = new FakeHost(sessionDir);
    prepare(host, 1);
    expect(host.writes).toHaveLength(1);
    expect(host.state.pendingReviewAttempt).toBeTruthy();
    expect(names(sessionDir)).toEqual([]);
  });
});

describe("writeRoundArtifact: collisions and adoption", () => {
  let sessionDir: string;
  beforeEach(() => { sessionDir = mkdtempSync(join(tmpdir(), "t488-collide-")); });
  afterEach(() => { rmSync(sessionDir, { recursive: true, force: true }); });

  const run = (host: FakeHost, identity: ReviewRoundIdentity, round = 1) => writeRoundArtifact(host, {
    identity,
    envelope: {
      reviewAttemptId: identity.reviewAttemptId, stage: "code", round,
      generation: identity.generation, payloadFingerprint: "fp",
      verdict: "approve", reviewer: "codex", summary: "s", findings: [], decidedAt: NOW,
    },
    attempt: { id: "item-1", workItemId: "T-001", kind: "ticket", startedAt: NOW, generation: identity.generation },
    buildArtifact: makeArtifactBuilder(round),
  });

  it("writes at generation 0 with the original filename", () => {
    const host = new FakeHost(sessionDir);
    const result = run(host, identityFor());
    expect(result.kind).toBe("ok");
    expect(names(sessionDir)).toEqual(["T-001-code-r1.json"]);
  });

  it("ADVANCES the generation when the path is held by a different attempt", () => {
    // The westworld case: generation 2's round 1 meets generation 1's round 1.
    // Before this, `writeReviewVerdict` answered `exists` and the round was
    // silently dropped.
    seedArtifact(sessionDir, "T-001-code-r1.json", { reviewAttemptId: "someone-else", itemAttemptId: "other-item" });
    const host = new FakeHost(sessionDir);
    const result = run(host, identityFor());
    expect(result.kind).toBe("ok");
    expect(names(sessionDir)).toEqual(["T-001-code-r1-g1.json", "T-001-code-r1.json"]);
    expect(result.kind === "ok" && result.identity.generation).toBe(1);
  });

  it("advances past a LEGACY artifact that carries no attempt identity at all", () => {
    // Absence is not a match. Adopting an unidentified artifact would silently
    // give a legacy round this attempt's provenance.
    seedArtifact(sessionDir, "T-001-code-r1.json");
    const host = new FakeHost(sessionDir);
    const result = run(host, identityFor());
    expect(result.kind === "ok" && result.artifactStatus).toBe("written");
    expect(names(sessionDir)).toContain("T-001-code-r1-g1.json");
  });

  it("re-persists BOTH copies of the generation atomically when it advances", () => {
    seedArtifact(sessionDir, "T-001-code-r1.json", { reviewAttemptId: "other" });
    const host = new FakeHost(sessionDir);
    run(host, identityFor());
    const write = host.writes.at(-1)!;
    expect((write.pendingReviewAttempt as { generation: number }).generation).toBe(1);
    expect((write.itemAttempt as ItemAttempt).generation).toBe(1);
  });

  it("ADOPTS an artifact that is this attempt's own, rather than renumbering it", () => {
    // The crash-recovery case: the artifact landed and the state write did not.
    // Renumbering here would write a second copy of one round.
    seedArtifact(sessionDir, "T-001-code-r1.json", {
      reviewAttemptId: "attempt-1", itemAttemptId: "item-1", summary: "the durable one",
    });
    const host = new FakeHost(sessionDir);
    const result = run(host, identityFor());
    expect(result.kind === "ok" && result.artifactStatus).toBe("exists");
    expect(result.kind === "ok" && result.artifact.summary).toBe("the durable one");
    expect(names(sessionDir)).toEqual(["T-001-code-r1.json"]);
  });

  it("refuses to adopt an artifact whose itemAttemptId differs while the round id matches", () => {
    // Half the pair is not a partial match. The pair IS the identity.
    seedArtifact(sessionDir, "T-001-code-r1.json", { reviewAttemptId: "attempt-1", itemAttemptId: "a-different-item" });
    const host = new FakeHost(sessionDir);
    const result = run(host, identityFor());
    expect(result.kind === "ok" && result.artifactStatus).toBe("written");
    expect(names(sessionDir)).toContain("T-001-code-r1-g1.json");
  });

  it("refuses to adopt its OWN artifact when the file no longer matches its hash", () => {
    // Attempt identity says the artifact is ours; the hash says the bytes have
    // changed since it was written. Adopting on identity alone would drop the
    // integrity check the previous `readReviewVerdict` recovery performed, and
    // a truncated or edited artifact would become this round's Tier-1 verdict.
    seedArtifact(sessionDir, "T-001-code-r1.json", {
      reviewAttemptId: "attempt-1", itemAttemptId: "item-1",
      summary: "tampered after the hash was computed",
      _contentHash: "0000000000000000000000000000000000000000000000000000000000000000",
    });
    const host = new FakeHost(sessionDir);
    const result = run(host, identityFor());

    expect(result.kind).toBe("retry");
    // The message names both conditions that reach it, so the assertion pins
    // the one this test actually created rather than the shared prefix.
    expect(result.kind === "retry" && result.instruction).toContain("stored hash missing or content changed");
    // Not renumbered either: this is ours and damaged, not somebody else's.
    expect(names(sessionDir)).toEqual(["T-001-code-r1.json"]);
  });

  it("adopts its own artifact when the bytes DO match their hash", () => {
    // The other half, so the check above cannot pass by rejecting everything.
    const host = new FakeHost(sessionDir);
    const first = run(host, identityFor());
    expect(first.kind === "ok" && first.artifactStatus).toBe("written");

    const second = run(new FakeHost(sessionDir), identityFor());
    expect(second.kind === "ok" && second.artifactStatus).toBe("exists");
  });

  it("bounds the search and fails LOUDLY rather than looping", () => {
    for (let g = 0; g <= GENERATION_COLLISION_BOUND; g++) {
      seedArtifact(sessionDir, verdictFilename("T-001", "code", 1, g), { reviewAttemptId: `other-${g}` });
    }
    const host = new FakeHost(sessionDir);
    const result = run(host, identityFor());
    expect(result.kind).toBe("retry");
    expect(result.kind === "retry" && result.instruction).toContain("generation slots are already occupied");
  });

  it("leaves ONE consistent generation across the envelope, the attempt and the artifact", () => {
    // The interrupted-recovery property. Whatever the collision loop ends on,
    // the three copies agree -- there is no state in which the artifact was
    // written at one generation and the durable record remembers another.
    seedArtifact(sessionDir, "T-001-code-r1.json", { reviewAttemptId: "other-a" });
    seedArtifact(sessionDir, "T-001-code-r1-g1.json", { reviewAttemptId: "other-b" });
    const host = new FakeHost(sessionDir);
    const result = run(host, identityFor());
    expect(result.kind).toBe("ok");
    const generation = result.kind === "ok" ? result.identity.generation : -1;
    expect(generation).toBe(2);
    expect((host.state.itemAttempt as ItemAttempt).generation).toBe(2);
    expect((host.state.pendingReviewAttempt as { generation: number }).generation).toBe(2);
    const written = JSON.parse(
      readFileSync(join(reviewsDirOf(sessionDir), "T-001-code-r1-g2.json"), "utf-8"),
    ) as { generation: number };
    expect(written.generation).toBe(2);
  });

  it("keeps every generation's artifact, so a redirect replay drops nothing", () => {
    // Acceptance 5 in miniature: rounds 1 and 2, a redirect, then rounds 1 and
    // 2 again -- FOUR artifacts, where the pre-fix code kept two.
    //
    // Every round here is handed its generation and every one of them collides,
    // so this pins SURVIVAL only. That a non-colliding round still inherits the
    // epoch's generation is pinned separately above, where round 2's path is
    // free.
    const host = new FakeHost(sessionDir);
    for (const round of [1, 2]) {
      run(host, identityFor({ reviewAttemptId: `g0-r${round}` }), round);
    }
    for (const round of [1, 2]) {
      run(host, identityFor({ reviewAttemptId: `g1-r${round}`, generation: 0 }), round);
    }
    expect(names(sessionDir)).toEqual([
      "T-001-code-r1-g1.json", "T-001-code-r1.json",
      "T-001-code-r2-g1.json", "T-001-code-r2.json",
    ]);
  });
});
