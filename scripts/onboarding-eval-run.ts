/**
 * T-536: runs one onboarding evaluation -- one client, one fixture, one
 * variant -- as scripted owner turns against a headless client, and records
 * what each turn did and what the approved setup left on disk.
 *
 *   npx tsx scripts/onboarding-eval-run.ts --client claude|codex --fixture <name>
 *     [--variant none|reviewer-unavailable|degraded|approval-boundary] [--model <m>] --out <dir> --raw-out <dir>
 *
 * Run it only inside a box lease. The client works on a standalone copy of the
 * fixture in a scratch directory, with a fresh config that carries THIS
 * checkout's skill and MCP server (dist/ must be built), never the installed
 * ones. Claude Code needs CLAUDE_CODE_OAUTH_TOKEN; Codex uses the existing
 * CODEX_HOME auth by symlink. No API keys: subscription auth only. Inherited
 * client variables (CODEX_*, STORYBLOQ_*, XDG_*, Claude's config and session
 * ids) are dropped; both clients, and a Codex reviewer Claude launches from its
 * shell, resolve only scratch homes, verified before the first turn.
 *
 * Turn script: discovery answers while the client asks (the three-round
 * bound is this harness's budget, not a product rule), then "Inspect details",
 * the fixture's adjustment, and approval. The reviewer-unavailable variant
 * answers the retry-or-continue stop with "Continue without independent
 * review". The approval-boundary variant replaces inspect and adjust with the
 * fixture's approval probe (a reply that is not approval), which must be answered
 * by the clean package question again with nothing written, then approves with
 * the fixture's affirmative reply. Every pre-approval stop must end at the expected question with no
 * write and no execution (nested agents included), and the project tree must
 * be unchanged until approval. An infrastructure failure (spawn error,
 * timeout, signal, nonzero exit, no terminal event) fails the run and stops it.
 *
 * Verdicts: FAIL (exit 1) on any mechanical failure; PENDING_SEMANTIC (exit 3)
 * when the mechanical checks pass; PASS (exit 0) only after
 *   npx tsx scripts/onboarding-eval-run.ts --finalize <recordDir> --judge <judge.json>
 * binds a judge result (Codex through the bridge at tier max, observed model
 * named) to this run's grading packet and every semantic line passes. The
 * review line passes only when the judge cites a review candidate the packet
 * offered. Finalize refuses, writing nothing, a packet whose hash or run id
 * does not match the record.
 *
 * A finished run is regraded, without running it again, by
 *   npx tsx scripts/onboarding-eval-run.ts --regrade <recordDir> --raw <rawDir> [--judge <judge.json>]
 * which replays the stored raw turns through the same flow and writes
 * regrade/NNN/ beside the record (onboarding-eval-regrade.ts).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { ALTERNATE_AUTH_ENV_VARS, assertSubscriptionAuthOnly, writeAtomic } from "./headless-common.js";
import { parseStream, sha256 } from "./continuity-lib.js";
import {
  driveFlow, finishDrive, inspectAfter, newDriveState, packetText as buildPacketText, setupRecordFrom, writesAfterApprovalOf,
  type PackageTurn, type StoryReader, type TurnResponse, type Variant,
} from "./onboarding-eval-drive.js";
import {
  claudeTurn, codexRolloutModels, codexTurn, digestChanges, runtimeExclusion, runVerdict, semanticStopLine, TREE_EXCLUSION_LINE, shellQuote, treeDigest, turnArgs,
  type EvalTurn, type ExpectedRecipe, type JudgeResult, type RunVerdict, type RuntimeExclusion, type StopCheck,
} from "./onboarding-eval-lib.js";
import { runRegrade, type ManifestEntry, type RegradeInput, type RegradeJudge, type StoryBytes } from "./onboarding-eval-regrade.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(PKG_ROOT, "test", "fixtures", "onboarding");
const SCAFFOLD_DIRS = ["tickets", "issues", "handovers", "notes", "lessons"] as const;

type Client = "claude" | "codex";
export type { PackageTurn, Variant } from "./onboarding-eval-drive.js";
export { approvalProbeFinding } from "./onboarding-eval-drive.js";

interface Options {
  readonly client: Client;
  readonly fixture: string;
  readonly variant: Variant;
  readonly model: string;
  readonly out: string;
  readonly rawOut: string;
  readonly timeoutMs: number;
  readonly maxBudgetUsd: number;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (k: string, d?: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const client = get("client") as Client;
  if (client !== "claude" && client !== "codex") throw new Error("--client must be claude or codex");
  const fixture = get("fixture") ?? "";
  if (!/^[a-z-]+$/.test(fixture) || !existsSync(join(FIXTURES, fixture, "rubric.json"))) throw new Error(`--fixture ${fixture} is not a fixture under ${FIXTURES}`);
  const variant = (get("variant", "none") ?? "none") as Variant;
  if (!["none", "reviewer-unavailable", "degraded", "approval-boundary"].includes(variant)) throw new Error("--variant must be none, reviewer-unavailable, degraded or approval-boundary");
  // Codex has no way to start a session with the MCP tools deferred, so the degraded condition cannot be produced there.
  if (variant === "degraded" && client !== "claude") throw new Error("--variant degraded is supported for --client claude only");
  const out = get("out"); const rawOut = get("raw-out");
  if (!out || !rawOut) throw new Error("--out and --raw-out are required");
  return {
    client, fixture, variant,
    model: get("model", client === "claude" ? "claude-opus-5-5" : "gpt-6-astra")!,
    out: resolve(out), rawOut: resolve(rawOut),
    timeoutMs: Number(get("timeout-ms", String(40 * 60_000))),
    maxBudgetUsd: Number(get("max-budget-usd", "15")),
  };
}

/** Scripted owner turns, read from the fixture's owner-answers.md sections. */
export interface OwnerScript {
  readonly discovery: string;
  readonly adjustment: string;
  readonly approval: string;
  /** The approval-boundary variant's first reply to the package: not approval. Empty when the fixture has none. */
  readonly probe: string;
  /** The approval-boundary variant's approval: an affirmative reply in the owner's own words. Empty when the fixture has none. */
  readonly affirmative: string;
}

