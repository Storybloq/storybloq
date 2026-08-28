import type { Earmark, EarmarkRole, OwnerTaskLike } from "../models/types.js";

/**
 * T-475: earmark CAS primitives. Pick-exclusion state for assignment
 * coordination between a duet's pen and worker -- unrelated to
 * `reconcile.ts`'s "reservations" (git-ref duplicate-display-id
 * tie-breaking).
 *
 * These are pure functions. The actual locked read-check-write transaction
 * lives at each choke point (autonomous/stages/pick-ticket.ts,
 * autonomous/stages/issue-sweep.ts) and in the CLI/MCP surface
 * (cli/commands/earmark.ts) -- this module only decides, never performs I/O.
 */

export type AcquireEarmarkResult =
  | { ok: true; write: Earmark | null }
  | { ok: false; holder: Earmark };

/**
 * The choke point's core decision (R5 -- the gate-1 acceptor's ruling after
 * round 3 found the original "clear on pick" design left an exclusion gap):
 * CONVERT, never clear.
 *
 * - No earmark: the choke point does not act. `write: null` means "no field
 *   to persist" -- ordinary, never-earmarked items are completely untouched.
 * - `reserved` matching this session's role: CAS-converts to
 *   `assigned(sessionId)`. The earmark PERSISTS (as `assigned`) rather than
 *   being cleared -- this is what keeps a rival's concurrent reserve/pick
 *   from landing in the gap between this pick and the item's later claim.
 * - `assigned` already to this session: passes, no write needed.
 * - Anything else (assigned to another session, or reserved for a role this
 *   session does not hold): refused, holder named.
 */
export function tryAcquireEarmark(
  current: Earmark | null | undefined,
  sessionId: string,
  role: EarmarkRole,
): AcquireEarmarkResult {
  if (!current) return { ok: true, write: null };
  if (current.stage === "reserved") {
    if (current.holderRole === role) {
      return { ok: true, write: { ...current, stage: "assigned", holderSession: sessionId } };
    }
    return { ok: false, holder: current };
  }
  // current.stage === "assigned"
  if (current.holderSession === sessionId) return { ok: true, write: null };
  return { ok: false, holder: current };
}

export type PlaceEarmarkResult =
  | { ok: true; earmark: Earmark }
  | { ok: false; holder: Earmark };

/**
 * Equality for the idempotent-retry row of the lifecycle table: a placement
 * call that exactly repeats the currently-stored earmark (excluding `since`,
 * which a genuine retry mints fresh) is a no-op success, not a conflict.
 */
function isIdempotentRetry(current: Earmark, next: Earmark): boolean {
  if (current.stage !== next.stage) return false;
  if (current.holderRole !== next.holderRole) return false;
  if (current.holderSession !== next.holderSession) return false;
  if (current.arrangementId !== next.arrangementId) return false;
  return current.reservedBy.client === next.reservedBy.client && current.reservedBy.id === next.reservedBy.id;
}

/**
 * Placement CAS (`earmark reserve`/`earmark assign`, and the explicit CLI
 * reserved->assigned conversion -- section 6). `next` is the caller's
 * fully-formed candidate earmark (identity/arrangement/timestamp already
 * resolved by the caller; this function only decides whether it may land).
 *
 * Succeeds only against: an absent earmark on an `open` item (fresh
 * placement); an exact idempotent retry of the current earmark; or a
 * role-matching `reserved` -> `assigned` conversion (the explicit CLI path,
 * distinct from the choke point's own pick-time conversion). Everything else
 * -- a non-open item, or an earmark that already names someone/something
 * else -- is a conflict, holder named. This is what keeps a rival placement
 * from ever overwriting a `tryAcquireEarmark` conversion that already landed
 * (R5's core safety property): by the time a placement call reads current
 * state, an in-progress pick's conversion is either already visible (this
 * call refuses) or not yet committed (the choke point's own lock ordering
 * decides who wins) -- never both silently succeeding.
 */
export function canPlaceEarmark(
  current: Earmark | null | undefined,
  itemStatus: string,
  next: Earmark,
): PlaceEarmarkResult {
  if (itemStatus !== "open") {
    return current
      ? { ok: false, holder: current }
      : { ok: false, holder: next }; // no earmark exists, but the item itself is already acquired -- refuse rather than mint one over live work
  }
  if (!current) return { ok: true, earmark: next };
  if (isIdempotentRetry(current, next)) return { ok: true, earmark: current };
  if (current.stage === "reserved" && next.stage === "assigned" && current.holderRole === next.holderRole) {
    return { ok: true, earmark: next };
  }
  return { ok: false, holder: current };
}

/**
 * Layer 2 (advisory, never load-bearing): true iff the item carries no
 * earmark at all. Used at candidate-listing sites so a worker's pick is not
 * tempted by a reserved/assigned item -- binding exclusion is enforced by
 * `tryAcquireEarmark` at the choke point regardless of what any listing
 * shows, so a missed call site here is a UX bug, never a correctness bug.
 */
export function isEarmarkVisible(item: { earmark?: Earmark | null }): boolean {
  return !item.earmark;
}

/**
 * Layer 2 variant for listings that mix open and inprogress items (most of
 * `recommend.ts`'s generators and `queries.ts`'s next-ticket queries filter
 * on "not complete" rather than "open"). An inprogress item's own `assigned`
 * earmark is the normal worked state (R5), not a pick temptation -- hiding
 * it would regress a session's ability to find its way back to its own
 * active work. Only an OPEN item's earmark is a pick temptation worth
 * suppressing here; every other status passes through untouched.
 */
