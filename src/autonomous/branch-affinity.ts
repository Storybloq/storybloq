import { displayIdOf } from "../core/resolver.js";
/**
 * Branch affinity detection for PICK_TICKET stage.
 * Pure functions (detection/annotation), plus async branch creation helpers for Part 2.
 */

import type { GitResult } from "./session-types.js";
import { gitHead, gitStatus, gitBlobHash, gitCheckoutNewBranch, gitBranchExists, gitCheckoutBranch, gitCheckRefFormat, resolveMainBranch, gitRevParse } from "./git-inspector.js";

// --- Types ---

export interface BranchAffinity {
  status: "none" | "matched" | "ambiguous";
  matchedIds: string[];
  branch: string | null;
}

export interface AffinityAnnotation {
  warningText: string | null;
}

// --- Constants ---

const PROTECTED_BRANCHES = new Set([
  "main", "master", "develop", "dev", "staging", "production",
]);

// ISS-752 accepted limitation: a team item lacking a displayId produces a
// canonical-id branch name (e.g. story/t-3fg59pn3sfeja1v1-slug) that this
// regex does not match, so branch affinity is inert for that branch. The
// loss is annotation-only (no false blocking, no false ending). The regex is
// deliberately NOT extended to 16-char crockford canonical ids because such
// runs collide with ordinary slug words.
const ENTITY_ID_REGEX = /(?:^|[/_-])(T-\d+[a-z]?|ISS-\d+)(?=$|[/_-])/gi;

// --- Functions ---

export function detectBranchAffinity(branch: string | null): BranchAffinity {
  if (!branch) {
    return { status: "none", matchedIds: [], branch };
  }

  const baseName = branch.includes("/") ? branch.split("/").pop()! : branch;
  if (PROTECTED_BRANCHES.has(baseName) || PROTECTED_BRANCHES.has(branch)) {
    return { status: "none", matchedIds: [], branch };
  }

  const matches: string[] = [];
  let match: RegExpExecArray | null;
  ENTITY_ID_REGEX.lastIndex = 0;
  while ((match = ENTITY_ID_REGEX.exec(branch)) !== null) {
    const raw = match[1]!;
    // Normalize prefix to uppercase (T-, ISS-) but preserve digit+suffix casing
    const id = raw.replace(/^(t-|iss-)/i, (p) => p.toUpperCase());
    if (!matches.some(m => m.toUpperCase() === id.toUpperCase())) {
      matches.push(id);
    }
  }

  if (matches.length === 0) {
    return { status: "none", matchedIds: [], branch };
  }
  if (matches.length === 1) {
    return { status: "matched", matchedIds: matches, branch };
  }
  return { status: "ambiguous", matchedIds: matches, branch };
}

/**
 * ISS-752: The pick is blocked only when NO id in pickedIds matches the
 * branch's matched ids (case-insensitive). Callers pass the full id set of
 * the resolved item (canonical id + displayId + previousDisplayIds) so a
 * canonical-id pick on a display-id branch is not falsely blocked.
 * pickedLabel is the single human-facing name used in the reason string.
 */
export function checkAffinityMismatch(
  affinity: BranchAffinity,
  pickedIds: readonly string[],
  pickedLabel: string,
): { blocked: boolean; reason: string } {
  if (affinity.status !== "matched") {
    return { blocked: false, reason: "" };
  }
  const matched = affinity.matchedIds.map(id => id.toUpperCase());
  if (pickedIds.some(id => matched.includes(id.toUpperCase()))) {
    return { blocked: false, reason: "" };
  }
  return {
    blocked: true,
    reason: `Branch "${affinity.branch}" is scoped to ${affinity.matchedIds.join(", ")}. Picking ${pickedLabel} would contaminate this branch.`,
  };
}

export function buildAffinityAnnotation(affinity: BranchAffinity): AffinityAnnotation {
  switch (affinity.status) {
    case "matched":
      return {
        warningText: `**[Branch affinity]** This branch is for ${affinity.matchedIds.join(", ")}. Pick that unless you have a specific reason not to.`,
      };
    case "ambiguous":
      return {
        warningText: `**[Branch warning]** Multiple IDs detected in branch name (${affinity.matchedIds.join(", ")}). Pick carefully or use targeted mode.`,
      };
    case "none":
    default:
      return { warningText: null };
  }
}

