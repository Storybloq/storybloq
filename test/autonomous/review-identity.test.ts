/**
 * T-488 Run A: the identity and provenance spine, unit level.
 *
 * These tests cover the decisions that are cheap to get wrong and expensive to
 * discover: a configured pin recorded as an observed execution, a stale
 * implementer attached to the next item's first round, an attempt id reused
 * across two different work items. Each of those writes a record that reads as
 * a fact and is not one, and no later fix can repair the records already
 * written -- which is the argument the ticket is built on.
 *
 * Join-quality derivation lives in `join-availability.test.ts` and deliberately
 * NOT here: an earlier draft had both files asserting the session-scoped case,
 * and two copies of one rule is how the rule comes to have two meanings.
 */
import { describe, it, expect } from "vitest";
import {
  SEVERITY_NORMALIZER_VERSION,
  UNKNOWN_PROVENANCE,
  attemptMatchesSubject,
  backendRunIdentity,
  evidenceFromBackendLabel,
  implementerForRound,
  implementerProvenanceFromReport,
  isPayloadConsistent,
  newItemAttempt,
  normalizeBackend,
  normalizeFindings,
  resolveItemAttempt,
  reviewPayloadFingerprint,
  reviewerProvenanceFromReport,
  upsertReviewRecord,
  type ItemAttempt,
} from "../../src/autonomous/review-identity.js";

const NOW = "2026-09-05T12:00:00.000Z";

describe("normalizeBackend", () => {
  it("names the single backends", () => {
    expect(normalizeBackend("codex")).toBe("codex");
    expect(normalizeBackend("lenses")).toBe("lenses");
    expect(normalizeBackend("agent")).toBe("agent");
  });

  it("reports a genuinely dual round as mixed, not as one of its halves", () => {
    // Real fleet value. Recording this as "codex" would attribute the whole
    // round to half of what ran, and recording it as "agent" would do the same
    // in the other direction.
    expect(normalizeBackend("codex + adversarial Opus agent (dual)")).toBe("mixed");
  });

  it("does not let an incidental 'agent' outvote an explicit backend name", () => {
    // Also a real fleet value. "20 agents" describes the lens fan-out, not a
    // second backend, so this is a lens round and nothing else.
    expect(
      normalizeBackend("workflow: 6-lens adversarial plan review (20 agents, refutation-verified)"),
    ).toBe("lenses");
  });

  it("records an unrecognized reviewer AS unrecognized rather than bucketing it", () => {
    expect(normalizeBackend("some-new-reviewer-2027")).toBe("other");
    expect(normalizeBackend("")).toBe("other");
    expect(normalizeBackend(undefined)).toBe("other");
  });

  it("is case-insensitive, because the free-text field is not normalized", () => {
    expect(normalizeBackend("Codex")).toBe("codex");
    expect(normalizeBackend("LENSES")).toBe("lenses");
  });
});

describe("provenance: evidence is never observed from a pin", () => {
  it("records a supplied model as configured when nothing said it was observed", () => {
    const p = reviewerProvenanceFromReport({ reviewerModel: "gpt-6-astra" });
    expect(p.model).toBe("gpt-6-astra");
    expect(p.evidence).toBe("configured");
  });

  it("leaves SOURCE unknown when the caller named a model but not how it was chosen", () => {
    // Two different questions. The model is known; how it came to be the model
    // is not, and answering the second from the first would record an unpinned
    // session default as a deliberate pin. That inflates exactly the count a
    // reader would use to ask whether pinning changes outcomes.
    const p = reviewerProvenanceFromReport({ reviewerModel: "gpt-6-astra" });
    expect(p.source).toBe("unknown");
    expect(p.source).not.toBe("explicit-pin");
    // An unknown source and a configured evidence coexist: the model was
    // configured somewhere, and nobody said by whom or why.
    expect(p.evidence).toBe("configured");
  });

  it("records the source the caller DID state, either way", () => {
    expect(reviewerProvenanceFromReport({
      reviewerModel: "gpt-6-astra", reviewerSource: "explicit-pin",
    }).source).toBe("explicit-pin");
    expect(reviewerProvenanceFromReport({
      reviewerModel: "gpt-6-astra", reviewerSource: "session-default",
    }).source).toBe("session-default");
    // And an unrecognized one is not promoted to either.
    expect(reviewerProvenanceFromReport({
      reviewerModel: "gpt-6-astra", reviewerSource: "whatever-2027",
    }).source).toBe("unknown");
  });

  it("records observed ONLY when the caller says the backend reported it", () => {
    const p = reviewerProvenanceFromReport({ reviewerModel: "gpt-6-astra", reviewerEvidence: "observed" });
    expect(p.evidence).toBe("observed");
  });

  it("refuses to promote a bad evidence value to observed", () => {
    // A typo, a newer vocabulary, a hostile caller: anything that is not
    // exactly "observed" falls back to the weaker claim, never the stronger.
    const p = reviewerProvenanceFromReport({
      reviewerModel: "m", reviewerEvidence: "OBSERVED" as unknown as string,
    });
    expect(p.evidence).toBe("configured");
  });

  it("records nothing known as unknown/none rather than inventing a model", () => {
    expect(reviewerProvenanceFromReport({})).toEqual(UNKNOWN_PROVENANCE);
    expect(UNKNOWN_PROVENANCE).toEqual({ source: "unknown", evidence: "none" });
    expect(UNKNOWN_PROVENANCE.model).toBeUndefined();
  });

  it("keeps a declared session-default from being written down as an explicit pin", () => {
    // The failure this closes: a dispatcher reporting the tier it INHERITED,
    // recorded as a tier someone chose. That is a fabricated decision.
    const p = reviewerProvenanceFromReport({ reviewerTier: "hands", reviewerSource: "session-default" });
    expect(p.source).toBe("session-default");
  });

  it("applies the identical rules on the implementer side", () => {
    expect(implementerProvenanceFromReport({})).toEqual(UNKNOWN_PROVENANCE);
    expect(implementerProvenanceFromReport({ implementerModel: "m" }).evidence).toBe("configured");
    expect(
      implementerProvenanceFromReport({ implementerModel: "m", implementerEvidence: "observed" }).evidence,
    ).toBe("observed");
  });
});

