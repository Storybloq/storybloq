/**
 * T-450 step 6a: the persisted cancellation transition record.
 *
 * WHAT THESE PIN. The transition record is the durability substrate: it is what
 * a recovering process reads to learn what the crashed one had already done.
 * Every property here exists because getting it wrong produces a FALSE DURABLE
 * RECORD, which is worse than no record at all.
 *
 * Two properties are load-bearing and neither is obvious:
 *
 * 1. THE BOUNDARY IS TOLERANT, THE READER IS STRICT. The record lives inside
 *    `state.json`, and `readSessionDetailed` (session.ts:963) validates the
 *    whole session schema before `handleCancel` is reachable. A strict field
 *    would make a malformed transition kill the LOOKUP, so the fail-closed
 *    fall-through the recovery path is meant to reach would be unreachable
 *    code. The session schema therefore accepts anything in that field.
 *
 *    The reader that classifies it, and the recovery path itself, arrive with
 *    the behavior half of 6a; this commit pins only the boundary. ISS-556 is
 *    the nearest precedent with a deliberately different mechanism: it keeps
 *    the schema strict and recovers afterwards (session.ts:432-462) from one
 *    enumerated corruption by DELETING the bad entries, neither of which
 *    transfers to a record whose whole purpose is to be read back.
 *
 * 2. CONTRADICTIONS ARE UNREPRESENTABLE, NOT MERELY UNWRITTEN. An audit record
 *    is read in isolation, long after anyone remembers what wrote it, so
 *    `ordinary_cancellation` carrying candidate authority must fail to PARSE
 *    rather than rely on no caller ever constructing it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SessionStateSchema,
  CancellationTransitionSchema,
  CancellationAuthoritySchema,
  StashPopOutcomeSchema,
  PersistedLivenessEvidenceSchema,
  PersistedTicketDispositionSchema,
} from "../../src/autonomous/session-types.js";
import { evidenceFingerprint, readOwnerLiveness, type OwnerLivenessSignals } from "../../src/autonomous/liveness.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UUID = "11111111-2222-4333-8444-555555555555";
const SESSION_UUID = "99999999-8888-4777-8666-555555555555";
const ISO = "2026-08-01T12:00:00.000Z";

/**
 * Evidence built BY THE PRODUCTION CODE, not by hand.
 *
 * WHY THIS IS NOT A LITERAL. A handwritten fixture only ever proves that the
 * schema agrees with the fixture, and `satisfies` cannot rescue it here because
 * `tsconfig.json` excludes `test/`, so no gate in this repo type-checks a test
 * file. That is precisely how the first version of this schema modeled
 * `{ root, startedAt }` for a `RegisteredServer` that actually carries
 * `{ pid, identity, registeredAt }`, and the test agreed with the wrong schema
 * rather than with the code.
 *
 * So `readOwnerLiveness` constructs the signals, exactly as production does.
 * If the real shape changes, this fixture changes with it for free, and a
 * schema that no longer mirrors it fails the parse below rather than passing a
 * private agreement between two things I wrote.
 */
let EVIDENCE: OwnerLivenessSignals;
let evidenceRoot: string;

beforeAll(() => {
  evidenceRoot = mkdtempSync(join(tmpdir(), "sb-evidence-"));
  EVIDENCE = realEvidence(evidenceRoot);
});

afterAll(() => {
  rmSync(evidenceRoot, { recursive: true, force: true });
});

function realEvidence(sessionDir: string, successorBoundAt = ISO): OwnerLivenessSignals {
  const verdict = readOwnerLiveness(
    sessionDir,
    () => ({
      // Field names read off `OwnableLivenessState` (liveness.ts:1685-1706),
      // not guessed. The first attempt at this fixture invented
      // `lastMcpCall` / `leaseExpiresAt` / `sidecarPid`, and every signal came
      // back `unknown`: a fixture that parses against any schema at all and so
      // proves nothing. The assertion below exists to catch that recurring.
      lastGuideCall: "2026-08-01T11:00:00.000Z",
      mcpGuideCallAt: "2026-08-01T11:00:00.000Z",
      mcpServerPid: 4242,
      lease: { expiresAt: "2026-08-01T11:30:00.000Z" },
      ownerTask: { client: "claude", id: "task-1", boundAt: ISO },
    }),
    Date.parse("2026-08-01T13:00:00.000Z"),
    2_700_000,
    () => ({
      kind: "observed",
      servers: [{ pid: 91, identity: { client: "claude", id: "task-1", boundAt: successorBoundAt }, registeredAt: ISO }],
    }),
  );
  return verdict.signals;
}

