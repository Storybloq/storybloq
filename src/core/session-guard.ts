import {
  scanSessionSummaries,
  KNOWN_DIAGNOSTIC_KINDS,
  DIAGNOSTIC_KIND_CATEGORY,
  type ActiveSessionSummary,
  type SessionDiagnosticCategory,
  type SessionLeaseState,
  type SessionScanDiagnostic,
  type SessionScanDiagnosticKind,
  type SessionScanResult,
} from "./session-scan.js";
import {
  currentStorybloqClient,
  isSameOwnerTask,
  ownerTaskForClient,
  type OwnerTask,
  type StorybloqClient,
} from "../autonomous/client-profile.js";
import { WORKFLOW_STATES } from "../autonomous/session-types.js";
import { sanitizeDisplayText, sanitizeDisplayPath } from "./display-text.js";
import { escapeMarkdownDocumentStrict } from "./output-formatter.js";
import { CONTAINMENT_CHECKS } from "./containment-checks.js";
import { safeJson, MAX_DISPLAY_SERIALIZED_LENGTH } from "./safe-json.js";
import { boundedList } from "./bounded-list.js";

export { CONTAINMENT_CHECKS };

/**
 * A directory or session NAME, rendered for a sentence a client may RENDER
 * (ISS-897).
 *
 * `transcriptionNotes` and the rationale strings are returned by
 * `storybloq_session_guard` inside a JSON payload that arrives at the client as
 * plain MCP text, unfenced. A client that renders that text as Markdown will
 * read whatever structure the payload put there: a directory named
 * `[click](javascript:...)` authors a link, one containing `|` forges a table
 * row, and one containing `<img ...>` reaches a raw HTML sink -- in the
 * sentence telling an operator whether another agent is running, which is the
 * worst line in this output to be able to write.
 *
 * Two steps: sanitize for display FIRST, neutralize Markdown SECOND. For a
 * LABEL the order is a convention rather than a hazard -- `sanitizeDisplayText`
 * does not introduce, remove or double backslashes (it passes existing ones
 * through and substitutes `?` for what is unsafe), so applying it after
 * Markdown escaping could not double an escape that pass had inserted -- but it
 * is the same order the address compositions REQUIRE, and one order across
 * every prose sink is what makes a call site checkable at a glance. See
 * `candidateDirectories` for the case where reversing it actually breaks
 * something.
 *
 * This helper covers the LABEL half only. There is deliberately no matching
 * `proseAddress`: the two places that render addresses (`namedDirectories` and
 * `candidateDirectories`) have to SORT between the two steps, because sorting
 * the escaped strings would order the list by `&#58;` and `\u001b` rather
 * than by anything a reader can see. They compose the same two operations inline,
 * in the same order, around that sort.
 *
 * The STRUCTURED fields (`sessions[].sourceDir`, `collisions`, `diagnostics`)
 * keep the decoded strings unmodified and go through neither of these. A consumer comparing them
 * against a directory listing needs the decoded value unmodified; only prose is
 * escaped.
 */
/**
 * How many per-entry paragraphs one verdict may carry (ISS-897).
 *
 * Each collision or repetition note is a full explanation, and one is written
 * per event. The populations they are derived from are caller-supplied at the
 * typed seam and workspace-controlled on disk, so the NUMBER of notes is
 * unbounded even though every name inside them is capped -- an MCP response
 * that an operator reads during an incident is the wrong place for that.
 *
 * Twelve is enough to show the shape of a real collision (which is almost
 * always two or three directories) while refusing a payload built to flood.
 * Nothing is lost by the cap: the rationale reports the totals and the
 * structured `collisions` field carries every participant, raw.
 */
const MAX_PER_ENTRY_NOTES = 12;

/**
 * Every element is a string, HOLES INCLUDED (ISS-897).
 *
 * `Array.prototype.every` skips holes, so `new Array(2)` satisfies any
 * predicate at all. These arrays arrive from a caller-supplied scan result, so
 * a sparse one is reachable, and the callers use the answer to NARROW a type.
 */
function allStrings(values: readonly unknown[]): boolean {
  for (const value of values) {
    if (typeof value !== "string") return false;
  }
  return true;
}

const proseLabel = (value: string): string =>
  escapeMarkdownDocumentStrict(sanitizeDisplayText(value));

/**
 * Typed session-ownership guard (T-446).
 *
 * Every `/story` invocation answers one question before anything else: is
 * anything running, and may I write? Until now that was computed by a model
 * executing Step 0.5 of `SKILL.md` as prose, which cost tokens on every session
 * and regressed four times (ISS-554, ISS-568, ISS-833, ISS-848) with the same
 * shape: the prose was ambiguous, a model resolved it wrongly, and the failure
 * was a write into another agent's session. Prose cannot be unit-tested.
 *
 * This module is a TRANSCRIPTION of that prose, not an improvement on it. Every
 * branch below maps to sentences of the guard contract as it stood BEFORE T-446,
 * frozen at `test/fixtures/skill-step-0.5-pre-t446.md`. Three regions of that
 * document are quotable: Step 0.5 itself, the client-task-identity paragraph it
 * depends on, and the do-not-guess sentence in Step 3. The current `SKILL.md` is
 * NOT the authority: this ticket deliberately moved those per-relationship
 * sentences out of it and into the generated fallback. The canonical mapping
 * from sentences to verdicts lives in `test/fixtures/session-guard-matrix.json`
 * -- which also generates the shipped legacy-path file, and whose every citation
 * is asserted against the frozen document as complete sentences. Where today's
 * documented behavior is unsafe or fail-open, it is preserved here and filed:
 * ISS-897 (the scanner conceals damaged sessions), ISS-898 (no multi-session
 * rule; a takeover the server WOULD reject, whose call T-446 now withholds
 * client-side because it cannot be formed without a `clientTaskId`, leaving the
 * capability advertised and the representation question open; expired-COMPACT recovery has no
 * identity-free variant, so it binds no new `ownerTask`, preserves any
 * `ownerTask` already recorded, and derives `claudeCodeSessionId` from it when
 * one is present), ISS-899 (of the two ownership cells where this guard and
 * `liveOwnershipConflict` disagreed, the live `ownerTask` plus identity-free
 * caller cell is now CLOSED, and the ownerless legacy-id cell stays looser here
 * by design).
 *
 * The classifier is pure -- no fs, no clock, no environment -- so the matrix is
 * testable without a filesystem. `evaluateSessionGuard` is the thin IO edge.
 */

export type OwnershipRelationship =
  | "same-owner"
  | "foreign-live"
  | "unowned-legacy"
  | "expired-compact"
  | "indeterminate"
  | "none";

export type GuardAction =
  | "continue" // proceed silently; the caller's own task
  | "auto-resume" // call resume immediately, no confirmation
  | "monitor-only" // never resume by default; monitor or work elsewhere
  | "offer-recovery" // present Resume / End session / Back; act only on selection
  | "unverifiable" // stop; do not guess; send the user to `storybloq session list`
  | "free"; // nothing running

export type SessionPopulation = "activeSessions" | "resumableSessions";

export interface SessionVerdict {
  readonly sessionId: string;
  readonly sourceDir: string;

  /**
   * Which array this record arrived in.
   *
   * It is a classification INPUT (`expectCompact`), not a derivation: two
   * otherwise identical records classify differently by population, and for a
   * population-invariant violation it cannot be inferred from the other fields
   * at all. It is serialized because Step 2's reconciliation compares a
   * fingerprint of exactly the inputs a verdict was computed from, and without
   * this the caller cannot build one.
   */
  readonly population: SessionPopulation;
  readonly relationship: OwnershipRelationship;
  readonly action: GuardAction;
  readonly state: string;
  readonly mode: string;
  readonly ticketId: string | null;
  readonly ticketTitle: string | null;
  readonly leaseState: SessionLeaseState;
  readonly leaseExpiresAt: string | null;
  readonly compactPending: boolean;
  readonly ownerTask: OwnerTask | null;
  readonly rationale: string;

  /**
   * Whether the server will actually accept a `resume` call.
   *
   * DESCRIPTIVE ONLY. Nothing in this module or the skill GATES on it: the
   * `monitor-only` procedure cites it as corroboration when explaining that a
   * takeover call cannot be formed without a caller identity, but what stops
   * that call is the missing `clientTaskId`, a fact about the input.
   *
   * Be plain about the consequence rather than hiding behind that distinction:
   * the outcome IS a client-side refusal for U2, so T-446 has taken the
   * execution half of ISS-898 case 2. The causal difference is real -- an
   * unformable argument, not a policy read off this flag -- but it does not
   * preserve the old execution outcome, and no server rejection is observed.
   * ISS-898 case 2 still owns whether the offer should be withheld or marked
   * unavailable up front. It
   * differs from `resumePermittedByProse` on exactly one row (U2), where the
   * prose permits a takeover the guide then rejects for want of a caller
   * identity. That U2 divergence rests on the guide's foreign-owner rejection
   * and is NOT what the test named below exercises. Because these are claims
   * about a round trip rather than about the prose, the row whose POSITIVE claim
   * could plausibly be wrong is exercised against the real guide separately:
   * `test/autonomous/identity-free-expired-resume.test.ts`
   * proves U5's identity-free expired resume is accepted, binds no new
   * `ownerTask`, and preserves any `ownerTask` already recorded. It does NOT
   * prove ownership is untouched: the guide DERIVES `claudeCodeSessionId` from
   * `ownerTask` whenever one is recorded (`legacyClaudeSessionIdForOwner`),
   * writing a claude owner's id and CLEARING it for a codex owner. This flag is
   * about `ownerTask` alone. Withholding the OFFER, or marking this path
   * unavailable in the verdict, is still ISS-898 case 2's to decide; withholding
   * the CALL is not, because T-446 already does it.
   */
  readonly resumable: boolean;

  /**
   * Whether today's prose permits a resume here, whether that means directing an
   * automatic one or allowing one after explicit confirmation. Deliberately not
   * named "offered": on the auto-resume rows nothing is shown to the user.
   * `action` is the discriminator between automatic and user-facing.
   */
  readonly resumePermittedByProse: boolean;

  readonly requiresTakeover: boolean;
  readonly recoveryRequiresExplicitRequest: boolean;
  readonly bindsOwner: boolean;
}

/**
 * Whether the scan that produced this verdict can be shown to have observed
 * everything (ISS-897).
 *
 * The SECOND axis of the aggregate. `overallAction` alone cannot express it:
 * `free` over a scan that dropped an unreadable directory is the ISS-554 shape,
 * and it is indistinguishable from `free` over a clean one.
 *
 * `unknown` and `incomplete` take the same column of the table below and differ
 * only in the remedy. `unknown` means the reporter could not tell us, and on a
 * build old enough to omit the field `storybloq session list` ALSO drops
 * damaged sessions, so the remedy there is to restart or upgrade first.
 *
 * `incomplete` establishes that a gap EXISTS, and that is all it establishes.
 * The completeness rule accepts a recognized `omission` on its category alone
 * -- a concealment claim is never softened by the rest of the entry being
 * malformed -- so `{ category: "omission" }` sets `incomplete` while carrying
 * no usable `sourceDir` or `sourcePath`.
 *
 * A consumer therefore cannot infer from this value that an address is
 * available. Only a FULLY USABLE omission names a directory to inspect and
 * takes the addressed remedy; a malformed one takes
 * `MALFORMED_OMISSION_REMEDY`, which names no path.
 */
export type ScanCompleteness = "complete" | "incomplete" | "unknown";

export interface GuardVerdict {
  /** The single bearing session, or null when there are zero or more than one. */
  readonly primary: SessionVerdict | null;
  /** Every bearing session, sorted for stable rendering only. */
  readonly sessions: readonly SessionVerdict[];
  /** Null when more than one session bears: the prose supplies no aggregate rule. */
  readonly overallAction: GuardAction | null;
  readonly overallRationale: string;
  readonly identityUnavailable: boolean;
  /** Places where the prose is ambiguous or unsafe, recorded rather than decided. */
  readonly transcriptionNotes: readonly string[];
  /**
   * The scan's diagnostics that this build could READ, each one unchanged (ISS-897).
   *
   * Not "everything the scan reported". `classifySessionGuard` drops an entry
   * that is malformed, carries a kind this build does not know, or pairs a kind
   * with a category the kind table does not assign it -- every rule below
   * matches an EXACT kind, so an entry none of them can match cannot be acted
   * on and must not be presented as though it were. Retained entries are
   * passed through verbatim; rejected ones are accounted for in
   * `scanCompleteness` rather than dropped in silence -- and WHICH value they
   * drive it to depends on why they were rejected. A rejected entry whose
   * category is `omission` still makes completeness `incomplete`, because the
   * category alone is the concealment claim and a claim is not softened by the
   * rest of the entry being unreadable. Every other rejection -- an unknown
   * kind, a kind paired with the wrong category, a missing or mistyped field --
   * makes it `unknown`. A consumer reading this array as the raw payload will
   * conclude the scan saw less than it did.
   */
  readonly diagnostics: readonly SessionScanDiagnostic[];
  readonly scanCompleteness: ScanCompleteness;
  /**
   * The only AUTHORITATIVE record of the guard's own deduplication (ISS-914).
   *
   * "Raw" here means UNMODIFIED BY THIS BUILD, not byte-exact against the
   * filesystem. `readdirSync` hands back decoded strings, so a name holding an
   * invalid encoding sequence has already been substituted before anything in
   * this file sees it; carrying that string through untouched is the strongest
   * claim available, and it is the one made. Byte fidelity would require
   * enumerating names as buffers end to end.
   *
   * Not the only raw carrier, and the earlier wording claiming that was wrong on
   * the face of this same interface: `diagnostics` is passed through verbatim,
   * `conflictingSourceDirs` inside it is raw, and a surviving `sessions[]` row
   * keeps its raw `sourceDir`. What is unique here is provenance -- this field
   * is DERIVED from the deduplication this guard performed, so it cannot be
   * short a participant and cannot carry one that was never deduplicated, which
   * is a claim none of the others can make about themselves.
   *
   * Everything else that names a colliding directory is unfit even to OPEN by:
   *
   *  - `transcriptionNotes` are SANITIZED for display. `sanitizeDisplayText`
   *    maps every control character and bidi mark to `?`, so two distinct raw
   *    names can render identically and a rendered name can equal an unrelated
   *    literal `?` directory. Prose that reads correctly can therefore name the
   *    wrong path, or leave the real one unaddressable.
   *  - `diagnostics` entries are passed through unchanged from the scan
   *    result. At the typed seam a caller supplies that result, so
   *    `conflictingSourceDirs` can name a directory no deduplication ever
   *    touched.
   *
   * These entries are built from the deduplication event this guard performed,
   * carrying the `sourceDir` strings it acted on, unmodified. Derived
   * rather than accepted.
   *
   * "Derived" is NOT "validated", and the difference matters because a consumer
   * reaching for this field is reaching for filesystem truth it does not have.
   * `classifySessionGuard` takes a
   * `SessionScanResult` -- built in-process by a trusted caller, or read off a
   * status payload in Mode A -- so a `sourceDir` here can be `../other-project`,
   * an absolute path, or a name with no directory behind it at all. What this
   * field establishes is that TWO RECORDS IN THAT RESULT claimed one session id
   * and one was dropped from the reported population. It does not establish that either
   * string names a real, contained session directory.
   *
   * So it is authoritative about the EVENT, not about the filesystem. Before
   * touching anything a consumer must still run every check in
   * `CONTAINMENT_CHECKS` (`core/containment-checks.ts`, re-exported here). That
   * constant is the ONE statement of them and this comment deliberately does not
   * repeat it: a prose copy is a copy that drifts, and the copies are what this
   * checklist has already had to be reconciled across once.
   *
   * And those checks license INSPECTION, and inspection is where this field
   * ends. They establish that a name is a real participant in this collision.
   * WHICH participant is stale is a separate question nothing on this path
   * answers: `kept` carries no semantic preference -- it is simply the first by
   * read order, since Step 0.5 supplies no tiebreak -- and either directory may
   * hold newer or unique state. So the contract is compare the validated
   * records, report what each holds, and stop. Neither this field nor any
   * rationale derived from it authorizes a deletion or names a command that
   * performs one; that decision belongs to the operator, on evidence this guard
   * cannot supply. The comment exists so the field cannot be mistaken for a set
   * of pre-validated cleanup targets.
   */
  readonly collisions: readonly SessionCollision[];
}

