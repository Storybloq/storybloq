/**
 * Multi-lens review preparation on the @storybloq/lenses package API
 * (ISS-823, pen ruling R2).
 *
 * prepare = carry-over consumer harness (context packaging, secrets gate,
 * path safety, per-lens caching) + package activate() + per-activation
 * buildLensPrompt(). The package is the single source for lens bodies,
 * shared preamble, and activation rules; this module only decides what each
 * lens sees (context-packager), redacts secrets before prompts leave the
 * process (secrets-gate), and mints/persists the round's cache keys and
 * anchoring artifact for the synthesize step.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  formatCitedRulingsSection,
  formatCitedRulingsSectionBounded,
} from "../../core/output-formatter.js";
import type { CitationResolution } from "../../core/ruling.js";
import { join } from "node:path";
import {
  LENSES,
  activate,
  buildLensPrompt,
  PreambleConfigSchema,
  type LensFinding,
  type Stage,
  type StartParams,
} from "@storybloq/lenses";
import { packageContext } from "./context-packager.js";
import { runSecretsGate, redactArtifactSecrets } from "./secrets-gate.js";
import { buildCacheKey, getFromCache } from "./cache.js";

/** The two lensConfig keys that have consumers. Everything else was pruned. */
interface LensActivationConfig {
  /** "auto" = the registry's own activation, unfiltered. */
  readonly lenses: "auto" | readonly string[];
  /** null = uncapped. */
  readonly maxLenses: number | null;
}

/**
 * Read `recipeOverrides.lensConfig` off disk.
 *
 * Straight off disk, not from the parsed config, for the reason synthesize.ts
 * loadMergerConfig does the same: `ConfigSchema.recipeOverrides` is a plain
 * z.object, so it STRIPS keys it does not declare and the value would never
 * survive to a consumer.
 *
 * Every malformed value falls back to the permissive default rather than
 * failing, because the alternative is a config typo turning off lens review.
 */
function loadLensActivationConfig(projectRoot: string | undefined): LensActivationConfig {
  const fallback: LensActivationConfig = { lenses: "auto", maxLenses: null };
  if (!projectRoot) return fallback;
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, ".story", "config.json"), "utf-8"));
    const lc = raw?.recipeOverrides?.lensConfig;
    if (!lc || typeof lc !== "object" || Array.isArray(lc)) return fallback;

    // Every name must be a KNOWN lens. A partially misspelled list is the
    // dangerous shape: `["security", "securty"]` has a non-empty intersection,
    // so an empty-result guard alone would let it through and it would drop
    // every other active lens on the strength of one typo. Falling back whole
    // is the same rule the per-stage review backends use -- a project that
    // meant three and typed one wrong gets its set or the default, never a
    // silently narrowed review. A known lens that is not ACTIVE for this stage
    // is not a typo and does not trip this.
    const lenses = Array.isArray(lc.lenses)
      && lc.lenses.length > 0
      && lc.lenses.every((l: unknown) =>
        typeof l === "string" && (ALL_LENS_IDS as readonly string[]).includes(l))
      ? (lc.lenses as readonly string[])
      : "auto" as const;

    // Bounded 1-8 to match the documented range. A value outside it is a
    // mistake, and honoring it would either disable review (0 or negative) or
    // read as a cap that is not one.
    const maxLenses = typeof lc.maxLenses === "number"
      && Number.isInteger(lc.maxLenses)
      && lc.maxLenses >= 1
      && lc.maxLenses <= 8
      ? lc.maxLenses
      : null;

    return { lenses, maxLenses };
  } catch {
    return fallback;
  }
}

// ISS-716: the assembled lens prompt is bounded upstream (per-lens artifact
// by the token budget, project rules by the 2000-char slice in
// context-packager), so this cap is a backstop against a pathological
// prompt, not the primary size control.
const MAX_PROMPT_SIZE = 200_000;

const TOKEN_BUDGET_PER_LENS = 32_000;

/** Session file carrying prepare-minted state into synthesize. */
export const HARNESS_META_FILE = "lens-harness-meta.json";

