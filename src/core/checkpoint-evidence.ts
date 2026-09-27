/**
 * T-537: the only two writers of `checkpointEvidence`.
 *
 *  - `completeDependent` is every completion: it refuses while a checkpoint
 *    the ticket waits on has not released, and otherwise records which
 *    checkpoint state the completion relied on.
 *  - `adoptConflictEvidence` takes one side's evidence verbatim when a
 *    conflict on a dependent is resolved; it never regenerates.
 *
 * Both must run under the project lock, against the state that lock loaded.
 */
import { COMPLETION_EVIDENCE_AUTHORITY, CONFLICT_EVIDENCE_AUTHORITY } from "./checkpoint-guard.js";
import {
  checkpointApproved,
  checkpointDigest,
  hasOwnerCheckpoint,
  parseOwnerCheckpoint,
  pendingCheckpointBlockers,
  type CheckpointEvidenceEntry,
  type CheckpointResolver,
} from "./owner-checkpoint.js";
import { writeTicketUnlocked } from "./project-loader.js";
import { displayIdOf } from "./resolver.js";
import type { Ticket } from "../models/ticket.js";

export type CompletionOutcome =
  | { readonly kind: "completed"; readonly ticket: Ticket }
  | { readonly kind: "checkpoint-blocked"; readonly checkpoints: readonly string[] };

/**
 * Evidence for a completion now: one entry per checkpoint in blockedBy, each
 * of which releases (the caller has checked). A checkpoint that stopped
 * parsing between the check and here cannot, since both run under one lock.
 */
export function evidenceFor(resolver: CheckpointResolver, ticket: Pick<Ticket, "blockedBy">): CheckpointEvidenceEntry[] {
  const out: CheckpointEvidenceEntry[] = [];
  const seen = new Set<string>();
  for (const ref of ticket.blockedBy) {
    const r = resolver.resolveTicketRef(ref);
    if (r.kind !== "found" || !hasOwnerCheckpoint(r.item) || seen.has(r.item.id)) continue;
    const p = parseOwnerCheckpoint(r.item);
    if (p.kind !== "ok") continue;
    seen.add(r.item.id);
    const cp = p.checkpoint;
    out.push({
      checkpoint: r.item.id,
      generation: cp.generation,
      revision: cp.revision,
      digest: checkpointDigest(cp),
      state: checkpointApproved(r.item) ? "approved" : "retired",
    });
  }
  return out;
}

/**
 * Completes `candidate` (status complete, every other change already applied
 * by the caller) and writes it, or returns the checkpoints it waits on
 * without writing anything. Also the re-completion of an already complete
 * ticket, which is how a reassessment flag clears.
 *
 * The evidence is replaced wholesale by the checkpoints current now. A ticket
 * that waits on none keeps no evidence: an entry naming a checkpoint it no
 * longer depends on would flag forever (reassessment row 1).
 */
export async function completeDependent(state: CheckpointResolver, candidate: Ticket, root: string): Promise<CompletionOutcome> {
  if (candidate.status !== "complete") {
    throw new Error(`completeDependent: ${candidate.id} is not being completed (status ${candidate.status})`);
  }
  const blocked = pendingCheckpointBlockers(state, candidate);
  if (blocked.length > 0) return { kind: "checkpoint-blocked", checkpoints: blocked };

  const evidence = evidenceFor(state, candidate);
  const next: Record<string, unknown> = { ...candidate };
  if (evidence.length > 0) next.checkpointEvidence = evidence;
  else delete next.checkpointEvidence;
  const ticket = next as Ticket;
  await writeTicketUnlocked(ticket, root, { authority: COMPLETION_EVIDENCE_AUTHORITY });
  return { kind: "completed", ticket };
}

/**
 * Writes `resolved` (a conflict resolution on a dependent) carrying the
 * selected side's evidence exactly as that side had it, or none when that
 * side had none.
 */
export async function adoptConflictEvidence(resolved: Ticket, side: Readonly<Record<string, unknown>>, root: string): Promise<Ticket> {
  const next: Record<string, unknown> = { ...resolved };
  if (side.checkpointEvidence !== undefined) next.checkpointEvidence = side.checkpointEvidence;
  else delete next.checkpointEvidence;
  const ticket = next as Ticket;
  await writeTicketUnlocked(ticket, root, { authority: CONFLICT_EVIDENCE_AUTHORITY });
  return ticket;
}

export type CheckpointEligibilityOp = "claim" | "start" | "complete";

export type CheckpointEligibility =
  | { readonly kind: "eligible" }
  | { readonly kind: "is-checkpoint" }
  | { readonly kind: "checkpoint-blocked"; readonly checkpoints: readonly string[] };

/**
 * Whether `ticket` may be claimed, started or completed as ordinary work.
 * An owner checkpoint never is (the owner answers it through the lifecycle
 * commands), and a ticket that waits on a checkpoint that has not released
 * is not until it does. Returned, never thrown, so no broad catch can turn
 * it into an I/O error; run it under the project lock, against the state that
 * lock loaded.
 */
export function assertCheckpointEligible(
  state: CheckpointResolver,
  ticket: Ticket,
  _op: CheckpointEligibilityOp,
): CheckpointEligibility {
  if (hasOwnerCheckpoint(ticket)) return { kind: "is-checkpoint" };
  const checkpoints = pendingCheckpointBlockers(state, ticket);
  return checkpoints.length > 0 ? { kind: "checkpoint-blocked", checkpoints } : { kind: "eligible" };
}

/** A refusal sentence for an ineligible result, naming checkpoints by display id. */
export function describeIneligible(
  state: CheckpointResolver & { ticketByID(id: string): Ticket | undefined },
  ticket: Ticket,
  op: CheckpointEligibilityOp,
  result: Exclude<CheckpointEligibility, { kind: "eligible" }>,
): string {
  const label = displayIdOf(ticket);
  if (result.kind === "is-checkpoint") {
    return `Cannot ${op} ${label}: it is an owner checkpoint. The owner answers it (resolve, change, reopen or retire); it is never worked as a ticket.`;
  }
  const names = result.checkpoints.map((c) => {
    const t = state.ticketByID(c);
    return t ? displayIdOf(t) : c;
  });
  if (op === "complete") return describeCheckpointBlock(label, names);
  return `Cannot ${op} ${label}: it waits on owner checkpoint${names.length === 1 ? "" : "s"} ${names.join(", ")}, not yet approved or retired.`;
}

export function describeCheckpointBlock(ticketLabel: string, checkpoints: readonly string[]): string {
  return `Cannot complete ${ticketLabel}: it waits on owner checkpoint${checkpoints.length === 1 ? "" : "s"} ${checkpoints.join(", ")}, ` +
    "not yet approved or retired. The owner answers a checkpoint; completing the dependent first would skip that answer.";
}
