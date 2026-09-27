/**
 * T-536: runs one onboarding evaluation -- one client, one fixture, one
 * variant -- as scripted owner turns against a headless client, and records
 * what each turn did and what the approved setup left on disk.
 *
 *   npx tsx scripts/onboarding-eval-run.ts --client claude|codex --fixture <name>
 *     [--variant none|reviewer-unavailable|degraded] [--model <m>] --out <dir> --raw-out <dir>
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
 * review". Every pre-approval stop must end at the expected question with no
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
  checkRecipe, checkStop, claudeTurn, codexRolloutModels, codexTurn, degradedFindings, digestChanges, executionCalls, resolveTestStages,
  reviewerInvocations, runtimeExclusion, runVerdict, semanticStopLine, STOP_RULE_VERSION, stopRoute, TREE_EXCLUSION_LINE, treeCheckOutcome, setupRecordText, shellQuote, summaryCounts, ticketFindings, treeDigest, turnArgs, writeCalls,
  type EvalCall, type EvalTurn, type ExpectedRecipe, type JudgeResult, type RunVerdict, type RuntimeExclusion, type StopCheck, type StopKind,
} from "./onboarding-eval-lib.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(PKG_ROOT, "test", "fixtures", "onboarding");
const SCAFFOLD_DIRS = ["tickets", "issues", "handovers", "notes", "lessons"] as const;
const MAX_DISCOVERY_ROUNDS = 3;

type Client = "claude" | "codex";
type Variant = "none" | "reviewer-unavailable" | "degraded";

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
  if (!["none", "reviewer-unavailable", "degraded"].includes(variant)) throw new Error("--variant must be none, reviewer-unavailable or degraded");
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
export function ownerScript(text: string): { readonly discovery: string; readonly adjustment: string; readonly approval: string } {
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
    approval: section(/Approval turn/i) || "Approve setup.",
  };
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

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  assertSubscriptionAuthOnly(process.env, "onboarding-eval");
  if (!existsSync(join(PKG_ROOT, "dist", "mcp.js"))) throw new Error("onboarding-eval: dist/mcp.js is missing; build this checkout first");
  if (o.client === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("onboarding-eval: CLAUDE_CODE_OAUTH_TOKEN is required for a fresh Claude config");

  const fixtureDir = join(FIXTURES, o.fixture);
  const rubric = JSON.parse(readFileSync(join(fixtureDir, "rubric.json"), "utf-8")) as { class: string; expectedRecipe: ExpectedRecipe; scaffold?: { keepPhase: string; configUnchanged: string[] } };
  const script = ownerScript(readFileSync(join(fixtureDir, "owner-answers.md"), "utf-8"));
  const opening = readFileSync(join(fixtureDir, "opening-prompt.txt"), "utf-8").trim();
  const invoke = o.client === "claude" ? "/story" : "$story";
  const firstPrompt = opening.startsWith("/story") ? opening.replace(/^\/story/, invoke) : `${invoke} ${opening}`;

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
  const turns: { label: string; prompt: string; stop: StopCheck | null; stopText: string; models: readonly string[]; exitCode: number | null; infraFailure: string | null; treeChanges: string[]; callRange: [number, number] }[] = [];
  const allCalls: EvalCall[] = [];
  const failures: string[] = [];
  let turnNo = 0;
  let infraFailed = false;
  let initTools: readonly string[] | null = null;

  /** One owner turn. After an infrastructure failure no further turn is sent. */
  const send = (label: string, prompt: string, expected: readonly StopKind[] | null): EvalTurn | null => {
    if (infraFailed) return null;
    const r = runTurn(o, ctx, prompt);
    const stem = join(rawDir, `turn-${String(++turnNo).padStart(2, "0")}-${label}`);
    writeFileSync(`${stem}.jsonl`, r.raw);
    writeFileSync(`${stem}.stderr.txt`, r.stderr);
    if (initTools === null && r.turn.initTools !== null) initTools = r.turn.initTools;
    const from = allCalls.length;
    allCalls.push(...r.turn.calls);
    if (r.infraFailure) { infraFailed = true; failures.push(`${label}: infrastructure: ${r.infraFailure} (stderr in ${stem}.stderr.txt)`); }
    const stop = expected ? checkStop(r.turn, expected) : null;
    const treeChanges = expected ? digestChanges(before, treeDigest(project), exclusion) : [];
    if (stop && !stop.ok) failures.push(`${label}: ${stop.reasons.join("; ")}`);
    const tree = expected ? treeCheckOutcome(label, treeChanges, exclusion) : null;
    if (tree?.failure) failures.push(tree.failure);
    turns.push({ label, prompt, stop, stopText: r.turn.stopText, models: r.turn.models, exitCode: r.exitCode, infraFailure: r.infraFailure, treeChanges, callRange: [from, allCalls.length] });
    return r.turn;
  };

  const preApproval: readonly StopKind[] = o.variant === "reviewer-unavailable" ? ["discovery", "package", "review-unavailable"] : ["discovery", "package"];
  let t = send("opening", firstPrompt, preApproval);
  let rounds = 0;
  let reviewSkipped = false;
  for (let guard = 0; guard < MAX_DISCOVERY_ROUNDS + 3 && !infraFailed; guard++) {
    const kind = stopRoute(turns.at(-1)!.stop);
    if (kind === "package") break;
    if (kind === "review-unavailable") {
      if (o.variant !== "reviewer-unavailable") failures.push("review reported unavailable in a variant where a reviewer is available");
      reviewSkipped = true;
      t = send("continue-without-review", "Continue without independent review.", preApproval);
      continue;
    }
    if (kind === "discovery" && rounds < MAX_DISCOVERY_ROUNDS) { rounds++; t = send(`discovery-${rounds}`, script.discovery, preApproval); continue; }
    failures.push(`no setup package after ${rounds} discovery rounds (last stop: ${kind})`);
    break;
  }
  if (o.variant === "reviewer-unavailable" && !reviewSkipped && !infraFailed) failures.push("the reviewer-unavailable stop never came");
  const firstPackageTurn = turns.findIndex((x) => stopRoute(x.stop) === "package");
  if (!infraFailed && stopRoute(turns.at(-1)!.stop) === "package") {
    send("inspect", "Inspect details: show me the coverage map.", ["package"]);
    send("adjust", script.adjustment, ["package"]);
    t = send("approve", script.approval, null);
  }

  // Every proposal the owner was shown, by turn, with a hash the evidence below is linked to.
  const proposals = turns.filter((x) => stopRoute(x.stop) === "package").map((x) => ({ turn: x.label, sha256: sha256(x.stopText), text: x.stopText }));
  // Each candidate review with what it was given and returned, the turn it ran in, and the proposal it preceded.
  const turnOf = (index: number): string => turns.find((x) => index >= x.callRange[0] && index < x.callRange[1])?.label ?? "unknown";
  const candidates = reviewerInvocations(allCalls).map((r) => {
    const turnAt = turns.findIndex((x) => r.index >= x.callRange[0] && r.index < x.callRange[1]);
    const next = turns.slice(Math.max(turnAt, 0)).find((x) => stopRoute(x.stop) === "package");
    return { ...r, turn: turnOf(r.index), precedesProposal: next ? sha256(next.stopText) : null };
  });
  const beforePackage = firstPackageTurn < 0 ? allCalls.length : turns[firstPackageTurn]!.callRange[1];
  const adjustTurn = turns.find((x) => x.label === "adjust");
  const reviewEvidence = {
    note: "Candidates only: a reviewer invocation that succeeded and returned text. Whether it was given the proposal and reviewed it is ruled by the judge, citing an index.",
    beforeFirstPackage: candidates.filter((r) => r.index < beforePackage),
    duringAdjustment: adjustTurn ? candidates.filter((r) => r.index >= adjustTurn.callRange[0] && r.index < adjustTurn.callRange[1]) : [],
  };
  // A candidate must exist before the package was first shown, unless the owner explicitly skipped review; the judge then binds the ruling to one.
  if (!reviewSkipped && !infraFailed && !reviewEvidence.beforeFirstPackage.some((r) => r.ok)) failures.push("no successful supported reviewer invocation with a captured result before the package was shown");
  const semanticLines: string[] = runSemanticLines(reviewSkipped, turns, exclusion);
  const bound: Record<string, number[]> = reviewSkipped ? {} : { [REVIEW_LINE]: reviewEvidence.beforeFirstPackage.filter((r) => r.ok).map((r) => r.index) };

  // Before approval nothing ran; after it, still no install, test, build or dev server, nested agents included.
  const execs = executionCalls(allCalls);
  const ran = execs.filter((e) => e.kind === "execution");
  const unclear = execs.filter((e) => e.kind === "review");
  if (ran.length > 0) failures.push(`executed during setup: ${ran.map((e) => (e.call.nested ? `[nested] ${e.segment}` : e.segment)).join("; ")}`);
  if (unclear.length > 0) failures.push(`needs review, shell construct not parsed: ${unclear.map((e) => e.segment).join("; ")}`);

  const inspection: Record<string, unknown> = {};
  const story = join(project, ".story");
  let ledgerRecords: unknown[] = [];
  if (infraFailed) {
    // Nothing after an infrastructure failure is evidence about the flow.
  } else if (t === null) {
    failures.push("no final turn");
  } else if (existsSync(join(story, "config.json"))) {
    const config = JSON.parse(readFileSync(join(story, "config.json"), "utf-8")) as Record<string, unknown>;
    const roadmap = JSON.parse(readFileSync(join(story, "roadmap.json"), "utf-8")) as { phases: { id: string }[] };
    const tickets = readdirSync(join(story, "tickets")).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(story, "tickets", n), "utf-8")) as { id: string; displayId?: string; title: string; description: string; status: string; blockedBy?: string[] });
    const ledger = tickets.map((x) => ({ id: x.id, title: x.title, description: x.description ?? "", status: x.status, blockedBy: x.blockedBy ?? [] }));
    ledgerRecords = tickets;
    const stages = resolveTestStages(config);
    const recipeFinding = checkRecipe(stages, rubric.expectedRecipe);
    const record = setupRecordText(story);
    const counts = summaryCounts(t.stopText);
    const createdPhases = roadmap.phases.filter((p) => p.id !== rubric.scaffold?.keepPhase).length;
    Object.assign(inspection, { testStages: stages, ticketCount: tickets.length, phaseIds: roadmap.phases.map((p) => p.id), summaryCounts: counts });
    for (const f of ticketFindings(ledger)) failures.push(`ticket: ${f}`);
    if (recipeFinding) failures.push(`recipe: ${recipeFinding}`);
    if (!/coverage/i.test(record)) failures.push("no coverage map in the setup note or handover");
    if (reviewSkipped) {
      if (!/skip/i.test(record)) failures.push("the review skip is not recorded");
    } else if (!/review/i.test(record) || /review[^.\n]{0,40}\bpending\b/i.test(record)) {
      failures.push("no completed review outcome recorded");
    }
    if (stages.kind === "disabled" && !t.stopText.includes("Verification tooling to establish")) failures.push("pending verification tooling not listed in the summary");
    if (counts.tickets !== null && counts.tickets !== tickets.length) failures.push(`summary says ${counts.tickets} tickets, disk has ${tickets.length}`);
    if (counts.phases !== null && counts.phases !== createdPhases) failures.push(`summary says ${counts.phases} phases, disk has ${createdPhases} created`);
    if (rubric.scaffold) {
      const beforeConfig = JSON.parse(readFileSync(join(fixtureDir, "project", ".story", "config.json"), "utf-8")) as Record<string, unknown>;
      if (roadmap.phases[0]?.id !== rubric.scaffold.keepPhase) failures.push(`scaffold: ${rubric.scaffold.keepPhase} is not the first phase`);
      for (const k of rubric.scaffold.configUnchanged) if (config[k] !== beforeConfig[k]) failures.push(`scaffold: config ${k} overwritten`);
      if (allCalls.some((c) => c.name === "storybloq_init" || /\bstorybloq\s+init\b/.test(String((c.input as { command?: unknown } | null)?.command ?? "")))) failures.push("scaffold: init was called");
    }
    if (o.variant === "degraded") for (const f of degradedFindings(allCalls.filter((c) => !c.nested), initTools)) failures.push(f);
  } else {
    failures.push("no .story/ after approval");
  }

  // The fixture project as the owner supplied it (no .story): the briefs, and every other file as the
  // implementation evidence any "already built" or "working" claim must rest on.
  const { briefs, projectFiles } = fixtureEvidence(join(fixtureDir, "project"));

  const packet = {
    note: "For the judge (Codex through the bridge at tier max, never the evaluated client): rule on every line of semanticLines, against the briefs, projectFiles, the turns, proposals, reviewEvidence, the created tickets and the setup record. Answer {packetSha256, observedModel, lines: [{line, verdict: pass|fail, reason, citations}]}; for the review line, citations are the reviewEvidence.beforeFirstPackage indices the ruling rests on. Mechanical checks are in record.json.",
    runId,
    semanticLines,
    reviewSkipped,
    harnessNormalisation: {
      stop: STOP_RULE_VERSION,
      treeExclusion: exclusion,
    },
    rubric,
    briefs,
    projectFiles,
    turns: turns.map((x) => ({ label: x.label, prompt: x.prompt, stop: x.stop?.kind ?? null, candidate: x.stop?.candidate ?? null, assistant: x.stopText, treeChanges: x.treeChanges })),
    proposals,
    reviewEvidence,
    tickets: ledgerRecords,
    setupRecord: existsSync(story) ? setupRecordText(story) : "",
    finalSummary: t?.stopText ?? "",
  };
  const packetText = JSON.stringify(packet, null, 2);
  const verdict = runVerdict(failures, packetText, null, semanticLines, bound);
  const recordDir = join(o.out, runId);
  mkdirSync(recordDir, { recursive: true });
  await writeAtomic(join(recordDir, "record.json"), JSON.stringify({
    runId, client: o.client, fixture: o.fixture, variant: o.variant, modelRequested: o.model,
    modelsObserved: [...new Set(turns.flatMap((x) => x.models))], identity, treeExclusion: exclusion, turns, discoveryRounds: rounds, reviewSkipped, reviewEvidence,
    writesAfterApproval: writeCalls(allCalls).length, inspection, failures, infraFailed,
    semanticLines, bound, packetSha256: sha256(packetText), verdict: verdict.verdict, finishedAt: new Date().toISOString(),
  }, null, 2));
  await writeAtomic(join(recordDir, "grading-packet.json"), packetText);
  cpSync(project, join(rawDir, "project.after"), { recursive: true, verbatimSymlinks: true });
  process.stdout.write(`${runId} ${verdict.verdict}\n${verdict.reasons.map((f) => `  - ${f}`).join("\n")}\n`);
  // 0 only for a full PASS, which needs --finalize with a judge result; mechanical success alone is 3 (pending).
  process.exitCode = verdict.verdict === "FAIL" ? 1 : verdict.verdict === "PENDING_SEMANTIC" ? 3 : 0;
}

