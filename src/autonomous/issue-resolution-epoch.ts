/**
 * ISS-1032 (T-470 Amendment A5, plan-run6.md): ownership proof for
 * `parkCurrentIssue`, mirroring `ClaimEpoch`'s (claim-reconciliation.ts)
 * pattern for tickets.
 *
 * Amendment A5 supersedes the ratified B5 line "no claim analogue: ownership
 * is proven by `current.status === "resolved"` ... nothing else" -- codex
 * round-1 finding #2 identified the ABA hazard that line left open: another
 * session's own legitimate resolve -> reopen -> re-resolve cycle, completed
 * between this session's status check and its park write, leaves
 * `status === "resolved"` true throughout while ownership silently changed
 * hands. `status` alone cannot tell that apart from this session's own,
 * still-current resolution.
 *
 * Deliberately narrower than `ClaimEpoch`: issues carry no merge-driver
 * -rewritten `claim {user,branch,since}` group to reconcile against, so only
 * a session identity and a mint timestamp are needed here.
 *
 * Schema-escaping by design, exactly like `claimEpoch` (session-types.ts:214,
 * never a `SessionStateSchema` field, read/written via untyped casts and
 * `parseClaimEpoch` throughout claim-preflight.ts/park.ts/plan.ts):
 * `SessionStateSchema` is `.passthrough()`, so an unmodeled `issueResolutionEpoch`
 * key survives a real parse untouched, the same mechanism that already
 * carries `claimEpoch`. Introducing a second convention for the same kind of
 * value here would be pure inconsistency with nothing behind it.
 */

export interface IssueResolutionEpoch {
  readonly issueId: string;
  readonly sessionId: string;
  readonly establishedAt: string;
}

/** Absent, malformed, or partially-written epochs all read as "no epoch". */
export function parseIssueResolutionEpoch(value: unknown): IssueResolutionEpoch | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.issueId !== "string" || raw.issueId.length === 0) return null;
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) return null;
  if (typeof raw.establishedAt !== "string") return null;
  return { issueId: raw.issueId, sessionId: raw.sessionId, establishedAt: raw.establishedAt };
}

/**
 * Exact-match ownership proof. Both epochs must parse and agree on every
 * field: the issue's stamped epoch says who most recently minted one, the
 * session's mirrored copy says who THIS caller believes it is -- agreement
 * proves this session's own resolution is still the one standing.
 *
 * Legacy match is granted ONLY for a genuinely ABSENT issue-side field
 * (`undefined` -- the key was never written, meaning this issue predates
 * Amendment A5 or has never been through `issue-fix.ts`'s stamping write):
 * the caller returns `true` unconditionally, leaving `status === "resolved"`
 * sufficient exactly as it was before this amendment.
 *
 * Codex round-2 finding #1: the FIRST version of this function collapsed
 * "genuinely absent" and "present but malformed" to the same `null` (via
 * `parseIssueResolutionEpoch`) and granted legacy match to both -- so a
 * TRUNCATED or CORRUPTED epoch on an otherwise-current issue silently fell
 * back to the pre-A5 status-only proof, exactly the fail-open D1 forbids
 * everywhere else in this batch. `null` is therefore NOT treated as absent
 * here: a present-but-invalid value (including an explicit `null`, which
 * nothing in this codebase legitimately writes for this field) fails closed.
 */
export function issueEpochProvesOwnership(
  issueEpoch: unknown,
  sessionEpoch: unknown,
): boolean {
  if (issueEpoch === undefined) return true;
  const stamped = parseIssueResolutionEpoch(issueEpoch);
  if (!stamped) return false;
  const mine = parseIssueResolutionEpoch(sessionEpoch);
  if (!mine) return false;
  return (
    mine.issueId === stamped.issueId &&
    mine.sessionId === stamped.sessionId &&
    mine.establishedAt === stamped.establishedAt
  );
}
