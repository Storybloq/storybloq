/**
 * T-537: the owner checkpoint lifecycle -- create, attach, resolve, change,
 * reopen, retire. These are the only writers of a checkpoint's record, its
 * status, completion date and ticket lifecycle: each holds LIFECYCLE_AUTHORITY
 * for the one write it makes (core/checkpoint-guard.ts), under the project
 * lock, after comparing the caller's expected `{generation, revision, digest}`
 * with the record on disk. A stale expectation is refused, so two owners
 * answering the same question cannot both win.
 *
 * The generation advances on every mutation (resolve, change, reopen,
 * retire; create and attach start it at 1), so evidence taken before any of
 * them no longer matches. The revision advances only when the reviewed
 * content changes.
 *
 * Retirement is the only release that is not an approval; nothing deletes a
 * checkpoint. The CLI and MCP surfaces are thin wrappers over these.
 */
import { CONFLICT_SETTLEMENT_AUTHORITY, LIFECYCLE_AUTHORITY, sameValue } from "./checkpoint-guard.js";
import { CHECKPOINT_SCHEMA_VERSION } from "./errors.js";
import {
  MAX_CHECKPOINT_COUNTER,
  OwnerCheckpointSchema,
  checkpointApproved,
  checkpointDigest,
  hasOwnerCheckpoint,
  isWellFormedText,
  parseOwnerCheckpoint,
  type CheckpointHistoryEntry,
  type CheckpointKind,
  type CheckpointResolution,
  type OwnerCheckpoint,
} from "./owner-checkpoint.js";
import {
  prepareTicketWrite,
  resolveActor,
  runTransactionUnlocked,
  TransactionRecoveryPendingError,
  withProjectLock,
  writeTicketUnlocked,
} from "./project-loader.js";
import type { ProjectState } from "./project-state.js";
import { resolveAndNormalizeTicketRef } from "./ref-normalization.js";
import { displayIdOf } from "./resolver.js";
import { CliValidationError, todayISO } from "../cli/helpers.js";
import { prepareNewTicketUnlocked, validatePostWriteState } from "../cli/commands/ticket.js";
import { prepareRulingUnlocked, rulingCreatePreflight, type RulingCreateInput } from "../cli/commands/ruling.js";
import type { Ticket } from "../models/ticket.js";

export interface CheckpointContentInput {
  readonly kind: CheckpointKind;
  readonly question?: string;
  readonly criteria?: string;
  readonly evidenceRefs: readonly string[];
}

/** What the caller last saw; every handler but create and attach compares it under the lock. */
export interface ExpectedCheckpoint {
  readonly generation: number;
  readonly revision: number;
  readonly digest: string;
}

/**
 * The next revision or generation. Refused past MAX_SAFE_INTEGER: beyond it an
 * increment no longer changes the number, so a stale approval would match.
 */
export function nextCounter(value: number, name: "revision" | "generation"): number {
  if (!Number.isSafeInteger(value) || value >= MAX_CHECKPOINT_COUNTER) {
    throw new CliValidationError("conflict", `Cannot advance the checkpoint ${name} past ${MAX_CHECKPOINT_COUNTER}; it would stop being exact.`);
  }
  return value + 1;
}

/**
 * Reviewed text must be well formed. The pen's T-537 ruling: a lone UTF-16
 * surrogate and U+FFFD are both refused, because the Mac app reads a lone
 * surrogate as U+FFFD and the two languages must hash the same text.
 */
function assertWellFormed(content: CheckpointContentInput): void {
  const fields: [string, string | undefined][] = [
    ["question", content.question],
    ["criteria", content.criteria],
    ...content.evidenceRefs.map((r, i): [string, string] => [`evidenceRefs[${i}]`, r]),
  ];
  for (const [name, text] of fields) {
    if (text !== undefined && !isWellFormedText(text)) {
      throw new CliValidationError(
        "invalid_input",
        `Checkpoint ${name} holds a lone UTF-16 surrogate or U+FFFD (the replacement character). ` +
          "The Mac app cannot hash either the same way as the CLI; replace it with the character you meant.",
      );
    }
  }
}

