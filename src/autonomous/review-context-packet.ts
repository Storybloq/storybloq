/**
 * ISS-1115 Run A: the round context packet for the codex and agent backends.
 *
 * THE PROBLEM. The lens path receives project rules, convergence history, prior
 * deferrals and known false positives. The codex and agent paths receive one
 * line: "Call `review_code` MCP tool with the diff." Every round after the
 * first is therefore a COLD READ, and the fleet data shows what that costs.
 * Codex accounts for 27 of 44 zero-finding revise rounds, and the longest
 * all-codex run went twelve rounds with major counts 4,4,3,0,3,1,7,6,5,13,11,8.
 * A count that RISES late is a reviewer rediscovering territory it already
 * covered, not a codebase getting worse.
 *
 * WHERE THE ANSWERS LIVE, AND WHY NOT IN STATE. `ReviewRecord` persists counts
 * and no findings at all, and the PLAN redirect clears `reviews` and
 * `lensReviewHistory` outright. So state cannot answer "what did round 2 find
 * and what did we decide about it". The T-488 verdict artifacts can: they carry
 * the findings, they carry the backend's own run id, they sit outside the
 * arrays the redirect clears, and their generation tag keeps a pre-redirect
 * round from being read as a post-redirect one.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not RECONCILE history.
 * There is no cross-round finding reference in this codebase: `Finding.id` is
 * optional, the native codex route synthesises a positional `codex-N` that is
 * not stable across rounds, and a content key over severity/category/text both
 * collides and misses. A suppression instruction keyed on a match that cannot
 * detect its own ambiguity IS the laundering vector the item's pitfall names:
 * "do not re-raise X" where X collides with unrelated Y suppresses Y. So every
 * prior acceptance is rendered as a REPORT FROM A ROUND, marked status
 * unconfirmed, and the reviewer does the reconciling. See plan section 3.3.
 *
 * THE MANDATORY PAYLOAD is the reporting rule, the completeness disclosure and
 * the capture directive. It is assembled BEFORE optional sections and it may
 * exceed the budget, in which case it still ships: a budget too small to
 * describe a review truthfully is not a reason to describe it untruthfully.
 * Its size is not knowable in advance, because the disclosure NAMES what was
 * dropped, so the fit is computed on the FULLY RENDERED payload for each trial
 * rather than against a figure taken before anything dropped.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { telemetryDirPath } from "./liveness.js";
import { formatCitedRulingsSectionBounded } from "../core/output-formatter.js";
import type { CitationResolution } from "../core/ruling.js";
import {
  parseVerdictFilename,
  computeContentHash,
  type ReviewVerdictArtifact,
} from "./review-verdict.js";

export type PacketSectionId = "accepted-residuals" | "prior-findings" | "project-rules";

export interface PacketSection {
  readonly id: PacketSectionId;
  readonly body: string;
}

export interface PacketFinding {
  readonly id?: string;
  readonly severity: string;
  readonly category: string;
  readonly description: string;
  /** The RAW value as recorded. Never normalised into a recognised bucket. */
  readonly disposition: string;
  readonly dispositionReason?: string;
}

export interface PriorRoundSummary {
  readonly round: number;
  readonly verdict: string;
  readonly findings: readonly PacketFinding[];
}

export type PacketCompleteness = "complete" | "partial" | "none";

export interface ReviewContextPacket {
  /**
   * The capture instruction handed to the reviewer. Part of the mandatory
   * payload: reserved before every optional section and never shed.
   *
   * NAMED FOR WHAT IT HOLDS. This is the INSTRUCTION that tells a reviewer how
   * to capture its subject, not the subject. Nothing here can check that it is
   * non-empty or that the reviewer runs it, so this is a reservation with a
   * stated limit and not a guarantee.
   */
  readonly captureDirective: string;
  readonly sections: readonly PacketSection[];
  readonly completeness: PacketCompleteness;
  /** Statements of what is missing. Rendered into `text`, never only carried. */
  readonly omissions: readonly string[];
  readonly priorRounds: readonly PriorRoundSummary[];
  readonly priorCodexSessionId?: string;
  /** Assembled payload. ALWAYS contains the whole mandatory payload. */
  readonly text: string;
}

