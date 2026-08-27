/**
 * Scope-drift detector for PLAN_REVIEW (ISS-598).
 *
 * ADVISORY ONLY for this ship (Gate-1 ratified decision, N-109 duet). It
 * never routes to PARK by itself -- `planReviewHardCeiling`
 * (plan-review-ceiling.ts) remains the only automatic-enforcement mechanism.
 * A token-overlap heuristic given automatic park authority risks a real
 * failure mode: a ticket repeatedly re-picked and re-parked across sessions
 * (each session gets a fresh baseline) with no human ever seeing why. The
 * heuristic here is characterized against one preserved incident corpus, not
 * validated for precision, so it surfaces as a directive hint to the agent
 * and structured telemetry, and can be promoted to automatic enforcement
 * later once field data supports it.
 *
 * The signal: does a plan-review finding's subject (file basename plus
 * description text) cite something that did not exist in the plan when
 * review began? A real incident showed this pattern concretely -- adversarial
 * review pressure caused successive rounds to invent, then critique their own
 * inventions, escalating in severity while moving further from the ticket's
 * actual scope. Round-count caps do not catch this: each round genuinely
 * resolves the previous round's findings, so finding COUNTS look like
 * convergence while the design underneath gets larger and more dangerous.
 *
 * Persisted tokens are HASH DIGESTS, never plan-text substrings. plan.md is
 * arbitrary project content and can legitimately contain secret-shaped values
 * (an API key pasted into a design note, a bearer token in an example); the
 * identifier-shaped extraction below cannot tell those apart from ordinary
 * code vocabulary, so nothing extracted from it may be persisted verbatim.
 * Hashing prevents the raw value from being persisted, which is the guarantee
 * `planReviewBaseline.tokens` needs -- it does NOT make every digest
 * irreversible. A short, low-entropy token (a real identifier is exactly this
 * shape) can still be recovered from its digest by dictionary or brute-force
 * guessing; this defends against casual disclosure through a shared ledger,
 * not against a determined offline attack on a guessable value.
 */
import { createHash } from "node:crypto";

/**
 * Digests are truncated to 32 hex chars (128 bits) -- collision-resistant
 * enough for a same-session token-overlap check, not a claim of full SHA-256
 * strength. See the module docblock for what this guarantee does and does not
 * cover.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token.toLowerCase()).digest("hex").slice(0, 32);
}

/**
 * Digest of the full plan.md TEXT (not its extracted tokens), used only to
 * detect whether a ticket's plan changed between two baseline-capture
 * attempts (plan-review.ts). Never persisted anywhere secret-sensitive
 * tokens would be -- this exists purely as a change marker, so unlike
 * `hashToken` it is not truncated.
 */
export function hashPlanContent(planText: string): string {
  return createHash("sha256").update(planText).digest("hex");
}

export interface DriftFinding {
  readonly file?: string;
  readonly description: string;
}

export interface ExtractResult {
  readonly tokens: ReadonlySet<string>;
  /** Extraction hit the character-scan limit or (when supplied) the token cap. */
  readonly truncated: boolean;
}

/** Bounds worst-case tokenization cost against a pathological or adversarial input. */
const MAX_SCAN_CHARS = 20_000;
/** Bounds `planReviewBaseline.tokens`' stored size. */
const MAX_BASELINE_TOKENS = 500;
const MIN_TOKEN_LENGTH = 4;
const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]{3,}/g;

/**
 * Common English words that would otherwise manufacture false overlap (a
 * finding's prose happens to share a word with the plan's prose) or false
 * novelty (a finding's prose uses a word the plan's prose did not). Kept
 * short and pragmatic -- this is a heuristic filter, not an NLP pipeline.
 */
const STOPWORDS = new Set([
  "this", "that", "with", "from", "should", "which", "where", "there",
  "would", "could", "function", "description", "suggestion", "finding",
  "review", "round", "plan", "file", "line", "code", "also", "have", "been",
  "being", "were", "when", "does", "doesn", "need", "needs", "must", "never",
  "always", "only", "then", "than", "them", "they", "their", "what", "will",
  "into", "over", "under", "about", "each", "some", "more", "most", "such",
  "just", "like", "because", "before", "after", "these", "those", "here",
  "make", "made", "makes", "using", "used", "uses", "instead", "without",
  "still", "already", "current", "currently", "existing", "another",
  // Codex round 2 (correctness): generic filename/extension vocabulary. Every
  // file's basename tends to contribute one of these (`widget.test.ts`,
  // `index.json`, `auth.config.yaml`...), and the plan text mentioning the
  // project's stack means almost any of them can already be in the baseline
  // -- so on their own they are near-zero signal that a finding's SUBJECT
  // (as opposed to its file's generic shape) existed at round 1. Filtered
  // from basenames and prose alike, same as the English stopwords above.
  "test", "tests", "spec", "specs", "mock", "mocks", "json", "yaml", "yml",
  "index", "config", "types", "type", "utils", "util", "helper", "helpers",
]);

