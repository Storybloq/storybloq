import {
  scanSessionSummaries,
  type ActiveSessionSummary,
  type SessionLeaseState,
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
 * one is present), ISS-899 (this guard and
 * `liveOwnershipConflict` disagree about ownership in two cells).
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
      `Session state ${JSON.stringify(s.state)} is not a known workflow state, so whether it needs COMPACT recovery cannot be determined. Run \`storybloq session list\`.`,
  },
  {
    // A recovery candidate that is not COMPACT is not one the recovery sentence
    // describes; the scanner never produces it, so anything that does is unknown
    // input rather than a case with a documented rule.
    id: "recovery-not-compact",
    applies: (s, expectCompact) => expectCompact && s.state !== "COMPACT",
    rationale: (s) =>
      `A session offered as a recovery candidate must be in COMPACT, not ${JSON.stringify(s.state)}. Run \`storybloq session list\`.`,
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

  // NOTE (ISS-899): `claudeCodeSessionId` is deliberately not consulted.
  // `liveOwnershipConflict` resolves ownership by `ownerTask`, else that legacy
  // id, else no conflict -- but the id appears nowhere in `SKILL.md`, and Step
  // 0.5's only rule for an `ownerTask`-absent session is the legacy pair below,
  // which inspects no id. Transcribing enforcement's precedence here would be
  // reading the implementation instead of the text, and the scanner does not
  // even project the field. The two components therefore disagree in this cell,
  // deliberately and with a test naming the issue.
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

export function classifySessionGuard(summaries: SessionScanResult, caller: GuardCaller): GuardVerdict {
  const identityAvailable = caller.task !== null;
  const notes: string[] = [];

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
  for (const entry of ordered) {
    const kept = seen.get(entry.summary.sessionId);
    if (kept !== undefined) {
      // Both directories, and WHICH is which. A note naming only the dropped one
      // tells an operator a collision exists without telling them what survived;
      // naming only the survivor loses the thing they have to go delete.
      notes.push(
        `Session id ${entry.summary.sessionId} appears under more than one directory: kept ${kept}, dropped ${entry.summary.sourceDir}. ` +
          "Step 0.5 says to deduplicate by full `sessionId` and supplies no tiebreak, so the first by read order is kept " +
          "and the other is not reported. This note IS the detection, in unstructured form; a structured scanner " +
          "diagnostic carrying both directories is ISS-897.",
      );
      continue;
    }
    seen.set(entry.summary.sessionId, entry.summary.sourceDir);
    deduped.push(entry);
  }

  const verdicts: SessionVerdict[] = [];
  for (const { summary, expectCompact } of deduped) {
    const c = expectCompact
      ? indeterminateState(summary, true) ?? classifyResumable(summary, identityAvailable)
      : indeterminateState(summary, false) ?? classifyLive(summary, caller);
    if (c.note) notes.push(c.note);
    verdicts.push(toVerdict(summary, c, expectCompact));
  }

  // Presentation only. Sorting first does not make the first one authoritative.
  verdicts.sort((a, b) => {
    const byRelationship = RENDER_ORDER.indexOf(a.relationship) - RENDER_ORDER.indexOf(b.relationship);
    return byRelationship !== 0 ? byRelationship : a.sourceDir.localeCompare(b.sourceDir);
  });

  if (verdicts.length === 0) {
    return {
      primary: null,
      sessions: [],
      overallAction: "free",
      overallRationale: "No autonomous session is running.",
      identityUnavailable: !identityAvailable,
      transcriptionNotes: notes,
    };
  }

  if (verdicts.length === 1) {
    const only = verdicts[0]!;
    return {
      primary: only,
      sessions: verdicts,
      overallAction: only.action,
      overallRationale: only.rationale,
      identityUnavailable: !identityAvailable,
      transcriptionNotes: notes,
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
  const named = verdicts.map((v) => `${v.sourceDir} (${v.relationship})`).join(", ");
  return {
    primary: null,
    sessions: verdicts,
    overallAction: null,
    overallRationale:
      `More than one session bears on this project: ${named}. There is no aggregate verdict: Step 0.5 gives a rule per session and none for combining them, ` +
      "and it does not say what to do when two verdicts conflict. Each session's own verdict is returned above; a permissive one standing beside a restrictive " +
      "one is an unresolved hazard, not a permission (ISS-898).",
    identityUnavailable: !identityAvailable,
    transcriptionNotes: notes,
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