export interface BuildPacketParams {
  readonly sessionDir: string;
  readonly projectRoot: string;
  readonly target: string;
  readonly stage: string;
  readonly generation: number;
  /** The round about to run. Priors are rounds 1..roundNum-1. */
  readonly roundNum: number;
  readonly budget: number;
  readonly captureDirective: string;
  /** `state.reviews.plan[]` when intact. Empty or absent after a redirect. */
  readonly planReviews?: readonly { readonly round: number; readonly codexSessionId?: string }[];
  /**
   * T-494: the resolved citations of the item under review. Resolved by the
   * CALLER; this module does no ledger IO of its own, matching how it already
   * receives everything else.
   */
  readonly citedRulings?: readonly CitationResolution[];
  /**
   * T-494: set INSTEAD of `citedRulings` when the citations could not be
   * resolved at all. It becomes an omission, so the disclosure says the packet
   * does not know what this item cites rather than showing a reviewer no
   * rulings and no reason to doubt it.
   */
  readonly citedRulingsUnavailable?: string;
}

/**
 * T-494: the ruling-TEXT budget, as a fraction of the round's budget rather
 * than a constant, so the same citations render differently at the 16,000
 * plan-review budget and the 24,000 code-review one. 25 percent gives 4,000 and
 * 6,000. Only text is bounded; per-citation metadata is never dropped.
 */
export const CITED_RULINGS_TEXT_BUDGET_FRACTION = 0.25;

/**
 * Dispositions that mean "a round reported this as settled". `addressed` is
 * deliberately absent: it is a CLAIM that a fix landed, not a confirmation that
 * it did, and presenting a claim as an acceptance tells a reviewer that a
 * possibly-unfixed defect is closed.
 */
const RESIDUAL_DISPOSITIONS = new Set(["deferred", "contested"]);

/** The four the write side declares. Anything else is read at its noisiest. */
const KNOWN_DISPOSITIONS = new Set(["open", "addressed", "contested", "deferred"]);

const ORIGIN_RULE = [
  "REPORTING RULE for this round. Every finding must carry `origin`",
  "(`introduced` or `pre-existing`) and `originClass` (`new`, `reintroduced`,",
  "`unchanged`, or `introduced-by-fix`; add `sinceRound` with `unchanged`).",
  "`reintroduced` still blocks. Prior-round context below is context, never an",
  "amnesty.",
].join(" ");

/**
 * The reopening protocol, stated ONCE at block level and attached to no
 * individual entry.
 *
 * WHY THIS SHAPE. Item 1(a) asks for the residuals to be "marked `do not
 * re-raise unless the code changed under them`", so the item does want an
 * instruction. The hazard is per-entry SUPERSEDING, a claim about which finding
 * is current, which needs identity this codebase does not have. A block-level
 * rule about how to treat history needs no identity at all, so the instruction
 * survives and the hazard does not.
 *
 * It is CONDITIONAL in both directions: it does not apply to an acceptance a
 * later included round already reopened, and it never converts postponed work
 * into a decision nobody took.
 */
const REOPENING_RULE = [
  "HOW TO TREAT THE HISTORY BELOW. Each entry is what a round REPORTED, not a",
  "statement about the code now: none is confirmed current, and absence of an",
  "entry is not acceptance. Reopen an item whose acceptance still stands only",
  "on new evidence, changed relevant code or dependencies, changed",
  "requirements, or a concrete error in the earlier rationale, and say which.",
  "An item a later round below already reopened needs no such grounds, and",
  "work recorded as deferred is OUTSTANDING rather than accepted.",
].join(" ");

// ---------------------------------------------------------------------------
// Reading artifacts, which is a trust boundary rather than a file read
// ---------------------------------------------------------------------------

interface ArtifactIdentity {
  readonly target: string;
  readonly stage: string;
  readonly round: number;
  readonly generation: number;
}

type ArtifactRead =
  | { readonly ok: true; readonly artifact: ReviewVerdictArtifact }
  | { readonly ok: false; readonly reason: string };

/**
 * A packet is a CLAIM ABOUT HISTORY. A tampered or misfiled artifact makes it a
 * false one, and a false history is worse than a missing one because it invites
 * treating a live defect as already settled. So four checks, and each failure
 * is a NAMED omission rather than silent absence:
 *
 *  1. the content hash verifies;
 *  2. the body's own identity matches the filename it was found under,
 *     INCLUDING generation, which is the field the whole redirect boundary
 *     rests on;
 *  3. `findings` is actually an array. Hash validity proves nobody edited the
 *     file, not that it was ever well formed;
 *  4. unknown optional fields are retained. Validation is not narrowing.
 */
