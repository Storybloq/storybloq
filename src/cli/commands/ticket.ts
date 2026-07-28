import { displayIdOf } from "../../core/resolver.js";
import { nextTicket, nextTickets, blockedTickets } from "../../core/queries.js";
import { nextTicketID, nextOrder, allocateTeamTicketId } from "../../core/id-allocation.js";
import { reserveDisplayId } from "../../core/remote-refs.js";
import { resolveAndNormalizeTicketRef, RefResolutionError } from "../../core/ref-normalization.js";
import { clearClaimOnComplete, buildClaim, canClaim } from "../../core/claims.js";
import { validateProject } from "../../core/validation.js";
import { ProjectState } from "../../core/project-state.js";
import {
  withProjectLock,
  writeTicketUnlocked,
  deleteTicket,
} from "../../core/project-loader.js";
import {
  formatTicketList,
  formatTicket,
  formatNextTicketOutcome,
  formatNextTicketsOutcome,
  formatBlockedTickets,
  formatError,
  successEnvelope,
  ExitCode,
} from "../../core/output-formatter.js";
import {
  TICKET_STATUSES,
  TICKET_TYPES,
  type TicketStatus,
  type TicketType,
} from "../../models/types.js";
import type { Ticket } from "../../models/ticket.js";
import {
  todayISO,
  CliValidationError,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import {
  formatMetadataValue,
  getMetadata,
  setMetadata,
  unsetMetadata,
} from "./metadata.js";

// Re-export for register.ts
export { TICKET_STATUSES, TICKET_TYPES };

const TICKET_CORE_METADATA_KEYS = new Set([
  "id",
  "title",
  "description",
  "type",
  "status",
  "phase",
  "order",
  "createdDate",
  "completedDate",
  "blockedBy",
  "crossNodeBlockedBy",
  "parentTicket",
  "createdBy",
  "assignedTo",
  "lastModifiedBy",
  "claimedBySession",
  "displayId",
  "previousDisplayIds",
  "rank",
  "lifecycle",
  "claim",
  "_conflicts",
  "createdAt",
  "deletedAt",
  "deletedBy",
]);

// --- Read Handlers ---

export function handleTicketList(
  filters: { status?: string; phase?: string; type?: string },
  ctx: CommandContext,
): CommandResult {
  let tickets = [...ctx.state.leafTickets];

  if (filters.status) {
    if (!TICKET_STATUSES.includes(filters.status as TicketStatus)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown ticket status "${filters.status}": must be one of ${TICKET_STATUSES.join(", ")}`,
      );
    }
    tickets = tickets.filter((t) => t.status === filters.status);
  }
  if (filters.phase) {
    tickets = tickets.filter((t) => t.phase === filters.phase);
  }
  if (filters.type) {
    if (!TICKET_TYPES.includes(filters.type as TicketType)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown ticket type "${filters.type}": must be one of ${TICKET_TYPES.join(", ")}`,
      );
    }
    tickets = tickets.filter((t) => t.type === filters.type);
  }

  return { output: formatTicketList(tickets, ctx.format) };
}

