/**
 * T-525: headless baseline runner for the continuity fixture.
 *
 * One real `claude -p "/story auto <ticket>"` session per attempt, in a
 * materialised copy of test/fixtures/continuity, with the storybloq MCP
 * server launched explicitly from THIS checkout's dist/mcp.js. Everything
 * the session produces is captured: the raw stream and every unchecked
 * artefact go to the private directory; only sanitised, publication-checked
 * artefacts reach the publishable one. The rules (identity, validity,
 * completion, qualification) live in continuity-lib.ts.
 */
import { spawn as nodeSpawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync, createWriteStream, cpSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir, userInfo, loadavg } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSubscriptionAuthOnly, assertValidTimerMs, writeAtomic, SessionKilledError, ALTERNATE_AUTH_ENV_VARS } from "./headless-common.js";
import { jsonShapePreserved,
  TASKS, type Task, REPEATS, ticketIdForTask, materialize, variantDiscoveryViolations, parseStream, summarizeStream,
  validity, rateLimitStop, machineLoadStop, parseSwapFree, LOAD_RULE, type LoadSample, completion, sanitize, publicationCheck, fixtureCredentialAllowlist, diffLedger, decideCell, attemptDirName,
  qualifies, experimentHash, hashInputs, hashTree, sha256, skillPayloadDiff, verifyAttemptDir, sameHashes, type ExperimentInputs, type ToolCallRecord, type CompletionStatus,
  environmentSecrets, ambiguousEnvironmentSecrets, INPUT_PATHS, hashInputsByPath, taskMaterial, driftedPaths, classifyInputDrift, configInventoryDrift,
} from "./continuity-lib.js";
import { killSidecar } from "../src/autonomous/liveness.js";
import { loadRulingsSafe } from "../src/core/ruling-loader.js";
import { claudeConfigDir } from "../src/core/claude-config-dir.js";
import { buildSuccessorIndex } from "../src/core/ruling.js";
import { classifyLifecycle } from "../src/core/ruling-lifecycle.js";
import { loadProject } from "../src/core/project-loader.js";
import { handleValidate } from "../src/cli/commands/validate.js";
import type { CommandContext } from "../src/cli/types.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(SCRIPT_DIR, "..");
export const WORKSPACE_ROOT = resolve(PKG_ROOT, "..");
export const FIXTURE_ROOT = join(PKG_ROOT, "test", "fixtures", "continuity");
export const DEFAULT_OUT = join(FIXTURE_ROOT, "baseline");
export const DEFAULT_RAW_OUT = join(WORKSPACE_ROOT, "eval-runs", "continuity");
/** Read once, at process start, so every publication in this run is checked against the same set of real values. */
const RUNNER_SECRETS = environmentSecrets(process.env);
/**
 * A value short enough to be an identifier rather than a credential is not silently dropped from the secret
 * list, because a short password is still a password; it is also not accepted blindly, because refusing every
 * artefact that contains it would make the capture impossible. The operator decides, before a cell is spent.
 * Names only: a refusal never prints a value.
 */
function refuseAmbiguousSecrets(env: NodeJS.ProcessEnv): void {
  const names = ambiguousEnvironmentSecrets(env);
  if (names.length === 0) return;
  throw new Error(
    `continuity-run: ${names.join(", ")} hold values short enough that refusing every artefact containing them would fail the capture, ` +
    "and short enough that they may not be credentials at all. Unset them for the run if they are placeholders, or lengthen them if they are real.",
  );
}
export const DIST_FILES = ["dist/mcp.js", "dist/cli.js", "dist/index.js", "dist/presence.js"] as const;
/** The experiment's identity inputs live in continuity-lib.ts so the scorer can re-derive them without importing the runner. */
export { INPUT_PATHS };

export type InputHashes = { readonly hashes: Record<string, string>; readonly errors: Record<string, string> };

/** One hash per INPUT_PATHS entry under PKG_ROOT; a label whose walk fails is reported, never thrown. */
export function inputHashes(): InputHashes {
  return hashInputsByPath(INPUT_PATHS.map((p) => ({ label: p, path: join(PKG_ROOT, p) })));
}

export interface InputDrift {
  readonly invalidating: string[];
  readonly disclosed: string[];
  /** Labels whose hash walk failed, with the message; each also counts as invalidating. */
  readonly errors: Record<string, string>;
}

/** ISS-1274: every label that differs from preflight in any observation, split by whether it reaches the cell. */
export function inputDrift(expected: Record<string, string>, observed: readonly InputHashes[], distUnchanged: boolean): InputDrift {
  const errors: Record<string, string> = {};
  for (const o of observed) for (const [label, msg] of Object.entries(o.errors)) errors[label] ??= msg;
  const drifted = [...new Set(observed.flatMap((o) => driftedPaths(expected, o.hashes)))].sort();
  const { invalidating, disclosed } = classifyInputDrift(drifted, distUnchanged);
  const errored = Object.keys(errors);
  return {
    invalidating: [...new Set([...invalidating, ...errored])].sort(),
    disclosed: disclosed.filter((l) => !errored.includes(l)),
    errors,
  };
}

/**
 * The rolled hash, the per-path map and the task material are separate walks. Bracket them with per-path reads and refuse
 * when anything moved or failed between them, so a mid-preflight edit cannot leave an identity and a baseline that
 * describe different trees.
 */
export function bracketedInputs<T>(read: () => InputHashes, compute: () => T): { readonly hashes: Record<string, string>; readonly value: T } {
  const before = read();
  const value = compute();
  const after = read();
  const failed = [...new Set([...Object.keys(before.errors), ...Object.keys(after.errors)])].sort();
  if (failed.length) throw new Error(`continuity-run: input paths could not be hashed (${failed.join(", ")})`);
  const moved = driftedPaths(before.hashes, after.hashes);
  if (moved.length) throw new Error(`continuity-run: input tree changed during preflight (${moved.join(", ")}); rerun preflight`);
  return { hashes: after.hashes, value };
}

export interface RunOptions {
  readonly arm: 1 | 2 | 3;
  readonly tasks: readonly Task[];
  readonly repeats: number;
  readonly model: string;
  readonly effort: string;
  readonly isolation: "fresh" | "shared";
  readonly ownerException: string | null;
  readonly out: string;
  readonly rawOut: string;
  readonly timeoutMs: number;
  readonly sigkillGraceMs: number;
  readonly maxBudgetUsd: number;
}

export function parseArgs(argv: readonly string[]): RunOptions {
  const get = (k: string, d?: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  if (argv.includes("--skip-build")) throw new Error("continuity-run: --skip-build is not supported; the build is what ties dist/ to the input tree");
  const arm = Number(get("arm", "1"));
  if (![1, 2, 3].includes(arm)) throw new Error(`--arm must be 1, 2 or 3`);
  const tasks = (get("tasks", TASKS.join(","))!).split(",").map((t) => t.trim()).filter(Boolean) as Task[];
  for (const t of tasks) if (!TASKS.includes(t)) throw new Error(`unknown task ${t}; known: ${TASKS.join(", ")}`);
  if (new Set(tasks).size !== tasks.length) throw new Error("--tasks lists a task twice");
  const isolation = get("isolation", "shared");
  if (isolation !== "fresh" && isolation !== "shared") throw new Error("--isolation must be fresh or shared");
  const timeoutMs = Number(get("timeout-ms", "1800000"));
  const sigkillGraceMs = Number(get("sigkill-grace-ms", "15000"));
  assertValidTimerMs(timeoutMs, "timeout-ms", "continuity-run");
  assertValidTimerMs(sigkillGraceMs, "sigkill-grace-ms", "continuity-run");
  const repeats = Number(get("repeats", String(REPEATS)));
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > REPEATS) throw new Error(`--repeats must be an integer in 1..${REPEATS}`);
  const out = resolve(get("out", DEFAULT_OUT)!);
  const rawOut = resolve(get("raw-out", DEFAULT_RAW_OUT)!);
  checkOutputPaths(out, rawOut, PKG_ROOT);
  return {
    arm: arm as 1 | 2 | 3, tasks, repeats,
    model: get("model", "claude-opus-5")!,
    effort: get("effort", "high")!,
    isolation,
    ownerException: get("owner-exception") ?? null,
    out, rawOut, timeoutMs, sigkillGraceMs,
    maxBudgetUsd: Number(get("max-budget-usd", "15")),
  };
}