/** One deduplication event, carrying the decoded names unmodified by this build (ISS-914). */
export interface SessionCollision {
  /** The embedded id both directories carried, raw. */
  readonly sessionId: string;
  /** The `sourceDir` that survived to be REPORTED, unmodified. */
  readonly kept: string;
  /**
   * The `sourceDir` dropped from the reported population, raw.
   *
   * "Dropped" means unreported, not unexamined: since ISS-914 this record is
   * still classified, solely so its policy signature can be compared against
   * the surviving verdict for its id where one exists. Where none does, the
   * comparison cannot be made and the collision withholds fail-closed.
   */
  readonly dropped: string;
}

export interface GuardCaller {
  readonly task: OwnerTask | null;
  readonly client: StorybloqClient;
}

interface Capabilities {
  readonly resumable: boolean;
  readonly resumePermittedByProse: boolean;
  readonly requiresTakeover: boolean;
  readonly recoveryRequiresExplicitRequest: boolean;
  readonly bindsOwner: boolean;
}

const NONE: Capabilities = {
  resumable: false,
  resumePermittedByProse: false,
  requiresTakeover: false,
  recoveryRequiresExplicitRequest: false,
  bindsOwner: false,
};

function caps(overrides: Partial<Capabilities>): Capabilities {
  return { ...NONE, ...overrides };
}

/**
 * The fields that decide whether two verdicts for the SAME session id are
 * interchangeable as the project-wide answer (ISS-914).
 *
 * `relationship` and `action` are what the aggregate SAYS. The capability fields
 * are what the caller may DO, and the aggregate exists to answer exactly that,
 * so leaving them out is not a simplification. Measured: a foreign owner with a
 * live lease classifies as `foreign-live` / `monitor-only` both when COMPACT and
 * when not, while all five capabilities invert between the two. One of those
 * records is recoverable by an explicit owner-gone request and the other offers
 * no recovery path at all, so a rule reading only the first two fields would
 * treat them as the same answer.
 *
 * Deliberately EXCLUDED: `state`, `ticketId`, `mode`, `sourceDir`, `ownerTask`.
 * They can differ without changing what the caller may do, and blocking on them
 * would stop an operator over a difference that costs them nothing. The
 * collision is still reported in every case; only the AGGREGATE is at stake
 * here.
 *
 * The two assertions below are set equality in both directions. A membership
 * constraint alone (`readonly (keyof SessionVerdict)[]`) rejects a misspelled
 * key but ACCEPTS a missing one, so adding a field to `Capabilities` and
 * forgetting it here would compile and silently widen the waiver.
 */
type PolicySignatureField = "relationship" | "action" | keyof Capabilities;

export const POLICY_SIGNATURE_FIELDS = [
  "relationship",
  "action",
  "resumable",
  "resumePermittedByProse",
  "requiresTakeover",
  "recoveryRequiresExplicitRequest",
  "bindsOwner",
] as const satisfies readonly (PolicySignatureField & keyof SessionVerdict)[];

type _CoversEveryPolicyField =
  PolicySignatureField extends (typeof POLICY_SIGNATURE_FIELDS)[number] ? true : never;
type _AddsNoOtherPolicyField =
  (typeof POLICY_SIGNATURE_FIELDS)[number] extends PolicySignatureField ? true : never;
const _coversEveryPolicyField: _CoversEveryPolicyField = true;
const _addsNoOtherPolicyField: _AddsNoOtherPolicyField = true;
void _coversEveryPolicyField;
void _addsNoOtherPolicyField;

/**
 * Does this collision withhold the aggregate? (ISS-914)
 *
 * Pure and exported because the `!survivor` arm is UNREACHABLE through
 * `classifySessionGuard` -- a dropped record's id was `seen`, so its kept record
 * is in `deduped`, and the verdict loop produces a verdict for every deduped
 * entry unconditionally (the gates change a verdict's ACTION, they do not remove
 * it from the population). It is kept as the fail-closed default and is covered
 * by a direct unit test rather than being claimed as classifier-reachable.
 */
export function collisionBlocksAggregate(
  dropped: SessionVerdict,
  survivor: SessionVerdict | undefined,
): boolean {
  if (!survivor) return true;
  return POLICY_SIGNATURE_FIELDS.some((field) => dropped[field] !== survivor[field]);
}

/** Display order only. Nothing reads this to choose a winner (see `aggregate`). */
const RENDER_ORDER: readonly OwnershipRelationship[] = [
  "same-owner",
  "foreign-live",
  "unowned-legacy",
  "expired-compact",
  "indeterminate",
  "none",
];

interface Classification {
  readonly relationship: OwnershipRelationship;
  readonly action: GuardAction;
  readonly capabilities: Capabilities;
  readonly rationale: string;
  readonly note?: string;
}

/**
 * A session reached the scanner's `resumableSessions` array, which means COMPACT
 * + compactPending + a non-live lease. The prose splits that population in two.
 */
function classifyResumable(summary: ActiveSessionSummary, identityAvailable: boolean): Classification {
  // Step 0.5's recovery bullet is scoped to an "Expired COMPACT session". A
  // lease with no `expiresAt` (missing) or an unparseable one (invalid) is not
  // expired -- it is undetermined, and the sentence that reaches it is:
  //
  //   "If state, lease, or full identity still cannot be determined, stop and
  //    tell the user to run `storybloq session list`; do not guess."
  //
  // The scanner lumps all three states into one array, and an earlier draft of
  // this module read its behavior off that membership rather than off the text.
  // Separating the scanner's own reporting is ISS-897; the guard no longer
  // depends on it.
  if (summary.leaseState !== "expired") {
    return {
      relationship: "indeterminate",
      action: "unverifiable",
      capabilities: NONE,
      rationale:
        `Lease state is \`${summary.leaseState}\`, so this session's liveness cannot be determined. ` +
        "Stop and run `storybloq session list`; do not guess.",
    };
  }

  // Identity-unavailable expired recovery is PRESERVED, not fail-closed.
  //
  // An earlier draft returned `unverifiable` here, citing "If state, lease, or
  // full identity still cannot be determined, stop ... do not guess." That
  // sentence is about a SESSION whose observation is incomplete, not about a
  // caller with no task id, and the paragraph that IS about the caller says the
  // opposite: "Missing or malformed identity never blocks the legacy workflow"
  // and "when identity is unavailable, guide ownership checks preserve the
  // legacy fail-open behavior". Blocking here would have been a behavior change
  // wearing a citation.
  //
  // So the offer stands and `bindsOwner` is false -- not because a sentence
  // grants an exception, but because there is no id to bind. That the bullet
  // still describes recovery as "passing the current `clientTaskId`" and
  // "rebinds ownership", neither of which is possible, is a real gap in the
  // prose. It is filed (ISS-898 case 3), not resolved here.
  //
  // `bindsOwner: false` says no NEW owner is bound. It does not say the session
  // is unowned afterward: this classification reaches expired sessions that
  // already carry an `ownerTask`, and the guide leaves that owner in place. It
  // says nothing about the legacy `claudeCodeSessionId`, which this verdict
  // cannot see at all (ISS-899) and which the guide DERIVES from `ownerTask`.
  // Measured, not inferred: `test/autonomous/identity-free-expired-resume.test.ts`
  // covers the owner axis end to end.

  // "Expired COMPACT session: offer Resume here, End session, or Back. Resume
  //  only after explicit selection ... successful recovery rebinds ownership."
  return {
    relationship: "expired-compact",
    action: "offer-recovery",
    capabilities: caps({
      resumable: true,
      resumePermittedByProse: true,
      recoveryRequiresExplicitRequest: true,
      // No caller identity means no new `ownerTask` to bind, as a fact of the
      // call. Says nothing about `claudeCodeSessionId`, which the guide may
      // still write; see the rationale below.
      bindsOwner: identityAvailable,
    }),
    rationale: identityAvailable
      ? "Expired COMPACT session. Offer Resume here, End session, or Back; act only on an explicit selection."
      : "Expired COMPACT session with no caller identity. Offer Resume here, End session, or Back; act only on an explicit selection. Omit `clientTaskId`: there is none to pass, so no new `ownerTask` is bound and any `ownerTask` already recorded is preserved. Recovery still derives `claudeCodeSessionId` from `ownerTask` where one is recorded: written for a claude owner, cleared for a codex owner, untouched only when there is no owner (ISS-898 case 3).",
    note: identityAvailable
      ? undefined
      : "U5: the expired-COMPACT bullet describes recovery as passing the current `clientTaskId` and rebinding ownership, neither of which is possible without an identity, and supplies no variant for that. Legacy fail-open is preserved and the gap is filed as ISS-898 case 3.",
  };
}

/**
 * Whether the record's workflow state is one the state machine defines.
 *
 * The scanner substitutes `"unknown"` when `state` is absent and copies through
 * any string that is present, so an undetermined state arrives here looking
 * exactly like a determined one. Every ownership row below branches on
 * `state === "COMPACT"`, which silently reads every other string -- including
 * `"unknown"` and a typo -- as a valid non-COMPACT state.
 */
function isKnownWorkflowState(state: string): boolean {
  return (WORKFLOW_STATES as readonly string[]).includes(state);
}

/**
 * The state gate, or null when the state is determined.
 *
 * "If state, lease, or full identity still cannot be determined, stop and tell
 *  the user to run `storybloq session list`; do not guess."
 *
 * The rule names STATE first, and it is the axis with the sharpest failure:
 * treating an undetermined state as non-COMPACT can hand a same-owner caller
 * `continue` for a session that actually needs COMPACT recovery. It runs at the
 * DISPATCH point, before either array's classifier, for two reasons: the answer
 * does not depend on who owns the session, and `classifySessionGuard` is
 * exported and takes a plain `SessionScanResult`. Today's scanner only puts
 * COMPACT records in `resumableSessions`, but a caller that built one by hand
 * could otherwise reach `classifyResumable` -- which inspects only the lease --
 * and be handed `offer-recovery` for a session whose state is a typo.
 */
export interface PreOwnershipGate {
  /** Stable id. The generated fallback and its fixture are keyed on these. */
  readonly id: string;
  readonly applies: (summary: ActiveSessionSummary, expectCompact: boolean) => boolean;
  readonly rationale: (summary: ActiveSessionSummary, expectCompact: boolean) => string;
}

/**
 * Every gate that runs BEFORE ownership, in evaluation order.
 *
 * A table rather than a chain of `if`s because the generated legacy-path file
 * has to apply the same gates in the same order, and a reader who meets a record
 * violating SEVERAL of them must land on the same one the tool lands on. That
 * precedence is not expressible as a section ordering in the generated file --
 * these gates are deliberately NOT contiguous by topic (`recovery-not-compact`
 * runs after the terminal and unknown-state gates, not beside the other two
 * population gates) -- so the order is published as data and asserted against
 * this array. Adding a gate here without registering it in the fixture fails the
 * parity test, which is the point: the previous version pinned a hand-written
 * list of ids against itself and would not have noticed.
 *
 * Membership invariants come first. `activeSessions` means a LIVE lease and
 * `resumableSessions` means COMPACT + compactPending + a non-live lease -- both
 * enforced by the scanner, neither by the type. A hand-built entry that violates
 * them is not a case Step 0.5 describes: an active entry with a `missing` lease
 * would reach `classifyLive` and get `continue` even though its liveness was
 * never established, and a resumable entry with `compactPending: false` would
 * get `offer-recovery` for a configuration the scanner produces no verdict for.
 */
export const PRE_OWNERSHIP_GATES: readonly PreOwnershipGate[] = [
  {
    id: "active-lease-not-live",
    applies: (s, expectCompact) => !expectCompact && s.leaseState !== "live",
    rationale: (s) =>
      "A session reported as active has lease state " +
      `\`${s.leaseState}\`, which that population cannot contain, so its liveness cannot be determined. ` +
      "Run `storybloq session list`.",
  },
  {
    id: "recovery-lease-live",
    applies: (s, expectCompact) => expectCompact && s.leaseState === "live",
    rationale: (s) =>
      "A session reported as a recovery candidate has lease state " +
      `\`${s.leaseState}\`, which that population cannot contain, so its liveness cannot be determined. ` +
      "Run `storybloq session list`.",
  },
  {
    id: "recovery-not-pending",
    applies: (s, expectCompact) => expectCompact && !s.compactPending,
    rationale: () =>
      "A session offered as a recovery candidate must have `compactPending`. Without it the scanner produces no " +
      "verdict at all, so there is no rule to apply. Run `storybloq session list`.",
  },
  {
    // `SESSION_END` is a VALID workflow state and never a bearing one: the
    // scanner drops it outright (`session-scan.ts`), so neither population can
    // contain it. The state gate below would wave it through as a perfectly
    // ordinary non-COMPACT state, which at the exported classifier seam means a
    // caller can hand in a terminal session and be told to `continue` it -- an
    // actionable verdict for a session that has ended, invented at the one
    // boundary the scanner does not guard. Its presence means the input did not
    // come from the scanner, so its bearing status cannot be trusted.
    id: "terminal-session-end",
    applies: (s) => s.state === "SESSION_END",
    rationale: () =>
      "A session in `SESSION_END` has finished, and the scanner never reports one, so this record did not come " +
      "from a scan and its bearing status cannot be established. Run `storybloq session list`.",
  },
  {
    id: "unknown-workflow-state",
    applies: (s) => !isKnownWorkflowState(s.state),
    rationale: (s) =>
      // `proseLabel(safeJson(...))`, not a bare `JSON.stringify`. This sentence
      // goes into `transcriptionNotes`, and the guard's stated contract for
      // that field is that it is ALREADY rendered safely -- SKILL.md tells the
      // reader to quote it as it arrives. `JSON.stringify` neutralizes control
      // characters and nothing else, so a `state` of `[click](javascript:...)`
      // authored a link inside the one field the reader is told not to clean
      // up, and an enormous one had no bound at all.
      `Session state ${proseLabel(safeJson(s.state, MAX_DISPLAY_SERIALIZED_LENGTH))} is not a known workflow state, so whether it needs COMPACT recovery cannot be determined. Run \`storybloq session list\`.`,
  },
  {
    // A recovery candidate that is not COMPACT is not one the recovery sentence
    // describes; the scanner never produces it, so anything that does is unknown
    // input rather than a case with a documented rule.
    id: "recovery-not-compact",
    applies: (s, expectCompact) => expectCompact && s.state !== "COMPACT",
    rationale: (s) =>
      `A session offered as a recovery candidate must be in COMPACT, not ${proseLabel(safeJson(s.state, MAX_DISPLAY_SERIALIZED_LENGTH))}. Run \`storybloq session list\`.`,
  },
];

