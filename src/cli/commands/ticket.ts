import { nextTicket, nextTickets, blockedTickets } from "../../core/queries.js";
import { nextTicketID, nextOrder } from "../../core/id-allocation.js";
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
  normalizeArrayOption,
  CliValidationError,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

// Re-export for register.ts
export { TICKET_STATUSES, TICKET_TYPES };

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
  const ticket = ctx.state.ticketByID(id);
  if (!ticket) {
    return {
      output: formatError("not_found", `Ticket ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatTicket(ticket, ctx.state, ctx.format) };
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

function validateBlockedBy(ids: string[], ticketId: string, state: ProjectState): void {
  for (const bid of ids) {
    if (bid === ticketId) {
      throw new CliValidationError("invalid_input", `Ticket cannot block itself: ${bid}`);
    }
    const blocker = state.ticketByID(bid);
    if (!blocker) {
      throw new CliValidationError("invalid_input", `Blocked-by ticket ${bid} not found`);
    }
    if (state.umbrellaIDs.has(bid)) {
      throw new CliValidationError("invalid_input", `Cannot block on umbrella ticket ${bid}. Use leaf tickets instead.`);
    }
  }
}

function validateParentTicket(parentId: string, ticketId: string, state: ProjectState): void {
  if (parentId === ticketId) {
    throw new CliValidationError("invalid_input", `Ticket cannot be its own parent`);
  }
  if (!state.ticketByID(parentId)) {
    throw new CliValidationError("invalid_input", `Parent ticket ${parentId} not found`);
  }
}

function validatePostWriteState(
  candidate: Ticket,
  state: ProjectState,
  isCreate: boolean,
): void {
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
  const result = validateProject(postState);
  if (!result.valid) {
    const errors = result.findings.filter((f) => f.level === "error");
    const msg = errors.map((f) => f.message).join("; ");
    throw new CliValidationError("validation_failed", `Write would create invalid state: ${msg}`);
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
    if (args.blockedBy.length > 0) {
      validateBlockedBy(args.blockedBy, "", state);
    }
    if (args.parentTicket) {
      validateParentTicket(args.parentTicket, "", state);
    }

    const id = nextTicketID(state.tickets);
    const order = nextOrder(args.phase, state);
    const ticket: Ticket = {
      id,
      title: args.title,
      description: args.description,
      type: args.type as TicketType,
      status: "open",
      phase: args.phase,
      order,
      createdDate: todayISO(),
      completedDate: null,
      blockedBy: args.blockedBy,
      parentTicket: args.parentTicket ?? undefined,
    };

    validatePostWriteState(ticket, state, true);
    await writeTicketUnlocked(ticket, root);
    createdTicket = ticket;
  });

  if (!createdTicket) throw new Error("Ticket not created");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(createdTicket), null, 2) };
  }
  return { output: `Created ticket ${createdTicket.id}: ${createdTicket.title}` };
}

export async function handleTicketUpdate(
  id: string,
  updates: {
    status?: string;
    title?: string;
    phase?: string | null;
    order?: number;
    description?: string;
    blockedBy?: string[];
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

  let updatedTicket: Ticket | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const existing = state.ticketByID(id);
    if (!existing) {
      throw new CliValidationError("not_found", `Ticket ${id} not found`);
    }

    if (updates.phase !== undefined) {
      validatePhase(updates.phase, { state });
    }
    if (updates.blockedBy) {
      validateBlockedBy(updates.blockedBy, id, state);
    }
    if (updates.parentTicket) {
      validateParentTicket(updates.parentTicket, id, state);
    }

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
      ...(updates.description !== undefined && { description: updates.description }),
      ...(updates.phase !== undefined && { phase: updates.phase }),
      ...(updates.order !== undefined && { order: updates.order }),
      ...(updates.blockedBy !== undefined && { blockedBy: updates.blockedBy }),
      ...(updates.parentTicket !== undefined && { parentTicket: updates.parentTicket }),
      ...statusChanges,
    };

    validatePostWriteState(ticket, state, false);
    await writeTicketUnlocked(ticket, root);
    updatedTicket = ticket;
  });

  if (!updatedTicket) throw new Error("Ticket not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedTicket), null, 2) };
  }
  return { output: `Updated ticket ${updatedTicket.id}: ${updatedTicket.title}` };
}

export async function handleTicketDelete(
  id: string,
  force: boolean,
  format: string,
  root: string,
): Promise<CommandResult> {
  if (force) {
    process.stderr.write(
      `Warning: force-deleting ${id} may leave dangling references. Run \`claudestory validate\` to check.\n`,
    );
  }
  await deleteTicket(id, root, { force });
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope({ id, deleted: true }), null, 2) };
  }
  return { output: `Deleted ticket ${id}.` };
}