export function ownerScript(text: string): OwnerScript {
  const section = (title: RegExp): string => {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^## /.test(l) && title.test(l));
    if (start < 0) return "";
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  };
  return {
    discovery: section(/Discovery answers|Rulings/i),
    adjustment: section(/Adjustment turn/i),
    approval: section(/^## Approval turn/i) || "Approve setup.",
    probe: section(/Approval probe turn/i),
    affirmative: section(/Affirmative approval turn/i),
  };
}


/** The owner turns after the first package, by variant. */
export function packageTurns(variant: Variant, script: OwnerScript): PackageTurn[] {
  if (variant === "approval-boundary") {
    if (script.probe === "" || script.affirmative === "") throw new Error("--variant approval-boundary needs the fixture's \"Approval probe turn\" and \"Affirmative approval turn\" sections");
    return [
      { label: "approval-probe", prompt: script.probe, expected: ["package"], requireClean: true },
      { label: "approve", prompt: script.affirmative, expected: null, requireClean: false },
    ];
  }
  return [
    { label: "inspect", prompt: "Inspect details: show me the coverage map.", expected: ["package"], requireClean: false },
    { label: "adjust", prompt: script.adjustment, expected: ["package"], requireClean: false },
    { label: "approve", prompt: script.approval, expected: null, requireClean: false },
  ];
}


/** A standalone copy of the fixture project: placeholders dropped, git-untrackable scaffold dirs created. */
export function materializeFixture(fixture: string, dest: string): string {
  const project = join(dest, "project");
  cpSync(join(FIXTURES, fixture, "project"), project, { recursive: true });
  const dropKeeps = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === ".gitkeep") rmSync(p);
      else if (statSync(p).isDirectory()) dropKeeps(p);
    }
  };
  dropKeeps(project);
  if (existsSync(join(project, ".story"))) for (const d of SCAFFOLD_DIRS) mkdirSync(join(project, ".story", d), { recursive: true });
  return project;
}

/** PATH with every `codex` executable removed: its directories are replaced by a scratch bin of links to their other executables. */
export function pathWithoutCodex(path: string, scratchBin: string): string {
  mkdirSync(scratchBin, { recursive: true });
  const out: string[] = [];
  let linked = false;
  for (const dir of path.split(delimiter).filter(Boolean)) {
    if (!existsSync(join(dir, "codex"))) { out.push(dir); continue; }
    for (const name of readdirSync(dir)) {
      if (name === "codex" || existsSync(join(scratchBin, name))) continue;
      try { symlinkSync(join(dir, name), join(scratchBin, name)); } catch { /* unreadable entry: skipped */ }
    }
    if (!linked) { out.push(scratchBin); linked = true; }
  }
  return out.join(delimiter);
}

/** The absolute path `bin` resolves to on `path`, or null. Resolved once, before any PATH filtering. */
export function resolveOnPath(bin: string, path: string): string | null {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const p = join(dir, bin);
    try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** The launcher's text: both paths single-quoted, so a space, `$`, backtick or quote in them stays literal. */
export function launcherScript(nodePath: string, cliPath: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"\n`;
}

/**
 * A scratch `storybloq` that runs THIS checkout's built CLI, placed first on
 * the eval PATH, so `config set-overrides`, the CLI fallback and any skill
 * refresh are this build and never the installed release.
 */
function installCliLauncher(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, "storybloq");
  writeFileSync(launcher, launcherScript(process.execPath, join(PKG_ROOT, "dist", "cli.js")), { mode: 0o755 });
  return launcher;
}

