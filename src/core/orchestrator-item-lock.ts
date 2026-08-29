import { withProjectLock } from "./project-loader.js";
import type { ProjectState } from "./project-state.js";

/**
 * ISS-1077 (run 7, Amendment A1): the ONE place orchestrator-then-item lock
 * ordering is implemented -- every two-root arrangement operation (earmark
 * placement in `cli/commands/earmark.ts`, arrangement closure's node-earmark
 * retraction in `cli/commands/arrangement.ts`) goes through this, so the
 * order can never be duplicated-and-later-inverted at a second call site.
 *
 * Acquires the orchestrator lock ONCE and holds it for the ENTIRE
 * validate-then-mutate window. `itemRoots` are then acquired STRICTLY
 * SEQUENTIALLY -- one at a time, released before the next is acquired, never
 * two item locks held simultaneously -- so a single item root (earmark
 * placement) and N node roots (arrangement closure retracting earmarks
 * across several bound nodes) are the same code path. Because any
 * orchestrator-side arrangement write must also acquire the SAME
 * orchestrator lock, nothing can mutate the arrangement while it is held --
 * a single read taken at lock-acquisition time (by the caller, inside
 * `perItem`/`finalize`) is authoritative for the whole critical section, by
 * construction, not by convention. No second read is needed.
 *
 * `strict: true` on every lock, matching every existing earmark/arrangement
 * handler -- never weakened here.
 *
 * `lockFn` defaults to the real `withProjectLock` -- ordinary dependency
 * injection (Amendment A2), not a test-only branch: production code always
 * resolves to this same default, and a test can substitute an instrumented
 * wrapper (e.g. one that pauses mid-critical-section) to prove the lock is
 * genuinely held for the claimed window, without introducing any
 * conditional test-only code path into production.
 *
 * `preValidate` (added post-gate-1, codex round 1): runs under the
 * orchestrator lock BEFORE any item root is touched. `perItem` mutates each
 * item root as it goes and its locks are released sequentially as the loop
 * proceeds (never held simultaneously), so anything a caller's own
 * post-loop write could refuse (not-found, conflicted, a detected race) must
 * be checked in `preValidate` instead -- checking it only after the loop
 * would let an earlier `perItem` call's mutation commit and its lock release
 * BEFORE the later refusal, leaving that mutation stranded with no way to
 * undo it. `preValidate` does not eliminate every failure window (see
 * `beforeItems` below for the ordering choice that determines which
 * direction a remaining partial failure fails toward), but it removes the
 * far more likely failure modes (logical validation failing) from ever
 * reaching that window at all.
 *
 * `beforeItems` (added codex round 2, ISS-1077 continued): an OPTIONAL
 * async hook, also run under the orchestrator lock, after `preValidate` but
 * BEFORE the item-root loop -- for a caller whose own orchestrator-side
 * write should commit before the item-root sweep, not after. Whether to use
 * it is a per-caller choice: a caller with no meaningful ordering preference
 * (e.g. earmark placement, which touches exactly one item root and has no
 * separate orchestrator-side commit at all) simply omits it and keeps using
 * `finalize` as before. `handleArrangementUpdate`'s close path uses it
 * specifically because inverting that one ordering changes a partial
 * multi-root failure's fail-direction from fail-open (earmarks cleared,
 * arrangement still active -- protected work becomes selectable) to
 * fail-closed (arrangement closed, an earmark stranded -- a conservative
 * leak, recoverable via `earmark release`'s own stored-arrangementId
 * authority). Neither ordering eliminates partial-failure cleanup debt on
 * its own; `beforeItems` only lets a caller choose which side of that debt
 * it would rather carry. True atomic rollback across every root would still
 * need every item lock held simultaneously through the final write, a
 * larger change this hook does not attempt.
 *
 * `itemRoots` itself is a pre-lock input: every caller resolves node names to
 * physical roots BEFORE calling this function, since the roots have to be
 * known before there is anything to pass here to lock. A node's configured
 * PATH changing in that pre-lock window is a TOCTOU this function cannot see
 * or close on its own -- tracked as ISS-1085 alongside the same shape in
 * `detectNodeCollision`'s unlocked scan. `earmark.ts`'s
 * `assertNodeWritePermissionUnderLock` shows the narrower fix already applied
 * for one specific pre-lock check (the `allowNodeWrites` permission flag,
 * re-verified here via `preValidate` against state loaded under this lock);
 * generalizing that same pattern to the node PATH itself is the design work
 * ISS-1085 tracks.
 */