export interface HarnessMeta {
  readonly reviewId: string;
  readonly stage: Stage;
  readonly cacheKeys: Record<string, string>;
  /**
   * The full artifact the lenses actually saw, persisted ONLY when secrets
   * redaction changed it (synthesize must anchor quotes against the redacted
   * bytes, not the raw diff the agent passes back).
   */
  readonly anchorArtifact?: string;
  readonly secretsMetaFinding?: LensFinding | null;
  /**
   * T-494: lens id -> ruling ids whose CONTENT that lens did not receive.
   * Persisted so `synthesize` can hold the verdict and suppress the cache
   * write-back even when it is handed no metadata by the caller.
   */
  readonly citedRulingsUndelivered?: Record<string, readonly string[]>;
}

export interface PrepareInput {
  readonly stage: Stage;
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly ticketDescription?: string;
  readonly reviewRound?: number;
  readonly priorDeferrals?: readonly string[];
  readonly projectRoot: string;
  readonly sessionDir?: string;
  readonly sessionId?: string;
  /** T-494: resolved citations of the item under review, resolved by the caller. */
  readonly citedRulings?: readonly CitationResolution[];
  /**
   * T-494: why the caller could not find out what the item cites.
   *
   * Distinct from an empty `citedRulings`, and the distinction is the point of
   * this ticket: "this item cites nothing" and "I could not find out what it
   * cites" are different claims, and a reviewer shown neither cannot tell them
   * apart. The three review-packet routes already carry this; a lens prompt
   * carries it too, so an absent rulings block is never read as an absence of
   * rulings.
   */
  readonly citedRulingsUnavailable?: string;
}

export interface PreparedLensPrompt {
  readonly lens: string;
  readonly model: string;
  readonly prompt: string;
  readonly promptRef: string;
  readonly promptTruncated: boolean;
  readonly cached: boolean;
  readonly cachedFindings?: readonly LensFinding[];
  /**
   * T-494: ruling ids whose CONTENT could not be delivered to this lens.
   *
   * Never an empty array standing in for "all delivered" -- absent means
   * nothing was omitted. Present means this lens reviewed WITHOUT decisions
   * that bind the item, which `synthesize` turns into a `nextActions` entry.
   * That entry, not this field and not any finding severity, is what stops the
   * verdict being `approve`.
   */
  readonly omittedCitedRulings?: readonly string[];
}

export interface PrepareOutput {
  readonly lensPrompts: readonly PreparedLensPrompt[];
  readonly artifact: string;
  readonly metadata: {
    readonly activeLenses: readonly string[];
    readonly skippedLenses: readonly string[];
    /** Per-lens activation status disclosure (pen ruling R2). */
    readonly activationReasons: Record<string, string>;
    readonly secretsGateActive: boolean;
    readonly reviewRound: number;
    readonly reviewId: string;
    readonly secretsMetaFinding: LensFinding | null;
    /** T-494: lens id -> ruling ids whose content that lens did not receive. */
    readonly citedRulingsUndelivered: Record<string, readonly string[]>;
    /** T-494: echoed back, so the caller reads the same reason the lenses did. */
    readonly citedRulingsUnavailable?: string;
    /** T-494: lenses whose prompt could not carry even the unavailability note. */
    readonly citedRulingsDisclosureUndelivered?: readonly string[];
  };
}

const ALL_LENS_IDS = Object.keys(LENSES) as readonly (keyof typeof LENSES)[];

/**
 * T-494: fits the cited-rulings block into what is LEFT of a lens prompt.
 *
 * WHY THE ADDITION IS MEASURED AGAINST REMAINING CAPACITY, NOT AGAINST THE CAP.
 * `handlePrepare` replaces the whole prompt with an EMPTY STRING once it passes
 * `MAX_PROMPT_SIZE`, which is total delivery failure rather than truncation. An
 * earlier revision of this design argued that 3,000 characters against a
 * 200,000 cap could not plausibly cause that. That compares the addition with
 * the LIMIT instead of with what is left: a CODE_REVIEW prompt embeds the diff,
 * so a prompt already a few hundred characters below the cap is reachable and
 * one ruling then empties it. The feature would be the cause.
 *
 * WHAT IS FITTED IS THE RENDERED BLOCK, NOT THE RULING TEXT. Budgeting text
 * alone spends nothing on the heading, the per-citation metadata, the caveat,
 * the truncation markers, or on Markdown escaping expanding the text it does
 * count: with 1,000 characters remaining, a 900-character text passes that
 * check and still overflows.
 *
 * THE ASSERT IS WHAT ACTUALLY CARRIES THE GUARANTEE. Every arithmetic decision
 * here is checked against the ASSEMBLED prompt before it is returned, so an
 * accounting error becomes a fallback to the base prompt rather than an emptied
 * one.
 */