function indeterminateState(summary: ActiveSessionSummary, expectCompact: boolean): Classification | null {
  for (const gate of PRE_OWNERSHIP_GATES) {
    if (gate.applies(summary, expectCompact)) {
      return {
        relationship: "indeterminate",
        action: "unverifiable",
        capabilities: NONE,
        rationale: gate.rationale(summary, expectCompact),
      };
    }
  }
  return null;
}

/** A session in `activeSessions`, which means its lease is live. */
function classifyLive(summary: ActiveSessionSummary, caller: GuardCaller): Classification {
  const identityAvailable = caller.task !== null;

  const compact = summary.state === "COMPACT";

  // POLICY (ISS-899): this guard classifies on `ownerTask` alone and never
  // consults `claudeCodeSessionId`; the guide keeps resolving ownership through
  // that legacy id, and the resulting looseness in THIS cell is accepted rather
  // than transcribed away.
  //
  // Why it is not transcribed: the id appears nowhere in `SKILL.md` as an
  // ownership rule, and the scanner does not project the field into
  // `ActiveSessionSummary`, so a classifier reading it would be reading the
  // implementation instead of the text and could not do so on an older server.
  //
  // What that costs, stated in the honest direction: for an ownerless session
  // carrying a legacy id, this row advises attempting a COMPACT recovery that
  // the guide may then refuse on a mismatch. SKILL.md now describes that
  // adjudication and its escape instead of promising the bind, so the advice
  // leads somewhere rather than dead-ending. The OTHER ISS-899 cell, an
  // `ownerTask` session on a live lease met by a caller with no identity, is
  // CLOSED: the guide refuses it now, matching the monitor-only rows below.
  if (summary.ownerTask === null) {
    return compact
      ? {
          // "Live legacy session without `ownerTask`, COMPACT: call `resume` ...
          //  this migration recovery binds the current task."
          relationship: "unowned-legacy",
          action: "auto-resume",
          capabilities: caps({
            resumable: true,
            resumePermittedByProse: true,
            bindsOwner: identityAvailable,
          }),
          // The binding half is conditional, and saying otherwise contradicts
          // `bindsOwner` in the same verdict: "If task identity is unavailable,
          // the guide preserves legacy resume behavior WITHOUT binding."
          rationale: identityAvailable
            ? "Legacy COMPACT session with no recorded owner. Migration recovery: resume and bind."
            : "Legacy COMPACT session with no recorded owner, and no caller identity to bind. Resume without binding.",
        }
      : {
          // "Live legacy session without `ownerTask`, non-COMPACT: ownership
          //  cannot be verified. Offer only Monitor or work here on something else."
          relationship: "unowned-legacy",
          action: "monitor-only",
          capabilities: NONE,
          rationale: "Live legacy session with no recorded owner. Ownership cannot be verified; monitor or work elsewhere.",
        };
  }

  // "Missing or malformed identity never blocks the legacy workflow, but it
  //  cannot prove same-task ownership." So with no caller identity, a session
  //  bearing ANY owner task falls to the different-owner rows below.
  const sameOwner = identityAvailable && isSameOwnerTask(summary.ownerTask, caller.task);

  if (sameOwner) {
    return compact
      ? {
          // "Same owner, COMPACT: call storybloq_autonomous_guide automatically
          //  ... Do not ask for another confirmation."
          relationship: "same-owner",
          action: "auto-resume",
          capabilities: caps({ resumable: true, resumePermittedByProse: true, bindsOwner: true }),
          rationale: "Your own task, compacted. Resume automatically and continue the pipeline.",
        }
      : {
          // "Same owner, non-COMPACT: this is the current autonomous task, not a
          //  foreign session. Do not show an Active Autonomous Session banner and
          //  do not ask for Resume."
          relationship: "same-owner",
          action: "continue",
          capabilities: NONE,
          rationale: "Your own task. Continue; do not show a session banner and do not ask for Resume.",
        };
  }

  if (!compact) {
    // "Different live owner, non-COMPACT: never call or offer `resume`." The
    // guide accepts `resume` only from COMPACT, so offering it produced the
    // Ratify -> Resume -> rejection loop of ISS-848.
    return {
      relationship: "foreign-live",
      action: "monitor-only",
      capabilities: NONE,
      rationale: "Another task holds this live session. Monitor or work here on something else; never offer Resume.",
    };
  }

  // "Different live owner, COMPACT: do not resume automatically. Prefer Open
  //  task or Monitor. If the user explicitly asks to recover here, confirm that
  //  the recorded owner task is gone, then call `resume` once with ...
  //  `takeover: true`."
  //
  // The prose conditions the takeover on the OWNER being gone and on nothing
  // else -- never on the caller having an identity. But `takeover: true` binds
  // the recovering caller, so with no `clientTaskId` the guide rejects the call.
  // Both facts are recorded in the verdict, and the OFFER is preserved: this row
  // still advertises `resumePermittedByProse`. The CALL is not preserved. With
  // no `clientTaskId` the prescribed call cannot be formed at all, so the
  // procedure stops before any confirmation -- observably a client-side refusal,
  // and the execution half of ISS-898 case 2 taken deliberately rather than
  // transcribed. What case 2 still owns is whether this row should advertise the
  // capability at all, or report it unavailable up front.
  return {
    relationship: "foreign-live",
    action: "monitor-only",
    capabilities: caps({
      resumable: identityAvailable,
      resumePermittedByProse: true,
      requiresTakeover: true,
      recoveryRequiresExplicitRequest: true,
      bindsOwner: identityAvailable,
    }),
    rationale: identityAvailable
      ? "Another task holds this compacted session. Recovery is possible only on an explicit request, after confirming the owner task is gone."
      : "Another task holds this compacted session. The prose permits recovery on explicit request, but the call it prescribes needs a `clientTaskId` that does not exist here, so it is not issued; the guide would reject it in any case (ISS-898 case 2).",
    note:
      identityAvailable
        ? undefined
        : "U2: `resumePermittedByProse` is true and `resumable` is false. The call is NOT issued: its required `clientTaskId` cannot be formed without a " +
          "caller identity, so the procedure stops client-side and no server rejection is observed. That is the execution half of ISS-898 case 2, taken " +
          "deliberately; what remains open there is whether the offer should be withheld or marked unavailable up front. See ISS-898 case 2.",
  };
}

function toVerdict(summary: ActiveSessionSummary, c: Classification, expectCompact: boolean): SessionVerdict {
  return {
    sessionId: summary.sessionId,
    sourceDir: summary.sourceDir,
    population: expectCompact ? "resumableSessions" : "activeSessions",
    relationship: c.relationship,
    action: c.action,
    state: summary.state,
    mode: summary.mode,
    ticketId: summary.ticketId,
    ticketTitle: summary.ticketTitle,
    leaseState: summary.leaseState ?? "missing",
    leaseExpiresAt: summary.leaseExpiresAt ?? null,
    compactPending: summary.compactPending === true,
    ownerTask: summary.ownerTask ?? null,
    rationale: c.rationale,
    ...c.capabilities,
  };
}

/**
 * Every category this build knows. An element outside it is unclassifiable HERE.
 *
 * Why it is unclassifiable is not something this build can tell: a newer writer
 * is one explanation, a hand-edited payload, a wrong-shaped Mode A response and
 * a typo are others, and nothing on this path distinguishes them. The handling
 * is the same for all of them, which is why the code does not try.
 *
 * Derived from an EXHAUSTIVE record rather than written as a string list: adding
 * a category to `SessionDiagnosticCategory` without adding it here would make
 * this build classify its own valid diagnostics as unclassifiable, and drive
 * healthy projects to `unverifiable`. The record makes that a compile error.
 */
const DIAGNOSTIC_CATEGORIES: Record<SessionDiagnosticCategory, true> = {
  omission: true,
  normalized: true,
  undetermined: true,
  collision: true,
};
const KNOWN_DIAGNOSTIC_CATEGORIES: ReadonlySet<string> = new Set(Object.keys(DIAGNOSTIC_CATEGORIES));

/**
 * The element's `category`, when it is one this build knows; null otherwise.
 *
 * Category level ONLY, and that is what makes it the completeness test rather
 * than the classification test. An `omission` whose other fields are garbage
 * still means the scan concealed something, so this answers on `category`
 * without looking at anything else. `isUsableDiagnostic` below is the shared
 * narrowing that decides whether fields may be READ.
 */
function recognizedCategory(entry: unknown): SessionDiagnosticCategory | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const category = (entry as { category?: unknown }).category;
  return typeof category === "string" && KNOWN_DIAGNOSTIC_CATEGORIES.has(category)
    ? (category as SessionDiagnosticCategory)
    : null;
}

/**
 * Is this entry safe to READ FIELDS off, not merely to categorize?
 *
 * The single narrowing used by both `completenessFromDiagnostics` and
 * `classifySessionGuard`, so the two cannot disagree about what is classifiable.
 * That split is what made the defensive completeness check hollow: it accepted
 * `null`, a primitive, an array, and a future category and answered `unknown`,
 * and then the classifier ran `.filter((d) => d.category === ...)` over the same
 * array and THREW on the first `null`. A guard whose whole contract is to fail
 * closed on an untrusted payload cannot fail by crashing, because the caller
 * then has no verdict at all -- strictly worse than the `unverifiable` the
 * completeness check went to the trouble of computing.
 *
 * Two checks, deliberately separate. `recognizedCategory` answers the
 * completeness question and needs only `category` -- an `omission` whose other
 * fields are garbage still means the scan concealed something, and downgrading
 * that to `unknown` would trade a specific warning for a vaguer one.
 *
 * This one is the gate for everything else, because every downstream consumer
 * reads `sourceDir`, `sourcePath`, `reason`, or `kind`. Validating only the
 * category was the same crash one property over: `{ category: "omission" }`
 * passed, `namedDirectories` then called `sanitizeDisplayPath(undefined)`, and
 * the guard threw instead of returning the fail-closed verdict the category
 * check had just earned.
 */
function isUsableDiagnostic(entry: unknown): entry is SessionScanDiagnostic {
  const category = recognizedCategory(entry);
  if (category === null) return false;
  const d = entry as Record<string, unknown>;
  if (
    typeof d.kind !== "string" ||
    // KNOWN kind, not merely a string. The blocking rules match exact kinds, so
    // a well-formed diagnostic this build does not recognize triggers nothing --
    // and calling it usable would leave completeness `complete` while an
    // ownership fault this build cannot read goes unenforced. Unusable means
    // `unknown`, which withholds the aggregate; that is the fail-closed answer.
    !KNOWN_DIAGNOSTIC_KINDS.has(d.kind) ||
    // ...and the kind must carry ITS category. Checking the two fields
    // separately accepted `{ kind: "state-unreadable", category: "normalized" }`:
    // both values recognized, so usable, so completeness `complete` -- while
    // that kind means a record was concealed and nothing fires on a
    // `normalized` entry to say so. The pair is the contract; half of it
    // validated is a fail-open that needs no hostility to reach, just a wrong
    // payload or a version that disagrees about what a kind means.
    DIAGNOSTIC_KIND_CATEGORY[d.kind as SessionScanDiagnosticKind] !== category ||
    (d.sourceDir !== null && typeof d.sourceDir !== "string") ||
    typeof d.sourcePath !== "string" ||
    (d.sessionId !== null && typeof d.sessionId !== "string") ||
    typeof d.reason !== "string"
  ) {
    return false;
  }
  // The collision carrier is the one optional field, and the one whose contents
  // get read back to an operator as the set of directories claiming an id.
  // Nothing it names authorizes a filesystem action -- it is supplied, not
  // derived, so it is a cross-check at best -- but a malformed one silently
  // changes what the collision REPORT says. Absent is fine; present-and-
  // malformed is not.
  if (d.conflictingSourceDirs !== undefined) {
    if (!Array.isArray(d.conflictingSourceDirs)) return false;
    // NOT `.every`. It skips HOLES, so a sparse array -- `new Array(2)`, or a
    // JSON payload assembled by something other than this build's scanner --
    // passes a predicate no element ever satisfied, and this function's whole
    // job is to narrow the value for consumers downstream. `for..of` visits
    // holes as `undefined`.
    if (!allStrings(d.conflictingSourceDirs)) return false;
  }
  return true;
}

/**
 * Derive scan completeness from a diagnostics array, in this order (ISS-897).
 *
 * 1. A recognized `omission` wins outright. A positively identified concealment
 *    is not weakened by malformed elements sitting beside it.
 * 2. Otherwise any element that is not FULLY USABLE -> `unknown`. That is a
 *    wider test than it first reads, and the width is the point: not an object,
 *    no string `category`, a category this build does not know, an unrecognized
 *    or non-string `kind`, a kind the table does not pair with the category the
 *    element carries, or any common field of the wrong type. Checking only the
 *    category is the fail-open this closes -- `{"category": "undetermined"}`
 *    carries a recognized category and no usable kind, so it can trigger no
 *    rule, and calling it `complete` lets a blocker this build could not read
 *    RAISE the aggregate. An unrecognized
 *    category could perfectly well be concealing, and this build can neither
 *    classify it nor tell where it came from -- a newer writer, a hand-edited
 *    payload and a typo are indistinguishable here -- so reading it as harmless
 *    is a fail-open at the deserialization boundary.
 * 3. Otherwise `complete`, the empty array included.
 *
 * ABSENCE is deliberately NOT handled here, because it means different things at
 * the two seams; see `classifySessionGuard`.
 */
