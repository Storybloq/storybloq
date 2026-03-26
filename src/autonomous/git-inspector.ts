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
