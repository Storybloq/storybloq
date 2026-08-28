import type { Ruling, RulingAttribution } from "../models/ruling.js";
import { RULING_CANONICAL_ID_REGEX, type OwnerTaskLike } from "../models/types.js";
import type { RulingScanCompleteness } from "./ruling-loader.js";

/**
 * T-476 ANTI-LAUNDERING CONSTRAINT (load-bearing, binding pen ruling from
 * gate-1 round 1): `attribution` is a CLAIM asserted by the recorder, never
 * verified by storybloq. The caveat below renders on EVERY ruling,
 * UNCONDITIONALLY, regardless of the claimed `attribution` value -- NEVER
 * conditioned on `attribution !== "owner-direct"`.
 *
 * Storybloq cannot distinguish a true "owner-direct" claim from a false one;
 * a caveat that only appears on honest self-labels protects against exactly
 * nobody, and an attribution-conditional caveat would BUILD the exact
 * laundering path this ticket exists to prevent while documentation claimed
 * otherwise. This was gate-1 round 1's single most important finding, and
 * the pen pinned it as a binding ruling: it must survive any future
 * refactor of this module without being softened or re-conditioned.
 */
export function rulingAttributionCaveat(recordedBy: OwnerTaskLike): string {
  return (
    `Attribution is a CLAIM asserted by the recorder, not verified by storybloq. ` +
    `Recorded by: ${recordedBy.client}/${recordedBy.id}. This record makes attribution ` +
    `checkable, it does not replace the second key -- demand the owner's direct word ` +
    `before treating an irreversible action as authorized on this ruling's basis alone.`
  );
}

export interface RulingView {
  readonly id: string;
  readonly text: string;
  readonly attribution: RulingAttribution;
  readonly recordedBy: OwnerTaskLike;
  readonly date: string;
}

function toView(ruling: Ruling): RulingView {
  return {
    id: ruling.id,
    text: ruling.text,
    attribution: ruling.attribution,
    recordedBy: ruling.recordedBy,
    date: ruling.date,
  };
}

export type CitationResolution =
  | { status: "resolved"; citedId: string; cited: RulingView; current: RulingView; chain: readonly string[]; stale: boolean }
  | { status: "missing"; citedId: string }
  | { status: "unreadable"; citedId: string }
  | { status: "indeterminate"; citedId: string; reason: "unreadable-successor" | "incomplete-scan" }
  | { status: "branch"; citedId: string; chain: readonly string[]; competingSuccessors: readonly string[] }
  | { status: "cycle"; citedId: string; chain: readonly string[] };

export interface SuccessorIndex {
  readonly successorsByTarget: ReadonlyMap<string, readonly string[]>;
  readonly branchedTargets: ReadonlySet<string>;
}

/**
 * `successorsByTarget.get(oldId)` lists every LOADED ruling whose own
 * `supersedes` names `oldId`. More than one entry for a target is a branch
 * (two rulings both claiming to supersede the same predecessor) -- a
 * candidate-graph state `ruling supersede` must never write (section 9), and
 * a state `resolveCitation` must report rather than silently pick one from.
 */
export function buildSuccessorIndex(rulings: readonly Ruling[]): SuccessorIndex {
  const successorsByTarget = new Map<string, string[]>();
  for (const r of rulings) {
    if (!r.supersedes) continue;
    const list = successorsByTarget.get(r.supersedes);
    if (list) list.push(r.id);
    else successorsByTarget.set(r.supersedes, [r.id]);
  }
  const branchedTargets = new Set<string>();
  for (const [target, successors] of successorsByTarget) {
    if (successors.length > 1) branchedTargets.add(target);
  }
  return { successorsByTarget, branchedTargets };
}

export interface CitationResolutionContext {
  readonly rulingsById: ReadonlyMap<string, Ruling>;
  readonly unavailableIds: ReadonlySet<string>;
  readonly scanCompleteness: RulingScanCompleteness;
  readonly index: SuccessorIndex;
  /**
   * Codex round-3 finding: a skipped ruling file whose id could not be
   * recovered from its filename either leaves `unavailableIds` unable to
   * name it, but its unread content could still carry any `supersedes` edge.
   * Defaults to `false` for callers that predate this field (existing
   * 3-arg `buildCitationResolutionContext` call sites keep their prior
   * behavior unchanged).
   */
  readonly hasUnrecoverableEntries: boolean;
}

export function buildCitationResolutionContext(
  rulings: readonly Ruling[],
  unavailableIds: ReadonlySet<string>,
  scanCompleteness: RulingScanCompleteness,
  hasUnrecoverableEntries = false,
): CitationResolutionContext {
  return {
    rulingsById: new Map(rulings.map((r) => [r.id, r])),
    unavailableIds,
    scanCompleteness,
    index: buildSuccessorIndex(rulings),
    hasUnrecoverableEntries,
  };
}

