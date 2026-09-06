/**
 * T-494 scope 3: the plan-pin guard.
 *
 * A plan that is about to be ACCEPTED -- pinned, completed on, or both -- must
 * name the current id of every ruling its item cites. The guard fails closed:
 * anything it cannot resolve to a single current ruling is a refusal, not a
 * pass.
 *
 * WHAT THIS GUARD PROVES, STATED HONESTLY BECAUSE AN EARLIER REVISION
 * OVERCLAIMED IT. An id appearing in a plan proves the id was MENTIONED. It
 * does not prove the ruling was read, understood, or followed. The sharpest
 * form of the gap: a plan can copy ids straight out of the review packet's own
 * text-truncation markers and pass without ever fetching the omitted decision
 * text. A test pins that an id-only mention PASSES, so no later reader mistakes
 * this for evidence of compliance. Substantive compliance is the review's job.
 *
 * Matching is on the ruling id STRING, case-sensitively, anywhere in the plan
 * text. Deliberately crude: a stricter parse (a required header, a fixed
 * format) would refuse plans that comply in substance, and formatting is not
 * what this gate is for.
 */

import { citationsForReviewTarget } from "./cited-rulings.js";
import type { CitationResolution } from "../core/ruling.js";

export type PlanPinGuardVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly instruction: string };

/**
 * The per-citation rule. Returns null when the citation is satisfied, or the
 * sentence naming why it is not.
 *
 * `current.id` and not `citedId` is the required id: `current` is what the
 * renderer actually showed the agent, and the current ruling is the one that
 * binds. Naming the cited id as well is fine; naming only the cited id is not.
 */
function refusalFor(resolution: CitationResolution, planText: string): string | null {
  switch (resolution.status) {
    case "resolved": {
      if (planText.includes(resolution.current.id)) return null;
      return resolution.stale
        ? `${resolution.current.id} (the current ruling superseding the cited ${resolution.citedId}) is not named in the plan`
        : `${resolution.current.id} is not named in the plan`;
    }
    case "missing":
      // A forward reference is a legal transient state for the LEDGER --
      // `resolveCitesRulingsInput` allows it deliberately -- but never for a
      // PIN. Recorded here so a later reader does not "fix" the asymmetry.
      return `${resolution.citedId} is cited but missing from the ledger`;
    case "unreadable":
      return `${resolution.citedId} is cited but its record could not be read`;
    case "indeterminate":
      return `${resolution.citedId} could not be resolved to a current ruling (${resolution.reason})`;
    case "branch":
      return `${resolution.citedId} has competing successors (${resolution.competingSuccessors.join(", ")}), so no single ruling is current`;
    case "cycle":
      return `${resolution.citedId} sits in a supersede cycle (${resolution.chain.join(" -> ")})`;
  }
}

/**
 * Judges `planText` against the citations of `targetId` read FRESH from disk.
 *
 * The item's stored `citesRulings` is the source, never the plan's own copy of
 * it: a plan cannot be allowed to satisfy a guard with a list it supplies
 * itself. An item citing nothing is unaffected -- no citations, no guard, no
 * message.
 */
export async function guardPlanNamesCitedRulings(
  root: string,
  targetId: string | undefined,
  planText: string,
): Promise<PlanPinGuardVerdict> {
  // Fails closed. An unidentifiable target is exactly the case where the guard
  // cannot know what the plan owes, so it refuses rather than waving it past.
  const citations = await citationsForReviewTarget(root, targetId ?? "");
  if (citations.kind === "unavailable") {
    return {
      ok: false,
      instruction: `Cannot verify the plan against the item's cited rulings: ${citations.reason}. Escalate -- do not treat this plan as approved.`,
    };
  }
  if (citations.citations.length === 0) return { ok: true };

  const refusals = citations.citations
    .map((resolution) => refusalFor(resolution, planText))
    .filter((r): r is string => r !== null);
  if (refusals.length === 0) return { ok: true };

  return {
    ok: false,
    instruction: [
      "This plan cannot be accepted until it addresses the rulings its item cites.",
      "",
      ...refusals.map((r) => `- ${r}`),
      "",
      "Read each ruling with `storybloq ruling get <id>`, revise the plan so it names the current id of every cited ruling and accounts for what that ruling requires, then resubmit.",
      "Naming an id is what this gate checks; whether the plan actually follows the ruling is what the review checks.",
    ].join("\n"),
  };
}