// --- T-328 / D3: the mismatch offer ---

/**
 * How many recoverable control failures an episode absorbs before it gives up.
 *
 * Deliberately under the generic `stuckRetryCount` threshold of 5, which
 * bypasses the cancel gate. Every control failure (main unresolvable, checkout
 * rejected, refresh failed, malformed report) costs a retry, so an unbounded
 * episode would end through that generic path instead of its own -- leaving the
 * guide somewhere nobody designed it to be.
 */
export const MAX_MISMATCH_CONTROL_FAILURES = 3;

export interface BranchAttempt {
  readonly name: string;
  readonly baseOid: string;
  readonly status: "planned";
}

export interface PendingMismatch {
  readonly targetId: string;
  readonly targetKind: "ticket" | "issue";
  readonly branch: string;
  readonly controlFailures: number;
  readonly attempt: BranchAttempt | null;
}

/**
 * The offer text. Names all three escapes with the exact action each reports,
 * because an escape the caller cannot spell is not an escape.
 */
export function buildMismatchOfferInstruction(
  affinity: BranchAffinity,
  attemptedPick: string,
  sessionId: string,
): string {
  return [
    "# Branch Mismatch",
    "",
    `You picked **${attemptedPick}**, but this branch (\`${affinity.branch}\`) is scoped to **${affinity.matchedIds.join(", ")}**.`,
    "Working here would mix unrelated work into that branch's history.",
    "",
    "Choose one:",
    "",
    `1. **Pick a matching item** -- report \`ticket_picked\` or \`issue_picked\` with one of ${affinity.matchedIds.join(", ")}.`,
    "2. **Branch fresh from main for this item** -- the guide switches to main and creates the branch for you:",
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "new_branch_from_main" } }`,
    "```",
    `3. **Skip ${attemptedPick}** and move on:`,
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "skip_ticket" } }`,
    "```",
    "4. **End the session** with a handover:",
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "end_session" } }`,
    "```",
    "",
    `Re-reporting **${attemptedPick}** unchanged ends the session with a handover.`,
  ].join("\n");
}

/**
 * Reserve room for a `-NN` suffix so a long title cannot push a collision
 * candidate past git's ref limits.
 */
export const SLUG_BUDGET_WITH_SUFFIX = 36;
const MAX_BRANCH_NAME_ATTEMPTS = 25;

/**
 * Pick a branch name that is NOT already taken.
 *
 * `createTicketBranch` adopts an existing branch of the same name, which is
 * right for resuming per-ticket work and wrong here: the existing branch may
 * have been created from the very base this escape exists to get away from, and
 * calling it "fresh" would be a lie.
 */
export async function findUnusedBranchName(
  root: string,
  target: BranchTarget,
): Promise<GitResult<string>> {
  const prefix = branchPrefixFor(target.kind);
  const id = target.displayId ?? target.canonicalId;
  const base = buildTicketBranchName(id, target.title, prefix, SLUG_BUDGET_WITH_SUFFIX);

  for (let attempt = 1; attempt <= MAX_BRANCH_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const validFormat = await gitCheckRefFormat(root, candidate);
    // Distinguish "git said this name is invalid" from "git could not be run".
    // Retrying a subprocess failure 25 times and then reporting exhaustion
    // would bury the real cause behind a misleading message.
    if (!validFormat.ok) return validFormat as GitResult<string>;
    if (!validFormat.data) continue;
    const exists = await gitBranchExists(root, candidate);
    if (!exists.ok) return exists as GitResult<string>;
    if (!exists.data) return { ok: true, data: candidate };
  }
  return {
    ok: false,
    reason: "git_error",
    message: `Could not find an unused branch name for ${id} after ${MAX_BRANCH_NAME_ATTEMPTS} attempts`,
  };
}

export type NewBranchOutcome =
  | { ok: true; branchName: string; refreshed: RefreshedGitState }
  /** `retryable` keeps the episode open so the caller can fix and re-report. */
  | { ok: false; message: string; retryable: boolean; attempt: BranchAttempt | null };

