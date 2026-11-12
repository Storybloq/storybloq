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
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync, createWriteStream, cpSync, realpathSync, rmSync } from "node:fs";
import { createServer, connect as netConnect, type AddressInfo } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { tmpdir, homedir, userInfo, loadavg } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSubscriptionAuthOnly, assertValidTimerMs, writeAtomic, writeDurable, fsyncDir, readRegularFile, SessionKilledError } from "./headless-common.js";
import {
  CLAUDE_TOOLS, claudeArgvProblems, claudePolicySettings, claudeReadback, claudeTurnArgs, initContradicts, initEventConsulted, isProvenanceProblem, initEventProblems, initProvenanceProblems, policyFileProblems,
  READBACK_REQUESTS, READBACK_TIMEOUT_MS, readbackExpected, readbackProblems, userMessage, type ReadbackExpected, type ClaudeExpected, type ClaudePolicyOptions, type ClaudeSession, type ReadbackIo, type ReadbackStep,
  type SignedInProvenance,
} from "./headless-policy.js";
import { jsonShapePreserved,
  TASKS, type Task, REPEATS, ticketIdForTask, materialize, variantDiscoveryViolations, parseStream, summarizeStream,
  validity, rateLimitStop, machineLoadStop, parseSwapFree, LOAD_RULE, type LoadSample, completion, sanitize, publicationCheck, fixtureCredentialAllowlist, diffLedger, decideCell, attemptDirName,
  qualifies, experimentHash, hashInputs, hashTree, sha256, verifyAttemptDir, LAUNCH_POLICY, pathMapping, classifyDenial, judgePilot, readPilot, probeMark, pilotCommand, inspectTarget, pilotVerdict, type PilotFactsFile, type PilotChecks,
  PILOT_FILE, PILOT_EVIDENCE, type PermissionDenial, type PilotFacts, type StreamEvent, sameHashes, type ExperimentInputs, type ToolCallRecord, type CompletionStatus,
  environmentSecrets, ambiguousEnvironmentSecrets, INPUT_PATHS, hashInputsByPath, taskMaterial, driftedPaths, classifyInputDrift, configInventoryDrift,
} from "./continuity-lib.js";
import { serverLaunch, writeServerLauncher } from "./onboarding-eval-host.js";
import { identityOf, startOf } from "./onboarding-eval-groups.js";
import { HomeJournalStop, journalAfter, journalBefore, journalGroup, recoverHomeJournal, type RecoveryProbe } from "./continuity-home.js";
import { EVAL_DIST } from "./build-eval.mjs";
import { killSidecar } from "../src/autonomous/liveness.js";
import { CONFIRM_BOUND_MS, CONFIRM_POLL_MS, groupHandle, processGroupSeams, type GroupHandle } from "../src/core/process-group.js";
import { loadProject } from "../src/core/project-loader.js";
import { handleValidate } from "../src/cli/commands/validate.js";
import type { CommandContext } from "../src/cli/types.js";
import { checkedProvenance, realHome, signedInClientEnv, signedInEnvProblems, signedInSpawnRefusal, writeStorybloqLauncher } from "./continuity-signed-in.js";

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
  /** ISS-1486 D4: fresh, or T-525 Addendum E's signed-in. The type keeps "shared" only so the entry points can be shown to refuse it. */
  readonly isolation: "fresh" | "shared" | "signed-in";
  /** Addendum E: the owner ruling id a signed-in live launch names. */
  readonly liveAck?: string;
  /** ISS-1486 D9: run the pilot for the arm instead of the matrix. */
  readonly pilot?: boolean;
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
  // ISS-1486 D4: shared isolation runs the client on the owner's live config, which the launch policy cannot hold.
  if (argv.includes("--owner-exception")) throw new Error(`continuity-run: --owner-exception is refused (${SHARED_REFUSAL})`);
  const isolation = get("isolation", "fresh");
  if (isolation !== "fresh" && isolation !== "signed-in") throw new Error(`continuity-run: --isolation ${String(isolation)} is refused (${SHARED_REFUSAL})`);
  const liveAck = get("live-ack");
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
    ...(liveAck === undefined ? {} : { liveAck }),
    pilot: argv.includes("--pilot"),
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

// --- ISS-1486: the launch under the shared policy ---------------------------------------------

/** Why shared isolation and the owner exception are refused, named in every refusal. */
export const SHARED_REFUSAL = "ISS-1486: the continuity runner runs only fresh isolation, under the shared launch policy (the one exception is signed-in, owner ruling r-hs5j319qkr3gjvtz)";

/** D4: refused at parseArgs and again at every exported entry point, so a caller building options by hand cannot reach a launch. */
export function refuseShared(o: { readonly isolation: string; readonly ownerException?: unknown }): void {
  if (o.isolation !== "fresh" && o.isolation !== "signed-in") throw new Error(`continuity-run: ${String(o.isolation)} isolation is refused (${SHARED_REFUSAL})`);
  if (o.ownerException !== undefined && o.ownerException !== null) throw new Error(`continuity-run: an owner exception is refused (${SHARED_REFUSAL})`);
}

/**
 * D2: this runner's options. The onboarding seven plus Agent (the review stages use a reviewer agent when no review
 * server is connected), Task, WebFetch and WebSearch denied, the effort and no session persistence as extras.
 */
export function continuityOptions(effort: string): ClaudePolicyOptions {
  return {
    builtInTools: [...CLAUDE_TOOLS, "Agent"],
    allowBuiltIns: ["Read", "Glob", "Grep", "Bash", "Skill", "Agent"],
    deny: ["WebFetch", "WebSearch", "Task"],
    extraArgs: [["--effort", effort]],
    extraFlags: ["--no-session-persistence"],
  };
}

/** T-525 Addendum E2: the signed-in arm's options, the continuity policy with no settings source but the run's --settings file. */
export function signedInOptions(effort: string): ClaudePolicyOptions {
  return { ...continuityOptions(effort), settingSources: "none" };
}

export const CONTINUITY_TOOLS_FILE = join(SCRIPT_DIR, "continuity-tools.json");
/** G1: the onboarding inventory, whose `withheld` map is the one list of tools no evaluation serves. */
export const ONBOARDING_TOOLS_FILE = join(SCRIPT_DIR, "onboarding-eval-tools.json");

/** G1: the names the onboarding inventory withholds, each with its reason; read from that file, never copied. */
export function withheldTools(file = ONBOARDING_TOOLS_FILE): Record<string, string> {
  const v = (JSON.parse(readFileSync(file, "utf-8")) as { withheld?: unknown }).withheld;
  if (v === null || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length === 0 || !Object.values(v).every((r) => typeof r === "string")) {
    throw new Error(`continuity-run: ${file} has no withheld map`);
  }
  return { ...(v as Record<string, string>) };
}

/**
 * D2: the pinned storybloq tool names; a file that is not a list of distinct names refuses. G1: so does a file that
 * permits any name the onboarding inventory withholds, for the same reasons (another repository's paths, other
 * sessions, a process id), before any launch.
 */
export function continuityTools(file = CONTINUITY_TOOLS_FILE, withheldFile = ONBOARDING_TOOLS_FILE): string[] {
  const v = (JSON.parse(readFileSync(file, "utf-8")) as { tools?: unknown }).tools;
  if (!Array.isArray(v) || v.length === 0 || !v.every((t) => typeof t === "string" && /^storybloq_[a-z0-9_]+$/.test(t)) || new Set(v).size !== v.length) {
    throw new Error(`continuity-run: ${file} is not a list of distinct storybloq tool names`);
  }
  const withheld = withheldTools(withheldFile);
  const named = (v as string[]).filter((t) => Object.hasOwn(withheld, t));
  if (named.length > 0) throw new Error(`continuity-run: ${file} permits ${named.map((t) => `${t} (${withheld[t]})`).join(", ")}, which the onboarding inventory withholds`);
  return [...v] as string[];
}

/** G2: the evaluation bundle the tool server runs (scripts/build-eval.mjs builds it; preflight records its sha256). */
export const EVAL_MCP_BUNDLE = join(PKG_ROOT, EVAL_DIST, "eval-mcp.js");
/** T-525 Addendum E4: the evaluation CLI bundle the signed-in arm's pinned storybloq launcher runs. */
export const EVAL_CLI_BUNDLE = join(PKG_ROOT, EVAL_DIST, "eval-cli.js");

/**
 * G2: the tool server's column. The server runs through the shared launcher (T-538 F2) under `codex sandbox`, with
 * exactly these variables, each from the MCP file's entry; nothing else the client holds, its OAuth token above
 * all, reaches the wrapper, the server or anything it starts.
 */
export const CONTINUITY_SERVER_COLUMN = [
  "PATH", "HOME", "TMPDIR", "LANG", "CODEX_HOME", "STORYBLOQ_PROJECT_ROOT", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_EVAL_EVENTS", "STORYBLOQ_EVAL_OUTSIDE", "STORYBLOQ_EVAL_TOOLS",
] as const;

/** G2: why the recorded bundle cannot be used: missing, or not the bytes preflight hashed. */
export function bundleProblems(file: string, sha: string): string[] {
  if (!existsSync(file)) return [`the evaluation bundle ${EVAL_DIST}/eval-mcp.js is missing; build it with node scripts/build-eval.mjs and rerun preflight`];
  return sha256(readFileSync(file)) === sha ? [] : [`the evaluation bundle ${EVAL_DIST}/eval-mcp.js is not the one preflight recorded; rerun preflight`];
}

/** The four folders of one launch, each canonical: the work folder and the temp folder are the writable roots. */
export interface LaunchDirs { readonly work: string; readonly tmp: string; readonly home: string; readonly config: string; readonly launch: string }

/**
 * D3: the client's environment, built from a table and never copied: the tool server it starts inherits it, and
 * STORYBLOQ_PROJECT_ROOT or CLAUDESTORY_PROJECT_ROOT from the runner's own environment would point that server at
 * another project. Nothing else passes, so no alternate authentication variable can either.
 */
export function launchEnv(source: NodeJS.ProcessEnv, d: Pick<LaunchDirs, "work" | "tmp" | "home" | "config">): NodeJS.ProcessEnv {
  // G2: the global folder lies under the temp root, so the sandboxed server and the client's own CLI share one writable copy.
  const env: NodeJS.ProcessEnv = { PATH: source.PATH ?? "/usr/bin:/bin", HOME: d.home, TMPDIR: d.tmp, CLAUDE_CONFIG_DIR: d.config, STORYBLOQ_PROJECT_ROOT: d.work, STORYBLOQ_GLOBAL_DIR: join(d.tmp, "storybloq-global") };
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "LANG", "LC_ALL"] as const) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

/** One launch: its files, what every check compares against, the argv and the environment. */
export interface Launch {
  /** T-525 G1: the isolation this launch was prepared for; the spawn boundary refuses signed-in whatever the run's options say. */
  readonly isolation: "fresh" | "signed-in";
  readonly dirs: LaunchDirs;
  readonly roots: readonly string[];
  readonly options: ClaudePolicyOptions;
  readonly expected: ClaudeExpected;
  readonly session: ClaudeSession;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /**
   * T-525 Addendum E1: the environment of the pilot's outside network probe, which runs unsandboxed. Signed-in: the
   * server column's values (the scratch HOME), never the client's real HOME. Fresh: the client's own environment.
   */
  readonly probeEnv: NodeJS.ProcessEnv;
  /** G1 and G2: the server's launcher, its tools file and the bundle, each checked before the spawn. */
  readonly server: {
    readonly launcher: string; readonly launcherSha256: string; readonly toolsFile: string; readonly toolsSha256: string; readonly bundle: string; readonly bundleSha256: string; readonly roots: readonly string[];
    /** J2: the codex the wrapper runs and its fingerprint from the build manifest, checked again before the spawn. */
    readonly codexBin: string; readonly codex: { readonly codexSha256: string; readonly codexVersion: string };
  };
  /** T-525 Addendum E4: the signed-in arm's pinned storybloq launcher, first on the client's PATH; absent on a fresh launch. */
  readonly storybloqLauncher?: { readonly path: string; readonly sha256: string };
}

/**
 * T-525: the isolation a launch is prepared for. Signed-in names the operator's real HOME, which the client alone
 * gets (from the password database unless a test passes a fake one); nothing under it is opened here.
 */
export type LaunchMode = { readonly isolation: "fresh" } | { readonly isolation: "signed-in"; readonly realHome?: string };

/** A new folder, canonical: a temp folder reached through a link (/var against /private/var) would fail every exact comparison. */
export const canonicalTemp = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/**
 * D2 and D5: the policy file (0400) and the MCP file (0600), each written once outside both roots, and the argv and
 * environment that use them. The MCP server entry pins the project root as well (D3).
 */