/** Canonical path of the nearest existing ancestor plus the remainder, so a not-yet-created output dir still resolves through symlinks. */
export function canonical(p: string): string {
  let probe = resolve(p);
  const tail: string[] = [];
  while (!existsSync(probe)) { tail.unshift(basename(probe)); const up = dirname(probe); if (up === probe) break; probe = up; }
  return join(realpathSync(probe), ...tail);
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** The private directory must never sit inside the publicly projected package, and the two outputs must not overlap. */
export function checkOutputPaths(out: string, rawOut: string, pkgRoot: string): void {
  const o = canonical(out); const r = canonical(rawOut); const pkg = canonical(pkgRoot);
  if (within(r, pkg)) throw new Error(`continuity-run: --raw-out ${rawOut} resolves inside the package (${pkg}); raw transcripts must stay out of the public projection`);
  if (within(o, r) || within(r, o)) throw new Error(`continuity-run: --out and --raw-out overlap (${o} / ${r})`);
}

/** The exact argv for one attempt's `claude -p`. Slash commands enabled, tools enabled, MCP strictly ours. */
export function buildClaudeArgs(o: { readonly prompt: string; readonly model: string; readonly effort: string; readonly mcpConfigPath: string; readonly maxBudgetUsd: number }): string[] {
  return [
    "-p", o.prompt,
    "--model", o.model,
    "--effort", o.effort,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config", o.mcpConfigPath,
    "--setting-sources", "user",
    "--max-budget-usd", String(o.maxBudgetUsd),
  ];
}

function sh(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, { cwd, env: env ?? process.env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** pgrep exits 1 when nothing matches; that is an empty answer, not an error. */
function pgrep(args: string[], cwd: string): string {
  try { return sh("pgrep", args, cwd); } catch { return ""; }
}

// --- configuration inventory ----------------------------------------------------

/** Tokenises a hook command respecting single and double quotes. */
export function commandTokens(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter(Boolean);
}

function collectCommands(node: unknown, into: string[]): void {
  if (Array.isArray(node)) { for (const n of node) collectCommands(n, into); return; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "command" && typeof v === "string") into.push(v);
      else collectCommands(v, into);
    }
  }
}

/**
 * Everything the client loads from its config dir that can change a session: settings.json, every hook script
 * those settings name (resolved structurally, quoted paths included), the user CLAUDE.md, the installed skill
 * tree, and the plugin inventory. Symlinks are inventoried by hashTree.
 */
export function effectiveConfigHash(configDir: string): { readonly sha256: string; readonly inventory: Record<string, string> } {
  const inv: Record<string, string> = {};
  const settings = join(configDir, "settings.json");
  if (existsSync(settings)) {
    const text = readFileSync(settings, "utf-8");
    inv["settings.json"] = sha256(text);
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { inv["settings.json:parse"] = "invalid-json"; }
    const commands: string[] = [];
    collectCommands((parsed as { hooks?: unknown } | null)?.hooks, commands);
    for (const cmd of commands) {
      for (const tok of commandTokens(cmd)) {
        const p = tok.replace(/^~(?=\/|$)/, homedir());
        if (!p.startsWith("/") || !existsSync(p)) continue;
        try { inv[`hook:${tok}`] = isDir(p) ? hashTree(p).sha256 : sha256(readFileSync(p)); } catch { inv[`hook:${tok}`] = "unreadable"; }
      }
    }
  }
  const claudeMd = join(configDir, "CLAUDE.md");
  if (existsSync(claudeMd)) inv["CLAUDE.md"] = sha256(readFileSync(claudeMd));
  for (const f of PLUGIN_INVENTORY_FILES) {
    const p = join(configDir, f);
    if (!existsSync(p)) continue;
    const h = pluginInventoryHash(readFileSync(p, "utf-8"));
    inv[f] = h.sha256;
    if (!h.parseOk) inv[`${f}:parse`] = "invalid-json";
  }
  const skills = join(configDir, "skills", "story");
  if (existsSync(skills)) inv["skills/story"] = hashTree(skills).sha256;
  return { sha256: sha256(JSON.stringify(inv)), inventory: inv };
}

const PLUGIN_INVENTORY_FILES = ["plugins/installed_plugins.json", "plugins/known_marketplaces.json"] as const;
/** Timestamps the client rewrites on every session start (ISS-1315); what a plugin IS stays pinned. */
const VOLATILE_PLUGIN_KEYS: ReadonlySet<string> = new Set(["lastUpdated", "installedAt"]);

function withoutVolatileKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutVolatileKeys);
  if (v && typeof v === "object") {
    // Null prototype: a parsed "__proto__" key must stay an own property, or it would hit the setter and vanish from the hash.
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (!VOLATILE_PLUGIN_KEYS.has(k)) out[k] = withoutVolatileKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** A plugin inventory file hashed as sorted-key JSON without its volatile keys; unparseable text hashes raw. */
export function pluginInventoryHash(text: string): { readonly sha256: string; readonly parseOk: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { sha256: sha256(text), parseOk: false }; }
  return { sha256: sha256(JSON.stringify(withoutVolatileKeys(parsed))), parseOk: true };
}

function isDir(p: string): boolean {
  try { readdirSync(p); return true; } catch { return false; }
}

