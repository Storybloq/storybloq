import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname, basename, relative, resolve, sep } from "node:path";
import { MAX_SUPPORTED_SCHEMA_VERSION } from "./errors.js";
import { ConfigSchema } from "../models/config.js";
import { ensureGitignoreEntries, STORY_GITIGNORE_ENTRIES } from "./init.js";
import { withProjectLock, writeConfigUnlocked } from "./project-loader.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { RULING_LIFECYCLE_MIN_CLI_VERSION, currentCliVersion, meetsVersionMinimum } from "./team-capabilities.js";

const execFileAsync = promisify(execFile);

export const MERGE_DRIVER_VERSION = 1;
export const MERGE_DRIVER_NAME = "storybloq-json";
export const MERGE_DRIVER_CMD = "storybloq merge-driver %O %A %B %P";
export const MERGE_DRIVER_DISPLAY_NAME = "Storybloq JSON three-way merge";

/**
 * T-537: the checkpoint-aware registration. Its command passes `--protocol 4`,
 * which a CLI that predates owner checkpoints rejects, so an older binary on
 * PATH exits nonzero and git records a conflict instead of merging a
 * checkpoint it cannot honour. Selected per clone by the local override in
 * `$GIT_DIR/info/attributes`, never by the tracked `.gitattributes`.
 */
export const MERGE_DRIVER_V4_NAME = "storybloq-json-v4";
export const MERGE_DRIVER_V4_CMD = "storybloq merge-driver --protocol 4 %O %A %B %P";
export const MERGE_DRIVER_V4_DISPLAY_NAME = "Storybloq JSON three-way merge (owner checkpoints)";
/** Both registrations merge structurally; readiness checks accept either. */
export const STRUCTURAL_MERGE_DRIVERS: ReadonlySet<string> = new Set([MERGE_DRIVER_NAME, MERGE_DRIVER_V4_NAME]);

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

/** T-537: the tracked block `checkpoint enable` writes after the managed one; later lines win. */
export const CHECKPOINT_BLOCK_BEGIN = "# storybloq-checkpoint-begin";
export const CHECKPOINT_BLOCK_END = "# storybloq-checkpoint-end";
/** T-537: the per-clone block in `$GIT_DIR/info/attributes`, one per ledger, keyed by its root-relative path. */
const localBlockBegin = (prefix: string) => `# storybloq-checkpoint-local-begin ${prefix}`;
const localBlockEnd = (prefix: string) => `# storybloq-checkpoint-local-end ${prefix}`;

const GITATTRIBUTES_PATTERNS = [
  "tickets/*.json merge=storybloq-json",
  "issues/*.json merge=storybloq-json",
  "notes/*.json merge=storybloq-json",
  "lessons/*.json merge=storybloq-json",
  "arrangements/*.json merge=storybloq-json",
  "rulings/*.json merge=storybloq-json",
  "config.json merge=storybloq-json",
  "roadmap.json merge=storybloq-json",
  // T-529: the two catalogs, merged by entry id instead of as text.
  "capabilities.json merge=storybloq-json",
  "glossary.json merge=storybloq-json",
];

/** The ledger paths the patterns cover, relative to `.story/`. */
const LEDGER_PATTERNS = GITATTRIBUTES_PATTERNS.map((line) => line.slice(0, line.indexOf(" ")));

const escapeRe = (m: string) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `existing` with every `begin`..`end` block and every lone marker removed,
 * then one block of `lines` appended at the END. Git lets the last matching
 * line in a file win, so a block that must override other rules has to follow
 * them; replacing it in place would leave a later rule in force.
 */
function withBlockLast(existing: string, begin: string, end: string, lines: readonly string[]): string {
  const marker = (m: string) => `^[^\\S\\n]*${escapeRe(m)}[^\\S\\n]*(?:\\n|$)`;
  let cleaned = existing
    .replace(new RegExp(`${marker(begin)}[\\s\\S]*?${marker(end)}`, "gm"), "")
    .replace(new RegExp(marker(begin), "gm"), "")
    .replace(new RegExp(marker(end), "gm"), "");
  if (cleaned.length > 0 && !cleaned.endsWith("\n")) cleaned += "\n";
  return cleaned + [begin, ...lines, end].join("\n") + "\n";
}

/** Whether `text` ends with exactly the block `withBlockLast` writes, so no later line can override it. */
function endsWithBlock(text: string, begin: string, end: string, lines: readonly string[]): boolean {
  return text.trimEnd().endsWith([begin, ...lines, end].join("\n")) && text.split(begin).length === 2;
}

const CHECKPOINT_LINES = (): string[] => LEDGER_PATTERNS.map((p) => `${p} -merge`);

/**
 * T-537: marks every ledger pattern `-merge` in the tracked
 * `.story/.gitattributes`, in its own block after the managed one. A clone
 * without the v4 override then records a conflict on any two-sided change
 * instead of merging a checkpoint with a driver that cannot honour it. An old
 * `team setup` rewrites only its own block and keeps this one.
 */