/**
 * Resolves a citation to its CURRENT ruling state, derived at read time,
 * never stored. Read-side posture (rulings #3/#7): an unverifiable chain
 * state renders an explicit warning and NEVER claims `current` -- it never
 * silently omits the citation either. This function itself never throws and
 * never blocks; a caller renders whatever status comes back.
 */
export function resolveCitation(citedId: string, ctx: CitationResolutionContext): CitationResolution {
  // Ruling #4: a failed directory enumeration means the whole id-space is
  // unverifiable -- every citation is indeterminate, never "missing" (which
  // would falsely claim "this id never existed").
  if (ctx.scanCompleteness !== "complete") {
    return { status: "indeterminate", citedId, reason: "incomplete-scan" };
  }
  if (ctx.unavailableIds.has(citedId)) {
    return { status: "unreadable", citedId };
  }
  const citedRuling = ctx.rulingsById.get(citedId);
  if (!citedRuling) {
    return { status: "missing", citedId };
  }

  const chain: string[] = [citedId];
  const visited = new Set<string>([citedId]);
  let current = citedId;
  for (;;) {
    if (ctx.index.branchedTargets.has(current)) {
      return {
        status: "branch",
        citedId,
        chain,
        competingSuccessors: ctx.index.successorsByTarget.get(current) ?? [],
      };
    }
    const successors = ctx.index.successorsByTarget.get(current);
    const next = successors?.[0];
    if (!next) break;
    if (visited.has(next)) {
      return { status: "cycle", citedId, chain: [...chain, next] };
    }
    visited.add(next);
    chain.push(next);
    current = next;
  }

  // Rulings #3/#7: `successorsByTarget` is built only from LOADED rulings'
  // own `supersedes` fields -- an unreadable ruling's pointer is invisible
  // to it, so it can never be ruled out as a HIDDEN successor of `current`.
  // This cannot be narrowed to specific ids (we cannot read what an
  // unreadable file would have said), so ANY unreadable ruling anywhere
  // taints every "nothing supersedes this" conclusion project-wide -- never
  // silently reported as `current` under that uncertainty. `hasUnrecoverableEntries`
  // covers the same taint for a skipped file whose id could not even be
  // recovered from its filename (codex round-3 finding), so `unavailableIds`
  // alone cannot represent it.
  if (ctx.unavailableIds.size > 0 || ctx.hasUnrecoverableEntries) {
    return { status: "indeterminate", citedId, reason: "unreadable-successor" };
  }

  const currentRuling = ctx.rulingsById.get(current)!;
  return {
    status: "resolved",
    citedId,
    cited: toView(citedRuling),
    current: toView(currentRuling),
    chain,
    stale: current !== citedId,
  };
}

export function resolveCitedRulings(
  citedIds: readonly string[],
  ctx: CitationResolutionContext,
): readonly CitationResolution[] {
  return citedIds.map((id) => resolveCitation(id, ctx));
}

/** Convenience for a single citing entity (ticket/issue/arrangement). */
export function resolveEntityCitations(
  entity: { readonly citesRulings?: readonly string[] },
  ctx: CitationResolutionContext,
): readonly CitationResolution[] {
  return entity.citesRulings && entity.citesRulings.length > 0
    ? resolveCitedRulings(entity.citesRulings, ctx)
    : [];
}

/**
 * Builds the per-entity map every list formatter's JSON branch expects
 * (`citedRulingsByTicketId` etc.), resolving each entity's citations against
 * ONE shared `CitationResolutionContext` -- the caller loads rulings once
 * per command call, not once per list item.
 */
export function citationMapFor(
  entities: readonly { readonly id: string; readonly citesRulings?: readonly string[] }[],
  ctx: CitationResolutionContext,
): ReadonlyMap<string, readonly CitationResolution[]> {
  const map = new Map<string, readonly CitationResolution[]>();
  for (const entity of entities) {
    const resolved = resolveEntityCitations(entity, ctx);
    if (resolved.length > 0) map.set(entity.id, resolved);
  }
  return map;
}