describe("evidenceFromBackendLabel", () => {
  it("maps the bridge's own labels rather than inventing a parallel vocabulary", () => {
    // codex-claude-bridge emits these two at orchestrator.ts:337 -- a runtime
    // session record for what ran, a bridge selection for what was chosen.
    expect(evidenceFromBackendLabel("runtime_session_record")).toBe("observed");
    expect(evidenceFromBackendLabel("bridge_selection")).toBe("configured");
  });

  it("reads an unknown or absent label as no evidence at all", () => {
    expect(evidenceFromBackendLabel("something_else")).toBe("none");
    expect(evidenceFromBackendLabel(undefined)).toBe("none");
  });
});

describe("implementerForRound: stale attribution is impossible, not merely unlikely", () => {
  const attemptA = "attempt-a";
  const attemptB = "attempt-b";
  const storedForA = { itemAttemptId: attemptA, model: "sonnet-5", source: "explicit-pin", evidence: "configured" } as const;

  it("returns the provenance when it belongs to this round's attempt", () => {
    expect(implementerForRound(storedForA, attemptA)).toEqual({
      model: "sonnet-5", source: "explicit-pin", evidence: "configured",
    });
  });

  it("refuses item A's implementer for item B's round", () => {
    // The concrete case: item A completes, item B is picked, and B's
    // PLAN_REVIEW runs BEFORE B's first IMPLEMENT. A session-level field would
    // still hold A's model at that instant. `maxTicketsPerSession` reaches 5,
    // so this is an ordinary path and not an edge case.
    expect(implementerForRound(storedForA, attemptB)).toEqual(UNKNOWN_PROVENANCE);
  });

  it("refuses when the round has no attempt of its own to match against", () => {
    expect(implementerForRound(storedForA, undefined)).toEqual(UNKNOWN_PROVENANCE);
    expect(implementerForRound(storedForA, null)).toEqual(UNKNOWN_PROVENANCE);
  });

  it("returns unknown when nothing is stored, rather than throwing", () => {
    expect(implementerForRound(null, attemptA)).toEqual(UNKNOWN_PROVENANCE);
  });

  it("strips the binding so it cannot leak into the record as data", () => {
    const out = implementerForRound(storedForA, attemptA) as Record<string, unknown>;
    expect(out.itemAttemptId).toBeUndefined();
  });
});