function contentOf(input: CheckpointContentInput): Pick<OwnerCheckpoint, "kind" | "question" | "criteria" | "evidenceRefs"> {
  return {
    kind: input.kind,
    ...(input.question !== undefined && { question: input.question }),
    ...(input.criteria !== undefined && { criteria: input.criteria }),
    evidenceRefs: [...input.evidenceRefs],
  };
}

/** Validates a record about to be written; the schema's own refinements name what is missing. */
function validated(record: unknown): OwnerCheckpoint {
  const parsed = OwnerCheckpointSchema.safeParse(record);
  if (!parsed.success) {
    throw new CliValidationError("invalid_input", `Invalid checkpoint: ${parsed.error.issues.map((i) => `${i.path.join(".") || "checkpoint"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * A history entry for an event, taken from the record AFTER the event: its
 * generation, revision, digest and reviewed content. `resolution` is the one
 * in force after the event, except for `changed` and `reopened`, which carry
 * the resolution they displaced (`displaced`), so no answer is ever lost.
 */
function historyEntry(
  cp: OwnerCheckpoint,
  event: CheckpointHistoryEntry["event"],
  by: string,
  at: string,
  extra?: { reason?: string; displaced?: CheckpointResolution },
): CheckpointHistoryEntry {
  const resolution = extra && "displaced" in extra ? extra.displaced : cp.resolution;
  return {
    event,
    at,
    by,
    generation: cp.generation,
    revision: cp.revision,
    digest: cp.digest,
    kind: cp.kind,
    ...(cp.question !== undefined && { question: cp.question }),
    ...(cp.criteria !== undefined && { criteria: cp.criteria }),
    evidenceRefs: [...cp.evidenceRefs],
    ...(resolution !== undefined && { resolution }),
    ...(extra?.reason !== undefined && { reason: extra.reason }),
  };
}

function without(cp: OwnerCheckpoint, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cp };
  for (const k of keys) delete out[k];
  return out;
}

function freshRecord(owner: string, input: CheckpointContentInput, by: string, at: string): OwnerCheckpoint {
  assertWellFormed(input);
  const content = contentOf(input);
  const base = { ...content, owner, lifecycle: "active" as const, revision: 1, generation: 1, digest: checkpointDigest(content), history: [] as CheckpointHistoryEntry[] };
  const record = validated(base);
  return validated({ ...record, history: [historyEntry(record, "created", by, at)] });
}

function findTicket(state: ProjectState, id: string): Ticket {
  let resolved: string;
  try {
    resolved = resolveAndNormalizeTicketRef(state, id);
  } catch {
    throw new CliValidationError("not_found", `Ticket ${id} not found`);
  }
  const t = state.ticketByID(resolved);
  if (!t) throw new CliValidationError("not_found", `Ticket ${id} not found`);
  return t;
}

/** The checkpoint on `ticket`, refused when absent, unrecognized, or not what the caller expected. */
function currentCheckpoint(ticket: Ticket, expected: ExpectedCheckpoint): OwnerCheckpoint {
  const label = displayIdOf(ticket);
  const p = parseOwnerCheckpoint(ticket);
  if (p.kind === "absent") throw new CliValidationError("invalid_input", `${label} is not an owner checkpoint`);
  if (p.kind === "unrecognized") {
    throw new CliValidationError("conflict", `${label} carries a checkpoint this CLI cannot read (${p.reason}); it blocks its dependents until the file is fixed by hand.`);
  }
  const cp = p.checkpoint;
  if (cp.generation !== expected.generation || cp.revision !== expected.revision || cp.digest !== expected.digest) {
    throw new CliValidationError(
      "conflict",
      `${label} changed since you read it: now generation ${cp.generation}, revision ${cp.revision}, digest ${cp.digest}. Read it again and decide against what it says now.`,
    );
  }
  return cp;
}

/**
 * Checkpoints exist only in a project `checkpoint enable` stamped at schema
 * version 4, which every client that ignores them refuses to write. Checked
 * under the lock before any ID is allocated or any file written; the config
 * is never upgraded here.
 */
function assertCheckpointsEnabled(state: ProjectState): void {
  const version = state.config.schemaVersion;
  if (version === undefined || version < CHECKPOINT_SCHEMA_VERSION) {
    throw new CliValidationError(
      "conflict",
      `Owner checkpoints are not enabled in this project (config schemaVersion ${version ?? "unset"}, needs ${CHECKPOINT_SCHEMA_VERSION}). ` +
        "Run `storybloq checkpoint enable` first; nothing enables them implicitly.",
    );
  }
}

function assertActive(ticket: Ticket, cp: OwnerCheckpoint, verb: string): void {
  if (cp.lifecycle !== "active") throw new CliValidationError("conflict", `Cannot ${verb} ${displayIdOf(ticket)}: the checkpoint is retired`);
}

async function writeCheckpoint(ticket: Ticket, record: OwnerCheckpoint, fields: Partial<Ticket>, state: ProjectState, root: string, createOnly = false): Promise<Ticket> {
  const next = { ...ticket, ...fields, ownerCheckpoint: record } as Ticket;
  validatePostWriteState(next, state, createOnly);
  await writeTicketUnlocked(next, root, { createOnly, authority: LIFECYCLE_AUTHORITY });
  return next;
}

// --- create / attach -------------------------------------------------------------------

export async function createCheckpoint(
  root: string,
  args: {
    title: string;
    description: string;
    phase: string | null;
    type?: string;
    blockedBy?: string[];
    parentTicket?: string | null;
    owner: string;
    content: CheckpointContentInput;
    actor?: string;
  },
): Promise<Ticket> {
  const by = await resolveActor(root, args.actor);
  let created: Ticket | undefined;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    assertCheckpointsEnabled(state);
    const ticket = await prepareNewTicketUnlocked({
      title: args.title,
      type: args.type ?? "task",
      phase: args.phase,
      description: args.description,
      blockedBy: args.blockedBy ?? [],
      parentTicket: args.parentTicket ?? null,
    }, state, root);
    const record = freshRecord(args.owner, args.content, by, new Date().toISOString());
    created = await writeCheckpoint(ticket, record, {}, state, root, true);
  });
  if (!created) throw new Error("Checkpoint not created");
  return created;
}

/** Makes an existing open, unclaimed, un-earmarked ticket a checkpoint. */
export async function attachCheckpoint(root: string, id: string, args: { owner: string; content: CheckpointContentInput; actor?: string }): Promise<Ticket> {
  const by = await resolveActor(root, args.actor);
  let updated: Ticket | undefined;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    assertCheckpointsEnabled(state);
    const ticket = findTicket(state, id);
    const label = displayIdOf(ticket);
    if (hasOwnerCheckpoint(ticket)) throw new CliValidationError("conflict", `${label} is already an owner checkpoint`);
    if (ticket.status !== "open") throw new CliValidationError("conflict", `Cannot attach a checkpoint to ${label}: it is ${ticket.status}, not open`);
    if (ticket.lifecycle !== undefined && ticket.lifecycle !== "active") throw new CliValidationError("conflict", `Cannot attach a checkpoint to ${label}: it is ${ticket.lifecycle}`);
    const raw = ticket as Record<string, unknown>;
    if (raw.claim != null || raw.claimedBySession != null || raw.earmark != null) {
      throw new CliValidationError("conflict", `Cannot attach a checkpoint to ${label}: it is claimed or earmarked; release it first`);
    }
    const record = freshRecord(args.owner, args.content, by, new Date().toISOString());
    updated = await writeCheckpoint(ticket, record, {}, state, root);
  });
  if (!updated) throw new Error("Checkpoint not attached");
  return updated;
}

