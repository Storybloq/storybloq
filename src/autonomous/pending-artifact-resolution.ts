/**
 * The mint point for `ResolvedTicketIdentities`.
 *
 * It lives here rather than in `pending-artifacts.ts` for two reasons. The
 * classifier is pure over an already-loaded observation and must stay that way,
 * and more importantly the brand is only worth anything if the value can be
 * produced in exactly ONE place that does the real work. A function that took a
 * list and handed it back branded would authenticate nothing: the caller could
 * pass the very list it was being asked to verify, which is a guard whose two
 * sides come from one source (L-038).
 *
 * So this takes a project state and resolves against it. The classifier then
 * consumes the branded result and never resolves anything itself.
 */
import type { ProjectState } from "../core/project-state.js";
import { resolveAndNormalizeTicketRefs, RefResolutionError } from "../core/ref-normalization.js";
import { ownStringArray } from "./pending-artifacts.js";
import { markResolvedTicketIdentities } from "./resolved-identities.js";
import type { ResolvedTicketIdentities } from "./session-types.js";

/**
 * Resolve a stored payload's ticket references against the ledger as it is now.
 *
 * Returns null when they cannot be resolved, which is a real answer rather than
 * an error: a record naming a ticket that no longer exists, or one that is
 * ambiguous, is a record recovery must refuse to replay. The classifier turns
 * that null into a quarantine.
 *
 * Non-resolution failures are rethrown. Swallowing them would report "these
 * refs do not resolve" for a bug that had nothing to do with the refs.
 */
export function resolvePayloadTicketIdentities(
  state: ProjectState,
  refs: readonly string[],
): ResolvedTicketIdentities | null {
  // The SAME own-data reader the classifier uses, not a second spelling of it.
  // It refuses holes, extra own properties, symbol keys and accessor elements,
  // and it returns a fresh copy read through descriptors -- so no getter is
  // invoked, nothing is read twice, and what gets resolved is exactly what was
  // checked. `Object.keys` plus `every` could do none of that: `every` skips
  // holes and invokes accessors, a spread invokes them a second time, and an
  // unrelated enumerable property can balance a missing index in the count.
  const checked = ownStringArray(refs);
  if (checked === null) return null;
  if (checked.some((r) => r.length === 0)) return null;
  try {
    return markResolvedTicketIdentities(resolveAndNormalizeTicketRefs(state, [...checked]));
  } catch (error) {
    if (error instanceof RefResolutionError) return null;
    throw error;
  }
}
