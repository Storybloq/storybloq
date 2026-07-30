/**
 * ISS-899: the ONE place session ownership precedence is expressed.
 *
 * FIVE independent copies of this logic existed, and they had already drifted:
 * two in the guide (`liveOwnershipConflict` and `handleResume`) and three in the
 * CLI (`session compact-prepare`, the SessionStart resume-prompt, and the
 * limit-stop owner filter). Each answered "may this caller touch this session?"
 * with its own hand-rolled booleans. The filing knew about four; the fifth was
 * found by the architecture pin in `test/autonomous/ownership-iss899.test.ts`
 * on its first run, which is the argument for pinning the shape rather than
 * trusting a comment not to be ignored. The resolution lives here and consumers
 * map the verdict onto their own gating rather than recomputing it.
 *
 * The verdict deliberately separates "the caller is someone else" from "the
 * caller has no identity at all". None of the five modelled that second case as
 * a verdict of its own, and they compensated in opposite directions: the two
 * guide seams mapped it to "no conflict" and failed OPEN, while the three CLI
 * gates grouped it with unauthorized callers and failed CLOSED. Only the CLI
 * gates truly collapsed the two, since the guide seams did refuse an IDENTIFIED
 * foreign caller. Naming the case here makes each consumer state which
 * treatment it means instead of inheriting whichever its author assumed.
 *
 * `via` records WHICH recorded owner matched, because the two are not
 * interchangeable policy-wise. The owner ruling for this issue covers
 * `ownerTask` sessions only; the legacy-id population is deliberately left on
 * its existing behaviour, and consumers express that by reading `via`.
 */
import { isSameOwnerTask, type OwnerTask } from "./client-profile.js";

/** Which recorded owner the verdict was resolved against. */
export type OwnershipVia = "ownerTask" | "legacyId";

export type SessionOwnership =
  /** No owner recorded at all. Any caller may proceed. */
  | { readonly kind: "unowned" }
  /** The caller is provably the recorded owner. */
  | { readonly kind: "same"; readonly via: OwnershipVia }
  /** The caller is identified and is provably NOT the recorded owner. */
  | { readonly kind: "foreign"; readonly via: OwnershipVia; readonly ownerDescription: string }
  /**
   * An owner is recorded and the caller has no identity, so ownership can be
   * neither proven nor disproven. Distinct from `foreign`: the remedy is to
   * establish identity, not to go to the owning task.
   */
  | {
      readonly kind: "unidentified-caller";
      readonly via: OwnershipVia;
      readonly ownerDescription: string;
    };

/** The subset of session state ownership depends on. */
export interface OwnableSession {
  readonly ownerTask?: OwnerTask | null;
  readonly claudeCodeSessionId?: string | null;
}

/**
 * Resolve who owns `state` relative to `callerTask`.
 *
 * Precedence, unchanged from the five copies this replaces: `ownerTask`, else
 * `claudeCodeSessionId`, else unowned. The legacy id is compared VERBATIM. An
 * id that fails `CLIENT_TASK_ID_PATTERN` still reads as an owner: normalizing
 * it to null would reclassify an owned session as unowned and route it to
 * auto-resume, which is the ISS-848 shape in reverse.
 */
export function resolveSessionOwnership(
  state: OwnableSession,
  callerTask: OwnerTask | null | undefined,
): SessionOwnership {
  const caller = callerTask ?? null;

  if (state.ownerTask) {
    const ownerDescription = `another live ${state.ownerTask.client} task`;
    if (!caller) return { kind: "unidentified-caller", via: "ownerTask", ownerDescription };
    return isSameOwnerTask(state.ownerTask, caller)
      ? { kind: "same", via: "ownerTask" }
      : { kind: "foreign", via: "ownerTask", ownerDescription };
  }

  if (state.claudeCodeSessionId) {
    const ownerDescription = "another live legacy Claude Code task";
    if (!caller) return { kind: "unidentified-caller", via: "legacyId", ownerDescription };
    return caller.client === "claude" && state.claudeCodeSessionId === caller.id
      ? { kind: "same", via: "legacyId" }
      : { kind: "foreign", via: "legacyId", ownerDescription };
  }

  return { kind: "unowned" };
}

/**
 * True when the caller is allowed to act because it is provably the owner or
 * there is no owner to be. The two CLI paths gate on exactly this, and they
 * gate identically, so the predicate is shared rather than restated.
 *
 * Note this is FALSE for `unidentified-caller` in both `via` cases, which is
 * the pre-existing behaviour of both CLI copies and is preserved.
 */
export function callerMayAct(ownership: SessionOwnership): boolean {
  return ownership.kind === "same" || ownership.kind === "unowned";
}

/**
 * The remedy handed to a caller refused for having no identity. One builder so
 * the three steps cannot drift between entry points.
 *
 * Ordered deliberately. Establishing identity is the designed path and is
 * executable by every supported client; the terminal escape comes last and must
 * be executable with NO identity at all, which is why it is the administrative
 * CLI rather than `takeover: true` -- that call is itself rejected without a
 * `clientTaskId`, so naming it would hand the caller an action that fails for
 * the same reason it was blocked (the ISS-848 shape).
 */
export function unidentifiedCallerRemedy(sessionId: string): string {
  return [
    "This task has no client task id, so ownership can be neither proven nor disproven.",
    "1. Establish identity: use the `[storybloq-client-task]` marker if your client injects one, " +
      "or probe it with `printenv CLAUDE_CODE_SESSION_ID` (Claude Code) or `printenv CODEX_THREAD_ID` (Codex), " +
      "then pass it as `clientTaskId`.",
    "2. With an identity established: a caller matching the recorded owner proceeds normally; " +
      "one that does not match should monitor instead, or recover only after confirming the recorded owner task is gone.",
    `3. If no identity can be established at all, end the session administratively: ` +
      `\`storybloq session list\`, then \`storybloq session stop ${sessionId}\`.`,
  ].join("\n");
}
