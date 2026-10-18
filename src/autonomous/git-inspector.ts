import { execFile } from "node:child_process";
import type { GitResult, DiffStats } from "./session-types.js";

const GIT_TIMEOUT = 10_000;

// ---------------------------------------------------------------------------
// Core executor -- async execFile with timeout, returns GitResult<T>
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

/**
 * ISS-1380: `git status --porcelain` that lists every untracked file whatever
 * the repository's `status.showUntrackedFiles` says. `gitStatus` follows that
 * setting, so with `no` an untracked file prints nothing and reads as clean.
 */
export async function gitStatusAllUntracked(cwd: string): Promise<GitResult<string[]>> {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"], (out) =>
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
 * Returns the stash commit hash (stable identifier -- won't shift if other stashes are created).
 */
export async function gitStash(cwd: string, message: string): Promise<GitResult<string>> {
  // Push the stash
  const pushResult = await git(cwd, ["stash", "push", "-m", message], () => undefined);
  if (!pushResult.ok) return { ok: false, reason: pushResult.reason, message: pushResult.message };

  // Capture the commit hash of the stash we just created (it's at stash@{0} right now)
  const hashResult = await git(cwd, ["rev-parse", "stash@{0}"], (out) => out.trim());
  if (!hashResult.ok) {
    // Stash was created but we can't identify it -- try to find by message, or pop it to restore workspace
    const listResult = await git(cwd, ["stash", "list", "--format=%gd %s"], (out) =>
      out.split("\n").filter(l => l.includes(message)),
    );
    if (listResult.ok && listResult.data.length > 0) {
      // Found by message -- extract ref from first match
      const ref = listResult.data[0]!.split(" ")[0]!;
      const refHash = await git(cwd, ["rev-parse", ref], (out) => out.trim());
      if (refHash.ok) return { ok: true, data: refHash.data };
    }
    // Can't identify -- do NOT pop blindly (could pop wrong stash if concurrent operations)
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
    // Cannot list stashes -- do NOT fall back to git stash pop (might pop wrong entry)
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

/** Check if `ancestor` is an ancestor of `descendant` (i.e., descendant is ahead). */
export async function gitIsAncestor(
  cwd: string, ancestor: string, descendant: string,
): Promise<GitResult<boolean>> {
  if (!SAFE_REF.test(ancestor) || !SAFE_REF.test(descendant)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  return new Promise((resolve) => {
    execFile("git", ["merge-base", "--is-ancestor", ancestor, descendant],
      { cwd, timeout: GIT_TIMEOUT },
      (err) => {
        if (!err) {
          resolve({ ok: true, data: true });
          return;
        }
        // Exit code 1 = not ancestor (valid result). Exit code is on .code (number) for process exits.
        const code = (err as any).code;
        if (code === 1) {
          resolve({ ok: true, data: false });
          return;
        }
        resolve({ ok: false, reason: "git_error", message: (err as Error).message });
      },
    );
  });
}

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

/** Lightweight HEAD hash only (no branch resolution), 3s timeout. */
export async function gitHeadHash(cwd: string): Promise<GitResult<string>> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd, timeout: 3000 }, (err, stdout) => {
      if (err) {
        const message = (err as any).stderr?.trim() || (err as Error).message || "unknown git error";
        resolve({ ok: false, reason: "git_error", message });
        return;
      }
      resolve({ ok: true, data: stdout.trim() });
    });
  });
}

/** Count commits reachable from `toSha` but not from `fromSha`. Validates refs via SAFE_REF. */
export async function gitCommitDistance(
  cwd: string, fromSha: string, toSha: string,
): Promise<GitResult<number>> {
  if (!SAFE_REF.test(fromSha) || !SAFE_REF.test(toSha)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  return git(cwd, ["rev-list", "--count", `${fromSha}..${toSha}`], (out) => {
    const n = parseInt(out.trim(), 10);
    if (Number.isNaN(n)) throw new Error(`unexpected rev-list output: ${out}`);
    return n;
  });
}

/** Resolve a hash (short or full) to its full 40-char SHA via rev-parse --verify. */
export async function gitResolveCommit(
  cwd: string, hash: string,
): Promise<GitResult<string>> {
  if (!SAFE_REF.test(hash)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--verify", `${hash}^{commit}`],
      { cwd, timeout: GIT_TIMEOUT },
      (err, stdout, stderr) => {
        if (err) {
          const message = stderr?.trim() || (err as Error).message || "unknown git error";
          resolve({ ok: false, reason: "git_error", message });
          return;
        }
        resolve({ ok: true, data: stdout.trim() });
      },
    );
  });
}