/** A fresh client config dir: the source skill, empty settings, onboarding done. Deterministic, so every attempt's dir hashes the same. */
export function provisionFreshConfig(dest: string, skillSource = join(PKG_ROOT, "src", "skill")): void {
  mkdirSync(dest, { recursive: true });
  cpSync(skillSource, join(dest, "skills", "story"), { recursive: true });
  writeFileSync(join(dest, "settings.json"), `${JSON.stringify({ env: {}, hooks: {} }, null, 2)}\n`);
  writeFileSync(join(dest, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);
}

/**
 * A shared-isolation owner exception is a ruling in the workspace ledger that names T-525 and "shared", loaded
 * through the real ruling loader and checked against the real successor index (supersession lives on the
 * successor's `supersedes` field, never on the old ruling).
 */
export function validateOwnerException(id: string, workspaceRoot: string): { readonly id: string; readonly sha256: string } {
  if (!/^r-[a-z0-9]+$/.test(id)) throw new Error(`continuity-run: --owner-exception ${id} is not a ruling id`);
  const loaded = loadRulingsSafe(workspaceRoot);
  const ruling = loaded.rulings.find((r) => r.id === id);
  if (!ruling) throw new Error(`continuity-run: owner exception ${id} is not a readable ruling in ${workspaceRoot}/.story/rulings${loaded.warnings.length ? ` (${loaded.warnings.join("; ")})` : ""}`);
  const successors = buildSuccessorIndex(loaded.rulings).successorsByTarget.get(id);
  if (successors && successors.length > 0) throw new Error(`continuity-run: ruling ${id} is superseded by ${successors.join(", ")}`);
  const lifecycle = classifyLifecycle(ruling).lifecycle;
  if (lifecycle !== "accepted" && lifecycle !== "accepted-legacy") throw new Error(`continuity-run: ruling ${id} is ${lifecycle}, not accepted; it cannot serve as the owner exception`);
  // The text is the owner's own words, which need not spell the ticket out; the record's scope tags and context may.
  const tags = (ruling.scopeTags ?? []).map((t) => t.toLowerCase());
  const namesTicket = /\bT-525\b/i.test(ruling.text) || /\bT-525\b/i.test(ruling.narrative?.context ?? "") || tags.includes("t-525");
  const namesShared = /\bshared\b/i.test(ruling.text) || tags.includes("shared");
  const missing = [namesTicket ? null : "T-525", namesShared ? null : "shared isolation"].filter((m): m is string => m !== null);
  if (missing.length > 0) throw new Error(`continuity-run: ruling ${id} does not name ${missing.join(" and ")}; it cannot serve as the owner exception`);
  return { id, sha256: sha256(readFileSync(join(workspaceRoot, ".story", "rulings", `${id}.json`))) };
}

// --- preflight ---------------------------------------------------------------

export interface BuildManifest {
  readonly workspaceHead: string;
  readonly nodeVersion: string;
  readonly packageJsonSha256: string;
  readonly lockfileSha256: string;
  readonly installedLockSha256: string | null;
  readonly tsupConfigSha256: string;
  readonly dist: Record<string, string>;
  readonly storybloqVersion: string;
  readonly storybloqExecutable: string;
  readonly claudeVersion: string;
}

export function buildManifestHash(m: BuildManifest): string {
  const { workspaceHead: _head, ...stable } = m;
  return sha256(JSON.stringify(stable));
}

export function distHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of DIST_FILES) out[f] = sha256(readFileSync(join(PKG_ROOT, f)));
  return out;
}

export interface Preflight {
  readonly build: BuildManifest;
  readonly buildManifestHash: string;
  readonly inputTreeHash: string;
  /** ISS-1273/1274: the same inputs hashed per path, so a drift names what moved. */
  readonly inputHashes: Record<string, string>;
  /** ISS-1273: the task material that must be identical across arms, rolled and per path. */
  readonly taskMaterialHash: string;
  readonly taskMaterialHashes: Record<string, string>;
  readonly experiment: string;
  readonly isolation: "fresh" | "shared";
  /** Shared: the live config dir. Fresh: null; each attempt provisions its own. */
  readonly sharedConfigDir: string | null;
  /** The configuration fingerprint every attempt must match before and after. */
  readonly configHash: string;
  readonly configInventory: Record<string, string>;
  readonly skillMarker: string | null;
  readonly allowlist: string[];
  readonly ownerException: { readonly id: string; readonly sha256: string } | null;
}

export function preflight(o: RunOptions): Preflight {
  refuseAmbiguousSecrets(process.env);
  assertSubscriptionAuthOnly(process.env, "continuity-run");
  for (const proc of ["vitest", "jest"]) {
    const found = pgrep(["-fl", proc], PKG_ROOT);
    if (found) throw new Error(`continuity-run: ${proc} is running on this machine; the memory rule forbids a concurrent suite:\n${found}`);
  }
  checkOutputPaths(o.out, o.rawOut, PKG_ROOT);
  const dirty = sh("git", ["status", "--porcelain", "--", ...INPUT_PATHS], PKG_ROOT);
  if (dirty) throw new Error(`continuity-run: the input tree has uncommitted changes; commit or discard them first:\n${dirty}`);
  sh("npm", ["run", "build"], PKG_ROOT);
  const exe = realpathSync(sh("which", ["storybloq"], PKG_ROOT));
  if (!within(exe, PKG_ROOT)) throw new Error(`continuity-run: the global storybloq resolves to ${exe}, outside this checkout`);
  const build: BuildManifest = {
    workspaceHead: sh("git", ["rev-parse", "HEAD"], PKG_ROOT),
    nodeVersion: process.version,
    packageJsonSha256: sha256(readFileSync(join(PKG_ROOT, "package.json"))),
    lockfileSha256: sha256(readFileSync(join(PKG_ROOT, "package-lock.json"))),
    installedLockSha256: existsSync(join(PKG_ROOT, "node_modules/.package-lock.json")) ? sha256(readFileSync(join(PKG_ROOT, "node_modules/.package-lock.json"))) : null,
    tsupConfigSha256: sha256(readFileSync(join(PKG_ROOT, "tsup.config.ts"))),
    dist: distHashes(),
    storybloqVersion: sh("storybloq", ["--version"], PKG_ROOT),
    storybloqExecutable: exe,
    claudeVersion: sh("claude", ["--version"], PKG_ROOT),
  };
  const bmh = buildManifestHash(build);
  const { hashes: perPathHashes, value: { inputTreeHash, tm } } = bracketedInputs(inputHashes, () => ({
    inputTreeHash: hashInputs(INPUT_PATHS.map((p) => ({ label: p, path: join(PKG_ROOT, p) }))),
    tm: taskMaterial(PKG_ROOT),
  }));
  // The task material's per-path values are the same entries hashed the same way; a mismatch means a read moved.
  const tmMoved = Object.keys(tm.paths).filter((l) => tm.paths[l] !== perPathHashes[l]);
  if (tmMoved.length) throw new Error(`continuity-run: task material changed during preflight (${tmMoved.join(", ")}); rerun preflight`);
  let sharedConfigDir: string | null = null;
  let skillMarker: string | null = null;
  let cfg: { sha256: string; inventory: Record<string, string> };
  if (o.isolation === "fresh") {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("continuity-run: --isolation fresh needs CLAUDE_CODE_OAUTH_TOKEN (claude setup-token); refusing");
    if (o.ownerException) throw new Error("continuity-run: --owner-exception only applies to shared isolation");
    const template = mkdtempSync(join(tmpdir(), "continuity-config-template-"));
    provisionFreshConfig(template);
    cfg = effectiveConfigHash(template);
    rmSync(template, { recursive: true, force: true });
  } else {
    sharedConfigDir = claudeConfigDir();
    const d = skillPayloadDiff(join(sharedConfigDir, "skills", "story"), join(PKG_ROOT, "src", "skill"));
    if (!d.ok) throw new Error(`continuity-run: installed skill differs from src/skill (extra ${d.extra.join(",")}; missing ${d.missing.join(",")}; changed ${d.changed.join(",")}); run storybloq setup --client claude`);
    skillMarker = d.marker;
    cfg = effectiveConfigHash(sharedConfigDir);
  }
  const ownerException = o.isolation === "shared" && o.ownerException ? validateOwnerException(o.ownerException, WORKSPACE_ROOT) : null;
  const experiment = experimentHash({ arm: o.arm, inputTreeHash, buildManifestHash: bmh, model: o.model, effort: o.effort, timeoutMs: o.timeoutMs, maxBudgetUsd: o.maxBudgetUsd, clientVersion: build.claudeVersion, isolation: o.isolation, configHash: cfg.sha256 } satisfies ExperimentInputs);
  return { build, buildManifestHash: bmh, inputTreeHash, inputHashes: perPathHashes, taskMaterialHash: tm.sha256, taskMaterialHashes: tm.paths, experiment, isolation: o.isolation, sharedConfigDir, configHash: cfg.sha256, configInventory: cfg.inventory, skillMarker, allowlist: fixtureCredentialAllowlist(join(FIXTURE_ROOT, "core")), ownerException };
}