/**
 * Identifier-shaped tokens (>=4 chars, word/underscore) from `text`, common
 * English filtered. `opts.maxTokens`, when given, caps the returned set size
 * (used only for the round-1 baseline, which is persisted); a per-finding
 * classification call omits it and lets the character-scan cap alone bound
 * cost.
 */
export function extractSubjectTokens(text: string, opts?: { readonly maxTokens?: number }): ExtractResult {
  const charTruncated = text.length > MAX_SCAN_CHARS;
  const scanned = charTruncated ? text.slice(0, MAX_SCAN_CHARS) : text;
  const tokens = new Set<string>();
  let tokenCapHit = false;
  for (const match of scanned.matchAll(IDENTIFIER_PATTERN)) {
    const raw = match[0];
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    // Lowercased BEFORE the Set add and the cap check (codex round 2,
    // correctness): every consumer of this Set only ever looks tokens up
    // through `hashToken`, which lowercases internally, so two case variants
    // of the same identifier are the same signal. Adding the raw-case string
    // here let case variants consume separate slots of the 500-token cap and
    // could trip `truncated` on a plan that was nowhere near the real limit.
    const token = raw.toLowerCase();
    if (STOPWORDS.has(token)) continue;
    if (opts?.maxTokens != null && !tokens.has(token) && tokens.size >= opts.maxTokens) {
      tokenCapHit = true;
      continue;
    }
    tokens.add(token);
  }
  return { tokens, truncated: charTruncated || tokenCapHit };
}

/**
 * Captured once, at PLAN_REVIEW's first `enter()` for a ticket, from plan.md
 * as it exists at that moment. Returned tokens are SHA-256 digests
 * (`hashToken`), never the raw plan-text substrings -- see the module
 * docblock.
 */
export function buildRound1Baseline(planText: string): { readonly tokens: readonly string[]; readonly truncated: boolean } {
  const { tokens, truncated } = extractSubjectTokens(planText, { maxTokens: MAX_BASELINE_TOKENS });
  return { tokens: Array.from(tokens, hashToken), truncated };
}

export type FindingClassification = "introduced" | "baseline" | "no-signal";

/**
 * Matches a path-shaped run embedded in free-form prose -- one or more
 * `segment/` prefixes followed by a final segment -- so it can be collapsed
 * to just that final segment (its basename) before tokenization.
 *
 * Codex round 2 (correctness): the native codex review path
 * (codex-review.ts's `normalizeFinding`) folds `file:line` INTO `description`
 * as literal text (`"src/autonomous/stages/widget.ts:42: ..."`) and every
 * reviewer is free to cite a path in prose even when a structured `file` is
 * also present. Stripping directory segments only off the structured field
 * left this text run untouched, so its `storybloq`/`src`/`autonomous`
 * segments still tokenized as prose and could still false-match a baseline
 * that mentions the project's own layout -- the exact failure basename-only
 * `file` handling was meant to close, just reached through `description`
 * instead.
 */
const EMBEDDED_PATH_PATTERN = /(?:[\w.-]+\/)+[\w.-]+/g;

function stripEmbeddedPathsToBasenames(text: string): string {
  return text.replace(EMBEDDED_PATH_PATTERN, (match) => match.split("/").pop() ?? match);
}