/**
 * List commits on the direct ancestry path between `from` and `to` that
 * modified `path`. Uses `rev-list --ancestry-path` to exclude merged-in
 * side-branch commits. The `path` is wrapped in `:(literal)` to neutralize
 * pathspec magic regardless of caller discipline.
 */
export async function gitRevListAncestryPath(
  cwd: string, from: string, to: string, path: string,
): Promise<GitResult<string[]>> {
  if (!SAFE_REF.test(from) || !SAFE_REF.test(to)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  if (!path || path.startsWith("-") || path.startsWith(":")) {
    return { ok: false, reason: "git_error", message: "invalid path" };
  }
  return git(
    cwd,
    ["rev-list", "--ancestry-path", "--reverse", `${from}..${to}`, "--", `:(literal)${path}`],
    (out) => out.split("\n").map((l) => l.trim()).filter((l) => l.length === 40),
  );
}

// ---------------------------------------------------------------------------
// T-328: Branch operations for per-ticket branch creation
// ---------------------------------------------------------------------------

/** Create a new branch at a specific base and check it out. */
export async function gitCheckoutNewBranch(cwd: string, branchName: string, base: string): Promise<GitResult<void>> {
  return git(cwd, ["checkout", "-b", branchName, base], () => undefined);
}

/** Check if a local branch exists. Exit code 1 = not found, other errors propagated. */
export async function gitBranchExists(cwd: string, branchName: string): Promise<GitResult<boolean>> {
  return new Promise((resolve) => {
    execFile("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd, timeout: GIT_TIMEOUT }, (err) => {
      if (err) {
        // execFile sets err.code to numeric exit code for process exits.
        // Exit code 1 = ref not found. Any other error (spawn failure, timeout) is a real error.
        const exitCode = (err as unknown as { code?: number }).code;
        if (exitCode === 1) {
          resolve({ ok: true, data: false });
        } else {
          resolve({ ok: false, reason: "git_error", message: (err as Error).message });
        }
        return;
      }
      resolve({ ok: true, data: true });
    });
  });
}

/** Check out an existing branch. */
export async function gitCheckoutBranch(cwd: string, branchName: string): Promise<GitResult<void>> {
  return git(cwd, ["checkout", branchName], () => undefined);
}

/** Validate a branch name against git's ref format rules. */
export async function gitCheckRefFormat(cwd: string, refName: string): Promise<GitResult<boolean>> {
  return new Promise((resolve) => {
    execFile("git", ["check-ref-format", "--branch", refName], { cwd, timeout: GIT_TIMEOUT }, (err) => {
      if (err) {
        resolve({ ok: true, data: false });
        return;
      }
      resolve({ ok: true, data: true });
    });
  });
}

/**
 * T-328: resolve what `branchStrategy: "main"` means in this repository.
 *
 * The contract is main-PREFERRED, not default-branch-aware: `main` if it exists
 * locally, else `master`. A repo that keeps a vestigial `main` while `master` is
 * its real default gets `main`. That is a deliberate simplification over reading
 * `refs/remotes/<remote>/HEAD`, and it is why the config value is spelled
 * "main" rather than "trunk".
 *
 * Resolution is local-only: no fetch, no remote probe, no fast-forward. A stale
 * local `main` is used as-is.
 */
export async function resolveMainBranch(cwd: string): Promise<GitResult<string>> {
  for (const candidate of ["main", "master"]) {
    const exists = await gitBranchExists(cwd, candidate);
    if (!exists.ok) return exists as GitResult<string>;
    if (exists.data) return { ok: true, data: candidate };
  }
  return {
    ok: false,
    reason: "git_error",
    message: "Neither a local \"main\" nor a local \"master\" branch exists",
  };
}

/** Resolve a ref to its commit OID. */
export async function gitRevParse(cwd: string, ref: string): Promise<GitResult<string>> {
  return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], (out) => out.trim());
}