export function writeCheckpointGitattributes(storyDir: string): void {
  const filePath = join(storyDir, ".gitattributes");
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const next = withBlockLast(existing, CHECKPOINT_BLOCK_BEGIN, CHECKPOINT_BLOCK_END, CHECKPOINT_LINES());
  if (next !== existing) writeFileSync(filePath, next, "utf-8");
}

/**
 * Whether the tracked `.story/.gitattributes` carries the checkpoint block
 * once, whole, and last: a marker alone, an edited line, or any rule after
 * the block (which git would let win) reads as missing.
 */
export function hasCheckpointGitattributes(storyDir: string): boolean {
  const filePath = join(storyDir, ".gitattributes");
  if (!existsSync(filePath)) return false;
  return endsWithBlock(readFileSync(filePath, "utf-8"), CHECKPOINT_BLOCK_BEGIN, CHECKPOINT_BLOCK_END, CHECKPOINT_LINES());
}

/** Whether the tracked `.story/.gitattributes` has any checkpoint marker, whole block or not. */
function mentionsCheckpointBlock(storyDir: string): boolean {
  const filePath = join(storyDir, ".gitattributes");
  if (!existsSync(filePath)) return false;
  const text = readFileSync(filePath, "utf-8");
  return text.includes(CHECKPOINT_BLOCK_BEGIN) || text.includes(CHECKPOINT_BLOCK_END);
}

