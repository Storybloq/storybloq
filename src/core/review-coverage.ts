/**
 * T-477: per-commit review-coverage classification (plan section 5).
 *
 * Visibility only -- nothing here blocks a commit, merge, or transition.
 * ISS-1048's advisory-first template: ship the signal, gather field data,
 * only then consider promoting any part of this to enforcement.
 *
 * PROJECT-WIDE CORRUPTION DOCTRINE (interpretation ruling, pen, gate-1+):
 * an unparseable gate-ack file with no recoverable `ticketRef` could be ANY
 * ticket's ack -- including the contest record for the very commit being
 * classified right now, and an invisible contest silently reading as a
 * confident `"matched"` (or `"absent"`) is a false clean, the worst output
 * this feature can emit. This mirrors T-476's `loadRulingsSafe`/
 * `hasUnrecoverableEntries` doctrine (`core/ruling-loader.ts`): corruption
 * with a recoverable identity taints only that identity; corruption with NO
 * recoverable identity taints every conclusion it could conceal. So: while
 * `scanForUnattributedGateAckWarnings` (gate-ack-loader.ts) reports ANY
 * warning for the current run, no ref may classify as `"matched"` or
 * `"absent"` -- every gate-ack-eligible (ticket-shaped) ref reads `"unknown"`
 * for that whole run, via the caller-supplied `runHasUnattributedCorruption`
 * flag. A warning attributable to a DIFFERENT ticket stays excluded per the
 * ratified scoping (never taints this ticket); a warning attributable to
 * THIS ticket already reads `"unknown"` on its own, independent of this flag.
 */

import {
  TICKET_ID_REGEX,
  TICKET_CANONICAL_ID_REGEX,
  ISSUE_ID_REGEX,
  ISSUE_CANONICAL_ID_REGEX,
} from "../models/types.js";
import { readGateAcksForTicket, ticketAcksFromScan, type GateAckDirScan, type TicketRefResolver } from "./gate-ack-loader.js";
import { PRECOMMIT_ACK_GATE_NAME, type GateAck } from "../models/gate-ack.js";

export type GateAckCoverage = "matched" | "absent" | "contested" | "unknown" | "notApplicable";
export type ReviewEvidence = "present" | "absent" | "notApplicable";

export interface ReviewCoverage {
  readonly gateAckCoverage: GateAckCoverage;
  readonly reviewEvidence: ReviewEvidence;
  readonly gateAckId?: string;
  readonly codexSessionId?: string;
  readonly verdict?: string;
  readonly rounds?: number;
  /** True when more than one uncontested candidate's pin exactly matched (rare; see below). */
  readonly multipleMatches?: boolean;
}

/** The commit's own topology -- a fact about the commit, independent of any candidate ack. */
export interface CommitTopology {
  /** First-parent sha, 40 or 64 hex depending on repo object format. Null for a root commit or when uncomputable. */
  readonly parentSha: string | null;
  /** `^{tree}` id, same hex length as `parentSha`. Null when uncomputable (e.g. a SHA-256 repo -- see plan 4.2). */
  readonly treeId: string | null;
}

export function isTicketShapedRef(ref: string): boolean {
  return TICKET_ID_REGEX.test(ref) || TICKET_CANONICAL_ID_REGEX.test(ref);
}

export function isIssueShapedRef(ref: string): boolean {
  return ISSUE_ID_REGEX.test(ref) || ISSUE_CANONICAL_ID_REGEX.test(ref);
}

const NOT_APPLICABLE: ReviewCoverage = { gateAckCoverage: "notApplicable", reviewEvidence: "notApplicable" };
const UNKNOWN: ReviewCoverage = { gateAckCoverage: "unknown", reviewEvidence: "notApplicable" };
const ABSENT: ReviewCoverage = { gateAckCoverage: "absent", reviewEvidence: "notApplicable" };
const CONTESTED: ReviewCoverage = { gateAckCoverage: "contested", reviewEvidence: "notApplicable" };

/**
 * Classifies one `LandingRef`'s review coverage. `ref` is assumed already
 * resolved to its canonical or display form (the caller's job, via
 * `ProjectState`); this function only needs to tell a ticket-shaped ref from
 * an issue-shaped one, which is a pure regex check independent of project
 * state.
 *
 * `runHasUnattributedCorruption` MUST come from ONE
 * `scanForUnattributedGateAckWarnings` call per run (see that function's doc
 * comment) -- never recomputed per ref, and never defaulted, since a silent
 * default here is exactly the "confident wrong answer" this flag exists to
 * prevent.
 *
 * `gateAckScan`, when supplied, is a `scanGateAcksOnce` result the caller
 * scanned ONCE for the whole run and is threading through every ref's call --
 * see `scanGateAcksOnce`'s doc comment (T-477 round-4 finding: without this,
 * each call re-scanned `.story/arrangement-acks/` from disk, which is both
 * O(refs x files) and lets different refs in the same run observe different
 * directory states). Omitted only by single-ref callers (this file's own
 * tests included), which fall back to a private one-ref scan via
 * `readGateAcksForTicket`.
 *
 * `resolveTicketRef`, when supplied, resolves a raw (possibly differently-
 * aliased) ticket ref to its canonical id -- see `ticketAcksFromScan`'s doc
 * comment (T-477 round-4 cap escalation). Built by `storybloq landings` from
 * `ProjectState.resolveTicketRef`; omitted by callers with no `ProjectState`,
 * which fall back to the fail-closed default (nothing confirms as a
 * different known ticket, so a corrupt ack's non-matching raw ref is never
 * silently excluded).
 */