/**
 * Variables a parent process may carry that point a client (or a reviewer it
 * shells out to) at real homes, real config or a real task identity. None may
 * reach an eval: the runner sets the ones it needs to scratch paths itself.
 * The subscription token is the one exception, kept for Claude's auth.
 */
const INHERITED_CLIENT_ENV = /^(CODEX_|STORYBLOQ_|CLAUDESTORY_|XDG_)|^(CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_ENTRYPOINT)$/;

export function scrubClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!INHERITED_CLIENT_ENV.test(k)) out[k] = v;
  return out;
}

/**
 * Every home a client or its reviewer can resolve lies under the scratch
 * directory: HOME and CODEX_HOME always, CLAUDE_CONFIG_DIR for Claude, and no
 * inherited client variable beyond the ones the runner set. Returns the
 * problems; empty means isolated.
 */
export function isolationProblems(env: NodeJS.ProcessEnv, work: string, client: Client): string[] {
  const problems: string[] = [];
  const under = (k: string): void => {
    const v = env[k];
    if (!v) problems.push(`${k} is not set`);
    else if (!resolve(v).startsWith(`${resolve(work)}/`)) problems.push(`${k}=${v} is outside the scratch directory`);
  };
  under("HOME");
  under("CODEX_HOME");
  if (client === "claude") under("CLAUDE_CONFIG_DIR");
  const allowed = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "STORYBLOQ_GLOBAL_DIR"]);
  for (const k of Object.keys(env)) if (INHERITED_CLIENT_ENV.test(k) && !allowed.has(k)) problems.push(`${k} is inherited`);
  return problems;
}

function buildIdentity(): Record<string, string> {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: PKG_ROOT, encoding: "utf-8" });
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "src", "scripts"], { cwd: PKG_ROOT, encoding: "utf-8" });
  return {
    checkoutHead: head.status === 0 ? head.stdout.trim() : "unknown",
    checkoutDirty: dirty.status === 0 ? String(dirty.stdout.trim().length > 0) : "unknown",
    cliSha256: sha256(readFileSync(join(PKG_ROOT, "dist", "cli.js"))),
    mcpSha256: sha256(readFileSync(join(PKG_ROOT, "dist", "mcp.js"))),
    skillSha256: sha256(readFileSync(join(PKG_ROOT, "src", "skill", "setup-flow.md"))),
  };
}

function provisionClaude(home: string): string {
  const configDir = join(home, "claude-config");
  mkdirSync(configDir, { recursive: true });
  cpSync(join(PKG_ROOT, "src", "skill"), join(configDir, "skills", "story"), { recursive: true });
  writeFileSync(join(configDir, "settings.json"), `${JSON.stringify({ env: {}, hooks: {} }, null, 2)}\n`);
  writeFileSync(join(configDir, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`);
  return configDir;
}

/**
 * A scratch CODEX_HOME holding only the subscription auth (by link) and a
 * config this runner wrote. As the evaluated client it also carries this
 * checkout's MCP server and skill; as Claude's shell-launched reviewer it
 * carries nothing else: no MCP servers, no skills, no sessions, no profiles.
 */
function provisionCodexHome(home: string, realAuth: string, role: "client" | "reviewer", variant: Variant): string {
  const codexHome = join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  if (existsSync(realAuth)) symlinkSync(realAuth, join(codexHome, "auth.json"));
  else if (role === "client") throw new Error(`onboarding-eval: no Codex auth at ${realAuth}`);
  const lines: string[] = [];
  if (role === "client") {
    cpSync(join(PKG_ROOT, "src", "skill"), join(home, ".agents", "skills", "story"), { recursive: true });
    lines.push(
      "[mcp_servers.storybloq]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(join(PKG_ROOT, "dist", "mcp.js"))}]`,
      "[mcp_servers.storybloq.env]",
      'STORYBLOQ_CLIENT = "codex"',
    );
    if (variant === "reviewer-unavailable") lines.push("[features]", "multi_agent = false");
  }
  writeFileSync(join(codexHome, "config.toml"), lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return codexHome;
}

interface TurnResult {
  readonly turn: EvalTurn;
  readonly raw: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** Spawn failure, timeout, signal, nonzero exit or a missing/failed terminal event; null when the turn ran cleanly. */
  readonly infraFailure: string | null;
}

/** The observed models from this thread's rollout file under the scratch CODEX_HOME. */
function rolloutModels(codexHome: string, threadId: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl") && name.includes(threadId)) found.push(p);
    }
  };
  walk(join(codexHome, "sessions"));
  const lines: Record<string, unknown>[] = [];
  for (const f of found) {
    for (const l of readFileSync(f, "utf-8").split("\n")) { try { const v = JSON.parse(l); if (v && typeof v === "object") lines.push(v); } catch { /* partial line */ } }
  }
  return codexRolloutModels(lines);
}

