/**
 * T-328: the single decode boundary for `branchStrategy`.
 *
 * The value used to be declared independently in seven places (a zod enum in
 * project config, a second zod enum gating persisted session reads, a
 * hand-written allowlist in the guide, a cast on resume, and three TS unions in
 * the recipe loader / session / stage types). Widening a union spread that thin
 * is how a partial widening ships: six sites learn the new value and the seventh
 * silently drops or rejects it.
 *
 * The two sets below are deliberately different, and every consumer states which
 * one it means:
 *
 * - BRANCH_STRATEGIES is canonical. It is what gets persisted and what code
 *   compares against.
 * - ACCEPTED_BRANCH_STRATEGY_INPUTS is what may arrive from outside. It adds the
 *   legacy "none", the spelling every project written before this ticket
 *   carries. "none" is normalized away at the boundary, so it is never canonical
 *   and is never newly written.
 */

/** Canonical values. What is persisted and what code compares against. */
export type BranchStrategy = "current" | "per-ticket" | "main";

export const BRANCH_STRATEGIES: readonly BranchStrategy[] = ["current", "per-ticket", "main"];

/**
 * The released default. `"current"` is the canonical spelling of the behavior
 * that shipped as `"none"`: work on whatever branch is checked out.
 */
export const DEFAULT_BRANCH_STRATEGY: BranchStrategy = "current";

/**
 * The pre-T-328 spelling of `"current"`. Accepted forever so existing configs
 * and in-flight sessions keep working.
 *
 * ISS-902: this is also what session state.json PERSISTS for the no-op
 * strategy. See toPersistedBranchStrategy.
 */
export const LEGACY_BRANCH_STRATEGY_ALIAS = "none";

/** Every spelling accepted from outside: canonical values plus the legacy alias. */
export const ACCEPTED_BRANCH_STRATEGY_INPUTS: readonly string[] = [
  ...BRANCH_STRATEGIES,
  LEGACY_BRANCH_STRATEGY_ALIAS,
];

/**
 * Normalize an external value to a canonical one.
 *
 * Returns null for anything unrecognized rather than falling back to the
 * default: a caller that cannot tell "absent" from "misspelled" would silently
 * accept `branchStrategy: "trunk"` and quietly do something else. Callers that
 * genuinely want a fallback apply DEFAULT_BRANCH_STRATEGY themselves.
 */
export function parseBranchStrategy(value: unknown): BranchStrategy | null {
  if (typeof value !== "string") return null;
  if (value === LEGACY_BRANCH_STRATEGY_ALIAS) return "current";
  return (BRANCH_STRATEGIES as readonly string[]).includes(value)
    ? (value as BranchStrategy)
    : null;
}

/** Normalize, falling back to the default for absent or unrecognized input. */
export function parseBranchStrategyOrDefault(value: unknown): BranchStrategy {
  return parseBranchStrategy(value) ?? DEFAULT_BRANCH_STRATEGY;
}

/**
 * ISS-902: the spelling written to session state.json. The inverse of
 * parseBranchStrategy, and the reason that function must accept the alias
 * forever.
 *
 * `"current"` stays canonical in memory, but persisting it strands in-flight
 * sessions. Every reader shipped before T-328 declares
 * `resolvedBranchStrategy` as `z.enum(["none", "per-ticket"])`, so a persisted
 * `"current"` fails safeParse on the WHOLE state file: the session then reads
 * as missing rather than as unreadable, and cannot be resumed, reported
 * against, or finalized until the client restarts. Enum widening cannot be
 * made forward compatible after the fact, so the no-op strategy keeps writing
 * the spelling old readers already accept.
 *
 * This does not fix `"main"`, which no pre-T-328 reader can parse. That
 * residual is accepted because `"main"` is opt-in, where `"current"` is the
 * DEFAULT and so would otherwise break every session.
 */
export function toPersistedBranchStrategy(strategy: BranchStrategy): string {
  return strategy === "current" ? LEGACY_BRANCH_STRATEGY_ALIAS : strategy;
}