export async function gitUserEmail(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["config", "user.email"], (out) => out.trim());
  return result.ok && result.data ? result.data : null;
}

/**
 * Committer email recorded ON a specific commit (ISS-982), as opposed to
 * `gitUserEmail`'s live, ambient `user.email` config. No `--` separator: with
 * one, git treats `hash` as a PATH FILTER rather than a revision and silently
 * returns empty output for every real hash.
 */
export async function gitCommitterEmail(cwd: string, hash: string): Promise<GitResult<string>> {
  if (!SAFE_REF.test(hash)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  return git(cwd, ["log", "-1", "--format=%ce", hash], (out) => out.trim());
}

/** The repository's object hash format ("sha1" or "sha256"). */
export async function gitObjectFormat(cwd: string): Promise<GitResult<string>> {
  return git(cwd, ["rev-parse", "--show-object-format"], (out) => out.trim());
}

/**
 * T-474: writes the tree object for the CURRENTLY STAGED index -- standard
 * git plumbing (used internally by `git commit` itself), content-addressed
 * and idempotent, not a working-tree mutation.
 */
export async function gitWriteTree(cwd: string): Promise<GitResult<string>> {
  return git(cwd, ["write-tree"], (out) => out.trim());
}

/**
 * T-474 (D2): a sha256-format repository's commit hashes are 64 hex chars,
 * longer than `SAFE_REF`'s 40-char (sha1-length) cap -- checking object
 * format BEFORE ref-shape validation is what makes the refusal message
 * actually name the real reason (unsupported repo format) instead of a
 * misleading "invalid ref format" that a too-long sha256 hash would
 * otherwise trip first.
 */
async function refuseUnlessSha1(cwd: string): Promise<{ ok: false; reason: string; message: string } | null> {
  const format = await gitObjectFormat(cwd);
  if (!format.ok) return format;
  if (format.data !== "sha1") {
    return { ok: false, reason: "unsupported_object_format", message: `gate-ack v1 only supports SHA-1 git repositories (found: ${format.data})` };
  }
  return null;
}

/**
 * Robustly counts a commit's parents via `git rev-list --parents -n 1
 * <sha>`, whose one-line output is `<commit> <parent1> <parent2> ...` --
 * never string-parses `rev-parse` output, which cannot express plurality at
 * all (`<sha>^` always names exactly the first parent, silently, for any
 * parent count).
 */
export async function gitParentCount(cwd: string, commitSha: string): Promise<GitResult<number>> {
  return git(cwd, ["rev-list", "--parents", "-n", "1", commitSha], (out) => {
    const tokens = out.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) throw new Error("empty rev-list output");
    return tokens.length - 1;
  });
}

/**
 * T-474 (AM3, codex round 1 finding #1): a merge commit's tree id fully
 * captures its resulting content but not its ancestry -- a commit sharing
 * the approved first parent and tree id could carry arbitrary additional
 * parents and still satisfy the same pin. v1 refuses merge commits entirely
 * rather than extending the pin's identity shape post-ratification: the same
 * posture as `refuseUnlessSha1` -- an unsupported commit shape is a NAMED
 * hard block, never a silent degradation. The autonomous FINALIZE flow never
 * produces a merge commit, so one appearing at a duet-gated commit is itself
 * a signal worth stopping on, not accommodating.
 */
async function refuseIfMergeCommit(cwd: string, commitSha: string): Promise<{ ok: false; reason: string; message: string } | null> {
  const count = await gitParentCount(cwd, commitSha);
  if (!count.ok) return count;
  if (count.data > 1) {
    return {
      ok: false,
      reason: "merge_commit_unsupported",
      message: `commit ${commitSha.slice(0, 12)} has ${count.data} parents -- merge commits are not supported by the pre-commit ack gate (v1); escalate to the pen`,
    };
  }
  return null;
}

/**
 * T-474 (D2): the committed commit's direct git parent. `ok: false` covers a
 * root commit (no parent), a merge commit (v1-unsupported, AM3), an
 * unresolvable sha, an unsupported (non-sha1) object format, or a git
 * process failure -- never a thrown exception, never a silently-absent or
 * silently-partial value treated as a matchable pin.
 */
