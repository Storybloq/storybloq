/**
 * Pending-artifact recovery: the three-outcome table.
 *
 * A session that crashes between a project write and the session write that
 * clears its marker leaves a `pendingProjectMutation` behind. Recovery has to
 * decide, from the record plus what is on disk now, whether the write landed.
 *
 * The two predicates this replaces were backwards in a way worth keeping
 * written down. A matching PREIMAGE was read as "already applied", but a
 * matching preimage means the write has NOT happened; that is the replay case,
 * and treating it as applied silently drops authorized work. And a postimage
 * was authenticated by target and field alone, though the field may hold a
 * third party's value, which lets a foreign write be mistaken for this
 * transaction's result.
 *
 * So:
 *
 * | Observation                                             | Outcome    |
 * |---------------------------------------------------------|------------|
 * | Exact PREIMAGE match                                     | replay     |
 * | Exact POSTIMAGE match AND nonce or content corroborates  | applied    |
 * | Anything else                                            | quarantine |
 *
 * Ticket variants replay only under still-held ticket authority. Quarantine is
 * a durable record, never a drop.
 *
 * Everything here is pure: no filesystem, no clock, no project load. The caller
 * observes, this decides, the caller writes. That is what makes each row of the
 * table reachable from a test rather than from a staged crash.
 *
 * NOTHING here trusts the caller's aim. The observation carries the identity it
 * was taken at, and that identity is checked against the identity the record
 * declares before any verdict other than quarantine is returned. A classifier
 * that accepted "the target" on faith would be deciding from a value the caller
 * chose, which is the same defect class as a guard whose two sides come from
 * one source (L-038).
 */

import { createHash } from "node:crypto";

import { isResolvedTicketIdentities } from "./resolved-identities.js";
import type {
  CanonicalTicketIdentity,
  FieldSnapshot,
  IssueCreateSemanticFingerprint,
  MutationProvenance,
  PendingIssueCreatePayload,
  QuarantinedMutation,
  ResolvedTicketIdentities,
} from "./session-types.js";

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type QuarantineReason =
  /** No structurally valid provenance. Quarantines in every state. */
  | "no-provenance"
  /** Provenance present, but the payload predates replayable snapshots. */
  | "legacy-payload"
  /**
   * The record's own fields are missing, wrong-typed, or contradict each other,
   * so the write it describes could not be performed as described.
   */
  | "malformed-record"
  /** A `type` this build does not know how to reason about. */
  | "unknown-variant"
  /**
   * A `type` this build RECOGNIZES and has no consumer for.
   *
   * Distinct from `unknown-variant` because it is actionable in a different
   * direction: the name is one of ours, so the answer is to implement the
   * consumer or retire the variant, not to work out what wrote it.
   */
  | "unimplemented-variant"
  /** The observation itself is malformed, so it cannot decide anything. */
  | "malformed-observation"
  /** The record names no identity, so no observation can be matched to it. */
  | "unidentifiable-target"
  /** The observation was taken somewhere other than where the record points. */
  | "identity-mismatch"
  /** The provenance authorizes a different ticket than the record writes to. */
  | "provenance-target-mismatch"
  /** The record names a target that no longer exists. */
  | "target-missing"
  /** The target holds neither the preimage nor the postimage. */
  | "conflict"
  /** The value matches, but nothing proves this transaction wrote it. */
  | "unconfirmed-postimage"
  /** Something else occupies the target, with content that is not ours. */
  | "foreign-occupant"
  /** Replayable, but the ticket authority that authorized it is gone. */
  | "ticket-authority-lost"
  /** The record names a field no replay consumer for its variant can write. */
  | "unsupported-field"
  /** The variant stores no fingerprint, so nothing can confirm it. */
  | "unverifiable-content"
  /** Confirmable only; the content needed to rewrite it was never stored. */
  | "not-replayable";

export type PendingMutationOutcome =
  | { readonly kind: "replay" }
  | { readonly kind: "applied" }
  | { readonly kind: "quarantine"; readonly reason: QuarantineReason };

const REPLAY: PendingMutationOutcome = { kind: "replay" };
const APPLIED: PendingMutationOutcome = { kind: "applied" };
function quarantine(reason: QuarantineReason): PendingMutationOutcome {
  return { kind: "quarantine", reason };
}

// ---------------------------------------------------------------------------
// Content fingerprints
// ---------------------------------------------------------------------------

/**
 * Key-order-independent serialization.
 *
 * The two sides of a fingerprint comparison are produced at different times by
 * different code paths, so a digest that depended on property order would
 * report a difference that does not exist. `undefined` members are dropped
 * rather than encoded, so an explicitly-absent field and an omitted one agree.
 */
