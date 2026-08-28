import { withProjectLock, writeTicketUnlocked, writeIssueUnlocked } from "../../core/project-loader.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { canPlaceEarmark, describeEarmarkHolder } from "../../core/earmarks.js";
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
import { CliValidationError } from "../helpers.js";
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
 * `--arrangement`/`arrangement` is required whenever more than one active
 * arrangement covers the target item (round 3 finding: disambiguation was
 * required but callers had no way to supply it); with exactly one covering
 * arrangement it is inferred.
 */
function resolveCoveringArrangement(explicitId: string | undefined, targetId: string, root: string): Arrangement {
  const { arrangements } = loadArrangementsSafe(root);
  const covering = arrangements.filter((a) => a.lifecycle !== "closed" && a.bounds.includes(targetId));
  if (explicitId) {
    const found = arrangements.find((a) => a.id === explicitId);
    if (!found) throw new CliValidationError("not_found", `Arrangement ${explicitId} not found`);
    if (!found.bounds.includes(targetId)) {
      throw new CliValidationError("invalid_input", `Arrangement ${explicitId} does not cover ${targetId}`);
    }
    return found;
  }
  if (covering.length === 0) {
    throw new CliValidationError("invalid_input", `No active arrangement covers ${targetId}; specify --arrangement`);
  }
  if (covering.length > 1) {
    throw new CliValidationError(
      "invalid_input",
      `Multiple active arrangements cover ${targetId} (${covering.map((a) => a.id).join(", ")}); specify --arrangement`,
    );
  }
  return covering[0]!;
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
  // resolveBoundRef's throws itself either).
  const target = resolveEarmarkTarget(ref, ctx.state);
  const item = loadTargetItem(target, ctx.state);
  const earmark = item.earmark ?? null;
  return { output: formatEarmarkGetResult(ref, earmark, ctx.format) };
}

// --- Write handlers ---

export async function handleEarmarkReserve(
  args: { ref: string; role: EarmarkRole; arrangement?: string; clientTaskId?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  let placed: Earmark | undefined;
  let refusalHolder: Earmark | undefined;

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

  if (refusalHolder) {
    throw new CliValidationError("conflict", `Cannot reserve ${args.ref}: held by ${describeEarmarkHolder(refusalHolder)}`);
  }
  if (!placed) throw new Error("Earmark not reserved");
  return { output: formatEarmarkActionResult("reserved", args.ref, placed, format) };
}

export async function handleEarmarkAssign(
  args: { ref: string; to: string; role: EarmarkRole; arrangement?: string; clientTaskId?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  let placed: Earmark | undefined;
  let refusalHolder: Earmark | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const target = resolveEarmarkTarget(args.ref, state);
    const arrangement = resolveCoveringArrangement(args.arrangement, target.id, root);
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

    const sessionRes = resolveSessionSelector(root, args.to);
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
      refusalHolder = decision.holder;
      return;
    }
    const updated = { ...item, earmark: decision.earmark };
    await persistTarget(target, updated, root);
    placed = decision.earmark;
  });

  if (refusalHolder) {
    throw new CliValidationError("conflict", `Cannot assign ${args.ref}: held by ${describeEarmarkHolder(refusalHolder)}`);
  }
  if (!placed) throw new Error("Earmark not assigned");
  return { output: formatEarmarkActionResult("assigned", args.ref, placed, format) };
}

export async function handleEarmarkRelease(
  args: { ref: string; arrangement?: string; clientTaskId?: string },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const target = resolveEarmarkTarget(args.ref, state);
    const item = loadTargetItem(target, state);
    const earmark = item.earmark ?? null;
    if (!earmark) return; // no-op: nothing to release, idempotent

    const arrangement = resolveCoveringArrangement(args.arrangement, target.id, root);
    const actor = requireCallerIdentity(args.clientTaskId);
    const isReserver = sameActor(earmark.reservedBy, actor);
    if (!isReserver && !isPenParty(arrangement, actor)) {
      throw new CliValidationError(
        "invalid_input",
        `Only the reserver or the "pen" party of arrangement ${arrangement.id} may release this earmark`,
      );
    }

    const updated = { ...item, earmark: null };
    await persistTarget(target, updated, root);
  });

  return { output: formatEarmarkActionResult("released", args.ref, null, format) };
}
