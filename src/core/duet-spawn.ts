import { chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { discoverProjectRoot, PROJECT_ROOT_ENV_VAR, LEGACY_PROJECT_ROOT_ENV_VAR } from "./project-root-discovery.js";

/**
 * N-131: the pen starts its own duet workers without the developer opening a
 * terminal per worker. The product depends on nothing but the OS: a small
 * launch script lands under `.story/spawn/` (git-ignored by its own
 * `.gitignore`, T-530 / ISS-1289: it used to live under `.story/sessions/`,
 * where the session scanner read it as a state-less session) and the platform
 * launcher opens it in the user's default terminal, a visible window titled
 * with the worker name. The sandboxed Mac app cannot host the PTY, so the
 * window is the OS's, never the app's. Where no launcher exists the exact
 * command is returned for the developer to paste.
 *
 * T-530: the worker's task id is minted BEFORE launch and pinned with
 * `claude --session-id`, the window starts with `/story` as its first prompt,
 * and when the handler has already created the arrangement and started
 * coordination the role carries the handshake facts so the worker sends the
 * nonce to the pen on its own. The pen still records the receipt only after it
 * OBSERVES that echo; nothing here proves the return route.
 */
export interface SpawnHandshake {
  readonly penTaskId: string;
  readonly penClient: "claude";
  readonly arrangementId: string;
  readonly coordinationSessionId: string;
  readonly nonce: string;
}

/**
 * Journal stages, each written BEFORE the effect it announces (T-530 plan D4).
 * Recovery reads the stage as launch evidence only; whether the arrangement or
 * coordination exists is reconciled against the ledger, never inferred here.
 */
export type SpawnStage = "intent" | "created" | "start-attempted" | "started" | "artifacts" | "launch-attempted" | "launched" | "launch-manual";
export const SPAWN_STAGES: readonly SpawnStage[] = ["intent", "created", "start-attempted", "started", "artifacts", "launch-attempted", "launched", "launch-manual"];

export interface SpawnWorkerOptions {
  /** Session display name; the address the pen messages. */
  readonly name: string;
  /** The pen's own session name, written into the worker's role. */
  readonly pen: string;
  /** Model id or alias passed to `claude --model`; absent or empty means the hands tier (`DEFAULT_WORKER_MODEL`), never the client default (ISS-1303). */
  readonly model?: string;
  /** Working directory the worker starts in. Default: the project root. */
  readonly dir?: string;
  /** A role file to use instead of the generated default. */
  readonly role?: string;
  /** macOS only: open with this terminal application instead of the default handler. */
  readonly terminal?: string;
  /**
   * Probe finding (N-131, environment mismatch): a spawned session inherits
   * nothing from the pen and starts in the client's default (prompting) mode,
   * so every tool call it makes waits on the developer and cross-session mail
   * from a bypass pen may be held. Explicit here wins. Absent, the product
   * default is `auto`; it rises to `bypassPermissions` only when the pen
   * itself is found running in bypass (owner ruling, 2026-09-22).
   */
  readonly permissionMode?: string;
  /** The worker's client task id, minted by the handler (`mintWorkerTaskId`); pinned with `claude --session-id`. */
  readonly workerTaskId: string;
  /** Start the window with `/story` as its first prompt. Default true. */
  readonly autoLoad?: boolean;
  /** Handshake facts for the role; present only when the handler created the arrangement and started coordination. */
  readonly handshake?: SpawnHandshake;
  /** T-575 section 10: a manual spawn's generated role carries the handover-line advice. */
  readonly lineAdvice?: boolean;
  /** The pen's project root (where the arrangement lives). */
  readonly penProjectRoot: string;
  /** The worker's working directory, resolved by `resolveWorkerDir`. */
  readonly workerDir: string;
  /** The project root `/story` will find from `workerDir`, or null when none is discoverable. */
  readonly workerProjectRoot: string | null;
  /** The per-invocation directory from `prepareSpawnDir`, already holding the journal. */
  readonly spawnDir: string;
  /** Stage journal writer; the handler supplies one that writes `<spawnDir>/<name>.json` atomically. */
  readonly journal: (stage: SpawnStage, extra?: Record<string, unknown>) => void;
}

export interface SpawnWorkerResult {
  readonly name: string;
  readonly workerTaskId: string;
  readonly scriptPath: string;
  readonly rolePath: string;
  /** "generated", "custom" (used as given), or "custom+handshake" (the custom text plus the handshake section, written beside the script). */
  readonly roleSource: "generated" | "custom" | "custom+handshake";
  /** The exact command the script runs, for pasting where no launcher exists. */
  readonly command: string;
  readonly autoLoad: boolean;
  readonly handshake: SpawnHandshake | null;
  /** The mode actually passed to the worker. */
  readonly permissionMode: string;
  /** How it was chosen: named on the command line, inherited from a bypass pen, or the product default. */
  readonly permissionModeSource: "explicit" | "inherited-bypass" | "default";
  /** The same, as one plain sentence (field feedback, 2026-09-22). */
  readonly permissionModeReason: string;
  /** ISS-1303: the model actually passed to the worker, how it was chosen, and why, as one plain sentence. */
  readonly model: string;
  readonly modelSource: "explicit" | "default";
  readonly modelReason: string;
  /** "opened" when the launcher ran, "printed" when no launcher applies. */
  readonly launch: "opened" | "printed";
  readonly launcher: string | null;
  readonly penProjectRoot: string;
  readonly workerDir: string;
  readonly workerProjectRoot: string | null;
}

/** Reports the pen's own permission mode, or null when it cannot be determined. */
export type PenModeDetector = () => string | null;

export const DEFAULT_WORKER_PERMISSION_MODE = "auto";

/**
 * ISS-1303: a worker left to the client default inherits whatever the
 * developer's session runs, usually the pen's own (most expensive) tier. The
 * hands tier is pinned instead, and the output says it was a default.
 */
export const DEFAULT_WORKER_MODEL = "opus";

export function resolveWorkerModel(explicit: string | undefined): { model: string; source: SpawnWorkerResult["modelSource"] } {
  if (explicit !== undefined && explicit !== "") return { model: explicit, source: "explicit" };
  return { model: DEFAULT_WORKER_MODEL, source: "default" };
}

export function workerModelReason(source: SpawnWorkerResult["modelSource"]): string {
  return source === "explicit" ? "as given on the command line" : "default hands tier; pass --model to pin another";
}

/** One ancestor process: its parent pid and its flattened command line, or null when unreadable. */
export type ProcessReader = (pid: number) => { ppid: number; command: string } | null;

/**
 * Parse `ps -o ppid=,command=` output for one pid. Exactly one nonempty line
 * is accepted; a command line spanning several lines (a newline inside an
 * argument) cannot be classified from its first line alone and is unknown.
 */
export function parsePsLine(out: string): { ppid: number; command: string } | null {
  // Only the line break is stripped: a space that ps printed inside the command
  // is evidence about argument boundaries and the classifier needs it intact.
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length !== 1) return null;
  const m = /^\s*(\d+) (.*)$/.exec(lines[0]!);
  return m ? { ppid: Number(m[1]), command: m[2]! } : null;
}