export function prepareLaunch(dirs: LaunchDirs, p: { readonly model: string; readonly effort: string; readonly maxBudgetUsd: number; readonly tools: readonly string[]; readonly codexBin: string; readonly bundleSha256: string; readonly codex: { readonly codexSha256: string; readonly codexVersion: string }; readonly provenance?: SignedInProvenance }, source: NodeJS.ProcessEnv = process.env, mode: LaunchMode = { isolation: "fresh" }): Launch {
  const signedIn = mode.isolation === "signed-in";
  // T-525 Addendum E1 and E3: a signed-in launch refuses on any token-shaped name in its source (names only) and
  // needs its pinned provenance; a fresh launch never carries one. All of it before anything is written.
  if (!signedIn && p.provenance !== undefined) throw new Error("continuity-run: provenance is a signed-in launch input only; refusing");
  if (signedIn) {
    const names = signedInEnvProblems(source);
    if (names.length > 0) throw new Error(`continuity-run: signed-in isolation refuses these variables (names only): ${names.join(", ")}`);
  }
  const provenance = signedIn ? checkedProvenance(p.provenance) : undefined;
  const roots = [dirs.work, dirs.tmp];
  // G2: the server's roots are the client's, with the project's .git named as T-538's are.
  const serverRoots = [dirs.work, join(dirs.work, ".git"), dirs.tmp];
  const options = signedIn ? signedInOptions(p.effort) : continuityOptions(p.effort);
  const policyFile = join(dirs.launch, "policy.json");
  const mcpFile = join(dirs.launch, "mcp.json");
  // G1: the server's inventory, both lists the permitted names, so restrictTools registers nothing else.
  const toolsFile = join(dirs.launch, "tools.json");
  // G2: the wrapper's own CODEX_HOME (empty) and the folder the server's self-probe must fail to write, both outside every root.
  const runnerHome = join(dirs.launch, "runner-home");
  const outside = join(dirs.launch, "outside-probe");
  // T-525 Addendum E4: the signed-in client's storybloq launcher folder, outside every writable root like the rest.
  const cliBin = join(dirs.launch, "bin");
  for (const f of [policyFile, mcpFile, toolsFile, runnerHome, outside, ...(signedIn ? [cliBin] : [])]) if (serverRoots.some((r) => within(f, r))) throw new Error(`continuity-run: ${f} is under a writable root`);
  const policyText = claudePolicySettings(roots, p.tools, options);
  writeFileSync(policyFile, policyText, { mode: 0o400, flag: "wx" });
  const toolsText = `${JSON.stringify({ degraded: [...p.tools], full: [...p.tools] }, null, 2)}\n`;
  writeFileSync(toolsFile, toolsText, { mode: 0o400, flag: "wx" });
  mkdirSync(runnerHome);
  mkdirSync(outside);
  const events = join(dirs.tmp, "eval-events", "events.jsonl");
  mkdirSync(dirname(events), { recursive: true });
  const launcher = writeServerLauncher(dirs.launch);
  let storybloqLauncher: { readonly path: string; readonly sha256: string } | undefined;
  if (signedIn) {
    mkdirSync(cliBin);
    storybloqLauncher = writeStorybloqLauncher({
      bin: cliBin, node: process.execPath, cli: EVAL_CLI_BUNDLE, scratchHome: dirs.home, codexHome: runnerHome, tmp: dirs.tmp, work: dirs.work,
      path: source.PATH ?? "/usr/bin:/bin", ...(source.LANG === undefined ? {} : { lang: source.LANG }),
    });
  }
  // E1: only the client gets the real HOME; the server column below keeps the scratch home and the source PATH.
  const env = mode.isolation === "signed-in" ? signedInClientEnv(source, { work: dirs.work, tmp: dirs.tmp, launcherBin: cliBin }, mode.realHome ?? realHome()) : launchEnv(source, dirs);
  const values: Record<(typeof CONTINUITY_SERVER_COLUMN)[number], string | undefined> = {
    PATH: source.PATH ?? "/usr/bin:/bin", HOME: dirs.home, TMPDIR: dirs.tmp, LANG: env.LANG, CODEX_HOME: runnerHome, STORYBLOQ_PROJECT_ROOT: dirs.work, STORYBLOQ_GLOBAL_DIR: env.STORYBLOQ_GLOBAL_DIR,
    STORYBLOQ_EVAL_EVENTS: events, STORYBLOQ_EVAL_OUTSIDE: outside, STORYBLOQ_EVAL_TOOLS: toolsFile,
  };
  const serverEnv: Record<string, string> = {};
  for (const k of CONTINUITY_SERVER_COLUMN) if (values[k] !== undefined) serverEnv[k] = values[k];
  const sl = serverLaunch(p.codexBin, process.execPath, EVAL_MCP_BUNDLE, serverRoots, launcher, Object.keys(serverEnv));
  const mcpLaunch = { command: sl.command, args: [...sl.args], env: serverEnv };
  const mcpText = `${JSON.stringify({ mcpServers: { storybloq: mcpLaunch } }, null, 2)}\n`;
  writeFileSync(mcpFile, mcpText, { mode: 0o600, flag: "wx" });
  const expected: ClaudeExpected = {
    model: p.model, policyFile, policySha256: sha256(policyText), mcpFile, mcpSha256: sha256(mcpText), project: dirs.work, roots,
    allowedTools: [...p.tools], mcpTools: [...p.tools], mcpLaunch, maxBudgetUsd: p.maxBudgetUsd, ...(provenance === undefined ? {} : { provenance }),
  };
  const session: ClaudeSession = { kind: "first", id: randomUUID() };
  const server = { launcher, launcherSha256: sha256(readFileSync(launcher)), toolsFile, toolsSha256: sha256(toolsText), bundle: EVAL_MCP_BUNDLE, bundleSha256: p.bundleSha256, roots: serverRoots, codexBin: p.codexBin, codex: { codexSha256: p.codex.codexSha256, codexVersion: p.codex.codexVersion } };
  return { isolation: mode.isolation, dirs, roots, options, expected, session, args: claudeTurnArgs(expected, session, options), env, probeEnv: signedIn ? { ...serverEnv } : env, server, ...(storybloqLauncher === undefined ? {} : { storybloqLauncher }) };
}

/**
 * K1: a signal to a detached child's whole process group; the turn and the probe share it. ISS-1494: the group
 * signal goes through the child's ISS-1469 handle, so once the group has been seen gone or SIGKILLed nothing more
 * is sent to that number. Whenever the group was not signalled, the child alone is, through Node's own handle,
 * which never reaches a process that is no longer this child.
 */
export function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid && groupHandle(child, true).signal(sig) === "sent") return;
  try { child.kill(sig); } catch { /* gone */ }
}

/** K1: whether any process is still in the child's group (ISS-1494: probed through its handle, so a gone answer disarms it). */
function groupAlive(child: ChildProcess): boolean {
  const answer = groupHandle(child, true).probe();
  return answer === "alive" || answer === "EPERM";
}

/**
 * J1: runs a network probe command outside any sandbox and reports whether the listener saw its token (the text
 * between the command's first pair of single quotes). The command is stopped once the token arrives, or after 5 s.
 * K1: it runs in its own process group, and the whole group (the shell and the nc in its pipeline) is killed and
 * awaited, so nothing it started outlives the probe or holds a connection open.
 */
export async function outsideProbe(command: string, cwd: string, env: NodeJS.ProcessEnv, received: readonly Buffer[]): Promise<boolean> {
  const token = /'([^']*)'/.exec(command)?.[1] ?? "";
  if (token === "") return false;
  const from = received.length;
  const seen = (): boolean => Buffer.concat(received.slice(from)).toString("utf-8").includes(token);
  const child = nodeSpawn("/bin/sh", ["-c", command], { cwd, env, stdio: "ignore", detached: true });
  // ISS-1494: settled on every way out, after the stop and its confirmation, so its gone-watch never outlives the probe.
  const handle = groupHandle(child, true);
  try {
    let ended = false;
    const exited = new Promise<void>((r) => { child.once("error", () => { ended = true; r(); }); child.once("close", () => { ended = true; r(); }); });
    let ok = false;
    for (let i = 0; i < 250 && !ok; i++) {
      ok = seen();
      if (!ok) await new Promise((r) => setTimeout(r, 20));
      if (ended && !ok) { await new Promise((r) => setTimeout(r, 50)); ok = seen(); break; }
    }
    signalGroup(child, "SIGKILL");
    await exited;
    if (child.pid) for (let i = 0; i < 100 && groupAlive(child); i++) await new Promise((r) => setTimeout(r, 20));
    return ok;
  } finally {
    handle.settle();
  }
}

/** D5: every reason the launch must not start, checked immediately before the spawn; empty means it holds. */
export function launchProblems(l: Launch): string[] {
  return [
    ...claudeArgvProblems(l.args, l.expected, l.session, l.options),
    ...policyFileProblems(l.expected.policyFile, l.expected.policySha256, 0o400),
    ...policyFileProblems(l.expected.mcpFile, l.expected.mcpSha256, 0o600),
    ...policyFileProblems(l.server.launcher, l.server.launcherSha256, 0o500),
    ...policyFileProblems(l.server.toolsFile, l.server.toolsSha256, 0o400),
    ...bundleProblems(l.server.bundle, l.server.bundleSha256),
    ...codexProblems(l.server.codexBin, l.server.codex),
  ];
}