export function handleTicketGet(
  id: string,
  ctx: CommandContext,
): CommandResult {
  const result = ctx.state.resolveTicketRef(id);
  if (result.kind === "ambiguous") {
    const ids = result.matches.map((m) => m.id).join(", ");
    return {
      output: formatError("invalid_input", `Ref "${id}" is ambiguous (matches: ${ids})`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "invalid_input",
    };
  }
  if (result.kind === "missing") {
    return {
      output: formatError("not_found", `Ticket ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatTicket(result.item, ctx.state, ctx.format) };
}

export function handleTicketMetaGet(
  id: string,
  path: string | undefined,
  ctx: CommandContext,
): CommandResult {
  const resolved = ctx.state.resolveTicketRef(id);
  if (resolved.kind === "ambiguous") {
    const ids = resolved.matches.map((m) => m.id).join(", ");
    return {
      output: formatError("invalid_input", `Ref "${id}" is ambiguous (matches: ${ids})`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "invalid_input",
    };
  }
  if (resolved.kind !== "found") {
    return {
      output: formatError("not_found", `Ticket ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  const ticket = resolved.item;
  const result = getMetadata(ticket as Record<string, unknown>, path, TICKET_CORE_METADATA_KEYS);
  if (!result.found) {
    return {
      output: formatError("not_found", `Metadata path "${path}" not found on ticket ${id}`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatMetadataValue(result.value, ctx.format) };
}

export function handleTicketNext(ctx: CommandContext, count: number = 1): CommandResult {
  if (count <= 1) {
    // Existing path — unchanged behavior, uses nextTicket (early-stop at blocked phase)
    const outcome = nextTicket(ctx.state);
    const exitCode = outcome.kind === "found" ? ExitCode.OK : ExitCode.USER_ERROR;
    return { output: formatNextTicketOutcome(outcome, ctx.state, ctx.format), exitCode };
  }
  // Multi-candidate path — continues across blocked phases
  const outcome = nextTickets(ctx.state, count);
  const exitCode = outcome.kind === "found" ? ExitCode.OK : ExitCode.USER_ERROR;
  return { output: formatNextTicketsOutcome(outcome, ctx.state, ctx.format), exitCode };
}

export function handleTicketBlocked(ctx: CommandContext): CommandResult {
  const blocked = blockedTickets(ctx.state);
  return { output: formatBlockedTickets(blocked, ctx.state, ctx.format) };
}

// --- Write Handlers ---

function validatePhase(phase: string | null, ctx: { state: ProjectState }): void {
  if (phase !== null && !ctx.state.roadmap.phases.some((p) => p.id === phase)) {
    throw new CliValidationError("invalid_input", `Phase "${phase}" not found in roadmap`);
  }
}

function rethrowResolutionError(err: unknown, fallbackMsg: string): never {
  if (err instanceof RefResolutionError) {
    const code = err.reason === "ambiguous" ? "invalid_input" : "not_found";
    throw new CliValidationError(code, err.message);
  }
  throw new CliValidationError("not_found", err instanceof Error ? err.message : fallbackMsg);
}

function validateAndResolveBlockedBy(ids: string[], ticketId: string, state: ProjectState): string[] {
  const resolved: string[] = [];
  for (const bid of ids) {
    let resolvedId: string;
    try {
      resolvedId = resolveAndNormalizeTicketRef(state, bid);
    } catch (err) {
      rethrowResolutionError(err, `Blocked-by ticket ${bid} not found`);
    }
    if (resolvedId === ticketId) {
      throw new CliValidationError("invalid_input", `Ticket cannot block itself: ${bid}`);
    }
    if (state.umbrellaIDs.has(resolvedId)) {
      throw new CliValidationError("invalid_input", `Cannot block on umbrella ticket ${bid}. Use leaf tickets instead.`);
    }
    resolved.push(resolvedId);
  }
  return resolved;
}

function validateAndResolveParentTicket(parentId: string, ticketId: string, state: ProjectState): string {
  let resolvedId: string;
  try {
    resolvedId = resolveAndNormalizeTicketRef(state, parentId);
  } catch (err) {
    rethrowResolutionError(err, `Parent ticket ${parentId} not found`);
  }
  if (resolvedId === ticketId) {
    throw new CliValidationError("invalid_input", `Ticket cannot be its own parent`);
  }
  return resolvedId;
}

/** Build a multiset of error findings keyed by code|entity|message, with message lookup. */
function buildErrorMultiset(findings: readonly { level: string; code: string; entity: string | null; message: string }[]): { counts: Map<string, number>; messages: Map<string, string> } {
  const counts = new Map<string, number>();
  const messages = new Map<string, string>();
  for (const f of findings) {
    if (f.level !== "error") continue;
    const key = `${f.code}|${f.entity ?? ""}|${f.message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    messages.set(key, f.message);
  }
  return { counts, messages };
}

/** ISS-065: Only block writes that make the project WORSE. Pre-existing errors pass through. */
function validatePostWriteState(
  candidate: Ticket,
  state: ProjectState,
  isCreate: boolean,
): void {
  // Pre-write validation (current state)
  const preResult = validateProject(state);
  const { counts: preErrors } = buildErrorMultiset(preResult.findings);

  // Post-write validation (state with candidate applied)
  const existingTickets = [...state.tickets];
  if (isCreate) {
    existingTickets.push(candidate);
  } else {
    const idx = existingTickets.findIndex((t) => t.id === candidate.id);
    if (idx >= 0) existingTickets[idx] = candidate;
    else existingTickets.push(candidate);
  }
  const postState = new ProjectState({
    tickets: existingTickets,
    issues: [...state.issues],
    notes: [...state.notes],
    roadmap: state.roadmap,
    config: state.config,
    handoverFilenames: [...state.handoverFilenames],
  });
  const postResult = validateProject(postState);
  const { counts: postErrors, messages: postMessages } = buildErrorMultiset(postResult.findings);

  // Block only if new errors were introduced (post count > pre count)
  const newErrors: string[] = [];
  for (const [key, postCount] of postErrors) {
    const preCount = preErrors.get(key) ?? 0;
    if (postCount > preCount) {
      newErrors.push(postMessages.get(key) ?? key);
    }
  }
  if (newErrors.length > 0) {
    throw new CliValidationError("validation_failed", `Write would create invalid state: ${newErrors.join("; ")}`);
  }
}

export async function handleTicketCreate(
  args: {
    title: string;
    type: string;
    phase: string | null;
    description: string;
    blockedBy: string[];
    parentTicket: string | null;
  },
  format: string,
  root: string,
): Promise<CommandResult> {
  if (!TICKET_TYPES.includes(args.type as TicketType)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown ticket type "${args.type}": must be one of ${TICKET_TYPES.join(", ")}`,
    );
  }

  let createdTicket: Ticket | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    validatePhase(args.phase, { state });
    const resolvedBlockedBy = args.blockedBy.length > 0
      ? validateAndResolveBlockedBy(args.blockedBy, "", state)
      : [];
    const resolvedParent = args.parentTicket
      ? validateAndResolveParentTicket(args.parentTicket, "", state)
      : undefined;

    const isTeam = state.config.team?.enabled === true;
    let id: string;
    let displayId: string | undefined;
    if (isTeam) {
      const alloc = allocateTeamTicketId(state.tickets);
      id = alloc.id;
      displayId = state.config.team?.idAllocator === "git-refs"
        ? (await reserveDisplayId(root, "ticket", state, id)).displayId
        : alloc.displayId;
    } else {
      id = nextTicketID(state.tickets);
      displayId = undefined;
    }
    const order = nextOrder(args.phase, state);
    const createdAt = new Date().toISOString();
    const ticket: Ticket = {
      id,
      ...(displayId != null && { displayId }),
      title: args.title,
      description: args.description,
      type: args.type as TicketType,
      status: "open",
      phase: args.phase,
      order,
      createdDate: createdAt.slice(0, 10),
      ...(isTeam && { createdAt }),
      completedDate: null,
      blockedBy: resolvedBlockedBy,
      parentTicket: resolvedParent,
    };

    validatePostWriteState(ticket, state, true);
    await writeTicketUnlocked(ticket, root, { createOnly: true });
    createdTicket = ticket;
  });

  if (!createdTicket) throw new Error("Ticket not created");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(createdTicket), null, 2) };
  }
  return { output: `Created ticket ${displayIdOf(createdTicket)}: ${createdTicket.title}` };
}