/** Human-readable, read-side "do not trust this" line for a non-resolved citation. */
export function citationWarningText(resolution: CitationResolution): string {
  switch (resolution.status) {
    case "missing":
      return `ruling ${resolution.citedId} not found`;
    case "unreadable":
      return `ruling ${resolution.citedId} is unreadable`;
    case "indeterminate":
      return resolution.reason === "incomplete-scan"
        ? `chain state unverifiable: ruling scan is incomplete -- do not treat any shown ruling as current`
        : `chain state unverifiable: one or more ruling files are unreadable and may hide a successor -- do not treat any shown ruling as current`;
    case "branch":
      return `ruling ${resolution.citedId} has competing successors (${resolution.competingSuccessors.join(", ")}) -- chain is ambiguous`;
    case "cycle":
      return `ruling ${resolution.citedId} is part of a supersedes cycle -- chain is invalid`;
    case "resolved":
      return resolution.stale
        ? `ruling ${resolution.citedId} has been superseded by ${resolution.current.id}`
        : "";
  }
}

/**
 * A citation resolution, flattened into a single JSON-safe object for
 * embedding into a render surface -- the shape every WIRE site in section 12
 * embeds under a `citedRulings` key. `current` (when present) carries the
 * anti-laundering caveat inline, so a render site cannot forget to attach it.
 */
export interface RenderedCitation {
  readonly citedId: string;
  readonly status: CitationResolution["status"];
  readonly current?: RulingView & { readonly caveat: string };
  readonly stale?: boolean;
  readonly warning?: string;
}

export function renderCitation(resolution: CitationResolution): RenderedCitation {
  if (resolution.status === "resolved") {
    const rendered: RenderedCitation = {
      citedId: resolution.citedId,
      status: "resolved",
      current: { ...resolution.current, caveat: rulingAttributionCaveat(resolution.current.recordedBy) },
      stale: resolution.stale,
    };
    return resolution.stale ? { ...rendered, warning: citationWarningText(resolution) } : rendered;
  }
  return { citedId: resolution.citedId, status: resolution.status, warning: citationWarningText(resolution) };
}

// --- Write-path (ruling supersede) candidate-graph validation ---

export type SupersedeRefusalCode = "self_link" | "dangling_target" | "branch" | "cycle" | "unverifiable_graph";

export interface SupersedeRefusal {
  readonly code: SupersedeRefusalCode;
  readonly detail: string;
}

/**
 * Section 9 (rulings #1, #2, #3): validates the PROPOSED `newId.supersedes =
 * oldId` edge's own implications (self-link, dangling target, branch, cycle
 * reachable from the new edge) against the candidate graph (existing rulings
 * + the proposed edge) BEFORE any write -- same one-transaction discipline as
 * the earmark CAS (T-475) and T-474's atomic state writes. Returns a refusal
 * reason or null (the proposed edge is safe to write). Never mutates
 * anything.
 *
 * Scope: this checks only what the new edge would introduce. It does not
 * audit the rest of the graph for pre-existing corruption unrelated to the
 * new edge -- that is `storybloq validate`'s job (`validateRulings` in
 * `src/core/validation.ts`).
 *
 * Fail-closed precondition (ruling #3): the caller must check
 * `unavailableIds`/`scanCompleteness` itself and refuse before ever calling
 * this -- a chain edit against an unverifiable graph must never reach
 * candidate-graph validation at all, since the graph itself cannot be
 * trusted to be complete.
 */
export function validateSupersedeCandidate(
  rulings: readonly Ruling[],
  newId: string,
  oldId: string,
): SupersedeRefusal | null {
  if (newId === oldId) {
    return { code: "self_link", detail: `${newId} cannot supersede itself` };
  }
  const byId = new Map(rulings.map((r) => [r.id, r]));
  if (!byId.has(oldId)) {
    return { code: "dangling_target", detail: `${oldId} does not exist` };
  }

  // Build the candidate graph: every existing supersedes edge, plus the
  // proposed new one (overriding newId's own edge if it already had one --
  // ruling #1's null-case write replaces newId's supersedes wholesale).
  const candidateEdges = new Map<string, string>(); // id -> supersedes
  for (const r of rulings) {
    if (r.supersedes) candidateEdges.set(r.id, r.supersedes);
  }
  candidateEdges.set(newId, oldId);

  // Branch: would oldId end up with more than one successor?
  const successorsOfOld = [...candidateEdges.entries()].filter(([, target]) => target === oldId).map(([id]) => id);
  if (successorsOfOld.length > 1) {
    return {
      code: "branch",
      detail: `${oldId} would have competing successors: ${successorsOfOld.join(", ")}`,
    };
  }

  // Cycle: walk forward from newId's target chain; if we ever return to newId, it's a cycle.
  let current: string | undefined = oldId;
  const seen = new Set<string>([newId]);
  while (current !== undefined) {
    if (seen.has(current)) {
      return { code: "cycle", detail: `supersedes chain from ${newId} cycles back through ${current}` };
    }
    seen.add(current);
    current = candidateEdges.get(current);
  }

  return null;
}