export async function withOrchestratorAndItemLocks<T>(
  orchestratorRoot: string,
  itemRoots: readonly string[],
  perItem: (orchestratorState: ProjectState, itemRoot: string, itemState: ProjectState) => Promise<void>,
  finalize: (orchestratorState: ProjectState) => Promise<T>,
  lockFn: typeof withProjectLock = withProjectLock,
  preValidate?: (orchestratorState: ProjectState) => void,
  beforeItems?: (orchestratorState: ProjectState) => Promise<void>,
): Promise<T> {
  const uniqueItemRoots = [...new Set(itemRoots)];
  let result!: T;
  await lockFn(orchestratorRoot, { strict: true }, async ({ state: orchestratorState }) => {
    preValidate?.(orchestratorState);
    // codex round-2 finding (T-478/ISS-1077 continued): `beforeItems` commits
    // orchestrator-side state (e.g. arrangement closure's own lifecycle
    // write) BEFORE the item-root sweep below, inverting round-1's
    // perItem-then-finalize order for callers where that ordering matters.
    // The fail direction this flips: with the write LAST (round 1), a
    // partial item-root failure left earmarks cleared but the arrangement
    // still "active" -- a fail-OPEN gap where work those earmarks protected
    // becomes selectable again even though the close nominally failed. With
    // the write FIRST, the same partial failure instead leaves the
    // arrangement closed but SOME item root's earmark still stranded --
    // fail-CLOSED (a conservative leak, not a lost protection), and cheap to
    // recover from a caller that already treats a stranded earmark as
    // release-by-its-own-stored-arrangementId (see `authorizeRelease` in
    // earmark.ts) rather than requiring the arrangement to still cover it.
    // This does not eliminate partial-failure cleanup debt -- it only
    // changes which side of "protected vs. exposed" that debt lands on.
    await beforeItems?.(orchestratorState);
    // codex round-2 finding: a configured node whose path resolves to the
    // SAME directory as the orchestrator (a self-alias) used to be handled
    // only when it was the SOLE item root (the old `length === 1 &&
    // uniqueItemRoots[0] === orchestratorRoot` special case). With that root
    // present ALONGSIDE any other, the loop below would try to `lockFn` the
    // orchestrator root a second time while the lock acquired just above is
    // still held -- not reentrant (a real O_EXCL file lock, not
    // AsyncLocalStorage-aware), so it would poll out to
    // DEFAULT_DEADLINE_MS and fail with io_error on every such close, a
    // guaranteed defect on a legal (if unusual) node configuration. Partition
    // the orchestrator root out UNCONDITIONALLY -- if present, `perItem` runs
    // for it directly here, using `orchestratorState` for both the
    // orchestrator and item state params (its state already IS the
    // orchestrator's own); only the remaining, genuinely distinct roots are
    // locked in the loop.
    if (uniqueItemRoots.includes(orchestratorRoot)) {
      await perItem(orchestratorState, orchestratorRoot, orchestratorState);
    }
    for (const itemRoot of uniqueItemRoots) {
      if (itemRoot === orchestratorRoot) continue;
      await lockFn(itemRoot, { strict: true }, async ({ state: itemState }) => {
        await perItem(orchestratorState, itemRoot, itemState);
      });
    }
    result = await finalize(orchestratorState);
  });
  return result;
}
