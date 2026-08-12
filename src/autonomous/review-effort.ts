import { normalizeRiskLevel, requiredRounds, reviewRiskForTicket, type RiskLevel } from "./review-depth.js";

/**
 * One dial for how hard review works (T-461).
 *
 * Review is the largest variable in both what a task costs and how long it
 * takes, and until now it was spread across six knobs that had to be set
 * together and mostly could not be. This module is the single place the levels
 * are defined; every consumer asks it rather than deciding for itself.
 *
 * `standard` is today's behavior exactly. That is the contract the rest of the
 * feature is built against, so a session that never sets the dial cannot move.
 *
 * The dial NEVER writes into `resolvedStages`. Everything is derived at read
 * time from the frozen base config plus the item's level, because a session
 * pinned to `light` must still be able to honor a ticket that asks for
 * `thorough`, and a destructive write would have thrown away the base values
 * that request needs.
 *
 * The fix-then-re-review rule is intensity-independent and survives at every
 * level. At `off` no review runs, so no change request can exist and the rule
 * is vacuously satisfied. At every other level CODE_REVIEW stays in the
 * pipeline, and `light` additionally carries the landing guard in
 * code-review.ts, without which its lower round cap would let a change request
 * land unfixed.
 */

export const REVIEW_EFFORTS = ["off", "light", "standard", "thorough"] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];

/** A session default may also defer to per-item size mapping, which is the default. */
export type ReviewEffortDefault = ReviewEffort | "size-mapped";

export type ReviewStageId = "PLAN_REVIEW" | "CODE_REVIEW";

/**
 * Where an item's level came from. Reported, never inferred by consumers.
 *
 * Three groups. ATTRIBUTABLE: `item`, `start-call`, `project` -- someone set
 * this, and a reader can go find where. DERIVED: `size-mapped`. NOT
 * ATTRIBUTABLE, and deliberately three distinct values rather than one, because
 * they send a reader to three different places: `legacy` is a session frozen
 * before the dial existed (held at standard by back-compat, no setting to find),
 * `default` is a session record that claims no origin, and `unknown` is a record
 * whose origin field could not be read (the only one of the three that means
 * something is corrupt).
 *
 * Nothing collapses one of these into another. An earlier version reported the
 * pre-dial case as `project`, which sent a reader hunting for a config setting
 * that was never written.
 */
export type ReviewEffortSource =
  | "item"
  | "start-call"
  | "project"
  | "size-mapped"
  | "legacy"
  | "default"
  | "unknown";

/**
 * Normalize a persisted provenance string to a value this build knows.
 *
 * Provenance is persisted as a bare string (the fields that carry it are
 * deliberately permissive so a damaged record cannot brick a session), so every
 * consumer that reports it has to pass it through here first. Anything
 * unreadable becomes `unknown` rather than being echoed verbatim into a record
 * a person later reads as fact.
 */
export function normalizeReviewEffortSource(value: unknown): ReviewEffortSource {
  return value === "item" || value === "start-call" || value === "project"
    || value === "size-mapped" || value === "legacy" || value === "default"
    ? value
    : "unknown";
}

export function isReviewEffort(value: unknown): value is ReviewEffort {
  return typeof value === "string" && (REVIEW_EFFORTS as readonly string[]).includes(value);
}

/**
 * Normalize an explicit level, failing closed to `standard`.
 *
 * Deliberately the opposite asymmetry from `reviewRiskForTicket`, which fails
 * closed to `high`. Risk failing closed buys MORE review; effort failing closed
 * buys TODAY's review. Both point away from accidentally reviewing less.
 */
export function normalizeReviewEffort(value: unknown, fallback: ReviewEffort = "standard"): ReviewEffort {
  return isReviewEffort(value) ? value : fallback;
}

/**
 * Normalize a session-level default, distinguishing ABSENT from MALFORMED.
 *
 * Absent means "no pin", which is the size-mapped default. A value that is
 * present but unrecognized is a mistake, and it fails closed to `standard` for
 * the same reason `normalizeReviewEffort` does: size mapping can be LIGHTER
 * than standard, so treating a typo as "no pin" would quietly buy less review
 * than the project has today.
 *
 * Absent is `undefined`, NOT `null`. A null reached this function from a config
 * or ledger file that literally contains `null`, which JSON only produces when
 * someone wrote it: `meta unset` DELETES the key (metadata.ts unsetMetadata),
 * so null is never how a cleared override is represented. It is a written value
 * that is not a level, so it takes the malformed branch.
 */
