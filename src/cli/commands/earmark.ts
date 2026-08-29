import { withProjectLock, writeTicketUnlocked, writeIssueUnlocked } from "../../core/project-loader.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { isArrangementConflicted } from "../../core/arrangement-authority.js";
import { canPlaceEarmark, describeEarmarkHolder } from "../../core/earmarks.js";
import { arrangementCoversNodeItem } from "../../core/arrangement-bounds.js";
import { withOrchestratorAndItemLocks } from "../../core/orchestrator-item-lock.js";
import { resolveSessionSelector } from "../../autonomous/session-selector.js";
import { ownerTaskForCurrentClient } from "../../autonomous/client-profile.js";
import { formatEarmarkGetResult, formatEarmarkActionResult } from "../../core/output-formatter.js";
import {
  TICKET_ID_REGEX,
  TICKET_CANONICAL_ID_REGEX,
  ISSUE_ID_REGEX,
  ISSUE_CANONICAL_ID_REGEX,
  type Earmark,
  type EarmarkRole,
  type OutputFormat,
} from "../../models/types.js";
import type { Arrangement } from "../../models/arrangement.js";
import type { Ticket } from "../../models/ticket.js";
import type { Issue } from "../../models/issue.js";
import { CliValidationError, resolveCliNodeRoot } from "../helpers.js";
import { checkNodeWritePermission } from "../../mcp/node-resolution.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { ProjectState } from "../../core/project-state.js";

type EarmarkTarget = { kind: "ticket"; id: string } | { kind: "issue"; id: string };

/**
 * Resolves a ref (display-form or canonical) to the earmarkable item it
 * names -- ticket and issue ref patterns are syntactically disjoint, same
 * disambiguation `arrangement.ts`'s `resolveBoundRef` already relies on.
 */
function resolveEarmarkTarget(ref: string, state: ProjectState): EarmarkTarget {
  const isTicketRef = TICKET_ID_REGEX.test(ref) || TICKET_CANONICAL_ID_REGEX.test(ref);
  const isIssueRef = ISSUE_ID_REGEX.test(ref) || ISSUE_CANONICAL_ID_REGEX.test(ref);
  if (!isTicketRef && !isIssueRef) {
    throw new CliValidationError("invalid_input", `Ref "${ref}" is neither a ticket nor an issue reference`);
  }
  if (isTicketRef) {
    const result = state.resolveTicketRef(ref);
    if (result.kind === "missing") throw new CliValidationError("not_found", `Ticket ${ref} not found`);
    if (result.kind === "ambiguous") throw new CliValidationError("invalid_input", `Ticket ref "${ref}" is ambiguous`);
    return { kind: "ticket", id: result.item.id };
  }
  const result = state.resolveIssueRef(ref);
  if (result.kind === "missing") throw new CliValidationError("not_found", `Issue ${ref} not found`);
  if (result.kind === "ambiguous") throw new CliValidationError("invalid_input", `Issue ref "${ref}" is ambiguous`);
  return { kind: "issue", id: result.item.id };
}

function loadTargetItem(target: EarmarkTarget, state: ProjectState): (Ticket | Issue) & { earmark?: Earmark | null } {
  const item = target.kind === "ticket" ? state.ticketByID(target.id) : state.issues.find((i) => i.id === target.id);
  if (!item) throw new CliValidationError("not_found", `${target.kind === "ticket" ? "Ticket" : "Issue"} ${target.id} not found`);
  return item as (Ticket | Issue) & { earmark?: Earmark | null };
}

async function persistTarget(target: EarmarkTarget, item: unknown, root: string): Promise<void> {
  if (target.kind === "ticket") await writeTicketUnlocked(item as Ticket, root);
  else await writeIssueUnlocked(item as Issue, root);
}

/**
 * ISS-1077 ([R2-FIX 4]): does `a` cover `targetId`, given the caller's node
 * scope? Qualified-only when node-scoped -- a plain, orchestrator-local
 * bound sharing a canonical id string with a node-scoped target must NEVER
 * authorize a write against that node (it would authorize the wrong board).
 */