export async function handleTicketUpdate(
  id: string,
  updates: {
    status?: string;
    title?: string;
    type?: string;
    phase?: string | null;
    order?: number;
    description?: string;
    blockedBy?: string[];
    crossNodeBlockedBy?: string[] | null;
    parentTicket?: string | null;
  },
  format: string,
  root: string,
): Promise<CommandResult> {
  if (updates.status && !TICKET_STATUSES.includes(updates.status as TicketStatus)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown ticket status "${updates.status}": must be one of ${TICKET_STATUSES.join(", ")}`,
    );
  }
  if (updates.type !== undefined && !TICKET_TYPES.includes(updates.type as TicketType)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown ticket type "${updates.type}": must be one of ${TICKET_TYPES.join(", ")}`,
    );
  }

  let updatedTicket: Ticket | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    let resolvedId: string;
    try {
      resolvedId = resolveAndNormalizeTicketRef(state, id);
    } catch (err) {
      rethrowResolutionError(err, `Ticket ${id} not found`);
    }
    const existing = state.ticketByID(resolvedId);
    if (!existing) {
      throw new CliValidationError("not_found", `Ticket ${id} not found`);
    }

    if (updates.phase !== undefined) {
      validatePhase(updates.phase, { state });
    }
    const resolvedBlockedBy = updates.blockedBy
      ? validateAndResolveBlockedBy(updates.blockedBy, resolvedId, state)
      : undefined;
    const resolvedParent = updates.parentTicket
      ? validateAndResolveParentTicket(updates.parentTicket, resolvedId, state)
      : updates.parentTicket;

    // Status transition with date management
    const statusChanges: Partial<Ticket> = {};
    if (updates.status !== undefined && updates.status !== existing.status) {
      statusChanges.status = updates.status as TicketStatus;
      if (updates.status === "complete" && existing.status !== "complete") {
        statusChanges.completedDate = todayISO();
      } else if (updates.status !== "complete" && existing.status === "complete") {
        statusChanges.completedDate = null;
      }
    }

    const ticket: Ticket = {
      ...existing,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.type !== undefined && { type: updates.type as TicketType }),
      ...(updates.description !== undefined && { description: updates.description }),
      ...(updates.phase !== undefined && { phase: updates.phase }),
      ...(updates.order !== undefined && { order: updates.order }),
      ...(resolvedBlockedBy !== undefined && { blockedBy: resolvedBlockedBy }),
      ...(updates.crossNodeBlockedBy !== undefined && { crossNodeBlockedBy: updates.crossNodeBlockedBy ?? undefined }),
      ...(updates.parentTicket !== undefined && { parentTicket: resolvedParent }),
      ...statusChanges,
    };

    const finalTicket = clearClaimOnComplete(ticket);
    validatePostWriteState(finalTicket, state, false);
    await writeTicketUnlocked(finalTicket, root);
    updatedTicket = finalTicket;
  });

  if (!updatedTicket) throw new Error("Ticket not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedTicket), null, 2) };
  }
  return { output: `Updated ticket ${displayIdOf(updatedTicket)}: ${updatedTicket.title}` };
}

