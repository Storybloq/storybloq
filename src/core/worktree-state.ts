import { execFileSync } from "node:child_process";

/**
 * C-v4.1 6.2: the worktree state recorded at receipt append (built in
 * commit 3; proof rule 3 reads it). One `git status` with the config that
 * could hide a change overridden. Paths under `.story/` are not counted.
 * A submodule at its expected commit with modified or untracked content is
 * dirty. Any failure is `unavailable`.
 */

export interface WorktreeCounts {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly submodule: number;
}

export type WorktreeState = WorktreeCounts | "unavailable";

const ARGS = [
  "-c", "status.showUntrackedFiles=all", "-c", "diff.ignoreSubmodules=none", "-c", "submodule.recurse=false",
  "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none",
];

const counted = (path: string) => path !== ".story" && !path.startsWith(".story/");

export function worktreeState(cwd: string): WorktreeState {
  let out: string;
  try {
    out = execFileSync("git", ARGS, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "unavailable";
  }
  const counts = { staged: 0, unstaged: 0, untracked: 0, submodule: 0 };
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "") continue;
    const type = token[0];
    if (type === "?") {
      if (counted(token.slice(2))) counts.untracked++;
      continue;
    }
    if (type === "!" || type === "#") continue;
    const fields = token.split(" ");
    // 1: 8 fields then the path; 2: 9 then the path, and the original path in the next token; u: 10 then the path.
    const before = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : -1;
    if (before < 0) return "unavailable";
    const path = fields.slice(before).join(" ");
    // A rename or copy counts when either side is outside `.story/` (a move into `.story/` still changes the tree).
    const original = type === "2" ? tokens[++i] ?? "" : undefined;
    if (!counted(path) && (original === undefined || !counted(original))) continue;
    const xy = fields[1] ?? "";
    const sub = fields[2] ?? "";
    if (xy[0] !== ".") counts.staged++;
    if (xy[1] !== ".") counts.unstaged++;
    if (sub[0] === "S" && (sub[2] === "M" || sub[3] === "U")) counts.submodule++;
  }
  return counts;
}