export async function gitParentOf(cwd: string, commitSha: string): Promise<GitResult<string>> {
  const refusal = await refuseUnlessSha1(cwd);
  if (refusal) return refusal;
  if (!SAFE_REF.test(commitSha)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  const mergeRefusal = await refuseIfMergeCommit(cwd, commitSha);
  if (mergeRefusal) return mergeRefusal;
  return git(cwd, ["rev-parse", `${commitSha}^`], (out) => out.trim());
}

/**
 * T-474 (D2): the committed commit's own tree object id, read directly from
 * the commit object -- no diff computation at all. Refuses a sha256 object
 * format (v1 constraint, R1-FIX 12) and a merge commit (v1 constraint, AM3)
 * for the same reason `gitParentOf` does: called standalone, this must not
 * be the caller's only line of defense against either unsupported shape.
 */
export async function gitTreeOf(cwd: string, commitSha: string): Promise<GitResult<string>> {
  const refusal = await refuseUnlessSha1(cwd);
  if (refusal) return refusal;
  if (!SAFE_REF.test(commitSha)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  const mergeRefusal = await refuseIfMergeCommit(cwd, commitSha);
  if (mergeRefusal) return mergeRefusal;
  return git(cwd, ["rev-parse", `${commitSha}^{tree}`], (out) => out.trim());
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

/**
 * T-495: commits touching one path, with their committer dates.
 *
 * The window filter is applied by the CALLER in JavaScript, not by
 * `--since`/`--until`. Those options walk history with a heuristic that can
 * stop early on non-linear history, so a commit inside the window can be
 * missed; and a date that came out of a config file would reach the argv of a
 * git invocation. Neither is acceptable for a check whose whole job is to
 * detect a change that a week's verdict then depends on. Listing every commit
 * for one path and comparing instants in memory has neither problem.
 */
export async function gitLogTouchingPath(
  cwd: string,
  path: string,
): Promise<GitResult<readonly { hash: string; committedAt: string }[]>> {
  if (path.startsWith("-")) {
    return { ok: false, reason: "invalid_ref", message: `Refusing path that reads as an option: ${path}` };
  }
  // `--full-history` is REQUIRED, not a refinement. A path-limited `git log`
  // applies history simplification by default: at a merge that is TREESAME for
  // this path to one parent, git can skip the other parent entirely, hiding a
  // branch that changed REVIEW.md and restored it before the merge. Filtering
  // dates afterwards cannot recover a commit the walk never emitted, so the
  // check would report a clean count over history it did not look at. Codex
  // found it.
  return git(cwd, ["log", "--full-history", "--format=%H %cI", "--", path], (out) =>
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        const sp = l.indexOf(" ");
        return sp === -1
          ? { hash: l, committedAt: "" }
          : { hash: l.slice(0, sp), committedAt: l.slice(sp + 1) };
      }),
  );
}

/**
 * Whether one path differs from what git has recorded.
 *
 * An UNTRACKED file counts as dirty. The question this answers is whether the
 * bytes on disk are the ones the repository can account for, and an untracked
 * REVIEW.md is exactly as unaccounted for as a modified one.
 */
export async function gitPathDirty(cwd: string, path: string): Promise<GitResult<boolean>> {
  if (path.startsWith("-")) {
    return { ok: false, reason: "invalid_ref", message: `Refusing path that reads as an option: ${path}` };
  }
  // BOTH FLAGS MATTER. `git status` omits ignored files by default, so an
  // untracked REVIEW.md covered by `.gitignore` or a global ignore rule prints
  // nothing and reads as clean, which contradicts the rule this function
  // states. `--untracked-files=all` keeps an untracked file visible when it
  // sits under an untracked directory that would otherwise be collapsed to the
  // directory name.
  return git(
    cwd,
    ["status", "--porcelain", "--ignored=matching", "--untracked-files=all", "--", path],
    (out) => out.split("\n").some((l) => l.trim().length > 0),
  );
}

// ---------------------------------------------------------------------------
// T-527: knowledge review. Path-only reads of history; nothing here writes.
// ---------------------------------------------------------------------------

export interface ChangedPath {
  /** Git's status letter: A, M, D, T, R or C (a rename or copy score is dropped). */
  readonly status: string;
  readonly path: string;
  /** The source path of a rename or copy, so both endpoints are known. */
  readonly oldPath?: string;
}

/**
 * Committed changes between two commits, rename endpoints included. `-z`
 * keeps an unusual path (a space, a newline, a quote) byte-exact, where the
 * default output would quote it.
 */
export async function gitChangedPaths(cwd: string, from: string, to: string): Promise<GitResult<ChangedPath[]>> {
  if (!SAFE_REF.test(from) || !SAFE_REF.test(to)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  return git(cwd, ["diff", "--name-status", "-z", "-M", from, to], (out) => {
    const fields = out.split("\0");
    const changed: ChangedPath[] = [];
    let i = 0;
    while (i < fields.length && fields[i] !== "") {
      const status = fields[i]!.charAt(0);
      if (status === "R" || status === "C") {
        const oldPath = fields[i + 1];
        const path = fields[i + 2];
        if (oldPath === undefined || path === undefined) throw new Error("truncated rename record");
        changed.push({ status, path, oldPath });
        i += 3;
      } else {
        const path = fields[i + 1];
        if (path === undefined) throw new Error("truncated change record");
        changed.push({ status, path });
        i += 2;
      }
    }
    return changed;
  });
}

/**
 * Whether the working tree's `.story/` differs from HEAD: a modified, staged,
 * deleted or untracked path. Plain porcelain on purpose: ignored paths
 * (`.story/sessions/`, `.story/snapshots/`) are session state, not ledger,
 * which is why `gitPathDirty` (which reports ignored files) is not used here.
 */
export async function gitStoryDirty(cwd: string): Promise<GitResult<boolean>> {
  return git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ".story/"], (out) => out.length > 0);
}

