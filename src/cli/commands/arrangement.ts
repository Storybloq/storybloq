import { withProjectLock, writeTicketUnlocked, writeIssueUnlocked, loadProject } from "../../core/project-loader.js";
import { loadArrangementsSafe, writeArrangementUnlocked } from "../../core/arrangement-loader.js";
import { isArrangementConflicted } from "../../core/arrangement-authority.js";
import { earmarkMatchesArrangement } from "../../core/earmarks.js";
import { generateCanonicalId } from "../../core/canonical-id.js";
import { summarizeZodIssues, describeSchemaIssues } from "../../core/zod-issues.js";
import { resolveNodeRoot } from "../../mcp/node-resolution.js";
import { withOrchestratorAndItemLocks } from "../../core/orchestrator-item-lock.js";
import {
  formatArrangement,
  formatArrangementList,
  formatArrangementCreateResult,
  formatArrangementUpdateResult,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import {
  ArrangementSchema,
  ARRANGEMENT_LIFECYCLE,
  type Arrangement,
  type ArrangementLifecycle,
  type ArrangementParty,
} from "../../models/arrangement.js";
import { TICKET_ID_REGEX, TICKET_CANONICAL_ID_REGEX, ISSUE_ID_REGEX, ISSUE_CANONICAL_ID_REGEX, type OutputFormat } from "../../models/types.js";
import { CROSS_NODE_REF_CAPTURE_REGEX } from "../../models/ticket.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { ProjectState } from "../../core/project-state.js";

/**
 * Resolves a `--bounds` ref (display-form or canonical, per binding item 1)
 * against the fresh `ProjectState` and returns the resolved item's own
 * `.id`, never the raw typed ref -- this normalizes a valid post-migration
 * display-id reference to its canonical form while leaving a legacy ref
 * untouched (a legacy item's `id` already equals its display form), so a
 * persisted bound is never ambiguous even if the display id it was typed as
 * later collides. Ticket and issue ref patterns are syntactically disjoint
 * (`T-`/`t-` vs `ISS-`/`i-`), so there is no try-one-then-fall-back-to-the-
 * other ambiguity.
 *
 * ISS-1077 ([R2-FIX 3], amended by A4): a `node:ref` prefix is recognized
 * BEFORE the local check (a `node:` prefix can never collide with a local
 * pattern, so order doesn't matter for correctness, but checking it first
 * makes the fail-closed path the first thing a reader sees). The node's OWN
 * project is loaded and the item resolved within it, exactly like a local
 * bound, then re-qualified with the node prefix around the resolved item's
 * OWN `.id` (canonical hash form for a team-mode node, display form for a
 * non-team-mode node -- see `NodeQualifiedBoundRefSchema`'s docblock in
 * models/arrangement.ts for the full rationale) -- eager normalization (Q2
 * ruling): an arrangement must never record a bound against unverified
 * state. Any failure along that path (unknown node, unresolvable node path,
 * node project fails to load, item missing/ambiguous on that node) throws,
 * never silently drops the node qualifier.
 */
async function resolveBoundRef(ref: string, state: ProjectState, pinnedRoot: string): Promise<string> {
  const crossNode = CROSS_NODE_REF_CAPTURE_REGEX.exec(ref);
  if (crossNode) {
    const [, nodeName, itemRef] = crossNode as unknown as [string, string, string];
    const resolved = resolveNodeRoot(pinnedRoot, nodeName);
    if (!resolved.ok) {
      throw new CliValidationError("invalid_input", `Bound ref "${ref}": ${resolved.error}`);
    }
    let nodeState: ProjectState;
    try {
      ({ state: nodeState } = await loadProject(resolved.root));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliValidationError("invalid_input", `Bound ref "${ref}": node "${nodeName}" project failed to load (${message})`);
    }
    const isTicketRef = TICKET_ID_REGEX.test(itemRef) || TICKET_CANONICAL_ID_REGEX.test(itemRef);
    const isIssueRef = ISSUE_ID_REGEX.test(itemRef) || ISSUE_CANONICAL_ID_REGEX.test(itemRef);
    if (!isTicketRef && !isIssueRef) {
      throw new CliValidationError("invalid_input", `Bound ref "${ref}": "${itemRef}" is neither a ticket nor an issue reference`);
    }
    const result = isTicketRef ? nodeState.resolveTicketRef(itemRef) : nodeState.resolveIssueRef(itemRef);
    if (result.kind === "missing") {
      throw new CliValidationError("invalid_input", `Bound ref "${ref}" not found on node "${nodeName}"`);
    }
    if (result.kind === "ambiguous") {
      throw new CliValidationError("invalid_input", `Bound ref "${ref}" is ambiguous on node "${nodeName}"`);
    }
    return `${nodeName}:${result.item.id}`;
  }

  const isTicketRef = TICKET_ID_REGEX.test(ref) || TICKET_CANONICAL_ID_REGEX.test(ref);
  const isIssueRef = ISSUE_ID_REGEX.test(ref) || ISSUE_CANONICAL_ID_REGEX.test(ref);
  if (!isTicketRef && !isIssueRef) {
    throw new CliValidationError("invalid_input", `Bound ref "${ref}" is neither a ticket nor an issue reference`);
  }
  const result = isTicketRef ? state.resolveTicketRef(ref) : state.resolveIssueRef(ref);
  if (result.kind === "missing") {
    throw new CliValidationError("invalid_input", `Bound ref "${ref}" not found`);
  }
  if (result.kind === "ambiguous") {
    throw new CliValidationError("invalid_input", `Bound ref "${ref}" is ambiguous`);
  }
  return result.item.id;
}

/**
 * Validates the assembled record against `ArrangementSchema` (including its
 * party-topology `superRefine`) BEFORE the writer's own defensive parse, so
 * a two-workers-no-pen or duplicate-identity payload reports `invalid_input`
 * with field detail rather than reaching `writeArrangementUnlocked`'s
 * internal `.parse()` and surfacing as an unclassified `io_error`.
 */
function validateOrThrow(candidate: unknown): Arrangement {
  const result = ArrangementSchema.safeParse(candidate);
  if (!result.success) {
    const issues = summarizeZodIssues(result.error);
    throw new CliValidationError("invalid_input", describeSchemaIssues(issues, result.error.issues.length));
  }
  return result.data;
}

// --- Read handlers ---
// Arrangements are deliberately NOT part of `ctx.state` (binding item 2:
// off the strict ProjectState load path), so both read handlers call the
// fail-safe loader directly, exactly as `handleStatus` does.

export function handleArrangementList(
  filters: { lifecycle?: string },
  ctx: CommandContext,
): CommandResult {
  const { arrangements } = loadArrangementsSafe(ctx.root);
  let filtered = arrangements;
  if (filters.lifecycle) {
    if (!ARRANGEMENT_LIFECYCLE.includes(filters.lifecycle as ArrangementLifecycle)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown arrangement lifecycle "${filters.lifecycle}": must be one of ${ARRANGEMENT_LIFECYCLE.join(", ")}`,
      );
    }
    filtered = filtered.filter((a) => a.lifecycle === filters.lifecycle);
  }
  return { output: formatArrangementList(filtered, ctx.format) };
}

export function handleArrangementGet(id: string, ctx: CommandContext): CommandResult {
  const { arrangements } = loadArrangementsSafe(ctx.root);
  const arrangement = arrangements.find((a) => a.id === id);
  if (!arrangement) {
    return {
      output: formatError("not_found", `Arrangement ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatArrangement(arrangement, ctx.format) };
}

// --- Write handlers ---

export async function handleArrangementCreate(
  args: {
    bounds: string[];
    parties: ArrangementParty[];
    onIrreversibleWork: "hold" | "escalate";
    onReversibleWork?: "hold" | "escalate" | "proceed";
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (args.bounds.length === 0) {
    throw new CliValidationError("invalid_input", "At least one --bounds ref is required");
  }

  let created: Arrangement | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const resolvedBounds = await Promise.all(args.bounds.map((ref) => resolveBoundRef(ref, state, root)));
    const id = generateCanonicalId("a");
    const today = new Date().toISOString().slice(0, 10);
    const candidate = {
      id,
      lifecycle: "active" as const,
      bounds: resolvedBounds,
      parties: args.parties,
      gates: [],
      unreachability: {
        onIrreversibleWork: args.onIrreversibleWork,
        ...(args.onReversibleWork !== undefined && { onReversibleWork: args.onReversibleWork }),
      },
      createdDate: today,
    };
    const arrangement = validateOrThrow(candidate);
    await writeArrangementUnlocked(arrangement, root, { createOnly: true });
    created = arrangement;
  });

  if (!created) throw new Error("Arrangement not created");
  return { output: formatArrangementCreateResult(created, format) };
}

/**
 * Section 5: closing an arrangement retracts everything it ever authorized.
 * Called INSIDE `handleArrangementUpdate`'s existing lock, never a
 * separately-locking wrapper (confirmed nesting-deadlock risk, round 1) --
 * `earmarkMatchesArrangement` (earmarks.ts) is the pure predicate, this is
 * just the scan-and-write.
 */
async function clearEarmarkUnlocked(state: ProjectState, arrangementId: string, root: string): Promise<void> {
  for (const ticket of state.tickets) {
    if (earmarkMatchesArrangement(ticket.earmark, arrangementId)) {
      await writeTicketUnlocked({ ...ticket, earmark: null }, root);
    }
  }
  for (const issue of state.issues) {
    if (earmarkMatchesArrangement(issue.earmark, arrangementId)) {
      await writeIssueUnlocked({ ...issue, earmark: null }, root);
    }
  }
}

/** ISS-1077 (C5): groups an arrangement's node-qualified bounds by node name. */
function groupNodeQualifiedBounds(bounds: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const ref of bounds) {
    const match = CROSS_NODE_REF_CAPTURE_REGEX.exec(ref);
    if (!match) continue;
    const [, nodeName, itemId] = match as unknown as [string, string, string];
    const list = groups.get(nodeName) ?? [];
    list.push(itemId);
    groups.set(nodeName, list);
  }
  return groups;
}

