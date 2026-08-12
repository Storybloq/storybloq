import { execFileSync } from "node:child_process";
import { currentStorybloqClient } from "../client-profile.js";
import {
  REVIEW_EFFORTS,
  effectiveReviewEffort,
  effortBackends,
  effortDeliberateClause,
  effortDepthSentence,
  type ReviewEffort,
} from "../review-effort.js";

export { currentStorybloqClient } from "../client-profile.js";

export interface ReviewBackendConfig {
  readonly reviewBackends: readonly string[];
  readonly codexReviewBackends?: readonly string[];
}

export function reviewBackendsForClient(config: ReviewBackendConfig): readonly string[] {
  if (currentStorybloqClient() === "codex") {
    return config.codexReviewBackends ?? ["lenses"];
  }
  return config.reviewBackends;
}

/** The slice of session state stage-level backend selection reads. */
export interface StageBackendState {
  readonly config: ReviewBackendConfig;
  readonly resolvedStages?: Record<string, Record<string, unknown>> | null;
  readonly resolvedReviewEffort?: {
    readonly level?: string | null;
    readonly explicitKnobs?: {
      readonly planReviewBackends?: boolean;
      readonly codeReviewBackends?: boolean;
    } | null;
  } | null;
  // T-461 phase 3: the dial narrows the chosen list. Optional so every existing
  // caller and test literal still satisfies the interface -- and absent reads
  // as `standard`, which narrows nothing.
  readonly currentReviewEffort?: string | null;
  readonly mode?: string | null;
}

/**
 * Backends for one review stage, honoring a project's per-stage override.
 *
 * `stages.PLAN_REVIEW.backends` and `stages.CODE_REVIEW.backends` have been
 * documented in SKILL.md and orchestrator-mode.md for a long time and were
 * never read by anything: every stage called `reviewBackendsForClient` and
 * ignored the resolved stage config. This is where that promise is kept.
 *
 * GATED ON THE T-461 MARKER, which is the load-bearing part. Sessions created
 * before that ticket froze the RECIPE's stage backends into `resolvedStages`
 * (coding.json used to ship `["lenses", "codex", "agent"]` there), and the
 * stages of their era ignored those arrays. Honoring them on resume would
 * silently change a frozen session's reviewers, and its cost, mid-flight. So a
 * session with no marker keeps exactly the pre-T-461 selection.
 *
 * A DAMAGED marker is treated as absent for the same reason, and "damaged"
 * means more than null. The session schema is deliberately permissive so a
 * corrupt record cannot brick a resume, which means it also admits `{}` and a
 * marker whose level is gone. Those cannot prove the session was created after
 * the change, so the gate asks for structural proof rather than mere presence.
 */
function isPostDialMarker(marker: unknown): boolean {
  if (typeof marker !== "object" || marker === null) return false;
  const { level, source } = marker as { level?: unknown; source?: unknown };
  // BOTH fields must be values handleStart could actually have written. An
  // earlier version accepted any level string, reasoning that a post-dial
  // session with a typo'd level is still post-dial. That was wrong: handleStart
  // never writes an invalid level, so a typo'd one is corruption on EITHER
  // side of the gate, and when both branches are corruption the question is
  // only which mistake is worse. Wrongly reading a legacy session as post-dial
  // revives its frozen recipe backends and changes a running session's
  // reviewers and cost. Wrongly reading a post-dial session as legacy just
  // ignores a per-stage override until the session ends. The second is the one
  // to prefer.
  //
  // Read from REVIEW_EFFORTS rather than restating the values, so a level added
  // there cannot silently fail this check.
  const levelOk = typeof level === "string"
    && ((REVIEW_EFFORTS as readonly string[]).includes(level) || level === "size-mapped");
  const sourceOk = source === "start-call" || source === "project" || source === "default";
  return levelOk && sourceOk;
}