/**
 * The `new_branch_from_main` escape: switch to main and branch fresh from there.
 *
 * The attempt is written down BEFORE git is touched. Recovery then turns on the
 * recorded ref rather than on a guess:
 *
 *   absent            -> the checkout never happened; re-run the same attempt
 *   present at base   -> we created it and nothing landed on it; adopt it
 *   present, moved    -> provenance unprovable; refuse
 *
 * A merge-base check cannot substitute for this: "main is an ancestor" is true
 * of any branch cut from main at any time, including one that predates this
 * attempt and carries someone else's commits.
 */
export async function performNewBranchFromMain(
  root: string,
  target: BranchTarget,
  recorded: BranchAttempt | null,
  /**
   * MUST persist the attempt durably and synchronously before returning, and
   * MUST throw if it cannot. The write-ahead guarantee is only as strong as
   * this callback: a memory-only implementation would let git create a branch
   * that no recorded attempt can later identify. `StageContext.writeState`
   * satisfies it (it calls `writeSessionSync` and propagates failures).
   */
  persistAttemptSync: (attempt: BranchAttempt) => void,
): Promise<NewBranchOutcome> {
  let attempt = recorded;

  // Recovery consults the RECORDED attempt first. Its name and baseOid are
  // frozen and self-sufficient, so a main branch deleted or renamed since the
  // attempt was written must not block recovering it -- resolving main up front
  // would fail the whole call and burn the episode's failure budget for a
  // question recovery never needed to ask.
  if (attempt) {
    const exists = await gitBranchExists(root, attempt.name);
    if (!exists.ok) {
      return { ok: false, message: `Could not inspect "${attempt.name}": ${exists.message}.`, retryable: true, attempt };
    }
    if (exists.data) {
      const tip = await gitRevParse(root, attempt.name);
      if (!tip.ok) {
        return { ok: false, message: `Could not read the tip of "${attempt.name}": ${tip.message}.`, retryable: true, attempt };
      }
      if (tip.data !== attempt.baseOid) {
        return {
          ok: false,
          retryable: false,
          attempt,
          message:
            `Branch "${attempt.name}" exists but its tip has moved from the commit this session recorded ` +
            `(${attempt.baseOid.slice(0, 7)} -> ${tip.data.slice(0, 7)}), so it cannot be shown to be the branch ` +
            "this session created. This is a conflict, not something to overwrite. Inspect it, then pick a different item or end the session.",
        };
      }
      const adopt = await gitCheckoutBranch(root, attempt.name);
      if (!adopt.ok) {
        return { ok: false, message: `Could not check out "${attempt.name}": ${adopt.message}.`, retryable: true, attempt };
      }
      const refreshedAdopt = await refreshGitWorkingState(root);
      if (!refreshedAdopt) {
        return { ok: false, message: `Checked out "${attempt.name}" but reading git state failed. Run \`git status\` and report again.`, retryable: true, attempt };
      }
      return { ok: true, branchName: attempt.name, refreshed: refreshedAdopt };
    }
    // Recorded but absent: the previous attempt never got as far as creating
    // the ref. Retry it verbatim rather than minting another suffix.
  }

  if (!attempt) {
    // Only a NEW attempt needs main resolved, which is why this sits here
    // rather than at the top of the function.
    const main = await resolveMainBranch(root);
    if (!main.ok) {
      return { ok: false, message: `Cannot branch from main: ${main.message}.`, retryable: true, attempt: null };
    }
    const name = await findUnusedBranchName(root, target);
    if (!name.ok) {
      return { ok: false, message: name.message, retryable: true, attempt: null };
    }
    const baseOid = await gitRevParse(root, main.data);
    if (!baseOid.ok) {
      return { ok: false, message: `Could not resolve "${main.data}": ${baseOid.message}.`, retryable: true, attempt: null };
    }
    attempt = { name: name.data, baseOid: baseOid.data, status: "planned" };
    // Write-ahead: durable before git runs, so a crash in between leaves a
    // record that recovery can identify rather than an orphan branch.
    persistAttemptSync(attempt);
  }

  const created = await gitCheckoutNewBranch(root, attempt.name, attempt.baseOid);
  if (!created.ok) {
    return { ok: false, message: `Could not create "${attempt.name}" from main: ${created.message}. Resolve that and report again.`, retryable: true, attempt };
  }
  const refreshed = await refreshGitWorkingState(root);
  if (!refreshed) {
    return { ok: false, message: `Created "${attempt.name}" but reading git state failed. Run \`git status\` and report again.`, retryable: true, attempt };
  }
  return { ok: true, branchName: attempt.name, refreshed };
}