function stableStringify(value: unknown): string {
  // `JSON.stringify(undefined)` is undefined rather than a string, which is
  // where the `?? "null"` earns its place: an undefined reaching here (a
  // sparse array member, or a top-level call) encodes as null, matching what
  // `JSON.stringify` does to the same value inside an array.
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  // `Array.from` over `.map`: `.map` SKIPS holes and leaves them holes, which
  // `.join` then renders as nothing, so `Array(1)` would digest identically to
  // `[]`. `Array.from` visits every index, so a hole arrives here as undefined
  // and encodes as null, which is what JSON persistence writes for it.
  if (Array.isArray(value)) return `[${Array.from(value, stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * The one canonicalization, used by both sides.
 *
 * A prepare site digests the content it is ABOUT to write and a recovery
 * digests what it finds. If the two used different canonicalizations, the
 * comparison would be decorative: it could only ever fail, and the "already
 * applied" row of the table would be unreachable.
 */
export function canonicalContentFingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 32);
}

/**
 * The deepest nesting a canonicalizable observation may have.
 *
 * Everything `stableStringify` walks arrives through `canonicalSnapshot` or
 * through a validated reader, so bounding the snapshot bounds the serializer
 * too. A ledger item nests three levels; sixty-four is far enough above that
 * the bound can only ever be hit by data no writer of ours produced.
 */
const MAX_SNAPSHOT_DEPTH = 64;

/**
 * A DEEP own-data copy, or null if the value cannot be one.
 *
 * `ownFields` guards only the top level, which is not enough for a whole-entity
 * digest: the serializer walks nested objects and arrays, so a getter two
 * levels down would still be invoked, and a cycle or a BigInt would THROW.
 * A throw inside recovery is the worst available outcome -- worse than
 * quarantining, because it takes the session with it -- so every one of these
 * becomes a null here and a quarantine above.
 *
 * Accessors are refused rather than read at any depth, for the reason they are
 * refused at the top: these values are read again by the comparison, and a
 * getter may answer differently each time.
 */
function canonicalSnapshot(
  value: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): { readonly value: unknown } | null {
  // A cycle is caught below, but an ACYCLIC value can be arbitrarily deep, and
  // this walk plus the serializer downstream are both recursive. The bound is
  // far above any ledger item -- an issue nests three levels -- and refusing
  // past it turns a stack overflow, which would take the recovering session
  // with it, into the quarantine every other malformed observation gets.
  if (depth > MAX_SNAPSHOT_DEPTH) return null;
  if (value === null) return { value: null };
  switch (typeof value) {
    case "string":
    case "boolean":
    case "undefined":
      return { value };
    case "number":
      // NaN and the infinities are not representable in the JSON this digests,
      // so they would serialize as null and be indistinguishable from one.
      return Number.isFinite(value) ? { value } : null;
    case "bigint":
    case "function":
    case "symbol":
      return null;
  }
  const object = value as object;
  // A cycle would recurse until the stack gives out. It cannot occur in a
  // ledger item loaded from JSON, which is exactly why it must not decide the
  // outcome by crashing.
  if (seen.has(object)) return null;
  const nested = new Set(seen).add(object);

  // `Reflect.ownKeys` rather than `getOwnPropertyNames`, which omits symbol
  // keys entirely. Omitting them silently would drop data from a digest that is
  // supposed to identify the whole entity -- two different objects would agree
  // -- and on an array a symbol key would balance the index count below and let
  // a sparse array through. Symbols cannot occur in the JSON these come from,
  // so their presence is a malformed observation, not a case to support.
  const keys = Reflect.ownKeys(object);
  if (keys.some((k) => typeof k === "symbol")) return null;

  if (Array.isArray(object)) {
    // One own key per index, plus `length`. Rejects holes and any array
    // carrying extra own properties, neither of which survives a JSON round
    // trip as what it looks like.
    if (keys.length !== object.length + 1) return null;
    const out: unknown[] = [];
    for (let i = 0; i < object.length; i++) {
      const d = Object.getOwnPropertyDescriptor(object, i);
      if (!d || !("value" in d)) return null;
      const element = canonicalSnapshot(d.value, nested, depth + 1);
      if (element === null) return null;
      out.push(element.value);
    }
    return { value: out };
  }

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as readonly string[]) {
    const d = Object.getOwnPropertyDescriptor(object, key);
    if (!d) return null;
    if (!("value" in d)) return null;
    const member = canonicalSnapshot(d.value, nested, depth + 1);
    if (member === null) return null;
    out[key] = member.value;
  }
  return { value: out };
}

/**
 * The one place a reflective walk over untrusted data is allowed to fail.
 *
 * `Reflect.ownKeys` and `getOwnPropertyDescriptor` are ordinary calls on an
 * ordinary object and exotic on a proxy, where a trap can throw whatever it
 * likes. Recovery classifies; it does not propagate. Anything that throws out
 * of the walk is a value that could not be canonicalized, which is exactly what
 * a null already means here.
 */
function safeCanonicalSnapshot(value: unknown): { readonly value: unknown } | null {
  try {
    return canonicalSnapshot(value);
  } catch {
    return null;
  }
}

/**
 * The whole-entity digest of a ledger item, taken through the own-data
 * boundary at every depth. Null when the value cannot be canonicalized at all.
 *
 * Exported because the PREPARE site has to produce it the same way recovery
 * does. Two canonicalizations would be two different questions, and the
 * comparison between them could only ever fail.
 */
export function entityFingerprint(value: unknown): string | null {
  const snapshot = safeCanonicalSnapshot(value);
  return snapshot === null ? null : canonicalContentFingerprint(snapshot.value);
}

/** The deep own-data copy itself, for callers that must also READ the fields. */
function entitySnapshot(value: unknown): Record<string, unknown> | null {
  const snapshot = safeCanonicalSnapshot(value);
  if (snapshot === null) return null;
  const v = snapshot.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * The SEMANTIC digest of an issue create: only the fields a create controls.
 *
 * Deliberately not a digest of the whole entity. A create cannot be aimed, so
 * the issue it produces carries an allocated id, an order and dates that the
 * preparer could not have predicted. A whole-entity digest taken before the
 * write therefore could never match the entity written, and a successfully
 * replayed create would be classified as somebody else's issue -- the record
 * would execute and then fail to recognize its own result, which is a record
 * that cannot converge.
 *
 * `relatedTickets` is read off the value like every other field, because the
 * payload stores CANONICAL identities rather than raw references: one
 * representation, so there is nothing to reconcile and no second copy that can
 * disagree with the first. It is deduplicated and sorted, because a set of
 * links has neither order nor multiplicity to preserve, and resolution can map
 * two references onto the same ticket.
 *
 * Takes both shapes on purpose: the same projection is applied to the stored
 * payload at preparation and to the observed issue at recovery, because two
 * projections would be two different questions.
 */
export function issueCreateFingerprint(value: unknown): IssueCreateSemanticFingerprint | null {
  const v = ownFields(value);
  if (v === null) return null;
  const title = nonEmptyString(v.title);
  const severity = nonEmptyString(v.severity);
  const dedupeKey = nonEmptyString(v.dedupeKey);
  const components = ownStringArray(v.components);
  const location = ownStringArray(v.location);
  if (title === null || severity === null || dedupeKey === null) return null;
  if (typeof v.impact !== "string" || components === null || location === null) return null;
  const relatedTickets = ownStringArray(v.relatedTickets);
  if (relatedTickets === null) return null;
  // Same rule the payload reader uses. Coercing a non-string phase to null
  // would make corrupt data indistinguishable from an absent phase, and the
  // two must not digest the same.
  if (v.phase !== undefined && v.phase !== null && typeof v.phase !== "string") return null;
  const phase = typeof v.phase === "string" ? v.phase : null;
  return canonicalContentFingerprint({
    title, severity, dedupeKey, components, location, impact: v.impact, phase,
    relatedTickets: [...new Set(relatedTickets)].sort(),
  }) as IssueCreateSemanticFingerprint;
}

// ---------------------------------------------------------------------------
// What the caller observed
// ---------------------------------------------------------------------------

/**
 * The state of the record's target, read once, before classification.
 *
 * One observation for one decision. Re-reading between the branches below
 * would let the target change underneath the table and produce a verdict that
 * was never true of any single moment.
 */
export interface TargetObservation {
  /** Does the target entity, file or display id exist at all? */
  readonly exists: boolean;
  /**
   * The identity this observation was actually taken at: the resolved entity
   * id, or the filename. Null only when nothing exists there. Compared against
   * the identity the record declares, so a caller that observed the wrong
   * place produces a refusal rather than a verdict.
   */
  readonly identity: string | null;
  /** The occupant's dedupe key, where the entity carries one. */
  readonly dedupeKey: string | null;
  /**
   * Where the record's dedupe key was found in the LEDGER, or null if nowhere.
   *
   * Ledger-wide rather than at the target, because a create cannot be aimed at
   * a display id. Without this a classifier can only ask "is the expected id
   * free", which answers a question no replay can act on: creating allocates
   * the next id, so a free expected id neither proves the create is absent nor
   * guarantees a replay would land there.
   */
  readonly dedupeKeyAt: string | null;
  /**
   * Digest of the target's canonical content, or null when not computable.
   *
   * Used by the variants whose content is OPAQUE to this module (a handover or
   * snapshot body, a written field). Structured occupants come through
   * `entity` instead, so the projection that decides them is chosen here
   * rather than by the caller.
   */
  readonly contentFingerprint: string | null;
  /**
   * The stored payload's ticket references, RE-RESOLVED against the ledger as
   * it is now, or null when they could not be resolved.
   *
   * The classifier cannot resolve anything itself, and a payload that merely
   * looks like a list of ids is not proof they are canonical. Without this the
   * record could replay display spellings, watch the create rewrite them, and
   * then read its own issue as somebody else's.
   */
  readonly resolvedPayloadTickets?: ResolvedTicketIdentities | null;
  /**
   * The occupant itself, for variants this module can project.
   *
   * Passed as data rather than as a digest so the caller cannot compute the
   * wrong projection: which fields count is a property of the outcome table,
   * not of whoever did the reading.
   *
   * It is also the ONLY source for everything a field write decides on. There
   * was once a caller-supplied `field` snapshot and a caller-supplied `nonce`
   * beside it, and both were the defect this module's header warns about: a
   * caller could report that the named field held the preimage while handing
   * over an entity that said otherwise, or stamp an observation with the
   * record's own transition id and have a foreign occupant credited as ours.
   * A guard whose two sides come from one source proves nothing (L-038), so the
   * field value and the transition stamp are now read off THIS, and there is no
   * longer any way to say something different about them.
   */
  readonly entity?: unknown;
}

/**
 * Authority the caller holds RIGHT NOW, resolved independently of the record.
 *
 * Passed in rather than read from the record's own provenance: a record cannot
 * be its own proof that its author still owns the ticket.
 *
 * It names the TICKET, not a yes/no. A bare "authority held" boolean does not
 * say what the authority is over, so authority legitimately held on one ticket
 * would authorize replaying a write aimed at another. Null means none is held.
 */
export interface RecoveryAuthority {
  readonly ticket: string | null;
}

/** The observation after its snapshots have been structurally validated. */
interface CheckedObservation {
  readonly exists: boolean;
  readonly identity: string | null;
  readonly dedupeKey: string | null;
  readonly dedupeKeyAt: string | null;
  readonly resolvedPayloadTickets: ResolvedTicketIdentities | null;
  readonly entity: unknown;
  readonly contentFingerprint: string | null;
}

function checkObservation(raw: TargetObservation): CheckedObservation | null {
  // The observation is structure this module did not build, so it goes through
  // the same own-data boundary the record does. Read directly, an inherited
  // `dedupeKeyAt` or a getter that answers differently on two reads would
  // decide a verdict.
  const observed = ownFields(raw);
  if (observed === null) return null;
  const { identity, dedupeKey, dedupeKeyAt, contentFingerprint, exists } = observed;
  if (typeof exists !== "boolean") return null;
  if (typeof identity !== "string" && identity !== null) return null;
  if (typeof dedupeKey !== "string" && dedupeKey !== null) return null;
  if (typeof dedupeKeyAt !== "string" && dedupeKeyAt !== null) return null;
  if (typeof contentFingerprint !== "string" && contentFingerprint !== null) return null;

  // The cross-field contract, not just the field types. An observation that
  // reports nothing exists while still carrying an identity, a dedupe key, a
  // digest or an occupant is two observations mixed together, and each arm of
  // the table below would read a different one of them. The free-target arm
  // returns REPLAY without consulting identity at all, so a contradiction here
  // authorizes a write.
  if (!exists) {
    if (identity !== null || dedupeKey !== null || contentFingerprint !== null) return null;
    if (observed.entity !== undefined && observed.entity !== null) return null;
  } else if (identity === null || identity.length === 0) {
    return null;
  }
  // A resolution has to BE one: the registry check is what a cast cannot
  // satisfy. Absent is allowed here and refused later by the variant that needs
  // it, so the variants that have no payload are not asked for one.
  const claimed = observed.resolvedPayloadTickets ?? null;
  if (claimed !== null && !isResolvedTicketIdentities(claimed)) return null;
  if (claimed !== null && ownStringArray(claimed) === null) return null;
  return {
    exists: exists as boolean,
    identity: identity as string | null,
    dedupeKey: dedupeKey as string | null,
    dedupeKeyAt: dedupeKeyAt as string | null,
    resolvedPayloadTickets: claimed as ResolvedTicketIdentities | null,
    entity: observed.entity,
    contentFingerprint: contentFingerprint as string | null,
  };
}

// ---------------------------------------------------------------------------
// Structural readers
// ---------------------------------------------------------------------------

/**
 * Provenance is validated, not merely detected.
 *
 * A half-written provenance object would otherwise authorize a replay while
 * carrying none of the information that authorization rests on. The bounds are
 * the ones the writer can actually produce: a session revision is a
 * non-negative integer, and an id that exists is a non-empty string. An empty
 * `ownerTask` would be reported as the displaced owner of a quarantined record,
 * which is an attribution to nobody.
 */
export function readProvenance(value: unknown): MutationProvenance | null {
  const v = ownFields(value);
  if (v === null) return null;
  const ownerTask = v.ownerTask;
  const ticket = v.ticket;
  if (typeof ownerTask !== "string" && ownerTask !== null) return null;
  if (typeof ownerTask === "string" && ownerTask.length === 0) return null;
  if (typeof ticket !== "string" && ticket !== null) return null;
  if (typeof ticket === "string" && ticket.length === 0) return null;
  if (typeof v.revision !== "number" || !Number.isInteger(v.revision) || v.revision < 0) return null;
  return { ownerTask, revision: v.revision, ticket };
}

/**
 * Returns null for anything that is not a well-formed snapshot.
 *
 * `{ present: false, value: "x" }` is rejected rather than read as an absence.
 * It is a contradiction, and the half a reader happens to look at would decide
 * whether a field counts as absent or as holding "x".
 */
export function readSnapshot(value: unknown): FieldSnapshot | null {
  const v = ownFields(value);
  if (v === null) return null;
  if (v.present === false) return "value" in v ? null : { present: false };
  if (v.present === true && typeof v.value === "string") return { present: true, value: v.value };
  return null;
}

export function snapshotEquals(a: FieldSnapshot, b: FieldSnapshot): boolean {
  if (!a.present || !b.present) return a.present === b.present;
  return a.value === b.value;
}

/**
 * An entity's own CANONICAL identity: `id`, in whichever form it holds.
 *
 * The ledger is permanently mixed. A legacy item carries its display id in
 * `id` and no `displayId`; a post-migration item carries a hash in `id` and the
 * display id separately. `id` is the canonical identity in both cases, which is
 * why it is the one read here: the prepare site records `target: issue.id`, and
 * the identity an observation is taken at is the one a ledger-wide search
 * returns, so all three have to be the same domain or a migrated item can never
 * be recognized at all.
 *
 * Preferring `displayId` -- which an earlier revision of this function did --
 * quarantines EVERY post-migration record: `entityIdentity` would answer
 * `ISS-001` while the record named `i-...`, and no observation could satisfy
 * both the target check and the entity binding. `displayId` survives only as a
 * fallback for a shape carrying a display id and no `id` at all.
 */
function entityIdentity(value: unknown): string | null {
  const v = ownFields(value);
  if (v === null) return null;
  return nonEmptyString(v.id) ?? nonEmptyString(v.displayId);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * An OWN, data-only snapshot of an object's fields, or null if it is not one.
 *
 * Every reader below goes through this, for two reasons. Inherited properties
 * are the first: an incomplete record whose prototype happens to carry `title`
 * or `dedupeKey` would otherwise pass validation and authorize a replay, and
 * this module exists precisely because its input may be old, hand-edited, or
 * otherwise not what this build would have written. Accessors are the second:
 * several fields here are read more than once, and a getter can return a
 * different value each time, so the two sides of a comparison would not be
 * reading the same thing. Only own data properties survive, and the copy has a
 * null prototype so nothing downstream can inherit either.
 *
 * Reflection itself is inside the try. `getOwnPropertyNames` and
 * `getOwnPropertyDescriptor` are ordinary calls on an ordinary object and
 * exotic on a proxy, whose traps may throw anything at all -- and this reads
 * the record, the observation, the provenance, the snapshots and the create
 * content, every one of which is structure this module did not build. A throw
 * out of any of them takes the recovering session down instead of quarantining
 * one record, so it becomes the null every other malformed value produces.
 */
function ownFields(value: unknown): Record<string, unknown> | null {
  // `Array.isArray` is INSIDE the try, not before it. It throws a TypeError on
  // a revoked proxy, so a guard placed ahead of the boundary would be the one
  // line able to escape it -- and a revoked proxy is exactly the kind of thing
  // that reaches a module whose whole premise is that its input may be
  // anything at all.
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (d && "value" in d) out[key] = d.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * A list of non-empty strings read through the own-data boundary, or null.
 *
 * Exported because the MINT point for resolved ticket identities has to read an
 * incoming ref list the same way. Two implementations of one structural check
 * are two chances to get it differently wrong, and the mint point's whole job is
 * to be the place that cannot be fooled.
 */
export function ownStringArray(value: unknown): readonly string[] | null {
  // Everything inside the try, including `Array.isArray`, which throws a
  // TypeError on a revoked proxy. See `ownFields` for the same rule.
  try {
    if (!Array.isArray(value)) return null;
    // Symbol keys are invisible to `getOwnPropertyNames`, so an array carrying
    // one would balance a hole in the count below and pass. They are also not
    // expressible in the JSON these lists come from, so an array holding one is
    // malformed whatever else it is.
    if (Reflect.ownKeys(value).some((k) => typeof k === "symbol")) return null;
    // One own key per index, plus `length`, and nothing else. This is what
    // rejects HOLES, which `every` skips entirely -- a sparse array would
    // otherwise pass an element check while holding nothing at that index --
    // and it also rejects an array carrying extra own properties, which is not
    // a list of strings whatever else it is.
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length !== value.length + 1) return null;
    const out: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, i);
      // Accessors are refused rather than read. These values are read again
      // later -- by the digest, by a set comparison, by a replay -- and a
      // getter may answer differently each time, so the two sides of a
      // comparison would not be the same list. Reading the descriptor also
      // means the getter is never invoked at all.
      if (!d || !("value" in d) || typeof d.value !== "string") return null;
      out.push(d.value);
    }
    // A COPY, so nothing downstream compares against an array the caller can
    // still mutate between the check and the use.
    return out;
  } catch {
    return null;
  }
}

/** Set equality, for values whose order and multiplicity are not content. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const v of left) if (!right.has(v)) return false;
  return true;
}

/**
 * Prove a stored ticket list canonical, by agreement with a real resolution.
 *
 * Canonicality is NOT decidable from an id's syntax here. This ledger is
 * permanently mixed: a legacy ticket's canonical id is its display-form value
 * (`T-001`) and a post-migration ticket's is a hash, so a rule that read the
 * hash form as canonical would quarantine every create linked to a legacy
 * ticket, forever.
 *
 * What is decidable is agreement with what a resolver actually returned.
 * `resolvedNow` must have come out of the resolver -- checked at runtime by
 * `isResolvedTicketIdentities`, not merely typed, because a brand does not
 * survive a cast -- so a caller cannot authenticate a record with a copy of
 * itself. A display ALIAS resolves to something else and the sets disagree,
 * which is exactly the record that would replay, get rewritten by the create,
 * and then never recognize its own result.
 *
 * This is the ONLY way to obtain `CanonicalTicketIdentity`.
 */
export function asCanonicalTicketIdentities(
  stored: readonly string[],
  resolvedNow: ResolvedTicketIdentities,
): readonly CanonicalTicketIdentity[] | null {
  if (!isResolvedTicketIdentities(resolvedNow)) return null;
  const left = ownStringArray(stored);
  const right = ownStringArray(resolvedNow);
  if (left === null || right === null) return null;
  return sameSet(left, right) ? (left as readonly CanonicalTicketIdentity[]) : null;
}

/**
 * A stored create input, validated against what a create actually needs.
 *
 * "A payload is present" is not the same as "a create can be performed": a
 * number, a string, an array or a half-filled object all pass a presence check
 * and none of them can be submitted. Since REPLAY is an instruction to execute
 * this payload, the fields it would be executed with are checked here.
 */
/**
 * A structurally valid payload whose ticket links have NOT yet been proven
 * canonical. Distinct from `PendingIssueCreatePayload` so the branded type
 * cannot be produced by reading alone -- only by checking against the resolver.
 */
export type UnverifiedIssueCreatePayload =
  Omit<PendingIssueCreatePayload, "relatedTickets"> & { readonly relatedTickets: readonly string[] };

export function readIssueCreatePayload(value: unknown): UnverifiedIssueCreatePayload | null {
  const v = ownFields(value);
  if (v === null) return null;
  const title = nonEmptyString(v.title);
  const severity = nonEmptyString(v.severity);
  const impact = v.impact;
  const components = ownStringArray(v.components);
  const relatedTickets = ownStringArray(v.relatedTickets);
  const location = ownStringArray(v.location);
  if (title === null || severity === null || typeof impact !== "string") return null;
  if (components === null || relatedTickets === null || location === null) return null;
  const dedupeKey = nonEmptyString(v.dedupeKey);
  if (dedupeKey === null) return null;
  if (v.phase !== undefined && v.phase !== null && typeof v.phase !== "string") return null;
  return {
    title, severity, impact, components, relatedTickets, location, dedupeKey,
    ...(v.phase !== undefined ? { phase: v.phase as string | null } : {}),
  };
}

/**
 * Does the observation point at the place the record names?
 *
 * A free target (nothing exists) has no identity to compare, and that is not a
 * mismatch: it is the replay case. An occupied target must match exactly.
 */
function identityAgrees(declared: string, observed: CheckedObservation): boolean {
  return !observed.exists || observed.identity === declared;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Does anything independent of the value itself prove this transaction wrote
 * it?
 *
 * Either the target carries our transition nonce, or the record's stored
 * prediction matches a digest of the entity that is actually there. Equal field
 * values are not evidence: two writers can produce the same value, which is
 * exactly how a foreign write gets credited to us.
 *
 * `observedDigest` is computed HERE, from the occupant, and is never taken from
 * the caller. A caller-supplied digest would let anyone copy the record's own
 * prediction into the observation and be told the write landed -- a guard whose
 * two sides come from one source (L-038). The digest covers the whole entity
 * rather than the one field, so a third party writing the same status onto a
 * differently-shaped issue does not match it.
 *
 * The transition stamp is read off the OCCUPANT for the same reason, not from
 * the observation around it. A nonce the caller supplies is not evidence about
 * the entity: it can be copied straight out of the record it is supposed to
 * corroborate, and a foreign occupant then clears as ours. Read from the
 * entity, the two sides of the comparison are the disk and the record, which is
 * what makes the comparison mean anything.
 *
 * Both digests are parameters rather than re-read from the record. The caller
 * has already validated them, and a second read of the same field is a second
 * chance for the two reads to disagree.
 */
function corroborated(
  record: Record<string, unknown>,
  occupant: Record<string, unknown>,
  observedDigest: string,
  postimageFingerprint: string,
): boolean {
  const transitionId = nonEmptyString(record.transitionId);
  const stamped = nonEmptyString(occupant[TRANSITION_STAMP_FIELD]);
  if (transitionId !== null && stamped !== null && stamped === transitionId) return true;
  return observedDigest === postimageFingerprint;
}

/**
 * The fields a replay can actually WRITE, per family of variant.
 *
 * Not a taste judgement and not a safety margin: this is a transcription of
 * what the replay consumer does. `recoverPendingMutation` in `guide.ts` replays
 * a ticket variant as `{ ...ticket, status: value }` and an issue variant as
 * `handleIssueUpdate(target, { status: value })`. Both write `status` and
 * nothing else, so a REPLAY verdict for any other field is a promise of a write
 * that will not happen -- the record would be cleared, and the work it
 * describes silently dropped.
 *
 * Identity fields are excluded by the same rule rather than by a separate one.
 * `id` and `displayId` are not writable by either consumer, and a replay that
 * COULD write them would move the entity out from under the `target` the record
 * locates it by, so the record could never afterwards recognize its own result.
 *
 * These sets move in lockstep with those consumers. Widening one without the
 * other reintroduces exactly the gap it closes.
 *
 * There is deliberately no entry for `ticket_recovery_write` or
 * `ticket_recovery_clear`. Both have been declared since T-119 with no producer
 * and no consumer, so there is nothing to transcribe from, and a set invented
 * for them would be a guess dressed as a transcription. They never reach here:
 * the dispatch quarantines them as `unimplemented-variant` (ISS-933).
 */
const TICKET_REPLAYABLE_FIELDS: ReadonlySet<string> = new Set(["status"]);
const ISSUE_REPLAYABLE_FIELDS: ReadonlySet<string> = new Set(["status"]);

/**
 * Where a transition stamp lives on an entity, if a writer ever puts one there.
 *
 * Named once so the corroborating read and any future writer cannot drift
 * apart. No ledger writer stamps entities today, so this arm is currently
 * unreachable in production and the whole-entity digest carries corroboration
 * on its own. It is kept rather than deleted because the alternative -- taking
 * the stamp from the observation -- is the unsound version, and because a
 * stamped entity is the one thing that can corroborate a write whose other
 * fields have legitimately moved on since.
 */
const TRANSITION_STAMP_FIELD = "transitionId";

/**
 * The named field's value AS THE OCCUPANT HOLDS IT, or null if it holds
 * something no record could have written.
 *
 * A missing field and a field explicitly holding `undefined` are the same
 * answer, and are deliberately reached by ONE branch rather than two: the
 * serializer drops an undefined member, so a JSON round trip cannot tell them
 * apart either, and a second branch that could only ever agree with the first
 * would be a guard no test could distinguish.
 *
 * A present non-string is neither absent nor any image this record can
 * describe, so it is refused here and becomes a conflict above: the world holds
 * something this transaction has nothing to say about. Reading it as an absence
 * instead would let a record whose preimage was ABSENT replay over it.
 *
 * The occupant has a null prototype -- `canonicalSnapshot` builds it that way
 * -- so this index cannot reach `toString` or any other inherited member and
 * mistake it for the field's value.
 */
function occupantField(occupant: Record<string, unknown>, field: string): FieldSnapshot | null {
  const value = occupant[field];
  if (value === undefined) return { present: false };
  return typeof value === "string" ? { present: true, value } : null;
}

function classifyFieldWrite(
  record: Record<string, unknown>,
  observed: CheckedObservation,
  ticketScoped: boolean,
  authority: RecoveryAuthority,
  provenance: MutationProvenance,
  replayableFields: ReadonlySet<string>,
): PendingMutationOutcome {
  const target = nonEmptyString(record.target);
  if (target === null) return quarantine("unidentifiable-target");
  if (!identityAgrees(target, observed)) return quarantine("identity-mismatch");
  // The provenance ticket is what makes the record ticket-scoped at all. Left
  // unchecked it is decorative: a record could carry authority for one ticket
  // and write to another, which is the whole point of recording it.
  if (ticketScoped && (provenance.ticket === null || provenance.ticket !== target)) {
    return quarantine("provenance-target-mismatch");
  }

  const preimage = readSnapshot(record.preimage);
  const postimage = readSnapshot(record.postimage);
  if (preimage === null || postimage === null) return quarantine("legacy-payload");
  // Both digests, because both arms of the table need one: the postimage arm to
  // corroborate, the replay arm to promise that what it writes will afterwards
  // be recognizable. A record carrying only one of them predates this design.
  const preimageFingerprint = nonEmptyString(record.preimageFingerprint);
  const postimageFingerprint = nonEmptyString(record.postimageFingerprint);
  if (preimageFingerprint === null || postimageFingerprint === null) {
    return quarantine("legacy-payload");
  }

  // A replay verdict is an instruction to write `field = value`, so both have
  // to be there and be writable. And the write has to produce the postimage the
  // record claims: a record whose value disagrees with its own postimage would
  // replay into a state its "already applied" arm would then refuse to
  // recognize. Absence is not expressible as a written value, so a postimage of
  // absence is refused rather than half-supported.
  const field = nonEmptyString(record.field);
  const value = record.value;
  if (field === null || typeof value !== "string") return quarantine("malformed-record");
  if (!snapshotEquals(postimage, { present: true, value })) return quarantine("malformed-record");

  if (!observed.exists) return quarantine("target-missing");

  // The occupant itself, not a digest of it. Passed as data so the projection
  // that decides this is chosen here rather than by whoever did the reading,
  // and bound to the identity being authenticated so content from one item
  // cannot authenticate an observation of another. The snapshot is the same
  // deep own-data copy `entityFingerprint` takes, kept because the replay arm
  // below has to READ the fields, not only digest them.
  const occupant = entitySnapshot(observed.entity);
  if (occupant === null || entityIdentity(occupant) !== observed.identity) {
    return quarantine("malformed-observation");
  }
  const observedDigest = canonicalContentFingerprint(occupant);

  // The field's current value comes from the OCCUPANT, never from the
  // observation around it. Every arm below turns on this one value, and a
  // caller that could name it independently could say the field held the
  // preimage while handing over an entity that said otherwise -- the same
  // one-source guard the digest above refuses to accept from a caller (L-038).
  const current = occupantField(occupant, field);
  if (current === null) return quarantine("conflict");

  // Postimage first, so a landed write clears rather than replaying. The
  // preimage guard below matters when preimage and postimage are equal: an
  // uncorroborated no-op write is indistinguishable from not having run, and
  // replaying it costs nothing, so it must not be quarantined.
  if (snapshotEquals(current, postimage)) {
    if (corroborated(record, occupant, observedDigest, postimageFingerprint)) return APPLIED;
    if (!snapshotEquals(current, preimage)) return quarantine("unconfirmed-postimage");
  }

  if (snapshotEquals(current, preimage)) {
    // Before anything about the moment, because this is about the record. A
    // field no consumer writes can never be replayed, by this session or any
    // later one, so it is reported ahead of an authority that a future session
    // might hold. The APPLIED arm above is deliberately NOT gated on this: the
    // original write was performed by the stage, not by the replay consumer, so
    // a landed write still clears its marker whatever field it touched.
    if (!replayableFields.has(field)) return quarantine("unsupported-field");
    if (ticketScoped && authority.ticket !== target) return quarantine("ticket-authority-lost");
    // A replay verdict is a promise of TWO things: that the write can be
    // performed, and that this record can afterwards recognize what it
    // produced. Recognition is whole-entity, so both halves are checked, and
    // they fail for different reasons.
    //
    // The world moved: the entity is not the one the record was prepared
    // against, so replaying it writes a state the prediction was never about.
    if (observedDigest !== preimageFingerprint) return quarantine("conflict");
    // The record is inconsistent with itself: performing its OWN write on the
    // entity it was prepared against does not produce the postimage it
    // predicted. Nothing that happens later can fix that, so it can never
    // converge, and the defect is the record's rather than the world's.
    if (canonicalContentFingerprint({ ...occupant, [field]: value }) !== postimageFingerprint) {
      return quarantine("malformed-record");
    }
    return REPLAY;
  }

  return quarantine("conflict");
}

/**
 * Verified on BOTH identity and content.
 *
 * Duplicate display ids are reachable in this ledger, so an occupied
 * `expectedId` proves only that the id is taken. The dedupe key is the
 * stronger identity and is checked alongside it; the content digest then
 * decides whether the occupant is the issue this transaction was creating.
 * Records that stored nothing but the id cannot be told apart from a foreign
 * occupant at all, so they are quarantine-only.
 */
function classifyIssueCreate(
  record: Record<string, unknown>,
  observed: CheckedObservation,
): PendingMutationOutcome {
  // Required as a locator and for the audit trail, but deliberately NOT the
  // thing any verdict below turns on.
  if (nonEmptyString(record.expectedId) === null) return quarantine("unidentifiable-target");

  // Nested structure straight off disk, so it gets the same own-data treatment
  // as the record around it.
  const content = ownFields(record.content);
  const fingerprint = content === null ? null : nonEmptyString(content.semanticFingerprint);
  if (fingerprint === null) return quarantine("legacy-payload");
  // The payload is what a replay would actually write. Without it this variant
  // is in exactly the position handovers and snapshots are in -- recognizable
  // but not rebuildable -- and returning REPLAY would promise a create no
  // consumer can perform from an id and a digest.
  const payload = readIssueCreatePayload(content === null ? undefined : content.payload);
  if (payload === null) return quarantine("malformed-record");
  // The stored digest has to be a digest OF THIS PAYLOAD. Unchecked, a record
  // could replay payload A while carrying the fingerprint of entity B, then
  // fail to recognize its own result -- or clear against B, which it never
  // created. Re-deriving also means a change to the projection invalidates old
  // records loudly instead of silently reinterpreting them.
  const predicted = issueCreateFingerprint(payload);
  if (predicted === null || predicted !== fingerprint) return quarantine("malformed-record");
  // The payload's ticket links have to BE canonical, not merely look like ids.
  // Proven against the live resolver rather than assumed, because a spelling
  // passes every structural check and then gets rewritten by the create,
  // leaving a record that cannot recognize what it just wrote.
  if (observed.resolvedPayloadTickets === null) return quarantine("malformed-record");
  if (asCanonicalTicketIdentities(payload.relatedTickets, observed.resolvedPayloadTickets) === null) {
    return quarantine("malformed-record");
  }

  // Identity is the dedupe key, searched for across the whole ledger, and NOT
  // the display id. `handleIssueCreate` allocates the next free id and cannot
  // be aimed at a chosen one, so "the expected id is free" is not evidence the
  // create is absent, and a replay could not promise to land there anyway.
  if (observed.dedupeKeyAt === null) {
    // Nothing in the ledger carries this key, so the create did not happen and
    // performing it now duplicates nothing. The caller had nothing of ours to
    // look at, so an observation of SOMETHING here is two answers at once.
    if (observed.exists) return quarantine("malformed-observation");
    return REPLAY;
  }

  // The caller found our key somewhere; the observation has to be OF that.
  if (!observed.exists || observed.identity !== observed.dedupeKeyAt) {
    return quarantine("malformed-observation");
  }
  if (observed.dedupeKey !== payload.dedupeKey) return quarantine("foreign-occupant");
  // The entity has to BE the thing at the identity being authenticated.
  // Otherwise a caller could hand over identity A with entity B, and B's
  // content would authenticate an observation of A.
  if (entityIdentity(observed.entity) !== observed.identity) return quarantine("malformed-observation");
  // Projected HERE, from the occupant itself, using the same function the
  // preparer used on the payload. The allocated id, order and dates are not
  // part of it, so an issue that landed at a different id than expected is
  // still recognized as the one this transaction created.
  const observedFingerprint = issueCreateFingerprint(observed.entity);
  if (observedFingerprint === null) return quarantine("unconfirmed-postimage");
  return observedFingerprint === fingerprint ? APPLIED : quarantine("foreign-occupant");
}

/**
 * Filename plus content fingerprint, and never a replay.
 *
 * The body of a handover or a snapshot is not stored in the record, so there is
 * nothing to write back. Recognize it or quarantine it; inventing the content
 * would fabricate the artifact. A record whose filename is null names no file
 * at all and can only be quarantined, whatever is observed.
 */
function classifyContentArtifact(
  record: Record<string, unknown>,
  observed: CheckedObservation,
): PendingMutationOutcome {
  const filename = nonEmptyString(record.filename);
  if (filename === null) return quarantine("unidentifiable-target");
  if (!identityAgrees(filename, observed)) return quarantine("identity-mismatch");

  const fingerprint = nonEmptyString(record.contentFingerprint);
  if (fingerprint === null) return quarantine("unverifiable-content");
  if (!observed.exists) return quarantine("not-replayable");
  if (observed.contentFingerprint === null) return quarantine("unconfirmed-postimage");
  return observed.contentFingerprint === fingerprint ? APPLIED : quarantine("foreign-occupant");
}

/**
 * Classify one pending mutation against one observation.
 *
 * Takes `unknown` deliberately: the field is `z.any()` on disk and may hold a
 * record written by an older build or edited by hand, so every structural
 * assumption is checked here rather than asserted by a cast.
 */
export function classifyPendingMutation(
  record: unknown,
  observed: TargetObservation,
  authority: RecoveryAuthority,
): PendingMutationOutcome {
  const r = ownFields(record);
  if (r === null) return quarantine("unknown-variant");
  const provenance = readProvenance(r.provenance);
  if (provenance === null) return quarantine("no-provenance");

  const checked = checkObservation(observed);
  if (checked === null) return quarantine("malformed-observation");

  switch (r.type) {
    case "ticket_update":
      return classifyFieldWrite(r, checked, true, authority, provenance, TICKET_REPLAYABLE_FIELDS);
    case "ticket_recovery_write":
    case "ticket_recovery_clear":
      // Declared since T-119, written by nothing and read by nothing (ISS-933).
      // Routing them through the field-write table would let a structurally
      // valid record earn a REPLAY, and a replay verdict is an instruction to a
      // consumer -- so it would be an instruction to nobody, followed by a
      // cleared marker and the work silently gone. Quarantine is the honest
      // answer: a durable record of something this build recognizes by name and
      // can perform nothing with. They come back here when a consumer exists to
      // transcribe an allowlist from, and not before.
      return quarantine("unimplemented-variant");
    case "issue_update":
      // Not ticket-scoped: an issue transition is not authorized by a ticket
      // claim, so ticket authority is not a condition of replaying it.
      return classifyFieldWrite(r, checked, false, authority, provenance, ISSUE_REPLAYABLE_FIELDS);
    case "issue_create":
      return classifyIssueCreate(r, checked);
    case "handover_create":
    case "snapshot_save":
      return classifyContentArtifact(r, checked);
    default:
      return quarantine("unknown-variant");
  }
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

export const QUARANTINE_EVENT_TYPE = "mutation_quarantined";

/**
 * Build the durable record. The timestamp is a parameter so the record is
 * reproducible and the builder stays pure.
 */
export function buildQuarantineRecord(
  record: unknown,
  reason: QuarantineReason,
  quarantinedAt: string,
): QuarantinedMutation {
  const r = ownFields(record) ?? {};
  const provenance = readProvenance(r.provenance);
  return {
    kind: nonEmptyString(r.type) ?? "unknown",
    // Verbatim. A reason and a kind describe the decision; only the payload
    // lets someone reconstruct what was actually lost.
    payload: record ?? null,
    reason,
    quarantinedAt,
    displacedOwner: provenance?.ownerTask ?? null,
  };
}

/** Audit-event data for a quarantined record, without the payload's bulk. */
export function quarantineEventData(entry: QuarantinedMutation): Record<string, unknown> {
  return {
    kind: entry.kind,
    reason: entry.reason,
    displacedOwner: entry.displacedOwner,
    quarantinedAt: entry.quarantinedAt,
  };
}