export async function handleTicketMetaSet(
  id: string,
  path: string,
  value: unknown,
  format: string,
  root: string,
): Promise<CommandResult> {
  let updatedTicket: Ticket | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    let resolvedId: string;
    try {
      resolvedId = resolveAndNormalizeTicketRef(state, id);
    } catch (err) {
      rethrowResolutionError(err, `Ticket ${id} not found`);
    }
    const existing = state.ticketByID(resolvedId);
    if (!existing) {
      throw new CliValidationError("not_found", `Ticket ${id} not found`);
    }
    const ticket = setMetadata(
      existing as Record<string, unknown>,
      path,
      value,
      TICKET_CORE_METADATA_KEYS,
    ) as Ticket;
    validatePostWriteState(ticket, state, false);
    await writeTicketUnlocked(ticket, root);
    updatedTicket = ticket;
  });

  if (!updatedTicket) throw new Error("Ticket metadata not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedTicket), null, 2) };
  }
  return { output: `Updated metadata ${path} on ticket ${displayIdOf(updatedTicket)}` };
}

export async function handleTicketMetaUnset(
  id: string,
  path: string,
  format: string,
  root: string,
): Promise<CommandResult> {
  let updatedTicket: Ticket | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    let resolvedId: string;
    try {
      resolvedId = resolveAndNormalizeTicketRef(state, id);
    } catch (err) {
      rethrowResolutionError(err, `Ticket ${id} not found`);
    }
    const existing = state.ticketByID(resolvedId);
    if (!existing) {
      throw new CliValidationError("not_found", `Ticket ${id} not found`);
    }
    const ticket = unsetMetadata(
      existing as Record<string, unknown>,
      path,
      TICKET_CORE_METADATA_KEYS,
    ) as Ticket;
    validatePostWriteState(ticket, state, false);
    await writeTicketUnlocked(ticket, root);
    updatedTicket = ticket;
  });

  if (!updatedTicket) throw new Error("Ticket metadata not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedTicket), null, 2) };
  }
  return { output: `Unset metadata ${path} on ticket ${displayIdOf(updatedTicket)}` };
}

