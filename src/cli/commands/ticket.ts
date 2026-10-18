import { displayIdOf } from "../../core/resolver.js";
import { nextTicket, nextTickets, blockedTickets, currentPhase, waitingInventory } from "../../core/queries.js";
import { nextTicketID, nextOrder, allocateTeamTicketId } from "../../core/id-allocation.js";
import { reserveDisplayId } from "../../core/remote-refs.js";
import { checkBranchAllocationWarning } from "../../core/branch-allocation-warning.js";
import { resolveAndNormalizeTicketRef, RefResolutionError } from "../../core/ref-normalization.js";
import {
  clearClaimOnComplete,
  guardCompletedTicketMutation,
  hasClaimMaterial,
  buildClaim,
  canClaim,
  type CompletionGuardOptions,
} from "../../core/claims.js";
import { clearSameSessionEarmark } from "../../core/earmarks.js";
import { collectCompletionOwnership, CompletionOwnershipUnavailable } from "../../core/status-authority.js";
import { validateProject } from "../../core/validation.js";
import { assertCheckpointEligible, completeDependent, describeCheckpointBlock, describeIneligible, evidenceFor } from "../../core/checkpoint-evidence.js";
import { checkpointState, hasOwnerCheckpoint, pendingCheckpointBlockers } from "../../core/owner-checkpoint.js";
import { assertWithdrawable } from "../../core/ticket-withdrawal.js";
import { ticketJsonBody } from "../../core/resolution-kind.js";
import { ProjectState } from "../../core/project-state.js";
import { loadCitationContext } from "../../core/ruling-loader.js";
import { citationMapFor, resolveEntityCitations, resolveCitesRulingsInput } from "../../core/ruling.js";
import { computeTargetedActionability } from "../../core/classification-context.js";
import { readFederationCache } from "../../federation/cache.js";
import { crossNodeStatusRecord, observeProject } from "../../federation/cross-node-observation.js";
import { join } from "node:path";
import {
  withProjectLock,
  writeTicketUnlocked,
  deleteTicket,
  sortKeysDeep,
} from "../../core/project-loader.js";
import {
  formatTicketList,
  formatTicket,
  formatNextTicketOutcome,
  formatNextTicketsOutcome,
  formatWaitingSummary,
  formatBlockedTickets,
  formatError,
  successEnvelope,
  ExitCode,
  stripRenderFence,
} from "../../core/output-formatter.js";
import {
  TICKET_STATUSES,
  TICKET_TYPES,
  effectivePriority,
  effectiveWaitingOn,
  type Priority,
  type TicketStatus,
  type TicketType,
  type WaitingOn,
} from "../../models/types.js";
import type { Ticket } from "../../models/ticket.js";
import type { UpdateWriteHooks } from "../../core/update-write-hooks.js";
import type { TicketUpdateInput } from "../../core/update-inputs.js";
import {
  todayISO,
  CliValidationError,
  assertUpdateHasFields,
  parsePriority,
  parseWaitingOn,
  withPriorityFields,
} from "../helpers.js";
import { localDateOf } from "../../core/local-date.js";
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
  "citesRulings",
  // T-537: protected; written only by the checkpoint lifecycle and evidence writers.
  "ownerCheckpoint",
  "checkpointEvidence",
  // T-486 U2: the withdrawal kind, and the response keys the JSON surfaces derive.
  "resolutionKind",
  "effective",
  "stored",
  // T-481: set through --priority / --waiting-on, never through meta set;
  // updatedDate is stamped by every write that changes content.
  "priority",
  "waitingOn",
  "updatedDate",
]);

// --- Read Handlers ---

export function handleTicketList(
  filters: { status?: string; phase?: string; type?: string; priority?: string; waitingOn?: string },
  ctx: CommandContext,
): CommandResult {
  let tickets = [...ctx.state.leafTickets];
  // T-481: both filters read through the views, so p2 and none include absent.
  const priority = filters.priority !== undefined ? parsePriority(filters.priority) : undefined;
  const waitingOn = filters.waitingOn !== undefined ? parseWaitingOn(filters.waitingOn) : undefined;

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
  if (priority !== undefined) {
    tickets = tickets.filter((t) => effectivePriority(t) === priority);
  }
  if (waitingOn !== undefined) {
    tickets = tickets.filter((t) => effectiveWaitingOn(t) === waitingOn);
  }

  const rulingCtx = loadCitationContext(ctx.root);
  return { output: formatTicketList(tickets, ctx.format, citationMapFor(tickets, rulingCtx)) };
}

