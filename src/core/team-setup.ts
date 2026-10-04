import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname, basename, relative, resolve, sep } from "node:path";
import { MAX_SUPPORTED_SCHEMA_VERSION } from "./errors.js";
import { ConfigSchema } from "../models/config.js";
import { ensureGitignoreEntries, STORY_GITIGNORE_ENTRIES } from "./init.js";
import { withProjectLock, writeConfigUnlocked } from "./project-loader.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  RESOLUTION_KIND_MIN_CLI_VERSION,
  RULING_LIFECYCLE_MIN_CLI_VERSION,
  TEAM_FENCE_MINIMUMS,
  currentCliVersion,
  meetsVersionMinimum,
} from "./team-capabilities.js";

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
/**
 * T-486: the resolution-kind registration. Its command passes `--protocol 5`,
 * which a pre-T-486 CLI rejects, so an older binary records a conflict
 * instead of merging resolution metadata without the two merge groups. Like
 * v4, selected per clone by the local override, never by the tracked file.
 */
export const MERGE_DRIVER_V5_NAME = "storybloq-json-v5";
export const MERGE_DRIVER_V5_CMD = "storybloq merge-driver --protocol 5 %O %A %B %P";
export const MERGE_DRIVER_V5_DISPLAY_NAME = "Storybloq JSON three-way merge (resolution kinds)";
/** Every registration merges structurally. */
export const STRUCTURAL_MERGE_DRIVERS: ReadonlySet<string> = new Set([MERGE_DRIVER_NAME, MERGE_DRIVER_V4_NAME, MERGE_DRIVER_V5_NAME]);

/**
 * T-486 A2/A5: each supported driver name and the exact command setup
 * generates for it, the only registration readiness accepts (compared after
 * trimming). A quoted path, a wrapper, npx or a node launcher is
 * "unsupported", never "foreign": setup replaces it. Setup generates the
 * same strings on every platform and has no Windows-specific form.
 */
export const MERGE_DRIVER_CONTRACTS: ReadonlyMap<string, { readonly command: string; readonly protocol: number | null }> = new Map([
  // 43655d9d (T-388): the original registration.
  [MERGE_DRIVER_NAME, { command: MERGE_DRIVER_CMD, protocol: null }],
  // 8b961ee3 (T-537): owner checkpoints.
  [MERGE_DRIVER_V4_NAME, { command: MERGE_DRIVER_V4_CMD, protocol: 4 }],
  // T-486: resolution kinds.
  [MERGE_DRIVER_V5_NAME, { command: MERGE_DRIVER_V5_CMD, protocol: 5 }],
]);

/** The drivers that honour owner checkpoints. */
export const CHECKPOINT_MERGE_DRIVERS: readonly string[] = [MERGE_DRIVER_V4_NAME, MERGE_DRIVER_V5_NAME];

export const UNSUPPORTED_REGISTRATION_MESSAGE = "unsupported merge driver registration; run storybloq team setup";

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
 * T-537: selects the checkpoint driver in THIS clone (T-486: v5, which also
 * honours checkpoints; an existing v4 block is rewritten to v5), in the file git names for
 * `info/attributes` (correct in a linked worktree too), which outranks every
 * `.gitattributes`. Patterns are qualified from the repository root, so a
 * nested ledger (`app/.story/`) is matched where it is, and each ledger owns
 * its own block, keyed by that path, so setting up one keeps another's.
 */