export function reviewBackendsForStage(
  stage: "PLAN_REVIEW" | "CODE_REVIEW",
  state: StageBackendState,
): readonly string[] {
  const clientBackends = reviewBackendsForClient(state.config);
  if (!isPostDialMarker(state.resolvedReviewEffort)) return clientBackends;

  const knobs = state.resolvedReviewEffort?.explicitKnobs;
  const projectSetBackends = stage === "PLAN_REVIEW"
    ? knobs?.planReviewBackends === true
    : knobs?.codeReviewBackends === true;

  /**
   * The dial narrows WITHIN whatever list was chosen; it never adds a backend
   * and never overrides a list the PROJECT set. That second half is what
   * `explicitKnobs` exists for: after resolveRecipe's shallow merge a
   * recipe-shipped value is indistinguishable from a project-set one, and the
   * dial may supersede the former but never the latter.
   */
  const narrow = (chosen: readonly string[]): readonly string[] =>
    projectSetBackends ? chosen : effortBackends(effectiveReviewEffort(state, stage), chosen);

  const configured = state.resolvedStages?.[stage]?.backends;
  // Every entry must be a usable string. A partially malformed array falls back
  // rather than being filtered: a project that meant three reviewers and typed
  // one of them wrong should get its configured behavior or the default, not a
  // silently narrowed review it never asked for.
  if (
    Array.isArray(configured)
    && configured.length > 0
    && configured.every((b) => typeof b === "string" && b.length > 0)
  ) {
    return narrow(configured as readonly string[]);
  }
  return narrow(clientBackends);
}

/**
 * The depth wording for ONE reviewer, or null where the reviewer composes its
 * own review and cannot take an instruction from the caller.
 *
 * ONE place decides this, and every emitter asks it. There are four: each
 * stage's enter() and each stage's retry instruction, and a retry is returned
 * VERBATIM by processAdvance without enter() ever running, so a copy that
 * drifted would show up as round 2 of a light review silently asking for a
 * standard one.
 *
 * `lenses` fans out programmatically and the native CLI runs a fixed command,
 * so neither takes a depth ask. The `deliberate` argument narrows further
 * still: it belongs to the codex-bridge MCP tools and to nothing else.
 */
export function reviewDepthLine(
  effort: ReviewEffort,
  kind: "plan" | "code",
  reviewer: string,
  config: ReviewBackendConfig,
): string | null {
  // Deliberately the CONFIGURED native path, not `shouldUseNativeCodexReview`.
  // That predicate ends in `hasNativeCodexCli()`, a `codex --version`
  // subprocess with a five-second timeout, and this function decides PROSE. A
  // retry instruction is returned verbatim out of report(), so probing here
  // would put a subprocess spawn on every retry of a native-codex project and
  // could block report handling behind a missing or hung binary. It would also
  // be a SECOND probe whose answer can differ from the one enter() already
  // made, which would suppress the depth ask on an instruction that is not
  // native after all.
  //
  // This is the same condition with the probe removed, so it errs one way only:
  // a project configured for native codex whose binary is absent falls to the
  // caller-composed branch and gets no depth ask. That drops a sentence; the
  // alternative emits one the reviewer cannot act on, and the disclosure line
  // carries the level either way.
  const configuredNative = currentStorybloqClient() === "codex"
    && config.codexReviewBackends?.includes("codex") === true
    && reviewer === "codex";
  if (reviewer === "lenses" || configuredNative) return null;
  const bridge = currentStorybloqClient() === "claude" && reviewer === "codex";
  const line = [
    effortDepthSentence(effort, kind),
    bridge ? effortDeliberateClause(effort) : null,
  ].filter(Boolean).join(" ");
  return line.length > 0 ? line : null;
}

export function hasNativeCodexCli(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function nativeCodexReviewCommand(kind: "plan" | "code", sessionId: string): string {
  return `storybloq codex-review ${kind} --session ${sessionId} --format guide-report`;
}

export function shouldUseNativeCodexReview(reviewer: string, config: ReviewBackendConfig): boolean {
  return currentStorybloqClient() === "codex"
    && config.codexReviewBackends?.includes("codex") === true
    && reviewer === "codex"
    && hasNativeCodexCli();
}

export function nativeCodexReportInstruction(sessionId: string): string {
  return [
    "The command prints a JSON report. Pass that report to `storybloq_autonomous_guide`:",
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": <paste codex-review JSON> }`,
    "```",
  ].join("\n");
}
