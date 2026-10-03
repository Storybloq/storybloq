import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { discoverProjectRootShared } from "../../src/core/project-root-shared.js";

export function captureLocalContext(startDir: string) {
  const launchDir = realpathSync(startDir);
  let boundary = launchDir;
  // Git validates real worktrees, including .git files. A stale marker must
  // not make a plain task inherit an unrelated ancestor ledger. Inherited Git
  // routing/config variables belong to other commands, not this discovery.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    boundary = realpathSync(
      execFileSync("git", ["-C", launchDir, "rev-parse", "--show-toplevel"], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        maxBuffer: 16384,
      }).trim(),
    );
  } catch {
    // No usable Git boundary: discover only at the original task directory.
    // This also permits non-Git Storybloq projects without Git installed.
    boundary = launchDir;
  }
  // Capture once, including while no ledger exists. Setup can only activate
  // within this original task boundary, never a different task's directory.
  let pinned: string | null = null;
  return {
    launchDir,
    boundary,
    resolve: () => {
      if (pinned) return pinned;
      const root = discoverProjectRootShared(launchDir, {
        ignoreEnv: true,
        boundary,
        onUnreadableStoryDir: () => {
          throw new Error("The local Storybloq ledger is unreadable.");
        },
        onIncompleteStoryDir: () => {
          throw new Error(
            "The local Storybloq ledger is incomplete. Repair it before opening the board.",
          );
        },
      });
      if (root) pinned = realpathSync(root);
      return pinned;
    },
  };
}