/**
 * Commits in `from..to`, oldest first. `firstParent` walks only the mainline
 * (what HEAD's own history did); without it every reachable commit is listed,
 * including those on a merged side branch.
 */
export async function gitRevList(
  cwd: string, from: string, to: string, opts: { firstParent: boolean; mergesOnly?: boolean },
): Promise<GitResult<string[]>> {
  if (!SAFE_REF.test(from) || !SAFE_REF.test(to)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  const args = [
    "rev-list", "--reverse",
    ...(opts.firstParent ? ["--first-parent"] : []),
    ...(opts.mergesOnly ? ["--merges"] : []),
    `${from}..${to}`,
  ];
  return git(cwd, args, (out) => out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
}

/**
 * Paths one commit changed against its FIRST parent. For a merge that is what
 * the merge brought into the mainline, so code arriving through a merged side
 * branch is seen at the merge itself.
 *
 * `--diff-merges=first-parent`, not `-m --first-parent`: `diff-tree` does not
 * honour `--first-parent`, so `-m` diffs a merge against EVERY parent and
 * would report the mainline's own earlier changes as the merge's.
 */
export async function gitCommitPaths(cwd: string, commit: string): Promise<GitResult<string[]>> {
  if (!SAFE_REF.test(commit)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  return git(cwd, ["diff-tree", "--no-commit-id", "-r", "--root", "--name-only", "-z", "--diff-merges=first-parent", commit], (out) =>
    out.split("\0").filter((p) => p.length > 0),
  );
}

/** A commit's first parent, or null for a root commit. */
export async function gitFirstParent(cwd: string, commit: string): Promise<GitResult<string | null>> {
  if (!SAFE_REF.test(commit)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  return git(cwd, ["rev-list", "--parents", "-n", "1", commit], (out) => out.trim().split(" ")[1] ?? null);
}

/** The tree id of `.story` at a commit, or null when the commit has no `.story` directory. */
export async function gitStoryTree(cwd: string, commit: string): Promise<GitResult<string | null>> {
  if (!SAFE_REF.test(commit)) {
    return { ok: false, reason: "git_error", message: "invalid ref format" };
  }
  return git(cwd, ["ls-tree", "-z", commit, "--", ".story"], (out) => {
    const line = out.split("\0").find((l) => l.length > 0);
    if (line === undefined) return null;
    const meta = line.slice(0, line.indexOf("\t")).split(" ");
    if (meta[1] !== "tree" || meta[2] === undefined) throw new Error(".story is not a directory at this commit");
    return meta[2];
  });
}
