/**
 * The send path with the wake tier attached.
 *
 * WHY THIS IS A SEPARATE MODULE, and not a call inside `sendBusMessage`: the wake
 * must never be able to fail a send. `sendBusMessage` commits the mail and returns;
 * only then does anything here run, outside its transaction. Section 7 of the T-489
 * plan calls that isolation structural rather than defensive, and a module boundary
 * is what makes it structural: `store.ts` has no import of the wake at all, so no
 * future edit inside the store transaction can reach it by accident.
 *
 * Both send surfaces (the `bus send` CLI command and the `storybloq_bus_send` MCP
 * tool) go through this one function, so the tier cannot be live on one and dead on
 * the other.
 */

import { sendBusMessage, type BusSendInput, type BusSendResult } from "./store.js";
import { wakeAfterSend } from "./wake-runner.js";
import { BUS_WAKE_TEXT, wakeTelemetry, wakeWanted } from "./wake.js";
import { listEndpoints } from "./endpoints.js";

/**
 * A send result plus what the wake tier did.
 *
 * `wake` is ABSENT, not `null`, when there was no attempt to describe: an endpoint
 * that never opted in, a send that committed no mail. Absence and a recorded
 * outcome are different facts and a reader must be able to tell them apart.
 */
export type BusSendWithWakeResult = BusSendResult & { readonly wake?: string };

export async function sendBusMessageWithWake(
  root: string,
  input: BusSendInput,
): Promise<BusSendWithWakeResult> {
  const sent = await sendBusMessage(root, input);
  // AFTER the send has resolved, never inside it. If this line is ever moved
  // above the await, or into `sendBusMessage`, the isolation is gone.
  const wake = await wakeForSend(root, sent);
  return wake === null ? sent : { ...sent, wake };
}

/**
 * Wake the recipient of a just-committed send.
 *
 * Returns the telemetry string for the send result, or null when no attempt was
 * made. NEVER THROWS: the mail is already committed and the caller's send stands.
 */
export async function wakeForSend(root: string, sent: BusSendResult): Promise<string | null> {
  try {
    // NO *NEW* MAIL, NO WAKE. Three shapes, one rule:
    //  - a parked send was refused at the hop cap;
    //  - a null messageId means nothing landed in a mailbox;
    //  - a REPLAY committed nothing new. It returns the original messageId with
    //    `parked: false`, so it looks exactly like a fresh send here, and without
    //    this clause retrying an idempotency key would start another turn on the
    //    peer and append another wake entry. That is precisely the retry the plan
    //    ruled out (section 1: one send, at most one wake attempt), arriving
    //    through the back door. It would also misattribute: the cursor comes from
    //    the CURRENT mailbox high-water, so a replay would carry unrelated newer
    //    mail's sequence on the replayed message's thread.
    // A wake is not a recovery mechanism, so a failed first wake is NOT retried by
    // replaying the send.
    if (sent.parked || sent.messageId === null || sent.replayed) return null;

    const listed = await listEndpoints(root);
    const recipient = listed.endpoints.find(
      (candidate) => candidate.endpointId === sent.toEndpoint,
    );
    // An unreadable recipient is not a reason to guess. Without the endpoint there
    // is no policy to honour and no thread id to wake.
    if (!recipient) return null;

    // The policy short-circuit is here as well as in gate 1, from the SAME
    // predicate, so the two cannot drift. Gate 1 is the authority for anyone
    // calling `attemptWake` directly; this is what keeps an endpoint that never
    // opted in from costing a send anything at all.
    if (!wakeWanted(recipient)) return null;

    const outcome = await wakeAfterSend({
      root,
      threadId: sent.threadId,
      recipient,
      wakeText: BUS_WAKE_TEXT,
    });
    return wakeTelemetry(outcome);
  } catch {
    // The mail is committed. A wake that blows up must be invisible to the sender
    // beyond the absent `wake` field, or the tier is worse than not having it.
    return null;
  }
}