function boundsCover(a: Arrangement, nodeName: string | null, targetId: string): boolean {
  return nodeName ? arrangementCoversNodeItem(a, nodeName, targetId) : a.bounds.includes(targetId);
}

/**
 * `--arrangement`/`arrangement` is required whenever more than one active
 * arrangement covers the target item (round 3 finding: disambiguation was
 * required but callers had no way to supply it); with exactly one covering
 * arrangement it is inferred.
 *
 * Factored out from `resolveCoveringArrangement` (ISS-1077, [R2-FIX 4]) so
 * BOTH the single-root CLI path and the node-scoped cross-root path
 * (`handleEarmarkReserve`/`Assign`/`Release`'s node branch) share the exact
 * same selection logic and refusal messages, rather than two implementations
 * that could drift. `targetLabel` is the human-facing form used in error
 * messages -- the qualified `node:id` form when node-scoped, the plain id
 * otherwise.
 */
function selectCoveringArrangement(
  explicitId: string | undefined,
  arrangements: readonly Arrangement[],
  warnings: readonly string[],
  nodeName: string | null,
  targetId: string,
  targetLabel: string,
): Arrangement {
  if (explicitId) {
    const found = arrangements.find((a) => a.id === explicitId);
    if (!found) throw new CliValidationError("not_found", `Arrangement ${explicitId} not found`);
    if (isArrangementConflicted(found)) {
      throw new CliValidationError(
        "invalid_input",
        `Arrangement ${explicitId} has unresolved merge conflicts; resolve with "storybloq resolve ${explicitId}" before using it for earmarks`,
      );
    }
    // codex round-2 finding, surfaced while verifying a precondition for the
    // arrangement-close reordering candidate: the INFERRED path below already
    // excludes closed arrangements (`a.lifecycle !== "closed"`), but this
    // explicit-id path never checked lifecycle at all -- naming a CLOSED
    // arrangement whose bounds still textually cover the target would place
    // a new earmark under an authority that has already ended. Reserve/assign
    // both create NEW placements (unlike release, which resolves by the
    // earmark's own stored arrangementId and intentionally does not call this
    // function at all -- see `authorizeRelease`), so both legitimately need a
    // LIVE authorizing arrangement regardless of which path (inferred or
    // explicit) found it.
    if (found.lifecycle === "closed") {
      throw new CliValidationError(
        "invalid_input",
        `Arrangement ${explicitId} is closed and can no longer authorize new earmarks`,
      );
    }
    if (!boundsCover(found, nodeName, targetId)) {
      throw new CliValidationError("invalid_input", `Arrangement ${explicitId} does not cover ${targetLabel}`);
    }
    return found;
  }
  // codex round-2 finding (T-478): an incomplete scan (an unreadable or
  // schema-invalid arrangement file) silently OMITS that record from
  // `arrangements` -- it is not in `warnings`' place, it is simply absent.
  // The inferred path's whole safety argument is "reason about the FULL set
  // of arrangements that could cover targetId"; an omitted arrangement could
  // itself cover `targetId` and be conflicted or otherwise disputed, and
  // there is no way to rule that out from an incomplete scan. Mirrors
  // `resolveGateStatus` (gate-enforcement.ts): any scan warning makes the
  // whole result untrustworthy, checked before any per-arrangement logic.
  // `--arrangement` (the explicit-id path above) is unaffected: naming an
  // arrangement that itself loaded fine needs no completeness guarantee
  // about the REST of the directory.
  if (warnings.length > 0) {
    throw new CliValidationError(
      "invalid_input",
      `Arrangement scan incomplete (${warnings.join("; ")}); a hidden arrangement cannot be ruled out. Run "storybloq validate" for details, or pass --arrangement to name a specific, known-good arrangement explicitly.`,
    );
  }
  // T-478: conflicted arrangements are excluded FIRST, across the FULL list,
  // before either `lifecycle` or `bounds` is consulted for ANY arrangement --
  // a conflicted arrangement's retained `bounds`/`lifecycle` is precisely the
  // field that may be in dispute, so this cannot be trusted to decide whether
  // the arrangement even reaches the `covering` filter. If any conflicted
  // arrangement exists at all, the inferred path refuses outright (AM2: the
  // refusal names the specific conflicted ids) rather than attempting to
  // reason about which ones could plausibly cover `targetId` -- deliberately
  // more conservative than strictly necessary, but never authorizes on
  // disputed data. --arrangement remains available to name an unconflicted
  // arrangement explicitly.
  const conflicted = arrangements.filter((a) => isArrangementConflicted(a));
  if (conflicted.length > 0) {
    throw new CliValidationError(
      "invalid_input",
      `Arrangement(s) ${conflicted.map((a) => a.id).join(", ")} have unresolved merge conflicts; resolve them with "storybloq resolve" or pass --arrangement to name a specific, unconflicted arrangement explicitly`,
    );
  }
  const covering = arrangements.filter((a) => a.lifecycle !== "closed" && boundsCover(a, nodeName, targetId));
  if (covering.length === 0) {
    throw new CliValidationError("invalid_input", `No active arrangement covers ${targetLabel}; specify --arrangement`);
  }
  if (covering.length > 1) {
    throw new CliValidationError(
      "invalid_input",
      `Multiple active arrangements cover ${targetLabel} (${covering.map((a) => a.id).join(", ")}); specify --arrangement`,
    );
  }
  return covering[0]!;
}

