/**
 * T-450 step 4: pending-artifact provenance and the three-outcome table.
 *
 * The table exists because the two predicates it replaces were backwards. A
 * matching PREIMAGE was read as "already applied", though a matching preimage
 * means the write has not happened; and a postimage was authenticated by target
 * and field alone, though the field may hold a third party's identical value.
 * The first silently drops authorized work, the second replays or clears on the
 * strength of someone else's write.
 *
 * Every test here drives the real classifier. It is a pure function over one
 * observation, which is what makes each row reachable directly instead of
 * through a staged crash -- but the observation in the prepare-site tests at the
 * bottom is taken from a REAL issue written by the real stage, so the digest
 * the table compares is the digest the write actually produces.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyPendingMutation,
  asCanonicalTicketIdentities,
  entityFingerprint,
  buildQuarantineRecord,
  canonicalContentFingerprint,
  quarantineEventData,
  issueCreateFingerprint,
  readIssueCreatePayload,
  readProvenance,
  readSnapshot,
  snapshotEquals,
  QUARANTINE_EVENT_TYPE,
  type TargetObservation,
  type RecoveryAuthority,
} from "../../src/autonomous/pending-artifacts.js";
import { resolvePayloadTicketIdentities } from "../../src/autonomous/pending-artifact-resolution.js";
import { markResolvedTicketIdentities } from "../../src/autonomous/resolved-identities.js";
import type {
  FieldSnapshot, FullSessionState, ResolvedTicketIdentities,
} from "../../src/autonomous/session-types.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { PickTicketStage } from "../../src/autonomous/stages/pick-ticket.js";
import { loadProject } from "../../src/core/project-loader.js";
import { displayIdOf } from "../../src/core/resolver.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Authority names the ticket it is held FOR. A test cannot say "held" without
 * saying held over what, which is the point: a bare boolean would let authority
 * legitimately held on one ticket authorize a write aimed at another.
 */
const authFor = (ticket: string): RecoveryAuthority => ({ ticket });
const HOLDS_T1: RecoveryAuthority = authFor("T-001");
const NO_AUTHORITY: RecoveryAuthority = { ticket: null };

const at = (value: string): FieldSnapshot => ({ present: true, value });
const absent: FieldSnapshot = { present: false };

/** An issue mutation is not ticket-scoped, so its provenance names no ticket. */
const PROV = { ownerTask: "task-a", revision: 7, ticket: null };
const PROV_T1 = { ownerTask: "task-a", revision: 7, ticket: "T-001" };

/**
 * An observation taken AT a named identity. The identity is explicit at every
 * call site because the classifier checks it: an observation that silently
 * defaulted to whatever the record said would be checking nothing.
 */
function observeAt(identity: string | null, over: Partial<TargetObservation> = {}): TargetObservation {
  const merged: TargetObservation = {
    exists: identity !== null,
    identity,
    dedupeKey: null,
    dedupeKeyAt: null,
    contentFingerprint: null,
    ...over,
  };
  // `exists` is DERIVED, after the overrides, and can never be set by a caller.
  // A builder that let a test say `exists: false` while leaving an identity in
  // place would manufacture exactly the contradictory observation the
  // classifier exists to reject, and the suite would normalize it rather than
  // catch it. Deliberately malformed observations go through `malformed()`.
  return { ...merged, exists: merged.identity !== null };
}

/** An observation that is deliberately invalid. Cast, because the type forbids it. */
const malformed = (o: Record<string, unknown>): TargetObservation => o as unknown as TargetObservation;

/**
 * The issue the default field-write record targets, on either side of the
 * write. The record stores digests of these and the observation carries the
 * OBJECT, so the classifier projects what it was handed rather than believing
 * a digest the caller computed.
 */
const ISSUE_OPEN = {
  id: "ISS-001", displayId: "ISS-001", title: "Issue ISS-001", status: "open",
  severity: "medium", components: [], impact: "test", resolution: null, location: [],
  discoveredDate: "2026-07-31", resolvedDate: null, relatedTickets: [], order: 10,
};
const ISSUE_DONE = { ...ISSUE_OPEN, status: "inprogress" };

/**
 * Observed at ISS-001, holding the issue as it was before the write.
 *
 * There is no `field` to override and no `nonce`: the classifier reads both off
 * the entity, so a test that wants the field to say something else says it by
 * handing over an entity that says it. `holding()` below is the shorthand.
 */
const observe = (over: Partial<TargetObservation> = {}): TargetObservation =>
  observeAt("ISS-001", { entity: ISSUE_OPEN, ...over });
/** Observed at ISS-001, holding the issue as the write would leave it. */
const observeDone = (over: Partial<TargetObservation> = {}): TargetObservation =>
  observeAt("ISS-001", { entity: ISSUE_DONE, ...over });
/** Observed at ISS-001, holding an issue whose status is exactly `status`. */
const holding = (status: string, over: Partial<TargetObservation> = {}): TargetObservation =>
  observeAt("ISS-001", { entity: { ...ISSUE_OPEN, status }, ...over });
/** The same, plus a transition stamp written onto the entity itself. */
const stamped = (status: string, transitionId: string, over: Partial<TargetObservation> = {}): TargetObservation =>
  observeAt("ISS-001", { entity: { ...ISSUE_OPEN, status, transitionId }, ...over });

function fieldWrite(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "issue_update",
    target: "ISS-001",
    field: "status",
    value: "inprogress",
    transitionId: "txn-1",
    provenance: PROV,
    preimage: at("open"),
    postimage: at("inprogress"),
    preimageFingerprint: entityFingerprint(ISSUE_OPEN),
    postimageFingerprint: entityFingerprint(ISSUE_DONE),
    ...over,
  };
}

const reasonOf = (o: ReturnType<typeof classifyPendingMutation>): string =>
  o.kind === "quarantine" ? o.reason : `not-quarantined:${o.kind}`;

// ---------------------------------------------------------------------------
// Provenance is the gate, and it is validated rather than detected
// ---------------------------------------------------------------------------

describe("T-450 step 4: provenance", () => {
  it("quarantines a record with no provenance even when the write plainly landed", () => {
    // The strongest possible evidence that the write succeeded -- postimage
    // match AND our own nonce on the target -- still does not authorize
    // clearing a record whose author and revision are unknown.
    const outcome = classifyPendingMutation(
      fieldWrite({ provenance: undefined }),
      stamped("inprogress", "txn-1"),
      HOLDS_T1,
    );
    expect(reasonOf(outcome)).toBe("no-provenance");
  });

  it("quarantines a record with no provenance when the write plainly did not land", () => {
    const outcome = classifyPendingMutation(
      fieldWrite({ provenance: undefined }),
      observe(),
      HOLDS_T1,
    );
    expect(reasonOf(outcome)).toBe("no-provenance");
  });

  it("refuses a half-written provenance object rather than reading around the gaps", () => {
    const broken: unknown[] = [
      { revision: 7, ticket: null },                        // no ownerTask key at all
      { ownerTask: "task-a", ticket: null },                // no revision
      { ownerTask: "task-a", revision: "7", ticket: null }, // revision as a string
      { ownerTask: "task-a", revision: NaN, ticket: null }, // non-finite revision
      { ownerTask: 42, revision: 7, ticket: null },         // ownerTask not a string
      { ownerTask: "task-a", revision: 7, ticket: 3 },      // ticket not a string
      "task-a",
      null,
    ];
    for (const provenance of broken) {
      expect(readProvenance(provenance), JSON.stringify(provenance)).toBeNull();
      expect(
        reasonOf(classifyPendingMutation(fieldWrite({ provenance }), observe(), HOLDS_T1)),
        JSON.stringify(provenance),
      ).toBe("no-provenance");
    }
  });

  it("refuses values the writer cannot produce, rather than only values of the wrong type", () => {
    // A revision is a non-negative integer and an id that exists is a non-empty
    // string. An empty ownerTask would be reported as the displaced owner of a
    // quarantined record, which is an attribution to nobody.
    const impossible: unknown[] = [
      { ownerTask: "", revision: 7, ticket: null },
      { ownerTask: "task-a", revision: 7, ticket: "" },
      { ownerTask: "task-a", revision: -1, ticket: null },
      { ownerTask: "task-a", revision: 1.5, ticket: null },
      { ownerTask: "task-a", revision: Infinity, ticket: null },
    ];
    for (const provenance of impossible) {
      expect(readProvenance(provenance), JSON.stringify(provenance)).toBeNull();
      expect(
        reasonOf(classifyPendingMutation(fieldWrite({ provenance }), observe(), HOLDS_T1)),
        JSON.stringify(provenance),
      ).toBe("no-provenance");
    }
    // Zero IS producible: a session's first revision.
    expect(readProvenance({ ownerTask: "t", revision: 0, ticket: null })).not.toBeNull();
  });

  it("accepts a null ownerTask, because a client with no task identity is legitimate", () => {
    const provenance = { ownerTask: null, revision: 0, ticket: null };
    expect(readProvenance(provenance)).toEqual(provenance);
    expect(classifyPendingMutation(fieldWrite({ provenance }), observe(), HOLDS_T1).kind)
      .toBe("replay");
  });

  it("checks provenance BEFORE the variant, so an unknown type with no provenance reports the gate it failed first", () => {
    expect(reasonOf(classifyPendingMutation({ type: "nope" }, observe(), HOLDS_T1))).toBe("no-provenance");
    expect(reasonOf(classifyPendingMutation({ type: "nope", provenance: PROV }, observe(), HOLDS_T1)))
      .toBe("unknown-variant");
  });

  it("quarantines anything that is not an object at all", () => {
    for (const record of [null, undefined, "", "ticket_update", 7, true, []]) {
      // An array IS an object, so it reaches the provenance gate; everything
      // else fails the shape check. Both quarantine, which is the property.
      expect(classifyPendingMutation(record, observe(), HOLDS_T1).kind, JSON.stringify(record)).toBe("quarantine");
    }
  });
});

// ---------------------------------------------------------------------------
// The classifier does not trust the caller's aim
// ---------------------------------------------------------------------------

describe("T-450 step 4: the observation must have been taken where the record points", () => {
  it("refuses when the observation was taken somewhere else", () => {
    // The occupant at ISS-999 is a perfectly good issue, correctly observed.
    // The ONLY thing wrong is that the record points somewhere else.
    const elsewhere = { ...ISSUE_OPEN, id: "ISS-999", displayId: "ISS-999" };
    expect(reasonOf(classifyPendingMutation(fieldWrite(), observeAt("ISS-999", { entity: elsewhere }), HOLDS_T1)))
      .toBe("identity-mismatch");
  });

  it("refuses a record that names no target at all", () => {
    for (const over of [{ target: undefined }, { target: "" }, { target: 7 }]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1)), JSON.stringify(over))
        .toBe("unidentifiable-target");
    }
  });

  it("does not call a free target an identity mismatch, because that is the replay case", () => {
    // Nothing exists there, so there is no identity to disagree with. The
    // record is still refused, but for the honest reason.
    expect(reasonOf(classifyPendingMutation(fieldWrite(), observeAt(null), HOLDS_T1)))
      .toBe("target-missing");
  });

  it("refuses a RECORD snapshot that is both absent and holds a value", () => {
    // A snapshot that is both absent and holds a value is a contradiction, and
    // which half a reader happens to look at would decide whether the field
    // counts as absent or as holding "open". Snapshots live on the RECORD now;
    // the observation no longer carries any, which is why this is tested there.
    const contradictory = { present: false, value: "open" } as unknown as FieldSnapshot;
    expect(readSnapshot(contradictory), "the reader refuses it on its own").toBeNull();
    for (const over of [{ preimage: contradictory }, { postimage: contradictory }]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1)), JSON.stringify(over))
        .toBe("legacy-payload");
    }
  });

  it("refuses an observation whose own shape is malformed rather than deciding from it", () => {
    for (const over of [
      { identity: 7 as unknown as string },
      { dedupeKey: 7 as unknown as string },
      { dedupeKeyAt: 7 as unknown as string },
      { contentFingerprint: 7 as unknown as string },
    ]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(), observe(over), HOLDS_T1)), JSON.stringify(over))
        .toBe("malformed-observation");
    }
  });

  it("refuses an observation whose fields contradict each other", () => {
    // Nothing exists there, yet the observation still carries an identity, a
    // key, a digest or a present field. The free-target arm returns REPLAY
    // WITHOUT consulting identity, so a contradiction here is not cosmetic:
    // it authorizes a write on the strength of half an observation.
    const base = { exists: false, identity: null, dedupeKey: null, dedupeKeyAt: null, contentFingerprint: null };
    for (const over of [
      { identity: "ISS-001" },
      { dedupeKey: "dk-1" },
      { contentFingerprint: "sha-x" },
      { entity: { id: "ISS-001", title: "something is there after all" } },
    ]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(), malformed({ ...base, ...over }), HOLDS_T1)), JSON.stringify(over))
        .toBe("malformed-observation");
    }
  });

  it("refuses an observation that reports something exists but cannot say what", () => {
    // The occupant is present and correct in every case here, so the ONLY
    // thing wrong is what the observation says about its own existence. A base
    // that omitted the entity would fail later, for a different reason, and
    // this row would pass without checking anything.
    const base = {
      exists: true, dedupeKey: null, dedupeKeyAt: null, entity: ISSUE_OPEN,
      contentFingerprint: null,
    };
    for (const identity of [null, ""]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(), malformed({ ...base, identity }), HOLDS_T1)), String(identity))
        .toBe("malformed-observation");
    }
    expect(reasonOf(classifyPendingMutation(fieldWrite(), malformed({ ...base, identity: "ISS-001", exists: "yes" }), HOLDS_T1)))
      .toBe("malformed-observation");
  });
});

// ---------------------------------------------------------------------------
// The three outcomes
// ---------------------------------------------------------------------------