function sh(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, { cwd, env: env ?? process.env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** pgrep exits 1 when nothing matches; that is an empty answer, not an error. */
function pgrep(args: string[], cwd: string): string {
  try { return sh("pgrep", args, cwd); } catch { return ""; }
}

/**
 * The number of processes whose command line matches `pattern`. Counts only: pgrep without -l prints
 * process ids, and only their number leaves this function, so no command line (which can carry another
 * session's token) reaches any text, log or record.
 */
export function processCount(pattern: string, cwd: string): number {
  return pgrep(["-f", pattern], cwd).split("\n").filter((l) => /^\d+$/.test(l.trim())).length;
}

/** The preflight refusal for a concurrent suite, naming the process kind and a count, never its arguments. */
export function concurrentSuiteProblem(proc: string, cwd: string): string | null {
  const n = processCount(proc, cwd);
  return n > 0 ? `continuity-run: ${n} ${proc} process(es) running on this machine; the memory rule forbids a concurrent suite` : null;
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
  /** G2: the sha256 of the evaluation bundle the tool server runs (.eval-dist/eval-mcp.js). */
  readonly evalMcpSha256: string;
  /** J2: the codex the server's sandbox runs under: its resolved file's sha256 and what `--version` prints. */
  readonly codexSha256: string;
  readonly codexVersion: string;
}

/** J2: the codex a launch runs: the sha256 of the file the path resolves to, and its `--version` output. */
export function codexFingerprint(bin: string): { readonly codexSha256: string; readonly codexVersion: string } {
  const codexSha256 = sha256(readFileSync(realpathSync(bin)));
  const codexVersion = execFileSync(bin, ["--version"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { codexSha256, codexVersion };
}

/** J2: why the codex at `bin` is not the one preflight recorded; empty when it is. */
export function codexProblems(bin: string, want: { readonly codexSha256: string; readonly codexVersion: string }): string[] {
  let now: ReturnType<typeof codexFingerprint>;
  try { now = codexFingerprint(bin); } catch (e) { return [`codex ${bin} cannot be fingerprinted (${e instanceof Error ? e.message.split("\n")[0] : String(e)}); rerun preflight`]; }
  const out: string[] = [];
  if (now.codexSha256 !== want.codexSha256) out.push(`codex ${bin} is not the executable preflight recorded; rerun preflight`);
  if (now.codexVersion !== want.codexVersion) out.push(`codex ${bin} reports ${now.codexVersion}, not ${want.codexVersion} as preflight recorded; rerun preflight`);
  return out;
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
  /** Always null since ISS-1486: each attempt provisions its own config dir. */
  readonly sharedConfigDir: string | null;
  /** ISS-1486 D2: the storybloq tool names the policy allows and the readback expects (scripts/continuity-tools.json). */
  readonly tools: readonly string[];
  /** The configuration fingerprint every attempt must match before and after. */
  readonly configHash: string;
  readonly configInventory: Record<string, string>;
  readonly skillMarker: string | null;
  readonly allowlist: string[];
  /** G2: the absolute codex executable whose `sandbox` wraps the tool server. */
  readonly codexBin: string;
}

/**
 * T-525 Addendum E1 and the live guard: a signed-in launch refuses on any token or API-key variable (names
 * only), then refuses to spawn claude: without --live-ack it names the ack, with it the missing gates.
 */
export function refuseSignedIn(o: Pick<RunOptions, "liveAck">, env: NodeJS.ProcessEnv): never {
  const names = signedInEnvProblems(env);
  if (names.length > 0) throw new Error(`continuity-run: signed-in isolation refuses these variables (names only): ${names.join(", ")}`);
  throw new Error(signedInSpawnRefusal(o.liveAck));
}

/**
 * T-525: every execution entry point (runPilot, runAttempt, runMatrix) and the driveClaude spawn boundary
 * refuse a signed-in launch, so a supplied Preflight cannot route around preflight's own refusal.
 */
export function refuseSignedInLaunch(o: Pick<RunOptions, "isolation" | "liveAck">, env: NodeJS.ProcessEnv = process.env): void {
  if (o.isolation === "signed-in") refuseSignedIn(o, env);
}

/**
 * T-525 G1: the Launch's own isolation, independent of the options it is driven with. A signed-in Launch is
 * refused (first for a missing pinned provenance, then as signed-in), and a Launch prepared for another isolation
 * than the run's is a mismatch; all before any spawn.
 */
export function refuseLaunchIsolation(o: Pick<RunOptions, "isolation" | "liveAck">, launch: Pick<Launch, "isolation" | "expected">): void {
  if (launch.isolation === "signed-in") {
    if (launch.expected?.provenance === undefined) throw new Error("continuity-run: a signed-in launch with no pinned provenance is refused before any spawn");
    throw new Error(`continuity-run: the launch is signed-in; ${signedInSpawnRefusal(o.liveAck)}`);
  }
  if (launch.isolation !== o.isolation) throw new Error(`continuity-run: launch isolation ${String(launch.isolation)} does not match the run's ${String(o.isolation)}; refusing before any spawn`);
}

export function preflight(o: RunOptions): Preflight {
  refuseShared(o);
  if (o.isolation === "signed-in") refuseSignedIn(o, process.env);
  refuseAmbiguousSecrets(process.env);
  assertSubscriptionAuthOnly(process.env, "continuity-run");
  for (const proc of ["vitest", "jest"]) {
    const problem = concurrentSuiteProblem(proc, PKG_ROOT);
    if (problem) throw new Error(problem);
  }
  checkOutputPaths(o.out, o.rawOut, PKG_ROOT);
  const dirty = sh("git", ["status", "--porcelain", "--", ...INPUT_PATHS], PKG_ROOT);
  if (dirty) throw new Error(`continuity-run: the input tree has uncommitted changes; commit or discard them first:\n${dirty}`);
  sh("npm", ["run", "build"], PKG_ROOT);
  // G2: the tool server runs the evaluation bundle (rebuilt here when its inputs changed) under codex sandbox.
  sh(process.execPath, [join(SCRIPT_DIR, "build-eval.mjs")], PKG_ROOT);
  if (!existsSync(EVAL_MCP_BUNDLE)) throw new Error(`continuity-run: ${bundleProblems(EVAL_MCP_BUNDLE, "")[0]}`);
  let codexBin: string;
  try { codexBin = sh("which", ["codex"], PKG_ROOT); } catch { throw new Error("continuity-run: codex is not on PATH; the tool server runs under codex sandbox"); }
  if (!codexBin.startsWith("/")) throw new Error(`continuity-run: codex resolves to ${codexBin}, not an absolute path`);
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
    evalMcpSha256: sha256(readFileSync(EVAL_MCP_BUNDLE)),
    ...codexFingerprint(codexBin),
  };
  const bmh = buildManifestHash(build);
  const { hashes: perPathHashes, value: { inputTreeHash, tm } } = bracketedInputs(inputHashes, () => ({
    inputTreeHash: hashInputs(INPUT_PATHS.map((p) => ({ label: p, path: join(PKG_ROOT, p) }))),
    tm: taskMaterial(PKG_ROOT),
  }));
  // The task material's per-path values are the same entries hashed the same way; a mismatch means a read moved.
  const tmMoved = Object.keys(tm.paths).filter((l) => tm.paths[l] !== perPathHashes[l]);
  if (tmMoved.length) throw new Error(`continuity-run: task material changed during preflight (${tmMoved.join(", ")}); rerun preflight`);
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("continuity-run: fresh isolation needs CLAUDE_CODE_OAUTH_TOKEN (claude setup-token); refusing");
  const template = mkdtempSync(join(tmpdir(), "continuity-config-template-"));
  provisionFreshConfig(template);
  const cfg = effectiveConfigHash(template);
  rmSync(template, { recursive: true, force: true });
  const tools = continuityTools();
  const experiment = experimentHash({ arm: o.arm, inputTreeHash, buildManifestHash: bmh, model: o.model, effort: o.effort, timeoutMs: o.timeoutMs, maxBudgetUsd: o.maxBudgetUsd, clientVersion: build.claudeVersion, isolation: "fresh", configHash: cfg.sha256, launchPolicy: LAUNCH_POLICY } satisfies ExperimentInputs);
  return { build, buildManifestHash: bmh, inputTreeHash, inputHashes: perPathHashes, taskMaterialHash: tm.sha256, taskMaterialHashes: tm.paths, experiment, isolation: "fresh", sharedConfigDir: null, tools, configHash: cfg.sha256, configInventory: cfg.inventory, skillMarker: null, allowlist: fixtureCredentialAllowlist(join(FIXTURE_ROOT, "core")), codexBin };
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
  /** ISS-1486 D4: how a fresh config dir is provisioned; a test changes it between attempts to show the drift stop. */
  readonly provision?: (dest: string) => void;
  /** ISS-1486 D6: the per-response readback deadline (READBACK_TIMEOUT_MS by default). */
  readonly readbackTimeoutMs?: number;
  /** ISS-1486 D5: called after the launch files are written and before they are checked; a test tampers here. */
  readonly beforeSpawnCheck?: (launch: Launch) => void;
  /** B-F2: the durable writer for the provenance intent and stop (writeDurable by default); a test injects a failure. */
  readonly writeDurable?: (path: string, text: string) => Promise<void>;
  /** B-F3: the directory reads of the provenance-stop scan; a test injects EACCES or EIO. */
  readonly stopScanFs?: StopScanFs;
  /** B-F7: the directory fsync for the raw chain before a guarded spawn (fsyncDir by default); a test records or fails it. */
  readonly fsyncDir?: (dir: string) => Promise<void>;
  /**
   * B-F8, test only (B3-Q): a provenance pinned onto the fresh Launch right after preparation. It is known before any
   * directory is made, so the guarded-run refusals see it at the run's start.
   */
  readonly provenance?: SignedInProvenance;
  /**
   * C1 (W1), test only: a fake home the turn journals as the signed-in arm journals the real one (C1 to C3). The
   * signed-in launch journals realHome() without it.
   */
  readonly homeRoot?: string;
  /** C1, K3 (W2): awaited after the spawn and before the readback and the prompt; a throw stops the turn. */
  readonly onGroup?: (pgid: number) => Promise<void>;
  /** C1: the leader's start identity for the group record (startOf by default). */
  readonly startOf?: (pid: number) => string | null;
  /** C-F3: awaited after the readback and before the prompt: the exchange and what it was compared against, made durable; a throw stops the turn. */
  readonly onReadback?: (r: { readonly expected: ReadbackExpected; readonly steps: readonly ReadbackStep[] }) => Promise<void>;
  /** E3 (B4): the cleanup confirmation's bound (CONFIRM_BOUND_MS by default); a test shortens it. */
  readonly cleanupBoundMs?: number;
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
  /** ISS-1486 D7: the launch-policy failure; the matrix stops on it and it consumes no retry. */
  readonly launchPolicy: string | null;
  /** ISS-1486 D6: the prompt never reached a child that ended on its own; invalid, retried like a spawn failure. */
  readonly inputFailure: string | null;
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

export type KillKind = "timeout" | "external-kill" | "runner-signal" | "policy-stop" | null;

/** What one launch produced, before any judgement of the session's work. */
export interface LaunchRun {
  readonly exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error };
  readonly killKind: KillKind;
  readonly started: number;
  readonly loadSamples: readonly LoadSample[];
  readonly streamErrors: readonly string[];
  readonly readback: { readonly steps: readonly ReadbackStep[]; readonly problems: readonly string[] };
  /** The readback stopped short because the child had already ended (closed, errored, signalled, timed out). */
  readonly readbackIncomplete: boolean;
  /** D7: the first launch-policy problem found during the run (readback); init and denials are judged after it. */
  readonly launchFailure: string | null;
  readonly promptWritten: boolean;
  /** D6: the write was accepted while the input was open, and no input error came before the result. */
  readonly promptDelivered: boolean;
  readonly inputError: string | null;
  readonly resultSeen: boolean;
  readonly survivors: string;
  /** E3: the first provenance latch of the turn (B1 to B4, K1); null when none latched or the launch carries no provenance. */
  readonly provenanceStop: string | null;
  /** E3 (H3): whether the group was confirmed gone after the run; null when no provenance asked for it. */
  readonly cleanup: "confirmed" | "unconfirmed" | null;
  /** E3 (B2): this turn's readback nonce; null without provenance. */
  readonly readbackNonce: string | null;
}

/**
 * E3 (H3): polls the group's handle every CONFIRM_POLL_MS until it answers "gone", for at most `boundMs`. Any other
 * answer at the bound (alive, EPERM, an error code) is "unconfirmed".
 */
export async function confirmGroupGone(handle: Pick<GroupHandle, "probe">, boundMs: number = CONFIRM_BOUND_MS): Promise<"confirmed" | "unconfirmed"> {
  const end = Date.now() + boundMs;
  for (;;) {
    if (handle.probe() === "gone") return "confirmed";
    if (Date.now() >= end) return "unconfirmed";
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
}

/**
 * D6: spawn under the launch, install every handler, run the readback over stdin, and only then write the prompt.
 * Operator signals, the attempt timeout and the policy stop share one escalation; an operator signal always wins.
 * Control responses never reach the transcript; stdin ends at the result event.
 */
export async function driveClaude(o: RunOptions, launch: Launch, prompt: string, files: { readonly transcript: string; readonly stderr: string }, deps: AttemptDeps, onLine: (line: string) => void): Promise<LaunchRun> {
  // T-525: the spawn boundary itself refuses a signed-in launch, whatever entry point reached it: by the run's
  // options, and (G1) by the Launch's own isolation, so fresh options cannot carry a signed-in Launch through.
  refuseSignedInLaunch(o);
  refuseLaunchIsolation(o, launch);
  const spawnFn = deps.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  const now = deps.now ?? Date.now;
  const signals: SignalSource = deps.signals ?? process;
  const outStream = createWriteStream(files.transcript, { flags: "a" });
  const errStream = createWriteStream(files.stderr, { flags: "a" });
  const streamErrors: string[] = [];
  outStream.on("error", (e) => streamErrors.push(`transcript: ${e.message}`));
  errStream.on("error", (e) => streamErrors.push(`stderr: ${e.message}`));
  const started = now();
  const kill: { kind: KillKind } = { kind: null };

  const child = spawnFn("claude", launch.args, { cwd: launch.dirs.work, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  // ISS-1494: the group's handle lives beside the child and is settled on every way out, after the last intended signal, so its gone-watch never outlives the run.
  const handle = groupHandle(child, true);
  try {
    const killGroup = (sig: NodeJS.Signals): void => {
      signalGroup(child, sig);
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // An operator signal always wins the classification, also during a timeout's or a policy stop's grace period:
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

    let inputError: string | null = null;
    let inputEnded = false;
    const stdin = child.stdin;
    stdin?.on("error", (e: NodeJS.ErrnoException) => { inputError ??= e.code ?? e.message; });
    const writeIn = (text: string, done?: (err: Error | null | undefined) => void): boolean => {
      if (!stdin || inputEnded || stdin.destroyed || stdin.writableEnded) return false;
      try { stdin.write(text, done); return true; } catch (e) { inputError ??= (e as NodeJS.ErrnoException).code ?? (e as Error).message; return false; }
    };
    // G6: the prompt counts as delivered only when its write completed with no input error before the first result.
    // The write callback sets it; the cast keeps the type checker from narrowing it to its first value.
    let promptAck = "pending" as "pending" | "ok" | "error";
    let deliveredAtResult: boolean | null = null;
    const endInput = (): void => { if (inputEnded) return; inputEnded = true; try { stdin?.end(); } catch { /* already closed */ } };

    let settled = false;
    let resultSeen = false;
    const answers = new Map<string, { subtype: string; response?: unknown; error?: unknown }>();
    const waiters = new Map<string, (r: { subtype: string; response?: unknown; error?: unknown } | null) => void>();
    // E3: with a pinned provenance, a fresh nonce per turn names this turn's readback ids (B2), and the first
    // provenance problem latches a stop that no later cause outranks (B4, K1).
    const provenance = launch.expected.provenance;
    const nonce = provenance === undefined ? null : randomBytes(6).toString("hex");
    let provenanceStop: string | null = null;
    let promptWritten = false;
    let initCount = 0;
    let readbackInit: Record<string, unknown> | null = null;
    /** B2: the ids this turn's readback has written and not yet seen answered. */
    const issued = new Set<string>();
    const latch = (code: string): void => {
      if (provenanceStop !== null) return;
      provenanceStop = code;
      if (!settled) escalate("policy-stop");
    };
    const line = (text: string, complete: boolean): void => {
      let v: unknown = null;
      try { v = JSON.parse(text); } catch { /* not JSON: kept as it came */ }
      const ev = v as { type?: unknown; subtype?: unknown; response?: { request_id?: unknown; subtype?: unknown; response?: unknown; error?: unknown } } | null;
      if (complete && ev !== null && typeof ev === "object" && ev.type === "control_response") {
        const r = ev.response;
        const id = typeof r?.request_id === "string" ? r.request_id : null;
        const answer = { subtype: String(r?.subtype), response: r?.response, error: r?.error };
        if (nonce !== null) {
          // B2, K1: only an id issued and still awaited is an answer; a replay, a future id, a duplicate or an unknown
          // id, before or after the prompt, latches the stop and the turn is discarded.
          if (id === null || !issued.delete(id)) { latch(`readback.unsolicited: ${id === null ? "no request id" : JSON.stringify(id.slice(0, 64))}`); return; }
          answers.set(id, answer);
          waiters.get(id)?.(answer);
          return;
        }
        if (id === null || answers.has(id)) return;
        answers.set(id, answer);
        waiters.get(id)?.(answer);
        return;
      }
      outStream.write(complete ? `${text}\n` : text);
      onLine(text);
      if (provenance !== undefined && complete && ev !== null && typeof ev === "object" && ev.type === "system" && ev.subtype === "init") {
        // B4: each init is checked on arrival: a second one, one that contradicts this turn's readback, then the pin.
        initCount++;
        const init = ev as unknown as Record<string, unknown>;
        if (initCount > 1) latch("init.duplicate");
        else if (initContradicts(init, readbackInit)) latch("init.contradiction");
        else { const bad = initProvenanceProblems(init, provenance); if (bad.length > 0) latch(bad[0]!); }
      }
      if (ev !== null && typeof ev === "object" && ev.type === "result" && !resultSeen) {
        if (provenance !== undefined && promptWritten && initCount === 0) latch("init.missing");
        deliveredAtResult = promptAck === "ok" && inputError === null;
        resultSeen = true; endInput();
      }
    };
    // One decoder per stream: a character split across two chunks is joined, never replaced.
    const outText = new StringDecoder("utf-8");
    let pending = "";
    child.stdout?.on("data", (d: Buffer) => {
      pending += outText.write(d);
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) { const l = pending.slice(0, nl); pending = pending.slice(nl + 1); line(l, true); }
    });
    child.stderr?.on("data", (d: Buffer) => errStream.write(d));
    const exitP = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((res) => {
      child.on("error", (error) => res({ code: null, signal: null, error }));
      child.on("close", (code, signal) => res({ code, signal }));
    }).then((x) => { settled = true; for (const w of waiters.values()) w(null); return x; });

    let launchFailure: string | null = null;
    let readbackIncomplete = false;
    let rb: { readonly steps: readonly ReadbackStep[]; readonly problems: readonly string[] } = { steps: [], problems: [] };
    let exit: { code: number | null; signal: NodeJS.Signals | null; error?: Error };
    try {
      const io: ReadbackIo = {
        write: (l) => {
          if (nonce !== null) { const id = (JSON.parse(l) as { request_id?: unknown }).request_id; if (typeof id === "string") issued.add(id); }
          writeIn(l);
        },
        response: (id, ms) => new Promise((done) => {
          const got = answers.get(id);
          if (got !== undefined) { done(got); return; }
          if (settled) { done(null); return; }
          const t = setTimeout(() => { waiters.delete(id); done(null); }, ms);
          waiters.set(id, (r) => { clearTimeout(t); waiters.delete(id); done(r); });
        }),
      };
      // C1, K3: the client's group is journalled before the readback and the prompt; a failed record stops the turn.
      if (deps.onGroup !== undefined) { try { await deps.onGroup(child.pid ?? 0); } catch (e) { latch(`home.group-record: ${(e as Error).message}`); } }
      const rbx = readbackExpected(launch.expected, launch.options, { ...(nonce === null ? {} : { nonce }), signedIn: launch.isolation === "signed-in" });
      rb = await claudeReadback(io, rbx, deps.readbackTimeoutMs ?? READBACK_TIMEOUT_MS);
      // C-F3: the readback is persisted at the point it is known, before the prompt, so recovery recomputes it.
      if (deps.onReadback !== undefined) { try { await deps.onReadback({ expected: rbx, steps: rb.steps }); } catch (e) { latch(`readback.record: ${(e as Error).message}`); } }
      const first = rb.steps[0];
      readbackInit = first?.subtype === "initialize" && first.outcome === "success" && first.response !== null && typeof first.response === "object" ? first.response as Record<string, unknown> : null;
      // B-F1: a provenance problem in the readback (listing, version, memory, freshness) latches the stop first.
      if (provenance !== undefined || launch.isolation === "signed-in") { const p = rb.problems.find(isProvenanceProblem); if (p !== undefined) latch(p); }
      const complete = rb.steps.length === READBACK_REQUESTS.length && rb.steps.every((s) => s.outcome === "success");
      if (rb.problems.length > 0) {
        // A wrong answer is the policy's; a missing one is the policy's only while the child was still running and
        // nothing else had ended it. Otherwise the cause that ended it keeps its class and the readback is incomplete.
        if (complete || (!settled && kill.kind === null)) {
          launchFailure = rb.problems[0]!;
          if (!settled) escalate("policy-stop");
        } else {
          readbackIncomplete = true;
        }
      } else if (!settled && !resultSeen && inputError === null && kill.kind === null && provenanceStop === null) {
        promptWritten = writeIn(userMessage(prompt), (err) => {
          if (err) { promptAck = "error"; inputError ??= (err as NodeJS.ErrnoException).code ?? err.message; } else if (promptAck === "pending") promptAck = "ok";
        });
      }
      exit = await exitP;
    } finally {
      clearTimeout(termTimer); if (killTimer) clearTimeout(killTimer);
      clearInterval(loadTimer);
      signals.off("SIGINT", onSignal); signals.off("SIGTERM", onSignal);
      if (!settled && child.exitCode === null && child.signalCode === null) killGroup("SIGKILL");
    }
    takeSample();
    pending += outText.end();
    if (pending !== "") line(pending, false);
    await new Promise<void>((r) => outStream.end(r));
    await new Promise<void>((r) => errStream.end(r));
    if (exit.signal === "SIGKILL" && kill.kind === null) kill.kind = "external-kill";
    // B4: a prompt written with no init by the exit is init.missing; the group is already gone, so nothing is signalled.
    if (provenance !== undefined && promptWritten && initCount === 0 && provenanceStop === null) provenanceStop = "init.missing";
    const survivors = child.pid ? pgrep(["-g", String(child.pid)], launch.dirs.work) : "";
    if (survivors) killGroup("SIGKILL");
    // H3: with provenance, the group must be confirmed gone; an unconfirmed cleanup latches its own stop.
    const cleanup = provenance === undefined && deps.onGroup === undefined ? null : await confirmGroupGone(handle, deps.cleanupBoundMs ?? CONFIRM_BOUND_MS);
    if (cleanup === "unconfirmed" && provenanceStop === null) provenanceStop = "cleanup.unconfirmed";
    // G6: delivered when the prompt's write completed cleanly before the first result (or, with no result, at all); an
    // input error that only follows the result (ending the input) changes nothing, and a result never excuses an earlier one.
    const promptDelivered = promptWritten && (deliveredAtResult ?? (promptAck === "ok" && inputError === null));
    return { exit, killKind: kill.kind, started, loadSamples, streamErrors, readback: rb, readbackIncomplete, launchFailure, promptWritten, promptDelivered, inputError, resultSeen, survivors, provenanceStop, cleanup, readbackNonce: nonce };
  } finally {
    handle.settle();
  }
}

/**
 * D6: the class of an attempt that did not deliver its prompt, the first that holds: an operator signal, a spawn
 * failure, a policy stop, the timeout, an external kill; only a child that ended on its own (not signalled, not timed
 * out, not killed) before the prompt was delivered is an input failure. Null when the prompt was delivered.
 */
export function inputFailureOf(r: Pick<LaunchRun, "exit" | "killKind" | "launchFailure" | "promptDelivered" | "inputError" | "resultSeen">): string | null {
  if (r.promptDelivered || r.exit.error || r.launchFailure !== null || r.killKind !== null || r.exit.signal !== null) return null;
  return r.inputError ?? (r.resultSeen ? "a result arrived before the prompt was written" : "the child ended before the prompt was written");
}

/**
 * D6 and D7, after the run: the init event (only under the shared predicate, so a run that failed for another
 * reason is never judged by it) and the result's permission denials, classified by tool. The first problem found
 * is the launch-policy failure; every denial is kept verbatim with its class.
 */
export function postRunPolicy(events: readonly StreamEvent[], launch: Launch, run: Pick<LaunchRun, "exit" | "killKind" | "launchFailure" | "promptDelivered"> & { readonly provenanceStop?: string | null }, inputFailure: string | null, pilot = false): {
  readonly launchFailure: string | null; readonly init: readonly string[]; readonly denials: readonly { readonly denial: unknown; readonly class: "blocked" | "expected" }[];
} {
  const failure = run.exit.error ? `spawn failed: ${run.exit.error.message}` : run.launchFailure !== null ? `launch: ${run.launchFailure}` : inputFailure !== null ? `input: ${inputFailure}`
    : run.killKind === "timeout" ? "timed out" : run.killKind !== null || run.exit.signal !== null ? `killed by ${run.exit.signal ?? run.killKind}` : null;
  const init = run.promptDelivered && initEventConsulted(failure, run.exit.code) ? initEventProblems(events as unknown as Record<string, unknown>[], launch.expected.mcpTools, launch.options) : [];
  const result = events.find((e) => e.type === "result") as { permission_denials?: unknown } | undefined;
  const raw = Array.isArray(result?.permission_denials) ? result!.permission_denials as unknown[] : [];
  const denials = raw.map((d) => ({ denial: d, class: classifyDenial((d ?? {}) as PermissionDenial, launch.roots, pilot) }));
  const blocked = denials.find((d) => d.class === "blocked");
  const blockedName = blocked ? `denied: ${String((blocked.denial as { tool_name?: unknown } | null)?.tool_name ?? "unknown tool")}` : null;
  // B4: a provenance latch outranks every other cause (timeout, signal, exit, input), and no init predicate gates it.
  return { launchFailure: run.provenanceStop ?? run.launchFailure ?? init[0] ?? blockedName, init, denials };
}

/**
 * J3: one opaque form per env value, keyed per run. The same value always maps to the same form within a run, so the
 * stored expected and observed env still compare equal exactly when the raw values did; the key is never written,
 * so a published form says nothing about its value (a LANG, a relative PATH entry) even to a dictionary.
 */
export function envValueMask(key: Buffer = randomBytes(32)): (value: string) => string {
  return (value) => `env-value:${createHmac("sha256", key).update(value).digest("hex").slice(0, 24)}`;
}

const maskEnv = (env: unknown, mask: (v: string) => string): unknown =>
  env !== null && typeof env === "object" && !Array.isArray(env)
    ? Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? mask(v) : v]))
    : env;

/** J3: the readback with every env value the client echoes (mcp_status's server configs) put through the mask. */
export function maskReadbackEnv(steps: readonly ReadbackStep[], mask: (v: string) => string): ReadbackStep[] {
  return steps.map((s) => {
    const r = s.response as { mcpServers?: unknown } | null | undefined;
    if (s.subtype !== "mcp_status" || r === null || typeof r !== "object" || !Array.isArray(r.mcpServers)) return s;
    const mcpServers = r.mcpServers.map((one: unknown) => {
      const o = one as { config?: unknown } | null;
      if (o === null || typeof o !== "object" || o.config === null || typeof o.config !== "object") return one;
      const config = o.config as { env?: unknown };
      return config.env === undefined ? one : { ...o, config: { ...config, env: maskEnv(config.env, mask) } };
    });
    return { ...s, response: { ...r, mcpServers } };
  });
}

/**
 * D8: the launch's evidence, the same for an attempt and the pilot: the exchange and what it was compared against.
 * J3: the expected and the observed env values go through one per-run mask, so neither file carries a raw value.
 */
export function launchEvidence(launch: Launch, run: LaunchRun | null, pre: readonly string[], post: ReturnType<typeof postRunPolicy> | null, mask: (v: string) => string = envValueMask()): { readonly readback: string; readonly launch: string } {
  const expected = readbackExpected(launch.expected, launch.options, { ...(run?.readbackNonce == null ? {} : { nonce: run.readbackNonce }), signedIn: launch.isolation === "signed-in" });
  const readback = {
    steps: maskReadbackEnv(run?.readback.steps ?? [], mask), problems: run?.readback.problems ?? [], incomplete: run?.readbackIncomplete ?? false,
    permissionDenials: post?.denials.map((d) => d.denial) ?? [], denialClasses: post?.denials.map((d) => d.class) ?? [],
  };
  const l = {
    launchPolicy: LAUNCH_POLICY, policyFile: launch.expected.policyFile, policySha256: launch.expected.policySha256, mcpFile: launch.expected.mcpFile, mcpSha256: launch.expected.mcpSha256,
    roots: launch.roots, options: launch.options, argv: launch.args, envNames: Object.keys(launch.env).sort(), mcpTools: launch.expected.mcpTools,
    expected: { ...expected, mcpLaunch: { ...expected.mcpLaunch, ...(expected.mcpLaunch.env === undefined ? {} : { env: maskEnv(expected.mcpLaunch.env, mask) as Record<string, string> }) } },
    problems: { preSpawn: pre, readback: run?.readback.problems ?? [], init: post?.init ?? [], denied: post?.denials.filter((d) => d.class === "blocked").map((d) => d.denial) ?? [] },
    launchFailure: post?.launchFailure ?? pre[0] ?? null,
  };
  return { readback: JSON.stringify(readback, null, 2), launch: JSON.stringify(l, null, 2) };
}

/** The fixture copy for one launch: materialised, a git repository with one commit, validated. */
function prepareWork(arm: 1 | 2 | 3, task: Task, workdir: string): { readonly mat: ReturnType<typeof materialize>; readonly initialHead: string } {
  const mat = materialize(FIXTURE_ROOT, arm, task, workdir);
  if (mat.variant) {
    const v = variantDiscoveryViolations(task, mat.variant);
    if (v.length) throw new Error(`variant check failed: ${v.join("; ")}`);
  }
  gitLocal(workdir, ["init", "-q", "-b", "main"]);
  gitLocal(workdir, ["config", "user.name", "continuity-fixture"]);
  gitLocal(workdir, ["config", "user.email", "fixture@continuity.invalid"]);
  gitLocal(workdir, ["add", "-A"]);
  gitLocal(workdir, ["commit", "-q", "-m", "fixture: initial state"]);
  return { mat, initialHead: gitLocal(workdir, ["rev-parse", "HEAD"]) };
}

/** The experiment's output folder, where experiment.json and the arm's pilot live. */
export const experimentDir = (o: Pick<RunOptions, "out">, pf: Pick<Preflight, "experiment">): string => join(o.out, pf.experiment.slice(0, 12));

/** D9: refuse before anything is spent unless the arm's pilot verifies. */
function requirePilot(o: RunOptions, pf: Preflight): void {
  const p = readPilot(experimentDir(o, pf), { experiment: pf.experiment, arm: o.arm });
  if (!p.ok) throw new LaunchPolicyStopError(`continuity-run: arm ${o.arm} has no verified pilot (${p.reason}); run --pilot for this arm first. No attempt was started.`);
}

/**
 * A publisher for the two launch evidence files (D8): one equality-preserving path mapping per launch, shared by
 * both files, then the same publication check as every other artefact.
 */
function mappedPublisher(dirs: LaunchDirs, allowlist: readonly string[]): (text: string) => { readonly text: string; readonly ok: boolean; readonly labels: string[] } {
  const map = pathMapping({ work: dirs.work, tmp: dirs.tmp, config: dirs.config, pkg: PKG_ROOT, home: dirs.home });
  return (text) => {
    const t = map(text);
    const verdict = publicationCheck(t, allowlist, { secrets: RUNNER_SECRETS });
    const shapeBroken = !jsonShapePreserved(text, t);
    return { text: t, ok: verdict.ok && !shapeBroken, labels: [...verdict.blocked.map((b) => b.label), ...(shapeBroken ? ["json-shape"] : [])] };
  };
}

/** B-F8: whether a path is, by lstat, a real directory: present, not a link, a directory. */
export function isRealDirectory(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * B-F8: a guarded run (signed-in, or a pinned provenance) needs --raw-out to exist as a real directory before the
 * run creates anything, so the intent never sits under an ancestor this run made and a crash could lose. Refused
 * before any directory is created and before any spawn. The fresh path still creates --raw-out.
 */
export function refuseGuardedRawOut(o: RunOptions, guarded: boolean): void {
  if (guarded && !isRealDirectory(o.rawOut)) throw new Error(`continuity-run: a guarded run needs --raw-out to exist as a real directory (not a link) before the run; ${o.rawOut} is not one. Refusing; nothing is created.`);
}

export async function runAttempt(o: RunOptions, pf: Preflight, task: Task, repeat: number, attemptNo: number, deps: AttemptDeps = {}): Promise<AttemptOutcome> {
  refuseShared(o);
  // B-F8: before any directory is made. The late check before the spawn covers a provenance attached any other way.
  const rawOutReal = isRealDirectory(o.rawOut);
  refuseGuardedRawOut(o, o.isolation === "signed-in" || deps.provenance !== undefined);
  refuseSignedInLaunch(o);
  requirePilot(o, pf);
  const now = deps.now ?? Date.now;
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
    const workdir = canonicalTemp("continuity-work-");
    const { mat, initialHead } = prepareWork(o.arm, task, workdir);
    await validateClean(workdir);
    cpSync(join(workdir, ".story"), join(rawDir, "ledger.before"), { recursive: true });
    const taskTicket = readFileSync(join(workdir, ".story", "tickets", `${ticketId}.json`), "utf-8");

    const configDir = canonicalTemp("continuity-config-");
    (deps.provision ?? provisionFreshConfig)(configDir);
    cleanup.push(() => rmSync(configDir, { recursive: true, force: true }));
    const cfgBefore = effectiveConfigHash(configDir);
    const sctx = { workdir, home: homedir(), user: userInfo().username, pkgRoot: PKG_ROOT, allowlist: pf.allowlist };
    // A refusal before the spawn: nothing was spent, the record says why, and the matrix stops on the outcome.
    const refuse = async (reasons: string[], why: string, extra: Record<string, unknown>, files: Record<string, string> = {}): Promise<void> => {
      const record = {
        experimentHash: pf.experiment, arm: o.arm, task, repeat, attempt: attemptNo, ticketId, launchPolicy: LAUNCH_POLICY, validity: "invalid", invalidReasons: reasons, inputDrift: { invalidating: [], disclosed: [], errors: {} },
        completion: "not-started", completionReason: why, completed: true, evidenceComplete: false, requiredArtefacts: [], wallMs: 0,
        killKind: null, interrupted: false, rateLimitStop: null, machineLoadStop: null, exitCode: null, exitSignal: null, configDrift: null, launchPolicyFailure: null, ...extra, finishedAt: new Date().toISOString(),
      };
      const recordText = sanitize(JSON.stringify(record, null, 2), sctx).text;
      const recordVerdict = publicationCheck(recordText, pf.allowlist, { secrets: RUNNER_SECRETS });
      if (!recordVerdict.ok) throw new Error(`record.json would publish blocked content (${recordVerdict.blocked.map((b) => b.label).join(",")}); runner bug`);
      for (const [name, text] of Object.entries(files)) await writeAtomic(join(pubDir, name), text);
      await writeAtomic(join(pubDir, "record.json"), recordText);
      const hashes: Record<string, string> = { "record.json": sha256(readFileSync(join(pubDir, "record.json"))) };
      for (const name of Object.keys(files)) hashes[name] = sha256(readFileSync(join(pubDir, name)));
      await writeAtomic(join(pubDir, "artefacts.sha256.json"), JSON.stringify(hashes, null, 2));
      await writeAtomic(join(pubDir, "completed"), `${new Date().toISOString()}\n`);
    };
    const notStarted = (reasons: string[], extra: Partial<AttemptOutcome>): AttemptOutcome => ({
      validity: "invalid", completion: "not-started", interrupted: false, rateLimited: false, machineLoad: false, evidenceComplete: false, inputDrift: { invalidating: [], disclosed: [], errors: {} },
      configDrift: null, launchPolicy: null, inputFailure: null, invalidReasons: reasons, wallMs: 0, exitCode: null, ...extra,
    });
    // ISS-1315: a config that has moved since preflight moved for every attempt after it too. Spawn nothing,
    // record the refusal (not counted toward the retry budget), and let the matrix stop for repair. The record
    // names each file that appeared, changed or went (a plugin inventory written by the client shows here).
    if (cfgBefore.sha256 !== pf.configHash) {
      const drifted = configInventoryDrift(pf.configInventory, cfgBefore.inventory);
      await refuse(["config-drift"], `config drifted since preflight: ${drifted.join(", ") || "inventory hash"}`, { configDrift: drifted });
      return notStarted(["config-drift"], { configDrift: drifted });
    }

    const distBefore = readDist();
    // Drift before the spawn is not an attempt to record: the experiment's build identity no longer holds.
    if (!sameHashes(pf.build.dist, distBefore)) throw new Error(`continuity-run: dist/ changed since preflight (${Object.keys(pf.build.dist).filter((k) => pf.build.dist[k] !== distBefore[k]).join(", ") || "key set"}); rerun preflight`);
    // ISS-1274: the same rule for the hashed inputs. An edit that reaches the cell voids the identity before anything is spent;
    // a plugins-source edit (dist unchanged, checked just above) proceeds and is disclosed on the record.
    const inputsBefore = readInputs();
    const driftBefore = inputDrift(pf.inputHashes, [inputsBefore], true);
    if (driftBefore.invalidating.length) throw new Error(`continuity-run: input tree changed since preflight (${driftBefore.invalidating.join(", ")}); rerun preflight`);

    // D2 to D5: the launch, its files outside both roots, and the checks immediately before the spawn.
    const attemptTmp = canonicalTemp("continuity-tmp-");
    const home = canonicalTemp("continuity-home-");
    const launchDir = canonicalTemp("continuity-launch-");
    for (const d of [attemptTmp, home, launchDir]) cleanup.push(() => rmSync(d, { recursive: true, force: true }));
    const prepared = prepareLaunch({ work: workdir, tmp: attemptTmp, home, config: configDir, launch: launchDir }, { model: o.model, effort: o.effort, maxBudgetUsd: o.maxBudgetUsd, tools: pf.tools, codexBin: pf.codexBin, bundleSha256: pf.build.evalMcpSha256, codex: pf.build });
    const launch = deps.provenance === undefined ? prepared : withTestProvenance(prepared, deps.provenance);
    const mapped = mappedPublisher(launch.dirs, pf.allowlist);
    deps.beforeSpawnCheck?.(launch);
    const pre = launchProblems(launch);
    if (pre.length > 0) {
      const ev = launchEvidence(launch, null, pre, null);
      const files: Record<string, string> = {};
      for (const [name, text] of [["readback.json", ev.readback], ["launch.json", ev.launch]] as const) { const m = mapped(text); if (m.ok) files[name] = m.text; else writeFileSync(join(rawDir, `unpublished.${name}`), text); }
      await refuse(["launch-policy"], `launch policy refused before the spawn: ${pre[0]}`, { launchPolicyFailure: pre[0] }, files);
      return notStarted(["launch-policy"], { launchPolicy: pre[0]! });
    }
    const manifestPre = {
      experimentHash: pf.experiment, arm: o.arm, task, repeat, attempt: attemptNo, ticketId, model: o.model, effort: o.effort, isolation: o.isolation, launchPolicy: LAUNCH_POLICY,
      ownerException: null, timeoutMs: o.timeoutMs, maxBudgetUsd: o.maxBudgetUsd, inputTreeHash: pf.inputTreeHash, buildManifestHash: pf.buildManifestHash,
      inputHashes: pf.inputHashes, taskMaterialHash: pf.taskMaterialHash, taskMaterialHashes: pf.taskMaterialHashes,
      build: pf.build, configHashExpected: pf.configHash, configHashBefore: cfgBefore.sha256, configInventory: cfgBefore.inventory, skillMarker: pf.skillMarker,
      policySha256: launch.expected.policySha256, mcpSha256: launch.expected.mcpSha256,
      variantSha256: mat.variantSha256, overlay: mat.overlay ? basename(mat.overlay) : null,
      rubricVersion: /rubricVersion:\s*(\d+)/.exec(readFileSync(join(FIXTURE_ROOT, "rubric.md"), "utf-8"))?.[1] ?? null, startedAt: new Date().toISOString(),
    };
    writeFileSync(join(rawDir, "manifest.pre.json"), JSON.stringify(manifestPre, null, 2));

    const prompt = `/story auto ${ticketId}`;
    const transcriptPath = join(rawDir, "transcript.jsonl");
    const planCopies: { toolUseId: string; file: string }[] = [];
    // The INITIAL snapshot belongs to the first main-session plan_written call, whether or not its copy succeeds.
    let firstPlanWrittenId: string | null = null;
    let mainPlanWrittenCalls = 0;
    const watcherErrors: string[] = [];
    let sessionDir: string | null = null;
    const plansDir = join(rawDir, "plans");
    mkdirSync(plansDir, { recursive: true });

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
    // B-F2: an unresolved intent is on disk before any provenance-enabled spawn, so a crash at any later point refuses recovery.
    const durable = deps.writeDurable ?? writeDurable;
    const guarded = launch.expected.provenance !== undefined || launch.isolation === "signed-in";
    // C-F3, C-F5: one env mask per attempt for the persisted readback; the intent records the launch's session id and
    // the expectation's hash before the spawn, so recovery checks the evidence against what was known then.
    const envMask = envValueMask();
    const maskX = (x: ReadbackExpected): ReadbackExpected => (x.mcpLaunch.env === undefined ? x : { ...x, mcpLaunch: { ...x.mcpLaunch, env: maskEnv(x.mcpLaunch.env, envMask) as Record<string, string> } });
    const intentFields: IntentRecord = { schema: PROVENANCE_RECORD_SCHEMA, sessionId: launch.session.id, expectedSha256: expectationSha256(maskX(readbackExpected(launch.expected, launch.options, { signedIn: launch.isolation === "signed-in" }))) };
    if (guarded && !rawOutReal) throw new Error(`continuity-run: a guarded run needs --raw-out to exist as a real directory (not a link) before the run; ${o.rawOut} was not one. Refusing before the spawn.`);
    if (guarded) {
      // B-F7: every entry of the raw chain (experiment, task, repeat, attempt) is recorded in its parent before the
      // intent, so a crash cannot leave a durable intent inside a directory recovery never finds.
      for (const d of rawChainParents(o.rawOut, rawDir)) await (deps.fsyncDir ?? fsyncDir)(d);
      await durable(join(rawDir, PROVENANCE_INTENT_FILE), `${JSON.stringify({ state: "unresolved", ...intentFields })}\n`);
    }
    // C1 (W1): the signed-in arm journals the real home; a test journals a fake one. The baseline precedes the spawn.
    const journalHome = launch.isolation === "signed-in" ? realHome() : deps.homeRoot;
    const homeStop = async (code: string): Promise<never> => {
      await durable(join(rawDir, PROVENANCE_STOP_FILE), `${JSON.stringify({ code, cleanup: null, retryable: false }, null, 2)}\n`);
      throw new ProvenanceStopError(`continuity-run: ${task}#${repeat} stopped on the home journal: ${code}. The turn is discarded, not graded and not retried.`);
    };
    if (journalHome !== undefined) {
      try { await journalBefore(rawDir, journalHome, { write: durable }); } catch (e) { if (e instanceof HomeJournalStop) await homeStop(e.code); throw e; }
    }
    const turnDeps: AttemptDeps = {
      ...deps,
      ...(journalHome === undefined ? {} : { onGroup: async (pgid: number) => journalGroup(rawDir, pgid, (deps.startOf ?? startOf)(pgid), { write: durable }) }),
      ...(guarded ? { onReadback: async (r: { readonly expected: ReadbackExpected; readonly steps: readonly ReadbackStep[] }) => durable(join(rawDir, PROVENANCE_READBACK_FILE), `${JSON.stringify({ schema: PROVENANCE_RECORD_SCHEMA, expected: maskX(r.expected), steps: maskReadbackEnv(r.steps, envMask) })}\n`) } : {}),
    };
    const run = await driveClaude(o, launch, prompt, { transcript: transcriptPath, stderr: join(rawDir, "stderr.txt") }, turnDeps, feed);
    // C1 to C3: the terminal inventory after the cleanup check, on success and failure, validated before any grading.
    let journalStop: string | null = null;
    if (journalHome !== undefined) {
      // C-F5: the exception allowlist is the launch's session id alone; the transcript's init events are checked against it.
      const binding = transcriptBinding(readFileSync(transcriptPath, "utf-8"), launch.session.id, false);
      try {
        const v = await journalAfter(rawDir, journalHome, run.cleanup === "confirmed" ? "confirmed" : "unconfirmed", [launch.session.id], { write: durable });
        if (v.length > 0) journalStop = `home.violation: ${v.map((c) => `${c.kind} ${c.rel}`).join(", ")}`;
      } catch (e) { if (e instanceof HomeJournalStop) journalStop = e.code; else throw e; }
      if (binding !== null) journalStop ??= `home.session-binding: ${binding}`;
    }
    if (journalStop !== null && run.provenanceStop === null) await homeStop(journalStop);
    if (guarded && run.provenanceStop === null && run.cleanup === "confirmed") {
      // C-F3: the positive evidence first (after the terminal journal), then the resolution; a crash between them is recoverable.
      await durable(join(rawDir, PROVENANCE_OUTCOME_FILE), `${JSON.stringify({ schema: PROVENANCE_RECORD_SCHEMA, sessionId: launch.session.id, nonce: run.readbackNonce, cleanup: "confirmed", transcriptSha256: sha256(readFileSync(transcriptPath)) })}\n`);
      await durable(join(rawDir, PROVENANCE_INTENT_FILE), `${JSON.stringify({ state: "resolved", ...intentFields })}\n`);
    }
    if (run.provenanceStop !== null) {
      // B4, K1: discarded before any grading, and persisted durably so no re-run resumes past it.
      await durable(join(rawDir, PROVENANCE_STOP_FILE), `${JSON.stringify({ code: run.provenanceStop, cleanup: run.cleanup, retryable: false }, null, 2)}\n`);
      throw new ProvenanceStopError(`continuity-run: ${task}#${repeat} stopped on provenance: ${run.provenanceStop}. The turn is discarded, not graded and not retried.`);
    }
    const { exit, started, loadSamples, streamErrors, survivors } = run;
    const killKind = run.killKind;
    const inputFailure = inputFailureOf(run);
    // A timeout is a behavioural failure under the fixed budget, never an interruption: the observation stands,
    // unless the stream shows it was spent on a rate limit or overload (rateLimitStop, B2).
    const interrupted = killKind === "runner-signal" || killKind === "external-kill";
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
    const post = postRunPolicy(parsed.events, launch, run, inputFailure);
    const launchFailure = post.launchFailure;
    const distAfter = readDist();
    // ISS-1274: rehash after the attempt; drift at either end (or a walk that failed) is drift under the run.
    const inputsAfter = readInputs();
    const drift = inputDrift(pf.inputHashes, [inputsBefore, inputsAfter], sameHashes(pf.build.dist, distBefore) && sameHashes(pf.build.dist, distAfter));
    const cfgAfterAll = effectiveConfigHash(configDir);
    const cfgAfter = cfgAfterAll.sha256;
    // Names, not hashes: a plugin inventory the client wrote during the turn is named here.
    const configDriftAfter = configInventoryDrift(pf.configInventory, cfgAfterAll.inventory);
    const fp = (stateJson?.binaryFingerprint as { sha256?: string } | null | undefined)?.sha256 ?? null;
    const initServers = (usage.initEvent?.mcp_servers as { name?: string; status?: string }[] | undefined) ?? null;
    const limitStop = rateLimitStop(parsed.events);
    const loadStop = machineLoadStop(killKind, [...loadSamples]);
    const v = validity({
      stateBinaryFingerprintSha256: fp, builtMcpSha256: pf.build.dist["dist/mcp.js"] ?? "", toolResults: toolCalls.map((t) => t.result), mainModels: usage.mainModels, pinnedModel: o.model,
      distHashesExpected: pf.build.dist, distHashesBefore: distBefore, distHashesAfter: distAfter, configHashExpected: pf.configHash, configHashBefore: cfgBefore.sha256, configHashAfter: cfgAfter,
      streamCorrupt: parsed.corruptLines > 0 || streamErrors.length > 0 || watcherErrors.length > 0, initMcpServers: initServers, interrupted,
      inputDriftInvalidating: drift.invalidating, rateLimitStop: limitStop, machineLoadStop: loadStop,
      launchPolicy: launchFailure, inputFailure, promptDelivered: run.promptDelivered,
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
    // D8: the launch evidence goes through the equality-preserving mapping instead of the sanitiser, which would
    // collapse two distinct unknown paths into one token and erase a mismatch.
    const launchEv = launchEvidence(launch, run, [], post);
    for (const [name, text] of [["readback.json", launchEv.readback], ["launch.json", launchEv.launch]] as const) {
      const m = mapped(text);
      if (m.ok) { writeFileSync(join(pubDir, name), m.text); published[name] = true; continue; }
      const labels: Record<string, number> = {};
      for (const l of m.labels) labels[l] = (labels[l] ?? 0) + 1;
      (redactionPublic.blockedLabels as Record<string, unknown>)[name] = labels;
      (redactionFull.blocked as Record<string, unknown>)[name] = m.labels;
      writeFileSync(join(rawDir, `unpublished.${name}`), text);
      published[name] = false;
    }
    writeFileSync(join(rawDir, "redaction.full.json"), JSON.stringify(redactionFull, null, 2));
    publish("redaction.json", JSON.stringify(redactionPublic, null, 2));

    // Required evidence follows the observed lifecycle, not what happened to be captured: a session that reported
    // plan_written owes the INITIAL snapshot and the FINAL plan; a session that produced a digest owes the PLAN
    // context. A genuine behavioural failure that never wrote a plan owes neither.
    const required = ["evidence.jsonl", "source.diff", "ledger.changes.json", "reports.json", "handover.md", "usage.json", "manifest.json", "task.json", "load.json", "readback.json", "launch.json"];
    if (usage.firstPlanWrittenToolUseId !== null) required.push("plan.initial.md", "plan.md");
    if (sessionDir && existsSync(join(sessionDir, "context-digest.md"))) required.push("plan-context.md");
    for (const pc of planCopies) if (!required.includes(pc.file)) required.push(pc.file);
    const evidenceComplete = required.every((n) => published[n] === true);
    // The record itself is published through the same checker; a blocked record is a runner bug, not a redaction.
    const record = {
      experimentHash: pf.experiment, arm: o.arm, task, repeat, attempt: attemptNo, ticketId, launchPolicy: LAUNCH_POLICY, validity: v.valid ? "valid" : "invalid", invalidReasons: v.reasons, inputDrift: drift,
      launchPolicyFailure: launchFailure, inputFailure, inputError: run.inputError, promptDelivered: run.promptDelivered, readbackIncomplete: run.readbackIncomplete, configDriftAfter,
      completion: comp.status, completionReason: comp.reason, completed: true, evidenceComplete, requiredArtefacts: required, wallMs, killKind, interrupted, rateLimitStop: limitStop, machineLoadStop: loadStop, exitCode: exit.code, exitSignal: exit.signal,
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
    return { validity: record.validity as "valid" | "invalid", completion: comp.status, interrupted, rateLimited: limitStop !== null, machineLoad: loadStop !== null, evidenceComplete, inputDrift: drift, configDrift: null, launchPolicy: launchFailure, inputFailure, invalidReasons: v.reasons, wallMs, exitCode: exit.code };
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

/** ISS-1486 D7 and D9: a launch-policy failure or a missing pilot; every later attempt would meet the same policy, so the matrix stops (exit 7). */
export class LaunchPolicyStopError extends Error {
  constructor(message: string) { super(message); this.name = "LaunchPolicyStopError"; }
}

/**
 * E3 (B4, K1): a provenance latch. The turn is discarded before any grading, the refusal is persisted beside the
 * attempt, and the matrix never resumes past it: a re-run refuses while that refusal is on disk.
 */
export class ProvenanceStopError extends Error {
  constructor(message: string) { super(message); this.name = "ProvenanceStopError"; }
}

/** E3: the file a provenance stop leaves in the attempt's raw dir. */
export const PROVENANCE_STOP_FILE = "provenance.stop.json";
/** B-F2: written unresolved before a provenance-enabled spawn, resolved only after a clean, confirmed outcome. */
export const PROVENANCE_INTENT_FILE = "provenance.intent.json";
/** C-F3: the readback exchange and its expectation (env values masked), written after the readback and before the prompt. */
export const PROVENANCE_READBACK_FILE = "provenance.readback.json";
/** C-F3: positive evidence of a clean turn, written only after a clean provenance outcome and a clean terminal journal. */
export const PROVENANCE_OUTCOME_FILE = "provenance.outcome.json";
/** C-F3: why a recovery refused (the K2 diagnostic is home.diagnostic.json). */
export const RECOVERY_DIAGNOSTIC_FILE = "provenance.recovery.json";
export const PROVENANCE_RECORD_SCHEMA = 1 as const;
/** C-F5, C-F3: what the intent records before the spawn: the launch's session id and the hash of the readback expectation. */
export interface IntentRecord { readonly schema: typeof PROVENANCE_RECORD_SCHEMA; readonly sessionId: string; readonly expectedSha256: string }
/** Canonical JSON (sorted keys at every level), so a stored expectation hashes as the in-memory one did. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** The expectation's identity without the per-turn nonce (the intent is written before the nonce exists). */
export const expectationSha256 = (x: ReadbackExpected): string => { const { nonce: _n, ...rest } = x; return sha256(canonicalJson(rest)); };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * C-F5: the transcript's init events checked against the session id the launch chose (recorded in the intent). A
 * duplicate, invalid or mismatched init, or a corrupt line, is a refusal; `complete` (recovery) also requires exactly
 * one init, no truncated tail and a terminal result event.
 */
export function transcriptBinding(text: string, sessionId: string, complete: boolean): string | null {
  const parsed = parseStream(text);
  if (parsed.corruptLines > 0) return `the transcript has ${parsed.corruptLines} corrupt line(s)`;
  if (complete && parsed.truncatedTail !== null) return "the transcript ends in a truncated line";
  const inits = parsed.events.filter((ev) => (ev as { type?: unknown }).type === "system" && (ev as { subtype?: unknown }).subtype === "init") as { session_id?: unknown }[];
  if (inits.length > 1) return `${inits.length} init events (one turn has one)`;
  for (const i of inits) {
    if (typeof i.session_id !== "string" || !SESSION_ID.test(i.session_id)) return "an init event carries no valid session id";
    if (i.session_id !== sessionId) return "an init event names a session the launch did not choose";
  }
  if (complete && inits.length !== 1) return "no init event";
  if (complete && !parsed.events.some((ev) => (ev as { type?: unknown }).type === "result")) return "no terminal result event";
  return null;
}

/** Raised when a cell publishes without its evidence: the experiment cannot qualify, so the matrix stops. */
export class EvidenceIncompleteError extends Error {
  constructor(message: string) { super(message); this.name = "EvidenceIncompleteError"; }
}

// --- ISS-1486 D9: the pilot -------------------------------------------------------------------

/** The pilot's fixed challenge: one subagent, five named probes in order, each carrying the run's id and its probe mark. */
export function pilotPrompt(id: string, t: { readonly bashInside: string; readonly bashOutside: string; readonly editOutside: string; readonly editInside: string; readonly port: number }): string {
  return [
    `This is a sandbox pilot, pilot id ${id}`,
    "Do not use any storybloq tool. Start exactly one subagent with the Agent tool and have that subagent, not you, make these five tool calls in this order, one call each.",
    "Each call's input must contain the mark shown for it. A refused call is an expected result: record it and go on to the next.",
    `1. bash-inside: ${t.bashInside}`,
    `   Bash: ${pilotCommand(id, "bash-inside", t.bashInside)}`,
    `2. bash-outside: ${t.bashOutside}`,
    `   Bash: ${pilotCommand(id, "bash-outside", t.bashOutside)}`,
    `3. edit-outside: ${t.editOutside}`,
    `   Edit: create the file with the content "${id} edit-outside" and a newline; mention ${probeMark(id, "edit-outside")} in the call`,
    `4. edit-inside: ${t.editInside}`,
    `   Edit: create the file with the content "${id} edit-inside" and a newline; mention ${probeMark(id, "edit-inside")} in the call`,
    `5. network: ${t.port}`,
    `   Bash: ${pilotCommand(id, "network", t.port)}`,
    "Then stop.",
  ].join("\n");
}

export interface PilotOutcome {
  readonly pass: boolean;
  readonly id: string;
  readonly probes: ReturnType<typeof judgePilot>["probes"];
  readonly problems: readonly string[];
}


/**
 * D9: the same launch as an attempt (D2 to D6) with the challenge prompt, no ticket and no scoring. Judged only
 * from what the runner holds: the transcript, the files, the canary and its own loopback listener. pilot.json and
 * the three evidence files it hashes are written beside experiment.json; the record is never an attempt record.
 */
export async function runPilot(o: RunOptions, pf: Preflight, deps: AttemptDeps = {}): Promise<PilotOutcome> {
  refuseShared(o);
  refuseSignedInLaunch(o);
  const expDir = experimentDir(o, pf);
  const id = `p${randomBytes(8).toString("hex")}`;
  // G7: a fresh raw folder for this invocation, named by its id and created exclusively: a retry never reads or
  // appends to an earlier pilot's transcript.
  const rawDir = join(o.rawOut, pf.experiment.slice(0, 12), "pilot", id);
  mkdirSync(expDir, { recursive: true });
  mkdirSync(dirname(rawDir), { recursive: true });
  mkdirSync(rawDir);
  const problems: string[] = [];
  const cleanup: (() => void)[] = [];
  // K1: every accepted socket is tracked, so one a probe left open cannot hold server.close() forever.
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((sock) => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)); sock.on("data", (d: Buffer) => received.push(d)); sock.on("error", () => { /* the probe's own end */ }); });
  const received: Buffer[] = [];
  try {
    const workdir = canonicalTemp("continuity-pilot-work-");
    prepareWork(o.arm, o.tasks[0] ?? TASKS[0], workdir);
    const configDir = canonicalTemp("continuity-config-");
    (deps.provision ?? provisionFreshConfig)(configDir);
    const outside = canonicalTemp("continuity-pilot-outside-");
    const attemptTmp = canonicalTemp("continuity-tmp-");
    const home = canonicalTemp("continuity-home-");
    const launchDir = canonicalTemp("continuity-launch-");
    for (const d of [configDir, outside, attemptTmp, home, launchDir]) cleanup.push(() => rmSync(d, { recursive: true, force: true }));
    const cfg = effectiveConfigHash(configDir);
    if (cfg.sha256 !== pf.configHash) problems.push(`config drifted since preflight: ${configInventoryDrift(pf.configInventory, cfg.inventory).join(", ") || "inventory hash"}`);
    // G8: the attempt's checks before the spawn: a pilot certifies only the build and inputs preflight hashed.
    const readDist = deps.distHashes ?? distHashes;
    const readInputs = deps.inputHashes ?? inputHashes;
    const distBefore = readDist();
    const distMoved = (seen: Record<string, string>): string => Object.keys({ ...pf.build.dist, ...seen }).filter((k) => pf.build.dist[k] !== seen[k]).sort().join(", ") || "key set";
    if (!sameHashes(pf.build.dist, distBefore)) problems.push(`dist/ changed since preflight before the pilot (${distMoved(distBefore)})`);
    const inputsBefore = readInputs();
    const driftBefore = inputDrift(pf.inputHashes, [inputsBefore], sameHashes(pf.build.dist, distBefore));
    if (driftBefore.invalidating.length) problems.push(`input tree changed since preflight before the pilot (${driftBefore.invalidating.join(", ")})`);
    let distAfter: Record<string, string> | null = null;
    let inputsAfter: InputHashes | null = null;
    let configAfter: string | null = null;

    const canary = join(outside, "canary.txt");
    let canaryBefore: string | null = null;
    try { writeFileSync(canary, `${randomBytes(16).toString("hex")}\n`, { flag: "wx" }); canaryBefore = sha256(readFileSync(canary)); } catch { /* recorded by the judge */ }
    let listenerStarted = false;
    try { await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res()); }); listenerStarted = true; } catch { /* recorded by the judge */ }
    const port = listenerStarted ? (server.address() as AddressInfo).port : 0;
    const paths = {
      "bash-inside": join(workdir, `pilot-${id}-bash.txt`), "bash-outside": join(outside, `pilot-${id}-bash.txt`),
      "edit-outside": join(outside, `pilot-${id}-edit.txt`), "edit-inside": join(workdir, `pilot-${id}-edit.txt`),
    };
    const prompt = pilotPrompt(id, { bashInside: paths["bash-inside"], bashOutside: paths["bash-outside"], editOutside: paths["edit-outside"], editInside: paths["edit-inside"], port });

    const launch = prepareLaunch({ work: workdir, tmp: attemptTmp, home, config: configDir, launch: launchDir }, { model: o.model, effort: o.effort, maxBudgetUsd: o.maxBudgetUsd, tools: pf.tools, codexBin: pf.codexBin, bundleSha256: pf.build.evalMcpSha256, codex: pf.build });
    deps.beforeSpawnCheck?.(launch);
    const pre = launchProblems(launch);
    let run: LaunchRun | null = null;
    let post: ReturnType<typeof postRunPolicy> | null = null;
    let events: StreamEvent[] = [];
    const transcriptPath = join(rawDir, "transcript.jsonl");
    if (pre.length > 0) problems.push(`launch: ${pre[0]}`);
    else if (problems.length === 0) {
      run = await driveClaude(o, launch, prompt, { transcript: transcriptPath, stderr: join(rawDir, "stderr.txt") }, deps, () => { /* judged after the run */ });
      events = parseStream(readFileSync(transcriptPath, "utf-8")).events;
      const inputFailure = inputFailureOf(run);
      post = postRunPolicy(events, launch, run, inputFailure, true);
      if (run.exit.error) problems.push(`spawn failed: ${run.exit.error.message}`);
      if (post.launchFailure !== null) problems.push(`launch: ${post.launchFailure}`);
      if (inputFailure !== null) problems.push(`input: ${inputFailure}`);
      if (run.killKind !== null) problems.push(`ended by ${run.killKind}`);
      if (!run.promptDelivered && inputFailure === null) problems.push("the prompt was not delivered");
      if (run.exit.code !== 0 && !run.exit.error) problems.push(`exit ${String(run.exit.code)}${run.exit.signal ? ` (${run.exit.signal})` : ""}`);
      // G8: the attempt's checks after the run: drift under the pilot, and a config (a plugin inventory) the client wrote.
      distAfter = readDist();
      if (!sameHashes(pf.build.dist, distAfter)) problems.push(`dist/ changed during the pilot (${distMoved(distAfter)})`);
      inputsAfter = readInputs();
      const driftAfter = inputDrift(pf.inputHashes, [inputsAfter], sameHashes(pf.build.dist, distAfter));
      if (driftAfter.invalidating.length) problems.push(`input tree changed during the pilot (${driftAfter.invalidating.join(", ")})`);
      const cfgAfter = effectiveConfigHash(configDir);
      configAfter = cfgAfter.sha256;
      if (cfgAfter.sha256 !== pf.configHash) problems.push(`config changed during the pilot: ${configInventoryDrift(pf.configInventory, cfgAfter.inventory).join(", ") || "inventory hash"}`);
    }

    // The runner's own control connection: a refusal proves something only if the listener was reachable.
    const before = Buffer.concat(received).toString("utf-8");
    let controlOk = false;
    if (listenerStarted) {
      const token = `control-${randomBytes(8).toString("hex")}`;
      await new Promise<void>((done) => { const s = netConnect(port, "127.0.0.1", () => s.end(token)); s.on("error", () => done()); s.on("close", () => done()); });
      for (let i = 0; i < 50 && !controlOk; i++) { controlOk = Buffer.concat(received).toString("utf-8").includes(token); if (!controlOk) await new Promise((r) => setTimeout(r, 20)); }
    }
    // J1: the probe's exact command, a fresh token in place of the id, run by the runner outside the sandbox with the
    // client's own environment (so the same nc on the same PATH): the listener must see the token.
    let outsideOk = false;
    if (listenerStarted && controlOk) outsideOk = await outsideProbe(pilotCommand(`outside-${randomBytes(8).toString("hex")}`, "network", port), workdir, launch.probeEnv, received);
    const contents = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, inspectTarget(p)])) as PilotFacts["contents"];
    const canaryText = inspectTarget(canary);
    const facts: PilotFacts = { id, paths, contents, canaryBefore, canaryAfter: typeof canaryText === "string" ? sha256(canaryText) : null, port, listener: { started: listenerStarted, received: before, controlOk, outsideOk } };
    // G4: everything the runner found before the judge, kept so the reader can recompute the verdict from evidence.
    const runProblems = [...problems];

    // Evidence: one mapping for the transcript and both launch files, so a path keeps one token across them.
    const map = mappedPublisher(launch.dirs, pf.allowlist);
    const ev = launchEvidence(launch, run, pre, post);
    const evidence: Record<string, string> = {};
    const checks: PilotChecks = { distBefore, distAfter, inputsBefore, inputsAfter, configBefore: cfg.sha256, configAfter };
    const factsFile: PilotFactsFile = { experimentHash: pf.experiment, arm: o.arm, id, launchPolicy: LAUNCH_POLICY, facts, runProblems, checks };
    const texts: Record<(typeof PILOT_EVIDENCE)[number], string> = {
      "pilot.transcript.jsonl": existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf-8") : "", "pilot.readback.json": ev.readback, "pilot.launch.json": ev.launch,
      "pilot.facts.json": JSON.stringify(factsFile, null, 2),
    };
    for (const name of PILOT_EVIDENCE) {
      const m = map(texts[name]);
      if (!m.ok) { problems.push(`${name} would publish blocked content (${m.labels.join(", ")})`); writeFileSync(join(rawDir, `unpublished.${name}`), texts[name]); continue; }
      writeFileSync(join(expDir, name), m.text);
      evidence[name] = sha256(readFileSync(join(expDir, name)));
    }
    // G4: the verdict the reader will recompute, from the same evidence values (before publication's path mapping).
    const judged = pilotVerdict(events, factsFile, JSON.parse(ev.launch) as Record<string, unknown>, JSON.parse(ev.readback) as Record<string, unknown>);
    problems.push(...judged.problems.slice(runProblems.length));
    const pass = problems.length === 0 && judged.pass;
    const record = {
      experimentHash: pf.experiment, arm: o.arm, id, pass, launchPolicy: LAUNCH_POLICY, probes: judged.probes, problems,
      policySha256: launch.expected.policySha256, mcpSha256: launch.expected.mcpSha256, evidence, writtenAt: new Date().toISOString(),
    };
    const m = map(JSON.stringify(record, null, 2));
    if (!m.ok) throw new Error(`${PILOT_FILE} would publish blocked content (${m.labels.join(", ")}); runner bug`);
    await writeAtomic(join(expDir, PILOT_FILE), m.text);
    return { pass, id, probes: judged.probes, problems };
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    for (const fn of cleanup.reverse()) { try { fn(); } catch { /* best effort */ } }
  }
}