function readArtifact(path: string, expected: ArtifactIdentity): ArtifactRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { ok: false, reason: "unreadable or not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "not an object" };
  }
  const { _contentHash, ...artifact } = parsed as Record<string, unknown>;

  if (typeof _contentHash !== "string" || _contentHash === "") {
    return { ok: false, reason: "no content hash" };
  }
  if (computeContentHash(artifact as unknown as ReviewVerdictArtifact) !== _contentHash) {
    return { ok: false, reason: "content hash does not verify" };
  }

  const mismatch: string[] = [];
  if (artifact.target !== expected.target) mismatch.push("target");
  if (typeof artifact.stage === "string"
    && artifact.stage.toLowerCase() !== expected.stage.toLowerCase()) mismatch.push("stage");
  if (artifact.round !== expected.round) mismatch.push("round");
  // An absent generation is generation 0, the value T-488 wrote before the
  // field existed. An absent one that should be non-zero still mismatches.
  if ((artifact.generation ?? 0) !== expected.generation) mismatch.push("generation");
  if (mismatch.length > 0) {
    return { ok: false, reason: `body identity contradicts filename (${mismatch.join(", ")})` };
  }

  if (!Array.isArray(artifact.findings)) {
    return { ok: false, reason: "findings is not an array" };
  }
  return { ok: true, artifact: artifact as unknown as ReviewVerdictArtifact };
}

function toPacketFinding(raw: unknown): PacketFinding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const description = typeof f.description === "string" ? f.description : "";
  if (description === "") return null;
  return {
    ...(typeof f.id === "string" ? { id: f.id } : {}),
    severity: typeof f.severity === "string" ? f.severity : "unknown",
    category: typeof f.category === "string" ? f.category : "unknown",
    description,
    // RAW, verbatim, always. Storage preserves; interpretation is conservative;
    // rendering shows both. Normalising here would destroy the evidence that
    // the rendering needs in order to disclose the effective reading.
    disposition: typeof f.disposition === "string" ? f.disposition : "open",
    ...(typeof f.dispositionReason === "string" ? { dispositionReason: f.dispositionReason } : {}),
  };
}

interface CollectResult {
  readonly rounds: Map<number, PriorRoundSummary>;
  /** Artifacts found and REJECTED, with the reason. Never silently dropped. */
  readonly rejected: readonly string[];
}

