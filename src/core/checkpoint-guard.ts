/**
 * T-537: the write-layer guard for owner checkpoints. `prepareTicketWrite`
 * (project-loader.ts) calls `assertCheckpointWriteAllowed` with the ticket as
 * it is on disk and as it is about to be written, so every writer that goes
 * through the ordinary choke point is covered whether or not it knows about
 * checkpoints.
 *
 * Authority is an in-process symbol, never persisted and never crossing MCP.
 * Each symbol may be imported only by the module that owns it (pinned by
 * test/core/checkpoint-guard.test.ts):
 *  - LIFECYCLE_AUTHORITY: core/checkpoint-lifecycle.ts, the only writer of a
 *    checkpoint's status, completion date, ticket lifecycle or record;
 *  - COMPLETION_EVIDENCE_AUTHORITY and CONFLICT_EVIDENCE_AUTHORITY:
 *    core/checkpoint-evidence.ts (`completeDependent`, `adoptConflictEvidence`),
 *    the only writers of `checkpointEvidence`;
 *  - CONFLICT_SETTLEMENT_AUTHORITY: core/checkpoint-lifecycle.ts
 *    (`settleCheckpointConflict` only), the one write that settles a
 *    checkpoint conflict and adopts a selected side's evidence together.
 * Neither lifecycle nor evidence authority covers the other's fields; only
 * the settlement covers both.
 */
import { ProjectLoaderError } from "./errors.js";
import { hasOwnerCheckpoint } from "./owner-checkpoint.js";

export const LIFECYCLE_AUTHORITY: unique symbol = Symbol("checkpoint-lifecycle");
export const COMPLETION_EVIDENCE_AUTHORITY: unique symbol = Symbol("checkpoint-completion-evidence");
export const CONFLICT_EVIDENCE_AUTHORITY: unique symbol = Symbol("checkpoint-conflict-evidence");
export const CONFLICT_SETTLEMENT_AUTHORITY: unique symbol = Symbol("checkpoint-conflict-settlement");

export type CheckpointWriteAuthority =
  | typeof LIFECYCLE_AUTHORITY
  | typeof COMPLETION_EVIDENCE_AUTHORITY
  | typeof CONFLICT_EVIDENCE_AUTHORITY
  | typeof CONFLICT_SETTLEMENT_AUTHORITY;

type Raw = Readonly<Record<string, unknown>>;

/** Key-order-insensitive equality; an absent key and `undefined` are the same. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

const present = (v: unknown): boolean => v !== undefined && v !== null;

function label(t: Raw): string {
  return typeof t.displayId === "string" ? t.displayId : String(t.id);
}

function refuse(message: string): never {
  throw new ProjectLoaderError("conflict", message);
}

/**
 * Refuses a ticket write the caller is not authorised to make. `prior` is the
 * ticket on disk (null when the write creates it).
 *
 * On a ticket that has or had `ownerCheckpoint`:
 *  - a change to status, completedDate, the ticket lifecycle or the record
 *    itself (removal included) needs LIFECYCLE_AUTHORITY (or the settlement);
 *  - a claim, an earmark, a session claim or inprogress is refused with or
 *    without it: nobody works on a checkpoint, the owner answers it.
 * On ANY ticket, a `checkpointEvidence` change needs one of the two evidence
 * authorities (or the settlement).
 */
export function assertCheckpointWriteAllowed(prior: Raw | null, next: Raw, authority?: CheckpointWriteAuthority): void {
  const priorCheckpoint = prior !== null && hasOwnerCheckpoint(prior);
  const nextCheckpoint = hasOwnerCheckpoint(next);

  if (priorCheckpoint || nextCheckpoint) {
    const changed = (key: string) => !sameValue(prior?.[key], next[key]);
    const lifecycleChanged = ["ownerCheckpoint", "status", "completedDate", "lifecycle"].filter(changed);
    if (lifecycleChanged.length > 0 && authority !== LIFECYCLE_AUTHORITY && authority !== CONFLICT_SETTLEMENT_AUTHORITY) {
      refuse(
        `${label(next)} is an owner checkpoint: ${lifecycleChanged.join(", ")} change only through the checkpoint commands ` +
          "(resolve, change, reopen, retire). A checkpoint is never deleted; retire it instead.",
      );
    }
    if (nextCheckpoint) {
      const worked = [
        next.status === "inprogress" && (changed("status") || !priorCheckpoint) ? "inprogress" : null,
        present(next.claim) && (changed("claim") || !priorCheckpoint) ? "claim" : null,
        present(next.claimedBySession) && (changed("claimedBySession") || !priorCheckpoint) ? "claimedBySession" : null,
        present(next.earmark) && (changed("earmark") || !priorCheckpoint) ? "earmark" : null,
      ].filter((x): x is string => x !== null);
      if (worked.length > 0) {
        refuse(`${label(next)} is an owner checkpoint and cannot be started, claimed or earmarked (${worked.join(", ")}): the owner answers it.`);
      }
    }
  }

  if (!sameValue(prior?.checkpointEvidence, next.checkpointEvidence)
    && authority !== COMPLETION_EVIDENCE_AUTHORITY
    && authority !== CONFLICT_EVIDENCE_AUTHORITY
    && authority !== CONFLICT_SETTLEMENT_AUTHORITY) {
    refuse(`${label(next)}: checkpointEvidence is written only when the ticket completes; it cannot be edited, set or removed directly.`);
  }
}

/**
 * The prior ticket from the file's text, for the guard. Only a missing file
 * is absent. An existing file that does not parse as a JSON object refuses
 * the write, whatever its text holds: a substring search is no proof (an
 * escaped key in truncated JSON hides from it), and what the write would
 * overwrite is unknown. Such a file is fixed by hand (`storybloq repair`
 * refuses it too), never overwritten or deleted.
 */
export function priorForGuard(text: string | null, target: string): Raw | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Raw;
  refuse(`${target} exists but does not parse as a ticket object, so it may hold an owner checkpoint or checkpoint evidence. Fix the file by hand first (\`storybloq repair\` refuses a file that does not parse, too); it is never overwritten or deleted as it stands.`);
}