// --- matrix -------------------------------------------------------------------

export interface AttemptEntry {
  readonly name: string;
  readonly record: { readonly validity: "valid" | "invalid"; readonly experimentHash: string; readonly completed: boolean; readonly evidenceComplete: boolean; readonly task?: string; readonly repeat?: number; readonly invalidReasons?: readonly string[]; readonly completion?: string; readonly launchPolicy?: unknown } | null;
  readonly reason?: string;
}

/** Every allocated attempt directory, each verified by the shared reader (record hash, manifest schema, required artefacts). */
export function readAttempts(cellDir: string): AttemptEntry[] {
  if (!existsSync(cellDir)) return [];
  return readdirSync(cellDir).filter((d) => d.startsWith("attempt-")).map((name): AttemptEntry => {
    const v = verifyAttemptDir(join(cellDir, name));
    if (!v.record) return { name, record: null, reason: v.reason ?? undefined };
    return { name, record: { validity: v.record.validity, experimentHash: v.record.experimentHash, completed: true, evidenceComplete: v.evidenceComplete, task: v.record.task, repeat: v.record.repeat, invalidReasons: v.record.invalidReasons, completion: v.record.completion, launchPolicy: v.record.launchPolicy }, reason: v.reason ?? undefined };
  });
}

export interface MatrixResult {
  readonly qualifying: boolean;
  readonly reason: string;
  readonly summary: string[];
}