describe("T-450 step 4: the three-outcome table", () => {
  it("replays on an exact preimage match", () => {
    expect(classifyPendingMutation(fieldWrite(), observe(), HOLDS_T1))
      .toEqual({ kind: "replay" });
  });

  it("clears without rewriting on an exact postimage match corroborated by the transition nonce", () => {
    expect(classifyPendingMutation(
      fieldWrite(),
      stamped("inprogress", "txn-1"),
      HOLDS_T1,
    )).toEqual({ kind: "applied" });
  });

  it("clears on an exact postimage match corroborated by the occupant's own content", () => {
    // No nonce. What agrees is the ENTITY: the record predicted the whole issue
    // this write would produce, and the issue that is there projects to the
    // same digest -- projected here, from the occupant, not handed over.
    expect(classifyPendingMutation(fieldWrite(), observeDone(), HOLDS_T1))
      .toEqual({ kind: "applied" });
  });

  it("does NOT mistake a third party's identical value for this transaction's postimage", () => {
    // The value is exactly what we intended to write, on an issue that is not
    // the one we were writing to. Accepting this is how a foreign write gets
    // credited to us and the real one is dropped.
    const foreign = { ...ISSUE_DONE, title: "someone else's issue" };
    expect(reasonOf(classifyPendingMutation(fieldWrite(), observeDone({ entity: foreign }), HOLDS_T1)))
      .toBe("unconfirmed-postimage");
  });

  it("does not accept a stamp belonging to a different transition", () => {
    const foreign = { ...ISSUE_DONE, title: "someone else's issue", transitionId: "txn-2" };
    expect(reasonOf(classifyPendingMutation(
      fieldWrite(),
      observeDone({ entity: foreign }),
      HOLDS_T1,
    ))).toBe("unconfirmed-postimage");
  });

  it("accepts a foreign-LOOKING occupant that carries our own stamp", () => {
    // The other side of the same rule, and the reason the stamp is read off the
    // entity rather than taken from the caller. An issue whose other fields
    // have moved on since is not evidence against us -- but the transition id
    // written ON IT is evidence FOR us, because only this transaction had it.
    // The whole-entity digest cannot agree here, so the stamp is the only thing
    // that can clear this record, and it does.
    const moved = { ...ISSUE_DONE, title: "edited by someone since", transitionId: "txn-1" };
    expect(entityFingerprint(moved), "the digest really does not agree")
      .not.toBe(entityFingerprint(ISSUE_DONE));
    expect(classifyPendingMutation(fieldWrite(), observeDone({ entity: moved }), HOLDS_T1))
      .toEqual({ kind: "applied" });
  });

  it("does not accept a digest the CALLER supplied in place of the occupant", () => {
    // The defect this arm exists to prevent, and the one that would make the
    // whole check decorative: a caller copying the record's own prediction into
    // the observation. It is never read, so the entity still decides, and a
    // differently-shaped issue is still refused.
    const foreign = { ...ISSUE_DONE, title: "someone else's issue" };
    const record = fieldWrite();
    expect(reasonOf(classifyPendingMutation(
      record,
      observeDone({ entity: foreign, contentFingerprint: record.postimageFingerprint as string }),
      HOLDS_T1,
    ))).toBe("unconfirmed-postimage");
    // And the reverse: a caller-supplied digest that is wrong does not stop a
    // genuine clear, because that field is not consulted here at all.
    expect(classifyPendingMutation(record, observeDone({ contentFingerprint: "sha-nonsense" }), HOLDS_T1))
      .toEqual({ kind: "applied" });
  });

  it("reads the field's current value off the OCCUPANT, never from beside it", () => {
    // The observation has no `field` of its own, deliberately: a caller that
    // could name the current value independently could report the preimage
    // while handing over an entity that says otherwise, and the classifier
    // would replay over a state it never looked at. The only way to say what
    // the field holds is to hand over an entity that holds it.
    //
    // A third value is neither image, so it is a conflict...
    expect(reasonOf(classifyPendingMutation(fieldWrite(), holding("resolved"), HOLDS_T1)))
      .toBe("conflict");
    // ...and the record's own images cannot talk it out of that, however
    // confidently they describe a transition it is not in.
    const insistent = fieldWrite({
      preimage: at("resolved"),
      preimageFingerprint: entityFingerprint({ ...ISSUE_OPEN, status: "resolved" }),
    });
    expect(classifyPendingMutation(insistent, holding("resolved"), HOLDS_T1))
      .toEqual({ kind: "replay" });
    expect(reasonOf(classifyPendingMutation(insistent, observe(), HOLDS_T1))).toBe("conflict");
  });

  it("refuses an occupant whose named field holds something no write could produce", () => {
    // A written value is a string. A field holding a number, an object or null
    // is neither absent nor any image this record describes, so the honest
    // answer is that the world holds something this transaction cannot speak
    // to -- not that the record is malformed, which it is not.
    for (const status of [7, null, { nested: "x" }, ["a"], true]) {
      expect(
        reasonOf(classifyPendingMutation(
          fieldWrite(),
          observeAt("ISS-001", { entity: { ...ISSUE_OPEN, status } }),
          HOLDS_T1,
        )),
        JSON.stringify(status),
      ).toBe("conflict");
    }
    // And it is refused rather than read as an ABSENCE, which is the reading
    // that would do damage: a record whose preimage was absent would then match
    // it and replay over whatever is really there.
    const absentPreimage = fieldWrite({
      preimage: absent,
      preimageFingerprint: entityFingerprint({ ...ISSUE_OPEN, status: 7 }),
    });
    expect(reasonOf(classifyPendingMutation(
      absentPreimage,
      observeAt("ISS-001", { entity: { ...ISSUE_OPEN, status: 7 } }),
      HOLDS_T1,
    ))).toBe("conflict");
  });

  it("reads a field explicitly holding undefined exactly as it reads a missing one", () => {
    // The serializer drops an undefined member, so a JSON round trip cannot
    // tell these apart and neither can this. Asserted rather than assumed,
    // because the alternative is two branches that can only ever agree.
    const { status: _status, ...noStatus } = ISSUE_OPEN;
    const record = fieldWrite({
      preimage: absent,
      postimage: at("inprogress"),
      preimageFingerprint: entityFingerprint(noStatus),
      postimageFingerprint: entityFingerprint({ ...noStatus, status: "inprogress" }),
    });
    expect(entityFingerprint({ ...noStatus, status: undefined }), "the digests agree too")
      .toBe(entityFingerprint(noStatus));
    expect(classifyPendingMutation(
      record,
      observeAt("ISS-001", { entity: { ...noStatus, status: undefined } }),
      HOLDS_T1,
    )).toEqual({ kind: "replay" });
  });

  it("recognizes a POST-MIGRATION issue, whose canonical id is a hash", () => {
    // The ledger is permanently mixed and this is the half that a display-id
    // identity would make unrecoverable. The prepare site records
    // `target: issue.id`, so for a migrated issue the record, the observation
    // and the entity all have to speak in hashes.
    const HASH = "i-9f2cabcdefgh2345";
    const open = { ...ISSUE_OPEN, id: HASH, displayId: "ISS-001" };
    const done = { ...open, status: "inprogress" };
    const record = fieldWrite({
      target: HASH,
      preimageFingerprint: entityFingerprint(open),
      postimageFingerprint: entityFingerprint(done),
    });
    expect(classifyPendingMutation(record, observeAt(HASH, { entity: open }), HOLDS_T1))
      .toEqual({ kind: "replay" });
    expect(classifyPendingMutation(record, observeAt(HASH, { entity: done }), HOLDS_T1))
      .toEqual({ kind: "applied" });
    // And the display id is NOT a second identity it also answers to. Reading
    // `displayId` first -- which an earlier revision of this did -- quarantined
    // every migrated record instead, because the record names the hash.
    expect(reasonOf(classifyPendingMutation(record, observeAt("ISS-001", { entity: open }), HOLDS_T1)))
      .toBe("identity-mismatch");
  });

  it("recognizes a LEGACY issue, whose canonical id is its display id", () => {
    // The other half of the mixed ledger: no `displayId` key at all, and `id`
    // carrying the display form. One rule covers both, which is the point.
    const { displayId: _displayId, ...open } = ISSUE_OPEN;
    const done = { ...open, status: "inprogress" };
    const record = fieldWrite({
      preimageFingerprint: entityFingerprint(open),
      postimageFingerprint: entityFingerprint(done),
    });
    expect(classifyPendingMutation(record, observeAt("ISS-001", { entity: open }), HOLDS_T1))
      .toEqual({ kind: "replay" });
    expect(classifyPendingMutation(record, observeAt("ISS-001", { entity: done }), HOLDS_T1))
      .toEqual({ kind: "applied" });
  });

  it("refuses an occupant holding an accessor at ANY depth, without invoking it", () => {
    // The serializer walks nested objects and arrays, so a top-level guard is
    // not enough: a getter two levels down would still be read, and read again
    // by the comparison, possibly answering differently each time. None of
    // these is a shape a ledger item loaded from JSON can have, which is
    // exactly why they must produce a refusal rather than a verdict.
    let reads = 0;
    const getter = { get: () => `read-${reads++}`, enumerable: true, configurable: true };
    const withArrayAccessor = () => {
      const a = ["x"];
      Object.defineProperty(a, 0, getter);
      return a;
    };
    for (const entity of [
      Object.defineProperty({ ...ISSUE_DONE }, "note", getter),
      { ...ISSUE_DONE, nested: Object.defineProperty({ deep: "x" }, "deep", getter) },
      { ...ISSUE_DONE, components: withArrayAccessor() },
      { ...ISSUE_DONE, nested: { list: withArrayAccessor() } },
    ]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(), observeDone({ entity }), HOLDS_T1)))
        .toBe("malformed-observation");
    }
    expect(reads, "and none of them was invoked").toBe(0);
  });

  it("refuses an occupant that cannot be canonicalized at all, rather than throwing", () => {
    // A cycle would recurse until the stack gave out and a BigInt would throw
    // inside JSON.stringify. A throw here takes the recovery down with it,
    // which is strictly worse than any verdict, so each is a refusal.
    const circular: Record<string, unknown> = { ...ISSUE_DONE };
    circular.self = circular;
    const nestedCycle: Record<string, unknown> = { ...ISSUE_DONE, nested: {} };
    (nestedCycle.nested as Record<string, unknown>).back = nestedCycle;
    for (const entity of [
      circular,
      nestedCycle,
      { ...ISSUE_DONE, big: BigInt(1) },
      { ...ISSUE_DONE, nested: { big: BigInt(1) } },
      { ...ISSUE_DONE, fn: () => "x" },
      { ...ISSUE_DONE, sym: Symbol("x") },
      { ...ISSUE_DONE, nan: NaN },
      { ...ISSUE_DONE, inf: Infinity },
    ]) {
      expect(
        () => classifyPendingMutation(fieldWrite(), observeDone({ entity }), HOLDS_T1),
        JSON.stringify(Object.keys(entity).at(-1)),
      ).not.toThrow();
      expect(reasonOf(classifyPendingMutation(fieldWrite(), observeDone({ entity }), HOLDS_T1)))
        .toBe("malformed-observation");
    }
  });

  it("refuses an occupant carrying a SYMBOL-keyed own property, at any depth", () => {
    // `getOwnPropertyNames` cannot see a symbol key. A digest taken with it
    // would silently omit that data, so two entities that differ would agree --
    // and on an array a symbol key is worse still: it pads the own-key count
    // and lets a SPARSE array through as though it were dense. Symbols do not
    // survive JSON, so an occupant holding one is a malformed observation
    // rather than a shape to support.
    const sym = Symbol("hidden");
    const withSymbolKey = (base: object) =>
      Object.defineProperty({ ...base }, sym, { value: "x", enumerable: true, configurable: true });
    const paddedBySymbol = () => {
      const a: unknown[] = [];
      a[0] = "x";
      a[2] = "y"; // index 1 is a hole...
      (a as unknown as Record<symbol, unknown>)[sym] = 1; // ...and this pads the count back
      return a;
    };
    expect(Reflect.ownKeys(paddedBySymbol()).length, "the symbol pads the own-key count back to dense")
      .toBe(paddedBySymbol().length + 1);
    for (const entity of [
      withSymbolKey(ISSUE_DONE),
      { ...ISSUE_DONE, nested: withSymbolKey({ deep: "x" }) },
      { ...ISSUE_DONE, components: paddedBySymbol() },
      { ...ISSUE_DONE, nested: { list: paddedBySymbol() } },
    ]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(), observeDone({ entity }), HOLDS_T1)))
        .toBe("malformed-observation");
    }
  });

  it("refuses a nested array that is sparse, or padded to look dense", () => {
    // A hole is not a value: it serializes as null and would digest as one, so
    // an array with a hole and an array holding null would agree. The padded
    // case is the one a count-only check misses -- an unrelated own property
    // restores the number of keys the missing index took away.
    const sparse = () => {
      const a: unknown[] = [];
      a[0] = "x";
      a[2] = "y";
      return a;
    };
    const padded = () => {
      const a = sparse();
      (a as unknown as Record<string, unknown>).note = "z";
      return a;
    };
    // A DENSE array carrying an extra own property is the case the per-index
    // loop cannot see at all: every index is present and readable, so only the
    // key count notices that the array is also something else. Digesting it as
    // a plain list would silently drop that property from an entity digest.
    const dense = () => {
      const a: unknown[] = ["x", "y"];
      (a as unknown as Record<string, unknown>).note = "z";
      return a;
    };
    expect(Object.getOwnPropertyNames(padded()).length, "the pad really does balance the count")
      .toBe(padded().length + 1);
    for (const entity of [
      { ...ISSUE_DONE, components: sparse() },
      { ...ISSUE_DONE, components: padded() },
      { ...ISSUE_DONE, components: dense() },
      { ...ISSUE_DONE, nested: { list: padded() } },
      { ...ISSUE_DONE, nested: { list: dense() } },
    ]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(), observeDone({ entity }), HOLDS_T1)))
        .toBe("malformed-observation");
    }
  });

  it("refuses an occupant nested deeper than the walk supports, rather than overflowing", () => {
    // A cycle is caught by identity, but an ACYCLIC chain can be arbitrarily
    // deep, and both this walk and the serializer below it recurse. Past the
    // bound the answer is a refusal; a stack overflow would take the recovering
    // session with it, which is worse than any verdict.
    const chain = (depth: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { leaf: "x" };
      for (let i = 0; i < depth; i++) node = { next: node };
      return node;
    };
    const ordinary = { ...ISSUE_DONE, nested: chain(8) };
    // PAST the bound but nowhere near a stack overflow. That is the case that
    // proves the bound is doing the work: an unbounded walk would canonicalize
    // this happily and reach a content verdict, so the refusal can only come
    // from the bound itself.
    const overBound = { ...ISSUE_DONE, nested: chain(100) };
    // And far enough past it that an unbounded walk would run out of stack.
    const abyss = { ...ISSUE_DONE, nested: chain(20000) };
    // Ordinary nesting is ordinary data and still digests, so the bound is a
    // bound and not a ban on nesting.
    expect(entityFingerprint(ordinary)).not.toBeNull();
    for (const entity of [overBound, abyss]) {
      expect(() => classifyPendingMutation(fieldWrite(), observeDone({ entity }), HOLDS_T1))
        .not.toThrow();
      expect(reasonOf(classifyPendingMutation(fieldWrite(), observeDone({ entity }), HOLDS_T1)))
        .toBe("malformed-observation");
      expect(entityFingerprint(entity), "and the digest refuses it too").toBeNull();
    }
  });

  it("refuses an occupant whose own reflection throws, rather than propagating", () => {
    // Reading own keys is an ordinary call on an ordinary object and an exotic
    // one on a proxy, where the trap may throw anything at all. Recovery
    // classifies; it does not propagate.
    const hostile = new Proxy({ ...ISSUE_DONE }, {
      ownKeys() {
        throw new Error("hostile observation");
      },
    });
    expect(() => classifyPendingMutation(fieldWrite(), observeDone({ entity: hostile }), HOLDS_T1))
      .not.toThrow();
    expect(reasonOf(classifyPendingMutation(fieldWrite(), observeDone({ entity: hostile }), HOLDS_T1)))
      .toBe("malformed-observation");
    expect(entityFingerprint(hostile), "and the digest refuses it too").toBeNull();
  });

  it("refuses reflection that throws in EVERY position a reader reads", () => {
    // The occupant is one position out of many. The record itself, its
    // provenance, its snapshots, the observation around them and a create's
    // content and payload are all structure this module did not build, and each
    // is read through a reflective boundary. A throw out of any one of them
    // takes the recovering session down instead of quarantining one record, so
    // every position is asserted rather than the one that happened to be found.
    let traps = 0;
    const hostile = (): unknown =>
      new Proxy({}, {
        ownKeys() {
          traps++;
          throw new Error("hostile reflection");
        },
        get() {
          traps++;
          throw new Error("hostile reflection");
        },
      });

    // Positions on the RECORD. Each is a different reader: ownFields on the
    // record itself, readProvenance, readSnapshot, and the create's content.
    for (const over of [
      { provenance: hostile() },
      { preimage: hostile() },
      { postimage: hostile() },
    ]) {
      expect(() => classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1), JSON.stringify(Object.keys(over)))
        .not.toThrow();
      expect(classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1).kind).toBe("quarantine");
    }
    // The record itself, and the observation itself.
    expect(() => classifyPendingMutation(hostile(), observe(), HOLDS_T1)).not.toThrow();
    expect(reasonOf(classifyPendingMutation(hostile(), observe(), HOLDS_T1))).toBe("unknown-variant");
    expect(() => classifyPendingMutation(fieldWrite(), hostile() as TargetObservation, HOLDS_T1)).not.toThrow();
    expect(reasonOf(classifyPendingMutation(fieldWrite(), hostile() as TargetObservation, HOLDS_T1)))
      .toBe("malformed-observation");
    // And the quarantine builder, which reads the same record again to record
    // who was displaced. A throw there loses the payload it exists to preserve.
    expect(() => buildQuarantineRecord(hostile(), "malformed-record", "2026-07-31T00:00:00.000Z"))
      .not.toThrow();

    expect(traps, "and every one of them really did trap").toBeGreaterThan(0);
  });

  it("refuses a REVOKED proxy, which throws before any trap can be reached", () => {
    // The case a trap-based test cannot find. `Array.isArray` throws a
    // TypeError on a revoked proxy, so a shape guard placed AHEAD of the
    // boundary is the one line able to escape it -- no handler runs, so
    // nothing is there to catch. Asserted first, so the premise is not
    // assumed.
    const revoked = (target: object): unknown => {
      const { proxy, revoke } = Proxy.revocable(target, {});
      revoke();
      return proxy;
    };
    expect(() => Array.isArray(revoked({}) as object), "the premise: this really does throw").toThrow(TypeError);
    expect(() => Array.isArray(revoked([]) as object)).toThrow(TypeError);

    for (const dead of [revoked({}), revoked([])]) {
      // Every reader position, object-shaped and array-shaped.
      expect(() => classifyPendingMutation(dead, observe(), HOLDS_T1)).not.toThrow();
      expect(classifyPendingMutation(dead, observe(), HOLDS_T1).kind).toBe("quarantine");
      expect(() => classifyPendingMutation(fieldWrite(), dead as TargetObservation, HOLDS_T1)).not.toThrow();
      expect(reasonOf(classifyPendingMutation(fieldWrite(), dead as TargetObservation, HOLDS_T1)))
        .toBe("malformed-observation");
      for (const over of [{ provenance: dead }, { preimage: dead }, { postimage: dead }]) {
        expect(() => classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1)).not.toThrow();
        expect(classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1).kind).toBe("quarantine");
      }
      expect(() => classifyPendingMutation(fieldWrite(), observe({ entity: dead }), HOLDS_T1)).not.toThrow();
      expect(reasonOf(classifyPendingMutation(fieldWrite(), observe({ entity: dead }), HOLDS_T1)))
        .toBe("malformed-observation");
      expect(() => buildQuarantineRecord(dead, "malformed-record", "2026-07-31T00:00:00.000Z")).not.toThrow();
      expect(() => readProvenance(dead)).not.toThrow();
      expect(readProvenance(dead)).toBeNull();
      expect(() => readSnapshot(dead)).not.toThrow();
      expect(readSnapshot(dead)).toBeNull();
      expect(() => readIssueCreatePayload(dead)).not.toThrow();
      expect(readIssueCreatePayload(dead)).toBeNull();
      expect(() => entityFingerprint(dead)).not.toThrow();
      expect(entityFingerprint(dead)).toBeNull();
    }
  });

  it("digests the occupant through the own-data boundary, not the raw object", () => {
    // The boundary is visible on a field the raw serialization would not see at
    // all: a non-enumerable own property is part of the entity and part of the
    // digest, and `Object.entries` would silently drop it.
    const hidden = (base: object) =>
      Object.defineProperty({ ...base }, "hidden", { value: "x", enumerable: false, configurable: true });
    const occupant = hidden(ISSUE_DONE);
    const record = fieldWrite({ postimageFingerprint: entityFingerprint(occupant) });
    expect(classifyPendingMutation(record, observeDone({ entity: occupant }), HOLDS_T1))
      .toEqual({ kind: "applied" });
    // And it really is load-bearing: without that property the digests differ.
    expect(entityFingerprint(occupant)).not.toBe(entityFingerprint({ ...ISSUE_DONE }));
  });

  it("refuses an occupant that is not the thing at the identity being authenticated", () => {
    // Content from one item must not authenticate an observation of another.
    for (const entity of [undefined, null, "an issue", ["an issue"], { ...ISSUE_DONE, id: "ISS-900", displayId: "ISS-900" }]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(), observeDone({ entity }), HOLDS_T1)), JSON.stringify(entity))
        .toBe("malformed-observation");
    }
  });

  it("refuses a record that stores only one of the two digests", () => {
    // Both arms need one. A record carrying neither, or only the postimage,
    // predates this design and cannot be reasoned about rather than being
    // reasoned about badly.
    for (const over of [
      { preimageFingerprint: undefined, postimageFingerprint: undefined },
      { preimageFingerprint: undefined },
      { postimageFingerprint: undefined },
      { preimageFingerprint: null },
      { postimageFingerprint: 7 },
    ]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1)), JSON.stringify(over))
        .toBe("legacy-payload");
      expect(reasonOf(classifyPendingMutation(fieldWrite(over), observeDone(), HOLDS_T1)), JSON.stringify(over))
        .toBe("legacy-payload");
    }
  });

  it("refuses to replay against an entity that drifted while the field did not", () => {
    // A replay verdict promises two things: that the write can be performed,
    // and that this record can afterwards recognize what it produced.
    // Recognition is whole-entity, so if some OTHER field moved since the
    // record was prepared, replaying would write a state whose digest can never
    // match the prediction -- the record would quarantine on its own result and
    // never converge. Refusing now is the only answer that terminates.
    const drifted = { ...ISSUE_OPEN, title: "somebody retitled it" };
    expect(reasonOf(classifyPendingMutation(fieldWrite(), observe({ entity: drifted }), HOLDS_T1)))
      .toBe("conflict");
    // Proof that the drift is what would break it, rather than an assertion
    // about it: the write applied to the drifted issue does not digest to the
    // prediction the record is holding.
    expect(entityFingerprint({ ...drifted, status: "inprogress" }))
      .not.toBe(fieldWrite().postimageFingerprint);
  });

  it("does not let an empty fingerprint stand in for a digest", () => {
    // An empty string is not a digest, and a record holding one is a record
    // that cannot corroborate anything. It is refused as legacy rather than
    // read as "no digest required".
    for (const over of [{ postimageFingerprint: "" }, { preimageFingerprint: "" }]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(over), observeDone(), HOLDS_T1)), JSON.stringify(over))
        .toBe("legacy-payload");
    }
  });

  it("does not accept a fingerprint of different content", () => {
    expect(reasonOf(classifyPendingMutation(
      fieldWrite({ postimageFingerprint: "sha-ours" }),
      holding("inprogress", { contentFingerprint: "sha-theirs" }),
      HOLDS_T1,
    ))).toBe("unconfirmed-postimage");
  });

  it("quarantines when the target holds neither image", () => {
    expect(reasonOf(classifyPendingMutation(fieldWrite(), holding("resolved"), HOLDS_T1)))
      .toBe("conflict");
  });

  it("quarantines when the target no longer exists", () => {
    expect(reasonOf(classifyPendingMutation(fieldWrite(), observeAt(null), HOLDS_T1)))
      .toBe("target-missing");
  });

  it("refuses a record that does not say what to write", () => {
    // REPLAY is an instruction to write `field = value`. Both have to be there
    // and be writable, or the consumer is handed an instruction it cannot obey.
    for (const over of [
      { field: undefined }, { field: "" }, { field: 7 },
      { value: undefined }, { value: 7 }, { value: null },
    ]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1)), JSON.stringify(over))
        .toBe("malformed-record");
    }
  });

  /**
   * A record naming FIELD, moving it from -> to, with every fingerprint
   * derived from the same two entities, plus the observation that sees it
   * before the write. Everything about this record is internally consistent;
   * the only question left is whether a replay could actually perform it.
   */
  const moves = (field: string, from: string, to: string) => {
    const before = { ...ISSUE_OPEN, [field]: from };
    const after = { ...before, [field]: to };
    return {
      record: fieldWrite({
        field,
        value: to,
        preimage: at(from),
        postimage: at(to),
        preimageFingerprint: entityFingerprint(before),
        postimageFingerprint: entityFingerprint(after),
      }),
      before: observeAt("ISS-001", { entity: before }),
      after: observeAt("ISS-001", { entity: after }),
    };
  };

  it("refuses to replay a field no replay consumer can write", () => {
    // The consumer replays an issue variant as `handleIssueUpdate(target,
    // { status: value })`. It writes `status` and nothing else, so a REPLAY
    // verdict for any other field promises a write that will not happen: the
    // marker would be cleared and the work it describes silently dropped.
    // Internally consistent records, every one of them -- the defect is not in
    // the record's shape but in what it asks for.
    for (const field of ["priority", "title", "severity", "assignee"]) {
      const m = moves(field, "before", "after");
      expect(reasonOf(classifyPendingMutation(m.record, m.before, HOLDS_T1)), field)
        .toBe("unsupported-field");
    }
  });

  it("refuses to replay a field that would move the target's own identity", () => {
    // Not a separate rule, the same one: `id` and `displayId` are not writable
    // by the consumer either. It is worth its own test because the failure is
    // worse -- a replay that COULD write them moves the entity out from under
    // the `target` this record locates it by, so the record could never
    // afterwards recognize the thing it just produced.
    for (const field of ["id", "displayId"]) {
      const m = moves(field, "ISS-001", "ISS-777");
      expect(reasonOf(classifyPendingMutation(m.record, m.before, HOLDS_T1)), field)
        .toBe("unsupported-field");
    }
  });

  it("still clears an unsupported field whose write already landed", () => {
    // Deliberately NOT gated on the allowlist. The original write was performed
    // by the stage, not by the replay consumer, so a write that already landed
    // is a marker to clear whatever field it touched. Quarantining it would
    // manufacture an incident out of a transaction that succeeded.
    const m = moves("priority", "low", "high");
    expect(classifyPendingMutation(m.record, m.after, HOLDS_T1)).toEqual({ kind: "applied" });
  });

  it("replays the field the consumer does write", () => {
    // The other side of the same allowlist: `status` is what both consumers
    // write, and it replays. Without this the rule above could be satisfied by
    // refusing everything.
    const m = moves("status", "open", "inprogress");
    expect(classifyPendingMutation(m.record, m.before, HOLDS_T1)).toEqual({ kind: "replay" });
  });

  it("refuses a record whose value disagrees with its own postimage", () => {
    // Replaying this would write a state the record's own "already applied"
    // arm would then refuse to recognize, so it could never converge.
    const record = fieldWrite({ value: "resolved", postimage: at("inprogress") });
    expect(reasonOf(classifyPendingMutation(record, observe(), HOLDS_T1)))
      .toBe("malformed-record");
    // And it is refused on the postimage side too, not only on replay.
    expect(reasonOf(classifyPendingMutation(record, stamped("inprogress", "txn-1"), HOLDS_T1)))
      .toBe("malformed-record");
  });

  it("quarantines a payload that predates the snapshots", () => {
    for (const over of [{ preimage: undefined }, { postimage: undefined }, { preimage: {}, postimage: {} }]) {
      expect(reasonOf(classifyPendingMutation(fieldWrite(over), observe(), HOLDS_T1)), JSON.stringify(over))
        .toBe("legacy-payload");
    }
  });

  it("does not report a no-op write as an unconfirmed postimage", () => {
    // preimage === postimage: the field reads the same whether the write ran or
    // not. A no-op write means the value written IS the value already there, so
    // the record's own value has to agree with both images, and so does the
    // postimage digest, since the write it describes leaves the entity put.
    const noop = fieldWrite({
      value: "open", preimage: at("open"), postimage: at("open"),
      postimageFingerprint: entityFingerprint(ISSUE_OPEN),
    });
    // The whole entity corroborates it, so it clears rather than being rewritten.
    expect(classifyPendingMutation(noop, observe(), HOLDS_T1)).toEqual({ kind: "applied" });
    // And when the entity has drifted, the honest reason is that the world
    // moved. There is no postimage to leave unconfirmed here: the field reads
    // the same either way, so calling it an unconfirmed postimage would name a
    // doubt the observation cannot even express.
    expect(reasonOf(classifyPendingMutation(
      noop, observe({ entity: { ...ISSUE_OPEN, title: "somebody retitled it" } }), HOLDS_T1,
    ))).toBe("conflict");
  });

  it("refuses to replay a record whose own write would not produce its prediction", () => {
    // The other half of the convergence promise, and the one a preimage digest
    // cannot give. Here the world has NOT moved -- the occupant is exactly what
    // the record was prepared against -- but performing the record's own write
    // on it produces something the record's postimage prediction is not about.
    // Replaying would execute and then quarantine on its own result forever.
    const inconsistent = fieldWrite({ postimageFingerprint: entityFingerprint({ ...ISSUE_DONE, title: "a different issue" }) });
    expect(reasonOf(classifyPendingMutation(inconsistent, observe(), HOLDS_T1)))
      .toBe("malformed-record");
    // Distinguished from the world moving, which is the record's own fault in
    // neither direction and reports as a conflict.
    expect(reasonOf(classifyPendingMutation(
      fieldWrite(), observe({ entity: { ...ISSUE_OPEN, title: "somebody retitled it" } }), HOLDS_T1,
    ))).toBe("conflict");
    // And the control: a consistent record on an untouched occupant replays.
    expect(classifyPendingMutation(fieldWrite(), observe(), HOLDS_T1)).toEqual({ kind: "replay" });
  });

  it("still prefers applied for a corroborated no-op, so a landed write is not rewritten", () => {
    // A no-op write means the value written IS the value already there, so the
    // record's own value has to agree with both images.
    const record = fieldWrite({ value: "open", preimage: at("open"), postimage: at("open") });
    expect(classifyPendingMutation(record, stamped("open", "txn-1"), HOLDS_T1))
      .toEqual({ kind: "applied" });
  });
});