// --- resolve --------------------------------------------------------------------------

export interface ResolveArgs {
  readonly response: string;
  readonly artifactRef?: string;
  readonly actor?: string;
  /** Also record the answer as an accepted ruling, committed with the checkpoint in one transaction. */
  readonly ruling?: RulingCreateInput & { readonly clientTaskId?: string };
}

/**
 * Approves the checkpoint at its current revision. A decision needs a
 * response; an acceptance also needs the reviewed artifact. The ticket
 * completes, and a `resolved` event records the content and the answer.
 */
export async function resolveCheckpoint(root: string, id: string, expected: ExpectedCheckpoint, args: ResolveArgs): Promise<{ ticket: Ticket; rulingId?: string }> {
  if (args.response.trim().length === 0) throw new CliValidationError("invalid_input", "A checkpoint resolution needs an explicit response");
  const recordedBy = args.ruling ? rulingCreatePreflight(args.ruling.attribution, args.ruling.clientTaskId) : undefined;
  const by = await resolveActor(root, args.actor);
  let out: { ticket: Ticket; rulingId?: string } | undefined;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    assertCheckpointsEnabled(state);
    const ticket = findTicket(state, id);
    const cp = currentCheckpoint(ticket, expected);
    const label = displayIdOf(ticket);
    assertActive(ticket, cp, "resolve");
    if (checkpointApproved(ticket)) throw new CliValidationError("conflict", `${label} is already approved at this revision; reopen or change it first`);
    if (checkpointDigest(cp) !== cp.digest) {
      throw new CliValidationError("conflict", `${label}: the stored digest does not match the checkpoint's content, so what would be approved is ambiguous. Change it to restate the content, then resolve.`);
    }
    if (cp.kind === "acceptance" && (args.artifactRef === undefined || args.artifactRef.length === 0)) {
      throw new CliValidationError("invalid_input", `${label} is an acceptance checkpoint: name the reviewed artifact (artifactRef)`);
    }

    const generation = nextCounter(cp.generation, "generation");
    const prepared = args.ruling && recordedBy ? await prepareRulingUnlocked(args.ruling, recordedBy, state.config, root) : undefined;
    const at = new Date().toISOString();
    const resolution: CheckpointResolution = {
      response: args.response,
      respondedBy: by,
      respondedAt: at,
      ...(args.artifactRef !== undefined && args.artifactRef.length > 0 && { artifactRef: args.artifactRef }),
      ...(prepared && { rulingId: prepared.ruling.id }),
      revision: cp.revision,
      digest: cp.digest,
      generation,
    };
    const resolved = { ...cp, generation, resolution };
    const record = validated({ ...resolved, history: [...cp.history, historyEntry(resolved, "resolved", by, at)] });
    const fields: Partial<Ticket> = { status: "complete", completedDate: todayISO() };

    if (!prepared) {
      out = { ticket: await writeCheckpoint(ticket, record, fields, state, root) };
      return;
    }
    // ONE transaction under the one lock: the ruling first, the checkpoint
    // last, so an approval never names a ruling that is not on disk. The
    // journal is the only recovery authority (project-loader.ts).
    const next = { ...ticket, ...fields, ownerCheckpoint: record } as Ticket;
    validatePostWriteState(next, state, false);
    const ticketOp = await prepareTicketWrite(next, root, { authority: LIFECYCLE_AUTHORITY });
    try {
      await runTransactionUnlocked(root, [prepared.op, { op: "write", ...ticketOp }]);
    } catch (err) {
      if (err instanceof TransactionRecoveryPendingError) {
        throw new CliValidationError(
          "io_error",
          `Resolving ${label} with ruling ${prepared.ruling.id}: the commit had already begun and forward recovery is pending. ` +
            "Do NOT retry: recovery completes this resolution at the next command. " +
            `Underlying failure: ${err.message}`,
        );
      }
      throw err;
    }
    out = { ticket: next, rulingId: prepared.ruling.id };
  });
  if (!out) throw new Error("Checkpoint not resolved");
  return out;
}