type CellRow = { task: string; repeat: number; satisfied: boolean; evidenceComplete: boolean; attempt: string | null };

/**
 * B-F7: the directories whose entries hold the raw chain from rawOut down to the attempt directory: rawOut,
 * experiment, task and repeat, in that order. The attempt directory itself is fsynced by writeDurable.
 */
export function rawChainParents(rawOut: string, rawDir: string): string[] {
  const parts = rawDir.slice(rawOut.length).split("/").filter((x) => x !== "");
  if (!rawDir.startsWith(`${rawOut}/`) || parts.length !== 4) throw new Error(`continuity-run: the attempt's raw directory is not rawOut/<experiment>/<task>/<repeat>/<attempt>: ${rawDir}`);
  return parts.slice(0, 3).reduce((acc, p) => [...acc, join(acc[acc.length - 1]!, p)], [rawOut]);
}

export { readRegularFile };
/** B-F6: the largest intent file the scan reads. */
export const INTENT_MAX_BYTES = 4096;

/** B-F3, B-F6: the reads the provenance-stop scan makes. lstat never follows a link; the intent is read by readIntent. */
export interface StopScanFs {
  lstatSync(p: string): { isDirectory(): boolean; isFile(): boolean };
  readdirSync(p: string): string[];
  readIntent(p: string): string;
}
const STOP_SCAN_FS: StopScanFs = { lstatSync, readdirSync: (p) => readdirSync(p), readIntent: (p) => readRegularFile(p, INTENT_MAX_BYTES) };