function sanitizeTarget(target: string): string {
  return target.replace(/\//g, "-");
}

/** Every VALID artifact for one target/stage/generation, keyed by round. */
function collectRounds(
  sessionDir: string,
  target: string,
  stage: string,
  generation: number,
): CollectResult {
  const rounds = new Map<number, PriorRoundSummary>();
  const rejected: string[] = [];
  const reviewsDir = join(telemetryDirPath(sessionDir), "reviews");
  let files: string[];
  try {
    files = readdirSync(reviewsDir);
  } catch {
    return { rounds, rejected };
  }
  for (const file of files) {
    const parsed = parseVerdictFilename(file);
    if (!parsed) continue;
    if (parsed.target !== sanitizeTarget(target)) continue;
    if (parsed.stage !== stage.toLowerCase()) continue;
    // Generation is an equality check, not a floor. A pre-redirect round is a
    // different question from a post-redirect one, and merging them would put
    // findings about an abandoned plan in front of a reviewer as though they
    // were still live.
    if (parsed.generation !== generation) continue;

    const read = readArtifact(join(reviewsDir, file), {
      target, stage, round: parsed.round, generation,
    });
    if (!read.ok) {
      rejected.push(`round ${parsed.round}: artifact rejected (${read.reason})`);
      continue;
    }
    const findings = (read.artifact.findings ?? [])
      .map(toPacketFinding)
      .filter((f): f is PacketFinding => f !== null);
    rounds.set(parsed.round, {
      round: parsed.round,
      verdict: typeof read.artifact.verdict === "string" ? read.artifact.verdict : "unknown",
      findings,
    });
  }
  return { rounds, rejected };
}

/**
 * The plan stage's codex session id, so code review continues the thread that
 * approved the plan rather than opening a cold one.
 *
 * State first because it is cheapest; the artifact second because it is what
 * survives state loss within a generation. `backendRunIdKind` is checked rather
 * than assumed: an agent dispatch id passed to the codex bridge as a session
 * would not resume anything, or would resume something unrelated.
 *
 * It goes through the SAME validated reader as the history. An earlier version
 * had its own unvalidated path, so an artifact the residual side rejected could
 * still hand a session id to the reviewer.
 */
function resolvePriorCodexSession(
  sessionDir: string,
  target: string,
  generation: number,
  planReviews: readonly { readonly codexSessionId?: string }[] | undefined,
): string | undefined {
  for (let i = (planReviews?.length ?? 0) - 1; i >= 0; i--) {
    const id = planReviews![i]!.codexSessionId;
    if (typeof id === "string" && id !== "") return id;
  }
  const reviewsDir = join(telemetryDirPath(sessionDir), "reviews");
  let files: string[];
  try {
    files = readdirSync(reviewsDir);
  } catch {
    return undefined;
  }
  const candidates = files
    .map((f) => ({ f, p: parseVerdictFilename(f) }))
    .filter((x) => x.p !== null && x.p.stage === "plan"
      && x.p.target === sanitizeTarget(target) && x.p.generation === generation)
    .sort((a, b) => b.p!.round - a.p!.round);
  for (const c of candidates) {
    const read = readArtifact(join(reviewsDir, c.f), {
      target, stage: "plan", round: c.p!.round, generation,
    });
    if (!read.ok) continue;
    if (read.artifact.backendRunIdKind === "codex-session"
      && typeof read.artifact.backendRunId === "string" && read.artifact.backendRunId !== "") {
      return read.artifact.backendRunId;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Raw value AND effective reading, together.
 *
 * Preserving an unrecognised disposition verbatim is right, and preserving it
 * WITHOUT saying how it is being treated was the defect: a reviewer shown
 * `wontfix-approved` and nothing else will read it as an acceptance, when every
 * decision in this codebase reads it as `open`.
 */
function renderDisposition(f: PacketFinding): string {
  const reason = f.dispositionReason ? `, reason ${f.dispositionReason}` : "";
  if (KNOWN_DISPOSITIONS.has(f.disposition)) return `${f.disposition}${reason}`;
  return `${f.disposition}${reason} [unrecognised value, treated as open]`;
}

function renderFinding(f: PacketFinding): string {
  const id = f.id ? `[${f.id}] ` : "";
  return `  - ${id}${f.severity}/${f.category}: ${f.description} -- ${renderDisposition(f)}`;
}

/**
 * One historical acceptance, rendered as a report rather than a verdict.
 *
 * `deferred` and `contested` are different information and read differently:
 * a deferral is outstanding work, a contest is a reviewer's judgement that the
 * finding was not real. And `owner-accepted-risk` is a decision that was taken,
 * where `valid-deferred` is work that was postponed. An earlier version stored
 * the distinction and then rendered both identically, which made the field
 * decorative.
 */
function renderHistoricalEntry(round: number, f: PacketFinding): string {
  const id = f.id ? `[${f.id}] ` : "";
  const kind = f.disposition === "contested"
    ? "reported NOT a real defect"
    : f.dispositionReason === "owner-accepted-risk"
      ? "reported as an accepted risk (a decision that was taken)"
      : f.dispositionReason === "valid-deferred"
        ? "reported as a valid defect, POSTPONED and still outstanding"
        : "reported as deferred";
  // NO unrecognised-disposition branch here, deliberately. This function only
  // ever renders entries selected by RESIDUAL_DISPOSITIONS, so an unrecognised
  // value cannot reach it: it is read as `open` and is therefore not an
  // acceptance at all. A branch for it would be dead code shaped like a
  // safeguard, which is the class this run has already been burned by twice.
  // The raw-plus-effective disclosure lives in `renderDisposition`, on the
  // prior-findings path, which is where an unrecognised value actually lands.
  return [
    `  - round ${round}: ${id}${f.severity}/${f.category}: ${f.description}`,
    `      ${kind}. Status unconfirmed.`,
  ].join("\n");
}

function projectRulesBody(projectRoot: string): string | null {
  const parts: string[] = [];
  const rulesPath = join(projectRoot, "RULES.md");
  if (existsSync(rulesPath)) {
    try {
      parts.push(`## RULES.md\n\n${readFileSync(rulesPath, "utf-8")}`);
    } catch { /* unreadable rules are absent rules */ }
  }
  // REVIEW.md goes in as TEXT. There is no parser, no activation and no policy
  // here: a reviewer benefits from the project's review guidance whatever shape
  // that file is in, and a checklist that declares no structure at all is still
  // guidance.
  const reviewPath = join(projectRoot, "REVIEW.md");
  if (existsSync(reviewPath)) {
    try {
      parts.push(`## REVIEW.md\n\n${readFileSync(reviewPath, "utf-8")}`);
    } catch { /* unreadable guidance is absent guidance */ }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface Trial {
  readonly sections: PacketSection[];
  readonly omissions: string[];
  readonly text: string;
  readonly completeness: PacketCompleteness;
}

export function buildReviewContextPacket(params: BuildPacketParams): ReviewContextPacket {
  const {
    sessionDir, projectRoot, target, stage, generation, roundNum, budget, captureDirective,
  } = params;

  // T-494. Rendered ONCE, outside the trial loop, because the ruling bound is a
  // function of the round's budget and not of any shedding decision. Rendering
  // it per trial would be wasted work and would let a shedding decision change
  // what a citation says, which is exactly the drift the single shared renderer
  // exists to prevent.
  const citedRulings = params.citedRulings ?? [];
  const rulingsRender = formatCitedRulingsSectionBounded(
    citedRulings,
    Math.floor(budget * CITED_RULINGS_TEXT_BUDGET_FRACTION),
  );

  const { rounds, rejected } = collectRounds(sessionDir, target, stage, generation);
  const priorRounds = [...rounds.values()]
    .filter((r) => r.round < roundNum)
    .sort((a, b) => a.round - b.round);

  // A round we know ran and whose artifact we cannot use. Pre-T-488 sessions
  // lost artifacts to the generation collision, so this is a real population
  // rather than a defensive branch, and a rejected artifact lands here too:
  // "we could not trust it" and "it was not there" are both gaps in the claim
  // this packet is making, and neither may be silent.
  const baseOmissions: string[] = [...rejected];
  // Reported through the EXISTING omissions channel so the disclosure names it,
  // rather than through a second reporting channel the reader has to know about.
  if (params.citedRulingsUnavailable !== undefined) {
    baseOmissions.push(
      `cited rulings not resolved: ${params.citedRulingsUnavailable}. This packet does not know what this item cites.`,
    );
  }
  if (rulingsRender.truncatedIds.length > 0) {
    baseOmissions.push(
      `${rulingsRender.truncatedIds.length} cited ruling text(s) truncated: ${rulingsRender.truncatedIds.join(", ")}. ` +
      "Metadata for each is present above; read the full text with ruling_get.",
    );
  }
  for (let r = 1; r < roundNum; r++) {
    if (!rounds.has(r) && !rejected.some((x) => x.startsWith(`round ${r}:`))) {
      baseOmissions.push(`round ${r}: artifact not recovered`);
    }
  }

  const priorCodexSessionId = resolvePriorCodexSession(
    sessionDir, target, generation, params.planReviews,
  );

  const residuals = priorRounds.flatMap((r) =>
    r.findings
      .filter((f) => RESIDUAL_DISPOSITIONS.has(f.disposition))
      .map((f) => ({ round: r.round, f })));

  // ── Optional sections, highest keep-priority first ───────────────────────
  const candidates: {
    id: PacketSectionId;
    render: (shed: number) => string;
    sheddable: boolean;
  }[] = [];

  if (residuals.length > 0) {
    candidates.push({
      id: "accepted-residuals",
      sheddable: true,
      render: (shed: number) => {
        const kept = residuals.slice(shed);
        const lines = [
          `# Prior review history (${kept.length} of ${residuals.length} recorded acceptances)`,
          "",
          REOPENING_RULE,
          "",
          ...kept.map(({ round, f }) => renderHistoricalEntry(round, f)),
        ];
        if (shed > 0) {
          lines.push("", `NOTE: ${shed} older entr(ies) dropped for size. This list is incomplete.`);
        }
        return lines.join("\n");
      },
    });
  }

  const lastRound = priorRounds[priorRounds.length - 1];
  if (lastRound && lastRound.findings.length > 0) {
    candidates.push({
      id: "prior-findings",
      sheddable: false,
      render: () => [
        `# Previous round (round ${lastRound.round}), verdict: ${lastRound.verdict}`,
        "",
        ...lastRound.findings.map(renderFinding),
      ].join("\n"),
    });
  }

  const rulesBody = projectRulesBody(projectRoot);
  if (rulesBody !== null) {
    candidates.push({
      id: "project-rules",
      sheddable: false,
      render: () => `# Project rules\n\n${rulesBody}`,
    });
  }

  /**
   * Render one candidate assembly completely, INCLUDING the disclosure that
   * names what this very assembly dropped.
   *
   * That self-reference is the whole point. The disclosure grows with each
   * shedding decision, so a size measured before shedding is a size for a
   * different payload than the one that ships. Every trial here is internally
   * consistent by construction, which is what makes the length invariant in the
   * tests checkable at an exact boundary.
   */
  function renderTrial(keep: number, shed: number): Trial {
    const sections: PacketSection[] = [];
    for (let i = 0; i < keep && i < candidates.length; i++) {
      sections.push({ id: candidates[i]!.id, body: candidates[i]!.render(i === 0 ? shed : 0) });
    }
    const omissions = [...baseOmissions];
    for (let i = keep; i < candidates.length; i++) {
      omissions.push(`section "${candidates[i]!.id}" dropped: context budget exceeded`);
    }
    if (shed > 0) {
      omissions.push(`${shed} older acceptance record(s) dropped: context budget exceeded`);
    }

    const disclosure = omissions.length === 0
      ? "CONTEXT COMPLETENESS: complete. Every prior round of this review is represented below."
      : [
        "CONTEXT COMPLETENESS: INCOMPLETE. What follows is missing the items",
        "listed here. Do not read the absence of a finding as its acceptance,",
        "and do not treat this history as the whole of it.",
        ...omissions.map((o) => `  - ${o}`),
      ].join("\n");

    // The mandatory payload, in order, and always whole. T-494 puts the cited
    // rulings AFTER the origin rule and BEFORE the disclosure and the capture
    // directive: they bind the work, so the reviewer reads them before being
    // sent to the diff, and they are never dropped for size.
    const mandatory = [
      ORIGIN_RULE,
      ...(rulingsRender.text === "" ? [] : [rulingsRender.text.trim()]),
      disclosure,
      captureDirective,
    ].join("\n\n");
    const text = [...sections.map((s) => s.body), mandatory].join("\n\n");

    const completeness: PacketCompleteness =
      sections.length === 0 && candidates.length > 0 ? "none"
        : omissions.length > 0 ? "partial"
          : "complete";

    return { sections, omissions, text, completeness };
  }

  // Trials in strict priority order. Whole sections drop from the BOTTOM, so
  // the fit is a strict prefix: a greedy per-section fit would drop a large
  // high-priority section and keep a small low-priority one that fitted in the
  // space it freed, inverting the ordering the drop order exists to express.
  // Only when the history section stands alone does content shed inside it,
  // oldest first, because the newest acceptance is the one most likely to
  // still matter.
  const trials: Trial[] = [];
  for (let keep = candidates.length; keep >= 1; keep--) trials.push(renderTrial(keep, 0));
  if (candidates.length > 0 && candidates[0]!.sheddable) {
    for (let shed = 1; shed <= residuals.length; shed++) trials.push(renderTrial(1, shed));
  }
  trials.push(renderTrial(0, 0));

  // Each trial strictly removes content from the one before it and the last
  // holds only the mandatory payload, so this terminates. The last trial ships
  // even when it exceeds budget: a budget too small to describe a review
  // truthfully is not a licence to describe it untruthfully, and dropping the
  // disclosure to respect a number produces exactly the quieter outcome this
  // item exists to prevent.
  const chosen = trials.find((t) => t.text.length <= budget) ?? trials[trials.length - 1]!;

  return {
    captureDirective,
    sections: chosen.sections,
    completeness: chosen.completeness,
    omissions: chosen.omissions,
    priorRounds,
    ...(priorCodexSessionId === undefined ? {} : { priorCodexSessionId }),
    text: chosen.text,
  };
}