function resolveCoveringArrangement(explicitId: string | undefined, targetId: string, root: string): Arrangement {
  const { arrangements, warnings } = loadArrangementsSafe(root);
  return selectCoveringArrangement(explicitId, arrangements, warnings, null, targetId, targetId);
}

function requireCallerIdentity(clientTaskId: string | undefined): { client: "claude" | "codex"; id: string } {
  const ownerTask = ownerTaskForCurrentClient(clientTaskId ?? null);
  if (!ownerTask) {
    throw new CliValidationError(
      "invalid_input",
      "Cannot resolve caller identity for this earmark action; run inside a supported client session or pass clientTaskId",
    );
  }
  return { client: ownerTask.client, id: ownerTask.id };
}

function sameActor(a: { client: string; id: string }, b: { client: string; id: string }): boolean {
  return a.client === b.client && a.id === b.id;
}

function isPenParty(arrangement: Arrangement, actor: { client: string; id: string }): boolean {
  return arrangement.parties.some((p) => p.role === "pen" && p.client === actor.client && p.identityAnchor === actor.id);
}

// --- Read handler ---

export function handleEarmarkGet(ref: string, ctx: CommandContext): CommandResult {
  // Resolution errors (bad shape, not found, ambiguous) propagate as thrown
  // CliValidationErrors -- both runReadCommand (CLI) and runMcpReadTool (MCP)
  // already catch and classify these uniformly, same as every other read
  // handler in this codebase (e.g. handleArrangementGet never catches
  // resolveBoundRef's throws itself either). Node routing (ISS-1077) is
  // handled by the caller resolving `ctx`'s root before this runs, exactly
  // like every other node-aware read tool -- this handler itself is
  // root-agnostic, same as it always was.
  const target = resolveEarmarkTarget(ref, ctx.state);
  const item = loadTargetItem(target, ctx.state);
  const earmark = item.earmark ?? null;
  return { output: formatEarmarkGetResult(ref, earmark, ctx.format) };
}

// --- Write handlers ---