describe("item attempts", () => {
  it("mints without a generation, because nothing has looked at the directory yet", () => {
    const a = newItemAttempt({ workItemId: "T-001", kind: "ticket" }, NOW);
    expect(a.generation).toBeUndefined();
    expect(a.workItemId).toBe("T-001");
    expect(a.kind).toBe("ticket");
    expect(a.startedAt).toBe(NOW);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints distinct ids", () => {
    const a = newItemAttempt({ workItemId: "T-001", kind: "ticket" }, NOW);
    const b = newItemAttempt({ workItemId: "T-001", kind: "ticket" }, NOW);
    expect(a.id).not.toBe(b.id);
  });

  it("reuses a stored attempt whose subject matches", () => {
    const stored: ItemAttempt = { id: "x", workItemId: "T-001", kind: "ticket", startedAt: NOW, generation: 2 };
    const { attempt, changed } = resolveItemAttempt(stored, { workItemId: "T-001", kind: "ticket" }, NOW);
    expect(changed).toBe(false);
    expect(attempt).toBe(stored);
    expect(attempt?.generation).toBe(2);
  });

  it("replaces a stored attempt whose subject does not match, never reusing it", () => {
    // A mismatch is not a smaller match. Reusing the id would attach this
    // round to the wrong work, which is worse than having no id at all.
    const stored: ItemAttempt = { id: "x", workItemId: "T-001", kind: "ticket", startedAt: NOW };
    const { attempt, changed } = resolveItemAttempt(stored, { workItemId: "T-002", kind: "ticket" }, NOW);
    expect(changed).toBe(true);
    expect(attempt?.id).not.toBe("x");
    expect(attempt?.workItemId).toBe("T-002");
  });

  it("treats the same id under a different KIND as a different subject", () => {
    // Ticket and issue id spaces are distinct but not provably disjoint, and
    // the pair is the identity everywhere else in this schema.
    const stored: ItemAttempt = { id: "x", workItemId: "X-1", kind: "ticket", startedAt: NOW };
    expect(attemptMatchesSubject(stored, { workItemId: "X-1", kind: "issue" })).toBe(false);
    expect(resolveItemAttempt(stored, { workItemId: "X-1", kind: "issue" }, NOW).changed).toBe(true);
  });

  it("establishes one lazily when a session resumed past acquisition with none", () => {
    const { attempt, changed } = resolveItemAttempt(null, { workItemId: "T-001", kind: "ticket" }, NOW);
    expect(changed).toBe(true);
    expect(attempt?.workItemId).toBe("T-001");
    expect(attempt?.generation).toBeUndefined();
  });

  it("yields no attempt when there is no subject, rather than one keyed on nothing", () => {
    expect(resolveItemAttempt(null, null, NOW).attempt).toBeNull();
    const stored: ItemAttempt = { id: "x", workItemId: "T-001", kind: "ticket", startedAt: NOW };
    const out = resolveItemAttempt(stored, null, NOW);
    expect(out.attempt).toBeNull();
    expect(out.changed).toBe(true);
  });
});

describe("isPayloadConsistent", () => {
  const open = (severity: string) => ({ severity, disposition: "open" });

  it("is false for a change-request carrying nothing to act on", () => {
    expect(isPayloadConsistent("revise", [])).toBe(false);
    expect(isPayloadConsistent("request_changes", [])).toBe(false);
  });

  it("is true for a change-request that names something", () => {
    expect(isPayloadConsistent("revise", [open("minor")])).toBe(true);
  });

  it("is false for an approve carrying an unresolved blocker", () => {
    expect(isPayloadConsistent("approve", [open("critical")])).toBe(false);
    expect(isPayloadConsistent("approve", [open("major")])).toBe(false);
  });

  it("is true for an approve whose blockers were addressed or deferred", () => {
    expect(isPayloadConsistent("approve", [{ severity: "critical", disposition: "addressed" }])).toBe(true);
    expect(isPayloadConsistent("approve", [{ severity: "major", disposition: "deferred" }])).toBe(true);
  });

  it("leaves a minor finding on an approve alone", () => {
    expect(isPayloadConsistent("approve", [open("minor")])).toBe(true);
    expect(isPayloadConsistent("approve", [open("suggestion")])).toBe(true);
  });

  it("does not judge a reject, which is not a payload contradiction", () => {
    expect(isPayloadConsistent("reject", [])).toBe(true);
  });
});

describe("normalizeFindings", () => {
  it("records the raw severity beside the normalized one", () => {
    const out = normalizeFindings([{ severity: "BLOCKING", category: "c", description: "d", disposition: "open" }]);
    expect(out[0]!.severity).toBe("critical");
    expect(out[0]!.rawSeverity).toBe("BLOCKING");
  });

  it("preserves the raw value for a severity the normalizer passes straight through", () => {
    // This is why the field is worth having. `high` is not in the declared
    // enum and is not remapped, so it reaches the artifact as `severity:
    // "high"` -- and without a raw copy a reader cannot tell that from a value
    // the normalizer produced.
    const out = normalizeFindings([{ severity: "high", category: "c", description: "d", disposition: "open" }]);
    expect(out[0]!.severity).toBe("high");
    expect(out[0]!.rawSeverity).toBe("high");
  });

  it("does not re-derive an already-recorded raw severity", () => {
    // A replay reconstructs a round from its envelope, whose findings are
    // already normalized. Re-deriving would record the normalized value as the
    // reviewer's own word.
    const out = normalizeFindings([
      { severity: "critical", rawSeverity: "blocking", category: "c", description: "d", disposition: "open" },
    ]);
    expect(out[0]!.rawSeverity).toBe("blocking");
  });

  it("pins the normalizer version to today's behavior exactly", () => {
    // Version 1 trims, lowercases and maps `blocking`. Remapping `high` to
    // `major` would change WHAT BLOCKS a review, which is a gate decision and
    // belongs to a version 2 owned by whoever owns the gate.
    expect(SEVERITY_NORMALIZER_VERSION).toBe(1);
    const out = normalizeFindings([{ severity: "high", category: "c", description: "d", disposition: "open" }]);
    expect(out[0]!.severity).not.toBe("major");
  });
});

