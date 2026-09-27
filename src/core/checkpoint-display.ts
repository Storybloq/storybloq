/**
 * T-537 S5: what every surface shows for an owner checkpoint. `ticket get`,
 * `ticket list`, `status` and `checkpoint list` read the same summary, so the
 * state a caller acts on (and the expected state a change must name) cannot
 * differ between them.
 */
import type { Ticket } from "../models/ticket.js";
import { checkpointState, parseOwnerCheckpoint, type CheckpointDisplayState } from "./owner-checkpoint.js";
import type { ExpectedCheckpoint } from "./checkpoint-lifecycle.js";
import { displayIdOf } from "./resolver.js";

export interface CheckpointSummary {
  readonly id: string;
  readonly title: string;
  readonly state: CheckpointDisplayState;
  readonly kind?: string;
  readonly owner?: string;
  readonly question?: string;
  readonly criteria?: string;
  readonly expected?: ExpectedCheckpoint;
  readonly reason?: string;
}

export function checkpointSummary(ticket: Ticket): CheckpointSummary | null {
  const state = checkpointState(ticket);
  if (state === null) return null;
  const id = displayIdOf(ticket);
  const p = parseOwnerCheckpoint(ticket);
  if (p.kind !== "ok") return { id, title: ticket.title, state, reason: p.kind === "unrecognized" ? p.reason : undefined };
  const cp = p.checkpoint;
  return {
    id,
    title: ticket.title,
    state,
    kind: cp.kind,
    owner: cp.owner,
    ...(cp.question !== undefined ? { question: cp.question } : {}),
    ...(cp.criteria !== undefined ? { criteria: cp.criteria } : {}),
    expected: { generation: cp.generation, revision: cp.revision, digest: cp.digest },
  };
}

export type CheckpointCounts = Record<CheckpointDisplayState, number>;

export function checkpointCounts(tickets: readonly Ticket[]): CheckpointCounts {
  const counts: CheckpointCounts = { pending: 0, approved: 0, retired: 0, unrecognized: 0 };
  for (const t of tickets) {
    const s = checkpointState(t);
    if (s !== null) counts[s]++;
  }
  return counts;
}