export function buildMismatchHandoverInstruction(
  affinity: BranchAffinity,
  attemptedPick: string,
  sessionId: string,
  storyCommand: "/story" | "$story" = "/story",
): string {
  return [
    "# Branch Mismatch -- Session Ending",
    "",
    `You attempted to pick **${attemptedPick}** but this branch (\`${affinity.branch}\`) is scoped to **${affinity.matchedIds.join(", ")}**.`,
    "Picking a different ticket would contaminate this branch's history.",
    "",
    "Write a handover documenting this mismatch and end the session.",
    "",
    "**To work on other tickets after this session ends:**",
    `- Switch to \`main\` and run \`${storyCommand} auto\` from there`,
    `- Use targeted mode: \`${storyCommand} auto ${attemptedPick}\` (skips the branch check)`,
    '- Set `branchStrategy: "per-ticket"` in config (auto-creates branches per ticket)',
    "",
    "Call `storybloq_autonomous_guide` with:",
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "handover_written", "handoverContent": "Session ended due to branch mismatch: branch ${affinity.branch} is for ${affinity.matchedIds.join(", ")}, attempted to pick ${attemptedPick}." } }`,
    "```",
  ].join("\n");
}

// --- Part 2: Per-ticket branch creation ---

export function buildTicketBranchName(
  id: string,
  title: string,
  prefix: "story" | "fix" = "story",
  /** T-328: callers that may append a `-NN` collision suffix pass a smaller
   * budget so the suffixed name still fits inside git's ref limits. */
  slugBudget = 40,
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, slugBudget)
    .replace(/-$/g, "");
  return `${prefix}/${id}-${slug}`;
}

export interface BranchCreationResult {
  branchName: string;
  created: boolean;
}

export async function createTicketBranch(
  root: string,
  gitState: { branch: string | null; mergeBase: string | null; initHead?: string },
  ticket: { id: string; displayId?: string; title: string },
  prefix: "story" | "fix" = "story",
): Promise<GitResult<BranchCreationResult>> {
  const branchName = buildTicketBranchName(displayIdOf(ticket), ticket.title, prefix);

  // 1. Idempotency: already on correct branch?
  if (gitState.branch === branchName) {
    return { ok: true, data: { branchName, created: false } };
  }

  // 2. Validate ref format
  const refCheck = await gitCheckRefFormat(root, branchName);
  if (refCheck.ok && !refCheck.data) {
    return { ok: false, reason: "git_error", message: `Invalid branch name: ${branchName}` };
  }

  // 3. Branch exists? (resume scenario)
  const exists = await gitBranchExists(root, branchName);
  if (exists.ok && exists.data) {
    const checkout = await gitCheckoutBranch(root, branchName);
    if (!checkout.ok) return checkout as GitResult<BranchCreationResult>;
    return { ok: true, data: { branchName, created: false } };
  }

  // 4. Create new branch from initHead (immutable session start, survives FINALIZE mergeBase mutation)
  const base = gitState.initHead ?? gitState.mergeBase ?? "HEAD";
  const create = await gitCheckoutNewBranch(root, branchName, base);
  if (!create.ok) return create as GitResult<BranchCreationResult>;

  return { ok: true, data: { branchName, created: true } };
}

// --- T-328: one strategy application shared by the ticket and issue paths ---

/**
 * The minimum an item needs to have a branch made for it. `kind` decides the
 * prefix, so the two handlers cannot drift into different namespaces.
 */
export interface BranchTarget {
  readonly canonicalId: string;
  readonly displayId?: string;
  readonly title: string;
  readonly kind: "ticket" | "issue";
}

export type RefreshedGitState = NonNullable<Awaited<ReturnType<typeof refreshGitWorkingState>>>;

export type ApplyStrategyResult =
  | { ok: true; refreshed?: RefreshedGitState; branchName?: string }
  /** `message` is the retry instruction. Never a silent pass-through. */
  | { ok: false; message: string };