export async function handleTicketDelete(
  id: string,
  force: boolean,
  format: string,
  root: string,
  hard?: boolean,
  displayLabel?: string,
): Promise<CommandResult> {
  if (force) {
    process.stderr.write(
      `Warning: force-deleting ${id} may leave dangling references. Run \`storybloq validate\` to check.\n`,
    );
  }
  const result = await deleteTicket(id, root, { force, hard });
  // ISS-757: team-mode re-delete of a tombstoned ticket is a silent success
  // (exit 0) that preserves the existing tombstone; surface it distinctly.
  if (result.alreadyDeleted) {
    if (format === "json") {
      return { output: JSON.stringify(successEnvelope({ id, deleted: true, alreadyDeleted: true }), null, 2) };
    }
    return { output: `Ticket ${displayLabel ?? id} is already deleted; existing tombstone preserved.` };
  }
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope({ id, deleted: true }), null, 2) };
  }
  return { output: `Deleted ticket ${displayLabel ?? id}.` };
}

export async function handleTicketUnclaim(
  id: string,
  format: string,
  root: string,
): Promise<CommandResult> {
  let updatedTicket: Ticket | undefined;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const resolvedId = resolveAndNormalizeTicketRef(state, id);
    const existing = state.ticketByID(resolvedId);
    if (!existing) throw new CliValidationError("not_found", `Ticket ${id} not found`);
    if (!existing.claim && !(existing as Record<string, unknown>).claimedBySession) {
      updatedTicket = existing;
      return;
    }
    const ticket: Ticket = { ...existing, claim: undefined } as unknown as Ticket;
    (ticket as Record<string, unknown>).claimedBySession = undefined;
    await writeTicketUnlocked(ticket, root);
    updatedTicket = ticket;
  });
  if (!updatedTicket) throw new Error("Ticket not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedTicket), null, 2) };
  }
  return { output: `Unclaimed ticket ${(updatedTicket as Record<string, unknown>).displayId as string | undefined ?? updatedTicket.id}` };
}

export async function handleTicketStart(
  id: string,
  format: string,
  root: string,
  force?: boolean,
): Promise<CommandResult> {
  let updatedTicket: Ticket | undefined;
  let claimWarning: string | undefined;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const resolvedId = resolveAndNormalizeTicketRef(state, id);
    const existing = state.ticketByID(resolvedId);
    if (!existing) throw new CliValidationError("not_found", `Ticket ${id} not found`);
    if (existing.status === "complete") {
      throw new CliValidationError("invalid_input", `Ticket ${id} is already complete`);
    }

    let email: string | undefined;
    let branch = "unknown";
    try {
      const { gitUserEmail, gitHead } = await import("../../autonomous/git-inspector.js");
      email = await gitUserEmail(root) ?? undefined;
      const head = await gitHead(root);
      if (head.ok && head.data.branch) branch = head.data.branch;
    } catch { /* git not available */ }

    if (existing.claim && email) {
      const check = canClaim(existing, email, branch, force);
      if (!check.allowed) {
        // N-059 decision #22: claims are advisory (latest-wins auto-merge) and
        // must never hard-block. A foreign claim warns and proceeds, taking over
        // the claim, rather than throwing. `--force` suppresses the warning.
        const displayId = (existing as Record<string, unknown>).displayId as string | undefined ?? existing.id;
        claimWarning = `Warning: ticket ${displayId} is claimed by ${check.claimedBy}; claims are advisory, starting anyway and taking over the claim (pass --force to suppress this warning).`;
      }
    }

    const claim = email ? buildClaim(email, branch, new Date().toISOString()) : undefined;
    const ticket: Ticket = {
      ...existing,
      status: "inprogress" as TicketStatus,
      ...(claim ? { claim } : {}),
    };
    validatePostWriteState(ticket, state, false);
    await writeTicketUnlocked(ticket, root);
    updatedTicket = ticket;
  });
  if (!updatedTicket) throw new Error("Ticket not updated");
  if (claimWarning) process.stderr.write(claimWarning + "\n");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedTicket), null, 2) };
  }
  return { output: `Started ticket ${(updatedTicket as Record<string, unknown>).displayId as string | undefined ?? updatedTicket.id}: ${updatedTicket.title}` };
}