export function notHiddenByEarmark(item: { status: string; earmark?: Earmark | null }): boolean {
  return item.status !== "open" || isEarmarkVisible(item);
}

function isStaleByAge(since: string, thresholdHours: number, nowIso: string): boolean {
  const ageMs = Date.parse(nowIso) - Date.parse(since);
  // An unparseable `since` fails closed -- flagged as stale rather than
  // silently treated as fresh, matching the codebase's fail-closed posture
  // for every other new check this ticket introduces.
  if (Number.isNaN(ageMs)) return true;
  return ageMs > thresholdHours * 60 * 60 * 1000;
}

/**
 * AM-a (gate-1 ratification amendment): staleness must be checkable from
 * item-file fields alone -- `validate` is pure over item files and has no
 * touch-recency signal. An `assigned` earmark whose `holderSession` equals
 * the ticket's actual `claimedBySession` is the normal worked state (R5) and
 * is never stale regardless of `since`'s age. A `reserved`-stage earmark, or
 * an `assigned` earmark with no matching claim, is stale once `since`
 * exceeds the threshold.
 */
export function isTicketEarmarkStale(
  ticket: { earmark?: Earmark | null; claimedBySession?: string | null },
  thresholdHours: number,
  nowIso: string,
): boolean {
  const earmark = ticket.earmark;
  if (!earmark) return false;
  if (earmark.stage === "assigned" && ticket.claimedBySession === earmark.holderSession) return false;
  return isStaleByAge(earmark.since, thresholdHours, nowIso);
}

/**
 * AM-b (gate-1 ratification amendment): `models/issue.ts` carries no
 * `claimedBySession` field at all -- a "matching claim" is definitionally
 * impossible for an issue, so an `assigned` issue earmark is ALWAYS
 * stale-eligible once `since` exceeds the threshold, stated explicitly here
 * rather than left as an implication of a missing field. This is what
 * surfaces a dead-session sweep strand: a session that dies mid-sweep leaves
 * an issue `inprogress` + `assigned` with no live session and no claim ever
 * possible to match against, and this function flags it past threshold
 * instead of leaving it permanently invisible to `validate`.
 */
export function isIssueEarmarkStale(
  issue: { earmark?: Earmark | null },
  thresholdHours: number,
  nowIso: string,
): boolean {
  const earmark = issue.earmark;
  if (!earmark) return false;
  return isStaleByAge(earmark.since, thresholdHours, nowIso);
}

/**
 * Release authorization. Two identity namespaces, kept separate rather than
 * bridged (round-3 finding, resolved by the gate-1 acceptor):
 * - `ownerTask`: the placement/retraction identity (resolved via the same
 *   clientTaskId/OwnerTask mechanism session_guard/arrangement handling
 *   already use), compared against `earmark.reservedBy` -- authorizes the
 *   reserver retracting their own placement, at EITHER stage.
 * - `session`: a Storybloq session UUID, compared against
 *   `earmark.holderSession` -- authorizes an assigned holder declining its
 *   own assignment. Only ever supplied from INSIDE that session's own
 *   PARK/SKIP flow (same namespace as `ctx.state.sessionId`), never from the
 *   standalone CLI `earmark release` path, which has no session to supply.
 */
export type EarmarkReleaseActor =
  | { kind: "ownerTask"; value: OwnerTaskLike }
  | { kind: "session"; value: string };

export function provenEarmarkOwnership(earmark: Earmark, actor: EarmarkReleaseActor): boolean {
  if (actor.kind === "ownerTask") {
    return earmark.reservedBy.client === actor.value.client && earmark.reservedBy.id === actor.value.id;
  }
  return earmark.stage === "assigned" && earmark.holderSession === actor.value;
}

/**
 * Self-decline (section 5): PARK, the three SKIP sites, and claim-loss/cancel
 * all release a claim on the item they are walking away from, and this is
 * the same-session earmark half of that release, applied in the SAME locked
 * write. Only ever clears an `assigned` earmark held by `sessionId` --
 * deliberately unconditional on whether a claim was also released, since the
 * choke point converts an earmark at PICK time, before PLAN's own
 * `plan_written` report ever lands a claim; a session that walks away before
 * that point still holds an earmark with nothing yet to release alongside it.
 * A `reserved` earmark is never touched here -- it names no session to match
 * against and was never `tryAcquireEarmark`'s job to convert in the first
 * place.
 */
export function clearSameSessionEarmark<T extends { earmark?: Earmark | null }>(
  item: T,
  sessionId: string,
): { cleared: boolean; item: T } {
  const earmark = item.earmark;
  if (!earmark || earmark.stage !== "assigned" || earmark.holderSession !== sessionId) {
    return { cleared: false, item };
  }
  return { cleared: true, item: { ...item, earmark: null } };
}

/**
 * Arrangement-close bulk clear (section 5): a pure predicate so the actual
 * scan-and-write stays in `handleArrangementUpdate`, inside the lock it
 * already holds, rather than this I/O-free module reaching for a lock of its
 * own (confirmed nesting-deadlock risk, round 1). Matches either stage --
 * closing an arrangement retracts everything it ever authorized, reserved or
 * already picked up.
 */
export function earmarkMatchesArrangement(earmark: Earmark | null | undefined, arrangementId: string): boolean {
  return !!earmark && earmark.arrangementId === arrangementId;
}

/** User-facing holder description for a refused pick/placement/conversion. */
export function describeEarmarkHolder(holder: Earmark): string {
  if (holder.stage === "assigned") {
    return `session ${holder.holderSession} (role ${holder.holderRole})`;
  }
  return `role ${holder.holderRole} (reserved, not yet picked up)`;
}