export function computeReviewCoverage(
  root: string,
  ref: string,
  topology: CommitTopology,
  runHasUnattributedCorruption: boolean,
  gateAckScan?: GateAckDirScan,
  resolveTicketRef?: TicketRefResolver,
): ReviewCoverage {
  // Step 1: issue ref -> notApplicable, stop. GateAckPin's ticketRef is
  // ticket-shaped-only (models/gate-ack.ts:70 / models/types.ts:184-189), so
  // an issue-linked landing cannot have a matching gate-ack under T-474.
  if (!isTicketShapedRef(ref)) return NOT_APPLICABLE;

  // Project-wide corruption doctrine (see module doc comment): checked
  // before this ticket's own scoped scan, since it overrides a clean result
  // regardless of what that scan finds.
  if (runHasUnattributedCorruption) return UNKNOWN;

  // Step 2: loader-warning check, scoped to THIS ticket.
  const { acks, scopedWarnings } = gateAckScan
    ? ticketAcksFromScan(gateAckScan, ref, resolveTicketRef)
    : readGateAcksForTicket(root, ref, resolveTicketRef);
  if (scopedWarnings.length > 0) return UNKNOWN;

  // A commit whose own topology could not be computed (shallow clone, a
  // SHA-256 repo per plan 4.2, or a root commit when the pin expects a
  // parent) cannot be exact-matched against anything.
  if (topology.parentSha === null || topology.treeId === null) return UNKNOWN;

  // Step 3: candidate filtering -- do NOT pre-exclude contested records here;
  // contested-ness is evaluated per exact pin match, next.
  const candidates = acks.filter(
    (a): a is GateAck & { pin: { kind: "tree-digest"; parentSha: string; treeId: string } } =>
      a.gateName === PRECOMMIT_ACK_GATE_NAME && a.pin.kind === "tree-digest",
  );

  // Step 4: exact pin match -- BOTH parentSha and treeId must match.
  const matches = candidates.filter((a) => a.pin.parentSha === topology.parentSha && a.pin.treeId === topology.treeId);

  // Step 5: classify, with explicit precedence across possibly-multiple exact matches.
  if (matches.length === 0) return ABSENT;
  const contestedMatches = matches.filter((m) => m.contested);
  if (contestedMatches.length > 0) return CONTESTED;

  // Every match here is uncontested. Prefer an evidence-bearing one;
  // otherwise the earliest by decidedAt (deterministic tie-break) --
  // sorted FIRST, not filtered-then-`.find()`'d, so the choice never depends
  // on directory-enumeration order: `acks` (and therefore `matches`) traces
  // back to `readdirSync`, whose order is not guaranteed, and two OR MORE
  // evidence-bearing matches would otherwise pick whichever happened to sort
  // first out of the filesystem rather than the earliest by decidedAt.
  const byDecidedAt = [...matches].sort((a, b) => (a.decidedAt ?? "").localeCompare(b.decidedAt ?? "") || a.id.localeCompare(b.id));
  const evidenceBearing = byDecidedAt.find((m) => m.reviewTrail.present === true);
  const selected = evidenceBearing ?? byDecidedAt[0]!;

  // Step 6: reviewEvidence, independent of the classification above.
  const reviewEvidence: ReviewEvidence = selected.reviewTrail.present ? "present" : "absent";

  return {
    gateAckCoverage: "matched",
    reviewEvidence,
    gateAckId: selected.id,
    codexSessionId: selected.reviewTrail.codexSessionId,
    verdict: selected.reviewTrail.verdict,
    rounds: selected.reviewTrail.rounds,
    ...(matches.length > 1 ? { multipleMatches: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// CommitSummary (plan section 4.1) -- derived, never stored.
// ---------------------------------------------------------------------------

export type CommitSummary =
  | "unattributed"
  | "fully-covered"
  | "needs-attention"
  | "contested"
  | "unknown"
  | "not-applicable";

/**
 * Total ordering over a commit's ref coverages (the pen's gate-1 ruling
 * restated this as a residual bucket so no combination falls through
 * unassigned): a matched-but-unevidenced ref (gate-ack exists,
 * `reviewTrail.present` false) lands in `"needs-attention"` rather than
 * satisfying neither of the original last two rules and getting no summary
 * at all.
 */
export function computeCommitSummary(coverages: readonly ReviewCoverage[]): CommitSummary {
  if (coverages.length === 0) return "unattributed";
  if (coverages.every((c) => c.gateAckCoverage === "notApplicable")) return "not-applicable";
  if (coverages.some((c) => c.gateAckCoverage === "contested")) return "contested";
  if (coverages.some((c) => c.gateAckCoverage === "unknown")) return "unknown";
  const fullyCovered = coverages.every(
    (c) => c.gateAckCoverage === "notApplicable" || (c.gateAckCoverage === "matched" && c.reviewEvidence === "present"),
  );
  return fullyCovered ? "fully-covered" : "needs-attention";
}