export async function writeLocalCheckpointAttributes(gitRoot: string, storyDir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "info/attributes"], { cwd: gitRoot, timeout: 5000 });
  const filePath = resolve(gitRoot, stdout.trim());
  const prefix = relative(realpathSync(gitRoot), realpathSync(storyDir)).split(sep).join("/");
  const lines = LEDGER_PATTERNS.map((p) => `${attributePattern(`${escapeGlob(prefix)}/${p}`)} merge=${MERGE_DRIVER_V5_NAME}`);
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
  await execFileAsync(
    "git", ["config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.driver`, MERGE_DRIVER_V5_CMD],
    { cwd: gitRoot, timeout: 5000 },
  );
  await execFileAsync(
    "git", ["config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.name`, MERGE_DRIVER_V5_DISPLAY_NAME],
    { cwd: gitRoot, timeout: 5000 },
  );
}

/**
 * T-486: setup writes each registration `--local`, but git reads worktree,
 * command-line and environment config over local, so an override there
 * still wins. Each registration is read back in git's own precedence after
 * install; one git would not run as the contract says names the scope and
 * origin of the value that wins and the exact command that removes it.
 * Empty when every registration is effective.
 */
export function registrationOverrides(gitRoot: string, git: GitRead = gitRead): string[] {
  const problems: string[] = [];
  for (const [name, contract] of MERGE_DRIVER_CONTRACTS) {
    const key = `merge.${name}.driver`;
    let out: string;
    try {
      out = git(["config", "--show-scope", "--show-origin", "-z", "--get-all", key], gitRoot);
    } catch (err) {
      const e = err as { status?: number | null; stderr?: unknown; message?: string };
      const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
      problems.push(e.status === 1 ? `${key} is not set after setup wrote it` : `git could not read ${key}: ${stderr || e.message || String(err)}`);
      continue;
    }
    const record = lastConfigRecord(out);
    if (record.kind === "malformed") {
      problems.push(`git could not read ${key}: ${record.detail}`);
      continue;
    }
    const { scope, origin, value } = record;
    if (value.trim() === contract.command) continue;
    const removal = scope === "command"
      ? "remove it from the command line or the GIT_CONFIG_* environment that sets it"
      : `remove it with: git config --${scope} --unset-all ${key}`;
    problems.push(`${key} = "${value}" from ${scope} config (${origin}) overrides the registration setup wrote; ${removal}`);
  }
  return problems;
}

const CONFIG_SCOPES: ReadonlySet<string> = new Set(["system", "global", "local", "worktree", "command"]);

export type ConfigRecord = { kind: "ok"; scope: string; origin: string; value: string } | { kind: "malformed"; detail: string };

/**
 * The last record of `git config --show-scope --show-origin -z --get-all`:
 * each record is scope, origin and value, each NUL-terminated, in precedence
 * order, and git runs the last. A value may hold newlines, so only NUL
 * separates records. Output that is not whole records (no final NUL, an
 * incomplete triple, an unknown scope, an empty origin) is malformed, which
 * every caller reports as a git read failure, never as a registration.
 */
export function lastConfigRecord(out: string): ConfigRecord {
  if (!out.endsWith("\0")) return { kind: "malformed", detail: "the git config output does not end with a NUL" };
  const fields = out.slice(0, -1).split("\0");
  if (fields.length % 3 !== 0) return { kind: "malformed", detail: `the git config output has ${fields.length} fields, not whole scope, origin and value records` };
  for (let i = 0; i < fields.length; i += 3) {
    if (!CONFIG_SCOPES.has(fields[i]!)) return { kind: "malformed", detail: `the git config output names an unknown scope "${fields[i]}"` };
    if (fields[i + 1] === "") return { kind: "malformed", detail: "the git config output has a record with no origin" };
  }
  const start = fields.length - 3;
  return { kind: "ok", scope: fields[start]!, origin: fields[start + 1]!, value: fields[start + 2]! };
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

/**
 * T-486: the fence raise for every capability minimum, in order, under the
 * T-522 rule (never past what this CLI itself passes). A minimum this CLI
 * cannot pass is deferred, and so is every later one: the fence never skips
 * a capability. Returns the outcome per minimum.
 */
export async function raiseTeamFence(
  root: string,
  minimums: readonly string[] = TEAM_FENCE_MINIMUMS,
): Promise<Map<string, RulingFenceOutcome>> {
  const outcomes = new Map<string, RulingFenceOutcome>();
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = { ...state.config, team: { ...(state.config.team ?? {}) } };
    config.team.mergeDriverVersion = MERGE_DRIVER_VERSION;
    let fence = typeof config.team.minCliVersion === "string" ? config.team.minCliVersion : null;
    const current = currentCliVersion();
    let blocked = false;
    // Capabilities may share a minimum (both are 1.16.0 today): each minimum
    // is decided once, so a later duplicate cannot overwrite "raised" with
    // the "already" its own raise just made true.
    for (const minimum of new Set(minimums)) {
      if (fence !== null && meetsVersionMinimum(fence, minimum)) {
        outcomes.set(minimum, "already");
      } else if (!blocked && current !== null && meetsVersionMinimum(current, minimum)) {
        fence = fence === null ? current : minimum;
        outcomes.set(minimum, "raised");
      } else {
        blocked = true;
        outcomes.set(minimum, "deferred");
      }
    }
    if (fence !== null) config.team.minCliVersion = fence;
    await writeConfigUnlocked(config, root);
  });
  return outcomes;
}