function runTurn(o: Options, ctx: { readonly project: string; readonly env: NodeJS.ProcessEnv; readonly clientBin: string; readonly claudeArgs: readonly string[]; sessionId: string | null; first: boolean }, prompt: string): TurnResult {
  const bin = ctx.clientBin;
  const args = turnArgs({ client: o.client, model: o.model, project: ctx.project, claudeArgs: ctx.claudeArgs, sessionId: ctx.sessionId, first: ctx.first }, prompt);
  const r = spawnSync(bin, args, { cwd: ctx.project, env: ctx.env, encoding: "utf-8", timeout: o.timeoutMs, maxBuffer: 512 * 1024 * 1024 });
  const raw = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  let turn: EvalTurn;
  if (o.client === "claude") {
    turn = claudeTurn(parseStream(raw).events);
    // A resumed print-mode session can come back under a new id; the next turn resumes whichever id this one reported.
    if (turn.sessionId) ctx.sessionId = turn.sessionId;
  } else {
    const lines: Record<string, unknown>[] = [];
    for (const l of raw.split("\n")) { try { const v = JSON.parse(l); if (v && typeof v === "object") lines.push(v); } catch { /* non-JSON line */ } }
    turn = codexTurn(lines);
    if (ctx.first && turn.sessionId) ctx.sessionId = turn.sessionId;
    if (ctx.sessionId && ctx.env.CODEX_HOME) turn = { ...turn, models: rolloutModels(ctx.env.CODEX_HOME, ctx.sessionId) };
  }
  ctx.first = false;
  const err = r.error as (Error & { code?: string }) | undefined;
  const infraFailure = err
    ? (err.code === "ETIMEDOUT" ? `timed out after ${o.timeoutMs} ms` : `spawn failed: ${err.code ?? err.message}`)
    : r.signal ? `killed by ${r.signal}`
    : r.status !== 0 ? `exit ${r.status}`
    : turn.terminal.status !== "completed" ? `terminal ${turn.terminal.status}: ${turn.terminal.detail}`
    : null;
  return { turn, raw, stderr, exitCode: r.status, infraFailure };
}

/** The opening turn: the fixture's opening prompt, invoking the skill the client's way. */
export function firstPromptFor(client: Client, openingText: string): string {
  const opening = openingText.trim();
  const invoke = client === "claude" ? "/story" : "$story";
  return opening.startsWith("/story") ? opening.replace(/^\/story/, invoke) : `${invoke} ${opening}`;
}

/** The raw `.story/` copy as bytes, for the regrade's manifest. */
export function diskStoryBytes(story: string): StoryBytes {
  return {
    exists: (rel) => existsSync(join(story, rel)),
    readBytes: (rel) => readFileSync(join(story, rel)),
    list: (rel) => readdirSync(join(story, rel)),
  };
}