/**
 * ISS-1077 ([R2-FIX 2], [R3-FIX 1/2/4]), fixed post-gate-1 (codex round 1):
 * resolves `nodeName` (when given) to an item root via `resolveCliNodeRoot`
 * -- the CLI's own node-resolution seam (Q1), used with `requireWrite: true`
 * since every caller of this function is a MUTATION. The original version
 * called `resolveNodeRoot` directly, which skips `checkNodeWritePermission`
 * entirely -- a real authorization bypass: `earmark reserve/assign/release
 * --node` could mutate a child board even with `federation.allowNodeWrites`
 * unset/false. `resolveEffectiveRootForWrite` (MCP-module-private, per Item
 * A's own MCP-only scoping) is still not reused here; `resolveCliNodeRoot` is
 * its CLI-side equivalent and already performs the same permission check.
 */
function resolveItemRootForNode(orchestratorRoot: string, nodeName: string | undefined): string {
  if (!nodeName) return orchestratorRoot;
  const resolved = resolveCliNodeRoot(orchestratorRoot, nodeName, true);
  if (!resolved.ok) {
    throw new CliValidationError(resolved.code, resolved.error);
  }
  return resolved.root;
}

/**
 * Codex round-1 finding (T-478 continued): `resolveItemRootForNode` above
 * (and the MCP layer's own pre-check in tools.ts) both verify
 * `federation.allowNodeWrites` UNLOCKED, before the orchestrator lock is even
 * acquired -- necessarily so, since the item root has to be known before
 * there's anything to lock. That leaves a window where a concurrent config
 * write could flip the flag off after the pre-check passes but before the
 * mutation actually lands. This re-checks the SAME flag against the
 * orchestrator config loaded UNDER the lock (`orchestratorState.config`,
 * fresh as of lock acquisition), immediately before the item mutation, as
 * this function's `preValidate` callback -- closing that gap for the
 * permission decision specifically. The node's configured PATH going stale in
 * that same pre-lock window is a broader, harder TOCTOU (the physical
 * directory resolved could itself change) deferred to ISS-1085 alongside
 * `detectNodeCollision`'s own unlocked scan-to-write race.
 */
function assertNodeWritePermissionUnderLock(
  orchestratorRoot: string,
  orchestratorState: ProjectState,
  nodeName: string | undefined,
): void {
  if (!nodeName) return;
  if (!checkNodeWritePermission(orchestratorRoot, orchestratorState.config as unknown as Record<string, unknown>)) {
    throw new CliValidationError(
      "invalid_input",
      "Node writes disabled. Set `federation.allowNodeWrites: true` in .story/config.json to enable cross-node writes from this orchestrator.",
    );
  }
}