/** T-522: the rulings fence alone (kept for callers that ask only about it). */
export async function updateConfigVersion(root: string): Promise<RulingFenceOutcome> {
  return (await raiseTeamFence(root, [RULING_LIFECYCLE_MIN_CLI_VERSION])).get(RULING_LIFECYCLE_MIN_CLI_VERSION)!;
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
  /** T-486: whether it now admits resolution-kind writes. */
  resolutionKindFence: RulingFenceOutcome;
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
  const overrides = registrationOverrides(gitRoot);
  if (overrides.length > 0) {
    throw new Error(`team setup wrote the merge driver registrations, but git would not run them: ${overrides.join("; ")}. Then run storybloq team setup again.`);
  }
  const fences = await raiseTeamFence(root);
  const rulingFence = fences.get(RULING_LIFECYCLE_MIN_CLI_VERSION) ?? "already";
  const resolutionKindFence = fences.get(RESOLUTION_KIND_MIN_CLI_VERSION) ?? "already";
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
    resolutionKindFence,
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
): { fenceOk: boolean; attributeOk: boolean; registration: MergeDriverRegistration } {
  const fenceOk = meetsVersionMinimum(minCliVersion, RULING_LIFECYCLE_MIN_CLI_VERSION);
  const root = dirname(storyDir);
  const relPath = `${basename(storyDir)}/rulings/${rulingId}.json`;
  const driver = effectiveMergeDriver(root, relPath);
  const attributeOk = driver !== null && STRUCTURAL_MERGE_DRIVERS.has(driver);
  // T-486 A2: the attribute alone proves nothing if the name runs no
  // command, or a command setup never generated. Any supported registration
  // whose command matches its own contract is accepted.
  const registration = mergeDriverRegistration(root, relPath);
  return { fenceOk, attributeOk, registration };
}

/**
 * T-486 R3-1: whether git would merge `relPath` (under `root`) with a driver
 * whose registration is exactly what setup generates. Three facts, all asked
 * of git and all failing closed: the `merge` attribute git resolves names a
 * supported driver (one of `accept`, when given); `git config --get` for its
 * command, with no scope flag so git's own precedence applies (worktree
 * config, local, global, system); and that command, trimmed, equals the
 * contract. Pure read.
 */
export type MergeDriverRegistration =
  | { readonly ok: true; readonly name: string; readonly protocol: number | null }
  | { readonly ok: false; readonly reason: "attribute" | "unregistered" | "unsupported" | "git"; readonly message: string };

export function mergeDriverRegistration(
  root: string,
  relPath: string,
  accept: readonly string[] = [...MERGE_DRIVER_CONTRACTS.keys()],
  git: GitRead = gitRead,
): MergeDriverRegistration {
  const name = effectiveMergeDriver(root, relPath, git);
  if (name === null || !accept.includes(name)) {
    return {
      ok: false,
      reason: "attribute",
      message: `git merges ${relPath} with ${name ?? "no driver"}, not ${accept.join(" or ")}; run storybloq team setup`,
    };
  }
  const contract = MERGE_DRIVER_CONTRACTS.get(name)!;
  const registered = registeredMergeDriverCommand(root, name, "effective", git);
  if (registered.kind === "git") return { ok: false, reason: "git", message: `git could not read merge.${name}.driver: ${registered.detail}` };
  if (registered.kind === "absent") {
    return { ok: false, reason: "unregistered", message: `the ${name} merge driver is not registered; run storybloq team setup` };
  }
  if (registered.command.trim() !== contract.command) {
    return { ok: false, reason: "unsupported", message: `${UNSUPPORTED_REGISTRATION_MESSAGE} (merge.${name}.driver)` };
  }
  return { ok: true, name, protocol: contract.protocol };
}

/** The command git would run for driver `name`, in git's own scope precedence, or why it cannot say. */
export function registeredMergeDriverCommand(
  root: string,
  name: string,
  scope: "effective" | "local" = "effective",
  git: GitRead = gitRead,
): { kind: "present"; command: string } | { kind: "absent" } | { kind: "git"; detail: string } {
  const args = ["config", ...(scope === "local" ? ["--local"] : []), "--get", `merge.${name}.driver`];
  try {
    const out = git(args, root);
    return { kind: "present", command: out.replace(/\n$/, "") };
  } catch (err) {
    const e = err as { status?: number | null; stderr?: unknown; message?: string };
    // `git config --get` exits 1 for a key that is not set, and only then.
    if (e.status === 1) return { kind: "absent" };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    return { kind: "git", detail: stderr || e.message || String(err) };
  }
}

/**
 * T-486 2b: the two facts a team ledger needs before a resolution-kind
 * write: the fence admits only kind-aware writers, and `relPath` merges with
 * the v5 driver registered exactly as setup generates it.
 */