export function completenessFromDiagnostics(diagnostics: readonly unknown[]): ScanCompleteness {
  // The CONTAINER is untrusted too, not just its elements. `{}` has no iterator
  // and a string iterates into characters, so assuming an array here crashed or
  // silently mis-derived before any element check could run.
  if (!Array.isArray(diagnostics)) return "unknown";
  let sawUnusable = false;
  for (const entry of diagnostics) {
    const category = recognizedCategory(entry);
    // A recognized `omission` wins on its CATEGORY ALONE, malformed or not: it
    // still says the scan concealed something, and answering `unknown` there
    // would trade a specific warning for a vaguer one.
    if (category === "omission") return "incomplete";
    // Everything else must be USABLE to count as clean. An unreadable category
    // is obviously unclassifiable -- but so is a recognized `undetermined`
    // whose fields are garbage, because it is dropped before it can block, and
    // `owner-task-undetermined` is precisely a kind that withholds the
    // aggregate. Treating it as `complete` would let a malformed ownership
    // fault RAISE the verdict from `unverifiable` to `continue`, which is the
    // one direction this axis must never move by losing data.
    if (category === null || !isUsableDiagnostic(entry)) sawUnusable = true;
  }
  return sawUnusable ? "unknown" : "complete";
}

/** The remedy wherever completeness is `unknown`, where there is no directory to name. */
const UNKNOWN_COMPLETENESS_REMEDY =
  "The scan did not report whether it observed everything, so this build cannot tell an empty result from a concealed one. " +
  "Restart your AI client to reload the MCP server, or upgrade storybloq, then rerun the guard -- a build old enough to omit that report " +
  "also drops damaged sessions from `storybloq session list`, so running that first can show no problem where one exists.";

/**
 * The remedy for a MALFORMED omission carrier, which is a different situation
 * from `unknown` completeness and must not borrow its words.
 *
 * `UNKNOWN_COMPLETENESS_REMEDY` opens with "the scan did not report whether it
 * observed everything". Here the scan DID report: the category-only rule read
 * `omission` off the entry and completeness is already `incomplete`. What is
 * missing is only the carrier's address. Appending the `unknown` explanation
 * gave the operator two incompatible accounts of the same payload in one
 * paragraph, so this states the narrower fact and keeps the same action.
 */
const MALFORMED_OMISSION_REMEDY =
  "The gap itself is established; what is missing is the address of the entry behind it, so no path is named here. " +
  "Restart your AI client to reload the MCP server, or upgrade storybloq, then rerun the guard.";

/**
 * Directory names for PROSE, so they are sanitized.
 *
 * Every string this file builds for a human -- `overallRationale` and
 * `transcriptionNotes` -- embeds names read off the filesystem, and they are
 * read during an incident, when the reader is deciding whether another agent is
 * running. A newline in a directory name forges a line; an ESC sequence
 * repaints the screen. The STRUCTURED fields (`sessions[].sourceDir`,
 * `diagnostics`) deliberately keep the decoded strings unmodified, because a consumer comparing
 * them against the filesystem needs what is actually there.
 */
function namedDirectories(diagnostics: readonly SessionScanDiagnostic[]): string {
  // Pick the sanitizer by FIELD, not by the value that happens to be there. A
  // collection-level fault has `sourceDir: null` by design, so its `sourcePath`
  // is the only actionable address it has, and the 300-char label cap would make
  // a deeply nested one unusable.
  // Deduplicate the RAW values, then render. Rendering first collapses two
  // genuinely different directories into one entry whenever they display alike
  // -- which `sanitizeDisplayText` makes easy, since every control character
  // becomes `?` -- so the gap COUNT printed beside this list would be right
  // while the list itself had silently lost one.
  const seenRaw = new Set<string>();
  const names: string[] = [];
  for (const d of diagnostics) {
    const key = d.sourceDir !== null ? `d:${d.sourceDir}` : `p:${d.sourcePath}`;
    if (seenRaw.has(key)) continue;
    seenRaw.add(key);
    names.push(d.sourceDir !== null ? sanitizeDisplayText(d.sourceDir) : sanitizeDisplayPath(d.sourcePath));
  }
  // Sorted on the SANITIZED form, escaped after. Sorting the escaped strings
  // would order by `&#58;` and `\u001b` rather than by anything a reader sees.
  // BOUNDED as a list, not just per name. Each name is capped, and the number
  // of them is not: the diagnostics array is caller-supplied and the sessions
  // directory is workspace-controlled, so joining all of them puts an
  // arbitrarily long sentence in an MCP response. The COUNT survives the cut,
  // because a shortened list that does not say it was shortened reads as the
  // whole set.
  return boundedList(names.sort().map(escapeMarkdownDocumentStrict), { noun: "directories" });
}

/**
 * The same directories, rendered for a sentence that sends someone to OPEN one
 * (ISS-897).
 *
 * `namedDirectories` renders LABELS: `sanitizeDisplayText` maps control
 * characters, U+2028/9 and bidi marks to `?`. That is structurally safe and
 * readable, and it is deliberately lossy -- every dangerous code point becomes
 * the same `?`, and `?` is itself a legal filename character, so two distinct
 * directories can render as one name and either can collide with a real
 * `dir?x`. A label is consequently not an identity and not an address. A repair
 * instruction built from one can send an operator to edit a different file.
 *
 * `sanitizeDisplayPath` is reversible, so the operator can recover the decoded
 * path string unmodified by this rendering. It still does not make the value SAFE: see the checks each of these
 * sentences requires before anything is opened.
 *
 * This is where the two-pass ORDER stops being a convention and starts being
 * load-bearing. `sanitizeDisplayPath` doubles backslashes, and Markdown
 * escaping inserts them. Encode first and a name containing `[` ends as `a\[b`,
 * which renders as the three characters `a[b`. Reverse the two and the Markdown
 * pass inserts that backslash first, `sanitizeDisplayPath` doubles it, and
 * `a\\[b` renders as an escaped BACKSLASH followed by a LIVE `[` -- the link or
 * table cell is structural again. (Injectivity is not what the order buys: the
 * pair stays distinct either way, since whichever pass sees a literal backslash
 * doubles it. `test/core/display-text.test.ts` runs both compositions and pins
 * both facts.)
 */
function candidateDirectories(diagnostics: readonly SessionScanDiagnostic[]): string {
  // RAW dedup, for the same reason as above and with more riding on it: this
  // list is what an operator validates and then opens, so folding two distinct
  // raw candidates into one entry drops a file they were asked to check.
  const raw = [...new Set(diagnostics.map((d) => d.sourceDir ?? d.sourcePath))];
  return boundedList(raw.map((v) => sanitizeDisplayPath(v)).sort().map(escapeMarkdownDocumentStrict), { noun: "addresses" });
}


/**
 * Kinds `storybloq session list` structurally CANNOT show, so the remedy must
 * not name that command for them.
 *
 * Pointing an operator at a command that prints nothing reads as "no problem",
 * which is the dead end ISS-897 exists to close, reintroduced in the sentence
 * meant to close it. So the membership of this set is a claim about what
 * `listAllSessionsDetailed` actually reports, and it has to be re-checked
 * whenever that function changes.
 *
 * `entry-not-a-directory` is NOT here, and its absence is the load-bearing
 * part. The scanner diagnoses a symlink of any name or a session-shaped
 * non-directory, and `listAllSessionsDetailed` now surfaces exactly those two
 * shapes in `unavailable` -- they were being dropped silently, which put the
 * concealment in the command the guard sends you to rather than removing it.
 * Listing the kind here would have told the operator the fault is invisible to
 * a command that renders it.
 *
 * What remains is what that function genuinely cannot reach. A collection-level
 * fault cannot be rendered as a session ROW at all, because enumeration is what
 * failed -- `listAllSessionsDetailed` now THROWS for an unreadable or dangling
 * sessions root and returns empty only for a proven absence, so neither outcome
 * produces a row to carry the warning.
 *
 * `entry-not-contained` is the awkward one and stays here deliberately. The
 * scanner emits it for TWO conditions its boolean cannot separate: a path proven
 * to resolve outside the root, and a path whose canonicalization failed. The
 * enumerator now distinguishes them -- a proven escape is dropped in silence, a
 * failed probe becomes an `unavailable` row -- so the kind is visible in one of
 * its two cases and invisible in the other. Membership has to be decided on the
 * KIND, which does not carry the difference, so it is decided conservatively:
 * telling an operator to run a command that will show them nothing is the dead
 * end this set exists to prevent, and it is the worse of the two errors.
 */
const SESSION_LIST_BLIND_KINDS = new Set<SessionScanDiagnostic["kind"]>([
  "sessions-dir-unreadable",
  "entry-not-contained",
]);