interface RulingFit {
  readonly prompt: string;
  /** Ruling ids whose CONTENT this lens will not receive. Empty means none. */
  readonly omittedIds: readonly string[];
  /** T-494: false when this prompt had no room even for the unavailability note. */
  readonly disclosureDelivered: boolean;
}

function fitCitedRulings(args: {
  citations: readonly CitationResolution[];
  activation: Parameters<typeof buildLensPrompt>[0]["activation"];
  startParams: StartParams;
  preambleConfig: Parameters<typeof buildLensPrompt>[0]["preambleConfig"];
  baseProjectRules: string;
  knownFP: string;
  /** T-494: the unavailability disclosure, or "" when the item resolved. */
  unavailableNote: string;
}): RulingFit {
  const { citations, activation, startParams, preambleConfig, baseProjectRules, knownFP, unavailableNote } = args;

  const assemble = (projectRules: string): string =>
    buildLensPrompt({
      activation,
      startParams,
      preambleConfig,
      projectContext: {
        projectRules,
        ...(knownFP ? { knownFalsePositives: knownFP } : {}),
      },
    }).prompt;

  // THE DISCLOSURE IS FITTED TOO, and it has to be.
  //
  // It used to be concatenated into `baseProjectRules` by the caller, which put
  // it INSIDE the measurement rather than subject to it. On the resolution-
  // failure path `citations` is empty, so this function returns before the
  // assembled-length check below ever runs, and a prompt sitting just under the
  // cap could be pushed over it by the disclosure alone and then emptied by the
  // pre-existing fail-to-zero path (ISS-1134). That is this feature causing
  // TOTAL delivery failure, the exact class of defect two earlier rounds
  // rejected. So the bare prompt is measured first and the note is added only
  // if the result still fits.
  const barePrompt = assemble(baseProjectRules);
  const notedPrompt =
    unavailableNote === "" ? barePrompt : assemble(`${baseProjectRules}${unavailableNote}`);
  const disclosureDelivered = unavailableNote === "" || notedPrompt.length <= MAX_PROMPT_SIZE;
  const basePrompt = disclosureDelivered ? notedPrompt : barePrompt;
  const fittedRules = disclosureDelivered ? `${baseProjectRules}${unavailableNote}` : baseProjectRules;
  if (citations.length === 0) return { prompt: basePrompt, omittedIds: [], disclosureDelivered };

  const allIds = citations.map((c) => (c.status === "resolved" ? c.current.id : c.citedId));
  const remaining = MAX_PROMPT_SIZE - basePrompt.length;

  // The metadata floor: what the block costs with NO ruling text at all. If
  // even that does not fit, the block is dropped whole and every citation is
  // reported undelivered. The base prompt still goes out intact -- this feature
  // never empties a prompt that would otherwise have been delivered.
  //
  // `>` and not `>=`: a floor that fits EXACTLY at the cap is delivered, which
  // matches the assert below (`> MAX_PROMPT_SIZE`). Both comparisons now read
  // the cap the same way, and the metadata tier still reaches the reviewer in
  // the boundary case instead of being dropped one character early.
  const floor = formatCitedRulingsSectionBounded(citations, 0).text;
  if (floor.length > remaining) return { prompt: basePrompt, omittedIds: allIds, disclosureDelivered };

  // CAPACITY IS THE ONLY LIMIT, and arriving there took two corrections.
  //
  // The first version capped ruling text at a constant 3,000 characters. That
  // made a hold no rerun could clear: a longer ruling was truncated however
  // empty the prompt was, its id was reported undelivered, and the resulting
  // `nextActions` entry refused the review forever, because the instruction it
  // carries -- shrink the artifact and rerun -- moves capacity and cannot move
  // a constant. A gate whose clearing condition is unreachable is not a gate.
  //
  // The second version made the allowance a fraction of remaining capacity with
  // that constant as a floor. Same defect, further out: remaining is bounded by
  // the cap, so a quarter of it is still an absolute ceiling near 50,000, and a
  // 60,000-character ruling was held just as permanently. A mutant then showed
  // the fraction was doing nothing at all once an expansion step rescued it,
  // which is the honest reason it is gone rather than merely widened.
  //
  // So the budget is what the prompt actually has. A ruling can only take room
  // the prompt was not using, and every truncation is now capacity-bound, which
  // is what makes the retry instruction true. The cost is that a very large
  // ruling occupies a large share of a lens prompt; that is strictly better
  // than a review that can never pass, and it is bounded by the same cap
  // everything else here respects.
  const textBudget = Math.max(0, remaining - floor.length);
  const rendered = formatCitedRulingsSectionBounded(citations, textBudget);
  const withRulings = assemble(`${fittedRules}\n${rendered.text}`);

  // The assert. A miscount above lands here rather than in an emptied prompt.
  if (withRulings.length > MAX_PROMPT_SIZE) {
    return { prompt: basePrompt, omittedIds: allIds, disclosureDelivered };
  }
  return { prompt: withRulings, omittedIds: rendered.truncatedIds, disclosureDelivered };
}