// --- change / reopen / retire ---------------------------------------------------------

/**
 * Restates the reviewed content. The revision advances and the digest is
 * recomputed; the old content and any answer to it move into a `changed`
 * event, and the ticket reopens: an answer to other words is not an answer.
 */
export async function changeCheckpoint(root: string, id: string, expected: ExpectedCheckpoint, content: CheckpointContentInput, actor?: string): Promise<Ticket> {
  const by = await resolveActor(root, actor);
  let updated: Ticket | undefined;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    assertCheckpointsEnabled(state);
    const ticket = findTicket(state, id);
    const cp = currentCheckpoint(ticket, expected);
    assertActive(ticket, cp, "change");
    assertWellFormed(content);
    const next = contentOf(content);
    const digest = checkpointDigest(next);
    if (digest === cp.digest && checkpointDigest(cp) === cp.digest) {
      throw new CliValidationError("invalid_input", `${displayIdOf(ticket)}: the content is unchanged`);
    }
    const at = new Date().toISOString();
    const after = {
      ...without(cp, ["resolution", "question", "criteria"]),
      ...next,
      revision: nextCounter(cp.revision, "revision"),
      generation: nextCounter(cp.generation, "generation"),
      digest,
    } as OwnerCheckpoint;
    const record = validated({ ...after, history: [...cp.history, historyEntry(after, "changed", by, at, { displaced: cp.resolution })] });
    updated = await writeCheckpoint(ticket, record, { status: "open", completedDate: null }, state, root);
  });
  if (!updated) throw new Error("Checkpoint not changed");
  return updated;
}