// --- one attempt -------------------------------------------------------------

export type SpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;

export interface SignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface AttemptDeps {
  readonly spawnFn?: SpawnFn;
  readonly now?: () => number;
  readonly signals?: SignalSource;
  /** The dist hash provider; tests inject a deterministic one so no build is needed. */
  readonly distHashes?: () => Record<string, string>;
  /** The per-path input hash provider; tests inject a deterministic one so the real tree is never rehashed. */
  readonly inputHashes?: () => InputHashes;
  /** The machine-load sampler and its period; tests inject both. */
  readonly loadSample?: () => Omit<LoadSample, "t">;
  readonly loadSampleMs?: number;
  /** The per-attempt progress line; stdout by default. */
  readonly log?: (line: string) => void;
}

/** One reading of this Mac: load1 from the kernel, free swap from vm.swapusage; an unreadable figure is null. */
export function sampleMachine(): Omit<LoadSample, "t"> {
  let swapFreeBytes: number | null = null;
  try { swapFreeBytes = parseSwapFree(execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf-8", timeout: 5000 })); } catch { /* unreadable */ }
  const load1 = loadavg()[0];
  return { load1: typeof load1 === "number" && Number.isFinite(load1) ? load1 : null, swapFreeBytes };
}

export interface AttemptOutcome {
  readonly validity: "valid" | "invalid";
  readonly completion: CompletionStatus;
  readonly interrupted: boolean;
  /** B2: the session stopped on a rate limit or overload; the matrix stops rather than spend the cell's retries on it. */
  readonly rateLimited: boolean;
  /** The pre-registered load rule invalidated this timeout; the matrix stops until the machine is quiet. */
  readonly machineLoad: boolean;
  readonly evidenceComplete: boolean;
  readonly inputDrift: InputDrift;
  /** ISS-1315: the inventory entries that had drifted when the attempt was refused before its spawn, else null. */
  readonly configDrift: readonly string[] | null;
  readonly invalidReasons: readonly string[];
  readonly wallMs: number;
  readonly exitCode: number | null;
}

async function validateClean(root: string): Promise<void> {
  const { state, warnings } = await loadProject(root);
  const ctx: CommandContext = { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format: "md" };
  const res = handleValidate(ctx);
  if (/Errors:\s*[1-9]/.test(res.output)) throw new Error(`fixture does not validate:\n${res.output}`);
}

function gitLocal(cwd: string, args: string[]): string {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return sh("git", args, cwd, env);
}

export type KillKind = "timeout" | "external-kill" | "runner-signal" | null;

export async function runAttempt(o: RunOptions, pf: Preflight, task: Task, repeat: number, attemptNo: number, deps: AttemptDeps = {}): Promise<AttemptOutcome> {
  const spawnFn = deps.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  const now = deps.now ?? Date.now;
  const signals: SignalSource = deps.signals ?? process;
  const readDist = deps.distHashes ?? distHashes;
  const readInputs = deps.inputHashes ?? inputHashes;
  const ticketId = ticketIdForTask(task);
  const shortExp = pf.experiment.slice(0, 12);
  const pubDir = join(o.out, shortExp, task, `repeat-${repeat}`, attemptDirName(attemptNo));
  const rawDir = join(o.rawOut, shortExp, task, `repeat-${repeat}`, attemptDirName(attemptNo));
  mkdirSync(pubDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const cleanup: (() => void)[] = [];
  const failure = (stage: string, err: unknown): void => {
    try { writeFileSync(join(rawDir, "failure.json"), JSON.stringify({ stage, error: err instanceof Error ? (err.stack ?? err.message) : String(err), at: new Date().toISOString() }, null, 2)); } catch { /* the raw dir itself may be the failure */ }
  };

  try {
    const workdir = mkdtempSync(join(tmpdir(), "continuity-work-"));
    const mat = materialize(FIXTURE_ROOT, o.arm, task, workdir);
    if (mat.variant) {
      const v = variantDiscoveryViolations(task, mat.variant);
      if (v.length) throw new Error(`variant check failed: ${v.join("; ")}`);
    }
    gitLocal(workdir, ["init", "-q", "-b", "main"]);
    gitLocal(workdir, ["config", "user.name", "continuity-fixture"]);
    gitLocal(workdir, ["config", "user.email", "fixture@continuity.invalid"]);
    gitLocal(workdir, ["add", "-A"]);
    gitLocal(workdir, ["commit", "-q", "-m", "fixture: initial state"]);
    const initialHead = gitLocal(workdir, ["rev-parse", "HEAD"]);
    await validateClean(workdir);
    cpSync(join(workdir, ".story"), join(rawDir, "ledger.before"), { recursive: true });
    const taskTicket = readFileSync(join(workdir, ".story", "tickets", `${ticketId}.json`), "utf-8");

    let configDir: string;
    if (o.isolation === "fresh") {
      configDir = mkdtempSync(join(tmpdir(), "continuity-config-"));
      provisionFreshConfig(configDir);
      const dir = configDir;
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    } else {
      configDir = pf.sharedConfigDir!;
    }
    const cfgBefore = effectiveConfigHash(configDir);
    // ISS-1315: a config that has moved since preflight moved for every attempt after it too. Spawn nothing,
    // record the refusal (not counted toward the retry budget), and let the matrix stop for repair.
    if (cfgBefore.sha256 !== pf.configHash) {
      const drifted = configInventoryDrift(pf.configInventory, cfgBefore.inventory);
      const reasons = ["config-drift"];
      const record = {
        experimentHash: pf.experiment, arm: o.arm, task, repeat, attempt: attemptNo, ticketId, validity: "invalid", invalidReasons: reasons, inputDrift: { invalidating: [], disclosed: [], errors: {} },
        completion: "not-started", completionReason: `config drifted since preflight: ${drifted.join(", ") || "inventory hash"}`, completed: true, evidenceComplete: false, requiredArtefacts: [], wallMs: 0,
        killKind: null, interrupted: false, rateLimitStop: null, machineLoadStop: null, exitCode: null, exitSignal: null, configDrift: drifted, finishedAt: new Date().toISOString(),
      };
      const sctx = { workdir, home: homedir(), user: userInfo().username, pkgRoot: PKG_ROOT, allowlist: pf.allowlist };
      const recordText = sanitize(JSON.stringify(record, null, 2), sctx).text;
      const recordVerdict = publicationCheck(recordText, pf.allowlist, { secrets: RUNNER_SECRETS });
      if (!recordVerdict.ok) throw new Error(`record.json would publish blocked content (${recordVerdict.blocked.map((b) => b.label).join(",")}); runner bug`);
      await writeAtomic(join(pubDir, "record.json"), recordText);
      await writeAtomic(join(pubDir, "artefacts.sha256.json"), JSON.stringify({ "record.json": sha256(readFileSync(join(pubDir, "record.json"))) }, null, 2));
      await writeAtomic(join(pubDir, "completed"), `${new Date().toISOString()}\n`);
      return { validity: "invalid", completion: "not-started", interrupted: false, rateLimited: false, machineLoad: false, evidenceComplete: false, inputDrift: record.inputDrift, configDrift: drifted, invalidReasons: reasons, wallMs: 0, exitCode: null };
    }

    const mcpConfigPath = join(workdir, ".continuity-mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { storybloq: { command: process.execPath, args: [join(PKG_ROOT, "dist", "mcp.js")] } } }, null, 2));
    const distBefore = readDist();
    // Drift before the spawn is not an attempt to record: the experiment's build identity no longer holds.
    if (!sameHashes(pf.build.dist, distBefore)) throw new Error(`continuity-run: dist/ changed since preflight (${Object.keys(pf.build.dist).filter((k) => pf.build.dist[k] !== distBefore[k]).join(", ") || "key set"}); rerun preflight`);
    // ISS-1274: the same rule for the hashed inputs. An edit that reaches the cell voids the identity before anything is spent;
    // a plugins-source edit (dist unchanged, checked just above) proceeds and is disclosed on the record.
    const inputsBefore = readInputs();
    const driftBefore = inputDrift(pf.inputHashes, [inputsBefore], true);
    if (driftBefore.invalidating.length) throw new Error(`continuity-run: input tree changed since preflight (${driftBefore.invalidating.join(", ")}); rerun preflight`);
    const manifestPre = {
      experimentHash: pf.experiment, arm: o.arm, task, repeat, attempt: attemptNo, ticketId, model: o.model, effort: o.effort, isolation: o.isolation,
      ownerException: pf.ownerException, timeoutMs: o.timeoutMs, maxBudgetUsd: o.maxBudgetUsd, inputTreeHash: pf.inputTreeHash, buildManifestHash: pf.buildManifestHash,
      inputHashes: pf.inputHashes, taskMaterialHash: pf.taskMaterialHash, taskMaterialHashes: pf.taskMaterialHashes,
      build: pf.build, configHashExpected: pf.configHash, configHashBefore: cfgBefore.sha256, configInventory: cfgBefore.inventory, skillMarker: pf.skillMarker,
      variantSha256: mat.variantSha256, overlay: mat.overlay ? basename(mat.overlay) : null,
      rubricVersion: /rubricVersion:\s*(\d+)/.exec(readFileSync(join(FIXTURE_ROOT, "rubric.md"), "utf-8"))?.[1] ?? null, startedAt: new Date().toISOString(),
    };
    writeFileSync(join(rawDir, "manifest.pre.json"), JSON.stringify(manifestPre, null, 2));

    const prompt = `/story auto ${ticketId}`;
    const args = buildClaudeArgs({ prompt, model: o.model, effort: o.effort, mcpConfigPath, maxBudgetUsd: o.maxBudgetUsd });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ALTERNATE_AUTH_ENV_VARS) delete env[k];
    if (o.isolation === "fresh") env.CLAUDE_CONFIG_DIR = configDir;
    const transcriptPath = join(rawDir, "transcript.jsonl");
    const stderrPath = join(rawDir, "stderr.txt");
    const outStream = createWriteStream(transcriptPath, { flags: "a" });
    const errStream = createWriteStream(stderrPath, { flags: "a" });
    const streamErrors: string[] = [];
    outStream.on("error", (e) => streamErrors.push(`transcript: ${e.message}`));
    errStream.on("error", (e) => streamErrors.push(`stderr: ${e.message}`));
    const started = now();
    const kill: { kind: KillKind } = { kind: null };
    const planCopies: { toolUseId: string; file: string }[] = [];
    // The INITIAL snapshot belongs to the first main-session plan_written call, whether or not its copy succeeds.
    let firstPlanWrittenId: string | null = null;
    let mainPlanWrittenCalls = 0;
    const watcherErrors: string[] = [];
    let sessionDir: string | null = null;
    let lineBuf = "";
    const plansDir = join(rawDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    const child = spawnFn("claude", args, { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = (sig: NodeJS.Signals): void => {
      try { if (child.pid) process.kill(-child.pid, sig); else throw new Error("no pid"); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // An operator signal always wins the classification, even when it arrives during a timeout's grace period:
    // the matrix must stop, and a retry after cancellation is the one thing this record must never permit.
    const escalate = (kind: Exclude<KillKind, null | "external-kill">): void => {
      if (kill.kind === null || kind === "runner-signal") kill.kind = kind;
      killGroup("SIGTERM");
      if (!killTimer) killTimer = setTimeout(() => killGroup("SIGKILL"), o.sigkillGraceMs);
    };
    const onSignal = (): void => escalate("runner-signal");
    signals.once("SIGINT", onSignal);
    signals.once("SIGTERM", onSignal);
    const termTimer = setTimeout(() => escalate("timeout"), o.timeoutMs);
    const loadSamples: LoadSample[] = [];
    const takeSample = (): void => { try { loadSamples.push({ t: now(), ...(deps.loadSample ?? sampleMachine)() }); } catch { loadSamples.push({ t: now(), load1: null, swapFreeBytes: null }); } };
    takeSample();
    const loadTimer = setInterval(takeSample, deps.loadSampleMs ?? LOAD_RULE.sampleMs);
    cleanup.push(() => clearInterval(loadTimer));
    cleanup.push(() => { clearTimeout(termTimer); if (killTimer) clearTimeout(killTimer); signals.off("SIGINT", onSignal); signals.off("SIGTERM", onSignal); });
    cleanup.push(() => { if (child.exitCode === null && child.signalCode === null) killGroup("SIGKILL"); });

    const watchLine = (line: string): void => {
      let ev: { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } } | null = null;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== "object") return;
      const mainSession = ev.parent_tool_use_id === null || ev.parent_tool_use_id === undefined;
      if (ev.type === "user" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message!.content as { type: string; content?: unknown }[]) {
          if (b.type !== "tool_result") continue;
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as { text?: string }[]).map((p) => p.text ?? "").join("\n") : "";
          const sid = /\*\*Session:\*\*\s*([0-9a-f-]{36})/i.exec(text)?.[1];
          if (sid && !sessionDir) sessionDir = join(workdir, ".story", "sessions", sid);
        }
        return;
      }
      if (ev.type !== "assistant" || !Array.isArray(ev.message?.content)) return;
      for (const b of ev.message!.content as { type: string; id?: string; name?: string; input?: { report?: { completedAction?: string } } }[]) {
        if (b.type === "tool_use" && b.name && /storybloq_autonomous_guide$/.test(b.name) && b.input?.report?.completedAction === "plan_written" && mainSession) {
          mainPlanWrittenCalls++;
          const id = b.id ?? "";
          if (firstPlanWrittenId === null) firstPlanWrittenId = id;
          const file = id === firstPlanWrittenId ? "plan.initial.md" : `plan.round-${mainPlanWrittenCalls}.md`;
          const src = sessionDir ? join(sessionDir, "plan.md") : null;
          if (src && existsSync(src)) {
            copyFileSync(src, join(plansDir, file));
            planCopies.push({ toolUseId: id, file });
          }
        }
      }
    };
    const feed = (line: string): void => { try { watchLine(line); } catch (e) { watcherErrors.push(e instanceof Error ? e.message : String(e)); } };
    child.stdout?.on("data", (d: Buffer) => {
      outStream.write(d);
      lineBuf += d.toString("utf-8");
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) { const line = lineBuf.slice(0, nl); lineBuf = lineBuf.slice(nl + 1); feed(line); }
    });
    child.stderr?.on("data", (d: Buffer) => errStream.write(d));

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((res) => {
      child.on("error", (error) => res({ code: null, signal: null, error }));
      child.on("close", (code, signal) => res({ code, signal }));
    });
    clearTimeout(termTimer); if (killTimer) clearTimeout(killTimer);
    clearInterval(loadTimer); takeSample();
    signals.off("SIGINT", onSignal); signals.off("SIGTERM", onSignal);
    if (lineBuf.trim()) feed(lineBuf);
    await new Promise<void>((r) => outStream.end(r));
    await new Promise<void>((r) => errStream.end(r));
    if (exit.signal === "SIGKILL" && kill.kind === null) kill.kind = "external-kill";
    // A timeout is a behavioural failure under the fixed budget, never an interruption: the observation stands,
    // unless the stream shows it was spent on a rate limit or overload (rateLimitStop, B2).
    const interrupted = kill.kind === "runner-signal" || kill.kind === "external-kill";
    const survivors = child.pid ? pgrep(["-g", String(child.pid)], workdir) : "";
    if (survivors) killGroup("SIGKILL");
    let sidecarOutcome: unknown = null;
    let stateJson: Record<string, unknown> | null = null;
    if (!sessionDir) {
      const sessions = join(workdir, ".story", "sessions");
      const dirs = existsSync(sessions) ? readdirSync(sessions) : [];
      if (dirs.length === 1 && dirs[0]) sessionDir = join(sessions, dirs[0]);
    }
    if (sessionDir && existsSync(join(sessionDir, "state.json"))) {
      stateJson = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as Record<string, unknown>;
      sidecarOutcome = killSidecar(stateJson.sidecarPid as number | null | undefined, { sessionDir });
    }
    const wallMs = now() - started;

    // Extraction.
    const rawText = readFileSync(transcriptPath, "utf-8");
    const parsed = parseStream(rawText);
    const { usage, toolCalls } = summarizeStream(parsed.events);
    if (firstPlanWrittenId !== usage.firstPlanWrittenToolUseId) watcherErrors.push(`watcher saw first plan_written ${firstPlanWrittenId ?? "none"}, stream summary says ${usage.firstPlanWrittenToolUseId ?? "none"}`);
    const distAfter = readDist();
    // ISS-1274: rehash after the attempt; drift at either end (or a walk that failed) is drift under the run.
    const inputsAfter = readInputs();
    const drift = inputDrift(pf.inputHashes, [inputsBefore, inputsAfter], sameHashes(pf.build.dist, distBefore) && sameHashes(pf.build.dist, distAfter));
    const cfgAfter = effectiveConfigHash(configDir).sha256;
    const fp = (stateJson?.binaryFingerprint as { sha256?: string } | null | undefined)?.sha256 ?? null;
    const initServers = (usage.initEvent?.mcp_servers as { name?: string; status?: string }[] | undefined) ?? null;
    const limitStop = rateLimitStop(parsed.events);
    const loadStop = machineLoadStop(kill.kind, loadSamples);
    const v = validity({
      stateBinaryFingerprintSha256: fp, builtMcpSha256: pf.build.dist["dist/mcp.js"] ?? "", toolResults: toolCalls.map((t) => t.result), mainModels: usage.mainModels, pinnedModel: o.model,
      distHashesExpected: pf.build.dist, distHashesBefore: distBefore, distHashesAfter: distAfter, configHashExpected: pf.configHash, configHashBefore: cfgBefore.sha256, configHashAfter: cfgAfter,
      streamCorrupt: parsed.corruptLines > 0 || streamErrors.length > 0 || watcherErrors.length > 0, initMcpServers: initServers, interrupted,
      inputDriftInvalidating: drift.invalidating, rateLimitStop: limitStop, machineLoadStop: loadStop,
    });
    let headAfter = initialHead;
    try { headAfter = gitLocal(workdir, ["rev-parse", "HEAD"]); } catch { /* keep */ }
    const ticketFile = join(workdir, ".story", "tickets", `${ticketId}.json`);
    const ticketStatus = existsSync(ticketFile) ? ((JSON.parse(readFileSync(ticketFile, "utf-8")) as { status?: string }).status ?? null) : null;
    const handoversDir = join(workdir, ".story", "handovers");
    const newHandovers = existsSync(handoversDir) ? readdirSync(handoversDir).filter((f) => !existsSync(join(rawDir, "ledger.before", "handovers", f))) : [];
    const comp = completion({ stateJson: stateJson as never, ticketId, ticketStatusOnDisk: ticketStatus, handoverWritten: newHandovers.length > 0, headMoved: headAfter !== initialHead });

    cpSync(join(workdir, ".story"), join(rawDir, "ledger.after"), { recursive: true });
    if (sessionDir && existsSync(sessionDir)) cpSync(sessionDir, join(rawDir, "session"), { recursive: true });
    const ledgerChanges = diffLedger(join(rawDir, "ledger.before"), join(rawDir, "ledger.after"));
    let sourceDiff = ""; let worktreeStatus = "";
    try { sourceDiff = gitLocal(workdir, ["diff", `${initialHead}..HEAD`]); } catch { /* none */ }
    try { worktreeStatus = gitLocal(workdir, ["status", "--porcelain"]); } catch { /* none */ }

    // Sanitised publication: one checked writer for every byte that lands under pubDir.
    const sctx = { workdir, home: homedir(), user: userInfo().username, pkgRoot: PKG_ROOT, allowlist: pf.allowlist };
    const redactionFull: Record<string, unknown> = { rawTranscriptSha256: sha256(rawText), rawTranscriptBytes: Buffer.byteLength(rawText), substitutions: {}, fixtureDerived: {}, blocked: {} };
    const redactionPublic: Record<string, unknown> = { rawTranscriptSha256: sha256(rawText), rawTranscriptBytes: Buffer.byteLength(rawText), substitutions: {}, fixtureDerived: {}, blockedLabels: {} };
    const published: Record<string, boolean> = {};
    const publish = (name: string, text: string): boolean => {
      const s = sanitize(text, sctx);
      const verdict = publicationCheck(s.text, pf.allowlist, { secrets: RUNNER_SECRETS });
      (redactionFull.substitutions as Record<string, unknown>)[name] = s.substitutions;
      (redactionPublic.substitutions as Record<string, unknown>)[name] = s.substitutions;
      (redactionFull.fixtureDerived as Record<string, unknown>)[name] = verdict.fixtureDerived;
      (redactionPublic.fixtureDerived as Record<string, unknown>)[name] = verdict.fixtureDerived;
      // A document that parsed before must parse after, or a corrupted artefact publishes as clean.
      const shapeBroken = !jsonShapePreserved(text, s.text);
      if (!verdict.ok || shapeBroken) {
        (redactionFull.blocked as Record<string, unknown>)[name] = shapeBroken ? [...verdict.blocked, { label: "json-shape", sample: "sanitisation broke a document that parsed before" }] : verdict.blocked;
        const labels: Record<string, number> = {};
        for (const b of verdict.blocked) labels[b.label] = (labels[b.label] ?? 0) + 1;
        if (shapeBroken) labels["json-shape"] = 1;
        (redactionPublic.blockedLabels as Record<string, unknown>)[name] = labels;
        writeFileSync(join(rawDir, `unpublished.${name}`), text);
        published[name] = false;
        return false;
      }
      writeFileSync(join(pubDir, name), s.text);
      published[name] = true;
      return true;
    };
    const guideReports = toolCalls.filter((t) => /storybloq_autonomous_guide$/.test(t.name) && t.parentToolUseId === null).map((t) => ({ toolUseId: t.toolUseId, input: t.input, resultHead: t.result.slice(0, 400) }));
    const evidence = toolCalls.filter((t) => t.parentToolUseId === null).map((t: ToolCallRecord) => JSON.stringify(t)).join("\n");
    if (mat.variant) publish("variant.json", JSON.stringify(mat.variant, null, 2));
    publish("task.json", taskTicket);
    if (sessionDir && existsSync(join(sessionDir, "context-digest.md"))) {
      const planInstr = toolCalls.find((t) => /storybloq_autonomous_guide$/.test(t.name) && /\*\*State:\*\*\s*PLAN\b/.test(t.result))?.result ?? "(PLAN instruction not observed)";
      publish("plan-context.md", `# context-digest.md\n\n${readFileSync(join(sessionDir, "context-digest.md"), "utf-8")}\n\n# PLAN instruction (verbatim guide result)\n\n${planInstr}\n`);
    }
    if (sessionDir && existsSync(join(sessionDir, "plan.md"))) publish("plan.md", readFileSync(join(sessionDir, "plan.md"), "utf-8"));
    for (const pc of planCopies) publish(pc.file, readFileSync(join(plansDir, pc.file), "utf-8"));
    publish("evidence.jsonl", evidence);
    publish("source.diff", sourceDiff);
    publish("worktree.status", worktreeStatus);
    publish("ledger.changes.json", JSON.stringify(ledgerChanges, null, 2));
    publish("reports.json", JSON.stringify(guideReports, null, 2));
    publish("handover.md", newHandovers.map((f) => `<!-- ${f} -->\n${readFileSync(join(handoversDir, f), "utf-8")}`).join("\n\n"));
    const usageOut = { ...usage, initEvent: undefined, resultEvent: undefined, totalCostUsd: (usage.resultEvent as { total_cost_usd?: number } | null)?.total_cost_usd ?? null, numTurns: (usage.resultEvent as { num_turns?: number } | null)?.num_turns ?? null, resultSubtype: (usage.resultEvent as { subtype?: string } | null)?.subtype ?? null };
    publish("usage.json", JSON.stringify(usageOut, null, 2));
    publish("load.json", JSON.stringify({ rule: LOAD_RULE, samples: loadSamples.map((x) => ({ offsetMs: x.t - started, load1: x.load1, swapFreeBytes: x.swapFreeBytes })) }, null, 2));
    publish("manifest.json", JSON.stringify({ ...manifestPre, post: { distAfter, inputHashesAfter: inputsAfter.hashes, configHashAfter: cfgAfter, stateBinaryFingerprintSha256: fp, mainModels: usage.mainModels, subagentModels: usage.subagentModels, clientSessionId: usage.initEvent?.session_id ?? null, finishedAt: new Date().toISOString() } }, null, 2));
    writeFileSync(join(rawDir, "redaction.full.json"), JSON.stringify(redactionFull, null, 2));
    publish("redaction.json", JSON.stringify(redactionPublic, null, 2));

    // Required evidence follows the observed lifecycle, not what happened to be captured: a session that reported
    // plan_written owes the INITIAL snapshot and the FINAL plan; a session that produced a digest owes the PLAN
    // context. A genuine behavioural failure that never wrote a plan owes neither.
    const required = ["evidence.jsonl", "source.diff", "ledger.changes.json", "reports.json", "handover.md", "usage.json", "manifest.json", "task.json", "load.json"];
    if (usage.firstPlanWrittenToolUseId !== null) required.push("plan.initial.md", "plan.md");
    if (sessionDir && existsSync(join(sessionDir, "context-digest.md"))) required.push("plan-context.md");
    for (const pc of planCopies) if (!required.includes(pc.file)) required.push(pc.file);
    const evidenceComplete = required.every((n) => published[n] === true);
    // The record itself is published through the same checker; a blocked record is a runner bug, not a redaction.
    const record = {
      experimentHash: pf.experiment, arm: o.arm, task, repeat, attempt: attemptNo, ticketId, validity: v.valid ? "valid" : "invalid", invalidReasons: v.reasons, inputDrift: drift,
      completion: comp.status, completionReason: comp.reason, completed: true, evidenceComplete, requiredArtefacts: required, wallMs, killKind: kill.kind, interrupted, rateLimitStop: limitStop, machineLoadStop: loadStop, exitCode: exit.code, exitSignal: exit.signal,
      spawnError: exit.error ? exit.error.message : null, streamCorruptLines: parsed.corruptLines, streamErrors, watcherErrors, truncatedTail: parsed.truncatedTail !== null, planCopies, sessionId: usage.guideSessionId,
      guideStates: usage.guideStates.map((g) => g.state), survivorsKilled: survivors ? survivors.split("\n").length : 0, sidecarOutcome, headBefore: initialHead, headAfter, published, finishedAt: new Date().toISOString(),
    };
    const recordText = sanitize(JSON.stringify(record, null, 2), sctx).text;
    const recordVerdict = publicationCheck(recordText, pf.allowlist, { secrets: RUNNER_SECRETS });
    if (!recordVerdict.ok) throw new Error(`record.json would publish blocked content (${recordVerdict.blocked.map((b) => b.label).join(",")}); runner bug`);
    await writeAtomic(join(pubDir, "record.json"), recordText);
    // Completed marker only after the published artefacts re-hash to what the manifest lists.
    const hashes: Record<string, string> = {};
    for (const [name, ok] of Object.entries(published)) if (ok) hashes[name] = sha256(readFileSync(join(pubDir, name)));
    hashes["record.json"] = sha256(readFileSync(join(pubDir, "record.json")));
    await writeAtomic(join(pubDir, "artefacts.sha256.json"), JSON.stringify(hashes, null, 2));
    for (const [name, h] of Object.entries(hashes)) if (sha256(readFileSync(join(pubDir, name))) !== h) throw new Error(`artefact ${name} changed under the writer`);
    await writeAtomic(join(pubDir, "completed"), `${new Date().toISOString()}\n`);
    return { validity: record.validity as "valid" | "invalid", completion: comp.status, interrupted, rateLimited: limitStop !== null, machineLoad: loadStop !== null, evidenceComplete, inputDrift: drift, configDrift: null, invalidReasons: v.reasons, wallMs, exitCode: exit.code };
  } catch (err) {
    failure("attempt", err);
    throw err;
  } finally {
    for (const fn of cleanup.reverse()) { try { fn(); } catch { /* best effort */ } }
  }
}

/** B2: raised when an attempt stopped on a rate limit or overload; a re-run after it clears resumes the matrix. */
export class RateLimitStopError extends Error {
  constructor(message: string) { super(message); this.name = "RateLimitStopError"; }
}

/** Raised when a timeout was invalidated by the pre-registered load rule; a re-run on a quiet machine resumes the matrix. */
export class MachineLoadStopError extends Error {
  constructor(message: string) { super(message); this.name = "MachineLoadStopError"; }
}

/** ISS-1315: raised when the client config drifted before a spawn; a re-run after the config is restored resumes. */
export class ConfigDriftStopError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigDriftStopError"; }
}

/** Raised when a cell publishes without its evidence: the experiment cannot qualify, so the matrix stops. */
export class EvidenceIncompleteError extends Error {
  constructor(message: string) { super(message); this.name = "EvidenceIncompleteError"; }
}

// --- matrix -------------------------------------------------------------------

export interface AttemptEntry {
  readonly name: string;
  readonly record: { readonly validity: "valid" | "invalid"; readonly experimentHash: string; readonly completed: boolean; readonly evidenceComplete: boolean; readonly task?: string; readonly repeat?: number; readonly invalidReasons?: readonly string[]; readonly completion?: string } | null;
  readonly reason?: string;
}

/** Every allocated attempt directory, each verified by the shared reader (record hash, manifest schema, required artefacts). */
export function readAttempts(cellDir: string): AttemptEntry[] {
  if (!existsSync(cellDir)) return [];
  return readdirSync(cellDir).filter((d) => d.startsWith("attempt-")).map((name): AttemptEntry => {
    const v = verifyAttemptDir(join(cellDir, name));
    if (!v.record) return { name, record: null, reason: v.reason ?? undefined };
    return { name, record: { validity: v.record.validity, experimentHash: v.record.experimentHash, completed: true, evidenceComplete: v.evidenceComplete, task: v.record.task, repeat: v.record.repeat, invalidReasons: v.record.invalidReasons, completion: v.record.completion }, reason: v.reason ?? undefined };
  });
}

export interface MatrixResult {
  readonly qualifying: boolean;
  readonly reason: string;
  readonly summary: string[];
}

type CellRow = { task: string; repeat: number; satisfied: boolean; evidenceComplete: boolean; attempt: string | null };

export async function runMatrix(o: RunOptions, pf: Preflight, deps: AttemptDeps = {}): Promise<MatrixResult> {
  const shortExp = pf.experiment.slice(0, 12);
  const cells: CellRow[] = [];
  const summary: string[] = [];
  for (const task of o.tasks) {
    for (let repeat = 1; repeat <= o.repeats; repeat++) {
      const cellDir = join(o.out, shortExp, task, `repeat-${repeat}`);
      for (;;) {
        const decision = decideCell(readAttempts(cellDir), pf.experiment, { task, repeat });
        if (decision.kind !== "satisfied" && decision.mismatched.length) summary.push(`${task}#${repeat}: ignored foreign records: ${decision.mismatched.join("; ")}`);
        if (decision.kind === "satisfied") {
          cells.push({ task, repeat, satisfied: true, evidenceComplete: decision.evidenceComplete, attempt: decision.attempt });
          summary.push(`${task}#${repeat}: satisfied by ${decision.attempt}${decision.evidenceComplete ? "" : " (evidence incomplete)"}`);
          // An observation that cannot publish its evidence cannot be scored, and qualifies() refuses the whole
          // experiment for one of them. Continuing spends every remaining cell on a result that can never be
          // cited. Two captures were lost this way before the runner stopped saying nothing about it: the first
          // ran 4 cells past the point of no return, the second 6. This is a tooling defect, not a behavioural
          // failure, so it stops the matrix for repair rather than counting against the arm.
          if (!decision.evidenceComplete) {
            writeExperiment(o, pf, cells, summary, `${task}#${repeat} published incomplete evidence (${decision.attempt}); the experiment can no longer qualify`);
            throw new EvidenceIncompleteError(`continuity-run: ${task}#${repeat} published incomplete evidence via ${decision.attempt}; see its redaction.json blockedLabels. No further attempts started.`);
          }
          break;
        }
        if (decision.kind === "exhausted") { cells.push({ task, repeat, satisfied: false, evidenceComplete: false, attempt: null }); summary.push(`${task}#${repeat}: EXHAUSTED (only invalid attempts)`); break; }
        const r = await runAttempt(o, pf, task, repeat, decision.nextAttempt, deps);
        (deps.log ?? ((line: string) => process.stdout.write(`${line}\n`)))(`attempt ${task}#${repeat}.${decision.nextAttempt} ${r.validity} [${r.invalidReasons.join(", ")}] wall=${Math.round(r.wallMs / 1000)} exit=${r.exitCode ?? "none"}`);
        const driftNote = `${r.inputDrift.invalidating.length ? ` INPUT DRIFT (${r.inputDrift.invalidating.join(", ")})` : ""}${r.inputDrift.disclosed.length ? ` input drift disclosed (${r.inputDrift.disclosed.join(", ")})` : ""}`;
        summary.push(`${task}#${repeat} ${attemptDirName(decision.nextAttempt)}: ${r.validity} ${r.completion}${r.interrupted ? " INTERRUPTED" : ""}${r.rateLimited ? " RATE-LIMITED" : ""}${r.machineLoad ? " MACHINE-LOAD" : ""}${driftNote}`);
        if (r.configDrift !== null) {
          writeExperiment(o, pf, cells, summary, "the client config drifted since preflight; restore it (or rerun preflight) and re-run the same command");
          throw new ConfigDriftStopError(`continuity-run: ${task}#${repeat} refused before its spawn: config drifted since preflight (${r.configDrift.join(", ") || "inventory hash"}). No attempt was spent; no further attempts started.`);
        }
        if (r.interrupted) {
          writeExperiment(o, pf, cells, summary, "interrupted by the operator");
          throw new SessionKilledError("external-kill", `continuity-run: interrupted during ${task}#${repeat}; no further attempts started`);
        }
        if (r.rateLimited) {
          writeExperiment(o, pf, cells, summary, "stopped on a rate limit or overload; re-run the same command after it clears");
          throw new RateLimitStopError(`continuity-run: ${task}#${repeat} stopped on a rate limit or overload; the attempt is invalid and not counted. No further attempts started; re-run the same command after it clears.`);
        }
        if (r.machineLoad) {
          writeExperiment(o, pf, cells, summary, "a timeout under the pre-registered machine-load rule; re-run the same command when the machine is quiet");
          throw new MachineLoadStopError(`continuity-run: ${task}#${repeat} timed out under measured machine load; the attempt is invalid and not counted. No further attempts started; re-run the same command when the machine is quiet.`);
        }
      }
    }
  }
  return writeExperiment(o, pf, cells, summary, null);
}

function writeExperiment(o: RunOptions, pf: Preflight, cells: CellRow[], summary: string[], interruption: string | null): MatrixResult {
  const q = interruption ? { qualifying: false, shortCells: [], unpublishedCells: [], reason: interruption } : qualifies({ cells, isolation: o.isolation, ownerException: pf.ownerException?.id ?? null });
  const expDir = join(o.out, pf.experiment.slice(0, 12));
  mkdirSync(expDir, { recursive: true });
  const text = sanitize(JSON.stringify({ experimentHash: pf.experiment, arm: o.arm, model: o.model, effort: o.effort, isolation: o.isolation, ownerException: pf.ownerException, inputTreeHash: pf.inputTreeHash, inputHashes: pf.inputHashes, taskMaterialHash: pf.taskMaterialHash, taskMaterialHashes: pf.taskMaterialHashes, buildManifestHash: pf.buildManifestHash, configHash: pf.configHash, build: pf.build, cells, qualification: q, writtenAt: new Date().toISOString() }, null, 2), { workdir: "\0never", home: homedir(), user: userInfo().username, pkgRoot: PKG_ROOT, allowlist: pf.allowlist }).text;
  const verdict = publicationCheck(text, pf.allowlist, { secrets: RUNNER_SECRETS });
  if (!verdict.ok) throw new Error(`experiment.json would publish blocked content (${verdict.blocked.map((b) => b.label).join(",")}); runner bug`);
  writeFileSync(join(expDir, "experiment.json"), text);
  const marker = join(expDir, "QUALIFYING");
  if (q.qualifying) writeFileSync(marker, `${new Date().toISOString()} ${q.reason}\n`);
  else if (existsSync(marker)) rmSync(marker);
  return { qualifying: q.qualifying, reason: q.reason, summary };
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const pf = preflight(o);
  process.stdout.write(`experiment ${pf.experiment}\nisolation ${o.isolation}; model ${o.model}; effort ${o.effort}; tasks ${o.tasks.join(",")} x ${o.repeats}\n`);
  const r = await runMatrix(o, pf);
  process.stdout.write(`${r.summary.join("\n")}\nqualifying: ${r.qualifying} (${r.reason})\n`);
  process.exit(r.qualifying ? 0 : 3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof SessionKilledError ? `[${err.kind}] ` : ""}${(err as Error).stack ?? String(err)}\n`);
    process.exit(err instanceof SessionKilledError ? 130 : err instanceof EvidenceIncompleteError ? 4 : err instanceof RateLimitStopError ? 5 : err instanceof MachineLoadStopError ? 6 : err instanceof ConfigDriftStopError ? 7 : 1);
  });
}
