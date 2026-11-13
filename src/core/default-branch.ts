import { execFileSync } from "node:child_process";

/**
 * The default branch: the remote's symbolic HEAD target (`origin/HEAD ->
 * origin/main`), falling back to `init.defaultBranch`, null when neither
 * resolves (never a guess). The same rule as branch-allocation-warning.ts
 * and board-git-state.ts, as one callable helper: receipt add uses it
 * (C-v4.1 commit 3) and the commit 4 snapshot will.
 */
export function resolveDefaultBranch(root: string, remote = "origin"): string | null {
  const run = (args: string[]): string | null => {
    try {
      const out = execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };
  const symbolic = run(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`]);
  if (symbolic !== null) return symbolic.startsWith(`${remote}/`) ? symbolic.slice(remote.length + 1) : symbolic;
  return run(["config", "init.defaultBranch"]);
}