export function normalizeReviewEffortDefault(value: unknown): ReviewEffortDefault {
  if (value === undefined) return "size-mapped";
  if (value === "size-mapped") return "size-mapped";
  if (isReviewEffort(value)) return value;
  return "standard";
}

/**
 * The default mapping, from what the ledger already records.
 *
 * `chore` is the only honest "small" signal available: there is no size field,
 * and `task` is the DEFAULT ticket type, so mapping `task` down would quietly
 * move the whole fleet off standard and break the standard-equals-today anchor.
 * High risk maps up, which keeps the fail-closed direction of
 * `reviewRiskForTicket` pointing at more review rather than less.
 */
export function mapSizeToEffort(type: unknown, risk: RiskLevel): ReviewEffort {
  if (risk === "high") return "thorough";
  if (type === "chore" && risk === "low") return "light";
  return "standard";
}

/**
 * Issues carry severity instead of type, and the issue path already resolves
 * risk `low` (one round). Mapping `critical` to `thorough` would triple the
 * cost of the least-changed path in the product, so criticals land on standard
 * and escalation stays available through an explicit per-item level.
 */
export function mapIssueSeverityToEffort(severity: unknown): ReviewEffort {
  // Only the two severities that MEAN "small" buy light. Everything else,
  // including an absent, misspelled, or non-string severity, lands on standard.
  // Written as an allowlist for that reason: the obvious spelling
  // (`critical || high ? standard : light`) reads identically for real inputs
  // while quietly handing every malformed one LESS review than today, which is
  // the one outcome this module exists to prevent. The ticket path fails closed
  // through reviewRiskForTicket; this is the issue path's equivalent.
  if (severity === "low" || severity === "medium") return "light";
  return "standard";
}

export interface ResolvedItemEffort {
  readonly level: ReviewEffort;
  readonly source: ReviewEffortSource;
}

/** Where a pinned session level came from, so the item can report its own provenance. */
export interface SessionEffort {
  readonly level: ReviewEffortDefault;
  readonly source: "start-call" | "project" | "default" | "legacy" | "unknown";
}

function fromSession(session: SessionEffort | null | undefined): ResolvedItemEffort | null {
  if (!session || session.level === "size-mapped") return null;
  // Provenance passes through UNCHANGED. Every previous version rewrote one
  // value into another here and was wrong twice: a rewrite has to prove no
  // other path can produce the value it is rewriting, and that proof does not
  // survive a persisted record that any string can reach. Whoever determines
  // the provenance names it; this function only carries it.
  return { level: session.level, source: session.source };
}

/**
 * Per-item level for a ticket: explicit metadata, then session pin, then size.
 *
 * The presence test is `!== undefined`, not `!= null`: an item carrying a
 * literal `reviewEffort: null` has a value written into it, and reading that as
 * "no override" would drop a low-risk chore to `light` -- LESS review than the
 * same ticket gets today. Own keys holding `undefined` cannot occur here (every
 * caller passes a JSON-parsed ledger entity), which is why this is a presence
 * test rather than `Object.hasOwn`: hasOwn would additionally catch a
 * hand-built `{ reviewEffort: undefined }` projection and pin every unset item
 * to standard, disabling the size mapping entirely.
 */
export function reviewEffortForTicket(
  ticket: Record<string, unknown>,
  session?: SessionEffort | null,
): ResolvedItemEffort {
  if (ticket.reviewEffort !== undefined) {
    return { level: normalizeReviewEffort(ticket.reviewEffort), source: "item" };
  }
  const pinned = fromSession(session);
  if (pinned) return pinned;
  return { level: mapSizeToEffort(ticket.type, reviewRiskForTicket(ticket)), source: "size-mapped" };
}

/** Per-item level for an issue. Same precedence, severity instead of type. */
export function reviewEffortForIssue(
  issue: Record<string, unknown>,
  session?: SessionEffort | null,
): ResolvedItemEffort {
  if (issue.reviewEffort !== undefined) {
    return { level: normalizeReviewEffort(issue.reviewEffort), source: "item" };
  }
  const pinned = fromSession(session);
  if (pinned) return pinned;
  return { level: mapIssueSeverityToEffort(issue.severity), source: "size-mapped" };
}

/**
 * Read the session's frozen pin back out of state, for per-item resolution.
 * A session frozen before this feature has no pin, which reads as size-mapped
 * and therefore leaves every item on its mapped level.
 */