export function handleTicketGet(id: string, ctx: CommandContext, withActionability?: false): CommandResult;
export function handleTicketGet(id: string, ctx: CommandContext, withActionability: boolean): CommandResult | Promise<CommandResult>;
/** T-486 U2-4: async only with actionability, which reads the live cross-node observation. */
export function handleTicketGet(
  id: string,
  ctx: CommandContext,
  withActionability = false,
): CommandResult | Promise<CommandResult> {
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
  const rulingCtx = loadCitationContext(ctx.root);
  const item = result.item;
  const render = (extraJsonFields?: Awaited<ReturnType<typeof computeTargetedActionability>>): CommandResult => ({
    output: formatTicket(item, ctx.state, ctx.format, resolveEntityCitations(item, rulingCtx), extraJsonFields),
  });
  return withActionability ? computeTargetedActionability(ctx, "ticket", item).then(render) : render();
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
    // Existing path -- unchanged behavior, uses nextTicket (early-stop at blocked phase)
    const outcome = nextTicket(ctx.state);
    const exitCode = outcome.kind === "found" ? ExitCode.OK : ExitCode.USER_ERROR;
    const citedRulings = outcome.kind === "found" ? resolveEntityCitations(outcome.ticket, loadCitationContext(ctx.root)) : [];
    return { output: withWaiting(formatNextTicketOutcome(outcome, ctx.state, ctx.format, citedRulings), ctx), exitCode };
  }
  // Multi-candidate path -- continues across blocked phases
  const outcome = nextTickets(ctx.state, count);
  const exitCode = outcome.kind === "found" ? ExitCode.OK : ExitCode.USER_ERROR;
  const citedRulingsByTicketId =
    outcome.kind === "found" ? citationMapFor(outcome.candidates.map((c) => c.ticket), loadCitationContext(ctx.root)) : new Map();
  return { output: withWaiting(formatNextTicketsOutcome(outcome, ctx.state, ctx.format, citedRulingsByTicketId), ctx), exitCode };
}

/**
 * T-481: next never offers a waiting item but always names them, from the
 * whole inventory rather than the phases it walked. JSON always carries the
 * inventory beside data, empty lists included, so the field is never absent.
 */
function withWaiting(output: string, ctx: CommandContext): string {
  const waiting = waitingInventory(ctx.state);
  if (ctx.format === "json") return JSON.stringify({ ...JSON.parse(output), waiting }, null, 2);
  const summary = formatWaitingSummary(waiting);
  return summary ? `${output}\n\n${summary}` : output;
}

/**
 * T-486 U2-4: lists tickets blocked locally or across nodes, each cross-node
 * ref with its live status; an unresolved ref shows the cached value, if
 * any, labelled stale.
 */