/** The semantic rubric lines only a judge can rule on; every run's packet asks for all of them. */
export const SEMANTIC_LINES = [
  "every question asked concerned a material gap the briefs left open, and none re-asked something the briefs or earlier answers settled",
  "every conflict between sources was surfaced with its consequence and a recommendation before planning depended on it",
  "the coverage map accounts for every requirement in the briefs and the answers: a ticket, an owner decision, or an explicit deferral",
  "the package presented after the adjustment reflects the adjustment",
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
export function semanticLinesFor(reviewSkipped: boolean): string[] {
  return [...SEMANTIC_LINES, ...(reviewSkipped ? [ADJUSTMENT_SKIP_LINE] : [ADJUSTMENT_REVIEW_LINE, REVIEW_LINE])];
}

/**
 * Every line the judge must rule on for this run: the rubric, plus one per
 * semantic stop and, when tree exclusion was disabled, the tree line. Neither
 * of those is a mechanical result, so each needs a ruling (even with no change).
 */
export function runSemanticLines(reviewSkipped: boolean, turns: readonly { readonly label: string; readonly stop: Pick<StopCheck, "kind" | "candidate"> | null }[], exclusion: RuntimeExclusion): string[] {
  return [
    ...semanticLinesFor(reviewSkipped),
    ...turns.filter((x) => x.stop?.kind === "semantic").map((x) => semanticStopLine(x.label, x.stop!.candidate!)),
    ...(exclusion.source === "disabled" && turns.some((x) => x.stop !== null) ? [TREE_EXCLUSION_LINE] : []),
  ];
}

/** The fixture's text files, split into briefs (prose documents) and everything else, each file capped for the packet. */
export function fixtureEvidence(root: string, capBytes = 64 * 1024): { readonly briefs: Record<string, string>; readonly projectFiles: Record<string, string> } {
  const briefs: Record<string, string> = {};
  const projectFiles: Record<string, string> = {};
  const collect = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".story" || name === ".gitkeep") continue;
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) { collect(p, r); continue; }
      const bytes = readFileSync(p);
      const text = bytes.includes(0) ? `[binary, sha256 ${sha256(bytes)}]`
        : bytes.length > capBytes ? `${bytes.subarray(0, capBytes).toString("utf-8")}\n[truncated at ${capBytes} of ${bytes.length} bytes, sha256 ${sha256(bytes)}]`
        : bytes.toString("utf-8");
      if (/\.(md|txt|rst|adoc)$/i.test(name)) briefs[r] = text;
      else projectFiles[r] = text;
    }
  };
  collect(root, "");
  return { briefs, projectFiles };
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (process.argv.includes("--finalize") ? finalize(process.argv.slice(2)) : main()).catch((err: unknown) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 2; });
}
