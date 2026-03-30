import { execFile } from "node:child_process";
import type { GitResult, DiffStats } from "./session-types.js";

const GIT_TIMEOUT = 10_000;

// ---------------------------------------------------------------------------
// Core executor — async execFile with timeout, returns GitResult<T>
// ---------------------------------------------------------------------------

async function git<T>(
  cwd: string,
  args: string[],
  parse: (stdout: string) => T,
): Promise<GitResult<T>> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr?.trim() || (err as Error).message || "unknown git error";
        resolve({ ok: false, reason: "git_error", message });
        return;
      }
      try {
        resolve({ ok: true, data: parse(stdout) });
      } catch (parseErr) {
        resolve({ ok: false, reason: "parse_error", message: (parseErr as Error).message });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Check if cwd is inside a git repository. */
export async function gitIsRepo(cwd: string): Promise<GitResult<boolean>> {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"], (out) => out.trim() === "true");
}

/** Get porcelain status lines (both tracked and untracked). */
export async function gitStatus(cwd: string): Promise<GitResult<string[]>> {
  return git(cwd, ["status", "--porcelain"], (out) =>
    out.split("\n").filter((l) => l.length > 0),
  );
}

/** Get current HEAD hash and branch name (two git calls). */
export async function gitHead(cwd: string): Promise<GitResult<{ hash: string; branch: string | null }>> {
  const hashResult = await git(cwd, ["rev-parse", "HEAD"], (out) => out.trim());
  if (!hashResult.ok) return hashResult;

  const branchResult = await gitBranch(cwd);

  return {
    ok: true,
    data: {
      hash: hashResult.data,
      branch: branchResult.ok ? branchResult.data : null,
    },
  };
}

/** Get current branch name. Returns error if detached HEAD. */
export async function gitBranch(cwd: string): Promise<GitResult<string>> {
  return git(cwd, ["symbolic-ref", "--short", "HEAD"], (out) => out.trim());
}

/** Get merge-base between HEAD and a base branch. */
export async function gitMergeBase(cwd: string, base: string): Promise<GitResult<string>> {
  return git(cwd, ["merge-base", "HEAD", base], (out) => out.trim());
}

/** Get diff stats (files changed, insertions, deletions) against a base ref. */
export async function gitDiffStat(cwd: string, base: string): Promise<GitResult<DiffStats>> {
  return git(cwd, ["diff", "--numstat", base], parseDiffNumstat);
}

/** Get list of changed file names against a base ref. */
export async function gitDiffNames(cwd: string, base: string): Promise<GitResult<string[]>> {
  return git(cwd, ["diff", "--name-only", base], (out) =>
    out.split("\n").filter((l) => l.length > 0),
  );
}

/** Get blob hash for a file in the working tree. */
export async function gitBlobHash(cwd: string, file: string): Promise<GitResult<string>> {
  return git(cwd, ["hash-object", file], (out) => out.trim());
}

/** Get diff stats for staged (cached) changes. */
export async function gitDiffCachedStat(cwd: string): Promise<GitResult<DiffStats>> {
  return git(cwd, ["diff", "--cached", "--numstat"], parseDiffNumstat);
}

/** Get list of staged file names. */
export async function gitDiffCachedNames(cwd: string): Promise<GitResult<string[]>> {
  return git(cwd, ["diff", "--cached", "--name-only"], (out) =>
    out.split("\n").filter((l) => l.length > 0),
  );
}

/**
 * Stash dirty tracked files with a descriptive message.
 * Returns the stash commit hash (stable identifier — won't shift if other stashes are created).
 */
export async function gitStash(cwd: string, message: string): Promise<GitResult<string>> {
  // Push the stash
  const pushResult = await git(cwd, ["stash", "push", "-m", message], () => undefined);
  if (!pushResult.ok) return { ok: false, reason: pushResult.reason, message: pushResult.message };

  // Capture the commit hash of the stash we just created (it's at stash@{0} right now)
  const hashResult = await git(cwd, ["rev-parse", "stash@{0}"], (out) => out.trim());
  if (!hashResult.ok) {
    // Stash was created but we can't identify it — try to find by message, or pop it to restore workspace
    const listResult = await git(cwd, ["stash", "list", "--format=%gd %s"], (out) =>
      out.split("\n").filter(l => l.includes(message)),
    );
    if (listResult.ok && listResult.data.length > 0) {
      // Found by message — extract ref from first match
      const ref = listResult.data[0]!.split(" ")[0]!;
      const refHash = await git(cwd, ["rev-parse", ref], (out) => out.trim());
      if (refHash.ok) return { ok: true, data: refHash.data };
    }
    // Can't identify — do NOT pop blindly (could pop wrong stash if concurrent operations)
    return { ok: false, reason: "stash_hash_failed", message: "Stash created but could not be identified. Run `git stash list` to find and pop it manually." };
  }

  return { ok: true, data: hashResult.data };
}

/**
 * Pop a stash entry by commit hash. Finds the stash ref matching the hash,
 * then pops it. Falls back to simple `git stash pop` if no hash provided.
 */
export async function gitStashPop(cwd: string, commitHash?: string): Promise<GitResult<void>> {
  if (!commitHash) {
    return git(cwd, ["stash", "pop"], () => undefined);
  }

  // Find the stash ref that matches this commit hash
  const listResult = await git(cwd, ["stash", "list", "--format=%gd %H"], (out) =>
    out.split("\n").filter(l => l.length > 0).map(l => {
      const [ref, hash] = l.split(" ", 2);
      return { ref: ref!, hash: hash! };
    }),
  );
  if (!listResult.ok) {
    // Cannot list stashes — do NOT fall back to git stash pop (might pop wrong entry)
    return { ok: false, reason: "stash_list_failed", message: `Cannot list stash entries to find ${commitHash}. Run \`git stash list\` and pop manually.` };
  }

  const match = listResult.data.find(e => e.hash === commitHash);
  if (!match) {
    return { ok: false, reason: "stash_not_found", message: `No stash entry with commit hash ${commitHash}` };
  }

  return git(cwd, ["stash", "pop", match.ref], () => undefined);
}

/** List files changed in a specific commit (for ISS-046 early-commit detection). */
export async function gitDiffTreeNames(cwd: string, commitHash: string): Promise<GitResult<string[]>> {
  return git(cwd, ["diff-tree", "--name-only", "--no-commit-id", "-r", commitHash], (out) =>
    out.split("\n").filter((l) => l.trim().length > 0),
  );
}

// Strict ref format: hex SHA (short or full) or HEAD. Rejects option injection (leading -)
const SAFE_REF = /^[0-9a-f]{4,40}$/i;

/** Git log between two refs (oneline), capped at limit. Best-effort. */
export async function gitLogRange(
  cwd: string,
  from: string | null,
  to: string | null,
  limit = 20,
): Promise<GitResult<string[]>> {
  // Validate refs to prevent option injection from corrupted session state
  if (from && !SAFE_REF.test(from)) {
    return { ok: false, reason: "invalid_ref", message: `Invalid git ref: ${from}` };
  }
  if (to && !SAFE_REF.test(to)) {
    return { ok: false, reason: "invalid_ref", message: `Invalid git ref: ${to}` };
  }
  // Require both from and to for a meaningful session range
  if (!from || !to) {
    return { ok: true, data: [] };
  }
  return git(cwd, ["log", "--oneline", `-${limit}`, `${from}..${to}`], (out) =>
    out.split("\n").filter((l) => l.trim().length > 0),
  );
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseDiffNumstat(out: string): DiffStats {
  const lines = out.split("\n").filter((l) => l.length > 0);
  let insertions = 0;
  let deletions = 0;
  let filesChanged = 0;

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parseInt(parts[0]!, 10);
    const removed = parseInt(parts[1]!, 10);
    if (!Number.isNaN(added)) insertions += added;
    if (!Number.isNaN(removed)) deletions += removed;
    filesChanged++;
  }

  return { filesChanged, insertions, deletions, totalLines: insertions + deletions };
}