/**
 * ISS-1077 (C5), reworked post-gate-1 per codex round 1: the node-side twin
 * of `clearEarmarkUnlocked`, scoped to one node root -- now a FULL scan of
 * that root's own tickets/issues by `arrangementId`, exactly mirroring
 * `clearEarmarkUnlocked`'s local behavior, rather than looking up only the
 * specific ids the arrangement's CURRENT bounds happen to name. The original
 * id-keyed version missed an item whose bound was removed/merge-edited after
 * its earmark was placed (unlike local closure, which always scans
 * everything), and could never retract a hand-edited, mismatched-id bound
 * against a team-mode node (A4's traced residual) since `ticketByID` would
 * simply miss. Scanning by `arrangementId` instead is form-and-mismatch
 * agnostic and idempotent (safe to re-run on a retry).
 */
async function retractNodeEarmarksOnItem(
  itemState: ProjectState,
  itemRoot: string,
  arrangementId: string,
): Promise<void> {
  for (const ticket of itemState.tickets) {
    if (earmarkMatchesArrangement(ticket.earmark, arrangementId)) {
      await writeTicketUnlocked({ ...ticket, earmark: null }, itemRoot);
    }
  }
  for (const issue of itemState.issues) {
    if (earmarkMatchesArrangement(issue.earmark, arrangementId)) {
      await writeIssueUnlocked({ ...issue, earmark: null }, itemRoot);
    }
  }
}