export function resolutionWritesReadiness(
  root: string,
  minCliVersion: string | undefined,
  relPath: string,
  git: GitRead = gitRead,
): { fenceOk: boolean; driver: MergeDriverRegistration } {
  return {
    fenceOk: meetsVersionMinimum(minCliVersion, RESOLUTION_KIND_MIN_CLI_VERSION),
    driver: mergeDriverRegistration(root, relPath, [MERGE_DRIVER_V5_NAME], git),
  };
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

/**
 * T-486 A4: a read-only git call: stdout, or a throw shaped like
 * `execFileSync`'s (`status`, `stderr`). Injectable so a write context can
 * memoise the lookups of one operation and a test can count them.
 */
export type GitRead = (args: readonly string[], cwd: string) => string;

export const gitRead: GitRead = (args, cwd) =>
  execFileSync("git", [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });

/** The `merge` attribute git resolves for `relPath` under `root`, or null when unset or unknowable. */
export function effectiveMergeDriver(root: string, relPath: string, git: GitRead = gitRead): string | null {
  let out: string;
  try {
    out = git(["check-attr", "merge", "--", relPath], root);
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

/**
 * T-486 A9: the `merge` attribute git resolves for `relPath`, keeping what
 * effectiveMergeDriver folds into null apart: no driver selected
 * (`unspecified`, `unset` for `-merge`, `set`, or empty) versus a git
 * failure. Pure read.
 */
export type MergeAttribute =
  | { readonly kind: "set"; readonly name: string }
  | { readonly kind: "none"; readonly value: string }
  | { readonly kind: "git"; readonly detail: string };

export function mergeAttribute(root: string, relPath: string, git: GitRead = gitRead): MergeAttribute {
  let out: string;
  try {
    out = git(["check-attr", "merge", "--", relPath], root);
  } catch (err) {
    return { kind: "git", detail: gitErrorDetail(err) };
  }
  const marker = ": merge: ";
  const at = out.lastIndexOf(marker);
  if (at < 0) return { kind: "git", detail: `unexpected check-attr output: ${out.trim()}` };
  const value = out.slice(at + marker.length).trim();
  if (value === "unspecified" || value === "unset" || value === "set" || value === "") return { kind: "none", value: value || "unspecified" };
  return { kind: "set", name: value };
}

/**
 * T-486 A9: the registration git would run for driver `name`, in git's own
 * precedence, with the scope and origin of the winning value, for messages
 * that name what to remove. A malformed record is a git failure, never a
 * match.
 */
export function registeredMergeDriverRecord(
  root: string,
  name: string,
  git: GitRead = gitRead,
): { kind: "present"; scope: string; origin: string; value: string } | { kind: "absent" } | { kind: "git"; detail: string } {
  let out: string;
  try {
    out = git(["config", "--show-scope", "--show-origin", "-z", "--get-all", `merge.${name}.driver`], root);
  } catch (err) {
    if ((err as { status?: number | null }).status === 1) return { kind: "absent" };
    return { kind: "git", detail: gitErrorDetail(err) };
  }
  const record = lastConfigRecord(out);
  if (record.kind === "malformed") return { kind: "git", detail: `unreadable git config record for merge.${name}.driver: ${record.detail}` };
  return { kind: "present", scope: record.scope, origin: record.origin, value: record.value };
}

function gitErrorDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: string };
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  return stderr || e.message || String(err);
}

/** The environment variables that point git somewhere other than discovery from the cwd. */
export const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"] as const;

/**
 * T-486 A9-1: whether `root` is in a git work tree. "none" only for a
 * verified ordinary directory: no `.git` entry (directory or gitfile) at
 * the root or any ancestor, and none of GIT_LOCATION_ENV set. Everything
 * else git cannot read as a work tree (a bare repository, metadata git
 * rejects, an environment git rejects) is "error" with the cause. A git
 * exit status alone never makes "none".
 */
export function gitWorkTreeState(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): { kind: "tree" } | { kind: "none" } | { kind: "error"; detail: string } {
  const explicit = GIT_LOCATION_ENV.filter((k) => typeof env[k] === "string" && env[k] !== "");
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (explicit.length === 0) for (const k of GIT_LOCATION_ENV) delete childEnv[k];
  let out: string | null = null;
  let failure = "";
  try {
    out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, env: childEnv, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  } catch (err) {
    failure = gitErrorDetail(err);
  }
  if (out === "true") return { kind: "tree" };
  if (explicit.length > 0) {
    return { kind: "error", detail: `git rejects the repository named by ${explicit.join(", ")}: ${out === null ? failure : "not a work tree"}` };
  }
  const dotGit = nearestDotGit(root);
  if (out !== null) return { kind: "error", detail: `${root} is in a git repository without a work tree (bare, or inside a .git directory)` };
  if (dotGit === null) return { kind: "none" };
  return { kind: "error", detail: `git rejects the repository at ${dotGit}: ${failure}` };
}

function nearestDotGit(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