function stashPending(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "stash_pending",
    transitionId: UUID,
    action: "ordinary_cancellation",
    authority: { kind: "legacy" },
    disposition: { kind: "released", ticketId: "T-001" },
    sessionId: SESSION_UUID,
    sessionStartedAt: ISO,
    transitionStartedRevision: 7,
    stash: { outcome: null },
    ...over,
  };
}

function published(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...stashPending(),
    phase: "published",
    stash: { outcome: "popped" },
    endedAt: ISO,
    terminalRevision: 9,
    shutdownArtifact: { schemaVersion: 1, filename: "cancellation-shutdown.json" },
    ...over,
  };
}

describe("T-450: the transition record's phase union", () => {
  it("accepts a stash_pending record with a null outcome", () => {
    // The whole point of write 1: the record exists BEFORE the pop is
    // attempted, so a crash during the pop still finds durable intent.
    const parsed = CancellationTransitionSchema.safeParse(stashPending());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("accepts a published record", () => {
    const parsed = CancellationTransitionSchema.safeParse(published());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("rejects endedAt on a stash_pending record", () => {
    // endedAt does not EXIST before publication. A flat record would let a
    // writer set it early and an auditor read a termination time for a
    // session that had not terminated.
    expect(CancellationTransitionSchema.safeParse(stashPending({ endedAt: ISO })).success).toBe(false);
  });

  it("rejects a published record with a null outcome", () => {
    // Publication is the moment the outcome becomes final. `null` means "not
    // yet decided", which cannot be true of a terminal record; the honest
    // terminal value for an unknown pop is `indeterminate`.
    expect(CancellationTransitionSchema.safeParse(published({ stash: { outcome: null } })).success).toBe(false);
  });

  it("requires the identity binding and the provenance anchor on both arms", () => {
    for (const make of [stashPending, published]) {
      for (const field of ["sessionId", "sessionStartedAt", "transitionStartedRevision"]) {
        const rec = make();
        delete rec[field];
        expect(
          CancellationTransitionSchema.safeParse(rec).success,
          `${make === stashPending ? "stash_pending" : "published"} accepted without ${field}`,
        ).toBe(false);
      }
    }
  });

  it("requires sessionStartedAt in the canonical toISOString grammar", () => {
    // A merely parseable timestamp is broader than what the writer emits, and
    // the value is compared for byte equality against session state, so a
    // non-canonical spelling could never match and would strand recovery.
    for (const bad of ["2026-08-01T12:00:00Z", "2026-08-01 12:00:00.000Z", "not-a-time", "2026-08-01T12:00:00+00:00"]) {
      expect(
        CancellationTransitionSchema.safeParse(stashPending({ sessionStartedAt: bad })).success,
        `accepted non-canonical ${bad}`,
      ).toBe(false);
    }
  });
});

describe("T-450: action and authority cannot contradict each other", () => {
  it("rejects ordinary_cancellation carrying candidate authority", () => {
    // THE CROSS-FIELD RULE. Both halves parse alone; the PAIR is the lie, and
    // an audit record is read in isolation where nothing else can catch it.
    const rec = stashPending({
      action: "ordinary_cancellation",
      authority: {
        kind: "candidate",
        clientTaskId: "task-1",
        confirmedSessionRevision: 6,
        confirmedFingerprint: "fp",
        evidence: EVIDENCE,
      },
    });
    expect(CancellationTransitionSchema.safeParse(rec).success).toBe(false);
  });

  it("rejects candidate_recovery_takeover carrying legacy or task authority", () => {
    for (const authority of [{ kind: "legacy" }, { kind: "task", callerTaskId: "task-1" }]) {
      const rec = stashPending({ action: "candidate_recovery_takeover", authority });
      expect(
        CancellationTransitionSchema.safeParse(rec).success,
        `accepted takeover with ${authority.kind} authority`,
      ).toBe(false);
    }
  });

  it("accepts each legitimate pairing", () => {
    const ordinary = [{ kind: "legacy" }, { kind: "task", callerTaskId: "task-1" }];
    for (const authority of ordinary) {
      expect(
        CancellationTransitionSchema.safeParse(stashPending({ authority })).success,
        `rejected ordinary + ${authority.kind}`,
      ).toBe(true);
    }
    const takeover = stashPending({
      action: "candidate_recovery_takeover",
      authority: {
        kind: "candidate",
        clientTaskId: "task-1",
        confirmedSessionRevision: 6,
        confirmedFingerprint: "fp",
        evidence: EVIDENCE,
      },
    });
    const parsed = CancellationTransitionSchema.safeParse(takeover);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  // ISS-967 -------------------------------------------------------------
  it("accepts candidate_recovery_cancellation under candidate authority", () => {
    // The value that was MISSING. Without it the cancel commit stamped the
    // takeover literal into the record of a session it had just ended, and
    // `authority.kind` could not disambiguate because `candidate` is right for
    // both operations.
    const rec = stashPending({
      action: "candidate_recovery_cancellation",
      authority: {
        kind: "candidate",
        clientTaskId: "task-1",
        confirmedSessionRevision: 6,
        confirmedFingerprint: "fp",
        evidence: EVIDENCE,
      },
    });
    const parsed = CancellationTransitionSchema.safeParse(rec);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("rejects candidate_recovery_cancellation carrying legacy or task authority", () => {
    // The cross-field rule needed NO edit to cover the new value, and it
    // enforces BOTH directions: `ordinary_cancellation` may not carry candidate
    // authority, and either candidate action REQUIRES it. This case pins the
    // second direction for the new value; the case above pins the first.
    for (const authority of [{ kind: "legacy" }, { kind: "task", callerTaskId: "task-1" }]) {
      const rec = stashPending({ action: "candidate_recovery_cancellation", authority });
      expect(
        CancellationTransitionSchema.safeParse(rec).success,
        `accepted cancellation with ${authority.kind} authority`,
      ).toBe(false);
    }
  });

  it("names the OFFENDING ACTION in its message rather than one fixed literal", () => {
    // T-450 step 8.1 (H2). The rule fires in two directions and one sentence
    // could not honestly describe both. It used to say
    // "ordinary_cancellation cannot carry candidate authority" for EVERY
    // violation, so a `candidate_recovery_cancellation` record rejected for
    // MISSING candidate authority was told about an action it did not carry
    // and a pairing it did not attempt -- the message pointing away from the
    // defect. This is a validation error read in isolation, which is the same
    // reason the action field exists at all.
    const msgFor = (rec: unknown) => {
      const parsed = CancellationTransitionSchema.safeParse(rec);
      expect(parsed.success).toBe(false);
      return JSON.stringify(parsed.error?.issues ?? []);
    };

    const missingAuthority = msgFor(stashPending({
      action: "candidate_recovery_cancellation",
      authority: { kind: "legacy" },
    }));
    expect(missingAuthority).toContain("candidate_recovery_cancellation requires candidate authority");

    const takeoverMissingAuthority = msgFor(stashPending({
      action: "candidate_recovery_takeover",
      authority: { kind: "legacy" },
    }));
    expect(takeoverMissingAuthority).toContain("candidate_recovery_takeover requires candidate authority");

    // The other direction keeps its own sentence: here the action IS the
    // problem, so naming it as a requirement would be backwards.
    const ordinaryWithCandidate = msgFor(stashPending({
      action: "ordinary_cancellation",
      authority: {
        kind: "candidate",
        clientTaskId: "task-1",
        confirmedSessionRevision: 6,
        confirmedFingerprint: "fp",
        evidence: EVIDENCE,
      },
    }));
    expect(ordinaryWithCandidate).toContain("ordinary_cancellation cannot carry candidate authority");
  });

  it("rejects a task authority with an empty caller id", () => {
    // The arm exists precisely to make `basis: task` + no id unrepresentable.
    expect(CancellationAuthoritySchema.safeParse({ kind: "task", callerTaskId: "" }).success).toBe(false);
  });

  it("rejects unknown authority kinds and extra fields", () => {
    expect(CancellationAuthoritySchema.safeParse({ kind: "owner-gone" }).success).toBe(false);
    expect(CancellationAuthoritySchema.safeParse({ kind: "legacy", callerTaskId: "x" }).success).toBe(false);
  });
});

describe("T-450: the persisted ticket disposition", () => {
  it("accepts the REACHABLE empty-id record", () => {
    // guide.ts:3010 constructs exactly this on the cancel path. A blanket
    // `ticketId: z.string().min(1)` would have refused to record a disposition
    // the shipped code actually produces, so commit B could never have
    // persisted or recovered that characterized case.
    const parsed = PersistedTicketDispositionSchema.safeParse({
      kind: "unchanged", ticketId: "", reason: "empty-id",
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("rejects the two contradictory unchanged records", () => {
    // Splitting by reason is what makes these unrepresentable rather than
    // merely unwritten: an `empty-id` naming a ticket, and a `missing` naming
    // none, each assert something the other field denies.
    expect(PersistedTicketDispositionSchema.safeParse({
      kind: "unchanged", ticketId: "T-001", reason: "empty-id",
    }).success).toBe(false);
    expect(PersistedTicketDispositionSchema.safeParse({
      kind: "unchanged", ticketId: "", reason: "missing",
    }).success).toBe(false);
  });

  it("accepts every other reachable disposition kind", () => {
    for (const d of [
      { kind: "not-authorized" },
      { kind: "no-ticket" },
      { kind: "released", ticketId: "T-001" },
      { kind: "conflict", ticketId: "T-001" },
      { kind: "unchanged", ticketId: "T-001", reason: "not-inprogress" },
      { kind: "failed", ticketId: "T-001" },
    ]) {
      const parsed = PersistedTicketDispositionSchema.safeParse(d);
      expect(parsed.success, `${d.kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});

describe("T-450: the stash outcome vocabulary", () => {
  it("names all four outcomes and nothing else", () => {
    for (const ok of ["popped", "failed", "none", "indeterminate"]) {
      expect(StashPopOutcomeSchema.safeParse(ok).success, `rejected ${ok}`).toBe(true);
    }
    // `unknown` is the tempting fifth spelling and must not exist alongside
    // `indeterminate`: two names for one state is how audit records start
    // disagreeing with each other.
    for (const bad of ["unknown", "ok", "true", ""]) {
      expect(StashPopOutcomeSchema.safeParse(bad).success, `accepted ${bad}`).toBe(false);
    }
  });
});

describe("T-450: persisted liveness evidence mirrors the real signal unions", () => {
  it("the fixture is NON-DEGENERATE, so everything below means something", () => {
    // A fixture whose every signal is `unknown` would parse against almost any
    // schema, including the wrong one this test exists to catch. These
    // assertions fail loudly if the state source ever stops feeding the
    // producer real values, which already happened once.
    expect(EVIDENCE.activity.kind, "activity degraded to unknown").not.toBe("unknown");
    expect(EVIDENCE.lease.kind, "lease degraded to unknown").not.toBe("unknown");
    expect(EVIDENCE.markerValidity.kind, "markerValidity degraded to unknown").not.toBe("unknown");
    expect(EVIDENCE.successors.kind).toBe("observed");
  });

  it("accepts a successor identity whose display-only boundAt is empty", () => {
    // PRODUCTION-VALID, and it nearly did not parse. The registry normalizer
    // (mcp-registry.ts:190) yields `boundAt: ""` when the stored entry omits
    // that field, while succession is decided by client and id alone, so the
    // identity is entirely valid. A `.min(1)` here would have made the schema
    // reject evidence the producer legitimately emits, and only in the
    // uncommon case: exactly the kind of defect that surfaces in the field
    // rather than in a fixture.
    const evidence = realEvidence(evidenceRoot, "");
    const parsed = PersistedLivenessEvidenceSchema.safeParse(evidence);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const reloaded = PersistedLivenessEvidenceSchema.parse(
      JSON.parse(JSON.stringify(evidence)),
    ) as OwnerLivenessSignals;
    expect(evidenceFingerprint(reloaded)).toBe(evidenceFingerprint(evidence));
  });

  it("accepts an evidence projection built from the live signal shapes", () => {
    const parsed = PersistedLivenessEvidenceSchema.safeParse(EVIDENCE);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("survives a persist/reload round trip with an UNCHANGED fingerprint", () => {
    // THE POINT OF MODELING THE REAL UNIONS. `evidenceFingerprint` digests
    // specific VALUES (the stored timestamp, the expiry, the recorded pid), so
    // a lossy projection would parse happily and then re-derive a DIFFERENT
    // fingerprint, and 6b's confirmation check would reject every legitimate
    // confirmation while nothing had actually changed.
    //
    // Executed rather than argued (L-039): the schema round trip is run and
    // the real hashing function is applied to both sides.
    const before = evidenceFingerprint(EVIDENCE);
    const reloaded = PersistedLivenessEvidenceSchema.parse(JSON.parse(JSON.stringify(EVIDENCE))) as OwnerLivenessSignals;
    const after = evidenceFingerprint(reloaded);
    expect(after).toBe(before);
  });

  it("NEGATIVE CONTROL: the fingerprint is sensitive to the fields modeled here", () => {
    // Without this, the round-trip test above could pass vacuously: two
    // fingerprints of the same bytes match no matter how little the function
    // actually reads. Changing values the digest is documented to consume must
    // MOVE the fingerprint, which is what makes "unchanged after reload" mean
    // something.
    const baseline = evidenceFingerprint(EVIDENCE);
    const variants: OwnerLivenessSignals[] = [
      { ...EVIDENCE, markerValidity: { kind: "not-invalidated", pid: 5555, recordedAt: ISO } },
      { ...EVIDENCE, lease: { kind: "expired", expiresAt: "2026-08-02T12:00:00.000Z", agoMs: 1_800_000 } },
      { ...EVIDENCE, sidecarProbe: { kind: "absent", pid: 9999 } },
      // The successor IDENTITY is the load-bearing field of the whole record,
      // so a fingerprint blind to it would be worse than one blind to any
      // other: succession is decided by identity.
      {
        ...EVIDENCE,
        successors: {
          kind: "observed",
          servers: [{ pid: 91, identity: { client: "codex", id: "task-2", boundAt: ISO }, registeredAt: ISO }],
        },
      },
      {
        ...EVIDENCE,
        successors: {
          kind: "observed",
          servers: [{ pid: 91, identity: null, registeredAt: ISO }],
        },
      },
    ];
    for (const [i, v] of variants.entries()) {
      expect(
        evidenceFingerprint(v),
        `variant ${i} did not move the fingerprint, so the round-trip test proves nothing about that field`,
      ).not.toBe(baseline);
    }
  });

  it("rejects a successor entry with no identity key at all", () => {
    // `null` identity means "unattributable", which is a real observation.
    // A MISSING key means the persister dropped it, and the two must not be
    // confused: one resolves to undetermined, the other silently loses the
    // field succession is decided by.
    expect(PersistedLivenessEvidenceSchema.safeParse({
      ...EVIDENCE,
      successors: { kind: "observed", servers: [{ pid: 91, registeredAt: ISO }] },
    }).success).toBe(false);
  });

  it("rejects a foreign field rather than carrying an unvalidated claim", () => {
    const tampered = { ...EVIDENCE, sidecarProbe: { kind: "match", pid: 42, trustMe: true } };
    expect(PersistedLivenessEvidenceSchema.safeParse(tampered).success).toBe(false);
  });

  it("rejects signal arms that contradict their own discriminator", () => {
    // `match` carries a pid; the `unknown` arm is the only one that may have
    // none. Accepting a pidless match would persist a probe result that claims
    // an identity it never established.
    expect(PersistedLivenessEvidenceSchema.safeParse({
      ...EVIDENCE, sidecarProbe: { kind: "match" },
    }).success).toBe(false);
    expect(PersistedLivenessEvidenceSchema.safeParse({
      ...EVIDENCE, lease: { kind: "live", expiresAt: ISO },
    }).success).toBe(false);
  });

  it("bounds the successor list rather than accepting an unbounded array", () => {
    expect(PersistedLivenessEvidenceSchema.safeParse({
      ...EVIDENCE,
      successors: { kind: "observed", servers: Array.from({ length: 200 }, (_, i) => ({ pid: i })) },
    }).success).toBe(false);
  });
});

describe("T-450: the session-schema boundary stays tolerant", () => {
  const base = {
    schemaVersion: 1,
    sessionId: "11111111-2222-4333-8444-555555555555",
    recipe: "coding",
    state: "IMPLEMENT",
    revision: 3,
    startedAt: ISO,
    lease: { workspaceId: "w", lastHeartbeat: ISO, expiresAt: ISO },
  };

  it("parses a session whose cancellationTransition is garbage", () => {
    // THE LOAD-BEARING ONE. If this field were strict, a malformed transition
    // would make `readSessionDetailed` report a corrupt session, `handleCancel`
    // would never run, and the fail-closed fall-through the recovery design
    // promises would be dead code. Garbage in this field must cost the LOOKUP
    // nothing; only the dedicated reader gets to have an opinion.
    for (const garbage of ["not-an-object", 42, [], { phase: "nonsense" }, null]) {
      const parsed = SessionStateSchema.safeParse({ ...base, cancellationTransition: garbage });
      expect(parsed.success, `lookup rejected a session over ${JSON.stringify(garbage)}`).toBe(true);
    }
  });

  it("parses a session with no cancellationTransition at all", () => {
    expect(SessionStateSchema.safeParse(base).success).toBe(true);
  });
});