// ---------------------------------------------------------------------------
// Presence preservation
// ---------------------------------------------------------------------------

describe("T-450 step 4: snapshots preserve presence", () => {
  it("distinguishes an absent field from a field holding the empty string", () => {
    expect(snapshotEquals(absent, at(""))).toBe(false);
    // A record whose preimage was ABSENT, observed against a field that is
    // present and empty: collapsing both to falsy would replay over a real
    // value someone else wrote.
    const record = fieldWrite({ preimage: absent, postimage: at("inprogress") });
    expect(reasonOf(classifyPendingMutation(record, holding(""), HOLDS_T1))).toBe("conflict");
  });

  it("replays when the field was absent and is still absent", () => {
    // The occupant genuinely does not carry the field, rather than an
    // observation SAYING it does not: there is no longer any way to say that
    // independently of the entity.
    const { status: _status, ...noStatus } = ISSUE_OPEN;
    const record = fieldWrite({
      preimage: absent,
      postimage: at("inprogress"),
      preimageFingerprint: entityFingerprint(noStatus),
      postimageFingerprint: entityFingerprint({ ...noStatus, status: "inprogress" }),
    });
    expect(classifyPendingMutation(record, observeAt("ISS-001", { entity: noStatus }), HOLDS_T1))
      .toEqual({ kind: "replay" });
  });

  it("refuses a postimage of absence, which no written value can produce", () => {
    // The preimage side keeps its full presence range: a field that did not
    // exist before is ordinary. The POSTIMAGE is the result of writing a
    // string, so absence there is a record describing a write it cannot make.
    const record = fieldWrite({ preimage: at("open"), postimage: absent });
    expect(reasonOf(classifyPendingMutation(record, observe(), HOLDS_T1)))
      .toBe("malformed-record");
  });

  it("rejects malformed snapshots rather than coercing them", () => {
    for (const value of [
      null, "open", { value: "open" }, { present: "yes", value: "open" },
      { present: true }, { present: true, value: 3 },
      // Both absent and holding a value: a contradiction, not an absence.
      { present: false, value: "open" }, { present: false, value: undefined },
    ]) {
      expect(readSnapshot(value), JSON.stringify(value)).toBeNull();
    }
    expect(readSnapshot({ present: false })).toEqual({ present: false });
    expect(readSnapshot({ present: true, value: "" })).toEqual({ present: true, value: "" });
  });
});