export const psProcessReader: ProcessReader = (pid) => {
  try {
    return parsePsLine(execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 }));
  } catch {
    return null;
  }
};

/**
 * Boolean Claude Code flags known to take no value. Every other token is
 * unknown: it might be a value-taking option whose value is the next token,
 * so nothing on that line can be trusted (Codex round 3 finding).
 */
const CLAUDE_BOOLEAN_FLAGS = new Set(["-c", "--continue", "--verbose", "--ide", "--chrome", "--no-chrome"]);

/** The token is the Claude Code executable: `claude`, a path to it, or the versioned binary it runs as. */
function isClaudeExecutable(token: string): boolean {
  const base = token.split("/").pop() ?? token;
  return base === "claude" || /\/claude\/versions\/[0-9][0-9A-Za-z.+-]*$/.test(token);
}

/** A node wrapper: `node <path>` where the path is exactly Claude Code's installed cli entry or versioned binary. */
function isClaudeNodeEntry(exe: string, script: string | undefined): boolean {
  const base = exe.split("/").pop() ?? exe;
  if (base !== "node" && !/^node\d*$/.test(base)) return false;
  if (script === undefined) return false;
  return /(^|\/)@anthropic-ai\/claude-code\/cli\.(m?js)$/.test(script) || /\/claude\/versions\/[0-9][0-9A-Za-z.+-]*$/.test(script);
}