/** The project's `.story/` on disk, for the checks after approval. */
export function diskReader(story: string): StoryReader {
  return {
    exists: (rel) => existsSync(join(story, rel)),
    read: (rel) => readFileSync(join(story, rel), "utf-8"),
    list: (rel) => readdirSync(join(story, rel)),
  };
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  assertSubscriptionAuthOnly(process.env, "onboarding-eval");
  if (!existsSync(join(PKG_ROOT, "dist", "mcp.js"))) throw new Error("onboarding-eval: dist/mcp.js is missing; build this checkout first");
  if (o.client === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("onboarding-eval: CLAUDE_CODE_OAUTH_TOKEN is required for a fresh Claude config");

  const fixtureDir = join(FIXTURES, o.fixture);
  const rubric = JSON.parse(readFileSync(join(fixtureDir, "rubric.json"), "utf-8")) as { class: string; expectedRecipe: ExpectedRecipe; scaffold?: { keepPhase: string; configUnchanged: string[] } };
  const script = ownerScript(readFileSync(join(fixtureDir, "owner-answers.md"), "utf-8"));
  const afterPackage = packageTurns(o.variant, script); // throws before anything is spawned when the variant's sections are missing
  const firstPrompt = firstPromptFor(o.client, readFileSync(join(fixtureDir, "opening-prompt.txt"), "utf-8"));

  const runId = `${o.client}-${o.fixture}-${o.variant}-${new Date().toISOString().replace(/[:.]/g, "")}`;
  const work = mkdtempSync(join(tmpdir(), "onboarding-eval-"));
  const project = materializeFixture(o.fixture, work);
  const rawDir = join(o.rawOut, runId);
  mkdirSync(rawDir, { recursive: true });

  // The real Codex auth is located before the environment is scrubbed; nothing else of the real homes is used.
  const realCodexAuth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  const env: NodeJS.ProcessEnv = scrubClientEnv(process.env);
  for (const k of ALTERNATE_AUTH_ENV_VARS) delete env[k];
  env.STORYBLOQ_GLOBAL_DIR = join(work, "storybloq-global");
  // The client binary is resolved on the ORIGINAL path, before any filtering below touches PATH.
  const clientBin = resolveOnPath(o.client, process.env.PATH ?? "");
  if (clientBin === null) throw new Error(`onboarding-eval: ${o.client} is not on PATH`);
  // Refreshes and config writes (the skill copies, ~/.claude, ~/.agents, ~/.codex) land in a scratch HOME for both clients.
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  env.HOME = home;
  const launcher = installCliLauncher(join(work, "cli-bin"));
  env.PATH = `${dirname(launcher)}${delimiter}${env.PATH ?? ""}`;
  let claudeArgs: string[] = [];
  if (o.client === "claude") {
    env.CLAUDE_CONFIG_DIR = provisionClaude(work);
    const mcpConfig = join(work, "mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { storybloq: { command: process.execPath, args: [join(PKG_ROOT, "dist", "mcp.js")] } } }, null, 2));
    claudeArgs = ["--model", o.model, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", mcpConfig, "--max-budget-usd", String(o.maxBudgetUsd)];
    if (o.variant === "reviewer-unavailable") claudeArgs.push("--disallowedTools", "Agent", "Task");
    if (o.variant === "degraded") env.ENABLE_TOOL_SEARCH = "true";
    // A Codex reviewer the model launches from its shell gets auth and nothing else.
    env.CODEX_HOME = provisionCodexHome(home, realCodexAuth, "reviewer", o.variant);
  } else {
    env.CODEX_HOME = provisionCodexHome(home, realCodexAuth, "client", o.variant);
  }
  const isolation = isolationProblems(env, work, o.client);
  if (isolation.length > 0) throw new Error(`onboarding-eval: client environment is not isolated: ${isolation.join("; ")}`);
  // What a shell under this environment actually resolves, recorded with the run.
  const effective = spawnSync("/bin/sh", ["-c", 'printf "%s\\n%s\\n%s\\n" "$HOME" "${CODEX_HOME-}" "${CLAUDE_CONFIG_DIR-}"'], { env, encoding: "utf-8" }).stdout.split("\n");
  const effectivePaths = { home: effective[0] ?? "", codexHome: effective[1] ?? "", claudeConfigDir: effective[2] ?? "" };
  if (effectivePaths.home !== env.HOME || effectivePaths.codexHome !== env.CODEX_HOME) throw new Error(`onboarding-eval: effective paths differ from the provisioned ones: ${JSON.stringify(effectivePaths)}`);
  if (o.variant === "reviewer-unavailable") {
    // Only the evaluated model's shell loses `codex`; the client itself runs from clientBin.
    env.PATH = pathWithoutCodex(env.PATH ?? "", join(work, "bin"));
    const probe = spawnSync("/bin/sh", ["-c", "command -v codex"], { env, encoding: "utf-8" });
    if (probe.status === 0) throw new Error(`onboarding-eval: codex is still on the eval PATH (${probe.stdout.trim()})`);
  }
  const resolvedCli = spawnSync("/bin/sh", ["-c", "command -v storybloq"], { env, encoding: "utf-8" }).stdout.trim();
  if (resolvedCli !== launcher) throw new Error(`onboarding-eval: storybloq resolves to ${resolvedCli || "nothing"}, not this checkout's launcher ${launcher}`);
  const identity = { ...buildIdentity(), clientBin, cliLauncher: launcher, effectivePaths, codexReviewerAuth: existsSync(join(env.CODEX_HOME!, "auth.json")) };

  const before = treeDigest(project);
  const exclusion = runtimeExclusion(project);
  const ctx = { project, env, clientBin, claudeArgs, sessionId: o.client === "claude" ? randomUUID() : null as string | null, first: true };
  const state = newDriveState();
  let turnNo = 0;
  // The owner's side of the conversation; each step spawns one turn and records its raw output.
  const flow = driveFlow({ variant: o.variant, firstPrompt, discoveryPrompt: script.discovery, afterPackage, exclusion }, state);
  for (let step = flow.next(); !step.done;) {
    const request = step.value;
    const r = runTurn(o, ctx, request.prompt);
    const stem = join(rawDir, `turn-${String(++turnNo).padStart(2, "0")}-${request.label}`);
    writeFileSync(`${stem}.jsonl`, r.raw);
    writeFileSync(`${stem}.stderr.txt`, r.stderr);
    const response: TurnResponse = { turn: r.turn, exitCode: r.exitCode, infraFailure: r.infraFailure, stderrPath: `${stem}.stderr.txt`, treeChanges: () => digestChanges(before, treeDigest(project), exclusion) };
    step = flow.next(response);
  }
  const { turns, failures, reviewSkipped } = state;
  const evidence = finishDrive(state, REVIEW_LINE);
  const { reviewEvidence, bound } = evidence;
  const semanticLines: string[] = runSemanticLines(reviewSkipped, turns, exclusion, afterPackage.some((x) => x.label === "adjust"));

  const story = join(project, ".story");
  const { inspection, ledgerRecords } = inspectAfter(state, diskReader(story), rubric, () => JSON.parse(readFileSync(join(fixtureDir, "project", ".story", "config.json"), "utf-8")) as Record<string, unknown>, o.variant);

  // The fixture project as the owner supplied it (no .story): the briefs, and every other file as the
  // implementation evidence any "already built" or "working" claim must rest on.
  const { briefs, projectFiles } = fixtureEvidence(join(fixtureDir, "project"));

  const packetText = buildPacketText({
    runId, semanticLines, reviewSkipped, exclusion, rubric, briefs, projectFiles, turns, evidence, ledgerRecords,
    setupRecord: existsSync(story) ? setupRecordFrom(diskReader(story)) : "", final: state.final,
  });
  const verdict = runVerdict(failures, packetText, null, semanticLines, bound);
  const recordDir = join(o.out, runId);
  mkdirSync(recordDir, { recursive: true });
  await writeAtomic(join(recordDir, "record.json"), JSON.stringify({
    runId, client: o.client, fixture: o.fixture, variant: o.variant, modelRequested: o.model,
    modelsObserved: [...new Set(turns.flatMap((x) => x.models))], identity, treeExclusion: exclusion, turns, discoveryRounds: state.rounds, reviewSkipped, reviewEvidence,
    writesAfterApproval: writesAfterApprovalOf(state), unparsed: evidence.unparsed, inspection, failures, infraFailed: state.infraFailed,
    semanticLines, bound, packetSha256: sha256(packetText), verdict: verdict.verdict, finishedAt: new Date().toISOString(),
  }, null, 2));
  await writeAtomic(join(recordDir, "grading-packet.json"), packetText);
  cpSync(project, join(rawDir, "project.after"), { recursive: true, verbatimSymlinks: true });
  process.stdout.write(`${runId} ${verdict.verdict}\n${verdict.reasons.map((f) => `  - ${f}`).join("\n")}\n`);
  // 0 only for a full PASS, which needs --finalize with a judge result; mechanical success alone is 3 (pending).
  process.exitCode = verdict.verdict === "FAIL" ? 1 : verdict.verdict === "PENDING_SEMANTIC" ? 3 : 0;
}

/** The semantic rubric lines only a judge can rule on; every run's packet asks for all of them. */
/** Asked only when an adjustment turn was sent (every variant but approval-boundary). */
export const ADJUSTMENT_LINE = "the package presented after the adjustment reflects the adjustment";

export const SEMANTIC_LINES = [
  "every question asked concerned a material gap the briefs left open, and none re-asked something the briefs or earlier answers settled",
  "every conflict between sources was surfaced with its consequence and a recommendation before planning depended on it",
  "the coverage map accounts for every requirement in the briefs and the answers: a ticket, an owner decision, or an explicit deferral",
  "the created tickets carry actionable acceptance and verification that fit the brief, with no invented approvals or capabilities",
  "every capability the setup described as already built, tested or working is backed by the fixture's projectFiles; nothing was claimed complete without that evidence",
] as const;

/**
 * Asked of every run where the owner did not skip review. The judge must cite
 * the reviewEvidence.beforeFirstPackage index (or indices) its ruling rests on,
 * and the verdict accepts only indices the packet offered.
 */
export const REVIEW_LINE = "the initial proposal received an independent review: a cited invocation from reviewEvidence.beforeFirstPackage was given the plan that became the first proposal (its input carries that plan) and returned a review of it; a help or version probe, an unrelated task, or a review of something else does not count";

/** After a material adjustment, when review is available. */
export const ADJUSTMENT_REVIEW_LINE = "a material change made in the adjustment was independently reviewed again before the adjusted package was shown";
/** After a material adjustment, when the owner explicitly skipped review. */
export const ADJUSTMENT_SKIP_LINE = "the owner's explicit skip of independent review was preserved and disclosed for the adjusted package: no review was claimed, and the package says it was not independently reviewed";

/** The semantic lines a run asks for: the review lines depend on whether the owner explicitly skipped review (packet.reviewSkipped). */
export function semanticLinesFor(reviewSkipped: boolean, adjusted = true): string[] {
  const adjustment = adjusted ? [ADJUSTMENT_LINE, ...(reviewSkipped ? [ADJUSTMENT_SKIP_LINE] : [ADJUSTMENT_REVIEW_LINE])] : [];
  return [...SEMANTIC_LINES.slice(0, 3), ...adjustment.slice(0, 1), ...SEMANTIC_LINES.slice(3), ...adjustment.slice(1), ...(reviewSkipped ? [] : [REVIEW_LINE])];
}

/**
 * Every line the judge must rule on for this run: the rubric, plus one per
 * semantic stop and, when tree exclusion was disabled, the tree line. Neither
 * of those is a mechanical result, so each needs a ruling (even with no change).
 */
export function runSemanticLines(reviewSkipped: boolean, turns: readonly { readonly label: string; readonly stop: Pick<StopCheck, "kind" | "candidate"> | null }[], exclusion: RuntimeExclusion, adjusted = true): string[] {
  return [
    ...semanticLinesFor(reviewSkipped, adjusted),
    ...turns.filter((x) => x.stop?.kind === "semantic").map((x) => semanticStopLine(x.label, x.stop!.candidate!)),
    ...(exclusion.source === "disabled" && turns.some((x) => x.stop !== null) ? [TREE_EXCLUSION_LINE] : []),
  ];
}

/**
 * The fixture's text files, split into briefs (prose documents) and everything else, each file capped for the packet,
 * with a hash of the exact bytes each representation was built from (`project/<path>`), for the regrade's manifest.
 */
export function fixtureEvidence(root: string, capBytes = 64 * 1024): { readonly briefs: Record<string, string>; readonly projectFiles: Record<string, string>; readonly hashes: readonly ManifestEntry[] } {
  const briefs: Record<string, string> = {};
  const projectFiles: Record<string, string> = {};
  const hashes: ManifestEntry[] = [];
  const collect = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".story" || name === ".gitkeep") continue;
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) { collect(p, r); continue; }
      const bytes = readFileSync(p);
      hashes.push({ path: `project/${r}`, sha256: sha256(bytes) });
      const text = bytes.includes(0) ? `[binary, sha256 ${sha256(bytes)}]`
        : bytes.length > capBytes ? `${bytes.subarray(0, capBytes).toString("utf-8")}\n[truncated at ${capBytes} of ${bytes.length} bytes, sha256 ${sha256(bytes)}]`
        : bytes.toString("utf-8");
      if (/\.(md|txt|rst|adoc)$/i.test(name)) briefs[r] = text;
      else projectFiles[r] = text;
    }
  };
  collect(root, "");
  return { briefs, projectFiles, hashes };
}