export function branchPrefixFor(kind: "ticket" | "issue"): "story" | "fix" {
  return kind === "issue" ? "fix" : "story";
}

/**
 * Put the repository on the branch the configured strategy says this item
 * belongs on.
 *
 * Called only AFTER every eligibility gate has passed: a pick that is blocked,
 * tombstoned, out of scope, or claimed by someone else must leave the
 * repository exactly where it found it.
 */
export async function applyBranchStrategy(
  root: string,
  strategy: string,
  gitState: { branch: string | null; mergeBase: string | null; initHead?: string } | undefined,
  target: BranchTarget,
): Promise<ApplyStrategyResult> {
  if (strategy !== "per-ticket" && strategy !== "main") return { ok: true };

  const headResult = await gitHead(root);
  if (!headResult.ok) {
    return { ok: false, message: `branchStrategy is "${strategy}" but git is unavailable: ${headResult.message}. Fix git access or set branchStrategy to "current".` };
  }
  if (headResult.data.branch === null) {
    return { ok: false, message: `branchStrategy is "${strategy}" but HEAD is detached. Check out a branch, or set branchStrategy to "current".` };
  }

  const current = gitState ?? { branch: headResult.data.branch, mergeBase: null };

  if (strategy === "main") {
    const resolved = await resolveMainBranch(root);
    if (!resolved.ok) {
      return { ok: false, message: `branchStrategy is "main" but ${resolved.message}. Create one, or set branchStrategy to "current".` };
    }
    if (headResult.data.branch === resolved.data) return { ok: true, branchName: resolved.data };

    const checkout = await gitCheckoutBranch(root, resolved.data);
    if (!checkout.ok) {
      return { ok: false, message: `Could not switch to "${resolved.data}": ${checkout.message}. Resolve that, then report the pick again.` };
    }
    const refreshed = await refreshGitWorkingState(root);
    if (!refreshed) {
      return { ok: false, message: `Switched to "${resolved.data}" but reading the resulting git state failed. Run \`git status\` and report the pick again.` };
    }
    return { ok: true, refreshed, branchName: resolved.data };
  }

  // per-ticket. The base is deliberately unchanged from what shipped
  // (initHead ?? mergeBase ?? HEAD); see D6(b) in the T-328 plan for why moving
  // it to main is an owner decision rather than part of this change.
  const created = await createTicketBranch(
    root,
    current,
    { id: target.canonicalId, displayId: target.displayId, title: target.title },
    branchPrefixFor(target.kind),
  );
  if (!created.ok) {
    return { ok: false, message: `Branch creation failed: ${created.message}. Fix the issue and retry.` };
  }
  if (created.data.created || created.data.branchName !== current.branch) {
    const refreshed = await refreshGitWorkingState(root);
    if (!refreshed) {
      return { ok: false, message: `Branch "${created.data.branchName}" was checked out but git state refresh failed. Run \`git status\` and retry.` };
    }
    return { ok: true, refreshed, branchName: created.data.branchName };
  }
  return { ok: true, branchName: created.data.branchName };
}

export async function refreshGitWorkingState(root: string): Promise<{
  branch: string | null;
  expectedHead: string | undefined;
  baseline: { porcelain: string[]; dirtyTrackedFiles: Record<string, { blobHash: string }>; untrackedPaths: string[] };
} | null> {
  const head = await gitHead(root);
  const status = await gitStatus(root);
  if (!head.ok || !status.ok) return null;

  const porcelain = status.data;
  const dirtyTrackedFiles: Record<string, { blobHash: string }> = {};
  const untrackedPaths: string[] = [];

  for (const line of porcelain) {
    const code = line.slice(0, 2);
    const filePath = line.slice(3);
    if (code === "??") {
      untrackedPaths.push(filePath);
    } else {
      if (filePath.startsWith(".story/")) continue;
      const blobResult = await gitBlobHash(root, filePath);
      dirtyTrackedFiles[filePath] = { blobHash: blobResult.ok ? blobResult.data : "unknown" };
    }
  }

  return {
    branch: head.data.branch,
    expectedHead: head.data.hash,
    baseline: { porcelain, dirtyTrackedFiles, untrackedPaths },
  };
}