export async function handleArrangementUpdate(
  id: string,
  updates: { lifecycle?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (updates.lifecycle === undefined) {
    throw new CliValidationError("invalid_input", "Specify at least one field to update: lifecycle");
  }
  if (!ARRANGEMENT_LIFECYCLE.includes(updates.lifecycle as ArrangementLifecycle)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown arrangement lifecycle "${updates.lifecycle}": must be one of ${ARRANGEMENT_LIFECYCLE.join(", ")}`,
    );
  }

  // ISS-1077 ([R3-FIX 3/4], reworked post-gate-1 per codex round 1): pre-lock
  // HINT only -- which node ROOTS might need earmark retraction if this
  // closes the arrangement, so we know which item locks to acquire before
  // entering the orchestrator lock. Deliberately a Set of resolved ROOTS, not
  // a name -> root map: two different configured node names can resolve to
  // the same physical root (an alias), and retraction below is a full scan
  // of that root's own tickets/issues by arrangementId (mirroring
  // `clearEarmarkUnlocked`'s local behavior exactly) -- it needs to know
  // WHICH ROOTS to visit, never WHICH NAME they were reached through, so an
  // aliased name can never cause one root's cleanup to be silently dropped
  // in favor of another. Re-verified against the freshly loaded arrangement
  // in `preValidate` below (by RESOLVED ROOT, same reasoning); if bounds
  // changed concurrently to reference a root this hint missed, the close
  // refuses rather than silently skipping that root's retraction (D1: fail
  // closed on a detected race, never proceed on a stale hint).
  //
  // Known accepted residual (ISS-1084, ruled by the pen during run-7's
  // codex-round-1 triage): this hint is built from the arrangement's CURRENT
  // bounds only. If a bounds edit removes a node NAME entirely (not just
  // swaps to a different id on the same node -- that case IS covered, see
  // `retractNodeEarmarksOnItem`'s full-scan-by-arrangementId below), that
  // node's root never enters `hintNodeRoots`, its lock is never acquired, and
  // any earmark stranded there is never retracted by this close. Accepted
  // because the failure direction is a STRANDED reservation (conservative:
  // blocks reuse, never authorizes a wrong write); full parity needs a real
  // design decision (lock every configured node on close, or a persisted
  // touched-nodes history) tracked in ISS-1084, not a bug fix. `earmark
  // release`'s stored-arrangementId authority (codex round 2, see
  // `authorizeRelease` in earmark.ts) is what makes the manual-recovery
  // claim above actually TRUE -- it was false when this comment was first
  // written (release required current bounds coverage, which this exact
  // scenario removes), fixed in the same round that added the multi-root
  // ordering choice below.
  const closing = updates.lifecycle === "closed";
  const hintNodeRoots = new Set<string>();
  if (closing) {
    const { arrangements: hintArrangements } = loadArrangementsSafe(root);
    const hintExisting = hintArrangements.find((a) => a.id === id);
    if (hintExisting) {
      for (const nodeName of groupNodeQualifiedBounds(hintExisting.bounds).keys()) {
        const resolved = resolveNodeRoot(root, nodeName);
        if (resolved.ok) hintNodeRoots.add(resolved.root);
        // Unresolvable here: dropped from the hint. preValidate's own fresh
        // resolution hits the same failure and refuses fail-closed there
        // (the close throws rather than silently proceeding).
      }
    }
  }

  let updated: Arrangement | undefined;

  await withOrchestratorAndItemLocks(
    root,
    [...hintNodeRoots],
    async (_orchestratorState, itemRoot, itemState) => {
      // Idempotent full scan (never limited to the bounds captured by the
      // pre-lock hint, and never skipped just because the arrangement was
      // ALREADY closed) -- this root was selected specifically because SOME
      // node-qualified bound named it as relevant; clearing by arrangementId
      // rather than by specific item id also means a hand-edited bound
      // storing a stale/mismatched id (A4's traced residual) can never leave
      // an earmark stranded here the way an id-keyed lookup could. Re-running
      // this on a retry after a prior partial failure is always safe: a
      // matching earmark is cleared, a non-matching or already-cleared one is
      // untouched. Runs AFTER `beforeItems` below has already committed the
      // arrangement's own closure (codex round 2): if THIS sweep fails
      // partway across multiple node roots, the arrangement is already
      // closed and whichever root's earmark this reached is already
      // retracted -- only the roots not yet reached are left with a
      // stranded-but-conservative earmark (see `beforeItems`'s docblock on
      // `withOrchestratorAndItemLocks` for the fail-direction this reorder
      // chose), recoverable via `earmark release`'s own
      // stored-arrangementId authority (`authorizeRelease` in earmark.ts),
      // which needs neither the arrangement to still be active nor its
      // bounds to still cover the item.
      await retractNodeEarmarksOnItem(itemState, itemRoot, id);
    },
    async () => {},
    undefined,
    () => {
      // Runs under the orchestrator lock BEFORE any item root is touched
      // (see withOrchestratorAndItemLocks's own docblock on why this can't
      // wait until the write below): not-found, conflicted, and the D1
      // missed-root race check all belong here, not after node mutations
      // have already committed and released their locks.
      const { arrangements } = loadArrangementsSafe(root);
      const existing = arrangements.find((a) => a.id === id);
      if (!existing) {
        throw new CliValidationError("not_found", `Arrangement ${id} not found`);
      }
      if (isArrangementConflicted(existing)) {
        throw new CliValidationError(
          "invalid_input",
          `Arrangement ${id} has unresolved merge conflicts; resolve with "storybloq resolve ${id}" before updating it`,
        );
      }
      if (closing) {
        // D1: every node root this close needs to touch must have had its
        // item lock actually acquired above. A bound added concurrently,
        // after the hint was taken but before this lock closed the race
        // window, would not have. Refuse rather than close with a node
        // earmark left stranded -- see this function's own module docblock
        // (C5). Compared by RESOLVED ROOT (never by name) so an alias never
        // masks a genuinely missed root.
        for (const nodeName of groupNodeQualifiedBounds(existing.bounds).keys()) {
          const resolved = resolveNodeRoot(root, nodeName);
          if (!resolved.ok || !hintNodeRoots.has(resolved.root)) {
            throw new CliValidationError(
              "conflict",
              `Arrangement ${id}'s bounds changed to reference node "${nodeName}" during this close; retry the close so its earmarks can be retracted safely.`,
            );
          }
        }
      }
    },
    async (orchestratorState) => {
      // codex round-2 (ISS-1077 continued): the arrangement's own write --
      // and the orchestrator-side earmark clear that depends on it having
      // already landed -- now commits HERE, under `beforeItems`, BEFORE the
      // node-root retraction sweep in `perItem` above, inverting round-1's
      // order. preValidate already confirmed existing/unconflicted/
      // no-missed-root; re-derive fresh again here only because this is
      // where the write happens and nothing else can have changed it while
      // the orchestrator lock has been held continuously since preValidate
      // ran. See `withOrchestratorAndItemLocks`'s own docblock for why this
      // ordering was chosen: it trades a fail-open partial-failure exposure
      // (earmarks cleared, arrangement still active) for a fail-closed one
      // (arrangement closed, an earmark stranded), the latter being cheap to
      // recover from now that `earmark release` no longer needs the
      // arrangement to still cover the item.
      const { arrangements } = loadArrangementsSafe(root);
      const existing = arrangements.find((a) => a.id === id)!;
      const candidate = { ...existing, lifecycle: updates.lifecycle as ArrangementLifecycle };
      const arrangement = validateOrThrow(candidate);

      // Binding item 3: the ordinary atomic-replace path, `createOnly` omitted.
      await writeArrangementUnlocked(arrangement, root);
      if (arrangement.lifecycle === "closed") {
        await clearEarmarkUnlocked(orchestratorState, arrangement.id, root);
      }
      updated = arrangement;
    },
  );

  if (!updated) throw new Error("Arrangement not updated");
  return { output: formatArrangementUpdateResult(updated, format) };
}