// ---------------------------------------------------------------------------
// Ticket authority
// ---------------------------------------------------------------------------

describe("T-450 step 4: ticket authority gates the replay, not the clear", () => {
  // Only the variant a consumer can actually execute. `ticket_recovery_write`
  // and `ticket_recovery_clear` are declared and unimplemented, and are pinned
  // separately below as quarantine-only rather than folded in here -- a table
  // that asserted `replay` for them would be codifying an instruction to
  // nobody.
  const ticketVariants = ["ticket_update"] as const;
  const unimplementedVariants = ["ticket_recovery_write", "ticket_recovery_clear"] as const;
  const TICKET_OPEN = {
    id: "T-001", displayId: "T-001", title: "Ticket T-001", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-07-31",
    completedDate: null, blockedBy: [], parentTicket: null,
  };
  const TICKET_DONE = { ...TICKET_OPEN, status: "inprogress" };
  const ticketRecord = (type: string, over: Record<string, unknown> = {}) =>
    fieldWrite({
      type, target: "T-001", provenance: PROV_T1,
      preimageFingerprint: entityFingerprint(TICKET_OPEN),
      postimageFingerprint: entityFingerprint(TICKET_DONE),
      ...over,
    });
  const atTicket = (over: Partial<TargetObservation> = {}) =>
    observeAt("T-001", { entity: TICKET_OPEN, ...over });
  const atTicketDone = (over: Partial<TargetObservation> = {}) =>
    observeAt("T-001", { entity: TICKET_DONE, ...over });
  /** The ticket as the write would leave it, stamped on the entity itself. */
  const atTicketStamped = (transitionId: string) =>
    observeAt("T-001", { entity: { ...TICKET_DONE, transitionId } });

  it("replays a ticket variant only while its ticket authority is still held", () => {
    for (const type of ticketVariants) {
      expect(classifyPendingMutation(ticketRecord(type), atTicket(), HOLDS_T1), type)
        .toEqual({ kind: "replay" });
      expect(reasonOf(classifyPendingMutation(ticketRecord(type), atTicket(), NO_AUTHORITY)), type)
        .toBe("ticket-authority-lost");
    }
  });

  it("clears a landed ticket write even after authority is gone, because clearing writes nothing", () => {
    for (const type of ticketVariants) {
      expect(
        classifyPendingMutation(ticketRecord(type), atTicketStamped("txn-1"), NO_AUTHORITY),
        type,
      ).toEqual({ kind: "applied" });
    }
  });

  it("never issues a replay for a variant no consumer can execute", () => {
    // Declared since T-119, written by nothing and read by nothing. A REPLAY
    // here would be an instruction to nobody, followed by a cleared marker and
    // the work silently gone -- which is the exact defect this whole table
    // exists to stop, arriving through the door marked "recognized variant".
    //
    // Asserted across the whole observation space rather than one case,
    // because the point is that NOTHING about the world changes the answer.
    for (const type of unimplementedVariants) {
      for (const observed of [atTicket(), atTicketDone(), atTicketStamped("txn-1"), observeAt(null)]) {
        for (const authority of [HOLDS_T1, NO_AUTHORITY]) {
          expect(reasonOf(classifyPendingMutation(ticketRecord(type), observed, authority)), type)
            .toBe("unimplemented-variant");
        }
      }
    }
    // And it is a distinct answer from a name this build has never heard of,
    // because the two point at different work: implement the consumer, versus
    // find out what wrote this.
    expect(reasonOf(classifyPendingMutation(ticketRecord("ticket_teleport"), atTicket(), HOLDS_T1)))
      .toBe("unknown-variant");
  });

  it("does not gate an issue transition on ticket authority, which does not govern it", () => {
    expect(classifyPendingMutation(fieldWrite(), observe(), NO_AUTHORITY))
      .toEqual({ kind: "replay" });
  });

  it("refuses authority held over a DIFFERENT ticket than the record writes to", () => {
    // The reason authority names a ticket instead of being a boolean. Held
    // authority over T-002 is real authority; it is just not authority here.
    for (const type of ticketVariants) {
      expect(reasonOf(classifyPendingMutation(ticketRecord(type), atTicket(), authFor("T-002"))), type)
        .toBe("ticket-authority-lost");
    }
  });

  it("refuses a ticket record whose provenance authorizes a different ticket", () => {
    // Unchecked, the provenance ticket is decorative: a record could carry
    // authority for one ticket and write to another. Checked, it binds the
    // authorization to the mutation it authorizes.
    for (const type of ticketVariants) {
      const wrong = ticketRecord(type, { provenance: { ownerTask: "task-a", revision: 7, ticket: "T-002" } });
      expect(reasonOf(classifyPendingMutation(wrong, atTicket(), HOLDS_T1)), type)
        .toBe("provenance-target-mismatch");
    }
  });

  it("refuses a ticket record whose provenance names no ticket at all", () => {
    for (const type of ticketVariants) {
      const unbound = ticketRecord(type, { provenance: PROV });
      expect(reasonOf(classifyPendingMutation(unbound, atTicket(), HOLDS_T1)), type)
        .toBe("provenance-target-mismatch");
    }
  });

  it("binds provenance before it even looks at the images, so a mismatch cannot clear either", () => {
    for (const type of ticketVariants) {
      const wrong = ticketRecord(type, { provenance: { ownerTask: "task-a", revision: 7, ticket: "T-002" } });
      expect(reasonOf(classifyPendingMutation(
        wrong, atTicketStamped("txn-1"), HOLDS_T1,
      )), type).toBe("provenance-target-mismatch");
    }
  });
});

// ---------------------------------------------------------------------------
// issue_create: identity AND content
// ---------------------------------------------------------------------------

/** A create input that `handleIssueCreate` can actually be called with. */
const CREATE_PAYLOAD = {
  title: "the issue this transaction was creating",
  severity: "medium",
  impact: "recorded so a replay has something to write",
  components: ["autonomous"],
  // CANONICAL identities, resolved at preparation. One representation, so the
  // replay input and the identity prediction cannot disagree.
  relatedTickets: ["t-abcdefgh23456789"],
  location: [],
  // The single canonical identity, and the only thing a create writes that a
  // later observation can match it by.
  dedupeKey: "dk-1",
};

/** A second canonical ticket, for the tests that need a two-element link set. */
const SECOND_LINK = "t-bbcdefgh23456789";
const TWO_LINKS = [CREATE_PAYLOAD.relatedTickets[0], SECOND_LINK];

/**
 * The resolutions these tests hand to the classifier are produced by the REAL
 * resolver over a REAL ledger, in `beforeAll` below. Deriving them from
 * `CREATE_PAYLOAD` instead would be the exact bypass the check exists to
 * prevent: a caller confirming a record with a copy of itself (L-038).
 */
let linksRoot: string;
let RESOLVED_LINKS: ResolvedTicketIdentities;
let RESOLVED_TWO: ResolvedTicketIdentities;

/**
 * A FORGED resolution: the right shape, without the provenance. A cast is all
 * a branded type can be defeated by, which is why the registry check exists.
 */
const asResolved = (v: unknown) => v as ResolvedTicketIdentities;
/**
 * A genuine registration, for the tests that are about set agreement rather
 * than about where the list came from.
 */
const minted = (ids: readonly string[]) => markResolvedTicketIdentities(ids);