export function handlePrepare(input: PrepareInput): PrepareOutput {
  // Guard: CODE_REVIEW with no changed files produces no lenses
  if (input.stage === "CODE_REVIEW" && input.changedFiles.length === 0) {
    const emptyReviewId = `lens-empty-${Date.now().toString(36)}`;
    // Overwrite any harness meta a prior round left behind so a later
    // synthesize can never anchor against a stale artifact or replay a stale
    // secrets meta-finding. (readHarnessMeta is also reviewId-gated, but this
    // keeps the on-disk state consistent with the round that just ran.)
    if (input.sessionDir) {
      try {
        writeFileSync(
          join(input.sessionDir, HARNESS_META_FILE),
          JSON.stringify(
            { reviewId: emptyReviewId, stage: input.stage, cacheKeys: {} } satisfies HarnessMeta,
            null,
            2,
          ),
        );
      } catch {
        /* best-effort */
      }
    }
    return {
      lensPrompts: [],
      artifact: input.diff,
      metadata: {
        activeLenses: [],
        skippedLenses: [],
        activationReasons: {},
        secretsGateActive: false,
        citedRulingsUndelivered: {},
        reviewRound: input.reviewRound ?? 1,
        reviewId: emptyReviewId,
        secretsMetaFinding: null,
      },
    };
  }

  const reviewId = `lens-${Date.now().toString(36)}`;
  const ticketDescription = input.ticketDescription ?? "Manual review";
  const reviewRound = input.reviewRound ?? 1;
  const knownFP = (input.priorDeferrals ?? []).join("\n");

  // 1. Activation via the package registry (surface rules + core set).
  const activations = activate({
    stage: input.stage,
    changedFiles: input.changedFiles,
  });

  // 1b. Apply the project's lensConfig (T-461). `lenses` and `maxLenses` were
  // documented in SKILL.md with zero consumers; this is where they take effect.
  // Read straight off disk like synthesize.ts loadMergerConfig, because
  // ConfigSchema.parse strips recipeOverrides keys it does not declare.
  const lensConfig = loadLensActivationConfig(input.projectRoot);
  const excluded: Record<string, string> = {};
  let selected = activations;

  if (lensConfig.lenses !== "auto") {
    const allowed = new Set(lensConfig.lenses);
    const filtered = selected.filter((a) => allowed.has(a.lensId as string));
    // An EMPTY intersection is misconfiguration, not an instruction to review
    // nothing. Misspelling every lens name would otherwise silently disable
    // lens review entirely, which is the one outcome no config mistake may
    // buy. The full activation stands and the mistake stays visible in the
    // reasons below rather than being applied.
    if (filtered.length > 0) {
      for (const a of selected) {
        if (!allowed.has(a.lensId as string)) excluded[a.lensId] = "excluded: lensConfig";
      }
      selected = filtered;
    }
  }

  if (lensConfig.maxLenses != null && selected.length > lensConfig.maxLenses) {
    for (const a of selected.slice(lensConfig.maxLenses)) {
      excluded[a.lensId] = "excluded: maxLenses cap";
    }
    selected = selected.slice(0, lensConfig.maxLenses);
  }

  const activeLenses = selected.map((a) => a.lensId as string);
  const skippedLenses = ALL_LENS_IDS.filter(
    (l) => !activeLenses.includes(l),
  ) as string[];
  const activationReasons: Record<string, string> = {};
  for (const a of selected) activationReasons[a.lensId] = a.activationReason;
  // Dropped lenses keep a reason too, so the existing disclosure surface says
  // WHY a lens did not run rather than leaving it silently absent.
  for (const [lensId, reason] of Object.entries(excluded)) activationReasons[lensId] = reason;

  // 2. Secrets gate BEFORE any prompt is assembled (redaction must happen
  // before content leaves the process).
  const secrets =
    input.changedFiles.length > 0
      ? runSecretsGate(input.changedFiles, input.projectRoot, false)
      : { active: false, secretsFound: false, redactedLines: new Map(), metaFinding: null };

  const redacted =
    secrets.secretsFound && input.stage === "CODE_REVIEW"
      ? redactArtifactSecrets(input.diff, secrets.redactedLines)
      : input.diff;

  // 3. Context packaging on the (possibly redacted) artifact.
  const ctx = packageContext({
    stage: input.stage,
    diff: redacted,
    changedFiles: input.changedFiles,
    activeLenses,
    ticketDescription,
    projectRoot: input.projectRoot,
    tokenBudgetPerLens: TOKEN_BUDGET_PER_LENS,
  });

  const preambleConfig = PreambleConfigSchema.parse({});
  // T-494: a resolution FAILURE is disclosed to the reviewer, not swallowed.
  //
  // Its own heading, so it can never collide with the rulings block, and in the
  // shared header rather than the block, so it survives every per-lens fit --
  // including the one that drops the rulings block whole for want of capacity.
  //
  // A DISCLOSURE and not a `nextActions` hold, on purpose. An undelivered
  // ruling exists and a shrunk artifact delivers it, so the hold names a
  // condition a rerun can clear. An unresolvable item leaves nothing for a
  // rerun of the LENS to fetch, so holding on it would be a gate whose clearing
  // condition is not in the reviewer's hands, which is the mistake this ticket
  // already made twice.
  const unavailableNote = input.citedRulingsUnavailable
    ? `\n\n## Cited Rulings: NOT AVAILABLE\n\n${input.citedRulingsUnavailable}. This review does not know which rulings bind the item; do not read the absence of a rulings block as an absence of rulings.`
    : "";
  const baseProjectRules = `${ctx.sharedHeader}\n\n${ctx.fileManifest}`;

  // T-494. The FULL rendered block, unbounded, used for two things only: as the
  // ruling half of each lens's cache identity, and as the source the per-lens
  // fit shrinks from. It is never sent as-is.
  const citedRulings = input.citedRulings ?? [];
  // The note joins the fingerprint so cache identity changes with availability:
  // without it, a round that could not resolve the item is served findings from
  // a round that could, and the disclosure never reaches a lens.
  const rulingsFingerprint = `${formatCitedRulingsSection(citedRulings)}${unavailableNote}`;

  // 4. Per activation: fit, then cache check, then prompt construction.
  const lensPrompts: PreparedLensPrompt[] = [];
  const cacheKeys: Record<string, string> = {};
  const citedRulingsUndelivered: Record<string, readonly string[]> = {};
  // T-494: lenses whose prompt had no room even for the unavailability note.
  // Recorded rather than dropped, for the same reason the note exists at all.
  const disclosureUndelivered: string[] = [];

  for (const activation of activations) {
    const lens = activation.lensId;
    const artifact = ctx.perLensArtifacts.get(lens) ?? redacted;
    const cacheKey = buildCacheKey(
      lens,
      LENSES[lens].version,
      input.stage,
      artifact,
      ticketDescription,
      // T-494: ruling identity is part of cache identity. Without this a
      // changed or superseded ruling would serve findings from a reviewer that
      // saw the old one. The fingerprint is the FULL unbounded block, so it
      // changes when any cited ruling's id, chain position or text changes.
      `${ctx.projectRules}\n${rulingsFingerprint}`,
      knownFP,
    );
    cacheKeys[lens] = cacheKey;

    // Informational pointer: the prompt body's single source of truth.
    const ref = `@storybloq/lenses#${lens}`;

    // T-494. THE FIT IS COMPUTED BEFORE THE CACHE EARLY RETURN, deliberately.
    // The capacity check is what DISCOVERS an omission, and it lives in prompt
    // construction; leaving it after the `continue` below would mean a cached
    // lens never detects one, so there would be no finding to survive the cache
    // rather than a finding that survives it.
    const startParams: StartParams =
      input.stage === "CODE_REVIEW"
        ? {
            stage: "CODE_REVIEW",
            changedFiles: [...input.changedFiles] as [string, ...string[]],
            artifact,
            ticketDescription,
            reviewRound,
            priorDeferrals: [],
          }
        : {
            stage: "PLAN_REVIEW",
            artifact,
            ticketDescription,
            reviewRound,
            priorDeferrals: [],
          };

    const fit = fitCitedRulings({
      citations: citedRulings,
      activation,
      startParams,
      preambleConfig,
      baseProjectRules,
      knownFP,
      unavailableNote,
    });
    if (fit.omittedIds.length > 0) citedRulingsUndelivered[lens] = fit.omittedIds;
    if (!fit.disclosureDelivered) disclosureUndelivered.push(lens);

    const cached = input.sessionDir ? getFromCache(input.sessionDir, cacheKey) : null;
    if (cached) {
      lensPrompts.push({
        lens,
        model: activation.model,
        prompt: "",
        promptRef: ref,
        promptTruncated: false,
        cached: true,
        cachedFindings: cached,
        ...(fit.omittedIds.length > 0 ? { omittedCitedRulings: fit.omittedIds } : {}),
      });
      continue;
    }

    const prompt = fit.prompt;
    // The pre-existing fail-to-zero (ISS-1134): past MAX_PROMPT_SIZE the whole
    // prompt is replaced by an empty string. `fitCitedRulings` guarantees the
    // rulings block never CAUSES that crossing -- it asserts the assembled
    // length and falls back to the base prompt -- so anything still over the
    // cap here was over it before this feature existed.
    const truncated = prompt.length > MAX_PROMPT_SIZE;
    lensPrompts.push({
      lens,
      model: activation.model,
      prompt: truncated ? "" : prompt,
      promptRef: ref,
      promptTruncated: truncated,
      cached: false,
      ...(fit.omittedIds.length > 0 ? { omittedCitedRulings: fit.omittedIds } : {}),
    });
  }

  // 5. Persist harness meta for the synthesize step: cache keys for the
  // write-back, the redacted anchoring artifact (only when redaction changed
  // it), and the secrets meta-finding keyed by reviewId so a stale file from
  // an earlier round can never leak into a later one.
  if (input.sessionDir) {
    const meta: HarnessMeta = {
      reviewId,
      stage: input.stage,
      cacheKeys,
      ...(redacted !== input.diff ? { anchorArtifact: redacted } : {}),
      ...(secrets.metaFinding ? { secretsMetaFinding: secrets.metaFinding } : {}),
      ...(Object.keys(citedRulingsUndelivered).length > 0 ? { citedRulingsUndelivered } : {}),
    };
    try {
      writeFileSync(
        join(input.sessionDir, HARNESS_META_FILE),
        JSON.stringify(meta, null, 2),
      );
    } catch {
      // Best-effort: synthesize falls back to the agent-supplied inputs.
    }
  }

  return {
    lensPrompts,
    artifact: redacted,
    metadata: {
      activeLenses,
      skippedLenses,
      activationReasons,
      secretsGateActive: secrets.active,
      reviewRound,
      reviewId,
      secretsMetaFinding: secrets.metaFinding,
      citedRulingsUndelivered,
      ...(input.citedRulingsUnavailable ? { citedRulingsUnavailable: input.citedRulingsUnavailable } : {}),
      ...(disclosureUndelivered.length > 0 ? { citedRulingsDisclosureUndelivered: disclosureUndelivered } : {}),
    },
  };
}