export function classifySessionGuard(summaries: SessionScanResult, caller: GuardCaller): GuardVerdict {
  const identityAvailable = caller.task !== null;
  const notes: string[] = [];

  // ABSENCE MEANS DIFFERENT THINGS AT THE TWO SEAMS, and collapsing them is a
  // breaking change either way round.
  //
  // HERE the argument is a `SessionScanResult` built in-process by a caller
  // inside this build, and `diagnostics` is optional exactly like `leaseState`
  // and `compactPending` on `ActiveSessionSummary`. Absence is `complete`, so
  // every hand-built input keeps the verdict it had before this field existed
  // and T-446's frozen matrix is untouched. `evaluateSessionGuard` never takes
  // this branch: `scanSessionSummaries` always populates the field.
  //
  // At the OTHER seam -- mode A of `session-guard-fallback.md`, reading a
  // `storybloq_status` payload off a server that may predate the field --
  // absence is `unknown` and yields `unverifiable`, because there it is a
  // capability signal about a scan this build did not perform.
  const supplied: unknown = summaries.diagnostics;
  const containerIsArray = Array.isArray(supplied);
  const rawDiagnostics: readonly unknown[] = containerIsArray ? (supplied as readonly unknown[]) : [];
  // Derived from what was SUPPLIED, not from the array substituted for it.
  // Handing the empty stand-in to the completeness rule answered `complete` for
  // a container this build could not read at all -- the note below would then
  // say `unknown` beside a verdict of `continue`, which is both a contradiction
  // and the wrong direction: an unreadable container is missing information, and
  // missing information may never raise the verdict.
  const scanCompleteness: ScanCompleteness =
    supplied === undefined ? "complete" : completenessFromDiagnostics(supplied as readonly unknown[]);
  if (supplied !== undefined && !containerIsArray) {
    notes.push(
      "The scan result supplied a `diagnostics` field that is not an array, so no diagnostic could be read from it at all. " +
        "Scan completeness is `unknown` and the aggregate is withheld. This build's scanner always supplies an array (empty when " +
        "the scan was clean), so the result was assembled somewhere else; obtain a fresh scan and rerun the guard.",
    );
  }
  // NARROWED before any property is touched. `completenessFromDiagnostics`
  // already answered `unknown` for anything unrecognized; reading `.category`
  // off the same array would throw on a `null` element and destroy the verdict
  // that answer was computed for. Everything downstream uses this array.
  const diagnostics = rawDiagnostics.filter(isUsableDiagnostic);
  const unclassifiableCount = rawDiagnostics.length - diagnostics.length;
  if (unclassifiableCount > 0) {
    // Dropped from the RETURNED array too, because `GuardVerdict.diagnostics` is
    // typed and every consumer reads fields off it -- handing them the same
    // shapes that would have thrown here just moves the crash downstream. The
    // count is reported instead, so nothing is silently lost: the reader learns
    // entries existed, that this build could not classify them, and (via
    // `scanCompleteness: "unknown"`) that the aggregate is withheld because of it.
    notes.push(
      `${unclassifiableCount} scan diagnostic${unclassifiableCount === 1 ? "" : "s"} could not be read by this build and ` +
        "were not returned in `diagnostics`. An entry is dropped when it is not an object; carries a `category` outside the four " +
        "this build knows; carries a `kind` this build does not know; carries a known `kind` paired with the WRONG category (one " +
        "kind means one category, and validating the two separately is how a concealing kind slips through wearing a benign one); " +
        "is missing or mistypes a field every consumer reads (`kind`, `sourceDir`, `sourcePath`, `sessionId`, `reason`); or " +
        "carries a `conflictingSourceDirs` that is not an array of strings. The aggregate is " +
        `withheld either way; scan completeness is \`${scanCompleteness}\` -- \`incomplete\` if one of them was a recognized ` +
        "`omission`, whose category is trusted even when the rest of the entry is not, and `unknown` otherwise. Something other " +
        "than this build's scanner produced it -- a newer writer, a hand-assembled payload, or a malformed one, and nothing here " +
        "can tell which; restart the AI client or upgrade storybloq, then rerun the guard.",
    );
  }
  const concealing = diagnostics.filter((d) => d.category === "omission");
  /**
   * Omissions the completeness pass TRUSTED and the usability filter DROPPED
   * (ISS-897).
   *
   * The two passes disagree on purpose. `completenessFromDiagnostics` takes a
   * recognized `omission` on its category alone -- a concealment claim is never
   * softened by the rest of the entry being malformed -- while `concealing` is
   * built from the usable set, so `{ category: "omission" }` sets `incomplete`
   * and then contributes nothing to any count or list.
   *
   * That was handled only in the all-or-nothing case: a branch fired when
   * `concealing` was EMPTY. With one usable omission beside one malformed one,
   * neither branch is right -- the rationale reported "1 gap" with an address,
   * and the second gap, the one with no address at all, was never mentioned. So
   * these are counted separately and always reported, and the address list
   * still comes only from the usable subset.
   */
  const malformedOmissions = (Array.isArray(supplied) ? supplied : []).filter(
    (entry) => recognizedCategory(entry) === "omission" && !isUsableDiagnostic(entry),
  );

  // "Read both `activeSessions` and `resumableSessions`; deduplicate by full
  //  `sessionId`."
  //
  // A sentence of the procedure, so it is transcribed rather than skipped. It
  // is not decorative: without it, one session recorded under two directories
  // becomes two bearing sessions, which drives `overallAction` to null and
  // sends the caller down the multi-session fallback for what the prose counts
  // as one session.
  //
  // The prose says to deduplicate and does not say which record survives, so
  // the tie is broken deterministically rather than by scan order, which is
  // filesystem-dependent: the arrays are read in the order the sentence names
  // them, each by `sourceDir`, and the first occurrence of a `sessionId` wins.
  // That choice is arbitrary where the prose is silent, and it is recorded as a
  // note rather than presented as a rule.
  //
  // Collapsing here means the second record stops being reported at all. That
  // is what the sentence asks for, and it is also exactly the concealment
  // ISS-897 tracks, so the note names it.
  const ordered: { summary: ActiveSessionSummary; expectCompact: boolean }[] = [
    ...[...summaries.activeSessions].sort((a, b) => a.sourceDir.localeCompare(b.sourceDir))
      .map((summary) => ({ summary, expectCompact: false })),
    ...[...summaries.resumableSessions].sort((a, b) => a.sourceDir.localeCompare(b.sourceDir))
      .map((summary) => ({ summary, expectCompact: true })),
  ];


  const seen = new Map<string, string>();
  const deduped: typeof ordered = [];
  /**
   * Every directory carrying each id, built BEFORE dedup, so the note below can
   * check whether a structured carrier really holds the whole collision.
   *
   * The pair (kept, dropped) is not the collision when three or more directories
   * carry one id: the note fires once per dropped record, and a diagnostic
   * holding only the pair this iteration is looking at would satisfy a pairwise
   * check while omitting a third directory the operator still has to go find.
   * The sentence it gates says the diagnostic carries EVERY directory and tells
   * the reader to act on it rather than parse the note, so it has to be true of
   * the whole set or not claimed at all.
   */
  const dirsBySessionId = new Map<string, Set<string>>();
  for (const entry of ordered) {
    const set = dirsBySessionId.get(entry.summary.sessionId);
    if (set) set.add(entry.summary.sourceDir);
    else dirsBySessionId.set(entry.summary.sessionId, new Set([entry.summary.sourceDir]));
  }

  /**
   * The session ids for which a `duplicate-session-id` diagnostic lists EXACTLY
   * that id's directories.
   *
   * Built in ONE pass over `diagnostics`, driven by the diagnostics rather than
   * by the collisions. Memoizing per id was not enough: each distinct colliding
   * id still walked the whole array, so K collisions over K diagnostics stayed
   * O(K^2). Both K values come from a `SessionScanResult` that is caller-built
   * at the typed seam and read off an untrusted status payload in Mode A, and
   * this runs on the guard path every invocation takes.
   *
   * Now the work is proportional to the diagnostics plus the directories they
   * list. Each entry looks up only its own id's directory set, so a diagnostic
   * naming an id with no collision costs one map miss.
   */
  const exactCarrierIds = new Set<string>();
  for (const d of diagnostics) {
    if (d.kind !== "duplicate-session-id" || typeof d.sessionId !== "string") continue;
    const allDirs = dirsBySessionId.get(d.sessionId);
    if (allDirs === undefined) continue;
    const listed = d.conflictingSourceDirs;
    if (!Array.isArray(listed) || !allStrings(listed)) continue;
    // EXACT set equality, both directions. A superset gets an unrelated
    // directory CORROBORATED by a deduplication that never saw it; a subset
    // drops a participant that has to stay available for comparison.
    const unique = new Set(listed);
    if (unique.size !== allDirs.size) continue;
    let equal = true;
    for (const dir of unique) {
      if (!allDirs.has(dir)) {
        equal = false;
        break;
      }
    }
    if (equal) exactCarrierIds.add(d.sessionId);
  }
  /**
   * Discarded records that were an ADDITIONAL DISTINCT DIRECTORY for an id, so
   * the aggregate below can decline to speak for a population it collapsed.
   *
   * Not every dedup drop: a repeated `(sessionId, sourceDir)` pair is dropped
   * too and is routed to `repeatedEntries` instead, because it is one directory
   * reported twice rather than two directories on disk, and only this array's
   * members have a second directory to compare against. The two are disjoint and together they
   * cover every drop.
   *
   * Recorded from the dedup event itself, NOT from the `duplicate-session-id`
   * diagnostic. The diagnostic is optional at this seam -- a hand-built
   * `SessionScanResult` legitimately carries none -- and keying the block off it
   * would make the safety of the verdict depend on whether the caller happened
   * to supply diagnostics. The collapse is observed right here either way.
   */
  const droppedDuplicates: { sessionId: string; kept: string; dropped: string }[] = [];
  /**
   * The dropped collision participants themselves, so they can be CLASSIFIED and
   * compared against the surviving verdict for their id, where one exists
   * (ISS-914).
   *
   * Separate from `droppedDuplicates` because that array is the public
   * `collisions` field and its shape is a contract. This one never leaves the
   * function.
   *
   * Repeats (the same `sessionId` AND the same `sourceDir` arriving twice) are
   * deliberately NOT recorded here: there is no second directory to compare
   * against, so they keep withholding the aggregate exactly as before.
   */
  const droppedRecords: { summary: ActiveSessionSummary; expectCompact: boolean }[] = [];
  /**
   * The SAME directory arriving twice, which is not a collision at all.
   *
   * Dedup drops the second either way, so both shapes look identical from the
   * `seen` map -- but they support different statements. A distinct-directory
   * collision has two participants, each of which can be validated and then
   * compared. This has ONE directory reported twice by a payload whose own
   * bookkeeping is therefore untrustworthy, and there is no second copy to
   * compare it against: an instruction to compare directories sends the
   * operator after something that does not exist, and any cleanup that follows
   * can only remove the single live session.
   *
   * Unreachable from this build's scanner: `activeSessions` needs a live lease
   * and `resumableSessions` needs a non-live one, so no record can enter both,
   * and each directory is visited once. It is reachable at the typed seam and
   * from mode A's untrusted status payload, which is the seam this whole block
   * exists for. It still fails CLOSED -- a payload that repeats a record is one
   * whose population cannot be trusted -- but it says what it actually saw.
   */
  const repeatedEntries: { sessionId: string; sourceDir: string }[] = [];
  /**
   * Every `(sessionId, sourceDir)` pair seen SO FAR, pre-dedup.
   *
   * A repeat is a pair that has occurred before ANYWHERE in the population, not
   * a pair matching the directory this id happened to keep. Comparing against
   * `seen` alone gets the ordering A, B, B wrong: B is dropped as a genuine
   * collision against kept A, then the second B is compared to A again, counted
   * as a second collision, and the identical repetition is never reported at
   * all -- so the payload fault disappears and the collision count is inflated
   * by the record that proved it. The pair is checked FIRST for that reason; a
   * pair's first occurrence can still be a collision, and its second cannot be
   * anything else.
   *
   * Keyed with `JSON.stringify` of the tuple for the same reason `identityKey`
   * is: a delimiter is not injective over strings this seam accepts.
   */
  const seenPairs = new Set<string>();
  /** Pairs already given a transcription note, so the note is emitted once each. */
  const notedRepeats = new Set<string>();
  let collisionNotes = 0;
  for (const entry of ordered) {
    const pair = JSON.stringify([entry.summary.sessionId, entry.summary.sourceDir]);
    if (seenPairs.has(pair)) {
      // EVERY post-first occurrence is an EVENT, so it is counted...
      repeatedEntries.push({ sessionId: entry.summary.sessionId, sourceDir: entry.summary.sourceDir });
      // ...but the NOTE comes out once per distinct pair. A, A, A is two events
      // and one note: repeating an identical sentence twice tells the reader
      // nothing the count does not already carry, and the fallback document
      // states the same split, so emitting per-event made the two seams disagree
      // about the same payload.
      if (notedRepeats.has(pair)) continue;
      notedRepeats.add(pair);
      // Bounded by COUNT, not only by content. Each note is a paragraph and the
      // number of distinct pairs is caller-controlled, so an unbounded number
      // of them floods the response on its own. `repeatedRationale` reports the
      // full totals, and the structured fields keep every event, so the cap
      // costs individual sentences and no findings.
      if (notedRepeats.size > MAX_PER_ENTRY_NOTES) continue;
      notes.push(
        `Session id ${proseLabel(entry.summary.sessionId)} arrives more than once for the SAME directory ` +
          `(${proseLabel(entry.summary.sourceDir)}). That is not a collision between directories: this directory was ` +
          "already reported for this id and the scan result reported it again, which this build's scanner cannot do (a record is " +
          "live or resumable, never both, and each directory is visited once). The repeat was dropped and the aggregate is " +
          "withheld, because a payload that duplicates a record is one whose population cannot be trusted. Do NOT delete " +
          "anything for THIS statement -- there is no stale copy of this directory to remove.",
      );
      continue;
    }
    seenPairs.add(pair);
    const kept = seen.get(entry.summary.sessionId);
    if (kept !== undefined) {
      droppedDuplicates.push({
        sessionId: entry.summary.sessionId,
        kept,
        dropped: entry.summary.sourceDir,
      });
      droppedRecords.push({ summary: entry.summary, expectCompact: entry.expectCompact });
      // Both directories, and WHICH is which. A note naming only the dropped one
      // tells an operator a collision exists without telling them what survived;
      // naming only the survivor loses the other participant entirely.
      // Whether the structured carrier for THIS collision is actually there
      // decides what this sentence may claim. A hand-built `SessionScanResult`
      // legitimately supplies none, and pointing such a caller at a diagnostic
      // that is not in the array would leave the dropped directory named
      // nowhere at all. Matched per id, not per array: a result carrying
      // unrelated diagnostics still has no record of THIS collision.
      //
      // The CONTENT is checked, not just the kind and the id.
      // `conflictingSourceDirs` is optional on the type, so a matching
      // diagnostic can arrive without it or holding only part of the collision
      // -- and the sentence below promises the structured entry "carries every
      // directory" and tells the reader to act on it instead of parsing the
      // note. Deferring to a carrier that lost a directory would send the
      // operator to structured data missing exactly what the sentence just told
      // them not to parse out of the note.
      //
      // Whether a structured carrier for THIS collision exists decides what the
      // sentence below may claim, and the answer was computed once, up front,
      // in `exactCarrierIds` -- including the exact-set-equality reasoning that
      // used to live here. A hand-built `SessionScanResult` legitimately
      // supplies no carrier, and pointing such a caller at a diagnostic that is
      // not in the array would leave the dropped directory named nowhere.
      const structured = exactCarrierIds.has(entry.summary.sessionId);
      // Bounded by COUNT, like the repeat notes above and for the same reason:
      // this note is a paragraph, one is emitted per dropped duplicate, and the
      // populations are caller-supplied. `collisionRationale` carries the
      // totals and `collisions` carries every participant, so what a cap costs
      // is repeated sentences.
      collisionNotes += 1;
      if (collisionNotes > MAX_PER_ENTRY_NOTES) continue;
      notes.push(
        `Session id ${proseLabel(entry.summary.sessionId)} appears under more than one directory: kept ${proseLabel(kept)}, dropped ${proseLabel(entry.summary.sourceDir)}. ` +
          "Step 0.5 says to deduplicate by full `sessionId` and supplies no tiebreak, so the first by read order is kept " +
          "and the other is not reported HERE. " +
          // NEITHER branch is the thing to act on. `collisions` is: it is derived
          // from THIS deduplication and carries the raw, unsanitized directory
          // names. This sentence is prose -- the names in it went through
          // `sanitizeDisplayText`, so two distinct raw directories can render
          // identically -- and `diagnostics` is passed through verbatim from the
          // scan result, so it can name a directory nothing here touched.
          // Pointing at either as the actionable carrier is what made the
          // destructive workflow read from a lossy or untrusted source.
          (structured
            ? "This scan result ALSO contains a `duplicate-session-id` diagnostic listing every directory, returned in " +
              "`diagnostics` (ISS-897) -- a caller-supplied CROSS-CHECK only. Set equality with the directories this deduplication " +
              "saw shows the payload is self-consistent; it does not show the entry came from this build's scanner."
            : "This scan result carries no structured `duplicate-session-id` diagnostic listing EVERY directory that holds THIS " +
              "session id (ISS-897). That does not say the `diagnostics` array is empty -- a hand-built result can carry unrelated entries, " +
              "or an entry for this id that omits one of its directories. Read every note.") +
          " To ACT on this collision, use `collisions` on this verdict: it is derived from this deduplication and carries the raw " +
          `directory names, which these sanitized sentences do not. Check each name before opening it: ${CONTAINMENT_CHECKS}. ` +
          "Passing those checks makes a name safe to INSPECT and settles nothing about which copy to keep -- `kept` is simply the " +
          "first by read order, this guard applies no tiebreak, and either directory may hold newer or unique state. Report what both " +
          "validated records hold and STOP. This verdict authorizes no deletion and names no command that performs one: which copy " +
          "is stale is a judgement nothing on this path can make, so it is the operator\'s to make and theirs to act on.",
      );
      continue;
    }
    seen.set(entry.summary.sessionId, entry.summary.sourceDir);
    deduped.push(entry);
  }

  // ISS-914: ONE dispatch, used for survivors AND for dropped collision
  // participants. Two copies would let the two populations classify by different
  // rules, which is exactly the comparison this issue rests on.
  const classifyEntry = (summary: ActiveSessionSummary, expectCompact: boolean): Classification =>
    expectCompact
      ? indeterminateState(summary, true) ?? classifyResumable(summary, identityAvailable)
      : indeterminateState(summary, false) ?? classifyLive(summary, caller);

  const verdicts: SessionVerdict[] = [];
  for (const { summary, expectCompact } of deduped) {
    const c = classifyEntry(summary, expectCompact);
    if (c.note) notes.push(c.note);
    verdicts.push(toVerdict(summary, c, expectCompact));
  }

  /**
   * Classify the DROPPED collision participants and partition the collisions
   * three ways by the outcome of that comparison: match, mismatch, or no
   * survivor to compare against at all (ISS-914).
   *
   * A collision withholds the aggregate when a dropped participant MISMATCHES
   * its survivor on the policy signature, or when there is NO survivor to
   * compare it against. Only a matched comparison is waived. The two blocking
   * cases are kept apart because they block for different reasons and the
   * rationale has to say which.
   *
   * A waived collision is still REPORTED everywhere it was before --
   * `collisions`, `diagnostics`, the transcription notes and the rationale --
   * because waiving the block is not waiving the report.
   *
   * Cost is proportional to collisions, not to the population: a record that was
   * never dropped needs no comparison, so a clean scan pays nothing.
   *
   * Note ORDER is deliberate and preserves today's structure: repeat and
   * collision notes during the dedup loop, then survivor classification notes,
   * then dropped-participant notes in dropped-record order. That is NOT the
   * order a classify-before-deduplicate pipeline would produce, so the claim
   * this pass makes is about VERDICTS, which are order-independent because the
   * classifiers are pure, and not about note sequence.
   */
  const survivorById = new Map(verdicts.map((v) => [v.sessionId, v]));
  // THREE outcomes, not two. Both of the first two withhold, but they withhold
  // for different reasons and the rationale has to say which: "disagrees with
  // its survivor" is false when there is no survivor, and that is precisely the
  // zero-verdict branch's situation.
  const mismatchedCollisions: SessionVerdict[] = [];
  const survivorlessCollisions: SessionVerdict[] = [];
  const waivedCollisions: SessionVerdict[] = [];
  let droppedNotes = 0;
  for (const rec of droppedRecords) {
    const c = classifyEntry(rec.summary, rec.expectCompact);
    const dropped = toVerdict(rec.summary, c, rec.expectCompact);
    const survivor = survivorById.get(dropped.sessionId);
    // The predicate stays the single decision point; `survivor` only labels WHY.
    if (collisionBlocksAggregate(dropped, survivor)) {
      (survivor ? mismatchedCollisions : survivorlessCollisions).push(dropped);
    } else {
      waivedCollisions.push(dropped);
    }
    // The dropped record's own note is RETAINED, prefixed to say the record is
    // not among the reported sessions. Measured: with identity unavailable a
    // foreign COMPACT record emits the U2 note while the non-COMPACT record at
    // the SAME relationship and action emits none, so the dropped record can be
    // the only carrier of it. Suppressing it would be the one way this pass is
    // observably different from classifying before deduplicating.
    //
    // Bounded like the collision notes above, and for the same reason: the
    // populations are caller-supplied.
    if (c.note && ++droppedNotes <= MAX_PER_ENTRY_NOTES) {
      notes.push(
        `Dropped collision participant ${proseLabel(dropped.sourceDir)} (session id ` +
        `${proseLabel(dropped.sessionId)}) is NOT reported among the sessions above, and its ` +
        `own classification carries this: ${c.note}`,
      );
    }
  }

  // Presentation only. Sorting first does not make the first one authoritative.
  verdicts.sort((a, b) => {
    const byRelationship = RENDER_ORDER.indexOf(a.relationship) - RENDER_ORDER.indexOf(b.relationship);
    return byRelationship !== 0 ? byRelationship : a.sourceDir.localeCompare(b.sourceDir);
  });

  // The concealment column of the aggregate table (ISS-897). One sentence,
  // applied identically at the `none` and `single` rows, because a scan that
  // dropped a record cannot support an aggregate over the records it kept: the
  // dropped one could be the foreign live session, which is ISS-554 exactly.
  //
  // The `multiple` row below does NOT use it -- see the comment there.
  /**
   * The per-fault remedy, shared by every row that reports an incomplete scan.
   *
   * Two groups with two different remedies, and no single command covering both.
   * A collection-level fault has `sourceDir: null` by design, so it is addressed
   * by `sourcePath` -- through `sanitizeDisplayPath`, because that string is an
   * ADDRESS the operator is expected to open, and a path truncated to a label
   * width is not a shorter path but a wrong one.
   *
   * The split is on TWO conditions, and the second one is not redundant. `kind`
   * says whether `storybloq session list` can structurally reach this class of
   * fault; `sourceDir` says whether there is a directory NAME for it to look up.
   * Both have to hold, because that command enumerates directories: a
   * diagnostic with a listable kind and a null `sourceDir` has no name to give
   * it, and the sentence would fall back to printing the PATH next to a command
   * that takes no path. `isUsableDiagnostic` accepts that combination -- it
   * validates the two fields separately, exactly as it must, since a null
   * `sourceDir` is legitimate on its own -- so nothing upstream rules it out and
   * the check belongs here. Kind alone sent an operator to a command that
   * prints nothing, which reads as "no problem": the dead end this whole issue
   * exists to close, reintroduced in the sentence written to close it.
   */
  const incompleteRemedy = (): string => {
    const listable = concealing.filter(
      (d) => d.sourceDir !== null && !SESSION_LIST_BLIND_KINDS.has(d.kind),
    );
    const blind = concealing.filter(
      (d) => d.sourceDir === null || SESSION_LIST_BLIND_KINDS.has(d.kind),
    );
    return [
      listable.length > 0
        ? `Inspect ${namedDirectories(listable)} with \`storybloq session list\`.`
        : null,
      blind.length > 0
        ? `${blind.length === 1 ? "This fault is" : "These faults are"} outside what \`storybloq session list\` can show, ` +
          `so inspect the path directly: ${boundedList([...new Set(blind.map((d) => sanitizeDisplayPath(d.sourcePath)))].sort().map(escapeMarkdownDocumentStrict), { noun: "paths" })}.`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" ");
  };

  /**
   * Says which SHAPE the gaps are, when it matters (ISS-897).
   *
   * "Gaps", not "entries". A gap with a `sourceDir` is an entry the scan SAW and
   * could not read. A gap with a null one is a fault against the collection
   * itself, where enumeration never happened and no entry was ever observed --
   * counting those as entries claims the scan saw something it did not. Both
   * conceal and neither permits `free`, which is why they share a count; only
   * one has a record behind it, which is why the shape is named.
   */
  const collectionLevel = (gaps: readonly SessionScanDiagnostic[]): string => {
    const observed = gaps.filter((d) => d.sourceDir !== null).length;
    const collection = gaps.length - observed;
    if (collection === 0) return "";
    return observed === 0
      ? "None of those is an entry the scan observed -- the collection itself could not be enumerated, so no session directory was ever seen. "
      : `${collection} of those ${collection === 1 ? "is" : "are"} a fault against the collection itself rather than an entry the scan observed. `;
  };

  /**
   * `incomplete` with NO usable omission left behind it.
   *
   * The entry's category was recognized -- so completeness is trusted -- while
   * the rest of it was not, so it was dropped. Every path that renders a gap
   * COUNT and a directory LIST has to branch here first, or it prints "0 gaps
   * ()": an empty list and a zero count beside a completeness value that says
   * something WAS concealed.
   */
  const MALFORMED_OMISSION_SENTENCE =
    "The scan reported an omission -- so something was concealed -- but the diagnostic carrying it could not be read by this build, " +
    `so there is no directory or path to name. ${MALFORMED_OMISSION_REMEDY}`;

  /**
   * The same fact as a CLAUSE, for the rationales that also have usable gaps to
   * report. `MALFORMED_OMISSION_SENTENCE` stands alone and says "an omission";
   * this one counts, and sits after a list of addressed gaps.
   */
  const malformedOmissionClause = (): string =>
    malformedOmissions.length === 0
      ? ""
      : ` ${malformedOmissions.length} further gap${malformedOmissions.length === 1 ? " was" : "s were"} reported whose diagnostic this build ` +
        `could not read, so ${malformedOmissions.length === 1 ? "it has" : "they have"} no address to name and ${malformedOmissions.length === 1 ? "is" : "are"} ` +
        `not counted above. ${MALFORMED_OMISSION_REMEDY}`;

  const incompleteRationale = (): string =>
    // `incomplete` with NO usable omission left: the entry's category was
    // recognized (so completeness is trusted) while the rest of it was not (so
    // it was dropped). Falling through would render "0 gaps ()" with an empty
    // list and no remedy, contradicting the completeness value beside it.
    scanCompleteness === "incomplete" && concealing.length === 0
      ? MALFORMED_OMISSION_SENTENCE
      : scanCompleteness !== "incomplete"
      ? UNKNOWN_COMPLETENESS_REMEDY
      : // The shape note goes AFTER the main claim, not inside it. Both of its
        // branches are complete sentences ending in a period, so interpolating
        // one between the comma and `so whether` produced "...an entry the scan
        // observed. so whether a session is running here cannot be established."
        // -- a sentence starting mid-clause with a lower-case conjunction, in
        // the one paragraph an operator reads to decide whether to intervene.
        `The scan reported ${concealing.length} gap${concealing.length === 1 ? "" : "s"} under \`.story/sessions\` (${namedDirectories(concealing)}), ` +
        `so whether a session is running here cannot be established. ${collectionLevel(concealing)}${incompleteRemedy()} Do not guess.${malformedOmissionClause()}`;

  /**
   * A collapsed population cannot support a permissive aggregate (ISS-914).
   *
   * Deduplication is what Step 0.5 asks for, and it is also what makes the
   * second record vanish before any rule runs. When the dropped record is a live
   * FOREIGN session, a verdict computed from the survivor alone says `continue`
   * -- the ISS-554 shape, reached through a green light, on a scan that is
   * otherwise genuinely `complete`.
   *
   * This does NOT invent an aggregate where the prose is silent. It applies the
   * same treatment this file already gives an incomplete scan: the record's own
   * verdict stands for the record and is still reported, while the AGGREGATE is
   * withheld because the population it would be computed over is not the
   * population on disk. `unverifiable` means exactly that -- stop, do not guess,
   * go look.
   *
   * It no longer fires on ANY collision. The dropped participants are now
   * classified and compared, where a survivor exists, against it on the POLICY
   * SIGNATURE
   * (`POLICY_SIGNATURE_FIELDS`: relationship, action, and the five capability
   * fields). A collision where every dropped record matches its survivor changes
   * no answer the aggregate can give, so it is WAIVED and the survivor's own
   * action stands. A collision where any dropped record disagrees, or where no
   * survivor exists to compare against, still withholds exactly as before.
   *
   * Waiving the block is not waiving the report. An agreeing collision is still
   * carried in `collisions`, in the transcription notes, and in the rationale
   * through `waivedCollisionClause`.
   */
  /**
   * Name a set of dropped participants by directory, bounded like every other
   * caller-supplied list in this file. `collisions` still carries the raw,
   * unsanitized names; these are for prose only.
   */
  const collisionGroup = (group: readonly SessionVerdict[]): string =>
    boundedList(
      group.map((v) => `${proseLabel(v.sessionId)} (dropped ${proseLabel(v.sourceDir)})`),
      { separator: "; ", noun: "collisions" },
    );

  const collisionRationale = (): string => {
    // Plural-neutral throughout. One session id can be embedded in any number of
    // directories, and several ids can collide at once, so "the other" and "the
    // stale one" would tell an operator to clean up one copy and leave the rest
    // -- after which the guard blocks again and the instruction that produced
    // the result reads as though it had already been followed.
    const ids = new Set(droppedDuplicates.map((d) => d.sessionId));
    // Bounded as a list. One id can collide across any number of directories
    // and the populations are caller-supplied, so this detail is exactly the
    // shape that grows without limit. `collisions` on the verdict keeps every
    // participant, so nothing is lost -- only the prose is shortened, and it
    // says by how much.
    const detail = boundedList(
      droppedDuplicates.map((d) => `${proseLabel(d.sessionId)}: kept ${proseLabel(d.kept)}, dropped ${proseLabel(d.dropped)}`),
      { separator: "; ", noun: "collisions" },
    );
    return (
      `${ids.size === 1 ? "A session id appears" : `${ids.size} session ids appear`} under more than one directory (${detail}). ` +
      `Deduplication kept one record per id and dropped ${droppedDuplicates.length === 1 ? "the other" : "the others"}. ` +
      // ISS-914: the dropped records ARE classified now, so the old wording
      // ("dropped BEFORE classification ... contributed nothing") would be
      // false. What they contribute is the comparison below.
      //
      // The consequence is stated WITHOUT claiming causation, because this
      // sentence also renders in the more-than-one-survivor branch, where the
      // aggregate is already `null` for the population reason and a collision
      // changes nothing about that.
      // "attempted", not "compared": the survivorless group below reports that
      // no comparison was possible, and a common sentence asserting one had
      // happened would contradict it in exactly that branch.
      "Every dropped record was then classified and a comparison against its survivor attempted, on the policy signature (relationship, " +
      "action, and the five capability fields). " +
      // Each outcome is NAMED with the directories it applies to. Counts alone
      // leave an operator unable to tell which dropped participant blocked when
      // several ids collide at once, which is the whole reason they are told.
      [
        mismatchedCollisions.length > 0
          ? `${collisionGroup(mismatchedCollisions)} ${mismatchedCollisions.length === 1 ? "disagrees" : "disagree"} with ` +
            `${mismatchedCollisions.length === 1 ? "its survivor" : "their survivors"} about what the caller may do, and may be a live ` +
            "session belonging to another task, so a project-wide answer cannot be computed from the survivors alone (ISS-914)."
          : null,
        survivorlessCollisions.length > 0
          ? `${collisionGroup(survivorlessCollisions)} could not be compared at all: no surviving verdict was produced for ` +
            `${survivorlessCollisions.length === 1 ? "that session id" : "those session ids"}, so equivalence cannot be established and ` +
            "the collision is not waived (ISS-914)."
          : null,
        waivedCollisions.length > 0
          ? `${collisionGroup(waivedCollisions)} matched ${waivedCollisions.length === 1 ? "its survivor" : "their survivors"} on the ` +
            `policy signature and ${waivedCollisions.length === 1 ? "withholds" : "withhold"} nothing on ` +
            `${waivedCollisions.length === 1 ? "its" : "their"} own; ` +
            `${waivedCollisions.length === 1 ? "it is" : "they are"} named here so a waived collision is not lost from a result that ` +
            "blocks for a different one."
          : null,
      ].filter((part): part is string => part !== null).join(" ") + " " +
      "The names above are SANITIZED for display, so they are " +
      "not the unmodified names, and nothing may be deleted on the strength of this sentence: two distinct directory names can render " +
      "identically here. `collisions` on this verdict carries the raw names, derived from this deduplication -- and each still has to " +
      `pass the same checks before it is safe even to OPEN: ${CONTAINMENT_CHECKS}. ` +
      "Those checks establish that a name is a real " +
      "participant in this collision; they do not establish which participant is stale, and this guard applies no tiebreak -- `kept` " +
      "is the first by read order. Compare the validated records, report what each one holds, and STOP. This guard authorizes no " +
      "deletion and names no command that performs one: which copy is stale is a judgement nothing on this path can make, so it is " +
      "the operator's to make and theirs to act on."
    );
  };

  /**
   * A collision that was WAIVED, reported so the waiver is never silent (ISS-914).
   *
   * Keyed on "a collision happened and none of them block", so it fires exactly
   * where `collisionRationale` no longer does. It is emitted in BOTH one-verdict
   * paths, not only the permissive one: when an incomplete scan, a repeated
   * entry, unknown ownership or an unsupported version independently forces
   * `unverifiable`, `collapsed` is false and the collision would otherwise
   * vanish from the one field a reader looks at first.
   */
  const waivedCollisionClause = (): string => {
    const ids = new Set(waivedCollisions.map((v) => v.sessionId));
    const detail = boundedList(
      droppedDuplicates.map((d) => `${proseLabel(d.sessionId)}: kept ${proseLabel(d.kept)}, dropped ${proseLabel(d.dropped)}`),
      { separator: "; ", noun: "collisions" },
    );
    return (
      `${ids.size === 1 ? "A session id appeared" : `${ids.size} session ids appeared`} under more than one directory (${detail}), ` +
      "and deduplication kept one record per id. Every dropped record was classified and matched its survivor on the policy signature " +
      "(relationship, action, and the five capability fields), so it could not have changed the answer above and the aggregate is NOT " +
      "withheld for it (ISS-914). The collision is still real: the records may differ in ticket or workflow state, and only the survivor " +
      "is reported among the sessions. `collisions` on this verdict carries the raw directory names, which these sanitized ones are not. " +
      "This waiver authorizes no deletion."
    );
  };

  /**
   * The same directory reported twice, which withholds the aggregate for a
   * DIFFERENT reason and must not borrow the collision remedy.
   *
   * The collapse looks similar but is NOT the same: a repeat is dropped and
   * never classified, because there is no second directory to compare it
   * against, so the ISS-914 equivalence waiver can never reach it. The cause is
   * a malformed payload rather than two directories on disk, and
   * the collision remedy would send an operator to compare against a copy that
   * does not exist. Reported separately, alongside a collision when both apply.
   */
  const repeatedRationale = (): string => {
    // TWO counts, because they differ and each would be a false statement in
    // place of the other. `repeatedEntries` counts dropped REPEATS: three copies
    // of one record produce two of them. The unique pairs count the DIRECTORIES
    // involved, which is one. Saying "2 sessions arrived more than once" over a
    // single duplicated session is the same class of miscount as calling a
    // repeat a collision.
    // Deduplicated on the RAW pair, then sanitized only for rendering. Folding
    // sanitized strings would merge two genuinely different pairs that happen to
    // render alike, and undercount the thing being reported.
    const uniquePairs = [...new Map(repeatedEntries.map((r) => [JSON.stringify([r.sessionId, r.sourceDir]), r])).values()];
    const detail = boundedList(
      uniquePairs.map((r) => `${proseLabel(r.sessionId)} (${proseLabel(r.sourceDir)})`).sort(),
      { noun: "pairs" },
    );
    // Three counts that can all differ, so each claim is made from its own.
    // A,A,A is 2 repeats over 1 pair, 1 session, 1 directory. A,A,B,B under one
    // id is 2 repeats over 2 pairs, 1 session, 2 directories. Deriving the noun
    // from the pair count says "2 sessions" for the second, which is false.
    const sessions = new Set(uniquePairs.map((r) => r.sessionId)).size;
    const dirs = new Set(uniquePairs.map((r) => r.sourceDir)).size;
    return (
      `${repeatedEntries.length === 1 ? "One repeated entry was" : `${repeatedEntries.length} repeated entries were`} received: ` +
      `${uniquePairs.length === 1 ? "a session/directory pair" : `${uniquePairs.length} session/directory pairs`} already reported in this same scan ` +
      `(${detail}), spanning ${sessions === 1 ? "one session id" : `${sessions} session ids`} and ${dirs === 1 ? "one directory" : `${dirs} directories`}. ` +
      "Each repeat was dropped and only one record per id was classified, so the aggregate is withheld -- but a repeat is NOT a collision between " +
      "directories: it implies no additional copy and authorizes no deletion. (A distinct-directory collision may be reported separately alongside " +
      "this, and that one keeps its own remedy.) This build's scanner cannot produce a repeat (a record is live or resumable, never both, and each " +
      "directory is visited once), so the scan result was assembled somewhere else and its population cannot be trusted. Obtain a fresh scan and " +
      "rerun the guard."
    );
  };

  /**
   * Ownership that could not be established on a record the scan ADMITTED
   * (ISS-897).
   *
   * The second reason an aggregate is withheld for something other than
   * incompleteness. `ownerTask` present but unreadable normalizes to null, and
   * null means "legacy session, no owner recorded" -- which is the shape the
   * guard auto-resumes. So a live COMPACT session belonging to another task,
   * whose owner id is damaged, was taken over rather than monitored.
   *
   * Kept off the completeness axis on purpose. Nothing vanished from this scan:
   * the record was admitted, and saying the scan was incomplete would tell an
   * operator to go looking for a session that is not missing. Whether it was
   * then CLASSIFIED is a separate question this block does not assume -- the
   * correlation below decides, per record, whether it survived, was dropped by
   * deduplication, or is unaccounted for at this seam.
   */
  const ownershipUndetermined = diagnostics.filter((d) => d.kind === "owner-task-undetermined");

  /**
   * A record whose `schemaVersion` this build does not support (ISS-897).
   *
   * The second kind that blocks on its own. The scanner ADMITS these -- the
   * summary is reported, so the operator still learns a session is there -- but
   * the fields were read by hand under a schema the file does not claim, and an
   * older schema can have moved a field's meaning just as a newer one can. So
   * the record is visible and the aggregate is withheld: those are not in
   * tension, which is the whole reason this kind exists rather than the record
   * being dropped.
   *
   * An ABSENT `schemaVersion` is not this. That is the documented legacy shape,
   * it is what sessions predating the field carry, and it stays silent.
   */
  const versionUnsupported = diagnostics.filter((d) => d.kind === "schema-version-undetermined");
  /**
   * ADMITTED is the claim this can make; SURVIVING is not, and neither is
   * assumed -- each affected directory is LOOKED UP.
   *
   * The scanner emits `owner-task-undetermined` only for a record it admitted,
   * and that used to be stated here as "reported above". It is not the same
   * thing: deduplication runs AFTER admission, so two directories sharing a
   * `sessionId` can both be admitted while only one becomes a verdict -- and
   * the dropped one is exactly where a damaged owner is most likely to sit,
   * since a duplicated session directory is how these arise.
   *
   * Stating the disjunction ("it is in one place or the other") was still a
   * claim about a payload this function does not control. `classifySessionGuard`
   * accepts a hand-built `SessionScanResult`, and mode A builds one from an
   * untrusted status payload, so an ownership diagnostic can name a directory
   * that is neither a survivor nor a dropped duplicate. So each one is
   * correlated against both sets and reported as what it actually is; anything
   * in neither gets the same invariant-violation framing the zero-verdict
   * branch uses, because that is the same violation seen from a populated scan.
   *
   * Correlated on `sessionId` AND `sourceDir`, not on the directory alone. The
   * directory is not an identifier at this seam: an untrusted payload can put
   * the same directory string on a diagnostic carrying a different embedded id,
   * or none, and matching on it alone would report an unrelated ownership fault
   * as though it belonged to the surviving session -- placing a record this
   * function cannot actually place, which is the defect it was rewritten to
   * stop. A diagnostic whose identity does not match is unaccounted, which is
   * the truthful answer and the safe one. Real scanner output always carries
   * both (`summary.sessionId` is substituted from the directory name when the
   * embedded id is unreadable), so nothing produced by this build is affected.
   */
  const identityKey = (sessionId: string | null, sourceDir: string | null): string | null =>
    // INJECTIVE encoding, not a delimiter. A separator is only safe if it cannot
    // appear in either field, and nothing satisfies that here: a JS string can
    // hold any code unit including NUL, and this function's premise is that the
    // payload may be hand-built. With a delimiter, (`a\u0000b`, `c`) and (`a`,
    // `b\u0000c`) produce ONE key, and the guard would place an unrelated
    // diagnostic as though it were the surviving session -- the exact failure the
    // composite key was added to prevent, reintroduced by the encoding.
    // `JSON.stringify` of the tuple escapes what it must and is reversible, so
    // distinct pairs stay distinct. That also keeps this seam equivalent to the
    // fallback document's rule, which compares the two fields pairwise and cannot
    // collide at all; a delimiter would make the two modes disagree.
    sessionId === null || sourceDir === null ? null : JSON.stringify([sessionId, sourceDir]);
  const survivingKeys = new Set(
    verdicts.map((v) => identityKey(v.sessionId, v.sourceDir)).filter((k): k is string => k !== null),
  );
  const droppedKeys = new Set(
    droppedDuplicates.map((d) => identityKey(d.sessionId, d.dropped)).filter((k): k is string => k !== null),
  );
  /**
   * CORRELATED, exactly as `ownershipRationale` is, and for the same reasons.
   *
   * The first version of this sentence asserted two things unconditionally and
   * neither is generally true. "Reported above" is false for a record that was
   * admitted and then dropped by deduplication. "No verdict is offered for it"
   * is false for a survivor, which is classified normally and appears in
   * `sessions` with its own verdict -- only the AGGREGATE is withheld. And at
   * the untrusted seam the diagnostic can correlate to neither population, in
   * which case there is no session to place and no state.json to name.
   */
  const versionRationale = (): string => {
    // Deduplicated for the same reason `ownershipRationale` is: a payload may
    // legitimately repeat one fully usable diagnostic, and `.length` below is
    // read as a SESSION count.
    const unique = dedupeByIdentity(versionUnsupported);
    const keyed = unique.map((d) => ({ d, key: identityKey(d.sessionId, d.sourceDir) }));
    // A session count may only be made from records that HAVE an identity.
    // `dedupeByIdentity` deliberately retains an unkeyed entry (null
    // `sessionId` or `sourceDir`) rather than folding it away, because two of
    // them may be two different faults -- but nothing establishes that either
    // names a session, so counting them as sessions asserts what the payload
    // never showed. A payload repeating one unkeyed carrier twice used to read
    // as "2 sessions" beside a list naming none.
    const identified = keyed.filter((e) => e.key !== null).map((e) => e.d);

    const surviving = keyed.filter((e) => e.key !== null && survivingKeys.has(e.key)).map((e) => e.d);
    const deduplicated = keyed
      .filter((e) => e.key !== null && !survivingKeys.has(e.key) && droppedKeys.has(e.key))
      .map((e) => e.d);
    const unaccounted = keyed
      .filter((e) => e.key === null || (!survivingKeys.has(e.key) && !droppedKeys.has(e.key)))
      .map((e) => e.d);
    const inspectable = [...surviving, ...deduplicated].filter((d) => d.sourceDir !== null);
    return [
      (identified.length === 0
        ? `${unique.length === 1 ? "A diagnostic reports" : `${unique.length} diagnostics report`} an unsupported \`schemaVersion\`, and none of them carries the identifiers needed to say WHICH session, so no session has been established here at all. The \`schemaVersion\` of what was reported `
        : `The \`schemaVersion\` of ${identified.length === 1 ? "a session" : `${identified.length} sessions`} `) +
        `${identified.length === 0 ? "" : `(${namedDirectories(identified)}) `}is not one this build supports, so its fields were read under a schema the file does not claim ` +
        "-- and an unsupported version can have moved a field's meaning in either direction, not only a newer one.",
      surviving.length > 0
        ? `${namedDirectories(surviving)} ${surviving.length === 1 ? "is" : "are"} reported among the sessions above with ${surviving.length === 1 ? "its" : "their"} own verdict, ` +
          "which is PROVISIONAL: it reports the record as this build read it, under a schema the record does not claim, so its " +
          "field meanings are undetermined -- and the project-wide answer is withheld regardless."
        : null,
      deduplicated.length > 0
        ? `${namedDirectories(deduplicated)} ${deduplicated.length === 1 ? "was" : "were"} dropped by deduplication, so ${deduplicated.length === 1 ? "it is" : "they are"} not among the sessions above.`
        : null,
      unaccounted.length > 0
        ? `${namedDirectories(unaccounted)} ${unaccounted.length === 1 ? "matches" : "match"} neither a reported session nor a dropped duplicate on \`sessionId\` and \`sourceDir\` together. ` +
          "This kind is emitted only for a record admitted to a reported population, so this payload violates that invariant and nothing here can say where that record went."
        : null,
      // CANDIDATES, and rendered reversibly. The old sentence named a file to
      // open, built from lossy labels, on the strength of correlation alone --
      // and correlation compares two halves of the SAME caller-supplied payload,
      // so it establishes self-consistency and not that either value is a
      // contained directory at all.
      inspectable.length > 0
        ? "This build did not interpret the file, so nothing here establishes that it is damaged OR that it is sound. " +
          `${candidateDirectories(inspectable)} ${inspectable.length === 1 ? "is a CANDIDATE" : "are CANDIDATES"} to inspect, not an established address: ` +
          `${CONTAINMENT_CHECKS}. When that holds, read and report the \`schemaVersion\` field of \`state.json\` there and nothing else, or use a ` +
          "storybloq that supports that schema, then rerun the guard. " +
          "When it does not, open nothing and rerun the guard. Do not delete anything either way. " +
          "One field, deliberately: this build did not interpret the file, so its contents are UNVALIDATED input, and the " +
          "fallback document whitelists exactly the field each procedure needs. Reading the rest invites transcribing a " +
          "`reason` or a ticket title written by whatever produced the file, into a report the reader trusts as the guard's own."
        : "No directory can be named here, so rerun the guard rather than editing anything.",
    ]
      .filter((part): part is string => part !== null)
      .join(" ");
  };

  /**
   * One entry per identity, keeping the first (ISS-897).
   *
   * These arrays come off a caller-supplied scan result, so nothing stops a
   * payload carrying the SAME fully usable diagnostic twice. Both copies are
   * legitimate by every gate -- recognized kind, paired category, well-typed
   * fields -- so completeness stays `complete` and the entry survives to here,
   * where `.length` was being read as a session count. Two copies of one
   * diagnostic then produced "2 sessions", plural candidate grammar, and the
   * placement sentence twice, for one record.
   *
   * Keyed with `identityKey`, which is injective over the pair, so this collapses
   * only genuine repeats and never two records that merely look alike.
   */
  const dedupeByIdentity = (
    entries: readonly SessionScanDiagnostic[],
  ): readonly SessionScanDiagnostic[] => {
    const byKey = new Map<string, SessionScanDiagnostic>();
    const unkeyed: SessionScanDiagnostic[] = [];
    for (const d of entries) {
      const key = identityKey(d.sessionId, d.sourceDir);
      // An entry with no usable identity cannot be shown to repeat, so it is
      // kept as-is rather than folded into some other entry's slot.
      if (key === null) unkeyed.push(d);
      else if (!byKey.has(key)) byKey.set(key, d);
    }
    return [...byKey.values(), ...unkeyed];
  };

  const ownershipRationale = (): string => {
    // Deduplicated ONCE and used for everything downstream -- the count, the
    // directory list, and the correlation. Deduplicating only the correlation
    // left the opening sentence saying "2 sessions" beside a list naming one
    // directory, which is the same inconsistency reported differently.
    const unique = dedupeByIdentity(ownershipUndetermined);
    const keyed = unique.map((d) => ({ d, key: identityKey(d.sessionId, d.sourceDir) }));
    // A session count may only be made from records that HAVE an identity.
    // `dedupeByIdentity` deliberately retains an unkeyed entry (null
    // `sessionId` or `sourceDir`) rather than folding it away, because two of
    // them may be two different faults -- but nothing establishes that either
    // names a session, so counting them as sessions asserts what the payload
    // never showed. A payload repeating one unkeyed carrier twice used to read
    // as "2 sessions" beside a list naming none.
    const identified = keyed.filter((e) => e.key !== null).map((e) => e.d);

    const surviving = keyed.filter((e) => e.key !== null && survivingKeys.has(e.key)).map((e) => e.d);
    const deduplicated = keyed
      .filter((e) => e.key !== null && !survivingKeys.has(e.key) && droppedKeys.has(e.key))
      .map((e) => e.d);
    const unaccounted = keyed
      .filter((e) => e.key === null || (!survivingKeys.has(e.key) && !droppedKeys.has(e.key)))
      .map((e) => e.d);
    // The entries an INSPECTION instruction can legitimately name: correlated to
    // a real record AND carrying a directory. `namedDirectories` falls back to
    // `sourcePath` when `sourceDir` is null, and that path may be a file or the
    // collection itself.
    //
    // Inspection, not repair. Reading `ownerTask` is what this authorizes;
    // writing one -- and above all CLEARING one, which converts a possibly
    // foreign-owned live session into the unowned-legacy shape that auto-resumes
    // -- needs separate authorization and evidence of who actually owns it.
    const inspectable = [...surviving, ...deduplicated].filter((d) => d.sourceDir !== null);
    return [
      (identified.length === 0
        ? `${unique.length === 1 ? "A diagnostic reports" : `${unique.length} diagnostics report`} an unreadable recorded owner, and none of them carries the identifiers needed to say WHICH session, so no session has been established here at all. The recorded owner of what was reported could not be read `
        : `The recorded owner of ${identified.length === 1 ? "a session" : `${identified.length} sessions`} could not be read `) +
        `${identified.length === 0 ? "" : `(${namedDirectories(identified)})`}.`,
      surviving.length > 0
        ? `${namedDirectories(surviving)} ${surviving.length === 1 ? "is" : "are"} reported among the sessions above.`
        : null,
      deduplicated.length > 0
        ? `${namedDirectories(deduplicated)} ${deduplicated.length === 1 ? "was" : "were"} observed and admitted, then dropped by deduplication, ` +
          `so ${deduplicated.length === 1 ? "it appears" : "they appear"} among the conflicting directories named in this rationale rather than in the session list.`
        : null,
      unaccounted.length > 0
        ? `${namedDirectories(unaccounted)} ${unaccounted.length === 1 ? "matches" : "match"} neither a reported session nor a dropped duplicate ` +
          "on `sessionId` and `sourceDir` together. `owner-task-undetermined` is emitted only for a record admitted to a reported population, and " +
          "the scanner always carries both identifiers, so this payload violates that invariant and nothing here can say where that record went. " +
          "Rerun the guard; if it persists, the scan result did not come from this build's scanner."
        : null,
      "What is unknown is WHO owns it. A record that survives deduplication is classified as though no owner were recorded, and a live COMPACT " +
        "session with no recorded owner is auto-resumed, so an aggregate computed over it could authorize taking over another task's session.",
      // The repair instruction is only for entries that HAVE a directory. An
      // untrusted payload can carry `owner-task-undetermined` with a null
      // `sessionId` or `sourceDir` -- that is the unaccounted case above -- and
      // for those `namedDirectories` renders `sourcePath`, which may be a file
      // or the collection itself. Telling the operator to open "that
      // directory's state.json" then names a file that was never established.
      inspectable.length > 0
        ? `${candidateDirectories(inspectable)} ${inspectable.length === 1 ? "is the CANDIDATE" : "are the CANDIDATES"} whose \`ownerTask\` to inspect -- ` +
          `a candidate, not an established address, because the diagnostic and the session it matches come out of the same supplied scan result: ` +
          `${CONTAINMENT_CHECKS}. When that holds, inspect \`ownerTask\` in its state.json and rerun the guard; when it does not, open nothing and rerun the guard.`
        : "No validated directory can be named for inspection, so rerun the guard rather than opening or editing anything.",
    ]
      .filter((part): part is string => part !== null)
      .join(" ");
  };

  if (verdicts.length === 0) {
    const clean = scanCompleteness === "complete";
    // A collision blocks HERE too, and the zero row is the one where getting it
    // wrong is worst. `free` is the most permissive answer the guard has, and
    // "no session is running" asserted over a population that dedup collapsed
    // would be a claim the surviving population cannot support.
    //
    // The ISS-914 waiver cannot reach this row, and that falls out of the rule
    // rather than needing a special case: with no verdicts there is no survivor
    // to compare a dropped record against, so `collisionBlocksAggregate` fails
    // closed for every one of them and this stays exactly as strict as before.
    const collapsed = mismatchedCollisions.length + survivorlessCollisions.length > 0;
    // A repeated entry blocks HERE too, and for the same reason as a collision:
    // a record was dropped before classification, so the emptiness is not
    // evidence of an empty project. Kept separate so the message does not tell
    // an operator to delete a copy that does not exist.
    const repeated = repeatedEntries.length > 0;
    // Ownership blocks HERE too, and only ever defensively. The scanner emits
    // `owner-task-undetermined` solely for an ADMITTED record, so a zero-verdict
    // population carrying one is a payload that violates that invariant -- which
    // a hand-built `SessionScanResult`, or mode A reading an untrusted status
    // payload, can still produce. Answering `free` there would be trusting the
    // invariant to hold in exactly the input that just broke it, and the two
    // seams would disagree about the same payload.
    const ownerUnknown = ownershipUndetermined.length > 0;
    // Same invariant violation as the ownership case one line down: the scanner
    // emits this only for a record it ADMITTED, so a zero-verdict population
    // carrying one did not come from this build's scanner.
    const versionUnknown = versionUnsupported.length > 0;
    const zeroClean = clean && !collapsed && !repeated && !ownerUnknown && !versionUnknown;
    return {
      primary: null,
      sessions: [],
      overallAction: zeroClean ? "free" : "unverifiable",
      overallRationale:
        zeroClean
          ? "No autonomous session is running."
          : [
              clean ? null : incompleteRationale(),
              collapsed
                // The "no survivor to compare against" half is now stated by
                // `collisionRationale` itself, per dropped participant, so this
                // suffix carries only what that sentence does not: what the
                // emptiness may NOT be read as.
                ? `${collisionRationale()} The emptiness is therefore not evidence that no session is running.`
                : null,
              repeated
                ? `${repeatedRationale()} No session produced a verdict, but that is not evidence that none is running: the repeat was dropped and never classified.`
                : null,
              // NOT `ownershipRationale()`. That sentence says the affected
              // sessions are reported above, which is true for every population
              // that has one and necessarily FALSE here -- and two contradictory
              // statements in one incident message is worse than either alone.
              ownerUnknown
                ? `An ownership fault was reported for ${namedDirectories(ownershipUndetermined)}, but no session produced a verdict at all. ` +
                  "A scan result cannot legitimately contain both: `owner-task-undetermined` is emitted only for a record admitted to a " +
                  "reported population. This payload therefore violates the invariant that would justify trusting its emptiness, so the " +
                  "emptiness is not trusted. Rerun the guard; if it persists, the scan result did not come from this build's scanner."
                : null,
              versionUnknown
                ? `An unsupported \`schemaVersion\` was reported for ${namedDirectories(versionUnsupported)}, but no session produced a verdict at all. ` +
                  "That kind is emitted only for a record admitted to a reported population, so this payload violates the invariant that would " +
                  "justify trusting its emptiness. Rerun the guard; if it persists, the scan result did not come from this build's scanner."
                : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" "),
      identityUnavailable: !identityAvailable,
      transcriptionNotes: notes,
      diagnostics,
      scanCompleteness,
      collisions: droppedDuplicates,
    };
  }

  if (verdicts.length === 1) {
    const only = verdicts[0]!;
    const clean = scanCompleteness === "complete";
    // ISS-914: a collision withholds here when a dropped participant mismatches
    // its survivor on the policy signature, OR when no survivor exists to
    // compare against (the fail-closed case, unreachable through this function
    // and kept anyway). A matched comparison changes no answer this branch can
    // give and is still reported through `waivedCollisionClause` below.
    const collapsed = mismatchedCollisions.length + survivorlessCollisions.length > 0;
    // A collision happened and NONE of them block. Deliberately not
    // `waivedCollisions.length > 0`: with one waived and one blocking,
    // `collisionRationale` already reports both, and adding this clause too
    // would say the aggregate is not withheld when it is.
    const waived = droppedDuplicates.length > 0
      && mismatchedCollisions.length + survivorlessCollisions.length === 0;
    const repeated = repeatedEntries.length > 0;
    const ownerUnknown = ownershipUndetermined.length > 0;
    const versionUnknown = versionUnsupported.length > 0;
    // `primary` and `sessions` are PRESERVED. The observed record's own verdict
    // is still correct for the record observed; discarding it would leave the
    // caller unable to say what was found OR what failed. Only the AGGREGATE is
    // withheld.
    //
    // Two independent reasons to withhold it, and BOTH are reported when both
    // apply: the scan may have missed records (`incomplete`), and dedup may have
    // discarded one it did see (a collision). A reader shown only one would draw
    // the wrong conclusion about how much of the population is accounted for.
    // "was classified", not "was observed". With a collision in play the scan
    // observed more than one record; exactly one SURVIVED to receive a verdict,
    // and that is the count this sentence is entitled to state.
    const observed = `One session was classified (${proseLabel(only.sourceDir)}: ${only.relationship}), and its own verdict is reported above, but it cannot stand as the answer for the project.`;
    return {
      primary: only,
      sessions: verdicts,
      overallAction:
        clean && !collapsed && !repeated && !ownerUnknown && !versionUnknown ? only.action : "unverifiable",
      overallRationale:
        clean && !collapsed && !repeated && !ownerUnknown && !versionUnknown
          // The permissive path. A waived collision is appended rather than
          // omitted: the aggregate is the survivor's, and the reader is still
          // told a record was dropped to get there.
          ? waived ? `${only.rationale} ${waivedCollisionClause()}` : only.rationale
          : [
              clean ? null : incompleteRationale(),
              collapsed ? collisionRationale() : null,
              // The withheld path. Without this, an agreeing collision would
              // disappear whenever an INDEPENDENT blocker forced `unverifiable`.
              waived ? waivedCollisionClause() : null,
              repeated ? repeatedRationale() : null,
              ownerUnknown ? ownershipRationale() : null,
              versionUnknown ? versionRationale() : null,
              observed,
            ]
              .filter((part): part is string => part !== null)
              .join(" "),
      identityUnavailable: !identityAvailable,
      transcriptionNotes: notes,
      diagnostics,
      scanCompleteness,
      collisions: droppedDuplicates,
    };
  }

  // More than one bearing session. Step 0.5 evaluates sessions ONE AT A TIME and
  // supplies no rule for combining them -- no ordering, no suppression, no
  // winner. Two earlier drafts invented one (a terminal `ambiguous` verdict,
  // then a same-owner-first precedence) and both changed behavior: the first
  // forbade actions the prose permits, the second let one session's `continue`
  // suppress another session's `monitor-only` restrictions.
  //
  // So the guard returns no aggregate at all. `overallAction: null` is not a new
  // action; it is the absence of one. The skill routes this case to
  // `session-guard-fallback.md` mode B, which reports the returned verdicts and
  // the unresolved conflict without selecting, combining, executing, or refusing
  // any of them. Deciding what the aggregate rule should be is ISS-898.
  notes.push(
    `${verdicts.length} sessions bear on this project. Step 0.5 supplies no rule for combining them, so no aggregate action is reported (ISS-898).`,
  );
  // Bounded across the POPULATION. The count is the load-bearing part of this
  // sentence and it is carried separately, so cutting the list loses names and
  // never loses the answer.
  const named = boundedList(
    verdicts.map((v) => `${proseLabel(v.sourceDir)} (${v.relationship})`),
    { noun: "sessions" },
  );

  // This row keeps `null` even when the scan is incomplete, and that is not an
  // oversight (ISS-897). `null` is a STRONGER stop than `unverifiable`: it means
  // no aggregate rule exists at all, and overwriting it would erase the
  // multiplicity signal in exchange for a weaker one.
  //
  // But it must not SUPPRESS the concealment. `diagnostics` is returned
  // regardless, and the rationale reports BOTH problems -- a reader who saw only
  // the multiplicity would lose the fact that the population it was computed
  // over is not the whole population.
  const incompleteClause =
    scanCompleteness === "complete"
      ? ""
      : scanCompleteness !== "incomplete"
        ? ` Scan completeness is ALSO unknown, so there may be further sessions beyond the ones listed here. ${UNKNOWN_COMPLETENESS_REMEDY}`
        : concealing.length === 0
          ? // Same malformed-carrier branch the single-session paths take. Without
            // it this clause rendered "0 gaps ()" -- and here it is worse than in
            // the single-session rationale, because it sits beside a list of real
            // sessions and reads as though the scan had accounted for all of them.
            ` The scan is ALSO incomplete, so there may be further sessions beyond the ones listed here. ${MALFORMED_OMISSION_SENTENCE}`
          : ` The scan is ALSO incomplete: it reported ${concealing.length} gap${concealing.length === 1 ? "" : "s"} (${namedDirectories(concealing)}), so there may be further sessions beyond the ones listed here. ${collectionLevel(concealing)}${incompleteRemedy()}${malformedOmissionClause()}`;

  // A collision here does NOT downgrade `null` to `unverifiable`, for the same
  // reason an incomplete scan does not: `null` already withholds the aggregate
  // outright. It is reported, though -- the count above is a count of SURVIVORS,
  // and a reader who did not know records had been dropped would take it for the
  // whole population.
  const collisionClause = droppedDuplicates.length > 0 ? ` ${collisionRationale()}` : "";
  // Same treatment, separate sentence: `null` already withholds the aggregate,
  // but a reader who did not know a record was reported twice would take the
  // survivor count for the payload's own bookkeeping.
  const repeatedClause = repeatedEntries.length > 0 ? ` ${repeatedRationale()}` : "";
  // Same treatment as the collision clause: `null` already withholds the
  // aggregate, but a reader who did not know an owner was unreadable would take
  // the listed relationships at face value.
  const ownershipClause = ownershipUndetermined.length > 0 ? ` ${ownershipRationale()}` : "";
  // `null` already withholds the aggregate, so this changes no action -- but a
  // reader shown the multiplicity and not this would not know one of the listed
  // sessions carries fields read under a schema it does not claim.
  const versionClause = versionUnsupported.length > 0 ? ` ${versionRationale()}` : "";

  return {
    primary: null,
    sessions: verdicts,
    overallAction: null,
    overallRationale:
      `More than one session bears on this project: ${named}. There is no aggregate verdict: Step 0.5 gives a rule per session and none for combining them, ` +
      "and it does not say what to do when two verdicts conflict. Each session's own verdict is returned above; a permissive one standing beside a restrictive " +
      `one is an unresolved hazard, not a permission (ISS-898).${collisionClause}${repeatedClause}${ownershipClause}${versionClause}${incompleteClause}`,
    identityUnavailable: !identityAvailable,
    transcriptionNotes: notes,
    diagnostics,
    scanCompleteness,
    collisions: droppedDuplicates,
  };
}