export async function handleEarmarkReserve(
  args: { ref: string; role: EarmarkRole; arrangement?: string; clientTaskId?: string },
  format: OutputFormat,
  root: string,
  nodeName?: string,
): Promise<CommandResult> {
  const itemRoot = resolveItemRootForNode(root, nodeName);
  let placed: Earmark | undefined;
  let refusalHolder: Earmark | undefined;

  if (!nodeName) {
    // Single-root path, byte-identical to pre-ISS-1077 behavior.
    await withProjectLock(root, { strict: true }, async ({ state }) => {
      const target = resolveEarmarkTarget(args.ref, state);
      const arrangement = resolveCoveringArrangement(args.arrangement, target.id, root);
      const actor = requireCallerIdentity(args.clientTaskId);
      const item = loadTargetItem(target, state);

      const candidate: Earmark = {
        stage: "reserved",
        reservedBy: actor,
        arrangementId: arrangement.id,
        since: new Date().toISOString(),
        holderRole: args.role,
        holderSession: null,
      };
      const decision = canPlaceEarmark(item.earmark ?? null, item.status, candidate);
      if (!decision.ok) {
        refusalHolder = decision.holder;
        return;
      }
      const updated = { ...item, earmark: decision.earmark };
      await persistTarget(target, updated, root);
      placed = decision.earmark;
    });
  } else {
    // Node-scoped: arrangements always read at the orchestrator root (Q3);
    // the item lives, and is locked, at itemRoot. Orchestrator lock is held
    // for the whole window (R3-FIX 1) -- the single arrangement read is
    // authoritative for the entire critical section, no second read needed.
    await withOrchestratorAndItemLocks(
      root,
      [itemRoot],
      async (_orchestratorState, _itemRoot, itemState) => {
        const target = resolveEarmarkTarget(args.ref, itemState);
        const { arrangements, warnings } = loadArrangementsSafe(root);
        const arrangement = selectCoveringArrangement(args.arrangement, arrangements, warnings, nodeName, target.id, `${nodeName}:${target.id}`);
        const actor = requireCallerIdentity(args.clientTaskId);
        const item = loadTargetItem(target, itemState);

        const candidate: Earmark = {
          stage: "reserved",
          reservedBy: actor,
          arrangementId: arrangement.id,
          since: new Date().toISOString(),
          holderRole: args.role,
          holderSession: null,
        };
        const decision = canPlaceEarmark(item.earmark ?? null, item.status, candidate);
        if (!decision.ok) {
          refusalHolder = decision.holder;
          return;
        }
        const updated = { ...item, earmark: decision.earmark };
        await persistTarget(target, updated, itemRoot);
        placed = decision.earmark;
      },
      async () => {},
      undefined,
      (orchestratorState) => assertNodeWritePermissionUnderLock(root, orchestratorState, nodeName),
    );
  }

  if (refusalHolder) {
    throw new CliValidationError("conflict", `Cannot reserve ${args.ref}: held by ${describeEarmarkHolder(refusalHolder)}`);
  }
  if (!placed) throw new Error("Earmark not reserved");
  return { output: formatEarmarkActionResult("reserved", args.ref, placed, format) };
}

/**
 * Shared by both the single-root and node-scoped paths of
 * `handleEarmarkAssign` -- everything after the covering arrangement is
 * resolved is root-shape-agnostic given `sessionLookupRoot` (where the
 * assignee session's own `.story/sessions/` lives -- the item's own root:
 * the assignee is presumably a session working ON that board) and
 * `persistRoot` (where the target item itself is written).
 */
async function assignEarmark(
  args: { ref: string; to: string; role: EarmarkRole; arrangement?: string; clientTaskId?: string },
  state: ProjectState,
  arrangement: Arrangement,
  sessionLookupRoot: string,
  persistRoot: string,
  onRefusal: (holder: Earmark) => void,
): Promise<Earmark | undefined> {
  const target = resolveEarmarkTarget(args.ref, state);
  const actor = requireCallerIdentity(args.clientTaskId);
  const item = loadTargetItem(target, state);
  const existingEarmark = item.earmark ?? null;

  // Reserved -> assigned explicit CLI conversion is authorized for the
  // reserver's own identity or a pen-role party of the covering
  // arrangement; a fresh absent -> assigned placement is an ordinary CAS
  // placement by any resolved actor (same as `earmark reserve`).
  if (existingEarmark && existingEarmark.stage === "reserved") {
    const isReserver = sameActor(existingEarmark.reservedBy, actor);
    if (!isReserver && !isPenParty(arrangement, actor)) {
      throw new CliValidationError(
        "invalid_input",
        `Only the reserver or the "pen" party of arrangement ${arrangement.id} may convert this reservation`,
      );
    }
  }

  const sessionRes = resolveSessionSelector(sessionLookupRoot, args.to);
  if (sessionRes.kind !== "resolved" || sessionRes.corrupt || !sessionRes.state) {
    throw new CliValidationError("invalid_input", `--to "${args.to}" does not resolve to a readable, live session`);
  }
  const targetState = sessionRes.state;
  const now = Date.now();
  const live = targetState.status === "active" && !!targetState.lease && Date.parse(targetState.lease.expiresAt) > now;
  if (!live) {
    throw new CliValidationError("invalid_input", `Session ${sessionRes.sessionId} is not live`);
  }
  const targetOwner = targetState.ownerTask;
  if (!targetOwner) {
    throw new CliValidationError("invalid_input", `Session ${sessionRes.sessionId} has no resolvable identity`);
  }
  const roleMatches = arrangement.parties.some(
    (p) => p.role === args.role && p.client === targetOwner.client && p.identityAnchor === targetOwner.id,
  );
  if (!roleMatches) {
    throw new CliValidationError(
      "invalid_input",
      `Session ${sessionRes.sessionId} does not match a "${args.role}" party of arrangement ${arrangement.id}`,
    );
  }

  const candidate: Earmark = {
    stage: "assigned",
    reservedBy: existingEarmark && existingEarmark.stage === "reserved" ? existingEarmark.reservedBy : actor,
    arrangementId: arrangement.id,
    since: new Date().toISOString(),
    holderRole: args.role,
    holderSession: sessionRes.sessionId,
  };
  const decision = canPlaceEarmark(existingEarmark, item.status, candidate);
  if (!decision.ok) {
    onRefusal(decision.holder);
    return undefined;
  }
  const updated = { ...item, earmark: decision.earmark };
  await persistTarget(target, updated, persistRoot);
  return decision.earmark;
}