describe("backendRunIdentity", () => {
  it("takes codex's thread id from the field the report already carries", () => {
    expect(backendRunIdentity("codex", { reviewerSessionId: "sess-1" }))
      .toEqual({ backendRunId: "sess-1", backendRunIdKind: "codex-session" });
  });

  it("takes the lens review id for a lens round", () => {
    expect(backendRunIdentity("lenses", { reviewId: "rev-1" }))
      .toEqual({ backendRunId: "rev-1", backendRunIdKind: "lens-review" });
  });

  it("records nothing for an agent round, because nothing survives to here", () => {
    expect(backendRunIdentity("agent", { reviewerSessionId: "sess-1" })).toEqual({});
  });

  it("records nothing for a mixed round rather than one backend's id", () => {
    // Two backends ran; a single run id would attribute the round to one.
    expect(backendRunIdentity("mixed", { reviewerSessionId: "sess-1", reviewId: "rev-1" })).toEqual({});
  });

  it("records nothing when the id the backend would carry is absent", () => {
    expect(backendRunIdentity("codex", {})).toEqual({});
    expect(backendRunIdentity("lenses", {})).toEqual({});
  });
});

describe("reviewPayloadFingerprint", () => {
  const base = {
    stage: "code", workItemId: "T-001", kind: "ticket", verdict: "revise",
    reviewer: "codex", summary: "notes", findings: [{ severity: "major" }],
  };

  it("is stable for the same payload", () => {
    expect(reviewPayloadFingerprint(base)).toBe(reviewPayloadFingerprint(base));
  });

  it("changes when the summary changes", () => {
    // `summary` comes from free-text notes and reaches the artifact, so a
    // fingerprint blind to it would call two different artifacts one round.
    expect(reviewPayloadFingerprint({ ...base, summary: "other" })).not.toBe(reviewPayloadFingerprint(base));
  });

  it("changes when the verdict, findings, subject or stage change", () => {
    expect(reviewPayloadFingerprint({ ...base, verdict: "approve" })).not.toBe(reviewPayloadFingerprint(base));
    expect(reviewPayloadFingerprint({ ...base, findings: [] })).not.toBe(reviewPayloadFingerprint(base));
    expect(reviewPayloadFingerprint({ ...base, workItemId: "T-002" })).not.toBe(reviewPayloadFingerprint(base));
    expect(reviewPayloadFingerprint({ ...base, kind: "issue" })).not.toBe(reviewPayloadFingerprint(base));
    expect(reviewPayloadFingerprint({ ...base, stage: "plan" })).not.toBe(reviewPayloadFingerprint(base));
  });

  it("distinguishes an absent subject from one that is present", () => {
    const { workItemId: _w, kind: _k, ...noSubject } = base;
    expect(reviewPayloadFingerprint(noSubject)).not.toBe(reviewPayloadFingerprint(base));
  });
});

describe("upsertReviewRecord", () => {
  it("appends a round that is not already recorded", () => {
    const out = upsertReviewRecord([{ reviewAttemptId: "a" }], { reviewAttemptId: "b" });
    expect(out.map((r) => r.reviewAttemptId)).toEqual(["a", "b"]);
  });

  it("replaces in place rather than double-counting a replayed round", () => {
    // A double count is not cosmetic: the ceiling fires on the round count, so
    // a duplicate can park an item early.
    const out = upsertReviewRecord(
      [{ reviewAttemptId: "a", round: 1 }, { reviewAttemptId: "b", round: 2 }],
      { reviewAttemptId: "a", round: 1, verdict: "approve" } as { reviewAttemptId?: string },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ reviewAttemptId: "a", verdict: "approve" });
  });

  it("appends a legacy record with no attempt id rather than inventing one to match", () => {
    const out = upsertReviewRecord([{ round: 1 } as { reviewAttemptId?: string }], { round: 2 } as { reviewAttemptId?: string });
    expect(out).toHaveLength(2);
  });

  it("does not mutate the array it was given", () => {
    const original = [{ reviewAttemptId: "a" }];
    upsertReviewRecord(original, { reviewAttemptId: "b" });
    expect(original).toHaveLength(1);
  });
});