/**
 * E3, B-F3: every attempt of this experiment that left a provenance stop or an unresolved intent, as
 * task/repeat/attempt paths. The scan is bounded to the experiment's own tree (rawOut/<experiment>/<task>/
 * <repeat>/<attempt>, three fixed levels, no link followed; the pilot's own subtree is skipped), so another
 * experiment never blocks this one. Only an absent experiment root means "no stops"; any other read error, a
 * non-directory where a directory belongs, or an unreadable intent is thrown, never taken as empty.
 * B-F6: an intent that is a link or a special file is a stop and is never opened; a regular one is read through
 * readRegularFile. The stop file is found by name only and never read.
 */
export function provenanceStops(root: string, fs: StopScanFs = STOP_SCAN_FS): string[] {
  try { if (!fs.lstatSync(root).isDirectory()) throw new Error(`continuity-run: the experiment's raw root is not a directory: ${root}`); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const dirs = (d: string): string[] => fs.readdirSync(d).map((n) => {
    if (!fs.lstatSync(join(d, n)).isDirectory()) throw new Error(`continuity-run: an unexpected entry in the experiment's raw tree: ${join(d, n)}`);
    return n;
  });
  const out: string[] = [];
  for (const task of fs.readdirSync(root).filter((n) => n !== "pilot")) {
    if (!fs.lstatSync(join(root, task)).isDirectory()) throw new Error(`continuity-run: an unexpected entry in the experiment's raw tree: ${join(root, task)}`);
    for (const repeat of dirs(join(root, task))) {
      for (const attempt of dirs(join(root, task, repeat))) {
        const d = join(root, task, repeat, attempt);
        const names = fs.readdirSync(d);
        let intentOpen = false;
        if (names.includes(PROVENANCE_INTENT_FILE)) {
          // B-F6: a link or a special file in the intent's place is a stop, never followed or opened.
          if (!fs.lstatSync(join(d, PROVENANCE_INTENT_FILE)).isFile()) intentOpen = true;
          else {
            const state = (JSON.parse(fs.readIntent(join(d, PROVENANCE_INTENT_FILE))) as { state?: unknown }).state;
            intentOpen = state !== "resolved";
          }
        }
        if (names.includes(PROVENANCE_STOP_FILE) || intentOpen) out.push(`${task}/${repeat}/${attempt}`);
      }
    }
  }
  return out.sort();
}

/** B-F8, test only: the fresh Launch with a pinned provenance, its argv rebuilt from the changed expectation. */
function withTestProvenance(l: Launch, provenance: SignedInProvenance): Launch {
  const expected = { ...l.expected, provenance };
  return { ...l, expected, args: claudeTurnArgs(expected, l.session, l.options) };
}

export async function runMatrix(o: RunOptions, pf: Preflight, deps: AttemptDeps = {}): Promise<MatrixResult> {
  refuseShared(o);
  refuseSignedInLaunch(o);
  // B-F8: the earliest point; nothing has been created yet.
  refuseGuardedRawOut(o, o.isolation === "signed-in" || deps.provenance !== undefined);
  // D9: the pilot is checked before anything is spent; a missing, failed or foreign one starts nothing.
  requirePilot(o, pf);
  const shortExp = pf.experiment.slice(0, 12);
  // E3 (B4, K1): a provenance stop on disk is never resumed past; it needs the operator, not a re-run.
  const stopped = provenanceStops(join(o.rawOut, shortExp), deps.stopScanFs);
  if (stopped.length > 0) throw new ProvenanceStopError(`continuity-run: a provenance stop is recorded (${stopped.join(", ")}); the matrix does not resume past it`);
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
        if (r.launchPolicy !== null) {
          writeExperiment(o, pf, cells, summary, `the launch policy did not hold (${r.launchPolicy}); every later attempt would meet the same policy`);
          throw new LaunchPolicyStopError(`continuity-run: ${task}#${repeat} stopped on the launch policy: ${r.launchPolicy}. The attempt is invalid and not counted; no further attempts started.`);
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
  const expDir = experimentDir(o, pf);
  const q = interruption ? { qualifying: false, shortCells: [], unpublishedCells: [], reason: interruption } : qualifies({ cells, isolation: o.isolation, pilot: readPilot(expDir, { experiment: pf.experiment, arm: o.arm }) });
  mkdirSync(expDir, { recursive: true });
  const text = sanitize(JSON.stringify({ experimentHash: pf.experiment, arm: o.arm, model: o.model, effort: o.effort, isolation: o.isolation, ownerException: null, launchPolicy: LAUNCH_POLICY, inputTreeHash: pf.inputTreeHash, inputHashes: pf.inputHashes, taskMaterialHash: pf.taskMaterialHash, taskMaterialHashes: pf.taskMaterialHashes, buildManifestHash: pf.buildManifestHash, configHash: pf.configHash, build: pf.build, cells, qualification: q, writtenAt: new Date().toISOString() }, null, 2), { workdir: "\0never", home: homedir(), user: userInfo().username, pkgRoot: PKG_ROOT, allowlist: pf.allowlist }).text;
  const verdict = publicationCheck(text, pf.allowlist, { secrets: RUNNER_SECRETS });
  if (!verdict.ok) throw new Error(`experiment.json would publish blocked content (${verdict.blocked.map((b) => b.label).join(",")}); runner bug`);
  writeFileSync(join(expDir, "experiment.json"), text);
  const marker = join(expDir, "QUALIFYING");
  if (q.qualifying) writeFileSync(marker, `${new Date().toISOString()} ${q.reason}\n`);
  else if (existsSync(marker)) rmSync(marker);
  return { qualifying: q.qualifying, reason: q.reason, summary };
}

/** W3 (K2): the real recovery probe: the group probe only (kill(-pgid, 0) through the seam; this module imports no signalling call), and the leader's identity for the diagnostic. */
const REAL_RECOVERY_PROBE: RecoveryProbe = {
  group: (pgid) => { try { processGroupSeams.probe(pgid); return "present"; } catch (e) { const c = (e as NodeJS.ErrnoException).code; return c === "ESRCH" ? "gone" : c ?? String(e); } },
  identity: identityOf,
};

/** C-F4, test seam: the two calls recovery's evidence is read with. Only ENOENT is absence. */
export interface RecoveryFs { readonly lstat: (p: string) => ReturnType<typeof lstatSync>; readonly read: (p: string, max: number) => string }
const RECOVERY_FS: RecoveryFs = { lstat: (p) => lstatSync(p), read: readRegularFile };
const TRANSCRIPT_MAX_BYTES = 256 * 1024 * 1024;
const RECORD_MAX_BYTES = 64 * 1024 * 1024;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * W3: the operator's way out of a crashed guarded attempt; never a spawn, never the matrix. The attempt is named
 * task/repeat/attempt inside --raw-out/<experiment>, every level a real directory (no link, no traversal). It must
 * hold an unresolved intent and no recorded stop (a stop is a result, not a crash, and is never cleared).
 * C-F3: the intent is resolved only on positive, persisted evidence of a clean turn, revalidated against what the
 * intent recorded before the spawn: the clean outcome record (written only after a clean provenance outcome and a
 * clean terminal journal), the transcript it names (hash, complete, one init bound to the launch's session id, a
 * terminal result), the persisted readback recomputed against the recorded expectation, the init checks the live
 * run latches on, and the home journal (K2 when the terminal inventory is missing), bound to that session id alone
 * (C-F5). C-F4: only ENOENT is absence. Every refusal leaves the intent unresolved; past the intent checks it also
 * writes a diagnostic.
 */
export async function recoverAttempt(o: RunOptions, pf: Pick<Preflight, "experiment">, attemptPath: string, deps: Pick<AttemptDeps, "homeRoot" | "writeDurable"> & { readonly recoveryProbe?: RecoveryProbe; readonly recoveryFs?: RecoveryFs } = {}): Promise<void> {
  refuseShared(o);
  const refuse = (why: string): never => { throw new ProvenanceStopError(`continuity-run: --recover ${attemptPath} refused: ${why}`); };
  if (!/^[0-9a-f]{12,64}$/.test(pf.experiment)) refuse("the experiment must be its hex id (the 12-hex short id is enough)");
  const experiment = pf.experiment.slice(0, 12);
  const m = /^(T-\d+)\/(repeat-\d+)\/(attempt-\d{3})$/.exec(attemptPath);
  if (m === null || !TASKS.includes(m[1] as Task)) refuse("the attempt must be <task>/repeat-<n>/attempt-<nnn>");
  const fsx = deps.recoveryFs ?? RECOVERY_FS;
  const stat = (p: string, what: string): ReturnType<typeof lstatSync> | null => {
    try { return fsx.lstat(p); } catch (e) {
      const c = (e as NodeJS.ErrnoException).code;
      if (c === "ENOENT") return null;
      return refuse(`${what} cannot be checked (${c ?? (e as Error).message})`);
    }
  };
  const readJson = (p: string, max: number, what: string): unknown => {
    const st = stat(p, what);
    if (st === null) return refuse(`no ${what}`);
    if (!st.isFile()) return refuse(`${what} is not a regular file`);
    let t: string;
    try { t = fsx.read(p, max); } catch (e) { return refuse(`${what} is unreadable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
    try { return JSON.parse(t); } catch { return refuse(`${what} is not JSON`); }
  };
  const realDir = (p: string): boolean => { const st = stat(p, p); return st !== null && st.isDirectory(); };
  if (!realDir(o.rawOut)) refuse("--raw-out is not a real directory");
  let dir = join(o.rawOut, experiment);
  for (const part of ["", ...m!.slice(1)]) { dir = part === "" ? dir : join(dir, part); if (!realDir(dir)) refuse(`${dir} is not a real directory`); }
  const intentPath = join(dir, PROVENANCE_INTENT_FILE);
  if (stat(intentPath, "the intent") === null) refuse("no unresolved intent: nothing to recover");
  const intent = readJson(intentPath, INTENT_MAX_BYTES, "the intent");
  if (!isRecord(intent)) return refuse("the intent is malformed");
  if (intent.state === "resolved") refuse("the intent is already resolved; recovery is not repeated");
  if (intent.state !== "unresolved") refuse("the intent is malformed");
  if (intent.schema !== PROVENANCE_RECORD_SCHEMA || typeof intent.sessionId !== "string" || !SESSION_ID.test(intent.sessionId) || typeof intent.expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(intent.expectedSha256)) refuse("the intent records no launch session or expectation");
  const fields: IntentRecord = { schema: PROVENANCE_RECORD_SCHEMA, sessionId: intent.sessionId as string, expectedSha256: intent.expectedSha256 as string };
  if (stat(join(dir, PROVENANCE_STOP_FILE), "the provenance stop") !== null) refuse("a provenance stop is recorded; recovery does not clear a stop");
  const home = deps.homeRoot ?? (o.isolation === "signed-in" ? realHome() : undefined);
  if (home === undefined) refuse("no journalled home for this run");
  const durable = deps.writeDurable ?? writeDurable;
  try {
    // C-F3: the clean outcome record: positive evidence, bound to the intent's session.
    const outcome = readJson(join(dir, PROVENANCE_OUTCOME_FILE), RECORD_MAX_BYTES, "clean provenance outcome (the turn ended without one: a latch, or a crash before or during the terminal journal)");
    if (!isRecord(outcome) || outcome.schema !== PROVENANCE_RECORD_SCHEMA || outcome.sessionId !== fields.sessionId || outcome.cleanup !== "confirmed"
      || typeof outcome.transcriptSha256 !== "string" || !(outcome.nonce === null || (typeof outcome.nonce === "string" && /^[0-9a-f]{12}$/.test(outcome.nonce)))) refuse("the outcome record does not match the intent");
    // The transcript it names: the same bytes, complete, one init bound to the launch's session.
    const tPath = join(dir, "transcript.jsonl");
    const tst = stat(tPath, "the transcript");
    if (tst === null || !tst.isFile()) refuse("no transcript");
    let text = "";
    try { text = fsx.read(tPath, TRANSCRIPT_MAX_BYTES); } catch (e) { refuse(`the transcript is unreadable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
    if (sha256(text) !== (outcome as Record<string, unknown>).transcriptSha256) refuse("the transcript is not the one the outcome recorded");
    const binding = transcriptBinding(text, fields.sessionId, true);
    if (binding !== null) refuse(`the transcript is incomplete or unbound: ${binding}`);
    // The persisted readback, recomputed against the expectation the intent recorded.
    const rbr = readJson(join(dir, PROVENANCE_READBACK_FILE), RECORD_MAX_BYTES, "readback record");
    if (!isRecord(rbr) || rbr.schema !== PROVENANCE_RECORD_SCHEMA || !isRecord(rbr.expected) || !Array.isArray(rbr.steps)) return refuse("the readback record is malformed");
    const x = rbr.expected as unknown as ReadbackExpected;
    let xHash = "";
    try { xHash = expectationSha256(x); } catch { refuse("the readback record's expectation is malformed"); }
    if (xHash !== fields.expectedSha256) refuse("the readback record's expectation is not the one the intent recorded");
    if ((x.nonce ?? null) !== (outcome as Record<string, unknown>).nonce) refuse("the readback record's nonce is not the outcome's");
    const steps = rbr.steps as unknown as ReadbackStep[];
    const rp = readbackProblems(steps, x);
    if (rp.length > 0) refuse(`readback: ${rp[0]}`);
    const init = parseStream(text).events.find((ev) => (ev as { type?: unknown }).type === "system" && (ev as { subtype?: unknown }).subtype === "init") as unknown as Record<string, unknown>;
    const first = steps[0];
    const readbackInit = first?.subtype === "initialize" && first.outcome === "success" && isRecord(first.response) ? first.response : null;
    if (initContradicts(init, readbackInit)) refuse("init.contradiction");
    if (x.provenance !== undefined) { const bad = initProvenanceProblems(init, x.provenance); if (bad.length > 0) refuse(bad[0]!); }
    // The home journal, bound to the launch's session alone (K2 when the terminal inventory is missing).
    let v: readonly unknown[] = [];
    try { v = await recoverHomeJournal(dir, home!, [fields.sessionId], deps.recoveryProbe ?? REAL_RECOVERY_PROBE, { write: durable }); } catch (e) { if (e instanceof HomeJournalStop) refuse(e.code + (e.message.includes(": ") ? ` (${e.message.slice(e.message.indexOf(": ") + 2)})` : "")); throw e; }
    if (v.length > 0) refuse(`home.violation: ${v.length} change(s) recorded in home.violations.json`);
  } catch (e) {
    if (!(e instanceof ProvenanceStopError)) throw e;
    try { await durable(join(dir, RECOVERY_DIAGNOSTIC_FILE), `${JSON.stringify({ schema: PROVENANCE_RECORD_SCHEMA, reason: e.message }, null, 2)}\n`); } catch (w) { throw new ProvenanceStopError(`${e.message}; the diagnostic was not written (${(w as Error).message})`); }
    throw e;
  }
  await durable(intentPath, `${JSON.stringify({ state: "resolved", ...fields })}\n`);
}

/** W3: `--recover <task/repeat/attempt> --experiment <12-hex>` alone; never with a run, never a spawn. */
export async function cliRecover(argv: readonly string[], deps: Parameters<typeof recoverAttempt>[3] = {}): Promise<boolean> {
  const i = argv.indexOf("--recover");
  if (i < 0) return false;
  if (argv.includes("--pilot") || argv.includes("--tasks") || argv.includes("--repeats")) throw new Error("continuity-run: --recover is not combined with a run");
  const e = argv.indexOf("--experiment");
  await recoverAttempt(parseArgs(argv.filter((_, k) => k !== i && k !== i + 1 && k !== e && k !== e + 1)), { experiment: e >= 0 ? argv[e + 1] ?? "" : "" }, argv[i + 1] ?? "", deps);
  return true;
}

/** Addendum E5: one attempt's row in the transcript listing. Metadata only: existence and size by lstat, nothing opened. */
export interface TranscriptListing {
  readonly attempt: string;
  readonly intent: "unresolved" | "resolved" | "missing" | "unreadable" | "malformed";
  readonly sessionId: string | null;
  readonly transcripts: readonly { readonly path: string; readonly size: number }[];
  /** <project>/<session id> folders (a client's runtime directory): listed by path only, never opened or read. */
  readonly runtimeDirectories: readonly string[];
  readonly problems: readonly string[];
}
export interface ListingFs {
  readonly lstat: (p: string) => { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; readonly size: number };
  readonly readdir: (p: string) => string[];
  readonly realpath: (p: string) => string;
  readonly readIntent: (p: string, max: number) => string;
}
const LISTING_FS: ListingFs = { lstat: lstatSync, readdir: (p) => readdirSync(p), realpath: (p) => realpathSync(p), readIntent: readRegularFile };

/**
 * Addendum E5: after the matrix, the run's transcripts are listed for the owner; removal is the owner's, never this
 * code's. Walks <rawOut>/<experiment>/<task>/<repeat>/<attempt>, reads each attempt's intent (a raw-dir record, bounded,
 * no follow) for the session id the launch chose, and looks for <home>/.claude/projects/<any>/<id>.jsonl and the
 * <id> folder beside it by lstat alone: a transcript is never opened, a folder is never entered, a link is never
 * followed (it is named as a problem), nothing is deleted. The home is an argument, so a test lists a fake one. Only
 * ENOENT is absence; any other error is named as a problem.
 *
 * Links on the way. The roots (the home, the raw folder, the experiment folder) must be real directories whose real
 * path is the path given, so no component of them is a link; otherwise the whole listing is refused before anything
 * beneath them is touched. <home>/.claude and its projects folder as a link are named and never entered. Every folder
 * that is listed is checked, used, then checked again: lstat, readdir, then its real path must still be the expected
 * one, or that level's entries are discarded and the change is named. The intent is opened no-follow and its
 * descriptor checked as a regular file, and the attempt folder's real path is checked after the read; each project
 * folder's real path is checked after its lookups. Node has no openat, so this narrows the window in which a folder
 * can be swapped for a link but cannot close it; the tool is an operator step run after the matrix, with nothing live.
 */
export function listRunTranscripts(rawOut: string, experiment: string, home: string, fs: ListingFs = LISTING_FS): TranscriptListing[] {
  if (!/^[0-9a-f]{12,64}$/.test(experiment)) throw new Error("continuity-run: --list-transcripts needs the experiment's hex id (12 hex is enough)");
  const kind = (p: string): "dir" | "file" | "link" | "other" | "absent" | `error ${string}` => {
    try { const st = fs.lstat(p); return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other"; } catch (e) {
      const c = (e as NodeJS.ErrnoException).code; return c === "ENOENT" ? "absent" : `error ${c ?? (e as Error).message}`;
    }
  };
  const said = (k: string): string => (k === "link" ? "a link, not followed" : k);
  // null when the folder's real path is still `p`; otherwise what it is now.
  const moved = (p: string): string | null => {
    try { const r = fs.realpath(p); return r === p ? null : `its real path is now ${r}`; } catch (e) { return `its real path cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`; }
  };
  const root = (label: string, p: string): string => {
    const r = resolve(p);
    const k = kind(r);
    if (k !== "dir") throw new Error(`continuity-run: the ${label} ${r} is not a real directory (${said(k)}); nothing listed`);
    const m = moved(r);
    if (m !== null) throw new Error(`continuity-run: the ${label} ${r} is not its own real path (${m}; a component is a link); pass the real path; nothing listed`);
    return r;
  };
  const homeDir = root("home", home);
  const rawDir = root("raw folder", rawOut);
  const expDir = root("experiment folder", join(rawDir, experiment.slice(0, 12)));
  const names = (p: string, re: RegExp): string[] => fs.readdir(p).filter((n) => re.test(n)).sort();
  // The projects folders, each by lstat: a link is never entered.
  const claudeDir = join(homeDir, ".claude");
  const projects = join(claudeDir, "projects");
  const homeProblems: string[] = [];
  let projectDirs: string[] = [];
  const ck = kind(claudeDir);
  const pk = ck === "dir" ? kind(projects) : "absent";
  if (ck !== "dir" && ck !== "absent") homeProblems.push(`${claudeDir} is ${said(ck)}`);
  else if (pk === "dir") {
    for (const n of fs.readdir(projects).sort()) {
      const d = join(projects, n); const k = kind(d);
      if (k === "dir") projectDirs.push(d); else if (k === "link") homeProblems.push(`${d} is a link, not followed`); else if (k.startsWith("error")) homeProblems.push(`${d} cannot be checked (${k.slice(6)})`);
    }
    const m = moved(projects);
    if (m !== null) { projectDirs = []; homeProblems.push(`${projects} changed while it was listed (${m}); its entries are discarded`); }
  } else if (pk !== "absent") homeProblems.push(`${projects} is ${said(pk)}`);
  const out: TranscriptListing[] = [];
  const stray = (attempt: string, problem: string): void => { out.push({ attempt, intent: "missing", sessionId: null, transcripts: [], runtimeDirectories: [], problems: [...homeProblems, problem] }); };
  // Each level: the parent is listed, then its real path is checked again; each child is checked by lstat before it is
  // used. A linked task, repeat or attempt folder is named, never entered; a parent that changed loses its entries.
  const level = (parent: string, re: RegExp, label: string): string[] => {
    const listed = names(parent, re);
    const m = moved(parent);
    if (m !== null) {
      if (label === "") throw new Error(`continuity-run: the experiment folder ${parent} changed while it was listed (${m}); nothing listed`);
      stray(label, `${parent} changed while it was listed (${m}); its entries are discarded`);
      return [];
    }
    const ok: string[] = [];
    for (const n of listed) {
      const k = kind(join(parent, n));
      if (k === "dir") ok.push(n); else stray(label === "" ? n : `${label}/${n}`, `${join(parent, n)} is not a real directory (${said(k)})`);
    }
    return ok;
  };
  for (const task of level(expDir, /^T-\d+$/, "")) {
    for (const repeat of level(join(expDir, task), /^repeat-\d+$/, task)) {
      for (const attempt of level(join(expDir, task, repeat), /^attempt-\d{3}$/, `${task}/${repeat}`)) {
        const label = `${task}/${repeat}/${attempt}`;
        const dir = join(expDir, task, repeat, attempt);
        const problems: string[] = [...homeProblems];
        const ip = join(dir, PROVENANCE_INTENT_FILE);
        const ik = kind(ip);
        let intent: TranscriptListing["intent"] = "missing"; let sessionId: string | null = null;
        if (ik === "file") {
          try {
            const text = fs.readIntent(ip, INTENT_MAX_BYTES);
            const m = moved(dir);
            if (m !== null) { intent = "unreadable"; problems.push(`${dir} changed while the intent was read (${m}); the content is discarded`); } else {
              const v = JSON.parse(text) as Record<string, unknown>;
              if ((v.state === "unresolved" || v.state === "resolved") && typeof v.sessionId === "string" && SESSION_ID.test(v.sessionId)) { intent = v.state; sessionId = v.sessionId; } else intent = "malformed";
            }
          } catch (e) { intent = "unreadable"; problems.push(`the intent is unreadable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
        } else if (ik !== "absent") { intent = "unreadable"; problems.push(`the intent is ${said(ik)}`); }
        const transcripts: { path: string; size: number }[] = [];
        const runtimeDirectories: string[] = [];
        if (sessionId !== null) {
          for (const d of projectDirs) {
            const found: { path: string; size: number }[] = []; const dirs: string[] = []; const named: string[] = [];
            const t = join(d, `${sessionId}.jsonl`);
            try {
              const st = fs.lstat(t);
              if (st.isSymbolicLink()) named.push(`${t} is a link, not followed`);
              else if (st.isFile()) found.push({ path: t, size: st.size });
              else named.push(`${t} is not a regular file`);
            } catch (e) { const c = (e as NodeJS.ErrnoException).code; if (c !== "ENOENT") named.push(`${t} cannot be checked (${c ?? (e as Error).message})`); }
            const rd = join(d, sessionId);
            const rk = kind(rd);
            if (rk === "dir") dirs.push(rd); else if (rk !== "absent") named.push(`${rd} is ${rk === "link" ? "a link, not followed" : rk.startsWith("error") ? `not checkable (${rk.slice(6)})` : "not a directory"}`);
            const m = moved(d);
            if (m !== null) problems.push(`${d} changed while it was checked (${m}); its results are discarded`);
            else { transcripts.push(...found); runtimeDirectories.push(...dirs); problems.push(...named); }
          }
        }
        out.push({ attempt: label, intent, sessionId, transcripts, runtimeDirectories, problems });
      }
    }
  }
  return out;
}

/** Addendum E5: `--list-transcripts --experiment <hex> --home <dir> [--raw-out <dir>]` alone; never with a run or a recovery. */
export function cliListTranscripts(argv: readonly string[], write: (s: string) => void = (s) => { process.stdout.write(s); }, fs: ListingFs = LISTING_FS): boolean {
  if (!argv.includes("--list-transcripts")) return false;
  if (["--pilot", "--tasks", "--repeats", "--recover"].some((f) => argv.includes(f))) throw new Error("continuity-run: --list-transcripts is not combined with a run or a recovery");
  const val = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const home = val("--home");
  if (home === undefined || home === "" || home.startsWith("--")) throw new Error("continuity-run: --list-transcripts needs --home <dir>, named explicitly");
  for (const r of listRunTranscripts(val("--raw-out") ?? DEFAULT_RAW_OUT, val("--experiment") ?? "", home, fs)) write(`${JSON.stringify(r)}\n`);
  return true;
}

async function main(): Promise<void> {
  if (cliListTranscripts(process.argv.slice(2))) process.exit(0);
  if (await cliRecover(process.argv.slice(2))) { process.stdout.write("recovered: the intent is resolved\n"); process.exit(0); }
  const o = parseArgs(process.argv.slice(2));
  const pf = preflight(o);
  process.stdout.write(`experiment ${pf.experiment}\nisolation ${o.isolation}; model ${o.model}; effort ${o.effort}; tasks ${o.tasks.join(",")} x ${o.repeats}\n`);
  if (o.pilot) {
    const p = await runPilot(o, pf);
    process.stdout.write(`${p.probes.map((v) => `${v.probe}: ${v.pass ? "pass" : "FAIL"} (${v.detail})`).join("\n")}\n${p.problems.map((x) => `problem: ${x}`).join("\n")}\npilot: ${p.pass ? "PASS" : "FAIL"}\n`);
    process.exit(p.pass ? 0 : 7);
  }
  const r = await runMatrix(o, pf);
  process.stdout.write(`${r.summary.join("\n")}\nqualifying: ${r.qualifying} (${r.reason})\n`);
  process.exit(r.qualifying ? 0 : 3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof SessionKilledError ? `[${err.kind}] ` : ""}${(err as Error).stack ?? String(err)}\n`);
    process.exit(err instanceof SessionKilledError ? 130 : err instanceof EvidenceIncompleteError ? 4 : err instanceof RateLimitStopError ? 5 : err instanceof MachineLoadStopError ? 6 : err instanceof ConfigDriftStopError || err instanceof LaunchPolicyStopError ? 7 : 1);
  });
}