export interface EvaluateSessionGuardOptions {
  /**
   * The caller's task id. Omitted or null falls back to the resolved client's
   * environment variable, exactly as the guide does. To force
   * `identityUnavailable` in a test, clear that variable rather than passing
   * null -- null here means "I have nothing to offer", not "ignore the
   * environment".
   */
  readonly clientTaskId?: string | null;
  readonly client?: StorybloqClient;
}

export function evaluateSessionGuard(root: string, opts: EvaluateSessionGuardOptions = {}): GuardVerdict {
  // The client is resolved exactly once and everything downstream keys off it.
  // `ownerTaskForCurrentClient` / `currentClientTaskId` would each re-read the
  // environment through `currentStorybloqClient()`, which can pair an explicit
  // `opts.client` of "claude" with `CODEX_THREAD_ID` (or the reverse) and
  // misclassify ownership.
  const client = opts.client ?? currentStorybloqClient();

  // Precedence matches `currentClientTaskId`, and matching it is the point: the
  // guide resolves its caller as `explicit ?? environment`, so a guard that
  // skipped the environment fallback would tell a caller its OWN session is
  // foreign wherever the id is inherited rather than passed. SKILL.md documents
  // that omission as supported ("Claude's inherited session id remains supported
  // when the field is omitted"). A hook-provided id is request-scoped and
  // therefore beats the environment of a potentially long-lived MCP process.
  const environmentTaskId = client === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID;
  const task = ownerTaskForClient(client, opts.clientTaskId ?? environmentTaskId);

  return classifySessionGuard(scanSessionSummaries(root), { task, client });
}