export function sessionEffortFromState(
  state: { readonly resolvedReviewEffort?: { readonly level?: string | null; readonly source?: string | null } | null },
): SessionEffort {
  // A session frozen before the dial shipped never opted into size mapping, so
  // the ABSENCE of the marker pins it to standard rather than letting the
  // mapping start moving items the moment it resumes and picks its next one.
  // Only a session created with the dial may be size-mapped.
  const marker = state.resolvedReviewEffort;
  // ABSENCE is the pre-dial session, and only absence earns `legacy` -- that
  // word tells a reader there is no setting to go find, which is a claim a
  // damaged record does not support. A literal null is a marker someone wrote
  // over, so it reports `unknown` instead. Both hold the level at standard.
  if (marker === undefined) return { level: "standard", source: "legacy" };
  if (marker === null) return { level: "standard", source: "unknown" };

  // A marker PRESENT with no level is a corrupt record, not an absent default,
  // and the difference decides whether a chore gets standard or light.
  // normalizeReviewEffortDefault reads a bare `undefined` as "no pin" ->
  // size-mapped, which is correct for a config key nobody ever wrote and wrong
  // here: the marker's existence proves a level WAS resolved at session start,
  // so its disappearance is corruption and fails closed like any other value
  // this build cannot read.
  const level = marker.level === undefined ? "standard" : normalizeReviewEffortDefault(marker.level);

  // The persisted source is a bare string, so a record CAN carry a provenance
  // this build does not know. That is not the same fact as a pre-dial session
  // and must not borrow its name: `legacy` says "no setting exists to find",
  // while `unknown` says "a setting may exist and this record cannot name it".
  const source = marker.source;
  return {
    level,
    source: source === "start-call" || source === "project" || source === "default" ? source : "unknown",
  };
}

/**
 * The narrow slice of session state the dial reads. Kept structural so the
 * module stays testable without building a whole session.
 */
export interface ReviewEffortState {
  readonly currentReviewEffort?: string | null;
  readonly currentReviewEffortSource?: string | null;
  readonly mode?: string | null;
  readonly resolvedReviewEffort?: { readonly level?: string | null; readonly source?: string | null } | null;
}

/**
 * A mode whose entire purpose is one review must still run it. `off` there
 * means "as little as is coherent", not "do the thing you were asked for
 * without doing it".
 */
function isForcedStage(mode: string | null | undefined, stage: ReviewStageId): boolean {
  return (mode === "plan" && stage === "PLAN_REVIEW") || (mode === "review" && stage === "CODE_REVIEW");
}

/**
 * The ONE level every consumer reads: skip(), round counts, backend selection,
 * instruction wording, records and events.
 *
 * Reading `currentReviewEffort` directly would leak `off` into round arithmetic
 * on a forced plan/review-mode run, so nothing else may read it.
 *
 * An absent value reads as `standard`, which is what makes a session frozen
 * before this feature behave exactly as it did.
 */
export function effectiveReviewEffort(state: ReviewEffortState, stage: ReviewStageId): ReviewEffort {
  const base = unforcedReviewEffort(state);
  if (base === "off" && isForcedStage(state.mode, stage)) return "light";
  return base;
}

/**
 * The level BEFORE a mode can force it, resolved the same way for every reader.
 *
 * Extracted rather than inlined twice: the disclosure line has to know whether
 * a forced run is what produced the level, and an independent copy that only
 * consulted `currentReviewEffort` would miss the case where the pin is absent
 * and the SESSION marker is what said `off`. That session is forced to light
 * and would have been disclosed under the provenance of whoever set the
 * session default -- naming a source that did not choose that level, which is
 * the one thing this line exists to avoid.
 */
function unforcedReviewEffort(state: ReviewEffortState): ReviewEffort {
  return state.currentReviewEffort != null
    ? normalizeReviewEffort(state.currentReviewEffort)
    : normalizeReviewEffort(
      normalizeReviewEffortDefault(state.resolvedReviewEffort?.level) === "size-mapped"
        ? "standard"
        : state.resolvedReviewEffort?.level,
    );
}

/** Minimum rounds before a clean verdict may land. */
export function effortMinRounds(effort: ReviewEffort, risk: RiskLevel): number {
  const base = requiredRounds(risk);
  switch (effort) {
    case "off": return 0;
    case "light": return 1;
    case "standard": return base;
    case "thorough": return Math.max(2, base);
  }
}

/**
 * Pick WITHIN the configured backends. The dial never adds a backend a project
 * did not configure, so a cheaper level can never make a review cost more.
 *
 * `light` prefers a single fast reviewer and drops lenses, which fans out to
 * many agents. A project whose only configured backend IS lenses keeps it: the
 * alternative is inventing a reviewer it never asked for. That case is
 * disclosed in the round record rather than silently downgraded.
 */