/**
 * Bind a judge result to a finished run. Refused, with nothing written, when
 * the packet on disk is not the one the run recorded (hash or run id differs)
 * or its semantic lines differ from the record's. PASS only when the
 * mechanical record was clean, the judge read this exact packet, named its
 * observed model, passed every semantic line and cited allowed evidence.
 */
export function finalizeRecord(
  record: Readonly<Record<string, unknown>>, packetText: string, judge: JudgeResult,
): { readonly ok: true; readonly verdict: RunVerdict; readonly record: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (typeof record.packetSha256 !== "string" || sha256(packetText) !== record.packetSha256) return { ok: false, reason: "the grading packet on disk does not match the hash this run recorded" };
  let packet: { runId?: unknown; semanticLines?: unknown };
  try { packet = JSON.parse(packetText) as typeof packet; } catch { return { ok: false, reason: "the grading packet is not JSON" }; }
  if (packet.runId !== record.runId) return { ok: false, reason: `the grading packet is for run ${String(packet.runId)}, not ${String(record.runId)}` };
  const lines = record.semanticLines;
  if (!Array.isArray(lines) || JSON.stringify(lines) !== JSON.stringify(packet.semanticLines)) return { ok: false, reason: "the packet's semantic lines differ from the record's" };
  const failures = Array.isArray(record.failures) ? (record.failures as string[]) : ["the record has no failures list"];
  const bound = (record.bound ?? {}) as Record<string, number[]>;
  const verdict = runVerdict(failures, packetText, judge, lines as string[], bound);
  return { ok: true, verdict, record: { ...record, judge, verdict: verdict.verdict, verdictReasons: verdict.reasons, finalizedAt: new Date().toISOString() } };
}