describe("T-450 step 4: issue_create is identified by its dedupe key, not its display id", () => {
  beforeAll(async () => {
    linksRoot = buildRepo();
    writeAliasedTicket(linksRoot);
    writeCanonicalTicket(linksRoot, SECOND_LINK, "T-002");
    const { state } = await loadProject(linksRoot);
    const one = resolvePayloadTicketIdentities(state, CREATE_PAYLOAD.relatedTickets);
    const two = resolvePayloadTicketIdentities(state, TWO_LINKS);
    expect(one, "the fixture ledger must actually hold these tickets").not.toBeNull();
    expect(two, "the fixture ledger must actually hold these tickets").not.toBeNull();
    RESOLVED_LINKS = one!;
    RESOLVED_TWO = two!;
  });
  afterAll(() => {
    rmSync(linksRoot, { recursive: true, force: true });
  });

  function create(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "issue_create",
      expectedId: "ISS-042",
      transitionId: "txn-c",
      provenance: PROV,
      content: { payload: CREATE_PAYLOAD, semanticFingerprint: issueCreateFingerprint(CREATE_PAYLOAD)! },
      ...over,
    };
  }
  /**
   * The ledger holds our issue, at whatever id it was actually allocated, with
   * the allocated fields a real create writes and a preparer cannot predict.
   */
  const landedIssue = (id: string, over: Record<string, unknown> = {}) => ({
    ...CREATE_PAYLOAD, id, displayId: id, status: "open", order: 40,
    discoveredDate: "2026-07-31", resolvedDate: null, resolution: null, ...over,
  });
  const foundAt = (id: string, over: Partial<TargetObservation> = {}) =>
    observeAt(id, {
      dedupeKeyAt: id, dedupeKey: "dk-1", entity: landedIssue(id),
      resolvedPayloadTickets: RESOLVED_LINKS, ...over,
    });
  /** Nothing in the ledger carries our key, and the links resolve to themselves. */
  const nowhere = (over: Partial<TargetObservation> = {}) =>
    observeAt(null, { resolvedPayloadTickets: RESOLVED_LINKS, ...over });

  it("quarantines a legacy record carrying only expectedId", () => {
    const legacy = { type: "issue_create", expectedId: "ISS-042", transitionId: "txn-c", provenance: PROV };
    expect(reasonOf(classifyPendingMutation(legacy, nowhere(), HOLDS_T1))).toBe("legacy-payload");
    expect(reasonOf(classifyPendingMutation(legacy, foundAt("ISS-042"), HOLDS_T1))).toBe("legacy-payload");
  });

  it("quarantines when the record stores no digest to recognize the result by", () => {
    for (const over of [
      { content: undefined },
      { content: {} },
      { content: { payload: CREATE_PAYLOAD } },
      { content: { payload: CREATE_PAYLOAD, semanticFingerprint: "" } },
      { content: { payload: CREATE_PAYLOAD, semanticFingerprint: 7 } },
      // The old key name. A record written by the previous shape is legacy.
      { content: { payload: CREATE_PAYLOAD, fingerprint: "sha-ours" } },
      { content: "sha-ours" },
    ]) {
      expect(reasonOf(classifyPendingMutation(create(over), nowhere(), HOLDS_T1)), JSON.stringify(over))
        .toBe("legacy-payload");
    }
  });

  it("refuses a payload no create could be performed from", () => {
    // "A payload is present" is not "a create can be performed". Each of these
    // passes a presence check and none of them can be submitted, so a REPLAY
    // verdict on any of them would be a promise the consumer cannot keep.
    const unusable: unknown[] = [
      undefined, null, false, 0, "an issue", ["an issue"], {},
      // An ARRAY carrying the right properties. JSON cannot persist this, but
      // the reader takes `unknown` and is exported, so the guard is real.
      Object.assign([], CREATE_PAYLOAD),
      { ...CREATE_PAYLOAD, title: "" },
      { ...CREATE_PAYLOAD, severity: undefined },
      { ...CREATE_PAYLOAD, impact: 7 },
      { ...CREATE_PAYLOAD, components: "autonomous" },
      { ...CREATE_PAYLOAD, relatedTickets: [7] },
      { ...CREATE_PAYLOAD, location: null },
      // Sparse arrays. `every` skips holes, so each of these passes a naive
      // check while holding no string at that index at all.
      { ...CREATE_PAYLOAD, components: Array(1) },
      { ...CREATE_PAYLOAD, relatedTickets: Array(2) },
      { ...CREATE_PAYLOAD, location: [...Array(1), "x"] },
      { ...CREATE_PAYLOAD, phase: 7 },
      // The identity itself. A create with no dedupe key produces an issue
      // nothing can afterwards match to this record.
      { ...CREATE_PAYLOAD, dedupeKey: undefined },
      { ...CREATE_PAYLOAD, dedupeKey: "" },
      { ...CREATE_PAYLOAD, dedupeKey: 7 },
    ];
    for (const payload of unusable) {
      expect(readIssueCreatePayload(payload), JSON.stringify(payload)).toBeNull();
      expect(
        reasonOf(classifyPendingMutation(
          create({ content: { payload, semanticFingerprint: "sha-ours" } }), nowhere(), HOLDS_T1,
        )),
        JSON.stringify(payload),
      ).toBe("malformed-record");
    }
    // A null phase is meaningful rather than malformed.
    expect(readIssueCreatePayload({ ...CREATE_PAYLOAD, phase: null })).not.toBeNull();
  });

  it("refuses a record that names no expected id", () => {
    for (const over of [{ expectedId: undefined }, { expectedId: "" }]) {
      expect(reasonOf(classifyPendingMutation(create(over), nowhere(), HOLDS_T1)), JSON.stringify(over))
        .toBe("unidentifiable-target");
    }
  });

  it("replays when the key is nowhere in the ledger", () => {
    expect(classifyPendingMutation(create(), nowhere(), HOLDS_T1)).toEqual({ kind: "replay" });
  });

  it("refuses to replay a payload whose links disagree with what resolved", () => {
    // The record looks fine and its digest is self-consistent. What it cannot
    // show is that its links are the IDENTITIES the ledger holds rather than
    // aliases, and an alias is rewritten by the create into something this
    // record could never afterwards recognize.
    for (const resolvedPayloadTickets of [
      null,                                     // the caller offered no resolution
      minted(["t-somethingelse00"]),            // they resolve to a different ticket
      minted([]),                               // they resolve to nothing
      minted([...CREATE_PAYLOAD.relatedTickets, "t-extra0000000000"]),
    ]) {
      const label = JSON.stringify(resolvedPayloadTickets);
      expect(
        reasonOf(classifyPendingMutation(create(), nowhere({ resolvedPayloadTickets }), HOLDS_T1)),
        label,
      ).toBe("malformed-record");
      expect(
        reasonOf(classifyPendingMutation(create(), foundAt("ISS-107", { resolvedPayloadTickets }), HOLDS_T1)),
        label,
      ).toBe("malformed-record");
    }
    // Order and duplication are not disagreement: it is the same set. The
    // resolution here is the real one, taken from the fixture ledger.
    const twoLinks = { ...CREATE_PAYLOAD, relatedTickets: TWO_LINKS };
    const record = { ...create(), content: { payload: twoLinks, semanticFingerprint: issueCreateFingerprint(twoLinks)! } };
    expect(classifyPendingMutation(record, nowhere({ resolvedPayloadTickets: RESOLVED_TWO }), HOLDS_T1))
      .toEqual({ kind: "replay" });
    expect([...RESOLVED_TWO].sort(), "and it is not a copy of the record")
      .toEqual([...TWO_LINKS].sort());
  });

  it("refuses a resolution that no resolver produced, even a correct one", () => {
    // The bypass a branded type alone cannot close: a caller that skips the
    // resolver and hands back the very list it was asked to authenticate. A
    // cast satisfies the type and not the registry, so this is refused as an
    // observation rather than believed as a resolution -- and being RIGHT is
    // not the same as being proven, so the correct list is refused too.
    const copied = asResolved([...CREATE_PAYLOAD.relatedTickets]);
    expect(reasonOf(classifyPendingMutation(create(), nowhere({ resolvedPayloadTickets: copied }), HOLDS_T1)))
      .toBe("malformed-observation");
    expect(reasonOf(classifyPendingMutation(create(), foundAt("ISS-107", { resolvedPayloadTickets: copied }), HOLDS_T1)))
      .toBe("malformed-observation");
    // Including the case that matters: an alias, self-confirmed. Left believed,
    // it would replay, get rewritten by the create, and never converge.
    const spelled = { ...CREATE_PAYLOAD, relatedTickets: ["T-001"] };
    const record = { ...create(), content: { payload: spelled, semanticFingerprint: issueCreateFingerprint(spelled)! } };
    expect(reasonOf(classifyPendingMutation(
      record, nowhere({ resolvedPayloadTickets: asResolved(spelled.relatedTickets) }), HOLDS_T1,
    ))).toBe("malformed-observation");
    // And a copy of a genuine resolution is not the genuine resolution: the
    // registry answers for the OBJECT, not for the values in it.
    expect(reasonOf(classifyPendingMutation(
      create(), nowhere({ resolvedPayloadTickets: asResolved([...RESOLVED_LINKS]) }), HOLDS_T1,
    ))).toBe("malformed-observation");
  });

  it("refuses a resolution the caller could not even have produced", () => {
    // Distinct from "they disagree": these are not a list of identities at all.
    // A sparse one is included because `every` skips holes, so it would pass a
    // naive element check while holding nothing at that index.
    for (const bad of ["t-abcdefgh23456789", 7, {}, [7], Array(1)]) {
      expect(
        reasonOf(classifyPendingMutation(
          create(), malformed({ ...nowhere(), resolvedPayloadTickets: bad }), HOLDS_T1,
        )),
        JSON.stringify(bad),
      ).toBe("malformed-observation");
    }
    // Including one that IS registered. Provenance is not shape: a resolution
    // that came from the right place and holds the wrong things is still an
    // observation that cannot decide anything.
    for (const bad of [[7], [null], Array(1)]) {
      expect(
        reasonOf(classifyPendingMutation(
          create(),
          malformed({ ...nowhere(), resolvedPayloadTickets: minted(bad as unknown as string[]) }),
          HOLDS_T1,
        )),
        `registered ${JSON.stringify(bad)}`,
      ).toBe("malformed-observation");
    }
  });

  it("recognizes its own issue at a DIFFERENT id than the one it expected", () => {
    // The property the whole variant turns on, and NOT a string comparison
    // between two copies of the same literal: the stored digest comes from the
    // pre-create payload and the observed one is projected here from an entity
    // carrying an allocated id, order and dates the preparer never saw.
    const outcome = classifyPendingMutation(create(), foundAt("ISS-107"), HOLDS_T1);
    expect(outcome).toEqual({ kind: "applied" });
    // Prove the two sides really were different objects.
    const stored = (create().content as { semanticFingerprint: string }).semanticFingerprint;
    expect(canonicalContentFingerprint(landedIssue("ISS-107"))).not.toBe(stored);
  });

  it("ignores every field a create does not control", () => {
    // Allocation drift, ordering and dates must not change the answer; a
    // whole-entity digest would have made each of these a foreign occupant.
    for (const over of [
      { order: 999 }, { discoveredDate: "2027-01-01" }, { status: "inprogress" },
      { resolution: "later" }, { resolvedDate: "2027-01-01" },
    ]) {
      expect(
        classifyPendingMutation(create(), foundAt("ISS-107", { entity: landedIssue("ISS-107", over) }), HOLDS_T1),
        JSON.stringify(over),
      ).toEqual({ kind: "applied" });
    }
  });

  it("treats the ticket links as a SET of content, not as an ordered list", () => {
    // Order and multiplicity are not content: resolution can map two
    // references onto one ticket, and nothing about a link set is sequential.
    const twoLinks = { ...CREATE_PAYLOAD, relatedTickets: TWO_LINKS };
    const record = { ...create(), content: { payload: twoLinks, semanticFingerprint: issueCreateFingerprint(twoLinks)! } };
    for (const relatedTickets of [
      [TWO_LINKS[1], TWO_LINKS[0]],
      [TWO_LINKS[0], TWO_LINKS[1], TWO_LINKS[0]],
    ]) {
      expect(
        classifyPendingMutation(record, foundAt("ISS-107", {
          entity: landedIssue("ISS-107", { relatedTickets }),
          resolvedPayloadTickets: RESOLVED_TWO,
        }), HOLDS_T1),
        JSON.stringify(relatedTickets),
      ).toEqual({ kind: "applied" });
    }
    // A genuinely different set of links is a different issue.
    for (const relatedTickets of [["t-other"], [], ["t-abcdefgh23456789", "t-extra"]]) {
      expect(
        reasonOf(classifyPendingMutation(create(), foundAt("ISS-107", { entity: landedIssue("ISS-107", { relatedTickets }) }), HOLDS_T1)),
        JSON.stringify(relatedTickets),
      ).toBe("foreign-occupant");
    }
  });

  it("refuses an entity that is not the thing at the identity being authenticated", () => {
    // Content from one issue must not authenticate an observation of another.
    // The entity carries its own identity, so it is checked against the one
    // the observation claims rather than assumed to match it.
    expect(reasonOf(classifyPendingMutation(
      create(), foundAt("ISS-107", { entity: landedIssue("ISS-900") }), HOLDS_T1,
    ))).toBe("malformed-observation");
    // Both ledger forms are recognized, in ONE identity domain: the canonical
    // `id`. A post-migration item is found at its hash, and the entity there
    // carries that hash, so all three agree...
    const migrated = { ...landedIssue("ISS-107"), id: "i-9f2cabcdefgh2345" };
    expect(classifyPendingMutation(
      create(), foundAt("i-9f2cabcdefgh2345", { entity: migrated, dedupeKeyAt: "i-9f2cabcdefgh2345" }), HOLDS_T1,
    )).toEqual({ kind: "applied" });
    // ...and a legacy item, whose canonical id IS its display id, agrees too.
    const legacyShaped = landedIssue("ISS-107");
    delete (legacyShaped as Record<string, unknown>).displayId;
    expect(classifyPendingMutation(create(), foundAt("ISS-107", { entity: legacyShaped }), HOLDS_T1))
      .toEqual({ kind: "applied" });
    // But a post-migration item reported at its DISPLAY id is two domains
    // mixed. Reading `displayId` first -- which an earlier revision did -- made
    // this pass and made the migrated case above impossible instead.
    expect(reasonOf(classifyPendingMutation(
      create(), foundAt("ISS-107", { entity: migrated }), HOLDS_T1,
    ))).toBe("malformed-observation");
  });

  it("refuses reflection that throws inside the create's own content and payload", () => {
    // The create variant reads two more layers than a field write does, and
    // both are structure off disk: the `content` wrapper and the `payload`
    // inside it. Each gets the same refusal rather than an escape.
    const hostile = (): unknown =>
      new Proxy({}, {
        ownKeys() { throw new Error("hostile reflection"); },
        get() { throw new Error("hostile reflection"); },
      });
    for (const content of [
      hostile(),
      { payload: hostile(), semanticFingerprint: "sha-x" },
    ]) {
      expect(() => classifyPendingMutation(create({ content }), nowhere(), HOLDS_T1)).not.toThrow();
      expect(classifyPendingMutation(create({ content }), nowhere(), HOLDS_T1).kind).toBe("quarantine");
    }
    // And the payload reader on its own, which the prepare side also uses.
    expect(() => readIssueCreatePayload(hostile())).not.toThrow();
    expect(readIssueCreatePayload(hostile())).toBeNull();
  });

  it("refuses a record whose stored digest is not a digest of its own payload", () => {
    // Otherwise the record could replay payload A while carrying the digest of
    // entity B, and then be unable to recognize what it created.
    const wrong = { payload: CREATE_PAYLOAD, semanticFingerprint: "sha-somebody-elses" };
    expect(reasonOf(classifyPendingMutation(create({ content: wrong }), nowhere(), HOLDS_T1))).toBe("malformed-record");
    expect(reasonOf(classifyPendingMutation(create({ content: wrong }), foundAt("ISS-107"), HOLDS_T1))).toBe("malformed-record");
    // Including digests that are genuinely computed, but of other content.
    for (const other of [
      { ...CREATE_PAYLOAD, title: "a different issue" },
      { ...CREATE_PAYLOAD, relatedTickets: ["t-other"] },
      { ...CREATE_PAYLOAD, phase: "p2" },
    ]) {
      const mismatched = { payload: CREATE_PAYLOAD, semanticFingerprint: issueCreateFingerprint(other)! };
      expect(reasonOf(classifyPendingMutation(create({ content: mismatched }), nowhere(), HOLDS_T1)), JSON.stringify(other))
        .toBe("malformed-record");
    }
  });

  it("does NOT mistake a foreign issue carrying our key for our postimage", () => {
    for (const over of [
      { title: "a different issue" }, { severity: "critical" }, { impact: "different" },
      { components: ["other"] }, { location: ["x"] }, { phase: "p2" },
    ]) {
      expect(
        reasonOf(classifyPendingMutation(create(), foundAt("ISS-042", { entity: landedIssue("ISS-042", over) }), HOLDS_T1)),
        JSON.stringify(over),
      ).toBe("foreign-occupant");
    }
  });

  it("cross-checks the occupant's key against the payload's, rather than trusting the search", () => {
    expect(reasonOf(classifyPendingMutation(
      create(),
      observeAt("ISS-042", { dedupeKeyAt: "ISS-042", dedupeKey: "dk-other", contentFingerprint: "sha-ours", resolvedPayloadTickets: RESOLVED_LINKS }),
      HOLDS_T1,
    ))).toBe("foreign-occupant");
    expect(reasonOf(classifyPendingMutation(
      create(),
      observeAt("ISS-042", { dedupeKeyAt: "ISS-042", dedupeKey: null, contentFingerprint: "sha-ours", resolvedPayloadTickets: RESOLVED_LINKS }),
      HOLDS_T1,
    ))).toBe("foreign-occupant");
  });

  it("refuses an observation that found the key and then looked somewhere else", () => {
    expect(reasonOf(classifyPendingMutation(
      create(),
      observeAt("ISS-999", { dedupeKeyAt: "ISS-042", dedupeKey: "dk-1", contentFingerprint: "sha-ours", resolvedPayloadTickets: RESOLVED_LINKS }),
      HOLDS_T1,
    ))).toBe("malformed-observation");
  });

  it("refuses to replay when the key WAS found and the caller observed nothing", () => {
    // The dangerous direction. The ledger says our issue exists; the caller
    // handed over nothing to look at. Concluding from "nothing is here" would
    // create a second copy of an issue that already exists.
    expect(reasonOf(classifyPendingMutation(
      create(),
      malformed({
        exists: false, identity: null, dedupeKey: null, dedupeKeyAt: "ISS-107",
        resolvedPayloadTickets: RESOLVED_LINKS, contentFingerprint: null,
      }),
      HOLDS_T1,
    ))).toBe("malformed-observation");
  });

  it("refuses an observation that found the key nowhere and still observed something", () => {
    // Two answers at once: the caller had nothing of ours to look at.
    expect(reasonOf(classifyPendingMutation(
      create(),
      observeAt("ISS-042", { contentFingerprint: "sha-ours", resolvedPayloadTickets: RESOLVED_LINKS }),
      HOLDS_T1,
    ))).toBe("malformed-observation");
  });

  it("refuses an entity that cannot even say which issue it is", () => {
    // Identity is checked before content, so these fail at the binding rather
    // than at the projection. An ARRAY is included because one carrying every
    // projected field would digest cleanly, and an issue is not an array.
    for (const entity of [undefined, null, "an issue", ["an issue"], { title: "only a title" },
      Object.assign([], landedIssue("ISS-042"))]) {
      expect(reasonOf(classifyPendingMutation(create(), foundAt("ISS-042", { entity }), HOLDS_T1)), JSON.stringify(entity))
        .toBe("malformed-observation");
    }
  });

  it("refuses to conclude anything when the right occupant cannot be projected", () => {
    // These ARE the issue at the observed identity; they simply hold a
    // projected field in a shape the projection cannot read, so the answer is
    // "cannot tell" rather than "somebody else's".
    for (const over of [
      { relatedTickets: "t-abcdefgh23456789" }, { relatedTickets: [7] }, { phase: 7 },
      { components: null }, { impact: 7 }, { dedupeKey: undefined },
    ]) {
      expect(
        reasonOf(classifyPendingMutation(create(), foundAt("ISS-042", { entity: landedIssue("ISS-042", over) }), HOLDS_T1)),
        JSON.stringify(over),
      ).toBe("unconfirmed-postimage");
    }
  });
});

// ---------------------------------------------------------------------------
// The brand's mint point, tested as its own contract
// ---------------------------------------------------------------------------