export async function handleTicketBlocked(ctx: CommandContext): Promise<CommandResult> {
  const observation = await observeProject(ctx.state, ctx.root);
  const blocked = blockedTickets(ctx.state, crossNodeStatusRecord(observation));
  const cache = observation.statuses.size > 0 ? readFederationCache(join(ctx.root, ".story")) : null;
  return {
    output: formatBlockedTickets(blocked, ctx.state, ctx.format, citationMapFor(blocked, loadCitationContext(ctx.root)), {
      statuses: observation.statuses,
      ...(cache?.crossNodeRefStatuses ? { cached: cache.crossNodeRefStatuses, scannedAt: cache.lastScanTimestamp } : {}),
    }),
  };
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
export function validatePostWriteState(
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
    omittedTickets: state.omittedTickets,
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

/**
 * A new open ticket, its id allocated and its references resolved, NOT yet
 * written. The caller holds the project lock. T-537: shared with checkpoint
 * create, which adds the checkpoint record before the one create-only write.
 */
export async function prepareNewTicketUnlocked(
  args: {
    title: string;
    type: string;
    phase: string | null;
    description: string;
    blockedBy: string[];
    parentTicket: string | null;
    citesRulings?: string[];
    /** T-481: already validated by the caller; waitingOn "none" stores nothing. */
    priority?: Priority;
    waitingOn?: WaitingOn;
  },
  state: ProjectState,
  root: string,
): Promise<Ticket> {
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
  const instant = new Date();
  const createdAt = instant.toISOString();
  return withPriorityFields<Ticket>({
    id,
    ...(displayId != null && { displayId }),
    title: args.title,
    description: args.description,
    type: args.type as TicketType,
    status: "open",
    phase: args.phase,
    order,
    createdDate: localDateOf(instant),
    ...(isTeam && { createdAt }),
    completedDate: null,
    blockedBy: resolvedBlockedBy,
    parentTicket: resolvedParent,
    ...(args.citesRulings !== undefined && args.citesRulings.length > 0
      && { citesRulings: args.citesRulings }),
  }, { priority: args.priority, waitingOn: args.waitingOn });
}

/**
 * ISS-1112: the phase a ticket gets when its creator did not choose one. The
 * current phase, else (a fresh roadmap, where no phase has leaves yet) the
 * first phase with no leaf tickets, else null.
 */
export function defaultTicketPhase(state: ProjectState): string | null {
  const current = currentPhase(state);
  if (current) return current.id;
  const empty = state.roadmap.phases.find((p) => state.phaseTickets(p.id).length === 0);
  return empty ? empty.id : null;
}

export async function handleTicketCreate(
  args: {
    title: string;
    type: string;
    /**
     * ISS-1112: undefined = not chosen (defaults to the current phase when the
     * project has phases); null = deliberately unphased; a string = that phase.
     */
    phase: string | null | undefined;
    description: string;
    blockedBy: string[];
    parentTicket: string | null;
    citesRuling?: string[];
    priority?: string;
    waitingOn?: string;
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
  const priority = args.priority !== undefined ? parsePriority(args.priority) : undefined;
  const waitingOn = args.waitingOn !== undefined ? parseWaitingOn(args.waitingOn) : undefined;
  const citesRulingsResolution = resolveCitesRulingsInput(args.citesRuling, undefined);
  if (!citesRulingsResolution.ok) {
    throw new CliValidationError("invalid_input", citesRulingsResolution.message);
  }

  let createdTicket: Ticket | undefined;
  let createdInState: ProjectState | undefined;
  let phaseNote = "";

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    createdInState = state;
    let phase = args.phase ?? null;
    if (args.phase === undefined && state.roadmap.phases.length > 0) {
      phase = defaultTicketPhase(state);
      phaseNote = phase !== null
        ? ` (phase ${phase}: defaulted to the current phase; pass phase null / --phase "" to leave it unphased)`
        : " (no current phase: ticket left unphased; assign a phase to schedule it)";
    }
    const ticket = await prepareNewTicketUnlocked({ ...args, phase, citesRulings: citesRulingsResolution.citesRulings, priority, waitingOn }, state, root);
    validatePostWriteState(ticket, state, true);
    await writeTicketUnlocked(ticket, root, { createOnly: true });
    createdTicket = ticket;
  });

  if (!createdTicket) throw new Error("Ticket not created");
  const branchWarning = createdInState
    ? checkBranchAllocationWarning(root, "ticket", createdInState, displayIdOf(createdTicket))
    : null;
  const warnings = branchWarning ? [branchWarning] : undefined;
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(ticketJsonBody(createdTicket)), null, 2), ...(warnings && { warnings }) };
  }
  return { output: `Created ticket ${displayIdOf(createdTicket)}: ${createdTicket.title}${phaseNote}`, ...(warnings && { warnings }) };
}

/**
 * Assembles the identity a completion is authorized against (T-442).
 *
 * `completingUser` comes from git; the veto set comes from the LOCAL active
 * session record. Neither is read off the ticket: `claimedBySession` there names
 * the current ledger winner, not the caller, so deriving the owner from it would
 * be circular. `--force` is the administrative bypass, expressed as a fully
 * permissive guard rather than a branch around it, so there is one code path.
 */