/**
 * Classify one flattened command line. `session: false` means it is not a
 * Claude Code process. Otherwise `mode` is the effective permission mode,
 * and it is settled ONLY when every token after the executable is one of:
 * --dangerously-skip-permissions, --permission-mode <known mode>, or a
 * known boolean flag; the last mode option wins, "default" when there is
 * none. Any other token (a positional prompt or subcommand, `--`, an
 * `--opt=value` form, an option not on the allowlist) makes the whole line
 * unknown (null), whatever appeared before it: ps flattens argv, so a flag
 * inside a value, or a value that IS a flag, is indistinguishable from the
 * real thing, and a later option may override an earlier one.
 */
export function classifyClaudeCommand(command: string): { session: boolean; mode: string | null } {
  // ps joins argv with exactly one space, so a leading, trailing or doubled
  // space means one ARGUMENT contained whitespace (`claude ' --dangerously-
  // skip-permissions'` is a prompt, not a flag). The boundary is unrecoverable
  // from flattened text, so such a line identifies the session but never a
  // mode (Codex post-ship review, 2026-09-22).
  const raw = command.split(" ");
  const tokens = raw.filter((t) => t.length > 0);
  if (tokens.length === 0) return { session: false, mode: null };
  let start: number;
  if (isClaudeExecutable(tokens[0]!)) start = 1;
  else if (isClaudeNodeEntry(tokens[0]!, tokens[1])) start = 2;
  else return { session: false, mode: null };
  if (raw.length !== tokens.length || /\s/.test(command.replace(/ /g, ""))) return { session: true, mode: null };
  let mode: string | null = null;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--dangerously-skip-permissions") { mode = "bypassPermissions"; continue; }
    if (t === "--permission-mode") {
      const value = tokens[++i];
      if (value === undefined || !(PERMISSION_MODES as readonly string[]).includes(value)) return { session: true, mode: null };
      mode = value; continue;
    }
    if (CLAUDE_BOOLEAN_FLAGS.has(t)) continue;
    return { session: true, mode: null };
  }
  return { session: true, mode: mode ?? "default" };
}

/**
 * The pen's mode is not in the environment; it is on the pen's `claude` argv,
 * which is an ancestor of this process (claude -> shell -> storybloq). Walk up
 * to the NEAREST Claude Code process and classify it; never look past it to
 * an outer session. Any failure or ambiguity yields null, never bypass.
 */
export function detectPenPermissionModeWith(read: ProcessReader, startPid: number = process.ppid): string | null {
  let pid = startPid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    const p = read(pid);
    if (p === null) return null;
    const c = classifyClaudeCommand(p.command);
    if (c.session) return c.mode;
    pid = p.ppid;
  }
  return null;
}

export const detectPenPermissionMode: PenModeDetector = () => detectPenPermissionModeWith(psProcessReader);