describe("T-450 step 4: canonical ticket identities can only be minted by checking", () => {
  const anyList = (v: unknown) => v as readonly string[];
  const A = "t-abcdefgh23456789";
  const B = "t-bbcdefgh23456789";

  it("mints the brand only when both sides agree as sets", () => {
    expect(asCanonicalTicketIdentities([A], minted([A]))).toEqual([A]);
    expect(asCanonicalTicketIdentities([A, B], minted([B, A, B]))).toEqual([A, B]);
    expect(asCanonicalTicketIdentities([A], minted([B]))).toBeNull();
    expect(asCanonicalTicketIdentities([A], minted([A, B]))).toBeNull();
    expect(asCanonicalTicketIdentities([], minted([A]))).toBeNull();
  });

  it("accepts BOTH ledger id forms, because both are canonical", () => {
    // The ledger is permanently mixed: a legacy ticket's canonical id IS its
    // display-form value, and a post-migration ticket's is a hash. A rule that
    // read the hash syntax as canonical would quarantine every create linked to
    // a legacy ticket, which is most of this repo's own tickets.
    expect(asCanonicalTicketIdentities(["T-001"], minted(["T-001"]))).toEqual(["T-001"]);
    expect(asCanonicalTicketIdentities(["T-079b"], minted(["T-079b"]))).toEqual(["T-079b"]);
    expect(asCanonicalTicketIdentities([A, "T-001"], minted(["T-001", A]))).toEqual([A, "T-001"]);
  });

  it("refuses a resolution that no resolver produced", () => {
    // What stops a caller confirming a record with a copy of itself. The brand
    // is a type and a type cannot stop a cast, so the check is a registry: only
    // the object a resolver returned counts, never an equal one.
    expect(asCanonicalTicketIdentities([A], asResolved([A]))).toBeNull();
    expect(asCanonicalTicketIdentities(["T-001"], asResolved(["T-001"]))).toBeNull();
    const real = minted([A]);
    expect(asCanonicalTicketIdentities([A], real), "the control").toEqual([A]);
    expect(asCanonicalTicketIdentities([A], asResolved([...real])), "a copy is not it").toBeNull();
  });

  it("refuses to brand anything that is not a list of strings", () => {
    // This function is EXPORTED and is the only place the brand is minted, so
    // its shape guard cannot rest on its current callers happening to validate
    // first. A branded value obtained from an unchecked input would make the
    // type a claim nothing checked. Sparse arrays are included because `every`
    // skips holes: without the length check, `Array(1)` compares equal to
    // itself as a set of one `undefined` and would mint the brand.
    const bad: unknown[] = [null, undefined, "t-a", 7, {}, [7], [null], Array(1), [...Array(1), A]];
    for (const v of bad) {
      expect(asCanonicalTicketIdentities(anyList(v), minted([A])), `stored ${JSON.stringify(v)}`).toBeNull();
    }
    // The resolved side is checked too, though only a list can be registered at
    // all, so the cases here are the lists that hold the wrong things.
    for (const v of [[7], [null], Array(1), [...Array(1), A]]) {
      expect(asCanonicalTicketIdentities([A], minted(anyList(v))), `resolved ${JSON.stringify(v)}`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The resolver mint point, tested as its own contract
// ---------------------------------------------------------------------------

describe("T-450 step 4: a resolution can only be obtained by resolving", () => {
  let mintRoot: string;
  let mintState: Awaited<ReturnType<typeof loadProject>>["state"];

  beforeAll(async () => {
    mintRoot = buildRepo();
    writeAliasedTicket(mintRoot);
    // A second, LEGACY ticket, so a substituted ref can resolve to something
    // real rather than merely failing to resolve. A test where the substitution
    // just errors cannot tell "the wrong ref was refused" from "the wrong ref
    // was never read".
    writeLegacyTicket(mintRoot, "T-002");
    ({ state: mintState } = await loadProject(mintRoot));
  });
  afterAll(() => {
    rmSync(mintRoot, { recursive: true, force: true });
  });

  it("rewrites a display spelling into the canonical identity", () => {
    // The whole reason the brand exists. A caller cannot produce this by
    // copying the record: the value that comes back is not the value handed in.
    expect(resolvePayloadTicketIdentities(mintState, ["T-001"])).toEqual(["t-abcdefgh23456789"]);
    expect(resolvePayloadTicketIdentities(mintState, ["t-abcdefgh23456789"])).toEqual(["t-abcdefgh23456789"]);
    expect(resolvePayloadTicketIdentities(mintState, [])).toEqual([]);
  });

  it("returns null rather than a resolution when a ref does not resolve", () => {
    // A real answer, not an error. A record naming a ticket that no longer
    // exists is one recovery must refuse to replay, and minting the refs
    // unresolved would hand back a resolution that resolved nothing.
    expect(resolvePayloadTicketIdentities(mintState, ["T-999"])).toBeNull();
    expect(resolvePayloadTicketIdentities(mintState, ["t-zzzzzzzzzzzzzzzz"])).toBeNull();
    expect(resolvePayloadTicketIdentities(mintState, ["T-001", "T-999"])).toBeNull();
  });

  it("refuses ref lists that are not lists of non-empty strings", () => {
    const bad: unknown[] = [null, undefined, "T-001", 7, {}, [7], [null], [""], Array(1), [...Array(1), "T-001"]];
    for (const refs of bad) {
      expect(
        resolvePayloadTicketIdentities(mintState, refs as readonly string[]),
        JSON.stringify(refs),
      ).toBeNull();
    }
  });

  it("refuses a ref list whose hole is padded by an unrelated own key", () => {
    // The failure a count-only check cannot see. `Object.keys` counts the
    // padding and stops counting the hole, `every` skips holes outright, so
    // this list passes an element check while holding nothing at index 1 -- and
    // gets minted as a proven resolution with a gap in it.
    const padded = () => {
      const a: unknown[] = [];
      a[0] = "T-001";
      a[2] = "T-001";
      (a as unknown as Record<string, unknown>).note = "pad";
      return a;
    };
    expect(Object.keys(padded()).length, "the pad really does balance the count").toBe(padded().length);
    expect(padded().every((r) => typeof r === "string"), "and the element check does not see the hole").toBe(true);
    expect(resolvePayloadTicketIdentities(mintState, padded() as readonly string[])).toBeNull();

    // Same shape, padded with a symbol key, which `getOwnPropertyNames` cannot
    // see at all.
    const symPadded = () => {
      const a: unknown[] = [];
      a[0] = "T-001";
      a[2] = "T-001";
      (a as unknown as Record<symbol, unknown>)[Symbol("pad")] = 1;
      return a;
    };
    expect(resolvePayloadTicketIdentities(mintState, symPadded() as readonly string[])).toBeNull();

    // And a DENSE list carrying a symbol key, where the index count notices
    // nothing at all. A symbol key cannot survive JSON, so this list was built
    // by code rather than read from the payload it claims to be.
    const symDense = () => {
      const a: unknown[] = ["T-001"];
      (a as unknown as Record<symbol, unknown>)[Symbol("pad")] = 1;
      return a;
    };
    expect(Object.getOwnPropertyNames(symDense()).length, "the count sees nothing wrong")
      .toBe(symDense().length + 1);
    expect(resolvePayloadTicketIdentities(mintState, symDense() as readonly string[])).toBeNull();
  });

  it("refuses a ref list whose own reflection throws, rather than propagating", () => {
    // `Array.isArray` is true of a proxy over an array, so the structural
    // reader really does reach the traps. A throw here would escape the mint
    // point into whatever asked it to resolve.
    const hostile = new Proxy(["T-001"], {
      ownKeys() { throw new Error("hostile refs"); },
      get() { throw new Error("hostile refs"); },
    });
    expect(Array.isArray(hostile), "the reader does not skip it as a non-array").toBe(true);
    expect(() => resolvePayloadTicketIdentities(mintState, hostile)).not.toThrow();
    expect(resolvePayloadTicketIdentities(mintState, hostile)).toBeNull();

    // And a REVOKED proxy, where `Array.isArray` itself throws before any trap
    // can run, so a shape guard ahead of the boundary would escape it.
    const { proxy: dead, revoke } = Proxy.revocable(["T-001"], {});
    revoke();
    expect(() => Array.isArray(dead), "the premise: this really does throw").toThrow(TypeError);
    expect(() => resolvePayloadTicketIdentities(mintState, dead)).not.toThrow();
    expect(resolvePayloadTicketIdentities(mintState, dead)).toBeNull();
  });

  it("refuses a ref list holding an accessor, without invoking it", () => {
    // A getter is read once by the check and again by whatever consumes the
    // result, and it may answer differently each time -- so what was verified
    // and what gets resolved would not be the same list. Reading descriptors
    // means it is never invoked at all, which is also why an accessor that
    // THROWS cannot take the classification down with it.
    let reads = 0;
    const withGetter = () => {
      const a: unknown[] = ["T-001"];
      Object.defineProperty(a, 0, { get: () => `T-00${++reads}`, enumerable: true, configurable: true });
      return a;
    };
    expect(resolvePayloadTicketIdentities(mintState, withGetter() as readonly string[])).toBeNull();
    const withThrowingGetter = () => {
      const a: unknown[] = ["T-001"];
      Object.defineProperty(a, 0, {
        get: () => {
          reads++;
          throw new Error("hostile ref");
        },
        enumerable: true,
        configurable: true,
      });
      return a;
    };
    expect(() => resolvePayloadTicketIdentities(mintState, withThrowingGetter() as readonly string[]))
      .not.toThrow();
    expect(resolvePayloadTicketIdentities(mintState, withThrowingGetter() as readonly string[])).toBeNull();
    expect(reads, "and no getter was invoked").toBe(0);
  });

  it("resolves the checked copy, not the caller's array, which reads by iterator", () => {
    // The other half of "what was verified is what gets resolved", and the one
    // a reflection-only reading misses. `ownStringArray` checks the INDEXED
    // elements through descriptors, but `resolveAndNormalizeTicketRefs`
    // consumes its argument with `for...of` -- so the array's ITERATOR decides
    // what actually gets resolved. An exotic array can disagree with itself
    // across those two channels while passing every structural check, because
    // the iterator lives on the prototype and owns no property the boundary
    // can see.
    class AliasedRefs extends Array<string> {
      *[Symbol.iterator](): IterableIterator<string> {
        yield "T-002";
      }
    }
    const refs = new AliasedRefs();
    refs.push("T-001");

    // The premise: this list passes the own-data boundary intact.
    expect(Array.isArray(refs), "an array subclass is still an array").toBe(true);
    expect(Object.getOwnPropertyNames(refs), "and owns nothing extra").toEqual(["0", "length"]);
    expect(refs[0], "indexed, it holds the ref that was checked").toBe("T-001");
    // ...and says something else entirely when iterated.
    expect([...refs], "iterated, it holds another one").toEqual(["T-002"]);

    // So the resolution must be of T-001, whose canonical id is the hash form.
    // Resolving the caller's array instead would mint a proven resolution of
    // T-002: a different, real ticket that no check ever looked at.
    expect(resolvePayloadTicketIdentities(mintState, refs)).toEqual(["t-abcdefgh23456789"]);
  });

  it("registers a COPY, so a resolution cannot be edited after it is proven", () => {
    // Registering the caller's own array would let it mint an honest list, pass
    // the check, and then edit the array into an alias afterwards. The proven
    // thing has to be a thing the caller no longer holds.
    const source = ["t-abcdefgh23456789"];
    const registered = markResolvedTicketIdentities(source);
    source[0] = "T-001";
    expect(registered, "the registered value is not the caller's array").toEqual(["t-abcdefgh23456789"]);
    expect(resolvePayloadTicketIdentities(mintState, ["T-001"])).toEqual(["t-abcdefgh23456789"]);
  });
});

// ---------------------------------------------------------------------------
// Own properties only
// ---------------------------------------------------------------------------

describe("T-450 step 4: a record is read from its OWN fields, never from a prototype", () => {
  const PAYLOAD = {
    title: "t", severity: "medium", impact: "i", components: [], location: [],
    relatedTickets: ["t-abcdefgh23456789"], dedupeKey: "dk-1",
  };
  const ISSUE = { ...PAYLOAD, id: "ISS-042", displayId: "ISS-042", order: 1 };

  it("refuses a payload whose required fields are inherited", () => {
    // The input is `unknown` because it may be old, hand-edited, or written by
    // a build this one does not know. An otherwise empty object whose prototype
    // supplies `title` and `dedupeKey` would authorize a replay of a create
    // that has no content of its own.
    expect(readIssueCreatePayload(Object.create(PAYLOAD))).toBeNull();
    expect(readIssueCreatePayload({ ...Object.create(PAYLOAD), title: "t" })).toBeNull();
    expect(readIssueCreatePayload({ ...PAYLOAD }), "the own-field control").not.toBeNull();
  });

  it("refuses provenance, snapshots and entities whose fields are inherited", () => {
    expect(readProvenance(Object.create({ ownerTask: "task-a", revision: 7, ticket: null }))).toBeNull();
    expect(readSnapshot(Object.create({ present: true, value: "open" }))).toBeNull();
    expect(readSnapshot(Object.create({ present: false }))).toBeNull();
    expect(issueCreateFingerprint(Object.create(ISSUE))).toBeNull();
    // The control, so this is a statement about inheritance and not about the
    // readers refusing everything.
    expect(readProvenance({ ownerTask: "task-a", revision: 7, ticket: null })).not.toBeNull();
    expect(readSnapshot({ present: true, value: "open" })).not.toBeNull();
    expect(issueCreateFingerprint({ ...ISSUE })).not.toBeNull();
  });

  it("refuses a top-level record whose fields are inherited", () => {
    const real = {
      type: "issue_update", target: "ISS-042", field: "status", value: "inprogress",
      transitionId: "txn-1", provenance: PROV,
      preimage: { present: true, value: "open" }, postimage: { present: true, value: "inprogress" },
    };
    expect(reasonOf(classifyPendingMutation(Object.create(real), observeAt("ISS-042"), NO_AUTHORITY)))
      .toBe("no-provenance");
    // And the quarantine record built from one attributes it to nobody rather
    // than reading an owner off the prototype.
    expect(buildQuarantineRecord(Object.create(real), "no-provenance", "T"))
      .toMatchObject({ kind: "unknown", displacedOwner: null });
  });

  it("refuses fields that are accessors rather than data", () => {
    // A getter can answer differently on each read, and several fields here are
    // read more than once, so the two sides of a comparison would not be
    // reading the same thing.
    const shifty = (base: object, key: string, value: unknown) =>
      Object.defineProperty({ ...base }, key, { get: () => value, enumerable: true, configurable: true });
    expect(readIssueCreatePayload(shifty(PAYLOAD, "title", "t"))).toBeNull();
    expect(readProvenance(shifty({ ownerTask: "task-a", revision: 7, ticket: null }, "revision", 7))).toBeNull();
    expect(readSnapshot(shifty({ present: true, value: "open" }, "value", "open"))).toBeNull();
    expect(issueCreateFingerprint(shifty(ISSUE, "dedupeKey", "dk-1"))).toBeNull();
  });

  it("refuses an OBSERVATION whose fields are inherited or are accessors", () => {
    // The observation is structure this module did not build either. Read
    // directly, an inherited `dedupeKeyAt` or a getter answering differently on
    // two reads would decide a verdict.
    const real = {
      exists: true, identity: "ISS-042", dedupeKey: "dk-1", dedupeKeyAt: "ISS-042",
      resolvedPayloadTickets: null, entity: undefined,
      contentFingerprint: null,
    };
    const record = {
      type: "issue_update", target: "ISS-042", field: "status", value: "inprogress",
      transitionId: "txn-1", provenance: PROV,
      preimage: { present: true, value: "open" }, postimage: { present: true, value: "inprogress" },
    };
    const asObservation = (v: unknown) => v as TargetObservation;
    expect(reasonOf(classifyPendingMutation(record, asObservation(Object.create(real)), NO_AUTHORITY)))
      .toBe("malformed-observation");
    let reads = 0;
    const shifty = Object.defineProperty({ ...real }, "identity", {
      get: () => (reads++ === 0 ? "ISS-042" : "ISS-999"), enumerable: true, configurable: true,
    });
    expect(reasonOf(classifyPendingMutation(record, asObservation(shifty), NO_AUTHORITY)))
      .toBe("malformed-observation");
    expect(reads, "and the getter was never invoked at all").toBe(0);
  });

  it("refuses a record whose nested content is inherited or is an accessor", () => {
    // `content` comes straight off disk with the record around it, so it gets
    // the same treatment. An inherited `semanticFingerprint` would otherwise
    // let a record with no content of its own be recognized.
    const content = {
      payload: { ...PAYLOAD },
      semanticFingerprint: issueCreateFingerprint({ ...PAYLOAD })!,
    };
    const record = (over: unknown) => ({
      type: "issue_create", expectedId: "ISS-042", transitionId: "txn-c",
      provenance: PROV, content: over,
    });
    const observed = observeAt(null, { resolvedPayloadTickets: minted(PAYLOAD.relatedTickets) });
    expect(classifyPendingMutation(record(content), observed, HOLDS_T1), "the control")
      .toEqual({ kind: "replay" });
    expect(reasonOf(classifyPendingMutation(record(Object.create(content)), observed, HOLDS_T1)))
      .toBe("legacy-payload");
    const shifty = Object.defineProperty({ ...content }, "semanticFingerprint", {
      get: () => content.semanticFingerprint, enumerable: true, configurable: true,
    });
    expect(reasonOf(classifyPendingMutation(record(shifty), observed, HOLDS_T1)))
      .toBe("legacy-payload");
  });

  it("refuses an array whose elements are accessors rather than data", () => {
    // Dense, so the sparsity check passes. The getter would be invoked once
    // during validation and again by the digest, by a set comparison and by a
    // replay, and it may answer differently each time.
    let reads = 0;
    const shiftyList = () => {
      const a = ["t-abcdefgh23456789"];
      Object.defineProperty(a, 0, {
        get: () => (reads++ === 0 ? "t-abcdefgh23456789" : "t-somethingelse0"),
        enumerable: true, configurable: true,
      });
      return a;
    };
    expect(readIssueCreatePayload({ ...PAYLOAD, relatedTickets: shiftyList() })).toBeNull();
    expect(readIssueCreatePayload({ ...PAYLOAD, components: shiftyList() })).toBeNull();
    expect(issueCreateFingerprint({ ...ISSUE, location: shiftyList() })).toBeNull();
    expect(reads, "the getter was never invoked").toBe(0);
    // An array carrying an extra own property is not a list of strings either.
    const extra = Object.assign(["t-abcdefgh23456789"], { note: "x" });
    expect(readIssueCreatePayload({ ...PAYLOAD, relatedTickets: extra })).toBeNull();
  });

  it("reads list fields into copies, not into the caller's arrays", () => {
    // Otherwise a caller could hand over an honest list, watch it validate, and
    // then edit the array it still holds -- so the list a replay writes would
    // not be the list anything checked.
    const links = ["t-abcdefgh23456789"];
    const components = ["autonomous"];
    const payload = readIssueCreatePayload({ ...PAYLOAD, relatedTickets: links, components })!;
    expect(payload, "the control").not.toBeNull();
    links[0] = "T-001";
    components[0] = "something-else";
    expect(payload.relatedTickets).toEqual(["t-abcdefgh23456789"]);
    expect(payload.components).toEqual(["autonomous"]);
  });
});

// ---------------------------------------------------------------------------
// handover_create / snapshot_save: recognizable, never replayable
// ---------------------------------------------------------------------------

describe("T-450 step 4: content artifacts are recognized or quarantined, never rewritten", () => {
  const kinds = ["handover_create", "snapshot_save"] as const;
  const NAME = "2026-07-31-x.md";

  function artifact(type: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type,
      filename: NAME,
      transitionId: "txn-h",
      provenance: PROV,
      contentFingerprint: "sha-ours",
      ...over,
    };
  }
  const atFile = (over: Partial<TargetObservation> = {}) => observeAt(NAME, over);

  it("quarantines a record whose filename is null, because it names no file", () => {
    // `filename` is declared nullable on both variants, and a null one cannot
    // be matched to any observation however good the digest is.
    for (const type of kinds) {
      expect(reasonOf(classifyPendingMutation(
        artifact(type, { filename: null }),
        atFile({ contentFingerprint: "sha-ours" }),
        HOLDS_T1,
      )), type).toBe("unidentifiable-target");
    }
  });

  it("refuses when the observation was taken at a different filename", () => {
    for (const type of kinds) {
      expect(reasonOf(classifyPendingMutation(
        artifact(type),
        observeAt("someone-elses.md", { contentFingerprint: "sha-ours" }),
        HOLDS_T1,
      )), type).toBe("identity-mismatch");
    }
  });

  it("quarantines when the record stored no fingerprint, because nothing can confirm it", () => {
    for (const type of kinds) {
      expect(reasonOf(classifyPendingMutation(artifact(type, { contentFingerprint: undefined }), atFile(), HOLDS_T1)), type)
        .toBe("unverifiable-content");
    }
  });

  it("recognizes its own artifact by filename and fingerprint", () => {
    for (const type of kinds) {
      expect(classifyPendingMutation(artifact(type), atFile({ contentFingerprint: "sha-ours" }), HOLDS_T1), type)
        .toEqual({ kind: "applied" });
    }
  });

  it("does not accept a file at the same name holding someone else's content", () => {
    for (const type of kinds) {
      expect(reasonOf(classifyPendingMutation(artifact(type), atFile({ contentFingerprint: "sha-theirs" }), HOLDS_T1)), type)
        .toBe("foreign-occupant");
    }
  });

  it("never replays, across the whole observation space", () => {
    // The body was never stored, so a replay would have to invent it. This is
    // the property, asserted over every combination rather than one case.
    for (const type of kinds) {
      for (const stored of [undefined, "sha-ours"]) {
        // The file is gone: the only valid observation of nothing.
        expect(
          classifyPendingMutation(artifact(type, { contentFingerprint: stored }), observeAt(null), HOLDS_T1).kind,
          `${type} absent ${stored}`,
        ).not.toBe("replay");

        for (const contentFingerprint of [null, "sha-ours", "sha-theirs"]) {
          for (const identity of [NAME, "someone-elses.md"]) {
            const outcome = classifyPendingMutation(
              artifact(type, { contentFingerprint: stored }),
              observeAt(identity, { contentFingerprint }),
              HOLDS_T1,
            );
            expect(outcome.kind, `${type} ${identity} ${contentFingerprint} ${stored}`).not.toBe("replay");
          }
        }
      }
    }
  });

  it("reports that a missing artifact cannot be rebuilt, rather than reporting a conflict", () => {
    for (const type of kinds) {
      expect(reasonOf(classifyPendingMutation(artifact(type), observeAt(null), HOLDS_T1)), type)
        .toBe("not-replayable");
    }
  });
});

// ---------------------------------------------------------------------------
// The canonicalization both sides use
// ---------------------------------------------------------------------------

describe("T-450 step 4: one canonicalization, used by both sides", () => {
  it("does not depend on property order", () => {
    expect(canonicalContentFingerprint({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(canonicalContentFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("treats an explicitly-undefined member and an omitted one as the same content", () => {
    expect(canonicalContentFingerprint({ a: 1, b: undefined })).toBe(canonicalContentFingerprint({ a: 1 }));
  });

  it("distinguishes content that actually differs, including null from absent", () => {
    const base = canonicalContentFingerprint({ a: 1, b: "x" });
    expect(canonicalContentFingerprint({ a: 1, b: "y" })).not.toBe(base);
    expect(canonicalContentFingerprint({ a: 1, b: null })).not.toBe(base);
    expect(canonicalContentFingerprint({ a: 1 })).not.toBe(base);
    expect(canonicalContentFingerprint({ a: 1, b: ["x"] })).not.toBe(base);
  });

  it("encodes an undefined member as null, the way JSON.stringify does", () => {
    // Reached for an explicitly-undefined ARRAY member, which the object
    // filter above never sees.
    expect(canonicalContentFingerprint({ a: [undefined] })).toBe(canonicalContentFingerprint({ a: [null] }));
    expect(canonicalContentFingerprint(undefined)).toBe(canonicalContentFingerprint(null));
  });

  it("encodes a HOLE the same way, and not as if the slot were absent", () => {
    // `[undefined]` is dense and would not catch this: `.map` invokes the
    // callback for it. A hole is skipped by `.map` and rendered as nothing by
    // `.join`, which would make a one-hole array digest identically to an empty
    // one. JSON persistence writes the hole as null, so a prediction containing
    // one would stop matching the entity actually written.
    expect(canonicalContentFingerprint(Array(1))).toBe(canonicalContentFingerprint([null]));
    expect(canonicalContentFingerprint(Array(1))).not.toBe(canonicalContentFingerprint([]));
    expect(canonicalContentFingerprint(Array(3))).toBe(canonicalContentFingerprint([null, null, null]));
  });

  it("preserves array order, which is content rather than layout", () => {
    expect(canonicalContentFingerprint({ a: [1, 2] })).not.toBe(canonicalContentFingerprint({ a: [2, 1] }));
  });
});

// ---------------------------------------------------------------------------
// The quarantine record
// ---------------------------------------------------------------------------

describe("T-450 step 4: quarantine is a durable record, not a drop", () => {
  it("carries kind, verbatim payload, reason, timestamp and the displaced owner", () => {
    const record = fieldWrite({ somethingThisBuildDoesNotKnow: { deep: [1, 2] } });
    const entry = buildQuarantineRecord(record, "conflict", "2026-07-31T00:00:00.000Z");
    expect(entry).toEqual({
      kind: "issue_update",
      payload: record,
      reason: "conflict",
      quarantinedAt: "2026-07-31T00:00:00.000Z",
      displacedOwner: "task-a",
    });
    // Verbatim means the unknown field survives: a reason and a kind describe
    // the decision, only the payload says what was lost.
    expect((entry.payload as Record<string, unknown>).somethingThisBuildDoesNotKnow).toEqual({ deep: [1, 2] });
  });

  it("records an unknown kind and a null owner rather than failing on a malformed record", () => {
    expect(buildQuarantineRecord({ transitionId: "t" }, "unknown-variant", "T")).toEqual({
      kind: "unknown", payload: { transitionId: "t" }, reason: "unknown-variant", quarantinedAt: "T", displacedOwner: null,
    });
    expect(buildQuarantineRecord(null, "no-provenance", "T").payload).toBeNull();
    expect(buildQuarantineRecord(undefined, "no-provenance", "T").payload).toBeNull();
    expect(buildQuarantineRecord("junk", "unknown-variant", "T"))
      .toMatchObject({ kind: "unknown", payload: "junk", displacedOwner: null });
  });

  it("reports a null displaced owner when provenance is present but the client had no identity", () => {
    const record = fieldWrite({ provenance: { ownerTask: null, revision: 1, ticket: null } });
    expect(buildQuarantineRecord(record, "conflict", "T").displacedOwner).toBeNull();
  });

  it("ignores a malformed provenance when naming the displaced owner", () => {
    // Not "read whatever string is there": the same validation that refuses to
    // authorize on a broken provenance refuses to attribute on one.
    for (const provenance of [{ ownerTask: "task-a", revision: "7" }, { ownerTask: "", revision: 1, ticket: null }]) {
      expect(buildQuarantineRecord(fieldWrite({ provenance }), "no-provenance", "T").displacedOwner).toBeNull();
    }
  });

  it("emits an audit event that omits the payload's bulk but keeps the attribution", () => {
    const entry = buildQuarantineRecord(fieldWrite(), "conflict", "2026-07-31T00:00:00.000Z");
    expect(quarantineEventData(entry)).toEqual({
      kind: "issue_update",
      reason: "conflict",
      displacedOwner: "task-a",
      quarantinedAt: "2026-07-31T00:00:00.000Z",
    });
    expect(quarantineEventData(entry)).not.toHaveProperty("payload");
    expect(QUARANTINE_EVENT_TYPE).toBe("mutation_quarantined");
  });
});

// ---------------------------------------------------------------------------
// The prepare site
// ---------------------------------------------------------------------------

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root });
}

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "t450-step4-"));
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "t450", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "t450", date: "2026-07-31",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({
    id: "ISS-001", title: "Issue ISS-001", status: "open", severity: "medium", components: [],
    impact: "test", resolution: null, location: [], discoveredDate: "2026-07-31",
    resolvedDate: null, relatedTickets: [], order: 10,
  }));
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

/** The canonical id of the post-migration issue fixture. */
const MIGRATED_ISSUE_ID = "i-9f2cabcdefgh2345";

/**
 * The same fixture with ISS-001 stored in POST-MIGRATION form: a hash `id`,
 * with the display id carried separately.
 *
 * The legacy fixture cannot show a difference between the two identity domains,
 * because its canonical id and its display id are the same string. Half of a
 * real ledger looks like this instead, and a prepare-to-recovery path that
 * only ever ran against the other half would quarantine all of it.
 */
function buildRepoMigrated(): string {
  const root = buildRepo();
  rmSync(join(root, ".story", "issues", "ISS-001.json"));
  writeFileSync(join(root, ".story", "issues", `${MIGRATED_ISSUE_ID}.json`), JSON.stringify({
    id: MIGRATED_ISSUE_ID, displayId: "ISS-001", title: "Issue ISS-001", status: "open",
    severity: "medium", components: [], impact: "test", resolution: null, location: [],
    discoveredDate: "2026-07-31", resolvedDate: null, relatedTickets: [], order: 10,
  }));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "migrated fixture"]);
  return root;
}

/**
 * A post-migration ticket: hash id, display id carried separately, so the
 * canonical identity and the spelling a caller would use are DIFFERENT.
 * Written only by the tests that need it -- an extra ticket changes what the
 * pick stage selects.
 */
function writeAliasedTicket(root: string): void {
  writeCanonicalTicket(root, "t-abcdefgh23456789", "T-001");
}

/**
 * A LEGACY ticket: the display id IS the canonical id, and there is no
 * `displayId` field at all. Both forms are canonical in this ledger.
 */
function writeLegacyTicket(root: string, id: string): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, title: `Ticket ${id}`, type: "task",
    status: "open", phase: "p1", order: 10, description: "", createdDate: "2026-07-31",
    completedDate: null, blockedBy: [], parentTicket: null,
  }));
}

