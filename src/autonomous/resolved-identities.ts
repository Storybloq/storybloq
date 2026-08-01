/**
 * The runtime proof behind `ResolvedTicketIdentities`.
 *
 * A branded TYPE cannot survive a cast, and canonicality cannot be inferred
 * from an id's SYNTAX: this ledger is permanently mixed, so a legacy ticket's
 * canonical id is its display-form value (`T-001`) while a post-migration
 * ticket's is a hash (`t-...`). A rule that read the hash form as "canonical"
 * would quarantine every create linked to a legacy ticket, forever.
 *
 * So the proof is a registry instead. A value counts as a resolution only if it
 * is the exact object a resolver handed back. Copying a record's own list, or
 * casting one, produces an object that was never registered and is refused.
 *
 * The honest limit: `markResolvedTicketIdentities` is exported, so any code that
 * imports this module can register anything. That is the ceiling for a
 * single-process module boundary. What it buys is that forging a resolution is
 * now a deliberate, greppable act rather than an ordinary cast.
 */
import type { ResolvedTicketIdentities } from "./session-types.js";

const REGISTRY = new WeakSet<object>();

/**
 * Register a resolver's output. Called only by the resolution module; frozen so
 * the registered object cannot be edited into something else after the fact.
 */
export function markResolvedTicketIdentities(ids: readonly string[]): ResolvedTicketIdentities {
  const frozen = Object.freeze([...ids]);
  REGISTRY.add(frozen);
  return frozen as unknown as ResolvedTicketIdentities;
}

/** Did this exact object come out of a resolver? */
export function isResolvedTicketIdentities(value: unknown): value is ResolvedTicketIdentities {
  return typeof value === "object" && value !== null && REGISTRY.has(value);
}