/** Withdraws the answer: the resolution moves into a `reopened` event and the ticket reopens. */
export async function reopenCheckpoint(root: string, id: string, expected: ExpectedCheckpoint, actor?: string, reason?: string): Promise<Ticket> {
  const by = await resolveActor(root, actor);
  let updated: Ticket | undefined;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    assertCheckpointsEnabled(state);
    const ticket = findTicket(state, id);
    const cp = currentCheckpoint(ticket, expected);
    assertActive(ticket, cp, "reopen");
    if (cp.resolution === undefined) throw new CliValidationError("conflict", `${displayIdOf(ticket)} has no answer to reopen`);
    const at = new Date().toISOString();
    const after = { ...without(cp, ["resolution"]), generation: nextCounter(cp.generation, "generation") } as OwnerCheckpoint;
    const record = validated({ ...after, history: [...cp.history, historyEntry(after, "reopened", by, at, { reason, displaced: cp.resolution })] });
    updated = await writeCheckpoint(ticket, record, { status: "open", completedDate: null }, state, root);
  });
  if (!updated) throw new Error("Checkpoint not reopened");
  return updated;
}

/**
 * Retires the checkpoint: the question no longer needs an answer. Its
 * dependents unblock; the ticket keeps its status and its file, and a
 * `retired` event records why. Retirement is final.
 */
export async function retireCheckpoint(root: string, id: string, expected: ExpectedCheckpoint, reason: string, actor?: string): Promise<Ticket> {
  if (reason.trim().length === 0) throw new CliValidationError("invalid_input", "Retiring a checkpoint needs a reason");
  const by = await resolveActor(root, actor);
  let updated: Ticket | undefined;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    assertCheckpointsEnabled(state);
    const ticket = findTicket(state, id);
    const cp = currentCheckpoint(ticket, expected);
    assertActive(ticket, cp, "retire");
    const at = new Date().toISOString();
    const after: OwnerCheckpoint = { ...cp, lifecycle: "retired", retiredAt: at, generation: nextCounter(cp.generation, "generation") };
    const record = validated({ ...after, history: [...cp.history, historyEntry(after, "retired", by, at, { reason })] });
    updated = await writeCheckpoint(ticket, record, {}, state, root);
  });
  if (!updated) throw new Error("Checkpoint not retired");
  return updated;
}

// --- conflict resolution ---------------------------------------------------------------

/**
 * Settles a merge conflict on a checkpoint after `conflicts resolve` applied
 * the selected side to `resolved` (the caller holds the conflict-resolution
 * lock). Validation checks consistency, never "must be approved": the stored
 * digest matches the selected content; lifecycle, status and resolution agree;
 * and a checkpoint any side had is never removed or deleted.
 *
 * The generation advances past every side's (every snapshot the conflict
 * held, the selected record and the ticket on disk), and the discarded side
 * is kept whole in a `conflict-resolved` history entry. A dependent's
 * evidence settled in the same resolution is adopted verbatim from a side,
 * never edited, in the same write. Then, by the selected side:
 *  - approved: the approval does not survive. Its resolution moves into the
 *    history entry and the checkpoint is pending again; the owner answers anew.
 *  - pending: kept pending.
 *  - retired: retirement stands, and a `retirement-adopted` event at the new
 *    generation makes it the effective release generation.
 */
export interface CheckpointSettlement {
  /** The side not selected, kept in history; both sides for a `--value` resolution. */
  readonly discarded: unknown;
  /** Every value each settled conflict held (base, ours, theirs), whole tickets or field values. */
  readonly snapshots: readonly unknown[];
  /** The `checkpointEvidence` each side had, when evidence was part of the conflict. */
  readonly evidenceChoices: readonly unknown[];
  readonly sidesHadCheckpoint: boolean;
  readonly actor: string;
}