export function effortBackends(effort: ReviewEffort, allowed: readonly string[]): readonly string[] {
  if (effort !== "light" || allowed.length <= 1) return allowed;
  if (allowed.includes("codex")) return ["codex"];
  const nonLens = allowed.find((b) => b !== "lenses");
  return nonLens ? [nonLens] : allowed;
}

/** True when `light` had to keep lenses because nothing else was configured. */
export function lensOnlyAtLight(effort: ReviewEffort, allowed: readonly string[]): boolean {
  return effort === "light" && allowed.length > 0 && allowed.every((b) => b === "lenses");
}

/**
 * Round cap for CODE_REVIEW.
 *
 * `configured === 0` means unlimited and stays unlimited at every level: a
 * project that explicitly disabled the cap did so deliberately. An explicitly
 * project-set cap always wins over the dial. The `requiredRounds` clamp is
 * preserved everywhere, so a cheaper level can never starve a risky item below
 * its minimum.
 */
export function effortCodeReviewMaxRounds(
  effort: ReviewEffort,
  risk: RiskLevel,
  configured: number,
  explicitlySet: boolean,
): number {
  if (configured === 0) return 0;
  const floor = requiredRounds(risk);
  if (explicitlySet || effort === "standard" || effort === "thorough" || effort === "off") {
    return Math.max(configured, floor);
  }
  return Math.max(Math.min(configured, LIGHT_CODE_REVIEW_MAX_ROUNDS), floor);
}

export const LIGHT_CODE_REVIEW_MAX_ROUNDS = 4;

/**
 * The depth ASK. Split from the `deliberate` clause below on purpose.
 *
 * This half is actionable anywhere the CALLER composes the review request --
 * the codex-bridge tool call and the "launch a review agent" path both let the
 * caller say what kind of pass it wants. It is deliberately NOT emitted on the
 * lenses or native-codex-CLI paths: there the review is composed
 * programmatically (a fixed lens fan-out, a fixed command line), so a depth
 * sentence would be an instruction with nothing to act on. Those paths still
 * carry the disclosure line, so the level is never hidden -- it is just not
 * pretended to be adjustable where it is not.
 *
 * `standard` returns null, which keeps its instruction byte-identical to today's.
 */
export function effortDepthSentence(effort: ReviewEffort, kind: "plan" | "code"): string | null {
  const subject = kind === "plan" ? "design soundness, edge cases, and failure modes" : "correctness, edge cases, and regressions";
  switch (effort) {
    case "light": return "Request a quick pass -- correctness blockers only, skip style and polish.";
    case "thorough": return `Request a thorough review -- ${subject}.`;
    default: return null;
  }
}

/**
 * The codex-bridge `deliberate` argument, and ONLY for that path.
 *
 * `deliberate` is a parameter of the bridge's `review_plan`/`review_code` MCP
 * tools. No other reviewer accepts it: the lenses harness has no such input,
 * `storybloq codex-review` has no such flag, and a review subagent has no tool
 * call to put it on. Emitting it elsewhere would tell the agent to pass an
 * argument that does not exist.
 */
export function effortDeliberateClause(effort: ReviewEffort): string | null {
  switch (effort) {
    case "light": return "Pass deliberate: false.";
    case "thorough": return "Pass deliberate: true.";
    default: return null;
  }
}

/**
 * The one disclosure line every review instruction carries, at every level
 * including standard. Nothing about the dial is silent.
 *
 * Takes the STATE rather than a level plus a source, because those two can
 * disagree and a caller pairing them by hand would eventually pair them wrong:
 * when a plan-mode or review-mode session pinned `off`, the forced run happens
 * at light, and reporting the item's own provenance beside that level would
 * name a source that did not choose it.
 */
export function effortDisclosureLine(state: ReviewEffortState, stage: ReviewStageId): string {
  const level = effectiveReviewEffort(state, stage);
  return `Review effort: ${level} (${effortDisclosureSource(state, stage)}).`;
}

function effortDisclosureSource(state: ReviewEffortState, stage: ReviewStageId): string {
  if (unforcedReviewEffort(state) === "off" && isForcedStage(state.mode, stage)) {
    return `${state.mode} mode requires this review`;
  }
  if (state.currentReviewEffortSource != null) {
    return normalizeReviewEffortSource(state.currentReviewEffortSource);
  }
  // No per-item pin: the session default is what resolved it. `legacy` and
  // `unknown` are real provenances here, not fallbacks -- see
  // sessionEffortFromState for what separates them.
  return sessionEffortFromState(state).source;
}

export { normalizeRiskLevel };