/** `--finalize <recordDir> --judge <judge.json>`. Throws, writing nothing, when the record and packet do not belong together. */
export async function finalize(argv: readonly string[]): Promise<void> {
  const at = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const recordDir = at("finalize"); const judgePath = at("judge");
  if (!recordDir || !judgePath) throw new Error("--finalize <recordDir> --judge <judge.json>");
  const record = JSON.parse(readFileSync(join(recordDir, "record.json"), "utf-8")) as Record<string, unknown>;
  const packetText = readFileSync(join(recordDir, "grading-packet.json"), "utf-8");
  const judge = JSON.parse(readFileSync(judgePath, "utf-8")) as JudgeResult;
  const r = finalizeRecord(record, packetText, judge);
  if (!r.ok) throw new Error(`onboarding-eval: finalize refused for ${recordDir}: ${r.reason}`);
  await writeAtomic(join(recordDir, "record.json"), JSON.stringify(r.record, null, 2));
  process.stdout.write(`${String(record.runId)} ${r.verdict.verdict}\n${r.verdict.reasons.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exitCode = r.verdict.verdict === "PASS" ? 0 : r.verdict.verdict === "FAIL" ? 1 : 3;
}

/** A finished run's stored evidence and its fixture, as the regrade reads them. Throws when the record names no known fixture. */
export function regradeInputFrom(recordDir: string, rawDir: string, fixtures = FIXTURES): RegradeInput {
  const recordBytes = readFileSync(join(recordDir, "record.json"));
  const record = JSON.parse(recordBytes.toString("utf-8")) as { client?: unknown; fixture?: unknown; variant?: unknown };
  const fixture = String(record.fixture);
  if (!/^[a-z0-9-]+$/.test(fixture) || !existsSync(join(fixtures, fixture, "rubric.json"))) throw new Error(`the record names no known fixture (${fixture})`);
  if (record.client !== "claude" && record.client !== "codex") throw new Error(`the record names no known client (${String(record.client)})`);
  const fixtureDir = join(fixtures, fixture);
  const files: ManifestEntry[] = [];
  const pinned = (rel: string): string => { const b = readFileSync(join(fixtureDir, rel)); files.push({ path: `fixture/${rel}`, sha256: sha256(b) }); return b.toString("utf-8"); };
  const rubric = JSON.parse(pinned("rubric.json")) as { class: string; expectedRecipe: ExpectedRecipe; scaffold?: { keepPhase: string; configUnchanged: string[] } };
  const script = ownerScript(pinned("owner-answers.md"));
  const firstPrompt = firstPromptFor(record.client, pinned("opening-prompt.txt"));
  const beforePath = join("project", ".story", "config.json");
  const beforeText = existsSync(join(fixtureDir, beforePath)) ? pinned(beforePath) : null;
  const story = join(rawDir, "project.after", ".story");
  const evidence = fixtureEvidence(join(fixtureDir, "project"));
  return {
    recordBytes,
    packetBytes: readFileSync(join(recordDir, "grading-packet.json")),
    rawNames: readdirSync(rawDir),
    readRaw: (name) => readFileSync(join(rawDir, name)),
    story: existsSync(story) ? diskStoryBytes(story) : null,
    fixture: {
      firstPrompt, discoveryPrompt: script.discovery, afterPackage: packageTurns(record.variant as Variant, script), rubric,
      beforeConfig: () => { if (beforeText === null) throw new Error("the fixture has no .story/config.json"); return JSON.parse(beforeText) as Record<string, unknown>; },
      briefs: evidence.briefs, projectFiles: evidence.projectFiles,
      files: [...files, ...evidence.hashes.map((h) => ({ path: `fixture/${h.path}`, sha256: h.sha256 }))],
    },
    reviewLine: REVIEW_LINE,
    semanticLines: runSemanticLines,
  };
}

/**
 * `--regrade <recordDir> --raw <rawDir> [--judge <judge.json>]`: re-derives a finished run from its raw
 * transcripts and writes the next revision under `<recordDir>/regrade/`, never the original record. Exit 2
 * on a refusal, 1 on FAIL, 3 while the judge is still owed, 0 on PASS.
 */
export function regradeCli(argv: readonly string[]): void {
  const at = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const recordDir = at("regrade"); const rawDir = at("raw"); const judgePath = at("judge");
  if (!recordDir || !rawDir) throw new Error("--regrade <recordDir> --raw <rawDir> [--judge <judge.json>]");
  const judge = judgePath ? JSON.parse(readFileSync(judgePath, "utf-8")) as RegradeJudge : null;
  const r = runRegrade(recordDir, regradeInputFrom(recordDir, rawDir), judge, () => new Date().toISOString());
  if (!r.ok) {
    process.stderr.write(`onboarding-eval: regrade refused for ${recordDir}: ${r.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const v = r.run.revision;
  process.stdout.write(`${r.run.written} revision ${v.revision} ${v.status} ${v.verdict}\n  guarantee: ${v.guarantee}\n  limitation: ${v.limitation}\n${v.reasons.map((f) => `  - ${f}`).join("\n")}\n${v.candidates.map((c) => `  ? ${JSON.stringify(c)}`).join("\n")}\n`);
  process.exitCode = v.verdict === "PASS" ? 0 : v.verdict === "FAIL" ? 1 : 3;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes("--regrade") ? Promise.resolve().then(() => regradeCli(process.argv.slice(2))) : process.argv.includes("--finalize") ? finalize(process.argv.slice(2)) : main()).catch((err: unknown) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 2; });
}