export async function settleCheckpointConflict(
  prior: Readonly<Record<string, unknown>>,
  resolved: Record<string, unknown>,
  settlement: CheckpointSettlement,
  root: string,
): Promise<Ticket> {
  const { discarded, snapshots, evidenceChoices, sidesHadCheckpoint, actor } = settlement;
  const label = typeof resolved.displayId === "string" ? resolved.displayId : String(resolved.id);
  const refuse = (why: string): never => {
    throw new CliValidationError("conflict", `Cannot resolve ${label} this way: ${why}`);
  };
  const evidenceChanged = !sameValue(prior.checkpointEvidence, resolved.checkpointEvidence);
  if (evidenceChanged && !evidenceChoices.some((e) => sameValue(e, resolved.checkpointEvidence))) {
    refuse("the selected checkpointEvidence is not either side's; evidence is adopted as a side had it, never edited.");
  }
  // Only this settlement writes a checkpoint and a side's evidence together.
  const authority = evidenceChanged ? CONFLICT_SETTLEMENT_AUTHORITY : LIFECYCLE_AUTHORITY;
  const established = sidesHadCheckpoint || hasOwnerCheckpoint(prior);
  // Deleted by either marker, whenever any version this settlement saw carries a checkpoint.
  const deleting = resolved.lifecycle === "deleted" || (resolved.deletedAt !== undefined && resolved.deletedAt !== null);
  const carriedAnywhere = established || hasOwnerCheckpoint(resolved)
    || snapshots.some((v) => v !== null && typeof v === "object" && hasOwnerCheckpoint(v));
  if (deleting && carriedAnywhere) {
    refuse("an owner checkpoint is never deleted; pick the side that keeps it, and retire it afterwards if it is no longer needed.");
  }
  if (!hasOwnerCheckpoint(resolved)) {
    if (established) refuse("the selected side drops the owner checkpoint, which is never removed; pick the side that keeps it.");
    const next = { ...resolved } as Ticket;
    await writeTicketUnlocked(next, root, evidenceChanged ? { authority } : undefined);
    return next;
  }

  const parsed = OwnerCheckpointSchema.safeParse(resolved.ownerCheckpoint);
  if (!parsed.success) refuse(`the selected checkpoint does not validate (${parsed.error!.issues.map((i) => i.message).join("; ")}).`);
  const sel = parsed.data!;
  if (checkpointDigest(sel) !== sel.digest) refuse("the selected checkpoint's digest does not match its content.");
  const status = resolved.status;
  if (status === "inprogress") refuse("a checkpoint is never in progress.");
  const r = sel.resolution;
  const resolutionCurrent = r !== undefined && r.generation === sel.generation && r.revision === sel.revision && r.digest === sel.digest;
  if (sel.lifecycle === "active") {
    if (r !== undefined && !resolutionCurrent) refuse("the selected answer does not match the selected checkpoint's generation, revision or digest.");
    if (r !== undefined && status !== "complete") refuse("the selected side is answered but its ticket is not complete.");
    if (r === undefined && status === "complete") refuse("the selected side is complete but has no answer.");
  }

  const generationOf = (v: unknown): number => {
    if (v === null || typeof v !== "object") return 0;
    const record = hasOwnerCheckpoint(v) ? (v as { ownerCheckpoint: unknown }).ownerCheckpoint : v;
    const g = (record as { generation?: unknown } | null)?.generation;
    return typeof g === "number" ? g : 0;
  };
  const generation = nextCounter(Math.max(sel.generation, generationOf(prior), ...snapshots.map(generationOf)), "generation");
  const at = new Date().toISOString();
  const approvedSide = sel.lifecycle === "active" && r !== undefined;
  const after = { ...(approvedSide ? without(sel, ["resolution"]) : sel), generation } as OwnerCheckpoint;
  const settled: CheckpointHistoryEntry = {
    ...historyEntry(after, "conflict-resolved", actor, at, approvedSide ? { displaced: r } : undefined),
    discarded,
  };
  const history = [...sel.history, settled];
  if (sel.lifecycle === "retired") history.push(historyEntry(after, "retirement-adopted", actor, at));
  const record = validated({ ...after, history });
  const fields: Record<string, unknown> = approvedSide ? { status: "open", completedDate: null } : {};
  const next = { ...resolved, ...fields, ownerCheckpoint: record } as Ticket;
  await writeTicketUnlocked(next, root, { authority });
  return next;
}
