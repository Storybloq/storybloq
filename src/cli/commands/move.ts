import { resolve } from "node:path";
import { generateKeyBetween, compareByRank, rebalanceRanks } from "../../core/fractional-index.js";
import { displayIdOf } from "../../core/resolver.js";
import type { Ticket } from "../../models/index.js";
import type { CommandResult } from "../types.js";

export interface MoveOptions {
  after?: string;
  before?: string;
  format?: "md" | "json";
}

export async function handleTicketMove(
  id: string,
  root: string,
  options: MoveOptions,
): Promise<CommandResult> {
  const format = options.format ?? "md";

  // ISS-805: the three pre-lock validations must honor --format json too, using
  // the same { ok:false, error } shape the in-lock fail() helper below emits.
  const earlyFail = (message: string): CommandResult => ({
    output: format === "json"
      ? JSON.stringify({ ok: false, error: message }, null, 2)
      : `Error: ${message}`,
    exitCode: 1,
  });

  if (options.after && options.before) {
    return earlyFail("specify --after or --before, not both.");
  }
  if (!options.after && !options.before) {
    return earlyFail("specify --after or --before.");
  }

  const targetRef = (options.after ?? options.before)!;
  if (targetRef === id) {
    return earlyFail("cannot move a ticket relative to itself.");
  }

  const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");

  let output = "";
  let exitCode: 0 | 1 = 0;
  const fail = (message: string): void => {
    output = format === "json"
      ? JSON.stringify({ ok: false, error: message }, null, 2)
      : `Error: ${message}`;
    exitCode = 1;
  };

  await withProjectLock(root, { strict: false }, async ({ state }) => {
    // ISS-753: resolve both refs at the display boundary (canonical id, displayId,
    // previous displayId) instead of canonical-id-only lookup, so the T-NNN display
    // IDs the CLI itself prints are movable in team mode.
    const ticketRes = state.resolveTicketRef(id);
    if (ticketRes.kind === "ambiguous") {
      fail(`ticket reference "${id}" is ambiguous; matches: ${ticketRes.matches.map((m) => m.id).join(", ")}. Use a canonical id.`);
      return;
    }
    if (ticketRes.kind === "missing") {
      fail(`ticket ${id} not found.`);
      return;
    }
    const ticket = ticketRes.item;

    const targetRes = state.resolveTicketRef(targetRef);
    if (targetRes.kind === "ambiguous") {
      fail(`target ticket reference "${targetRef}" is ambiguous; matches: ${targetRes.matches.map((m) => m.id).join(", ")}. Use a canonical id.`);
      return;
    }
    if (targetRes.kind === "missing") {
      fail(`target ticket ${targetRef} not found.`);
      return;
    }
    const target = targetRes.item;

    // Self-move via mixed refs (canonical id on one side, its own displayId on the
    // other): the raw string check above cannot catch this; only post-resolution
    // identity can.
    if (target.id === ticket.id) {
      fail(`cannot move a ticket relative to itself.`);
      return;
    }

    if (ticket.phase !== target.phase) {
      fail(`${displayIdOf(ticket)} (phase ${ticket.phase}) and ${displayIdOf(target)} (phase ${target.phase}) are in different phases.`);
      return;
    }

    const siblings: Ticket[] = state.phaseTickets(ticket.phase)
      .filter((t) => t.id !== ticket.id)
      .sort(compareByRank);

    const targetIdx = siblings.findIndex((s) => s.id === target.id);
    if (targetIdx === -1) {
      fail(`target ${displayIdOf(target)} not found in phase siblings.`);
      return;
    }

    // ISS-753: rank backfill. Tickets are never assigned a rank at creation, so in
    // the default state every sibling is unranked; ranking only the moved ticket
    // yanks it to the top/bottom because compareByRank sorts ranked before unranked.
    // Materialize a rank onto every unranked sibling first, preserving the currently
    // displayed (compareByRank) order exactly, then compute the move bounds against
    // the fully ranked sibling list. All writes happen under this same project lock.
    //
    // Decided disclosure: writeTicketUnlocked also persists the loader-derived
    // displayId (= id) that loadProject injects in-memory onto legacy ticket files
    // (project-loader.ts legacy classification). Accepted deliberately: semantically
    // a no-op (displayIdOf falls back to id), loader-idempotent, one-time churn.
    if (siblings.some((s) => s.rank == null)) {
      if (siblings.every((s) => s.rank == null)) {
        // All unranked: assign evenly spread ranks in displayed order.
        const ranks = rebalanceRanks(siblings.length);
        for (let i = 0; i < siblings.length; i++) {
          const updated: Ticket = { ...siblings[i]!, rank: ranks[i]! };
          // T-481: rank is ordering, not content; a move never stamps.
          await writeTicketUnlocked(updated, resolve(root), { touch: false });
          siblings[i] = updated;
        }
      } else {
        // Mixed: ranked siblings sort before unranked ones, so the unranked tail
        // appends after the highest existing rank. Walk the displayed order and give
        // each unranked sibling generateKeyBetween(prevRank, null) sequentially (the
        // next-existing bound is always null for the tail).
        let prev: string | null = null;
        for (let i = 0; i < siblings.length; i++) {
          let sibling = siblings[i]!;
          if (sibling.rank == null) {
            sibling = { ...sibling, rank: generateKeyBetween(prev, null) };
            await writeTicketUnlocked(sibling, resolve(root), { touch: false });
            siblings[i] = sibling;
          }
          prev = sibling.rank!;
        }
      }
    }

    // Lower/upper rank bounds for the new position. For --after we slot between the
    // target and its next sibling; for --before, between the previous sibling and
    // the target.
    let lo: string | null;
    let hi: string | null;
    if (options.after) {
      lo = siblings[targetIdx]!.rank ?? null;
      hi = targetIdx + 1 < siblings.length ? (siblings[targetIdx + 1]!.rank ?? null) : null;
    } else {
      lo = targetIdx > 0 ? (siblings[targetIdx - 1]!.rank ?? null) : null;
      hi = siblings[targetIdx]!.rank ?? null;
    }

    let newRank: string;
    try {
      // ISS-688: the spec allows duplicate ranks, so the immediate bounds can be
      // equal (or non-increasing) and there is no value strictly between them. Rather
      // than let generateKeyBetween's midpoint() throw (which surfaced as an opaque
      // io_error), widen the bound past the duplicate-rank group to the nearest
      // DISTINCT sibling, so the ticket lands just after/before the group and still
      // before/after the next distinct sibling (siblings are sorted ascending by rank).
      if (lo !== null && hi !== null && lo >= hi) {
        if (options.after) {
          let upper: string | null = null;
          for (let j = targetIdx + 1; j < siblings.length; j++) {
            const r = siblings[j]!.rank;
            if (r != null && r > lo) { upper = r; break; }
          }
          newRank = generateKeyBetween(lo, upper);
        } else {
          let lower: string | null = null;
          for (let j = targetIdx - 1; j >= 0; j--) {
            const r = siblings[j]!.rank;
            if (r != null && r < hi) { lower = r; break; }
          }
          newRank = generateKeyBetween(lower, hi);
        }
      } else {
        newRank = generateKeyBetween(lo, hi);
      }
    } catch {
      // Genuine exhaustion (e.g. moving before the minimum rank): actionable guidance
      // instead of a crash. reconcile --rebalance-ranks restores spread-out ranks.
      fail(`Cannot compute a rank for this move: sibling ranks are duplicated or exhausted. Run \`storybloq reconcile --rebalance-ranks\` and retry.`);
      return;
    }

    const updated: Ticket = { ...ticket, rank: newRank };
    await writeTicketUnlocked(updated, resolve(root), { touch: false });

    if (format === "json") {
      output = JSON.stringify({ ok: true, data: { id: ticket.id, displayId: displayIdOf(ticket), rank: newRank } }, null, 2);
    } else {
      output = `Moved ${displayIdOf(ticket)} ${options.after ? "after" : "before"} ${displayIdOf(target)} (rank: ${newRank}).`;
    }
  });

  return exitCode ? { output, exitCode } : { output };
}