export async function handleEarmarkAssign(
  args: { ref: string; to: string; role: EarmarkRole; arrangement?: string; clientTaskId?: string },
  format: OutputFormat,
  root: string,
  nodeName?: string,
): Promise<CommandResult> {
  const itemRoot = resolveItemRootForNode(root, nodeName);
  let placed: Earmark | undefined;
  let refusalHolder: Earmark | undefined;

  if (!nodeName) {
    await withProjectLock(root, { strict: true }, async ({ state }) => {
      const target = resolveEarmarkTarget(args.ref, state);
      const arrangement = resolveCoveringArrangement(args.arrangement, target.id, root);
      placed = await assignEarmark(args, state, arrangement, root, root, (holder) => { refusalHolder = holder; });
    });
  } else {
    await withOrchestratorAndItemLocks(
      root,
      [itemRoot],
      async (_orchestratorState, _itemRoot, itemState) => {
        const target = resolveEarmarkTarget(args.ref, itemState);
        const { arrangements, warnings } = loadArrangementsSafe(root);
        const arrangement = selectCoveringArrangement(args.arrangement, arrangements, warnings, nodeName, target.id, `${nodeName}:${target.id}`);
        placed = await assignEarmark(args, itemState, arrangement, itemRoot, itemRoot, (holder) => { refusalHolder = holder; });
      },
      async () => {},
      undefined,
      (orchestratorState) => assertNodeWritePermissionUnderLock(root, orchestratorState, nodeName),
    );
  }

  if (refusalHolder) {
    throw new CliValidationError("conflict", `Cannot assign ${args.ref}: held by ${describeEarmarkHolder(refusalHolder)}`);
  }
  if (!placed) throw new Error("Earmark not assigned");
  return { output: formatEarmarkActionResult("assigned", args.ref, placed, format) };
}

/**
 * Codex round-2 fix (ISS-1084 continued): release, unlike reserve/assign,
 * REMOVES a hold rather than creating one -- its authority is the earmark's
 * OWN stored `arrangementId`, not whatever arrangement CURRENTLY covers the
 * item's bounds. Reserve/assign correctly require current bounds coverage
 * (they are placing a NEW hold and need a live, currently-authorizing
 * arrangement); requiring the same for release meant a bounds edit that
 * dropped the node/id entirely left a stranded earmark with no working
 * release path at all -- ISS-1084's stated manual-recovery mitigation was
 * false until this fix.
 *
 * The reserver releasing their OWN hold needs no arrangement lookup at all
 * (`earmark.reservedBy` was captured at reserve time and is independent of
 * the arrangement's current state -- self-release is inherently safe).
 * Only the pen-party override path resolves the earmark's own arrangement by
 * id and, following the same T-478 "never trust a conflicted arrangement's
 * authority" doctrine `resolveCoveringArrangement` already applies, refuses
 * if that specific arrangement cannot be found/loaded or is itself
 * conflicted -- its `parties` list is exactly the kind of field a conflict
 * can leave in dispute.
 *
 * `explicitArrangementId` (the CLI's optional `--arrangement`) is no longer
 * needed for disambiguation here (there is nothing to disambiguate -- the
 * earmark names exactly one authorizing arrangement), but a caller-supplied
 * value naming a DIFFERENT arrangement than the one actually authorizing
 * this earmark is a real caller error worth catching rather than silently
 * ignoring.
 */