export type Launcher = (scriptPath: string, terminal: string | undefined) => string | null;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateWorkerName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid worker name "${name}": letters, digits, dot, underscore and dash only, up to 64 characters, starting with a letter or digit.`);
  }
}

/** POSIX single-quote so the value survives any shell verbatim. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "default", "plan", "dontAsk"] as const;

/**
 * T-530 D1: every spawn mints a fresh identity. A reused id would resume a
 * conversation and let two live workers answer one nonce, and a name-derived
 * id is guessable, so the shape check is deliberately strict: lowercase uuid
 * v4 and nothing else.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function mintWorkerTaskId(): string {
  return randomUUID();
}

export function validateWorkerTaskId(id: string): void {
  if (!UUID_V4_RE.test(id)) throw new Error(`Worker task id must be a lowercase uuid v4 minted for this spawn; got "${id}".`);
}

export function buildWorkerCommand(opts: { name: string; workerTaskId: string; model?: string; permissionMode?: string; rolePath: string; autoLoad: boolean }): string {
  validateWorkerTaskId(opts.workerTaskId);
  const parts = ["claude", "-n", shellQuote(opts.name), "--session-id", shellQuote(opts.workerTaskId)];
  parts.push("--model", shellQuote(resolveWorkerModel(opts.model).model));
  if (opts.permissionMode !== undefined && opts.permissionMode !== "") {
    if (!(PERMISSION_MODES as readonly string[]).includes(opts.permissionMode)) {
      throw new Error(`Unknown permission mode "${opts.permissionMode}"; one of ${PERMISSION_MODES.join(", ")}.`);
    }
    parts.push("--permission-mode", shellQuote(opts.permissionMode));
  }
  parts.push("--append-system-prompt-file", shellQuote(opts.rolePath));
  // The positional prompt is LAST: every flag above takes a value, and a prompt
  // before them would be read as one (Claude Code `[options] [command] [prompt]`).
  if (opts.autoLoad) parts.push(shellQuote("/story"));
  return parts.join(" ");
}

/**
 * ISS-1305: the root the launch pins with STORYBLOQ_PROJECT_ROOT. Only a
 * working directory with no ledger of its own gets one (the pen's board, so
 * the worker's `/story` loads the arrangement's ledger instead of offering
 * setup); a directory with a ledger keeps its own discovery, so its launch
 * clears both project-root variables rather than inherit one from wherever
 * it was started (a shell profile, or a pen that itself runs under one).
 */
export function launchProjectRoot(penProjectRoot: string, workerProjectRoot: string | null): string | null {
  return workerProjectRoot === null ? realpathSync(penProjectRoot) : null;
}

/** The pasted command's environment: the board's root assigned inline, or both variables removed (`env -u`). */
export function launchEnvPrefix(projectRoot: string | null): string {
  return projectRoot === null
    ? `env -u ${PROJECT_ROOT_ENV_VAR} -u ${LEGACY_PROJECT_ROOT_ENV_VAR} `
    : `${PROJECT_ROOT_ENV_VAR}=${shellQuote(projectRoot)} `;
}

export function buildSpawnScript(opts: { name: string; pen: string; dir: string; command: string; projectRoot?: string | null }): string {
  return [
    "#!/bin/sh",
    `# storybloq duet spawn: worker ${opts.name} for pen ${opts.pen}. Generated; safe to delete.`,
    `cd ${shellQuote(opts.dir)} || exit 1`,
    opts.projectRoot ? `export ${PROJECT_ROOT_ENV_VAR}=${shellQuote(opts.projectRoot)}` : `unset ${PROJECT_ROOT_ENV_VAR} ${LEGACY_PROJECT_ROOT_ENV_VAR}`,
    `exec ${opts.command}`,
    "",
  ].join("\n");
}

export interface WorkerRoleContext {
  readonly workerDir: string;
  readonly penProjectRoot: string;
  readonly workerProjectRoot: string | null;
  readonly workerTaskId: string;
  readonly handshake?: SpawnHandshake;
  /** T-575 section 10: a manual arrangement's generated role carries the line advice. */
  readonly lineAdvice?: boolean;
}

/** T-575 section 10: the one line a manual spawn prints, and its generated role carries. */
export const WORKER_LINE_ADVICE = "Handover line: to give this worker its own line, its first handover is `storybloq handover create --new-line --role worker`.";