/** A path matched literally by git's wildmatch: its glob metacharacters escaped, and a leading `!` or `#`. */
function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]]/g, "\\$&").replace(/^[!#]/, "\\$&");
}

/**
 * An attributes-file pattern: as is when it has nothing the line format
 * splits or strips, else C-quoted (git unquotes a pattern that starts with
 * `"` before matching it). Whitespace, quotes and control characters need it.
 */
function attributePattern(pattern: string): string {
  if (!/[\s"\x00-\x1f\x7f]/.test(pattern)) return pattern;
  const quoted = pattern.replace(/[\\"\x00-\x1f\x7f]/g, (c) => {
    if (c === "\\" || c === '"') return `\\${c}`;
    const named: Record<string, string> = { "\t": "\\t", "\n": "\\n", "\r": "\\r" };
    return named[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`;
  });
  return `"${quoted}"`;
}

/**
 * T-537: selects the v4 driver in THIS clone, in the file git names for
 * `info/attributes` (correct in a linked worktree too), which outranks every
 * `.gitattributes`. Patterns are qualified from the repository root, so a
 * nested ledger (`app/.story/`) is matched where it is, and each ledger owns
 * its own block, keyed by that path, so setting up one keeps another's.
 */
export async function writeLocalCheckpointAttributes(gitRoot: string, storyDir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/attributes"], { cwd: gitRoot, timeout: 5000 });
  const filePath = resolve(gitRoot, stdout.trim());
  const prefix = relative(realpathSync(gitRoot), realpathSync(storyDir)).split(sep).join("/");
  const lines = LEDGER_PATTERNS.map((p) => `${attributePattern(`${escapeGlob(prefix)}/${p}`)} merge=${MERGE_DRIVER_V4_NAME}`);
  const key = attributePattern(prefix);
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const next = withBlockLast(existing, localBlockBegin(key), localBlockEnd(key), lines);
  if (next !== existing) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, next, "utf-8");
  }
  return filePath;
}

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
  await execFileAsync(
    "git", ["config", "--local", `merge.${MERGE_DRIVER_V4_NAME}.driver`, MERGE_DRIVER_V4_CMD],
    { cwd: gitRoot, timeout: 5000 },
  );
  await execFileAsync(
    "git", ["config", "--local", `merge.${MERGE_DRIVER_V4_NAME}.name`, MERGE_DRIVER_V4_DISPLAY_NAME],
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

/** T-522: what `team setup` did about the 1.16 rulings fence. */
export type RulingFenceOutcome = "raised" | "already" | "deferred";

export async function updateConfigVersion(root: string): Promise<RulingFenceOutcome> {
  let outcome: RulingFenceOutcome = "already";
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = { ...state.config, team: { ...(state.config.team ?? {}) } };
    config.team.mergeDriverVersion = MERGE_DRIVER_VERSION;
    // T-522: raise the write fence to the first rulings-lifecycle CLI, but
    // ONLY when this CLI itself passes it. Writing a fence this binary cannot
    // pass would brick its own next write (the ISS-748 class of failure); a
    // pre-1.16 build reports the raise as deferred and the ruling write
    // precondition keeps refusing until a 1.16 build reruns setup.
    // An existing lower fence is raised to exactly the minimum (never past
    // a teammate's 1.16.x); an ABSENT fence takes this CLI's own version,
    // which is `team init`'s convention for a fresh team.
    const fence = typeof config.team.minCliVersion === "string" ? config.team.minCliVersion : null;
    if (fence === null || !meetsVersionMinimum(fence, RULING_LIFECYCLE_MIN_CLI_VERSION)) {
      const current = currentCliVersion();
      if (current !== null && meetsVersionMinimum(current, RULING_LIFECYCLE_MIN_CLI_VERSION)) {
        config.team.minCliVersion = fence === null ? current : RULING_LIFECYCLE_MIN_CLI_VERSION;
        outcome = "raised";
      } else {
        outcome = "deferred";
      }
    }
    await writeConfigUnlocked(config, root);
  });
  return outcome;
}

export interface SetupResult {
  driverInstalled: boolean;
  gitattributesWritten: boolean;
  versionUpdated: boolean;
  gitignoreEnsured: boolean;
  gitRoot: string;
  /** Effective id allocator after setup: anything but an explicit "git-refs" runs as "local". */
  idAllocator: "local" | "git-refs";
  /** T-522: whether `team.minCliVersion` now admits 1.16 ruling records. */
  rulingFence: RulingFenceOutcome;
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

  // T-537: validate before any mutation, as the loader would. A config this
  // build cannot read (unparseable, schema-invalid, or a schemaVersion above
  // what it supports) is refused here, not after the driver and attributes
  // were rewritten.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(`Cannot read .story/config.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ConfigSchema.passthrough().safeParse(raw);
  if (!parsed.success) {
    throw new Error(`.story/config.json is not a valid config: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}. Fix it before running team setup.`);
  }
  const schemaVersion = parsed.data.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`.story/config.json is schemaVersion ${schemaVersion}; this build supports up to ${MAX_SUPPORTED_SCHEMA_VERSION}. Update storybloq before running team setup.`);
  }

  const gitRoot = await findGitRoot(root);

  await installMergeDriver(gitRoot);
  await writeGitattributes(storyDir);
  // A rewritten managed block must not end up after the checkpoint block:
  // a ledger that has one keeps it last.
  if (mentionsCheckpointBlock(storyDir)) writeCheckpointGitattributes(storyDir);
  await writeLocalCheckpointAttributes(gitRoot, storyDir);
  const rulingFence = await updateConfigVersion(root);
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
    rulingFence,
  };
}

/**
 * T-522: the two facts a team-mode ledger needs before any 1.16 ruling write:
 * the fence admits only 1.16 writers, and the ruling file merges structurally.
 * Pure read; shared by the ruling write precondition and `team doctor`.
 *
 * The attribute answer comes from git itself (`git check-attr merge`) on the
 * ACTUAL path about to be written (or a representative one for a project-wide
 * check), so every rule git would apply is honoured: broader patterns after
 * the managed block, character classes, `-merge`, the repo-root file and
 * `info/attributes`. No git, not a repository, or any other failure reads as
 * not ready: a team-mode ledger without git cannot merge structurally anyway.
 */
export function rulingLifecycleReadiness(
  storyDir: string,
  minCliVersion: string | undefined,
  rulingId: string = "r-0000000000000000",
): { fenceOk: boolean; attributeOk: boolean } {
  const fenceOk = meetsVersionMinimum(minCliVersion, RULING_LIFECYCLE_MIN_CLI_VERSION);
  const root = dirname(storyDir);
  const driver = effectiveMergeDriver(root, `${basename(storyDir)}/rulings/${rulingId}.json`);
  const attributeOk = driver !== null && STRUCTURAL_MERGE_DRIVERS.has(driver);
  return { fenceOk, attributeOk };
}

/** T-529: the catalog files whose merges must run the structural driver. */
export const CATALOG_MERGE_FILES = ["capabilities.json", "glossary.json"] as const;

/**
 * T-529: the catalog files git would NOT merge with the structural driver,
 * asked of git itself the way `rulingLifecycleReadiness` asks for a ruling
 * path, so every attribute rule git applies is honoured. Empty when both are
 * covered, and empty outside a git work tree (or without git), where nothing
 * merges and `check-attr` could not tell "unset" from "no repository". Pure
 * read.
 */
export function catalogsWithoutMergeDriver(storyDir: string): string[] {
  const root = dirname(storyDir);
  if (!insideGitWorkTree(root)) return [];
  return CATALOG_MERGE_FILES.filter((file) => {
    const driver = effectiveMergeDriver(root, `${basename(storyDir)}/${file}`);
    return driver === null || !STRUCTURAL_MERGE_DRIVERS.has(driver);
  });
}

function insideGitWorkTree(root: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** The `merge` attribute git resolves for `relPath` under `root`, or null when unset or unknowable. */
export function effectiveMergeDriver(root: string, relPath: string): string | null {
  let out: string;
  try {
    out = execFileSync("git", ["check-attr", "merge", "--", relPath], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
  // `<path>: merge: <value>`; the path may itself contain ": ", so split from the right.
  const marker = ": merge: ";
  const at = out.lastIndexOf(marker);
  if (at < 0) return null;
  const value = out.slice(at + marker.length).trim();
  if (value === "unspecified" || value === "unset" || value === "set" || value === "") return null;
  return value;
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