function writeCanonicalTicket(root: string, id: string, displayId: string): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, displayId, title: `Ticket ${displayId}`, type: "task",
    status: "open", phase: "p1", order: 10, description: "", createdDate: "2026-07-31",
    completedDate: null, blockedBy: [], parentTicket: null,
  }));
}

function makeState(root: string, over: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000004a0",
    recipe: "coding", state: "PICK_TICKET", revision: 12, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: null, expectedHead: null, initHead: null, autoStash: null },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    ownerTask: { client: "claude", id: "task-prepare", boundAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, quarantinedMutations: [], resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
    ...over,
  } as unknown as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "IMPLEMENT", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block", branchStrategy: "current",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  } as unknown as ResolvedRecipe;
}

describe("T-450 step 4: the prepare site records what recovery cannot reconstruct", () => {
  let root: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  /**
   * Runs the real stage and captures the marker it writes BEFORE the project
   * write clears it. The record is then fed to the real classifier: if the
   * stage and the table ever disagree about the shape, this fails.
   */
  async function pickAndCapture(
    build: () => string = buildRepo,
  ): Promise<{ record: Record<string, unknown>; root: string }> {
    root = build();
    const dir = join(root, ".story", "sessions", "s");
    mkdirSync(dir, { recursive: true });
    const ctx = new StageContext(root, dir, makeState(root), makeRecipe());

    const seen: Record<string, unknown>[] = [];
    const real = ctx.writeState.bind(ctx);
    vi.spyOn(ctx, "writeState").mockImplementation((patch: Partial<FullSessionState>) => {
      const marker = (patch as { pendingProjectMutation?: unknown }).pendingProjectMutation;
      if (marker) seen.push(marker as Record<string, unknown>);
      return real(patch);
    });

    const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(result.action, "the issue pick should have advanced").toBe("goto");
    expect(seen, "the stage should have staged exactly one pending mutation").toHaveLength(1);
    return { record: seen[0]!, root };
  }

  /**
   * Put ISS-001 back to `open`, with the real command, so an observation can be
   * taken in the state a crash BEFORE the project write would have left. The
   * stage applies its write, so the pre-write state has to be restored rather
   * than assumed.
   */
  async function rewindStatus(r: string): Promise<void> {
    const { handleIssueUpdate } = await import("../../src/cli/commands/issue.js");
    await handleIssueUpdate("ISS-001", { status: "open" }, "json", r);
  }

  it("stages a marker a POST-MIGRATION issue can be recognized by, in one identity domain", async () => {
    // The half of the ledger the legacy fixture cannot exercise. The stage
    // records `target: issue.id`, which for a migrated issue is a hash rather
    // than the display id a caller typed, so the marker, the observation and
    // the entity have to agree in that one domain. An identity rule that
    // preferred `displayId` passes every legacy test above and quarantines
    // every record in this one.
    const { record, root: r } = await pickAndCapture(buildRepoMigrated);
    expect(record.target, "the marker names the canonical id, not the display id")
      .toBe(MIGRATED_ISSUE_ID);

    const { state } = await loadProject(r);
    const applied = state.issues.find(i => i.id === MIGRATED_ISSUE_ID);
    expect(applied?.status, "the stage should have applied the write").toBe("inprogress");
    expect(applied?.displayId, "and it really is the migrated shape").toBe("ISS-001");
    expect(classifyPendingMutation(record, observeAt(MIGRATED_ISSUE_ID, { entity: applied }), NO_AUTHORITY))
      .toEqual({ kind: "applied" });

    // ...and the state a crash before the project write would have left,
    // restored with the real command, replays from the same domain.
    await rewindStatus(r);
    const { state: back } = await loadProject(r);
    const before = back.issues.find(i => i.id === MIGRATED_ISSUE_ID);
    expect(before?.status).toBe("open");
    expect(classifyPendingMutation(record, observeAt(MIGRATED_ISSUE_ID, { entity: before }), NO_AUTHORITY))
      .toEqual({ kind: "replay" });
  });

  it("stages a record the three-outcome table accepts as replayable", async () => {
    const { record, root: r } = await pickAndCapture();
    // The observation a recovery would take if the crash happened between the
    // marker write and the project write: the issue is still open, and it is
    // the REAL issue, read off disk, not one this test wrote out. The stage
    // performs the write, so it is put back with the real command.
    await rewindStatus(r);
    const { state } = await loadProject(r);
    const issue = state.issues.find(i => i.id === "ISS-001");
    expect(issue?.status, "the write must not have landed for this row").toBe("open");
    expect(classifyPendingMutation(
      record,
      observeAt("ISS-001", { entity: issue }),
      NO_AUTHORITY,
    )).toEqual({ kind: "replay" });
  });

  it("refuses to replay when an unrelated field drifted after preparation", async () => {
    // The convergence row for the one variant that is actually prepared.
    // Recognition is whole-entity, so a replay authorized against a drifted
    // issue would write a state whose digest can never match the prediction
    // this record is holding, and the record would quarantine on its own
    // result forever. The drift here is a real edit, applied by the real
    // command, not a hand-built object.
    const { record, root: r } = await pickAndCapture();
    await rewindStatus(r);
    const { handleIssueUpdate } = await import("../../src/cli/commands/issue.js");
    await handleIssueUpdate("ISS-001", { title: "somebody retitled it" }, "json", r);
    const { state } = await loadProject(r);
    const drifted = state.issues.find(i => i.id === "ISS-001");
    expect(drifted?.status, "the field this record writes is untouched").toBe("open");
    expect(reasonOf(classifyPendingMutation(
      record,
      observeAt("ISS-001", { entity: drifted }),
      NO_AUTHORITY,
    ))).toBe("conflict");
    // And this is why: performing the write anyway would produce something the
    // record could not recognize.
    expect(entityFingerprint({ ...drifted, status: "inprogress" }))
      .not.toBe(record.postimageFingerprint);
  });

  it("recognizes its own landed write against the REAL post-write issue", async () => {
    // The row that matters most and the one a stored-but-uncomputable
    // fingerprint would make unreachable. The stage performed the write, so
    // this reads what is actually on disk and digests it the same way the
    // prepare site digested its prediction. If the two canonicalizations ever
    // diverge, or if the write touches a field the prediction did not, this
    // fails rather than quietly quarantining every applied mutation.
    const { record, root: r } = await pickAndCapture();
    const { state } = await loadProject(r);
    const issue = state.issues.find(i => i.id === "ISS-001");
    expect(issue?.status, "the stage should have applied the write").toBe("inprogress");

    const observed = observeAt("ISS-001", { entity: issue });
    expect(classifyPendingMutation(record, observed, NO_AUTHORITY)).toEqual({ kind: "applied" });
  });

  it("does not credit itself with a write that landed on a differently-shaped issue", async () => {
    // Same field value, different entity. The whole-entity digest is what
    // keeps this from reading as ours.
    const { record, root: r } = await pickAndCapture();
    const { state } = await loadProject(r);
    const issue = state.issues.find(i => i.id === "ISS-001");
    const observed = observeAt("ISS-001", {
      entity: { ...issue, title: "someone else edited this" },
    });
    expect(reasonOf(classifyPendingMutation(record, observed, NO_AUTHORITY))).toBe("unconfirmed-postimage");
  });

  it("stages provenance naming the owner task and the session revision", async () => {
    const { record } = await pickAndCapture();
    expect(readProvenance(record.provenance)).toEqual({ ownerTask: "task-prepare", revision: 12, ticket: null });
  });

  it("stages presence-preserving snapshots of both images", async () => {
    const { record } = await pickAndCapture();
    expect(readSnapshot(record.preimage)).toEqual({ present: true, value: "open" });
    expect(readSnapshot(record.postimage)).toEqual({ present: true, value: "inprogress" });
  });

  it("issues a replay verdict that a real create executes AND can then recognize", async () => {
    // A replay verdict is a promise of two things, not one: that the stored
    // record can be executed, and that the record can afterwards recognize
    // what it produced. A record that executes and then reads its own result
    // as somebody else's issue never converges -- it would replay forever.
    root = buildRepo();
    writeAliasedTicket(root);
    const payload = {
      title: "the issue this transaction was creating",
      severity: "medium",
      impact: "recorded so a replay has something to write",
      components: ["autonomous"],
      // The CANONICAL identity, not the display spelling. The next test shows
      // what storing the spelling instead would cost.
      relatedTickets: ["t-abcdefgh23456789"],
      location: [],
      dedupeKey: "dk-replay-1",
    };
    const record = {
      type: "issue_create",
      expectedId: "ISS-042",
      transitionId: "txn-c",
      provenance: { ownerTask: "task-prepare", revision: 12, ticket: null },
      // Computed BEFORE the create, from the payload and the ticket references
      // resolved at preparation time, exactly as a preparer would have to.
      content: { payload, semanticFingerprint: issueCreateFingerprint(payload)! },
    };
    // The links are proven canonical the way a real recovery caller proves
    // them: by putting them through the SAME resolver the create will use,
    // against the live ledger. Nothing here compares the record with itself.
    const { state: before } = await loadProject(root);
    const resolvedPayloadTickets = resolvePayloadTicketIdentities(before, payload.relatedTickets);
    const nothingFound = {
      exists: false, identity: null, dedupeKey: null, dedupeKeyAt: null,
      resolvedPayloadTickets, contentFingerprint: null,
    };
    expect(classifyPendingMutation(record, nothingFound, NO_AUTHORITY), "a key found nowhere is the replay case")
      .toEqual({ kind: "replay" });

    const stored = readIssueCreatePayload((record.content as { payload: unknown }).payload);
    expect(stored, "the classifier accepted it, so the reader must too").not.toBeNull();
    const { handleIssueCreate } = await import("../../src/cli/commands/issue.js");
    await handleIssueCreate(stored!, "json", root);

    const { state } = await loadProject(root);
    const created = state.issues.find(i => i.dedupeKey === "dk-replay-1");
    expect(created, "the replay should have produced an issue carrying the recorded key").toBeDefined();
    expect(created?.title).toBe(payload.title);
    // The create RESOLVED the reference, and because the payload already held
    // the canonical identity the written links are byte-identical to what was
    // predicted. This is the property that makes one stored representation
    // sufficient for both replaying and recognizing.
    expect(created?.relatedTickets).toEqual(["t-abcdefgh23456789"]);
    // The point of keying on the dedupe key: the ledger allocated whatever id
    // was next, NOT the expected one. A display-id-keyed design would have
    // replayed again here and created a duplicate.
    const landedAt = displayIdOf(created!);
    expect(landedAt).not.toBe("ISS-042");

    // And now the half that matters: the SAME record, observing the issue it
    // just created, at the id it actually landed on.
    expect(classifyPendingMutation(
      record,
      {
        exists: true, identity: landedAt, dedupeKey: "dk-replay-1", dedupeKeyAt: landedAt,
        entity: created, resolvedPayloadTickets, contentFingerprint: null,
      },
      NO_AUTHORITY,
    ), "the record must recognize its own result, or recovery never converges")
      .toEqual({ kind: "applied" });
  });

  it("refuses to replay a record that stored a ticket SPELLING, and shows the cost", async () => {
    // Not a hypothetical. The create resolves "T-001" to "t-abcdefgh23456789", so a
    // record that stored the spelling predicts a digest the written issue can
    // never match, and its own result reads as somebody else's issue. This is
    // executed, not argued: the resolution is performed by the real command.
    root = buildRepo();
    writeAliasedTicket(root);
    const spelled = {
      title: "prepared with a display alias",
      severity: "medium",
      impact: "x",
      components: [],
      relatedTickets: ["T-001"],
      location: [],
      dedupeKey: "dk-spelled",
    };
    const record = {
      type: "issue_create", expectedId: "ISS-042", transitionId: "txn-s",
      provenance: { ownerTask: "task-prepare", revision: 12, ticket: null },
      content: { payload: spelled, semanticFingerprint: issueCreateFingerprint(spelled)! },
    };
    // Recovery never gets as far as executing it. Before replaying anything it
    // resolves the record's links itself, against the live ledger, and a
    // spelling does not survive that: the resolver hands back the identity, the
    // record holds the alias, and the disagreement is the refusal.
    const { state: before } = await loadProject(root);
    const resolvedPayloadTickets = resolvePayloadTicketIdentities(before, spelled.relatedTickets);
    expect(resolvedPayloadTickets, "the resolver, not the test, rewrites the alias")
      .toEqual(["t-abcdefgh23456789"]);
    expect(reasonOf(classifyPendingMutation(
      record,
      {
        exists: false, identity: null, dedupeKey: null, dedupeKeyAt: null,
        resolvedPayloadTickets, contentFingerprint: null,
      },
      NO_AUTHORITY,
    )), "an unproven link set is refused before any replay").toBe("malformed-record");

    // And this is what that refusal is worth. Performed anyway, by the real
    // command, the create rewrites the links, so the digest the record predicted
    // is not a digest of what landed: its own result reads as somebody else's
    // issue and the transaction would replay forever.
    const { handleIssueCreate } = await import("../../src/cli/commands/issue.js");
    await handleIssueCreate(spelled, "json", root);
    const { state } = await loadProject(root);
    const created = state.issues.find(i => i.dedupeKey === "dk-spelled")!;
    expect(created.relatedTickets, "the create resolved the alias").toEqual(["t-abcdefgh23456789"]);
    expect(issueCreateFingerprint(created), "so the record cannot recognize what it wrote")
      .not.toBe(record.content.semanticFingerprint);

    // The refusal holds at the far end too, and by BOTH routes: a caller that
    // confirmed the record with a copy of itself is refused because a copy was
    // never registered, and the honest resolution is refused on disagreement.
    const landedAt = displayIdOf(created);
    const routes: Array<[ResolvedTicketIdentities | null, string]> = [
      [asResolved(spelled.relatedTickets), "malformed-observation"],
      [resolvedPayloadTickets, "malformed-record"],
    ];
    for (const [resolution, expected] of routes) {
      expect(reasonOf(classifyPendingMutation(
        record,
        {
          exists: true, identity: landedAt, dedupeKey: "dk-spelled", dedupeKeyAt: landedAt,
          entity: created, resolvedPayloadTickets: resolution,
          contentFingerprint: null,
        },
        NO_AUTHORITY,
      )), JSON.stringify(resolution)).toBe(expected);
    }
  });

  it("replays and then recognizes a create linked to a LEGACY ticket", async () => {
    // The ledger is permanently mixed, and a legacy ticket's canonical id IS
    // its display-form value. Inferring canonicality from the hash syntax would
    // quarantine every create linked to one of these -- in a ledger that
    // predates the migration, most of them -- forever. Executed against the
    // real create, so the claim is
    // that the resolver returns "T-001" and not that a rule says it may.
    root = buildRepo();
    writeLegacyTicket(root, "T-001");
    const payload = {
      title: "linked to a legacy ticket",
      severity: "medium",
      impact: "x",
      components: [],
      relatedTickets: ["T-001"],
      location: [],
      dedupeKey: "dk-legacy",
    };
    const record = {
      type: "issue_create", expectedId: "ISS-042", transitionId: "txn-legacy",
      provenance: { ownerTask: "task-prepare", revision: 12, ticket: null },
      content: { payload, semanticFingerprint: issueCreateFingerprint(payload)! },
    };
    const { state: before } = await loadProject(root);
    const resolvedPayloadTickets = resolvePayloadTicketIdentities(before, payload.relatedTickets);
    expect(resolvedPayloadTickets, "a legacy ticket resolves to its display-form id")
      .toEqual(["T-001"]);
    expect(classifyPendingMutation(
      record,
      {
        exists: false, identity: null, dedupeKey: null, dedupeKeyAt: null,
        resolvedPayloadTickets, contentFingerprint: null,
      },
      NO_AUTHORITY,
    ), "a legacy link set is replayable").toEqual({ kind: "replay" });

    const { handleIssueCreate } = await import("../../src/cli/commands/issue.js");
    await handleIssueCreate(payload, "json", root);
    const { state } = await loadProject(root);
    const created = state.issues.find(i => i.dedupeKey === "dk-legacy")!;
    expect(created.relatedTickets, "the create left the legacy id alone").toEqual(["T-001"]);

    const landedAt = displayIdOf(created);
    expect(classifyPendingMutation(
      record,
      {
        exists: true, identity: landedAt, dedupeKey: "dk-legacy", dedupeKeyAt: landedAt,
        entity: created, resolvedPayloadTickets, contentFingerprint: null,
      },
      NO_AUTHORITY,
    ), "and the record recognizes what it wrote").toEqual({ kind: "applied" });
  });

  it("keeps the legacy three-way key the shipped recovery path still reads", async () => {
    // Removing this would break crash recovery for every session in flight,
    // because step 4 wires no consumer for the snapshots yet.
    const { record } = await pickAndCapture();
    expect(record.expectedCurrent).toBe("open");
    expect(record.type).toBe("issue_update");
    expect(record.target).toBe("ISS-001");
    expect(record.value).toBe("inprogress");
    expect(typeof record.transitionId).toBe("string");
  });
});