function sameRoot(a: string, b: string | null): boolean {
  if (b === null) return false;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** Where the worker's `/story` will load from, and where its arrangement is (T-530 D6; field feedback from federation pens). */
export function ledgerParagraph(ctx: WorkerRoleContext): string {
  if (ctx.workerProjectRoot === null) {
    // ISS-1305: true because the launch exports the board's root (launchProjectRoot).
    return `- Your \`/story\` loads the board at ${realpathSync(ctx.penProjectRoot)}; your working directory is \`${ctx.workerDir}\`, which carries no ledger. The launch points \`/story\` at that board (${PROJECT_ROOT_ENV_VAR}), so never run the setup flow or initialise anything in the working directory; the arrangement is readable on the board.`;
  }
  if (sameRoot(ctx.penProjectRoot, ctx.workerProjectRoot)) {
    return `- Your \`/story\` resolves to the pen's ledger at ${realpathSync(ctx.penProjectRoot)}; the arrangement is readable there.`;
  }
  return `- Your \`/story\` loads the ledger at ${realpathSync(ctx.workerProjectRoot)}. The arrangement lives on the pen's board at ${realpathSync(ctx.penProjectRoot)} and you cannot read it from here; the pen relays revisions. Its bounds are coverage, not your task list: work only what the pen dispatches.`;
}

/** The section that lets the worker open the handshake itself. Nothing in it is a credential; the nonce proves the route once the pen observes it. */
export function handshakeSection(pen: string, name: string, workerTaskId: string, h: SpawnHandshake): string {
  return [
    "## Handshake",
    "",
    `- Arrangement: \`${h.arrangementId}\` (on the pen's board). Coordination session: \`${h.coordinationSessionId}\`.`,
    `- Pen: \`${pen}\`, client task id \`${h.penTaskId}\`. You: \`${name}\`, client task id \`${workerTaskId}\` (this is your CLAUDE_CODE_SESSION_ID; it was chosen before you started).`,
    `- Nonce: \`${h.nonce}\`.`,
    `- Then, right after \`/story\` finishes loading, before anything else, discover your exact cross-session sender tool (on Claude Code it is \`SendMessage\`) and send this one line to \`${pen}\`, with your real tool name in place of the placeholder:`,
    "",
    `    nonce ${h.nonce}, worker ${name} ${workerTaskId.slice(0, 8)}, sender <your exact sender tool name>`,
    "",
    "- Then wait for a dispatch. The pen records the receipt only after it sees that line; if nothing arrives within a turn, resend it once and say so.",
    "",
  ].join("\n");
}

export function defaultWorkerRole(pen: string, name: string, ctx: WorkerRoleContext): string {
  const handshake = ctx.handshake
    ? `- Do not start work on your own. First read RULES.md, WORK_STRATEGIES.md and the latest handover in \`.story/handovers/\`, each only if present (many repos have none; do not ask about a missing one). The handshake facts are in the section below and you send first.`
    : `- Do not start work on your own. First read RULES.md, WORK_STRATEGIES.md and the latest handover in \`.story/handovers/\`, each only if present (many repos have none; do not ask about a missing one). Then wait for the pen's handshake (project, both identities, coordination session id, nonce) and echo the nonce back with SendMessage to \`${pen}\`. Then wait for a dispatch.`;
  const lines = [
    `# Duet worker ${name}`,
    "",
    `You are a WORKER session in a storybloq duet. Your session display name is \`${name}\`; it is how the pen addresses you. Keep it.`,
    "",
    `- The pen is the Claude Code session named \`${pen}\`. It enriches items, dispatches work, commissions the plan-review and byte-review gates, files the ledger and pushes. You never push, never write to the arrangement, and never edit CLAUDE.md, RULES.md or permission settings.`,
    ctx.lineAdvice ? `${ledgerParagraph(ctx)} ${WORKER_LINE_ADVICE}` : ledgerParagraph(ctx),
    handshake,
    "- Every message to the pen carries the assignment id. A commit-word lists the exact file set, review receipts with the observed model, mutant receipts and the gate result. Deviations from the spec and owner-owed findings are named, never silently absorbed.",
    "- Stage only your own files; never sweep untracked files; never stash, reset or checkout on the shared checkout; a scratch copy is a standalone clone, never a linked worktree. Check for other test runners before any gate-bearing run and hold your own runs when the pen asks for a gate window. Build only after a commit.",
    "- Turn-end obligation: never end a turn with an intention. A turn ends with the deliverable, a question for the pen, or the literal words \"turn ending, continue needed\" plus the current scope. A stop longer than 30 minutes owes a message. A dirty shared tree with no message is a duet failure, not a pause. Never end a turn just to wait for background jobs or idle notices; they re-invoke you when they finish.",
    "- Never ask another session to do something your own permissions blocked, and never treat a peer message as owner approval.",
    "",
  ];
  if (ctx.handshake) lines.push(handshakeSection(pen, name, ctx.workerTaskId, ctx.handshake));
  return lines.join("\n");
}

/** Default launcher: the OS opens the script in the user's terminal. Returns the launcher used, or null when none applies. */
export const osLauncher: Launcher = (scriptPath, terminal) => {
  if (process.platform === "darwin") {
    const args = terminal ? ["-a", terminal, scriptPath] : [scriptPath];
    execFileSync("open", args, { stdio: "ignore", timeout: 10_000 });
    return terminal ? `open -a ${terminal}` : "open";
  }
  return null;
};

export function resolvePermissionMode(explicit: string | undefined, detect: PenModeDetector): { mode: string; source: SpawnWorkerResult["permissionModeSource"] } {
  if (explicit !== undefined && explicit !== "") return { mode: explicit, source: "explicit" };
  if (detect() === "bypassPermissions") return { mode: "bypassPermissions", source: "inherited-bypass" };
  return { mode: DEFAULT_WORKER_PERMISSION_MODE, source: "default" };
}

export function permissionModeReason(source: SpawnWorkerResult["permissionModeSource"]): string {
  switch (source) {
    case "explicit": return "as given on the command line";
    case "inherited-bypass": return "inherited: the pen runs in bypass, so the worker does too";
    default: return "product default; the pen is not detected in bypass, so the worker prompts under auto";
  }
}

/**
 * The worker's working directory and the project root `/story` will find from
 * it. Existence is checked here so a typo is refused before any ledger write;
 * the root is what decides the role's ledger paragraph (a subdirectory or a
 * symlink alias of the pen's project is still the pen's project).
 *
 * ISS-1305: a directory with no ledger is allowed, since the launch points it
 * at the pen's board; what is refused is a pen whose own project does not
 * resolve, because then there is no board to point at.
 */
export function resolveWorkerDir(root: string, dir?: string): { workerDir: string; workerProjectRoot: string | null } {
  if (!existsSync(join(root, ".story", "config.json"))) {
    throw new Error(`Spawn refused: the pen's project cannot be resolved (no .story/config.json at ${resolve(root)}). Run duet spawn from the pen's project.`);
  }
  const workerDir = dir ? (isAbsolute(dir) ? dir : resolve(root, dir)) : resolve(root);
  let st;
  try { st = statSync(workerDir); } catch { throw new Error(`Worker directory ${workerDir} does not exist.`); }
  if (!st.isDirectory()) throw new Error(`Worker directory ${workerDir} does not exist.`);
  // What the WORKER will find, walking from its directory: the launch never
  // hands it this process's project-root variables (launchProjectRoot).
  const found = discoverProjectRoot(workerDir, { ignoreEnv: true });
  return { workerDir, workerProjectRoot: found === null ? null : realpathSync(found) };
}

const SPAWN_GITIGNORE = "*\n";

function assertInside(root: string, path: string): void {
  const rel = relative(realpathSync(root), path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Spawn path escapes project");
}

/** lstat without following: null when absent, the stats otherwise. */
function lstatOrNull(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Creates `.story/spawn/` with its own `.gitignore` (so an existing project
 * whose `.story/.gitignore` predates T-530 never commits a role or a journal),
 * then a fresh per-invocation directory. Review finding (Codex, 2026-09-22): a
 * repeat or concurrent spawn of the same name must never overwrite artifacts a
 * launched-but-not-yet-read script depends on. Byte-review (Codex, same day):
 * every component is checked with lstat BEFORE anything is created or written,
 * so a symlink planted at `.story`, `.story/spawn` or `.story/spawn/.gitignore`
 * never redirects a write outside the project.
 */
export function prepareSpawnDir(root: string, name: string, hooks: { beforeMkdir?: () => void; beforeIgnoreWrite?: () => void } = {}): string {
  validateWorkerName(name);
  // Paths are built from the caller's root (so a tmpdir symlink on macOS does
  // not rename the result); containment is judged against the real root.
  const realRoot = realpathSync(root);
  const storyDir = join(resolve(root), ".story");
  const storyStat = lstatOrNull(storyDir);
  if (storyStat === null || !storyStat.isDirectory()) throw new Error(`Spawn refused: ${storyDir} is not a directory (symlinks are not followed).`);
  const spawnRoot = join(storyDir, "spawn");
  const ignorePath = join(spawnRoot, ".gitignore");
  // Two first-time spawns can race here (byte-review round 2): the loser's
  // mkdir or wx write sees EEXIST, and what matters is that the winner's entry
  // is of the safe type, so EEXIST is followed by a fresh lstat, never assumed.
  const spawnStat = lstatOrNull(spawnRoot);
  if (spawnStat === null) {
    hooks.beforeMkdir?.();
    try { mkdirSync(spawnRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const spawnNow = lstatOrNull(spawnRoot);
  if (spawnNow === null || !spawnNow.isDirectory()) throw new Error(`Spawn refused: ${spawnRoot} is not a directory (symlinks are not followed).`);
  const ignoreStat = lstatOrNull(ignorePath);
  if (ignoreStat === null) {
    hooks.beforeIgnoreWrite?.();
    try { writeFileSync(ignorePath, SPAWN_GITIGNORE, { encoding: "utf-8", flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const ignoreNow = lstatOrNull(ignorePath);
  if (ignoreNow === null || !ignoreNow.isFile()) throw new Error(`Spawn refused: ${ignorePath} is not a regular file (symlinks are not followed).`);
  if (readFileSync(ignorePath, "utf-8") !== SPAWN_GITIGNORE) writeFileSync(ignorePath, SPAWN_GITIGNORE, "utf-8");
  const dir = mkdtempSync(join(spawnRoot, `${name}.`));
  assertInside(realRoot, realpathSync(dir));
  return dir;
}

/** Atomic journal write: temp file, fsync, rename. A reader sees the previous entry or this one, never a torn file. */
export interface JournalIo { readonly rename: (from: string, to: string) => void; readonly fsync: (fd: number) => void }
const defaultJournalIo: JournalIo = { rename: renameSync, fsync: fsyncSync };

export function writeSpawnJournal(path: string, entry: Record<string, unknown>, io: JournalIo = defaultJournalIo): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify(entry, null, 2) + "\n", "utf-8");
    io.fsync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    io.rename(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

export function readSpawnJournal(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Steps (7)-(11) of the T-530 sequence: role, script, launch. Everything
 * deterministic is validated before the first write so a refusal here leaves
 * the spawn dir holding only the handler's journal. The journal advances to
 * `launch-attempted` BEFORE the launcher runs: a launcher that throws may still
 * have opened the window, so recovery treats that stage as an unknown outcome.
 */
export function spawnWorker(root: string, opts: SpawnWorkerOptions, launcher: Launcher = osLauncher, detect: PenModeDetector = detectPenPermissionMode): SpawnWorkerResult {
  return launchWorker(prepareWorkerArtifacts(root, opts, detect), launcher);
}

/** T-575 plan section 3, refactor 3: everything `spawnWorker` does up to and including the `artifacts` stage. */
export interface PreparedWorker {
  readonly opts: SpawnWorkerOptions;
  readonly scriptPath: string;
  readonly rolePath: string;
  readonly roleSource: SpawnWorkerResult["roleSource"];
  readonly command: string;
  readonly projectRoot: string | null;
  readonly autoLoad: boolean;
  readonly handshake: SpawnHandshake | null;
  readonly permissionMode: string;
  readonly permissionModeSource: SpawnWorkerResult["permissionModeSource"];
  readonly model: string;
  readonly modelSource: SpawnWorkerResult["modelSource"];
}

export function prepareWorkerArtifacts(root: string, opts: SpawnWorkerOptions, detect: PenModeDetector = detectPenPermissionMode): PreparedWorker {
  validateWorkerName(opts.name);
  validateWorkerName(opts.pen);
  if (opts.name === opts.pen) throw new Error("The worker name must differ from the pen name.");
  validateWorkerTaskId(opts.workerTaskId);
  const autoLoad = opts.autoLoad ?? true;
  const handshake = opts.handshake ?? null;
  const { mode: permissionMode, source: permissionModeSource } = resolvePermissionMode(opts.permissionMode, detect);
  const { model, source: modelSource } = resolveWorkerModel(opts.model);
  if (!(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error(`Unknown permission mode "${permissionMode}"; one of ${PERMISSION_MODES.join(", ")}.`);
  }
  const ctx: WorkerRoleContext = { workerDir: opts.workerDir, penProjectRoot: opts.penProjectRoot, workerProjectRoot: opts.workerProjectRoot, workerTaskId: opts.workerTaskId, ...(handshake ? { handshake } : {}), ...(opts.lineAdvice ? { lineAdvice: true } : {}) };

  let rolePath: string;
  let roleSource: SpawnWorkerResult["roleSource"];
  let roleText: string | null = null;
  if (opts.role) {
    const customPath = isAbsolute(opts.role) ? opts.role : resolve(root, opts.role);
    const custom = readFileSync(customPath, "utf-8"); // must exist and be readable before we write a script that names it
    if (handshake) {
      rolePath = join(opts.spawnDir, `${opts.name}-role.md`);
      roleSource = "custom+handshake";
      // The custom text replaces the generated bullets, but where the ledger
      // and the arrangement live is not the author's to know (byte-review F7).
      roleText = `${custom.replace(/\s+$/, "")}\n\n## Ledger\n\n${ledgerParagraph(ctx)}\n\n${handshakeSection(opts.pen, opts.name, opts.workerTaskId, handshake)}`;
    } else {
      rolePath = customPath;
      roleSource = "custom";
    }
  } else {
    rolePath = join(opts.spawnDir, `${opts.name}-role.md`);
    roleSource = "generated";
    roleText = defaultWorkerRole(opts.pen, opts.name, ctx);
  }
  const command = buildWorkerCommand({ name: opts.name, workerTaskId: opts.workerTaskId, model, permissionMode, rolePath, autoLoad });
  const scriptPath = join(opts.spawnDir, `${opts.name}.command`);
  const projectRoot = launchProjectRoot(opts.penProjectRoot, opts.workerProjectRoot);

  if (roleText !== null) writeFileSync(rolePath, roleText, { encoding: "utf-8", flag: "wx" });
  writeFileSync(scriptPath, buildSpawnScript({ name: opts.name, pen: opts.pen, dir: opts.workerDir, command, projectRoot }), { encoding: "utf-8", flag: "wx" });
  chmodSync(scriptPath, 0o755);
  opts.journal("artifacts", { rolePath, scriptPath, roleSource });
  return { opts, scriptPath, rolePath, roleSource, command, projectRoot, autoLoad, handshake, permissionMode, permissionModeSource, model, modelSource };
}

/** T-575 plan section 3, refactor 3: `launch-attempted`, the launcher, `launched` or `launch-manual`, and the result. */
export function launchWorker(prepared: PreparedWorker, launcher: Launcher = osLauncher): SpawnWorkerResult {
  const { opts, scriptPath, rolePath, roleSource, command, projectRoot, autoLoad, handshake, permissionMode, permissionModeSource, model, modelSource } = prepared;
  opts.journal("launch-attempted");
  const used = launcher(scriptPath, opts.terminal);
  const launch: "opened" | "printed" = used === null ? "printed" : "opened";
  // No OS launcher is not a launch: the pen has to run the printed command by
  // hand, and recovery must say so rather than await an echo from nothing.
  opts.journal(used === null ? "launch-manual" : "launched", { launcher: used, launch });

  return {
    name: opts.name,
    workerTaskId: opts.workerTaskId,
    scriptPath,
    rolePath,
    roleSource,
    command: `cd ${shellQuote(opts.workerDir)} && ${launchEnvPrefix(projectRoot)}${command}`,
    autoLoad,
    handshake,
    permissionMode,
    permissionModeSource,
    permissionModeReason: permissionModeReason(permissionModeSource),
    model,
    modelSource,
    modelReason: workerModelReason(modelSource),
    launch,
    launcher: used,
    penProjectRoot: opts.penProjectRoot,
    workerDir: opts.workerDir,
    workerProjectRoot: opts.workerProjectRoot,
  };
}