async function resolveCompletionGuard(
  root: string,
  ticket: Ticket,
  force: boolean,
): Promise<CompletionGuardOptions> {
  if (force) {
    return { completingUser: ticket.claim?.user ?? null, activeEpochs: [], authorized: true };
  }

  try {
    return await collectCompletionOwnership(root);
  } catch (err) {
    if (!(err instanceof CompletionOwnershipUnavailable)) throw err;
    if (err.unreadable) {
      throw new CliValidationError("invalid_input", `Cannot verify ticket ownership: ${err.message} Re-run with --force to complete anyway.`);
    }
    // An unreadable or malformed session store is NOT proof that no session is
    // running. Treating it as an empty veto set would let a completion clear a
    // live session's claim on email evidence alone, which is the exact ISS-784
    // harm. Fail closed and require the explicit administrative bypass.
    throw new CliValidationError(
      "invalid_input",
      `Cannot verify ticket ownership: local session state could not be read (${err.message}). ` +
      "Re-run with --force to complete anyway.",
    );
  }
}

export async function handleTicketUpdate(
  id: string,
  updates: TicketUpdateInput,
  format: string,
  root: string,
  force = false,
  hooks?: UpdateWriteHooks<Ticket>,
): Promise<CommandResult> {
  if (updates.reason !== undefined && updates.resolutionKind === undefined) {
    throw new CliValidationError("invalid_input", "--reason is only for a withdrawal: pass it with --resolution-kind withdrawn");
  }
  const withdrawal = updates.resolutionKind !== undefined;
  if (withdrawal && updates.resolutionKind !== "withdrawn") {
    throw new CliValidationError("invalid_input", `Unknown ticket resolution kind "${updates.resolutionKind}": a ticket can only be withdrawn`);
  }
  const withdrawalReason = updates.reason?.trim() ?? "";
  if (withdrawal && withdrawalReason === "") {
    throw new CliValidationError("invalid_input", "A withdrawal needs a non-empty --reason saying why the work is not delivered");
  }
  assertUpdateHasFields(
    updates,
    "ticket",
    "status, title, type, phase, order, description, blockedBy, addBlockedBy, crossNodeBlockedBy, parentTicket, citesRuling, clearCitesRulings, resolutionKind (with reason), priority, waitingOn",
  );
  if (updates.blockedBy !== undefined && updates.addBlockedBy !== undefined) {
    throw new CliValidationError("invalid_input", "Use either --blocked-by (replaces the prerequisites) or --add-blocked-by (adds to them), not both");
  }
  const priority = updates.priority !== undefined ? parsePriority(updates.priority) : undefined;
  const waitingOn = updates.waitingOn !== undefined ? parseWaitingOn(updates.waitingOn) : undefined;
  // ISS-1192: an agent that reads the md-rendered description back and
  // writes it verbatim carries the render fence into storage, growing by one
  // backtick every round trip. Applies to both the CLI --stdin/--description
  // path and MCP's ticket_update, which share this handler.
  let descriptionFenceStripped = false;
  if (updates.description !== undefined) {
    const stripped = stripRenderFence(updates.description);
    updates.description = stripped.text;
    descriptionFenceStripped = stripped.stripped;
  }
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
  const citesRulingsResolution = resolveCitesRulingsInput(updates.citesRuling, updates.clearCitesRulings);
  if (!citesRulingsResolution.ok) {
    throw new CliValidationError("invalid_input", citesRulingsResolution.message);
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

    await hooks?.precondition?.(existing, state);

    if (updates.phase !== undefined) {
      validatePhase(updates.phase, { state });
    }
    let resolvedBlockedBy = updates.blockedBy
      ? validateAndResolveBlockedBy(updates.blockedBy, resolvedId, state)
      : undefined;
    // T-538: the addition reads the stored set under this lock. A checkpoint
    // takes new prerequisites only while pending: an approved or retired one
    // has released its dependents, and an unrecognized one cannot be read.
    if (updates.addBlockedBy !== undefined) {
      const cpState = checkpointState(existing);
      if (cpState !== null && cpState !== "pending") {
        throw new CliValidationError(
          "conflict",
          `Cannot add prerequisites to ${displayIdOf(existing)}: the checkpoint is ${cpState}, and only a pending checkpoint takes new ones. ` +
            (cpState === "unrecognized" ? "Fix the file by hand first." : "Reopen it first if the answer no longer stands."),
        );
      }
      const added = validateAndResolveBlockedBy(updates.addBlockedBy, resolvedId, state);
      // Stored refs are kept as written; a new one is skipped when a stored
      // ref already resolves to the same ticket.
      const held = new Set(existing.blockedBy.map((ref) => {
        const r = state.resolveTicketRef(ref);
        return r.kind === "found" ? r.item.id : ref;
      }));
      resolvedBlockedBy = [...existing.blockedBy];
      for (const ref of added) {
        if (held.has(ref)) continue;
        held.add(ref);
        resolvedBlockedBy.push(ref);
      }
    }
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

    const built: Ticket = withPriorityFields<Ticket>({
      ...existing,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.type !== undefined && { type: updates.type as TicketType }),
      ...(updates.description !== undefined && { description: updates.description }),
      ...(updates.phase !== undefined && { phase: updates.phase }),
      ...(updates.order !== undefined && { order: updates.order }),
      ...(resolvedBlockedBy !== undefined && { blockedBy: resolvedBlockedBy }),
      ...(updates.crossNodeBlockedBy !== undefined && { crossNodeBlockedBy: updates.crossNodeBlockedBy ?? undefined }),
      ...(updates.parentTicket !== undefined && { parentTicket: resolvedParent }),
      ...(citesRulingsResolution.citesRulings !== undefined && { citesRulings: citesRulingsResolution.citesRulings }),
      ...statusChanges,
    }, { priority, waitingOn });

    // T-486 U2-6: the withdrawal setter. With the flag, the ticket as updated
    // must be complete and must not be an owner checkpoint or an umbrella,
    // and no live ticket may wait on it or on an umbrella above it; the
    // withdrawal is bound to the completion date. Without it, a status change
    // (a reopen, S1) or an explicit re-completion (S2) drops any stored
    // withdrawal, so the ticket reads as delivered or open; every other edit
    // keeps the slot byte for byte.
    let ticket: Ticket = built;
    const recompletes = updates.status === "complete" && existing.status === "complete";
    if (withdrawal) {
      const label = displayIdOf(existing);
      if (hasOwnerCheckpoint(built)) {
        throw new CliValidationError("invalid_input", `Cannot withdraw ${label}: an owner checkpoint cannot be withdrawn; it releases by its own resolution, so retire it instead`);
      }
      if (built.status !== "complete") {
        throw new CliValidationError("invalid_input", `Cannot withdraw ${label}: a withdrawal needs a complete ticket (it is ${built.status}); pass --status complete to complete it now`);
      }
      ticket = { ...built, resolutionKind: { kind: "withdrawn", closedOn: built.completedDate, reason: withdrawalReason } };
      // Early, for a clear message: the lock's tickets with this one as it
      // will be written, so a new parent in the same update counts. The
      // check at commit (assertWithdrawalLedgerCurrent) is the authority.
      const candidate = ticket;
      assertWithdrawable(ProjectState.forTicketGraph(state.tickets.map((t) => (t === existing ? candidate : t)), state.omittedTickets), candidate);
    } else if ((statusChanges.status !== undefined || recompletes) && Object.hasOwn(built, "resolutionKind")) {
      const { resolutionKind: _dropped, ...rest } = built;
      ticket = rest as Ticket;
    }

    // T-537: an explicit `status: complete` on a ticket already complete is a
    // re-completion. It refreshes the checkpoint evidence (which is how a
    // reassessment flag clears) when that evidence is stale or a checkpoint
    // it waits on no longer releases; otherwise it is the no-op it always was.
    // Edits that do not name the status never refresh.
    const refreshesEvidence =
      updates.status === "complete" &&
      existing.status === "complete" &&
      (pendingCheckpointBlockers(state, ticket).length > 0 ||
        // Key-order-insensitive, array order kept: the file holds deep-sorted
        // keys, evidenceFor builds them in declaration order.
        JSON.stringify(sortKeysDeep(evidenceFor(state, ticket))) !== JSON.stringify(sortKeysDeep(ticket.checkpointEvidence ?? [])));
    const isNoOpUpdate = !refreshesEvidence && JSON.stringify(ticket) === JSON.stringify(existing);

    // T-442 / ISS-784 / ISS-981: a completion must not clear a claim the caller
    // cannot prove is theirs, and neither may a REOPEN bypass that guard.
    // clearClaimOnComplete cannot cover the reopen direction itself: it returns
    // early whenever the CANDIDATE's status is not "complete", which is exactly
    // what a reopen produces. It does still cover a candidate that STAYS
    // complete while carrying contradictory claim material (ISS-913), which is
    // the mechanism that keeps a claim-bearing ticket's fields protected below.
    // This is deliberately NOT limited to tickets that still carry claim
    // material: ISS-981's own filing names the claim-free case -- the common
    // shape, since a successful completion strips claim keys -- as the defect
    // ("no claim, no --force" reopens a session's just-completed work).
    // `--force` is the escape for a claim-free ticket, since there is no
    // identity left to prove ownership against; a claim-bearing one must still
    // match it. Identity comes from git and from the LOCAL active session
    // record, never from the ticket being updated -- that value identifies the
    // current ledger winner, so using it to authorize would authorize the very
    // party it is meant to exclude.
    //
    // SCOPE (1.9.0): the guard covers the REOPEN direction only, not every edit
    // of a complete ticket. ISS-981's stated defect is that a reopen "erases its
    // completion date" and undoes a session's work; a title or description edit
    // erases nothing and steals nothing. Guarding those too made a routine human
    // correction on a finished ticket fail with "cannot prove ownership" against
    // a ticket that, post-completion, carries no ownership to prove -- a
    // breaking change with no integrity gain. Reopening still fails closed.
    const isReopen =
      existing.status === "complete" &&
      statusChanges.status !== undefined &&
      statusChanges.status !== "complete";

    // Gathering ownership evidence costs a git identity lookup and a session
    // scan, and resolveCompletionGuard fails closed by throwing rather than
    // guessing when it cannot complete them. Resolve it only when something
    // will actually consult the result: a reopen, an explicit --force, or a
    // candidate still carrying claim material for clearClaimOnComplete to
    // authorize. `hasClaimMaterial` is imported rather than re-derived so this
    // cannot drift from the early return it mirrors.
    //
    // Scoped as an optimization, NOT as a fix for an observed failure. The
    // throw is real but no trigger was demonstrated: findActiveSessionFull
    // catches its own readdir and parse failures and returns null, so a
    // malformed session record and a chmod 000 sessions directory both take the
    // ordinary path. The realistic remaining trigger is a failed dynamic import
    // or an unexpected internal error. Not consulting evidence no verdict needs
    // is right on its own terms; do not read this as a reproduced bug.
    const needsOwnershipEvidence = force || (!isNoOpUpdate && (isReopen || hasClaimMaterial(ticket)));
    const guard: CompletionGuardOptions = needsOwnershipEvidence
      ? await resolveCompletionGuard(root, existing, force)
      : { completingUser: null, activeEpochs: [] };

    if (!isNoOpUpdate && isReopen) {
      const { authorized } = guardCompletedTicketMutation(existing, guard);
      if (!authorized) {
        throw new CliValidationError(
          "invalid_input",
          `Cannot reopen ${displayIdOf(existing)}: it is complete and this caller cannot prove ownership` +
            (guard.completingUser === null ? " (git user.email is not configured)" : "") +
            `. If that is intended, re-run with --force.`,
        );
      }
    }

    // A genuine no-op never needs to prove anything -- and must not, since
    // `clearClaimOnComplete` has no no-op awareness of its own: called
    // unconditionally, it would independently reproduce the exact rejection
    // `isNoOpUpdate` was meant to exempt above (ISS-981 [R5-F1] correction),
    // because a no-op's `ticket` is content-identical to `existing` and so
    // yields the identical verdict either guard would compute.
    const completion = isNoOpUpdate ? { rejected: false as const, ticket } : clearClaimOnComplete(ticket, guard);
    if (completion.rejected) {
      throw new CliValidationError(
        "invalid_input",
        `Cannot complete ${displayIdOf(ticket)}: it is claimed by ` +
          `${ticket.claim?.user ?? "another session"} and this caller cannot prove ownership` +
          (guard.completingUser === null ? " (git user.email is not configured)" : "") +
          `. Completing it would take the ticket from a session still working on it. ` +
          `If that is intended, re-run with --force.`,
      );
    }
    let finalTicket = completion.ticket;
    // Section 5 (completion, new seam): `clearClaimOnComplete` just stripped
    // `existing.claimedBySession` above -- an `assigned` earmark that named
    // that exact session was the normal worked state (R5) and is now
    // orphaned by the claim it was co-located with, which is one of R5's two
    // invalid split states if left behind. Scoped to a genuine, non-no-op
    // completion that actually had a matching claim to strip; an earmark
    // that never matched `existing.claimedBySession` was already invalid
    // independently of this write and is left for `validate` to flag.
    if (!isNoOpUpdate && finalTicket.status === "complete" && existing.claimedBySession) {
      const { item: completedWithEarmark } = clearSameSessionEarmark(finalTicket, existing.claimedBySession);
      finalTicket = completedWithEarmark;
    }
    validatePostWriteState(finalTicket, state, false);
    const completes = !isNoOpUpdate && finalTicket.status === "complete" && (existing.status !== "complete" || refreshesEvidence);
    // T-486 U2-6 (P1): withdrawing a ticket that is already complete does not
    // go through completeDependent below, so it meets the same refusal here:
    // a ticket waiting on an owner checkpoint that has not released cannot
    // close, delivered or withdrawn.
    if (withdrawal && !isNoOpUpdate && !completes) {
      const pending = pendingCheckpointBlockers(state, finalTicket);
      if (pending.length > 0) {
        throw new CliValidationError("conflict", describeCheckpointBlock(displayIdOf(existing), pending.map((c) => {
          const t = state.ticketByID(c);
          return t ? displayIdOf(t) : c;
        })));
      }
    }
    // T-537: a completion, or a re-completion that refreshes evidence, goes
    // through completeDependent, which refuses while an owner checkpoint the
    // ticket waits on has not released and records the checkpoint state it
    // relied on. Every other update writes as before.
    if (completes) {
      const outcome = await completeDependent(state, finalTicket, root, hooks);
      if (outcome.kind === "checkpoint-blocked") {
        throw new CliValidationError("conflict", describeCheckpointBlock(displayIdOf(existing), outcome.checkpoints.map((c) => {
          const t = state.ticketByID(c);
          return t ? displayIdOf(t) : c;
        })));
      }
      updatedTicket = outcome.ticket;
      return;
    }
    await writeTicketUnlocked(finalTicket, root, hooks);
    updatedTicket = finalTicket;
  });

  if (!updatedTicket) throw new Error("Ticket not updated");
  const warnings = descriptionFenceStripped
    ? ["outer render fence removed; use --format json for round trips"]
    : undefined;
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(ticketJsonBody(updatedTicket)), null, 2), ...(warnings && { warnings }) };
  }
  return { output: `Updated ticket ${displayIdOf(updatedTicket)}: ${updatedTicket.title}`, ...(warnings && { warnings }) };
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
    return { output: JSON.stringify(successEnvelope(ticketJsonBody(updatedTicket)), null, 2) };
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
    return { output: JSON.stringify(successEnvelope(ticketJsonBody(updatedTicket)), null, 2) };
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
    return { output: JSON.stringify(successEnvelope(ticketJsonBody(updatedTicket)), null, 2) };
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
    // T-537: an owner checkpoint is never started, and neither is a ticket
    // that waits on one that has not released.
    const eligibility = assertCheckpointEligible(state, existing, "start");
    if (eligibility.kind !== "eligible") {
      throw new CliValidationError("conflict", describeIneligible(state, existing, "start", eligibility));
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
    return { output: JSON.stringify(successEnvelope(ticketJsonBody(updatedTicket)), null, 2) };
  }
  return { output: `Started ticket ${(updatedTicket as Record<string, unknown>).displayId as string | undefined ?? updatedTicket.id}: ${updatedTicket.title}` };
}