function authorizeRelease(
  earmark: Earmark,
  actor: { client: string; id: string },
  explicitArrangementId: string | undefined,
  arrangements: readonly Arrangement[],
  warnings: readonly string[],
): void {
  if (explicitArrangementId && explicitArrangementId !== earmark.arrangementId) {
    throw new CliValidationError(
      "invalid_input",
      `--arrangement ${explicitArrangementId} does not match this earmark's authorizing arrangement (${earmark.arrangementId})`,
    );
  }
  if (sameActor(earmark.reservedBy, actor)) return;
  const arrangement = arrangements.find((a) => a.id === earmark.arrangementId);
  if (!arrangement) {
    const detail = warnings.length > 0 ? ` (arrangement scan warnings: ${warnings.join("; ")})` : "";
    throw new CliValidationError(
      "not_found",
      `Arrangement ${earmark.arrangementId} (which authorized this earmark) could not be loaded or no longer exists${detail}; only its original reserver may release it now`,
    );
  }
  if (isArrangementConflicted(arrangement)) {
    throw new CliValidationError(
      "invalid_input",
      `Arrangement ${arrangement.id} has unresolved merge conflicts; resolve with "storybloq resolve ${arrangement.id}" before using its "pen" party authority to release this earmark, or have the original reserver release it`,
    );
  }
  if (!isPenParty(arrangement, actor)) {
    throw new CliValidationError(
      "invalid_input",
      `Only the reserver or the "pen" party of arrangement ${arrangement.id} may release this earmark`,
    );
  }
}

export async function handleEarmarkRelease(
  args: { ref: string; arrangement?: string; clientTaskId?: string },
  format: OutputFormat,
  root: string,
  nodeName?: string,
): Promise<CommandResult> {
  const itemRoot = resolveItemRootForNode(root, nodeName);

  if (!nodeName) {
    await withProjectLock(root, { strict: true }, async ({ state }) => {
      const target = resolveEarmarkTarget(args.ref, state);
      const item = loadTargetItem(target, state);
      const earmark = item.earmark ?? null;
      if (!earmark) return; // no-op: nothing to release, idempotent

      const actor = requireCallerIdentity(args.clientTaskId);
      const { arrangements, warnings } = loadArrangementsSafe(root);
      authorizeRelease(earmark, actor, args.arrangement, arrangements, warnings);

      const updated = { ...item, earmark: null };
      await persistTarget(target, updated, root);
    });
  } else {
    await withOrchestratorAndItemLocks(
      root,
      [itemRoot],
      async (_orchestratorState, _itemRoot, itemState) => {
        const target = resolveEarmarkTarget(args.ref, itemState);
        const item = loadTargetItem(target, itemState);
        const earmark = item.earmark ?? null;
        if (!earmark) return; // no-op: nothing to release, idempotent

        const actor = requireCallerIdentity(args.clientTaskId);
        const { arrangements, warnings } = loadArrangementsSafe(root);
        authorizeRelease(earmark, actor, args.arrangement, arrangements, warnings);

        const updated = { ...item, earmark: null };
        await persistTarget(target, updated, itemRoot);
      },
      async () => {},
      undefined,
      (orchestratorState) => assertNodeWritePermissionUnderLock(root, orchestratorState, nodeName),
    );
  }

  return { output: formatEarmarkActionResult("released", args.ref, null, format) };
}
