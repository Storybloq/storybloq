/**
 * The one way a session gives back its own claim (ISS-1405).
 *
 * A write refuses when an unparseable record in the directory might be a
 * misnamed claimant of the same id. Six paths end a session's hold on a ticket
 * (cancel, session stop, session end, skip at three stages), and a dead claim
 * left by that refusal strands the ticket, so here alone that one refusal gives
 * way. Only when the ticket was just loaded under this lock, carries this
 * session's own stamp or assigned earmark, and the write changes nothing but
 * those (and the status back to open). A misnamed claimant that can be seen
 * still refuses, as does a record that cannot be read at all, and the writer is
 * told which file was written past so it can be repaired.
 *
 * The trade-off: a misnamed claimant hidden inside the unparseable file stays
 * hidden, so the release can leave it as a second copy until that file is
 * repaired, when the duplicate check names it.
 *
 * The write and its checks live in project-loader.ts (`releaseOwnClaimUnlocked`),
 * which checks the record on disk, so no caller can vouch for what it loaded.
 */

import type { Ticket } from "../models/ticket.js";
import { MisnamedUnparseableError } from "./resolution-write-guard.js";
import { releaseOwnClaimUnlocked, withProjectLock, writeTicketUnlocked } from "./project-loader.js";

export type OwnClaimRelease =
  /** Nothing was asked of the ledger: `decide` returned null, or the ticket is not there. */
  | { readonly kind: "no-write" }
  | { readonly kind: "released"; readonly file: string; readonly writtenPast: readonly string[] }
  | { readonly kind: "not-released"; readonly file: string; readonly reason: string };

/**
 * Takes the project lock, loads the ticket and writes what `decide` returns
 * (null writes nothing). Never throws: every failure, including the lock's, is
 * returned, so a caller cannot lose one to a catch.
 */
export async function releaseOwnClaim(
  root: string,
  ticketId: string,
  sessionId: string,
  decide: (loaded: Ticket) => Ticket | null,
): Promise<OwnClaimRelease> {
  const file = `.story/tickets/${ticketId}.json`;
  let done: OwnClaimRelease | null = null;
  try {
    await withProjectLock(root, { strict: false }, async ({ state }) => {
      const loaded = state.ticketByID(ticketId) as Ticket | undefined;
      const next = loaded ? decide(loaded) : null;
      if (!loaded || next === null) {
        done = { kind: "no-write" };
        return;
      }
      try {
        await writeTicketUnlocked(next, root);
        done = { kind: "released", file, writtenPast: [] };
      } catch (err) {
        if (!(err instanceof MisnamedUnparseableError)) throw err;
        done = { kind: "released", file, writtenPast: await releaseOwnClaimUnlocked(next, sessionId, root) };
      }
    });
  } catch (err) {
    // A throw after the write or the decision leaves that outcome standing: it happened.
    if (done === null) return { kind: "not-released", file, reason: err instanceof Error ? err.message : String(err) };
  }
  return done ?? { kind: "no-write" };
}

/** What the reader of a reply must know about a release; empty when there is nothing to do. */
export function ownClaimReleaseNote(outcome: OwnClaimRelease): string {
  if (outcome.kind === "not-released") {
    return ` The claim in ${outcome.file} was NOT released and the ticket stays held until it is cleared by hand: ${outcome.reason}`;
  }
  if (outcome.kind === "released" && outcome.writtenPast.length > 0) {
    return ` The claim in ${outcome.file} was released past ${outcome.writtenPast.join(", ")}, which could not be parsed; repair it.`;
  }
  return "";
}
