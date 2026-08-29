import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureGitignoreEntries, STORY_GITIGNORE_ENTRIES } from "./init.js";
import { withProjectLock, writeConfigUnlocked } from "./project-loader.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MERGE_DRIVER_VERSION = 1;
export const MERGE_DRIVER_NAME = "storybloq-json";
export const MERGE_DRIVER_CMD = "storybloq merge-driver %O %A %B %P";
export const MERGE_DRIVER_DISPLAY_NAME = "Storybloq JSON three-way merge";

/**
 * ISS-734: inline collision guidance printed by `team init` and `team setup`
 * whenever the effective id allocator is local. Surfaced at the point the
 * choice is made because the failure mode (duplicate display ids after a
 * merge of divergent branches) only shows up much later.
 */
export const LOCAL_ALLOCATOR_NOTE =
  "Note: the local id allocator can mint duplicate display ids across divergent branches; " +
  "run `storybloq reconcile` after merges, or use --id-allocator git-refs to prevent collisions at the source.";

const BLOCK_BEGIN = "# storybloq-merge-begin";
const BLOCK_END = "# storybloq-merge-end";

const GITATTRIBUTES_PATTERNS = [
  "tickets/*.json merge=storybloq-json",
  "issues/*.json merge=storybloq-json",
  "notes/*.json merge=storybloq-json",
  "lessons/*.json merge=storybloq-json",
  "arrangements/*.json merge=storybloq-json",
  "config.json merge=storybloq-json",
  "roadmap.json merge=storybloq-json",
];

async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
    return stdout.trim();
  } catch {
    throw new Error("Not inside a git repository");
  }
}

export async function installMergeDriver(gitRoot: string): Promise<void> {
  await execFileAsync(
    "git", ["config", "--local", `merge.${MERGE_DRIVER_NAME}.driver`, MERGE_DRIVER_CMD],
    { cwd: gitRoot, timeout: 5000 },
  );
  await execFileAsync(
    "git", ["config", "--local", `merge.${MERGE_DRIVER_NAME}.name`, MERGE_DRIVER_DISPLAY_NAME],
    { cwd: gitRoot, timeout: 5000 },
  );
}

export async function writeGitattributes(storyDir: string): Promise<void> {
  const filePath = join(storyDir, ".gitattributes");
  let existing = "";
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, "utf-8");
  }

  const blockContent = [BLOCK_BEGIN, ...GITATTRIBUTES_PATTERNS, BLOCK_END].join("\n");

  const beginIdx = existing.indexOf(BLOCK_BEGIN);
  const endIdx = existing.indexOf(BLOCK_END);

  let result: string;
  if (beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx) {
    const before = existing.substring(0, beginIdx);
    const after = existing.substring(endIdx + BLOCK_END.length);
    result = before + blockContent + after;
  } else {
    let cleaned = existing;
    if (beginIdx !== -1 || endIdx !== -1) {
      cleaned = cleaned.replace(new RegExp(`^[^\\S\\n]*${BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\S\\n]*\\n?`, "gm"), "");
      cleaned = cleaned.replace(new RegExp(`^[^\\S\\n]*${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\S\\n]*\\n?`, "gm"), "");
    }
    if (cleaned.length > 0 && !cleaned.endsWith("\n")) {
      cleaned += "\n";
    }
    result = cleaned + blockContent + "\n";
  }

  writeFileSync(filePath, result, "utf-8");
}

export async function updateConfigVersion(root: string): Promise<void> {
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = { ...state.config, team: { ...(state.config.team ?? {}) } };
    config.team.mergeDriverVersion = MERGE_DRIVER_VERSION;
    await writeConfigUnlocked(config, root);
  });
}

export interface SetupResult {
  driverInstalled: boolean;
  gitattributesWritten: boolean;
  versionUpdated: boolean;
  gitignoreEnsured: boolean;
  gitRoot: string;
  /** Effective id allocator after setup: anything but an explicit "git-refs" runs as "local". */
  idAllocator: "local" | "git-refs";
}

export async function teamSetup(root: string): Promise<SetupResult> {
  const storyDir = join(root, ".story");
  if (!existsSync(storyDir)) {
    throw new Error("No .story/ directory found");
  }

  const configPath = join(storyDir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error("No .story/config.json found");
  }

  const gitRoot = await findGitRoot(root);

  await installMergeDriver(gitRoot);
  await writeGitattributes(storyDir);
  await updateConfigVersion(root);
  // ISS-754: legacy projects upgraded to team mode predate init's gitignore
  // writing; without this, sessions/, snapshots/, status.json (absolute paths
  // including the username) become committed to the shared team repo.
  await ensureGitignoreEntries(join(storyDir, ".gitignore"), STORY_GITIGNORE_ENTRIES);

  // ISS-734: report the effective allocator so callers can surface the
  // local-allocator collision note. Re-read config.json: updateConfigVersion
  // just rewrote it, so this reflects the on-disk truth including any
  // pre-existing team.idAllocator.
  let idAllocator: "local" | "git-refs" = "local";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const team = config.team as Record<string, unknown> | undefined;
    if (team?.idAllocator === "git-refs") idAllocator = "git-refs";
  } catch {
    // Unreadable config would have thrown in updateConfigVersion already;
    // default to "local", the runtime allocation default.
  }

  return {
    driverInstalled: true,
    gitattributesWritten: true,
    versionUpdated: true,
    gitignoreEnsured: true,
    gitRoot,
    idAllocator,
  };
}

export interface CheckResult {
  ok: boolean;
  issues: string[];
}

export async function checkMergeDriverSetup(root: string): Promise<CheckResult> {
  const issues: string[] = [];
  const storyDir = join(root, ".story");

  let gitRoot: string;
  try {
    gitRoot = await findGitRoot(root);
  } catch {
    issues.push("Not inside a git repository");
    return { ok: false, issues };
  }

  try {
    const { stdout } = await execFileAsync(
      "git", ["config", "--local", "--get", `merge.${MERGE_DRIVER_NAME}.driver`],
      { cwd: gitRoot, timeout: 5000 },
    );
    if (stdout.trim() !== MERGE_DRIVER_CMD) {
      issues.push(`Merge driver command mismatch: expected "${MERGE_DRIVER_CMD}", got "${stdout.trim()}"`);
    }
  } catch {
    issues.push("Merge driver not configured in local git config");
  }

  const attrsPath = join(storyDir, ".gitattributes");
  if (!existsSync(attrsPath)) {
    issues.push(".story/.gitattributes not found");
  } else {
    const content = readFileSync(attrsPath, "utf-8");
    if (!content.includes(BLOCK_BEGIN) || !content.includes(BLOCK_END)) {
      issues.push(".story/.gitattributes missing managed merge block");
    }
  }

  const configPath = join(storyDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const team = config.team as Record<string, unknown> | undefined;
      const configVersion = team?.mergeDriverVersion;
      if (configVersion !== MERGE_DRIVER_VERSION) {
        issues.push(`Merge driver version mismatch: config has ${configVersion}, current is ${MERGE_DRIVER_VERSION}`);
      }
    } catch {
      issues.push("Failed to read config.json");
    }
  }

  return { ok: issues.length === 0, issues };
}