/**
 * Classifies one finding against the round-1 baseline (a set of `hashToken`
 * digests, per `buildRound1Baseline`).
 *
 * `no-signal` covers two distinct cases: the finding has no extractable
 * identifier-shaped tokens at all (generic prose), or its own subject text
 * was truncated AND no match was found within the scanned prefix -- an
 * unproven non-match from partial data is not evidence the subject is new,
 * so it must not count as "introduced". A match found within a truncated
 * scan is still trustworthy and returns "baseline".
 *
 * Only a file's BASENAME contributes tokens, never its full path -- whether
 * the path arrives as the structured `file` field or embedded in
 * `description` prose (see `stripEmbeddedPathsToBasenames`). Every file in a
 * project typically shares directory segments (`storybloq`, `src`,
 * `autonomous`, `stages`...) that the plan text almost certainly also
 * mentions, so tokenizing a full path would let an entirely new file classify
 * as "baseline" purely off a shared parent directory -- silently defeating
 * the detector on nearly every real finding. A handful of generic
 * filename/extension words (`test`, `json`, `config`...) are additionally
 * filtered as STOPWORDS for the same reason: on their own they are near-zero
 * signal that a finding's actual subject, not just its file's generic shape,
 * existed at round 1.
 */
export function classifyFinding(finding: DriftFinding, baseline: ReadonlySet<string>): FindingClassification {
  const basename = finding.file?.split(/[\\/]/).pop();
  const sanitizedDescription = stripEmbeddedPathsToBasenames(finding.description);
  const subjectText = [basename, sanitizedDescription].filter(Boolean).join(" ");
  const { tokens, truncated } = extractSubjectTokens(subjectText);
  if (tokens.size === 0) return "no-signal";
  for (const token of tokens) {
    if (baseline.has(hashToken(token))) return "baseline";
  }
  return truncated ? "no-signal" : "introduced";
}

/**
 * Fraction of `findings` classified "introduced", counted only over
 * signal-bearing findings (`introduced` + `baseline`; `no-signal` findings
 * contribute to neither the numerator nor the denominator). Returns `null`,
 * not `0`, when there is no signal-bearing finding at all -- "no drift
 * detected" and "nothing to measure" are different facts, and a null result
 * must not be recorded as a history entry (see `driftTriggered`).
 */
export function foldIntroducedFraction(
  findings: readonly DriftFinding[],
  baseline: ReadonlySet<string>,
): number | null {
  let introduced = 0;
  let counted = 0;
  for (const finding of findings) {
    const classification = classifyFinding(finding, baseline);
    if (classification === "no-signal") continue;
    counted++;
    if (classification === "introduced") introduced++;
  }
  return counted === 0 ? null : introduced / counted;
}

export const DRIFT_FRACTION_THRESHOLD = 0.5;
export const DRIFT_CONSECUTIVE_ROUNDS = 2;

export interface DriftRoundEntry {
  readonly round: number;
  readonly fraction: number;
}

/**
 * True when the last `DRIFT_CONSECUTIVE_ROUNDS` history entries are BOTH
 * above threshold AND genuinely adjacent (`round` values consecutive).
 *
 * The adjacency check matters because a round with no signal-bearing
 * findings contributes no history entry at all (see `foldIntroducedFraction`)
 * -- without requiring adjacency, two qualifying-but-non-consecutive rounds
 * separated by a no-signal gap would read as "the last two entries" and
 * falsely trigger.
 */
export function driftTriggered(history: readonly DriftRoundEntry[]): boolean {
  if (history.length < DRIFT_CONSECUTIVE_ROUNDS) return false;
  const recent = history.slice(-DRIFT_CONSECUTIVE_ROUNDS);
  for (let i = 0; i < recent.length; i++) {
    const entry = recent[i];
    if (!entry || entry.fraction < DRIFT_FRACTION_THRESHOLD) return false;
    const previous = i > 0 ? recent[i - 1] : undefined;
    if (previous && entry.round !== previous.round + 1) return false;
  }
  return true;
}

/**
 * The round of the EARLIEST window in `history` for which `driftTriggered`
 * would have been true, or `null` if it never was.
 *
 * Used so a later round-ceiling park can report "drift would independently
 * have fired at round N" (Gate-1 ratification condition b) without needing a
 * separately persisted first-trigger marker: `planReviewDriftHistory.rounds`
 * already retains every round's entry, so this recomputes the answer from
 * that full record rather than tracking a second piece of state that could
 * drift out of sync with it.
 */
export function firstDriftTriggerRound(history: readonly DriftRoundEntry[]): number | null {
  for (let end = DRIFT_CONSECUTIVE_ROUNDS; end <= history.length; end++) {
    if (driftTriggered(history.slice(0, end))) return history[end - 1]?.round ?? null;
  }
  return null;
}
