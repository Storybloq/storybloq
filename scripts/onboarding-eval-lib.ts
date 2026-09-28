/**
 * T-536: the mechanical checks behind the onboarding evaluations. Pure over a
 * transcript already normalised into calls, and over the files a run left on
 * disk, so the runner stays thin and every rule here has a unit test.
 *
 * What these checks cannot decide (whether a question concerned a material
 * gap, whether a conflict was surfaced with a recommendation, whether the
 * coverage map accounts for every requirement) goes into the grading packet
 * for a judge; nothing here pretends to answer it.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, posix, relative } from "node:path";

import { resolveRecipe } from "../src/autonomous/recipes/loader.js";
import { COMMANDS } from "../src/cli/commands/reference.js";
import { sha256, type StreamEvent, summarizeStream } from "./continuity-lib.js";

// --- normalised calls -----------------------------------------------------------

/** One tool call, whichever client made it. `name` is bare: no `mcp__server__` prefix. */
export interface EvalCall {
  readonly name: string;
  readonly input: unknown;
  readonly isError: boolean;
  /** Made by a nested agent (a reviewer, a subagent). Audited for writes and executions; never an owner interaction. */
  readonly nested?: boolean;
  /** The call's captured result text, when the client reported one. */
  readonly result?: string;
}

/** Whether the client itself reported finishing the turn. Anything but `completed` is an infrastructure failure. */
export interface TurnTerminal {
  readonly status: "completed" | "failed" | "missing";
  readonly detail: string;
}

export interface EvalTurn {
  /** Every call the turn made, the main agent's and nested agents', in issue order. */
  readonly calls: readonly EvalCall[];
  /**
   * The turn's terminal interaction only: the main agent's final text, or a
   * structured question it issued last and left pending. Earlier questions,
   * answered or failed ones, and nested agents' questions never count.
   */
  readonly stopText: string;
  /**
   * Set when the terminal interaction is a pending structured question: the
   * question as rendered, and all main-agent text before it (every text block,
   * in any message, and the result text), which may be empty.
   */
  readonly pendingQuestion?: { readonly question: string; readonly preamble: string };
  readonly models: readonly string[];
  readonly sessionId: string | null;
  readonly terminal: TurnTerminal;
  /** Tools the client listed at session start (Claude's init event); null when it reports none. */
  readonly initTools: readonly string[] | null;
}

export function bareToolName(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

function questionText(input: unknown): string {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return "";
  const parts: string[] = [];
  for (const q of qs) {
    const rec = q as { question?: unknown; options?: unknown };
    if (typeof rec.question === "string") parts.push(rec.question);
    if (Array.isArray(rec.options)) {
      for (const o of rec.options) {
        const label = (o as { label?: unknown }).label;
        if (typeof label === "string") parts.push(label);
      }
    }
  }
  return parts.join("\n");
}

/**
 * A Claude Code stream-json turn. The terminal interaction is read from the
 * main agent's ordered activity (text and tool calls, nested agents excluded):
 * the result text counts only when the main agent's last activity was text,
 * and a structured question counts only when it was the main agent's last
 * activity and is neither failed nor answered. A question followed by more
 * text or more tool use was not where the turn stopped.
 */
export function claudeTurn(events: readonly StreamEvent[]): EvalTurn {
  const { usage, toolCalls } = summarizeStream(events);
  const ordered = [...toolCalls].sort((a, b) => a.issuedAt - b.issuedAt);
  const calls: EvalCall[] = ordered.map((c) => ({ name: bareToolName(c.name), input: c.input, isError: c.isError, result: c.result, ...(c.parentToolUseId !== null ? { nested: true } : {}) }));
  let lastMain: { readonly kind: "text" } | { readonly kind: "tool"; readonly id: string } | null = null;
  // Every main-agent text block, in order: before a pending question they are its preamble.
  const mainTexts: string[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant" || (ev.parent_tool_use_id ?? null) !== null) continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as readonly Record<string, unknown>[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") { lastMain = { kind: "text" }; mainTexts.push(block.text); }
      else if (block.type === "tool_use" && typeof block.id === "string") lastMain = { kind: "tool", id: block.id };
    }
  }
  const last = lastMain as { readonly kind: "text" } | { readonly kind: "tool"; readonly id: string } | null;
  const lastId = last?.kind === "tool" ? last.id : null;
  const lastCall = lastId === null ? undefined : toolCalls.find((c) => c.toolUseId === lastId);
  const pendingQuestion = lastCall !== undefined && bareToolName(lastCall.name) === "AskUserQuestion" && !lastCall.isError && lastCall.resolvedAt === null
    ? questionText(lastCall.input)
    : "";
  const result = usage.resultEvent as { result?: unknown; is_error?: unknown; subtype?: unknown } | null;
  const resultText = typeof result?.result === "string" ? result.result : "";
  // A pending question's preamble is all the main agent's text before it, in any message, the result text included
  // once when it repeats none of them: the judge must see every sentence the owner saw with the question.
  const preamble = [...mainTexts, ...(mainTexts.some((t) => t.trim() === resultText.trim()) ? [] : [resultText])].filter(Boolean).join("\n");
  const stopText = last?.kind === "text" ? resultText
    : pendingQuestion !== "" ? [preamble, pendingQuestion].filter(Boolean).join("\n")
    : "";
  const sessionId = (usage.initEvent?.session_id as string | undefined) ?? null;
  const terminal: TurnTerminal = result === null
    ? { status: "missing", detail: "no result event" }
    : result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")
      ? { status: "failed", detail: `result ${String(result.subtype)}` }
      : { status: "completed", detail: "result success" };
  const tools = usage.initEvent?.tools;
  const initTools = Array.isArray(tools) ? tools.map(String) : null;
  const pending = last?.kind !== "text" && pendingQuestion !== "" ? { pendingQuestion: { question: pendingQuestion, preamble } } : {};
  return { calls, stopText, ...pending, models: usage.mainModels, sessionId, terminal, initTools };
}

/** Codex item types that are activity after which an earlier agent message is no longer where the turn stopped. */
const CODEX_ACTIVITY = new Set(["command_execution", "mcp_tool_call", "file_change", "web_search"]);

/**
 * A Codex `exec --json` turn. Items are read from their completed events only.
 * The terminal interaction is the last agent message, and only when no tool
 * activity followed it: a message superseded by more work is stale.
 */
export function codexTurn(lines: readonly Record<string, unknown>[], checkSet = 1): EvalTurn {
  const calls: EvalCall[] = [];
  let lastMessage = "";
  let messageAt = -1;
  let activityAt = -1;
  let sessionId: string | null = null;
  let terminal: TurnTerminal = { status: "missing", detail: "no turn.completed event" };
  for (let at = 0; at < lines.length; at++) {
    const ev = lines[at]!;
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") sessionId = ev.thread_id;
    if (ev.type === "turn.completed") terminal = { status: "completed", detail: "turn.completed" };
    if (ev.type === "turn.failed" || ev.type === "error") {
      const err = (ev.error as { message?: unknown } | undefined)?.message ?? ev.message;
      terminal = { status: "failed", detail: `${String(ev.type)}: ${typeof err === "string" ? err : "no message"}` };
    }
    if (ev.type !== "item.completed") continue;
    const item = (ev.item ?? {}) as Record<string, unknown>;
    // Check set 2: an agent spawn or wait after the message is activity too, so the message is no longer the turn's stop.
    if (typeof item.type === "string" && (CODEX_ACTIVITY.has(item.type) || (checkSet >= 2 && item.type === "collab_tool_call"))) activityAt = at;
    switch (item.type) {
      case "agent_message":
        if (typeof item.text === "string") { lastMessage = item.text; messageAt = at; }
        break;
      case "command_execution":
        calls.push({ name: "Bash", input: { command: item.command }, isError: typeof item.exit_code === "number" && item.exit_code !== 0, result: typeof item.aggregated_output === "string" ? item.aggregated_output : "" });
        break;
      case "mcp_tool_call":
        calls.push({ name: String(item.tool ?? ""), input: item.arguments ?? null, isError: item.status === "failed" || item.error != null, result: item.result == null ? "" : JSON.stringify(item.result) });
        break;
      case "file_change":
        calls.push({ name: "Write", input: { changes: item.changes }, isError: item.status === "failed" });
        break;
      case "collab_tool_call":
        // Check set 2: an agent spawn or wait is a call, so a reviewer agent's completion can be bound. Check set 1 dropped them.
        if (checkSet >= 2) {
          calls.push({
            name: `collab:${String(item.tool ?? "")}`,
            input: { sender_thread_id: item.sender_thread_id ?? null, receiver_thread_ids: Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : [], prompt: typeof item.prompt === "string" ? item.prompt : null },
            isError: item.status === "failed",
            result: JSON.stringify(item.agents_states ?? {}),
          });
        }
        break;
      default:
        break;
    }
  }
  return { calls, stopText: messageAt > activityAt ? lastMessage : "", models: [], sessionId, terminal, initTools: null };
}

/**
 * The models a Codex thread actually ran on. `exec --json` does not report
 * them; the thread's rollout file does, once per turn, as `turn_context`.
 */
export function codexRolloutModels(lines: readonly Record<string, unknown>[]): string[] {
  const models: string[] = [];
  for (const ev of lines) {
    if (ev.type !== "turn_context") continue;
    const model = (ev.payload as { model?: unknown } | undefined)?.model;
    if (typeof model === "string" && model.length > 0 && !models.includes(model)) models.push(model);
  }
  return models;
}

// --- write and execution detection ----------------------------------------------

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
const STORYBLOQ_WRITE = /^storybloq_(init|snapshot|handover_create|.*_create|.*_update|.*_set|.*_unset|.*_add|.*_reinforce)$/;
const STORYBLOQ_CLI_WRITE = /\bstorybloq\s+(init|snapshot|config\s+set-overrides|(phase|ticket|issue|note|lesson|handover)\s+(create|update))\b/;
const GIT_INIT = /\bgit\s+init\b/;
/**
 * The redirections proven safe on a command's unquoted skeleton: a descriptor duplication or close (`>&N`, `N>&M`,
 * `>&N-`, `N>&M-`, `>&-`, `N>&-`, `{name}>&-`), any redirection into /dev/null, and a process substitution `>(`,
 * which is a construct under review of its own.
 */
const SAFE_REDIRECT = /\{[A-Za-z_][A-Za-z0-9_]*\}>&-(?=$|[\s|&;<>)])|[0-9]*>&(?:[0-9]+-?|-)(?=$|[\s|&;<>)])|(?:[0-9]*|\{[A-Za-z_][A-Za-z0-9_]*\})[&<]?>[>&|!]*\s*\/dev\/null(?=$|[\s|&;<>)])|(?<![>&])>\(/g;
/**
 * A shell redirect into a file, or tee. The rule is inverted, not enumerated: any `>` on the skeleton outside a
 * proven-safe form (SAFE_REDIRECT) is a file redirect, so `>|`, `>!`, `>>!`, `>&|`, `>>&|`, `>&file`, `>>&2`,
 * `{name}>file`, `N>file` and `<>` all are, and any unrecognised redirection reads as one. A comparison inside
 * `[[ ]]` or `$(( ))` reads as one too: the command is review already, so the second reason fails closed.
 * Its target is not resolved, so it is review, never a counted write.
 */
function fileRedirect(bare: string): boolean {
  return /\btee\s/.test(bare) || bare.replace(SAFE_REDIRECT, " ").includes(">");
}
/** Launchers that run the storybloq CLI named as their first operand. */
const STORYBLOQ_LAUNCHERS = new Set(["npx", "bunx", "pnpx"]);
/** Git's global options that consume the next word. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

/** The git subcommand, past git's global options. */
function gitSubcommand(args: readonly string[]): string {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (GIT_VALUE_OPTIONS.has(a)) { k++; continue; }
    if (!a.startsWith("-")) return a;
  }
  return "";
}

/** Help and version flags: a call that parses one where its CLI accepts it prints and exits, so it is a probe, never a write. */
const PROBE_FLAGS = new Set(["-h", "--help", "-V", "--version"]);
/** A help or version option in a negated or valued spelling (`--no-help`, `--help=false`, `-hx`): it can switch the probe off. */
const PROBE_VARIANT = /^--(no-)?(help|version)(=|$)|^-[hV]./;

/**
 * Whether the words before `--` could switch a probe off: a help or version
 * option given more than once in any spelling, or once negated or valued
 * (`--help --no-help` and `--help --help=false` run the command). A CLI is
 * not re-implemented here; any such word declines the probe, so the call
 * reads as a write.
 */
function probeDoubtful(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const words = end < 0 ? args : args.slice(0, end);
  let seen = 0;
  for (const w of words) {
    if (PROBE_FLAGS.has(w)) seen++;
    else if (PROBE_VARIANT.test(w)) return true;
  }
  return seen > 1;
}

/**
 * Whether git parses a help or version flag and does nothing else: the last
 * word, among git's global options or directly after the subcommand. The one
 * exception is git(1)'s own rule that `--help <command>` brings up that
 * command's manual page. Parsing stops at `--`, and a value option's value
 * (`-C --help`) is never read as a flag.
 */
function gitProbe(args: readonly string[]): boolean {
  if (probeDoubtful(args)) return false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") return false;
    if (PROBE_FLAGS.has(a)) {
      const rest = args.slice(k + 1);
      return rest.length === 0 || (a === "--help" && rest.length === 1 && !rest[0]!.startsWith("-"));
    }
    if (GIT_VALUE_OPTIONS.has(a)) { k++; continue; }
    if (!a.startsWith("-")) return PROBE_FLAGS.has(args[k + 1] ?? "") && k + 2 === args.length;
  }
  return false;
}

/**
 * The storybloq CLI's value-taking options, per command, read from the CLI
 * reference table (`--flag <value>` in a command's usage). A drift test keeps
 * that table equal to the real registrations, so this is the CLI's own list.
 */
const STORYBLOQ_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  COMMANDS.map((c) => [c.name, new Set([...c.usage.matchAll(/(--[\w-]+) </g)].map((m) => m[1]!))]),
);
const STORYBLOQ_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map(COMMANDS.map((c) => [c.name, new Set(c.flags)]));

/**
 * Whether the storybloq CLI parses a help or version flag and does nothing
 * else: the flag is the invocation's last word. yargs reads a word after it as
 * its value (`--help false` runs the command), so any word after it, `--`
 * included, declines the probe. A value option's value is skipped (`--title --help`
 * sets the title), and so is the word after an option the command does not
 * list, because it may take a value: any doubt reads as no probe, so as a write.
 */
function storybloqProbe(args: readonly string[]): boolean {
  if (probeDoubtful(args)) return false;
  const words: string[] = [];
  let command: string | null = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") return false;
    if (PROBE_FLAGS.has(a)) return k === args.length - 1;
    if (a.startsWith("-")) {
      if (a.includes("=")) continue;
      const known = command !== null && STORYBLOQ_FLAGS.get(command)!.has(a);
      if (!known || STORYBLOQ_VALUE_FLAGS.get(command!)!.has(a)) k++;
      continue;
    }
    words.push(a);
    for (let n = words.length; n > 0; n--) {
      const name = words.slice(0, n).join(" ");
      if (STORYBLOQ_FLAGS.has(name)) { command = name; break; }
    }
  }
  return false;
}

/** Whether one unwrapped simple command (its argv) writes setup state: `git init` or a storybloq CLI write. */
function argvWrites(argv: readonly string[]): boolean {
  const bin = baseName(argv[0] ?? "");
  if (bin === "git") return !gitProbe(argv.slice(1)) && gitSubcommand(argv.slice(1)) === "init";
  const at = STORYBLOQ_LAUNCHERS.has(bin) ? argv.findIndex((w, k) => k > 0 && !w.startsWith("-")) : 0;
  if (at < 0 || !/^storybloq(@\S*)?$/.test(baseName(argv[at] ?? ""))) return false;
  if (storybloqProbe(argv.slice(at + 1))) return false;
  return STORYBLOQ_CLI_WRITE.test(["storybloq", ...argv.slice(at + 1)].join(" "));
}

/**
 * Whether a shell command writes setup state, read structurally: every simple
 * command in the list or pipeline is unwrapped and its argv checked, and a
 * nested shell's command string (`zsh -lc "..."`) is walked the same way,
 * because it executes. Words passed as arguments (a prompt that mentions
 * `git init`) are data. Redirects are read from each command's unquoted
 * skeleton. Quoted text the shell runs is code and is walked the same way:
 * eval's operands, and a `$(...)` or backtick span inside double quotes.
 * Where the parser cannot see through a construct (a heredoc, a process
 * substitution, an unknown wrapper option), that command's unquoted skeleton
 * falls back to the textual patterns, so an unreadable write still counts and
 * a quoted operand (a review prompt) still does not. Past nesting depth 3 the
 * text is read unblanked: fail-closed, so a prompt that deep counts as a write.
 */
function shellWrites(cmd: string, depth = 0): boolean {
  const nested = (code: string): boolean => (depth >= 3 ? textualWrite(code) : shellWrites(code, depth + 1));
  for (const c of shellSequence(cmd).commands) {
    if (c.live.some(nested)) return true;
    const { argv, inner, ambiguous } = unwrap(c.words);
    if (inner !== null) {
      if (nested(inner)) return true;
      continue;
    }
    if (argvWrites(argv)) return true;
    // eval runs its operands as one command string; `source` and `.` read a file, so theirs stay data.
    if (baseName(argv[0] ?? "") === "eval" && nested(argv.slice(1).join(" "))) return true;
    if ((ambiguous !== null || UNSUPPORTED_SYNTAX.test(c.bare) || unsupportedArgv(argv) !== null) && textualWrite(c.bare)) return true;
  }
  return false;
}

function textualWrite(text: string): boolean {
  return STORYBLOQ_CLI_WRITE.test(text) || GIT_INIT.test(text);
}

function commandOf(call: EvalCall): string | null {
  if (call.name !== "Bash" && call.name !== "shell" && call.name !== "exec_command") return null;
  const c = (call.input as { command?: unknown } | null)?.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(String).join(" ");
  return null;
}

/**
 * The write rule the packet names beside the stop rule, so a reader of a
 * record knows which classifier produced its writes.
 */
export const WRITE_RULE_VERSION = "2026-09-27.8: a write is a file-writing tool, a storybloq MCP write, or a shell command whose own argv is `git init` or a storybloq CLI write; a git or storybloq call that parses -h, --help, -V or --version as its last word, where its CLI accepts it (git: among its global options or directly after the subcommand, plus git's own --help <command>; storybloq: anywhere), is a probe, never a write, any word after the flag declining the probe, unless a help or version option appears more than once in any spelling or in a negated or valued form (--no-help, --help=<anything>, -h<attached>), which declines the probe, with parsing stopped at -- and the values of value-taking options (git's global value options, storybloq's from the CLI reference table, and the word after any option the command does not list) never read as flags, any doubt reading as a write; quoted operands are data, except quoted text the shell runs (a nested shell's -c string, eval's operands, a $(...) or backtick span inside double quotes), which is walked as code; source and . operands are files, not code; a construct the parser cannot read falls back to the textual patterns on its unquoted skeleton only; past nesting depth 3 the text is read unblanked, fail-closed, so a quoted prompt that deep counts as a write; a here-document's body is never read as commands, and only a simple delimiter word is modelled ([A-Za-z0-9_]+ bare, or wrapped whole in one pair of single quotes or of double quotes, or behind one backslash, any fd prefix, <<- included): under a simple quoted one the shell never expands the body, so it is data, and under a simple unquoted one it is read unblanked, fail-closed; any other delimiter word (a backslash or quote inside it, mixed quoting, a continuation, $, a backtick, a carriage return, any non-word character) is complex: its end is not known, so everything after it is read unblanked, fail-closed, and the command is needs-review (complex here-document delimiter); a here-document an interpreter reads (python, node, sh, bash, zsh, dash, ksh, perl, ruby), quoted delimiter or not, is a script the harness cannot read, so it is needs-review, never clean, and its writes are not counted: writesAfterApproval is a lower bound whenever a needs-review construct carries the writes; a shell redirect or tee is never a counted write: its target is not resolved, so it is needs-review (file redirect, target not resolved), and the tree check is the truth for project files, so a redirect into the project before approval is caught as a project change before approval, not by the counter, and writesAfterApproval stays a lower bound; any unrecognised redirection reads as a file redirect, review: only a descriptor duplication or close (>&N, N>&M, >&N-, N>&M-, >&-, N>&-, {name}>&-), a redirection into /dev/null and a process substitution are exempt; a comparison inside [[ ]] or $(( )) reads as a redirect too, fail-closed";

/** Every call that writes setup state: storybloq writes by MCP or CLI, file edits, `git init`. A shell redirect is review; the tree check reports the files it changes. */
export function writeCalls(calls: readonly EvalCall[]): EvalCall[] {
  return calls.filter((call) => {
    if (WRITE_TOOLS.has(call.name)) return true;
    if (STORYBLOQ_WRITE.test(call.name)) return true;
    const cmd = commandOf(call);
    return cmd !== null && shellWrites(cmd);
  });
}

/** Executables whose invocation (with these subcommands) installs, tests, builds or serves. */
const EXEC_RULES: readonly { readonly bin: RegExp; readonly sub: RegExp | null }[] = [
  { bin: /^(npm|pnpm|yarn|bun)$/, sub: /^(install|i|ci|add|test|t|run|run-script|start|exec|dlx|x)$/ },
  { bin: /^(npx|bunx|pnpx)$/, sub: null },
  { bin: /^(pytest|py\.test|uvicorn|vite|vitest|jest|tsc|next|gunicorn|flask|tox|nox|playwright)$/, sub: null },
  { bin: /^(pip|pip3|uv|poetry|pipenv|hatch|pdm)$/, sub: /^(install|sync|run|add)$/ },
  { bin: /^python[0-9.]*$/, sub: /^(-m|manage\.py|setup\.py)$/ },
  { bin: /^(cargo|go|flutter|dart|dotnet|swift|gradle|gradlew|make|mvn|mvnw|rake|bundle|mix|deno)$/, sub: /^(test|build|run|install|serve|package|exec|check|task)$/ },
];

/**
 * Options that take a value, per executable family, so `npm --prefix web test`
 * reads `test` as the subcommand. A flag not listed here is assumed to take
 * none; an unknown option therefore never hides a subcommand behind it.
 */
const VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["--prefix", "-w", "--workspace", "-C"]),
  // pnpm's -w is --workspace-root, a flag: it takes no value.
  pnpm: new Set(["-C", "--dir", "--filter", "-F"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd", "--cwd="]),
  make: new Set(["-C", "-f", "--directory", "--file"]),
  go: new Set(["-C"]),
  cargo: new Set(["--manifest-path", "-p", "--package"]),
  poetry: new Set(["-C", "--directory"]),
  uv: new Set(["--directory", "--project"]),
};

/**
 * Leading words that run the rest of the line as a command, with the options
 * each one knows: `value` options consume the next word, `flags` consume
 * nothing, and `operands` counts the positional words before the command
 * (`timeout`'s duration). An option a wrapper does not list makes the segment
 * ambiguous: it may take a value that hides the real command.
 */
interface WrapperSpec {
  readonly value: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
  /** Flags with an attached value (`-oL`, `-10`). */
  readonly attached?: RegExp;
  readonly operands?: number;
}
const TIMEOUT_SPEC: WrapperSpec = { value: new Set(["-s", "--signal", "-k", "--kill-after"]), flags: new Set(["--preserve-status", "--foreground", "-v", "--verbose", "-f", "-p"]), attached: /^-[sk].+$/, operands: 1 };
const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  command: { value: new Set(), flags: new Set(["-p", "-v", "-V"]) },
  builtin: { value: new Set(), flags: new Set() },
  nohup: { value: new Set(), flags: new Set() },
  exec: { value: new Set(["-a"]), flags: new Set(["-c", "-l"]) },
  time: { value: new Set(["-f", "--format", "-o", "--output"]), flags: new Set(["-p", "-l", "-a", "-v", "--portability", "--append", "--verbose"]) },
  sudo: {
    value: new Set(["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout", "-R", "--chroot"]),
    flags: new Set(["-A", "-B", "-b", "-E", "-e", "-H", "-i", "-K", "-k", "-n", "-P", "-S", "-s", "--askpass", "--bell", "--background", "--preserve-env", "--set-home", "--login", "--remove-timestamp", "--reset-timestamp", "--non-interactive", "--preserve-groups", "--stdin", "--shell"]),
    attached: /^-[ugpCDrtUTR].+$/,
  },
  nice: { value: new Set(["-n", "--adjustment"]), flags: new Set(), attached: /^-(n.+|-?\d+)$/ },
  caffeinate: { value: new Set(["-t", "-w"]), flags: new Set(["-d", "-i", "-m", "-s", "-u"]) },
  stdbuf: { value: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]), flags: new Set(), attached: /^-[ioe].+$/ },
  timeout: TIMEOUT_SPEC,
  gtimeout: TIMEOUT_SPEC,
};
const ENV_SPEC: WrapperSpec = { value: new Set(["-u", "--unset", "-C", "--chdir", "-P"]), flags: new Set(["-i", "--ignore-environment", "-0", "--null", "-v", "--debug", "-"]), attached: /^-[uCP].+$/ };

/** Shell reserved words: a segment led by one is a control structure the checks do not model. */
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "!", "[[", "]]", "coproc"]);

/** A construct the tokenizer cannot see through: the segment is reported for review, never passed as clean. */
// The eval and source builtins as words, not an option such as node's --eval.
const UNSUPPORTED = /\$\(|`|<\(|>\(|<<|(?<![-\w])eval\b|(?<![-\w])source\b|^\.\s|\bxargs\b|\bfind\b[^|;&]*-exec/;
/** Shell syntax the tokenizer cannot see through, matched on a command's unquoted skeleton (`ShellCommand.bare`). */
const UNSUPPORTED_SYNTAX = /\$\(|`|<\(|>\(|<</;
/** Interpreters that run a here-document as a script (`python3 - <<'PY'`, `bash <<EOF`). */
const HEREDOC_INTERPRETERS = /^(python[0-9.]*|node|sh|bash|zsh|dash|ksh|perl|ruby)$/;
/** Executables that run a command built from their arguments, matched on the unwrapped argv with quotes resolved. */
const UNSUPPORTED_EXECUTABLES = new Set(["eval", "source", ".", "xargs"]);
const FIND_EXEC = /^-(exec|execdir|ok|okdir)$/;

/** Why an unwrapped argv runs a command the checks cannot read (`eval`, `xargs`, `find -exec` ...), or null. */
function unsupportedArgv(argv: readonly string[]): string | null {
  const bin = baseName(argv[0] ?? "");
  if (UNSUPPORTED_EXECUTABLES.has(bin)) return bin;
  if (bin === "find" && argv.some((w) => FIND_EXEC.test(w))) return "find -exec";
  return null;
}

export interface ShellCommand {
  readonly words: readonly string[];
  /** The operator that ended the command (`&&`, `||`, `;`, `;;`, newline, `|`, `&`, a paren or brace), or "" at the end. */
  readonly sep: string;
  /**
   * The command as its own shell sees it, with quoted text blanked: a
   * single-quoted span becomes `''` and a double-quoted span `""`, keeping
   * only the substitutions still live inside double quotes (`$(`, a
   * backtick). The separator is appended, so `<(` and `$(` survive the split.
   * Constructs are matched here, never inside a quoted payload.
   */
  readonly bare: string;
  /**
   * The bodies of the substitutions inside double quotes (`"$(git init)"`,
   * a backtick span): quoted text the shell runs, so it is code, not data.
   */
  readonly live: readonly string[];
  /** The command reads a here-document (`<<`, `3<<-`), whatever its delimiter. */
  readonly heredoc: boolean;
  /** One of its here-documents has a delimiter word outside the simple forms, so its end is not known. */
  readonly heredocComplex: boolean;
  /** One of its here-documents has a simple unquoted delimiter, so its body is expanded and read unblanked. */
  readonly heredocUnquoted: boolean;
}

/**
 * A here-document's delimiter, read from the word after `<<` or `<<-`. Only a
 * simple word is modelled: `[A-Za-z0-9_]+` bare, or wrapped whole in one pair
 * of single or double quotes, or behind one backslash. Every other word is
 * complex (a backslash or quote inside it, mixed quoting, a continuation, `$`,
 * any other character), because reading it needs the shell's quote removal.
 */
interface Heredoc {
  readonly delimiter: string;
  readonly form: "unquoted" | "quoted" | "complex";
  /** `<<-`: leading tabs are stripped from each body line, the delimiter line included. */
  readonly strip: boolean;
  /** The index in `commands` of the command that reads it. */
  readonly at: number;
}

/** The characters that end a shell word: a blank, a newline or a metacharacter. */
const WORD_END = "(?=[ \\t\\n;|&<>()]|$)";
const SIMPLE_DELIMITERS: readonly { readonly form: "unquoted" | "quoted"; readonly re: RegExp }[] = [
  { form: "unquoted", re: new RegExp(`^([A-Za-z0-9_]+)${WORD_END}`) },
  { form: "quoted", re: new RegExp(`^'([A-Za-z0-9_]+)'${WORD_END}`) },
  { form: "quoted", re: new RegExp(`^"([A-Za-z0-9_]+)"${WORD_END}`) },
  { form: "quoted", re: new RegExp(`^\\\\([A-Za-z0-9_]+)${WORD_END}`) },
];

/** The delimiter word that starts at `from` (after `<<`): its form, and for a simple word the text of its terminator line. */
function heredocDelimiter(command: string, from: number): Omit<Heredoc, "at"> {
  let k = from;
  const strip = command[k] === "-";
  if (strip) k++;
  while (command[k] === " " || command[k] === "\t") k++;
  const rest = command.slice(k);
  for (const { form, re } of SIMPLE_DELIMITERS) {
    const m = re.exec(rest);
    if (m !== null) return { delimiter: m[1]!, form, strip };
  }
  return { delimiter: "", form: "complex", strip };
}

/**
 * Split one shell command into simple commands, honouring quotes, and report
 * every operator seen (including a bare `(` that ends no command), so a caller
 * can refuse structures it does not model. A `&` inside a redirect (`2>&1`,
 * `&>file`) is part of the word. A here-document's body, the lines after the
 * newline that ends its command, is never split into commands: under a simple
 * quoted delimiter (`<<'X'`, `<<"X"`, `<<\X`) the shell never expands it, so it
 * is data and is dropped; under an unquoted one it can carry `$(...)`, so it is
 * appended to its command's skeleton unblanked, fail-closed. Under a complex
 * delimiter its end is not known, so everything after it stays on the
 * skeleton, fail-closed, and the command is flagged.
 */
export function shellSequence(command: string): { readonly commands: readonly ShellCommand[]; readonly operators: readonly string[] } {
  const commands: ShellCommand[] = [];
  const operators: string[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let bare = "";
  let live: string[] = [];
  let heredoc = false;
  let heredocComplex = false;
  let heredocUnquoted = false;
  let pending: Heredoc[] = [];
  const endWord = (): void => { if (inWord) { words.push(word); word = ""; inWord = false; } };
  const endCommand = (sep: string): void => {
    endWord();
    if (words.length > 0) commands.push({ words, sep, bare: (bare + sep).trim(), live, heredoc, heredocComplex, heredocUnquoted });
    words = []; bare = ""; live = []; heredoc = false; heredocComplex = false; heredocUnquoted = false;
    if (sep) operators.push(sep);
  };
  /** Consume the pending bodies from `from`, in order; returns the index after the last one. */
  const readBodies = (from: number): number => {
    let pos = from;
    for (const h of pending) {
      const body: string[] = [];
      if (h.form === "complex") { body.push(command.slice(pos)); pos = command.length; }
      while (pos < command.length) {
        const nl = command.indexOf("\n", pos);
        const end = nl < 0 ? command.length : nl;
        const line = command.slice(pos, end);
        pos = end + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delimiter) break;
        body.push(line);
      }
      const target = commands[h.at];
      if (h.form !== "quoted" && target !== undefined) commands[h.at] = { ...target, bare: `${target.bare}\n${body.join("\n")}` };
    }
    pending = [];
    return Math.min(pos, command.length);
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && command[i - 1] !== "<") {
      const h: Heredoc = { ...heredocDelimiter(command, i + 2), at: commands.length };
      pending.push(h);
      heredoc = true;
      if (h.form === "complex") heredocComplex = true;
      if (h.form === "unquoted") heredocUnquoted = true;
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const stop = close < 0 ? command.length : close;
      word += command.slice(i + 1, stop); inWord = true; i = stop; bare += "''"; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let marks = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) { word += command[j + 1]; j += 2; continue; }
        if (command[j] === "`") {
          marks += "`";
          const close = command.indexOf("`", j + 1);
          const stop = close < 0 ? command.length : close;
          live.push(command.slice(j + 1, stop));
          word += command.slice(j, Math.min(stop + 1, command.length)); j = stop + 1; continue;
        }
        if (command[j] === "$" && command[j + 1] === "(") {
          marks += "$(";
          const stop = substitutionEnd(command, j + 2);
          live.push(command.slice(j + 2, stop));
          word += command.slice(j, Math.min(stop + 1, command.length)); j = stop + 1; continue;
        }
        word += command[j]; j++;
      }
      inWord = true; i = j; bare += `"${marks}"`; continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      if (command[i + 1] === "\n") { i++; continue; }
      word += command[i + 1]; inWord = true; i++; bare += "_"; continue;
    }
    if (ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) { word += ch; inWord = true; bare += ch; continue; }
    // A `|` right after `>`, `>&` or `>>&` belongs to the redirection (`>|`, `>&|`, `>>&|`), never a pipe; `|&` stays a pipe.
    if (ch === "|" && (bare.endsWith(">") || bare.endsWith(">&"))) { word += ch; inWord = true; bare += ch; continue; }
    // `{name}>` opens a named descriptor: the brace starts a word, not a group.
    if (ch === "{" && !inWord && /^\{[A-Za-z_][A-Za-z0-9_]*\}[<>]/.test(command.slice(i, i + 64))) { word += ch; inWord = true; bare += ch; continue; }
    if (ch === "&" || ch === "|" || ch === ";") {
      const two = command[i + 1] === ch;
      if (two) i++;
      endCommand(two ? ch + ch : ch);
      continue;
    }
    if (ch === "\n" && pending.length > 0) { endCommand(ch); i = readBodies(i + 1) - 1; continue; }
    if (ch === "\n" || ch === "(" || ch === ")" || ((ch === "{" || ch === "}") && !inWord)) { endCommand(ch); continue; }
    if (ch === " " || ch === "\t") { endWord(); bare += " "; continue; }
    if (ch === "#" && !inWord) { const nl = command.indexOf("\n", i); i = nl < 0 ? command.length : nl - 1; continue; }
    word += ch; inWord = true; bare += ch;
  }
  endCommand("");
  return { commands, operators };
}

/**
 * The index of the `)` that closes a `$(` whose body starts at `from`,
 * counting nested parentheses outside quotes, or the end of the text.
 */
function substitutionEnd(text: string, from: number): number {
  let depth = 1;
  for (let k = from; k < text.length; k++) {
    const ch = text[k]!;
    if (ch === "\\") { k++; continue; }
    if (ch === "'") { const close = text.indexOf("'", k + 1); if (close < 0) return text.length; k = close; continue; }
    if (ch === '"') {
      let m = k + 1;
      while (m < text.length && text[m] !== '"') m += text[m] === "\\" ? 2 : 1;
      k = m; continue;
    }
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return k;
  }
  return text.length;
}

/** Split one shell command into simple-command word lists, honouring quotes. Operators and newlines separate commands. */
export function shellCommands(command: string): string[][] {
  return shellSequence(command).commands.map((c) => [...c.words]);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const baseName = (w: string): string => w.replace(/^.*\//, "");
/** POSIX single-quoting: the word reaches a shell as one literal argument. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** How many words one option takes under a spec (1 or 2), or null when the spec does not know it. */
function optionWidth(w: string, spec: WrapperSpec): 1 | 2 | null {
  const eq = /^(--[^=]+)=/.exec(w);
  if (eq) return spec.value.has(eq[1]!) ? 1 : null;
  if (spec.value.has(w)) return 2;
  if (spec.flags.has(w) || spec.attached?.test(w)) return 1;
  if (/^-[A-Za-z]{2,}$/.test(w) && [...w.slice(1)].every((c) => spec.flags.has(`-${c}`))) return 1;
  return null;
}

/** Skip a wrapper's options from `i`. The first option the spec does not know is reported: it may hide the command. */
function skipOptions(words: readonly string[], i: number, spec: WrapperSpec): { readonly next: number; readonly unknown: string | null } {
  let unknown: string | null = null;
  while (i < words.length) {
    const w = words[i]!;
    if (w === "--") return { next: i + 1, unknown };
    if (!w.startsWith("-") || (w === "-" && !spec.flags.has("-"))) break;
    const width = optionWidth(w, spec);
    if (width === null) unknown ??= w;
    i += width ?? 1;
  }
  return { next: i, unknown };
}

interface Unwrapped {
  readonly argv: readonly string[];
  /** A command string run by a nested shell (`sh -c`) or split by `env -S`; scanned in its place. */
  readonly inner: string | null;
  /** Why the segment cannot be read with confidence: an unknown wrapper option or a control structure. */
  readonly ambiguous: string | null;
  /** A wrapper changed the working directory (`env -C`, `sudo -D`). */
  readonly chdir: boolean;
}

/** Strip assignments, reserved words and wrappers (`env`, `timeout 5`, `nohup` ...) down to the executable and its arguments. */
function unwrap(words: readonly string[]): Unwrapped {
  let i = 0;
  let ambiguous: string | null = null;
  let chdir = false;
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i]!)) i++;
    const w = words[i];
    if (w === undefined) return { argv: [], inner: null, ambiguous, chdir };
    if (RESERVED.has(w)) { ambiguous ??= `shell control structure (${w})`; i++; continue; }
    const base = baseName(w);
    if (base === "env") {
      i++;
      for (;;) {
        while (i < words.length && ASSIGNMENT.test(words[i]!)) i++;
        const o = words[i];
        if (o === undefined || !o.startsWith("-")) break;
        if (o === "--") { i++; break; }
        const split = o === "-S" || o === "--split-string" ? words[i + 1] ?? ""
          : o.startsWith("--split-string=") ? o.slice("--split-string=".length)
          : /^-S./.test(o) ? o.slice(2)
          : null;
        if (split !== null) {
          const after = i + (o === "-S" || o === "--split-string" ? 2 : 1);
          return { argv: [], inner: [split, ...words.slice(after).map(shellQuote)].join(" "), ambiguous, chdir };
        }
        if (/^(-C|--chdir)(=|$)|^-C./.test(o)) chdir = true;
        const width = optionWidth(o, ENV_SPEC);
        if (width === null) ambiguous ??= `env option ${o}`;
        i += width ?? 1;
      }
      continue;
    }
    // `command -v` and `command -V` only look a name up; nothing runs. `command pytest` and `command -p pytest` still run it.
    if (base === "command") {
      const rest = words.slice(i + 1);
      const end = rest.findIndex((x) => x === "--" || !x.startsWith("-"));
      if ((end < 0 ? rest : rest.slice(0, end)).some((x) => /^-[pvV]*[vV][pvV]*$/.test(x))) return { argv: [], inner: null, ambiguous, chdir };
    }
    const spec = WRAPPERS[base];
    if (spec) {
      if (base === "sudo" && words.slice(i + 1).some((x) => /^(-D|--chdir)(=|$)|^-D./.test(x))) chdir = true;
      const r = skipOptions(words, i + 1, spec);
      if (r.unknown) ambiguous ??= `${base} option ${r.unknown}`;
      i = r.next + (spec.operands ?? 0);
      continue;
    }
    if (/^(ba|z|da|k)?sh$/.test(base)) {
      const c = words.indexOf("-c", i + 1);
      const lc = words.findIndex((x, k) => k > i && /^-[a-z]*c[a-z]*$/.test(x));
      const at = c >= 0 ? c : lc;
      return { argv: words.slice(i), inner: at >= 0 ? (words[at + 1] ?? null) : null, ambiguous, chdir };
    }
    return { argv: words.slice(i), inner: null, ambiguous, chdir };
  }
}

/**
 * The executable's subcommand: the first word that is not an option or a
 * known option's value. `unknownBefore` says an unlisted option came first,
 * which may have taken the word read as the subcommand as its value.
 */
function subcommand(bin: string, args: readonly string[]): { readonly sub: string; readonly unknownBefore: boolean; readonly rest: readonly string[] } {
  const takesValue = VALUE_OPTIONS[bin] ?? new Set<string>();
  let unknownBefore = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") return { sub: args[k + 1] ?? "", unknownBefore, rest: args.slice(k + 2) };
    if (!a.startsWith("-") || a === "-m") return { sub: a, unknownBefore, rest: args.slice(k + 1) };
    if (takesValue.has(a)) { k++; continue; }
    if (/^--[^=]+=/.test(a)) continue;
    unknownBefore = true;
  }
  return { sub: "", unknownBefore, rest: [] };
}

/** Node options that consume the next word. */
const NODE_VALUE_OPTIONS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--input-type", "--env-file", "--title", "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-timeout", "--run"]);

/**
 * Node's own mode, read from the options before the script: `test` for
 * `--test` (the built-in test runner), `run` for `--run <script>`
 * (a package.json script), `eval` for `-e`/`-p`. `unknownBefore` is true when
 * an unlisted option precedes a word that may be its value, and `--test`
 * appears after that word: the parser cannot tell whether it is Node's.
 */
function nodeMode(args: readonly string[]): { mode: "test" | "run" | "eval" | null; runScript: string; unknownBefore: boolean } {
  let unknown = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--test" || a.startsWith("--test=")) return { mode: "test", runScript: "", unknownBefore: false };
    if (a === "--run") return { mode: "run", runScript: args[k + 1] ?? "", unknownBefore: false };
    if (a.startsWith("--run=")) return { mode: "run", runScript: a.slice("--run=".length), unknownBefore: false };
    if (/^(-e|--eval|-p|--print)$/.test(a) || /^--(eval|print)=/.test(a)) return { mode: "eval", runScript: "", unknownBefore: false };
    if (a === "--") break;
    if (!a.startsWith("-")) {
      const later = args.slice(k + 1).some((w) => w === "--test" || w.startsWith("--test=") || w === "--run");
      return { mode: null, runScript: "", unknownBefore: unknown && later };
    }
    if (NODE_VALUE_OPTIONS.has(a)) { k++; continue; }
    if (a.startsWith("--") && a.includes("=")) continue;
    unknown = true;
  }
  return { mode: null, runScript: "", unknownBefore: false };
}

/**
 * `execution` when argv installs, tests, builds or serves; `review` when an
 * unlisted option may be hiding such a subcommand; null otherwise.
 */
function classifyExecution(argv: readonly string[]): "execution" | "review" | null {
  const bin = baseName(argv[0] ?? "");
  if (/^node(js)?$/.test(bin)) {
    const n = nodeMode(argv.slice(1));
    if (n.mode === "test" || n.mode === "run") return "execution";
    return n.unknownBefore ? "review" : null;
  }
  const rules = EXEC_RULES.filter((r) => r.bin.test(bin));
  if (rules.length === 0) return null;
  const s = subcommand(bin, argv.slice(1));
  if (rules.some((r) => r.sub === null || r.sub.test(s.sub))) return "execution";
  if (s.unknownBefore && s.rest.some((w) => rules.some((r) => r.sub !== null && r.sub.test(w)))) return "review";
  return null;
}

export interface ExecutionHit {
  readonly call: EvalCall;
  readonly segment: string;
  /** `review`: a construct the parser cannot see through. Never treated as clean. */
  readonly kind: "execution" | "review";
}

/**
 * The skill's own `codex exec` options that take a value, as a separate word or after `=` (long forms), and nothing that
 * can widen execution. Deliberately absent, so unknown and refusing in any spelling: `-o`/`--output-last-message` (they
 * write a file), `-c`/`--config` and `-p`/`--profile` (they can configure an MCP server subprocess). `--sandbox`/`-s`
 * is allowed only with the value `read-only`.
 */
const CODEX_EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--output-schema", "-m", "--model", "-C", "--cd", "-s", "--sandbox", "-i", "--image", "--color"]);
/** `codex exec` flags that take no value. Any other option (`--full-auto` raises the sandbox) is unknown and refuses. */
const CODEX_EXEC_FLAGS: ReadonlySet<string> = new Set(["--ephemeral", "--skip-git-repo-check", "--json"]);
/** The only sandbox value the exemption accepts. */
const sandboxOption = (option: string): boolean => option === "-s" || option === "--sandbox";
/** A redirection word as the tokenizer keeps it (`<<PLAN`, `2>/dev/null`, `&>log`). */
const REDIRECTION_WORD = /^(?:\d*[<>]|&>)/;

/**
 * Whether a simple command is a DIRECT `codex exec` (its first word is `codex` by basename: no wrapper, no leading
 * assignment) whose only positional operand, once its options and their values are parsed and `--` ends them, is
 * exactly `-`: the prompt is read from stdin. An unknown option, a missing value or any other positional is not.
 */
function codexExecReadsStdin(words: readonly string[]): boolean {
  if (baseName(words[0] ?? "") !== "codex" || words[1] !== "exec") return false;
  const positional: string[] = [];
  for (let i = 2; i < words.length; i++) {
    const word = words[i]!;
    if (REDIRECTION_WORD.test(word)) continue;
    if (word === "--") { positional.push(...words.slice(i + 1).filter((w) => !REDIRECTION_WORD.test(w))); break; }
    if (word === "-" || !word.startsWith("-")) { positional.push(word); continue; }
    const eq = word.indexOf("=");
    if (word.startsWith("--") && eq > 0 && CODEX_EXEC_VALUE_OPTIONS.has(word.slice(0, eq))) {
      if (sandboxOption(word.slice(0, eq)) && word.slice(eq + 1) !== "read-only") return false;
      continue;
    }
    if (CODEX_EXEC_VALUE_OPTIONS.has(word)) {
      const value = words[i + 1];
      if (value === undefined || REDIRECTION_WORD.test(value)) return false;
      if (sandboxOption(word) && value !== "read-only") return false;
      i++;
      continue;
    }
    if (!CODEX_EXEC_FLAGS.has(word)) return false;
  }
  return positional.length === 1 && positional[0] === "-";
}

/** Shell commands that run a build, test, install or dev server, from every call including nested agents'. Reading a manifest never matches. */
export function executionCalls(calls: readonly EvalCall[]): ExecutionHit[] {
  const hits: ExecutionHit[] = [];
  // One classification per simple command: a construct is matched on the
  // command's unquoted skeleton, so a quoted multi-line payload is one command.
  // A nested shell's string is judged once, inside; outside, only the
  // wrapper's own words (everything but that string) are.
  const scan = (call: EvalCall, cmd: string, depth: number): void => {
    for (const { words, bare, heredoc, heredocComplex, heredocUnquoted } of shellSequence(cmd).commands) {
      const { argv, inner, ambiguous } = unwrap(words);
      const residue = inner === null ? bare : words.filter((w) => w !== inner).join(" ");
      // The skill's own review command (setup-flow.md): a direct `codex exec ... -` with its prompt on stdin from a
      // here-document whose every delimiter is simple and quoted. That body is data, so the `<<` alone is no unparsed
      // construct; a wrapper, any other operand layout, or any other construct in the command (`$(`, `<(`, a backtick,
      // an unquoted or complex delimiter) keeps the review mark.
      const quotedCodexPrompt = inner === null && heredoc && !heredocComplex && !heredocUnquoted && codexExecReadsStdin(words);
      const skeleton = quotedCodexPrompt ? residue.replace(/(?<!<)<<(?!<)/g, "") : residue;
      const executable = inner === null ? unsupportedArgv(argv) : null;
      // A here-document an interpreter reads is a script the checks cannot read, quoted delimiter or not.
      const interpreter = heredoc && inner === null && HEREDOC_INTERPRETERS.test(baseName(argv[0] ?? "")) ? baseName(argv[0]!) : null;
      // tee is read on the unwrapped argv too, so a quoted executable name cannot hide it from the skeleton.
      const redirect = fileRedirect(bare) || (inner === null && baseName(argv[0] ?? "") === "tee");
      const reasons = [...(interpreter !== null ? [`heredoc into ${interpreter}`] : []), ...(heredocComplex ? ["complex here-document delimiter"] : []), ...(redirect ? ["file redirect, target not resolved"] : [])];
      if (reasons.length > 0) hits.push({ call, segment: `${residue} [${reasons.join("; ")}]`, kind: "review" });
      else if (UNSUPPORTED_SYNTAX.test(skeleton)) hits.push({ call, segment: residue, kind: "review" });
      else if (executable !== null) hits.push({ call, segment: `${argv.join(" ")} [${executable}]`, kind: "review" });
      if (ambiguous !== null) hits.push({ call, segment: `${words.join(" ")} [${ambiguous}]`, kind: "review" });
      if (inner !== null) {
        if (depth >= 3) hits.push({ call, segment: words.join(" "), kind: "review" });
        else scan(call, inner, depth + 1);
        continue;
      }
      if (argv.length === 0) continue;
      const kind = classifyExecution(argv);
      if (kind !== null) hits.push({ call, segment: argv.join(" "), kind });
    }
  };
  for (const call of calls) {
    const cmd = commandOf(call);
    if (cmd !== null) scan(call, cmd, 0);
  }
  return hits;
}

// --- client turns ------------------------------------------------------------------

export interface TurnSpec {
  readonly client: "claude" | "codex";
  readonly model: string;
  readonly project: string;
  /** Claude's fixed options (model, output format, MCP config, budget, tool limits). */
  readonly claudeArgs: readonly string[];
  readonly sessionId: string | null;
  readonly first: boolean;
}

/**
 * The client argv for one owner turn. `--` ends option parsing before the
 * prompt on every form, so an owner answer that starts with `-` (a list item,
 * `- `) reaches the client as the prompt, never as an option.
 */
export function turnArgs(t: TurnSpec, prompt: string): string[] {
  if (t.client === "claude") return ["-p", ...t.claudeArgs, ...(t.first ? ["--session-id", t.sessionId!] : ["--resume", t.sessionId!]), "--", prompt];
  const common = ["--json", "--model", t.model, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
  return t.first ? ["exec", ...common, "-C", t.project, "--", prompt] : ["exec", "resume", t.sessionId!, ...common, "--", prompt];
}

// --- stop points -------------------------------------------------------------------

export type StopKind = "discovery" | "package" | "review-unavailable" | "semantic" | "none";

const PACKAGE_OPTIONS = ["Approve setup", "Adjust the plan", "Inspect details"] as const;

/** The opening source marker a citation may carry (`Source:`, `See`, `Per`, `This comes from`). */
const CITATION_MARKER = /^(?:\*\*|_)?(?:sources?|references?|see|per|this (?:confirmation )?comes from)\b/i;
/** A markdown link: its label stays as words, only the URL part is removed. */
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
/**
 * A file path token in an explicit citation form: rooted at `/`, `./`, `~/`
 * or `.story/` with an extension on the last segment (`.story/config.json`,
 * `/tmp/x/setup-flow.md`), or a bare `.md` or `.json` name with no slash.
 * `yes/no`, `Next.js` and `Node.js/Next.js` are words, not paths.
 */
const isPathToken = (token: string): boolean =>
  (/^(?:\/|\.\/|~\/|\.story\/)/.test(token) && /\.[A-Za-z0-9]+$/.test(token.split("/").pop() ?? "")) || /^[\w.-]+\.(?:md|json)$/i.test(token);
/** Wrapping a token may carry (quotes, code ticks, emphasis, brackets, closing punctuation). */
const TOKEN_WRAP = /^[`"'“‘*_([]+|[`"'”’*_)\].,;:!]+$/g;
/** The connective words a citation may carry around its links and paths; any other word is residue. */
const CITATION_WORDS: ReadonlySet<string> = new Set(["the", "a", "this", "story", "skill", "skill's", "file", "document", "guidance", "from"]);
/**
 * The stop rule this build applies, recorded in every packet so a later
 * change to what counts as a clean ending is visible in the record.
 */
export const STOP_RULE_VERSION = "2026-09-27.16: a trailing paragraph without a question mark is dropped only when nothing remains after its opening marker, link URLs (labels stay as words), file path tokens (rooted at /, ./, ~/ or .story/ with an extended last segment, or a bare .md/.json name), punctuation and the connective allowlist; a package is clean only when its closing paragraph is the option list (an optional single prefix line that is the skill's package question verbatim or one listed selection question, then exactly the three option lines, each one label as a list item or bare, then nothing) or is exactly one listed selection question (one sentence, case-folded, emphasis and trailing punctuation stripped), otherwise semantic, whatever options it names; a pending structured question preceded by any non-empty main-agent text (every text block before it, in any message, and the result text) is semantic (candidate package when the question renders the package, otherwise discovery), the preceding prose never validated; a question is read through trailing emphasis; a discovery stop is never clean: any question mark in an ending without the package options is semantic with candidate discovery, none without one; a stop that classifies only with a residue paragraph removed is semantic, routed on its candidate and ruled by the judge; package labels as whole phrases, case- and emphasis-insensitive, all three; a semantic stop's candidate is read from its last question-bearing paragraph (a ? ending a sentence, through closing emphasis, quotes or brackets) to the end: package when that text names \"approve setup\" as a whole phrase, review-unavailable when it offers retry and continuing without independent review, otherwise discovery; an older package above that question never decides the route, except that a question paragraph immediately after a paragraph carrying the three option labels as lines routes package when its last question sentence, stripped of closing punctuation, is a listed selection form, alone or followed by a comma suffix that only cites (citation-only, or one leading per, given, according to or see, then at least one link or path and only punctuation and the connective allowlist, a link's label dropped), commentary after that sentence allowed";

/**
 * A paragraph that only cites where the question came from: it asks nothing,
 * and once its opening marker, every link URL (the label stays), every file
 * path token (see `isPathToken`), punctuation and the
 * connective words in `CITATION_WORDS` are removed, nothing remains. It must
 * carry a marker, a link or a path. Any residue at all keeps the paragraph in
 * the ending; whether that residue matters is the judge's ruling, not ours.
 */
export function isCitationOnly(paragraph: string): boolean {
  if (paragraph.includes("?")) return false;
  let rest = paragraph.trim().replace(/’/g, "'");
  const marked = CITATION_MARKER.test(rest);
  rest = rest.replace(CITATION_MARKER, " ");
  const linked = rest.match(MARKDOWN_LINK) !== null;
  rest = rest.replace(MARKDOWN_LINK, " $1 ");
  let pathed = false;
  rest = rest.split(/\s+/).map((token) => {
    if (!isPathToken(token.replace(TOKEN_WRAP, ""))) return token;
    pathed = true;
    return " ";
  }).join(" ");
  if (!marked && !linked && !pathed) return false;
  const words = rest.replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "").toLowerCase()).filter(Boolean);
  return words.every((w) => CITATION_WORDS.has(w));
}

/** Drop citation-only paragraphs that follow the last paragraph asking something. */
function withoutTrailingNotes(paragraphs: readonly string[]): readonly string[] {
  let end = paragraphs.length;
  while (end > 1 && isCitationOnly(paragraphs[end - 1]!)) end--;
  return paragraphs.slice(0, end);
}

/** Lowercase, markdown emphasis removed, whitespace collapsed: a label is matched as prose, not as exact text. */
const normalized = (text: string): string => text.replace(/\*\*|__|[*_]/g, "").replace(/\s+/g, " ").toLowerCase();
/** Whether `text` names a package option as a whole phrase. */
const namesOption = (text: string, option: string): boolean =>
  new RegExp(`(^|[^a-z])${option.toLowerCase()}([^a-z]|$)`).test(normalized(text));

/** Whether text ends by asking: a closing `?`, through any trailing markdown emphasis. */
const asks = (text: string): boolean => /\?$/.test(text.trim().replace(/(?:\*\*|__|[*_])+$/, "").trimEnd());

/** The complete selection questions a package may close with, case-folded, emphasis and trailing punctuation stripped. */
const SELECTION_FORMS: ReadonlySet<string> = new Set([
  "which would you like", "which one would you like", "which would you like to do", "what would you like to do", "how would you like to proceed",
  "which option do you prefer", "which do you prefer", "which one should we pick", "which should we do",
]);

/** A paragraph's sentences, case-folded, emphasis stripped and whitespace collapsed. */
const sentencesOf = (paragraph: string): string[] => normalized(paragraph).trim().split(/(?<=[.?!])\s+/).filter(Boolean);

const LIST_MARKER = /^(?:[-*+•]|\d+[.)])\s+/;

/** The package option a line is, as a list item or a bare label with nothing else on the line, or null. */
function optionOfLine(line: string): string | null {
  const text = normalized(line.trim().replace(LIST_MARKER, "")).trim();
  return PACKAGE_OPTIONS.find((o) => o.toLowerCase() === text) ?? null;
}

/** The skill's own package question (setup-flow.md), exactly as `questionText` renders it. */
const PACKAGE_QUESTION = "How should I proceed with this setup?";

/**
 * Whether a closing paragraph IS the option list: an optional single prefix line that is the skill's package
 * question or one listed selection question, then exactly the three option lines, then nothing.
 */
function isOptionList(paragraph: string): boolean {
  const lines = paragraph.split("\n").map((l) => l.trim()).filter(Boolean);
  const list = lines.length === PACKAGE_OPTIONS.length + 1 && (lines[0] === PACKAGE_QUESTION || isSelectionQuestion(lines[0]!)) ? lines.slice(1) : lines;
  if (list.length !== PACKAGE_OPTIONS.length) return false;
  const named = new Set(list.map(optionOfLine));
  return !named.has(null) && named.size === PACKAGE_OPTIONS.length;
}

/** Whether a closing paragraph is exactly one selection question from `SELECTION_FORMS`: one sentence, no added words, no other order. */
function isSelectionQuestion(paragraph: string): boolean {
  const sentences = sentencesOf(paragraph);
  if (sentences.length !== 1) return false;
  const form = (sentences[sentences.length - 1] ?? "").replace(/[\s.?!]+$/, "");
  return SELECTION_FORMS.has(form);
}

/** The strict kind of an ending already split into paragraphs: it must END by asking the owner. */
function endingKind(paragraphs: readonly string[]): StopKind {
  const tail = paragraphs.slice(-2).join("\n");
  const lastLine = paragraphs.join("\n").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (PACKAGE_OPTIONS.every((o) => namesOption(tail, o)) && PACKAGE_OPTIONS.some((o) => namesOption(lastLine, o) || asks(lastLine))) return "package";
  if (/continue without (an )?independent review/i.test(tail) && /retry/i.test(tail) && (asks(lastLine) || /continue without|retry/i.test(lastLine))) return "review-unavailable";
  return "none";
}

/** Whether a paragraph asks: a `?` ending a sentence, through closing emphasis, quotes or brackets (a URL query is not a question). */
const hasQuestion = (paragraph: string): boolean => /\?[*_"'”’)\]]*(?=\s|$)/.test(paragraph);

/** Whether a paragraph carries the three option labels as lines of their own (list items or bare), in any order, other lines allowed. */
function hasOptionLines(paragraph: string): boolean {
  const named = new Set(paragraph.split("\n").map(optionOfLine).filter((o) => o !== null));
  return named.size === PACKAGE_OPTIONS.length;
}

/**
 * Whether a comma suffix on a selection question only cites: citation-only as a paragraph, or one leading citation
 * word (per, given, according to, see) followed by at least one link or path and nothing else but punctuation and
 * the connective allowlist, a link's label dropped with its URL. "Node.js/Next.js" offers a different choice: residue.
 */
function citesOnly(suffix: string): boolean {
  const text = suffix.trim().replace(/[\s.?!]+$/, "");
  if (isCitationOnly(text)) return true;
  const lead = /^(?:per|given|according to|see)\s+/i.exec(text);
  if (lead === null) return false;
  let cited = false;
  const rest = text.slice(lead[0].length).replace(MARKDOWN_LINK, () => { cited = true; return " "; }).split(/\s+/).map((token) => {
    if (!isPathToken(token.replace(TOKEN_WRAP, ""))) return token;
    cited = true;
    return " ";
  }).join(" ");
  const words = rest.replace(/’/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "").toLowerCase()).filter(Boolean);
  return cited && words.every((w) => CITATION_WORDS.has(w));
}

/**
 * Whether a question paragraph asks the owner to choose among options just shown: its LAST question sentence,
 * stripped of closing punctuation, is a listed selection form, or one followed by a comma suffix that only cites
 * (see `citesOnly`). Commentary after that question is allowed ("Which would you like? I recommend approving.");
 * an earlier selection sentence never decides it ("Which would you like? Before deciding, which laptop OS will the
 * volunteers use?"), and a question on a new subject ("Should I deploy now?") is not one.
 */
function asksSelection(paragraph: string): boolean {
  const questions = sentencesOf(paragraph).map((sentence) => sentence.replace(/[*_"'”’)\]\s]+$/, "")).filter((sentence) => sentence.endsWith("?"));
  const selects = (question: string): boolean => {
    const text = question.replace(/[\s?!.]+$/, "");
    const comma = text.indexOf(",");
    const head = (comma < 0 ? text : text.slice(0, comma)).replace(/[\s.?!]+$/, "");
    return SELECTION_FORMS.has(head) && (comma < 0 || citesOnly(text.slice(comma + 1)));
  };
  const last = questions[questions.length - 1];
  return last !== undefined && selects(last);
}

/** A semantic stop's candidate, read from its last question and everything after it. */
function questionCandidate(text: string): StopKind {
  if (namesOption(text, "Approve setup")) return "package";
  if (/continue without (an )?independent review/i.test(text) && /retry/i.test(text)) return "review-unavailable";
  return "discovery";
}

/** A stop as read: its kind and, for a semantic stop, the kind it would be without the trailing paragraphs the judge must rule on. */
export interface StopReading {
  readonly kind: StopKind;
  readonly candidate: StopKind | null;
}

/**
 * What the turn stopped at, read from its terminal interaction only (see
 * `EvalTurn.stopText`). Each kind requires that interaction to END by asking
 * the owner: the last paragraph must carry the question or the options, so a
 * package shown mid-turn and followed by other text is not a package.
 * Citation-only paragraphs after that question are dropped (see
 * `isCitationOnly`). When the ending classifies only once trailing paragraphs
 * with residue are removed, the stop is `semantic`: the harness cannot tell
 * whether that residue answers, redirects or merely cites, so the run routes
 * on the candidate and the judge rules on the verbatim ending.
 */
export function readStop(stopText: string): StopReading {
  const all = stopText.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const paragraphs = withoutTrailingNotes(all);
  const kind = endingKind(paragraphs);
  // A package is clean in exactly two shapes: the closing paragraph is the option list, or it is exactly one listed
  // selection question. Any other closing paragraph, option-bearing or not (a citation, a deploy, a stack choice, a choice
  // made for the owner, a line above the list), may do something else: only the judge can say.
  const last = paragraphs[paragraphs.length - 1] ?? "";
  if (kind === "package" && (isOptionList(last) || isSelectionQuestion(last))) return { kind, candidate: null };
  if (kind === "review-unavailable") return { kind, candidate: null };
  // Semantic from here. The owner answers the LAST question, so an older package above it never decides the route:
  // a question offering "approve setup" is the package question however its other labels are worded (attempt 5 runs 2
  // and 5), and a new question after a package is not the package.
  const asked = paragraphs.map(hasQuestion).lastIndexOf(true);
  if (asked >= 0) {
    // A selection question right after the option list still refers to those options, whatever prose or citation it
    // adds ("Which would you like? I recommend approving."): the package, never a discovery question.
    const previous = asked > 0 ? paragraphs[asked - 1]! : "";
    if ((isOptionList(previous) || hasOptionLines(previous)) && asksSelection(paragraphs[asked]!)) return { kind: "semantic", candidate: "package" };
    return { kind: "semantic", candidate: questionCandidate(paragraphs.slice(asked).join("\n\n")) };
  }
  if (kind === "package") return { kind: "semantic", candidate: "package" };
  for (let end = paragraphs.length - 1; end >= 1; end--) {
    const candidate = endingKind(paragraphs.slice(0, end));
    if (candidate !== "none") return { kind: "semantic", candidate };
  }
  // A discovery stop is never clean by the harness alone: no closed form separates a question that only asks from
  // one that also assumes, answers or acts, so any question in the ending without the package goes to the judge.
  if (stopText.includes("?")) return { kind: "semantic", candidate: "discovery" };
  return { kind: "none", candidate: null };
}

/**
 * A turn's stop as read. A pending structured question preceded by any
 * main-agent text is semantic: that prose is not validated here, so the judge rules on it,
 * with the candidate the question's own shape gives (package when it renders the
 * package, otherwise discovery). With no preceding text the question is read
 * like any other ending.
 */
export function readTurnStop(turn: Pick<EvalTurn, "stopText" | "pendingQuestion">): StopReading {
  const pending = turn.pendingQuestion;
  if (pending !== undefined && pending.preamble.trim() !== "") {
    const shape = readStop(pending.question);
    const candidate = shape.kind === "package" || shape.candidate === "package" ? "package" : "discovery";
    return { kind: "semantic", candidate };
  }
  return readStop(turn.stopText);
}

export function classifyStop(stopText: string): StopKind {
  return readStop(stopText).kind;
}

export interface StopCheck {
  readonly kind: StopKind;
  /** For a semantic stop, the kind the run routes on. */
  readonly candidate: StopKind | null;
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/** The kind a run routes on: a semantic stop's candidate, otherwise the stop's own kind. */
export function stopRoute(stop: Pick<StopCheck, "kind" | "candidate"> | null | undefined): StopKind | undefined {
  if (!stop) return undefined;
  return stop.kind === "semantic" ? stop.candidate ?? "none" : stop.kind;
}

/** The judge line a semantic stop requires, naming the turn whose verbatim ending is in packet.turns. */
export function semanticStopLine(label: string, candidate: StopKind): string {
  return `the ${label} turn's ending (packet.turns, label ${label}, verbatim) stops at the ${candidate} question: nothing after that question answers it, assumes an answer, instructs the owner elsewhere or acts on it`;
}

/** A pre-approval stop: the turn ended at the expected question and wrote nothing. */
export function checkStop(turn: EvalTurn, expected: readonly StopKind[]): StopCheck {
  const { kind, candidate } = readTurnStop(turn);
  const reasons: string[] = [];
  const route = stopRoute({ kind, candidate })!;
  if (!expected.includes(route)) reasons.push(`stopped at ${kind === "semantic" ? `semantic (candidate ${route})` : kind}, expected ${expected.join(" or ")}`);
  const writes = writeCalls(turn.calls);
  if (writes.length > 0) reasons.push(`wrote before approval: ${writes.map((w) => commandOf(w) ?? w.name).join("; ")}`);
  const execs = executionCalls(turn.calls);
  const ran = execs.filter((e) => e.kind === "execution");
  const unclear = execs.filter((e) => e.kind === "review");
  if (ran.length > 0) reasons.push(`executed during setup: ${ran.map((e) => (e.call.nested ? `[nested] ${e.segment}` : e.segment)).join("; ")}`);
  if (unclear.length > 0) reasons.push(`needs review, shell construct not parsed: ${unclear.map((e) => e.segment).join("; ")}`);
  return { kind, candidate, ok: reasons.length === 0, reasons };
}

// --- files on disk ------------------------------------------------------------------

/**
 * Every entry under root, never following a link: a regular file maps to its
 * sha256, a directory to "dir", a symlink to "link:<target as written>", and
 * anything else to its type. A link is therefore distinguishable from the
 * file it names, a link loop cannot recurse, and nothing outside root is read.
 */
export function treeDigest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      const rel = relative(root, p);
      if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) { out[`${rel}/`] = "dir"; walk(p); }
      else if (st.isFile()) out[rel] = sha256(readFileSync(p));
      else out[rel] = st.isFIFO() ? "fifo" : st.isSocket() ? "socket" : st.isBlockDevice() ? "block-device" : st.isCharacterDevice() ? "char-device" : "other";
    }
  };
  walk(root);
  return out;
}

export function digestChanges(before: Record<string, string>, after: Record<string, string>, exclusion?: RuntimeExclusion): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys].filter((k) => before[k] !== after[k]).sort();
  if (!exclusion) return changed;
  const excluded = changed.filter((k) => isRuntimeState(k, exclusion));
  const kept = changed.filter((k) => !excluded.includes(k));
  // A directory changed only because runtime state was minted inside it (`.story/` itself) is not a change.
  return kept.filter((k) => !(k.endsWith("/") && excluded.some((e) => e.startsWith(k)) && !kept.some((o) => o !== k && o.startsWith(k))));
}

/** The fixed runtime set under `.story/`, used when the project has no `.story/.gitignore`. */
export const RUNTIME_STATE_FIXED = ["/channel-inbox/", "/servers/", "/telemetry/", "/sessions/", "/snapshots/", "/.lock", "/.txn.json"] as const;

/**
 * Paths under `.story/` that the storybloq runtime writes on its own (presence,
 * inbox, server records, locks): not setup writes, so the pre-approval tree
 * check ignores them. Read once, before the first turn, so nothing the agent
 * writes can widen it.
 */
export interface RuntimeExclusion {
  /** `disabled`: `.story/.gitignore` holds a pattern this matcher cannot read, so nothing is excluded. */
  readonly source: ".story/.gitignore" | "fixed set" | "disabled";
  readonly patterns: readonly string[];
  /** The first `.story/.gitignore` pattern this matcher does not support, when `source` is `disabled`. */
  readonly unsupported?: string;
}

/**
 * The project's `.story/.gitignore` when every pattern in it is readable; the
 * fixed set only when that file is absent. One unsupported pattern disables
 * exclusion entirely: no fallback set stands in for a file whose meaning the
 * matcher cannot reproduce, so every changed path is reported and the judge rules.
 */
export function runtimeExclusion(project: string): RuntimeExclusion {
  const file = join(project, ".story", ".gitignore");
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (st === undefined) return { source: "fixed set", patterns: [...RUNTIME_STATE_FIXED] };
  if (!st.isFile()) return { source: "disabled", patterns: [], unsupported: ".story/.gitignore is not a regular file" };
  const patterns = readFileSync(file, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  const unsupported = patterns.find((p) => ignorePattern(p.startsWith("!") ? p.slice(1) : p) === null);
  if (unsupported === undefined) return { source: ".story/.gitignore", patterns };
  return { source: "disabled", patterns: [], unsupported };
}

/** The judge line a run with exclusion disabled requires: the packet carries every changed path and the unsupported pattern. */
export const TREE_EXCLUSION_LINE = "with .story/.gitignore exclusion disabled (the unsupported pattern is packet.harnessNormalisation.treeExclusion.unsupported), every path in packet.turns[].treeChanges is runtime state the storybloq runtime wrote on its own, and none is a setup write before approval";

/**
 * What one pre-approval tree check means for the run. With exclusion in force,
 * any reported change is a mechanical failure. With it disabled the check is
 * never clean, even with no change: the paths go to the judge instead.
 */
export function treeCheckOutcome(label: string, changes: readonly string[], exclusion: RuntimeExclusion): { readonly clean: boolean; readonly failure: string | null; readonly judge: boolean } {
  if (exclusion.source === "disabled") return { clean: false, failure: null, judge: true };
  if (changes.length > 0) return { clean: false, failure: `${label}: project changed before approval: ${changes.join(", ")}`, judge: false };
  return { clean: true, failure: null, judge: false };
}

/**
 * One gitignore pattern as a regex over a path relative to `.story/`, where
 * directory entries end in `/`; null for a form this matcher does not read
 * (a character class, an escape, `**` that is not a whole path segment).
 * A `**` segment follows gitignore: leading or inner, it matches zero or more
 * directories; trailing, everything inside.
 */
function ignorePattern(pattern: string): RegExp | null {
  if (/[[\]\\]/.test(pattern)) return null;
  const body = pattern.replace(/^\//, "").replace(/\/$/, "");
  if (body === "" || body.split("/").some((seg) => seg.includes("**") && seg !== "**")) return null;
  const anchored = pattern.startsWith("/") || body.includes("/");
  const segs = body.split("/");
  let re = "";
  segs.forEach((seg, k) => {
    const last = k === segs.length - 1;
    if (seg === "**") { re += last ? ".*" : "(?:.*/)?"; return; }
    re += seg.replace(/[.+^${}()|]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + (last ? "" : "/");
  });
  return new RegExp(`${anchored ? "^" : "(^|/)"}${re}${pattern.endsWith("/") ? "/" : "(/|$)"}`);
}

/** Whether a digest path is runtime state under the exclusion; gitignore order applies, so a later `!pattern` re-includes. */
export function isRuntimeState(rel: string, exclusion: RuntimeExclusion): boolean {
  if (!rel.startsWith(".story/")) return false;
  const sub = rel.slice(".story/".length);
  if (sub === "") return false;
  let ignored = false;
  for (const p of exclusion.patterns) {
    const negate = p.startsWith("!");
    if (ignorePattern(negate ? p.slice(1) : p)?.test(sub)) ignored = !negate;
  }
  return ignored;
}

export type TestStages =
  | { readonly kind: "disabled" }
  | { readonly kind: "enabled"; readonly command: string; readonly writeTests: boolean; readonly test: boolean }
  | { readonly kind: "abort"; readonly reason: string };

/** The guide's start-time rule over the project's recipe and stage overrides, without executing anything. */
export function resolveTestStages(config: Record<string, unknown>): TestStages {
  const recipe = typeof config.recipe === "string" ? config.recipe : "coding";
  const overrides = (config.recipeOverrides ?? {}) as { stages?: Record<string, Record<string, unknown>> };
  const resolved = resolveRecipe(recipe, { stages: overrides.stages });
  const test = resolved.stages?.TEST as Record<string, unknown> | undefined;
  const write = resolved.stages?.WRITE_TESTS as Record<string, unknown> | undefined;
  const testOn = Boolean(test?.enabled) && resolved.pipeline.includes("TEST");
  const writeOn = Boolean(write?.enabled) && resolved.pipeline.includes("WRITE_TESTS");
  if (!testOn && !writeOn) return { kind: "disabled" };
  const writeCmd = write?.command as string | undefined;
  const testCmd = test?.command as string | undefined;
  const effectiveWrite = writeCmd ?? testCmd ?? "npm test";
  const effectiveTest = testCmd ?? "npm test";
  if (testOn && writeOn && effectiveWrite !== effectiveTest) return { kind: "abort", reason: `different commands (${effectiveWrite} vs ${effectiveTest})` };
  const command = writeOn ? (writeCmd ?? testCmd) : testCmd;
  if (!command) return { kind: "abort", reason: "enabled with no command" };
  return { kind: "enabled", command, writeTests: writeOn, test: testOn };
}

export interface ExpectedRecipe {
  readonly testStages: "disabled" | "same-command" | "same-command-or-disabled" | "disabled-or-components" | "components";
  readonly command?: string;
  /**
   * For `disabled-or-components`: every part's directory; an enabled command must run each part's tests from it.
   * For check set 2 `components`: each established component (`.` is the root) with the commands accepted there.
   */
  readonly components?: readonly string[] | Readonly<Record<string, { readonly commands: readonly string[] }>>;
  /** Check set 2 `components`: every component whose test command is pending. */
  readonly pendingComponents?: readonly string[];
}

/**
 * Options that make an executable run in another directory, per executable.
 * Only these move a test run into a component: an option that merely names a
 * root for config or collection (pytest's --rootdir) does not, and neither
 * does a test path argument.
 */
const DIR_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["--prefix"]),
  pnpm: new Set(["-C", "--dir"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd"]),
  make: new Set(["-C", "--directory"]),
  go: new Set(["-C"]),
  poetry: new Set(["-C", "--directory"]),
  uv: new Set(["--directory"]),
};
/** Operators a component command may use: a plain sequence. Anything else changes scope or control flow. */
const SEQUENCE_OPERATORS = new Set(["&&", ";", "\n"]);

/** `target` resolved against `cwd` (both project-relative, "" is the root); null when it leaves the project or cannot be read. */
function resolveDir(cwd: string, target: string | undefined): string | null {
  if (target === undefined || target === "" || /^[/~$-]/.test(target)) return null;
  const joined = posix.normalize(posix.join(cwd === "" ? "." : cwd, target)).replace(/\/+$/, "");
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined === "." ? "" : joined;
}

const firstPositional = (words: readonly string[]): readonly string[] => {
  const k = words.findIndex((w) => !w.startsWith("-"));
  return k < 0 ? [] : words.slice(k);
};

/** Whether argv runs a test suite (not an install, a build or a server). */
export function isTestInvocation(argv: readonly string[], depth = 0): boolean {
  if (argv.length === 0 || depth > 3) return false;
  const bin = baseName(argv[0]!);
  const args = argv.slice(1);
  if (/^(pytest|py\.test|vitest|jest|tox|nox|rspec|phpunit|mocha|ava)$/.test(bin)) return true;
  if (/^python[0-9.]*$/.test(bin)) { const m = args.indexOf("-m"); return m >= 0 && /^(pytest|unittest|nose2)$/.test(args[m + 1] ?? ""); }
  if (/^(npx|bunx|pnpx)$/.test(bin)) return isTestInvocation(firstPositional(args), depth + 1);
  if (/^node(js)?$/.test(bin)) { const n = nodeMode(args); return n.mode === "test" || (n.mode === "run" && /^test(:|$)/.test(n.runScript)); }
  const s = subcommand(bin, args);
  if (/^(npm|pnpm|yarn|bun)$/.test(bin)) {
    if (/^(test|t)$/.test(s.sub)) return true;
    if (/^(run|run-script)$/.test(s.sub)) return /^test(:|$)/.test(firstPositional(s.rest)[0] ?? "");
    if (/^(exec|dlx|x)$/.test(s.sub)) return isTestInvocation(firstPositional(s.rest), depth + 1);
    return bin !== "npm" && /^test:/.test(s.sub);
  }
  if (bin === "playwright") return s.sub === "test";
  if (/^(uv|poetry|pipenv|hatch|pdm)$/.test(bin)) return s.sub === "test" || (s.sub === "run" && isTestInvocation(firstPositional(s.rest), depth + 1));
  if (/^(cargo|go|dotnet|swift|mix|deno|flutter|dart|gradle|gradlew|mvn|mvnw)$/.test(bin)) return s.sub === "test";
  if (bin === "make") return /^(test|check)$/.test(s.sub);
  if (bin === "rake") return /^(test|spec)$/.test(s.sub);
  if (bin === "bundle") return s.sub === "exec" && isTestInvocation(firstPositional(s.rest), depth + 1);
  return false;
}

/**
 * Problems with a multi-part test command. The command must be a plain
 * sequence (`&&`, `;`, newlines) of `cd` and simple commands: subshells,
 * groups, pipes, `||`, background jobs, control structures and wrappers that
 * change directory are refused as ambiguous. Each `cd` resolves against the
 * current directory; every TEST invocation must run inside a component (by
 * the resolved directory or a directory option), and every component must
 * have one. Installs and builds are allowed but cover nothing.
 */
/**
 * True when the only thing `componentCommandFindings` refuses in `command` is a subshell: its non-sequence
 * operators are exactly `(` and `)`, and no line uses another unsupported construct. Such a command is
 * correct shell the harness cannot place, so a regrade may put it to the judge; anything else stays a failure.
 */
export function subshellOnly(command: string): boolean {
  const odd = new Set(shellSequence(command).operators.filter((op) => !SEQUENCE_OPERATORS.has(op)));
  return odd.size === 2 && odd.has("(") && odd.has(")") && !command.split("\n").some((l) => UNSUPPORTED.test(l.trim()));
}

export function componentCommandFindings(command: string, components: readonly string[]): string[] {
  const parts = new Set(components.map((c) => resolveDir("", c) ?? c));
  const findings: string[] = [];
  const { commands, operators } = shellSequence(command);
  const odd = [...new Set(operators.filter((op) => !SEQUENCE_OPERATORS.has(op)))];
  if (odd.length > 0 || command.split("\n").some((l) => UNSUPPORTED.test(l.trim()))) {
    return [`cannot tell where \`${command}\` runs${odd.length > 0 ? ` (it uses ${odd.join(" ")})` : ""}: use a plain sequence of cd and test commands joined by && or ;`];
  }
  const covered = new Set<string>();
  let cwd: string | null = "";
  for (const { words } of commands) {
    const u = unwrap(words);
    if (u.ambiguous !== null || u.inner !== null || u.chdir) { findings.push(`cannot tell where \`${words.join(" ")}\` runs`); continue; }
    const argv = u.argv;
    if (argv.length === 0) continue;
    const bin = baseName(argv[0]!);
    if (bin === "cd") {
      cwd = cwd === null ? null : resolveDir(cwd, argv[1]);
      if (cwd === null) findings.push(`\`${argv.join(" ")}\` leaves the project or cannot be resolved`);
      continue;
    }
    if (bin === "pushd" || bin === "popd") { findings.push(`cannot tell where \`${argv.join(" ")}\` leaves the directory`); cwd = null; continue; }
    if (!isTestInvocation(argv)) continue;
    if (cwd === null) continue;
    let dir: string | null = cwd;
    const dirOptions = DIR_OPTIONS[bin] ?? new Set<string>();
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k]!;
      const eq = /^(--[a-z-]+)=(.+)$/.exec(a);
      if (eq && dirOptions.has(eq[1]!)) dir = resolveDir(cwd, eq[2]);
      else if (dirOptions.has(a) && argv[k + 1] !== undefined) dir = resolveDir(cwd, argv[k + 1]);
    }
    if (dir === null) findings.push(`\`${argv.join(" ")}\` names a directory outside the project`);
    else if (dir === "") findings.push(`\`${argv.join(" ")}\` runs at the project root, not in a component`);
    else if (!parts.has(dir)) findings.push(`\`${argv.join(" ")}\` runs in ${dir}, which is not a component`);
    else covered.add(dir);
  }
  for (const c of parts) if (!covered.has(c)) findings.push(`no test command runs in ${c}`);
  return findings;
}

export function checkRecipe(stages: TestStages, expected: ExpectedRecipe): string | null {
  if (stages.kind === "abort") return `the guide would refuse to start: ${stages.reason}`;
  if (expected.testStages === "disabled-or-components") {
    if (stages.kind === "disabled") return null;
    const f = componentCommandFindings(stages.command, Array.isArray(expected.components) ? expected.components : []);
    return f.length === 0 ? null : `component test command: ${f.join("; ")}`;
  }
  if (expected.testStages === "disabled") return stages.kind === "disabled" ? null : `expected both test stages disabled, got ${stages.command}`;
  if (stages.kind === "disabled") return expected.testStages === "same-command-or-disabled" ? null : `expected ${expected.command}, got both disabled`;
  if (expected.command && stages.command !== expected.command) return `expected ${expected.command}, got ${stages.command}`;
  return null;
}

// --- check set 2: the command-evidence contract -----------------------------------------

/** The approved quality level (setup-flow.md, 1d), as the package states it. */
export type QualityLevel = "full" | "tests-only" | "minimal";

const QUALITY_LABELS: readonly (readonly [QualityLevel, string])[] = [["full", "full pipeline"], ["tests-only", "tests only"], ["minimal", "minimal"]];

/** What may follow the level on its line: nothing, a closing period, or a delimiter (`,` `;` `:` `.` then a space, ` (`, ` - `) and a reason. */
const QUALITY_SUFFIX = /^(?:\.?$|[,;:.]\s|\s+\(|\s+-\s)/;
/** A reason that opens by negating or deferring the level it follows (`; not approved`, `(undecided)`); a later "not" inside a reason is prose. */
const QUALITY_NEGATION = /^[,;:.]?\s*[(-]?\s*(?:not|no|undecided|unapproved|rejected|tbd|to be decided|if approved|unless)\b/;

/**
 * The quality level a package approves: every line that begins `Quality level:` (list marker, emphasis and code marks
 * stripped) must name exactly one of the three immediately after the colon, followed by nothing or a delimited reason
 * that names no other level and negates nothing. Any such line that does not, or two lines naming different levels,
 * leave the level unnamed (null).
 */
export function qualityLevel(packageText: string): QualityLevel | null {
  const found = new Set<QualityLevel>();
  for (const raw of packageText.split("\n")) {
    const line = raw.trim().replace(LIST_MARKER, "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!line.startsWith("quality level:")) continue;
    const value = line.slice("quality level:".length).trim();
    const hit = QUALITY_LABELS.find(([, label]) => value.startsWith(label));
    if (hit === undefined) return null;
    const suffix = value.slice(hit[1].length);
    if (!QUALITY_SUFFIX.test(suffix)) return null;
    if (QUALITY_LABELS.some(([, label]) => suffix.includes(label)) || QUALITY_NEGATION.test(suffix)) return null;
    found.add(hit[0]);
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** A fixture's command evidence under check set 2: the established components with their accepted commands, and the pending ones. `""` is the root. */
export interface RecipeContract {
  readonly established: Readonly<Record<string, readonly string[]>>;
  readonly pending: readonly string[];
}

const componentKey = (dir: string): string => (dir === "." ? "" : resolveDir("", dir) ?? dir);
const componentName = (dir: string): string => (dir === "" ? "the root" : dir);

/** The contract a check set 2 `components` expectation states; null for any other form. */
export function recipeContract(expected: ExpectedRecipe): RecipeContract | null {
  if (expected.testStages !== "components") return null;
  const established: Record<string, readonly string[]> = {};
  const components = Array.isArray(expected.components) ? {} : (expected.components ?? {}) as Readonly<Record<string, { readonly commands: readonly string[] }>>;
  for (const [dir, spec] of Object.entries(components)) established[componentKey(dir)] = spec.commands;
  return { established, pending: (expected.pendingComponents ?? []).map(componentKey) };
}

/** The test stages a quality level uses. */
export function stagesUsed(level: QualityLevel): readonly ("WRITE_TESTS" | "TEST")[] {
  return level === "full" ? ["WRITE_TESTS", "TEST"] : level === "tests-only" ? ["TEST"] : [];
}

const SEPARATOR_NAMES: Readonly<Record<string, string>> = { "\n": "newline" };

/**
 * The shape `step (&& step)*` before any word is read: every quote closes, no escape is left dangling, and every
 * `&&` has a non-empty step on both sides (the tokenizer drops empty segments, so `&& pytest` would otherwise pass).
 */
function sequenceSyntax(command: string): string | null {
  const steps: string[] = [];
  let step = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return "the test command has an unclosed quote";
      step += command.slice(i, close + 1); i = close; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') j += command[j] === "\\" ? 2 : 1;
      if (j >= command.length) return "the test command has an unclosed quote";
      step += command.slice(i, j + 1); i = j; continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) return "the test command ends in a dangling escape";
      step += command.slice(i, i + 2); i++; continue;
    }
    if (ch === "&" && command[i + 1] === "&") { steps.push(step); step = ""; i++; continue; }
    step += ch;
  }
  steps.push(step);
  if (steps.some((x) => x.trim() === "")) return "the test command has an empty step: every `&&` joins two steps";
  return null;
}

/** Whether a command's words are exactly an accepted command's arguments, token by token (quoting that keeps each argument whole is harmless). */
function sameArgv(words: readonly string[], accepted: string): boolean {
  const want = shellCommands(accepted)[0] ?? [];
  return words.length === want.length && words.every((w, k) => w === want[k]);
}

/** Django's own runner, `python manage.py test` or `django-admin test`: a test invocation for the check set 2 grammar only. */
function isDjangoTest(argv: readonly string[]): boolean {
  const bin = baseName(argv[0] ?? "");
  if (bin === "django-admin") return argv[1] === "test";
  if (bin === "manage.py") return argv[1] === "test";
  return /^python[0-9.]*$/.test(bin) && baseName(argv[1] ?? "") === "manage.py" && argv[2] === "test";
}

/**
 * Check set 2's grammar for a test command: `step (&& step)*`, a step being `cd <dir>` or an accepted test invocation
 * in the directory it runs in. Anything else fails: another separator, a subshell or group, a redirection, an
 * environment prefix, a control word, a construct the tokenizer cannot see through, or a command that is neither.
 */
export function testCommandFindings(command: string, contract: RecipeContract): string[] {
  const syntax = sequenceSyntax(command);
  if (syntax !== null) return [syntax];
  const { commands, operators } = shellSequence(command);
  for (const c of commands) {
    if (c.heredoc || c.live.length > 0 || UNSUPPORTED_SYNTAX.test(c.bare)) return [`the test command uses shell syntax the grammar does not accept: \`${c.words.join(" ")}\``];
  }
  const group = operators.find((op) => op === "(" || op === ")" || op === "{" || op === "}");
  if (group !== undefined) return [`the test command uses shell syntax the grammar does not accept: a subshell or group (\`${group}\`)`];
  const separator = operators.find((op) => op !== "&&");
  if (separator !== undefined) return [`separator \`${SEPARATOR_NAMES[separator] ?? separator}\` is not allowed; steps are joined only by &&`];
  const accepted = Object.values(contract.established).flat();
  const pending = new Set(contract.pending);
  const findings: string[] = [];
  const covered = new Set<string>();
  let cwd: string | null = "";
  for (const { words } of commands) {
    const text = words.join(" ");
    if (words.some((w) => REDIRECTION_WORD.test(w))) { findings.push(`the test command uses shell syntax the grammar does not accept: a redirection in \`${text}\``); continue; }
    if (ASSIGNMENT.test(words[0] ?? "")) { findings.push(`an environment prefix is not allowed: \`${text}\``); continue; }
    if (RESERVED.has(words[0] ?? "")) { findings.push(`the test command uses shell syntax the grammar does not accept: \`${words[0]}\``); continue; }
    if (words[0] === "cd") {
      if (words.length !== 2) { findings.push(`\`${text}\` is not a cd step with exactly one directory`); cwd = null; continue; }
      cwd = cwd === null ? null : resolveDir(cwd, words[1]);
      if (cwd === null) findings.push(`\`${text}\` leaves the repository or cannot be resolved`);
      continue;
    }
    const testish = accepted.some((a) => sameArgv(words, a)) || isTestInvocation(words) || isDjangoTest(words);
    if (!testish) { findings.push(`\`${text}\` is not a cd step or an accepted test invocation`); continue; }
    if (cwd === null) continue;
    const commandsHere = contract.established[cwd];
    if (commandsHere !== undefined) {
      if (commandsHere.some((a) => sameArgv(words, a))) covered.add(cwd);
      else findings.push(`\`${text}\` in ${componentName(cwd)} is not an accepted runner (${commandsHere.join(", ")})`);
    } else if (pending.has(cwd)) findings.push(`\`${text}\` runs in ${componentName(cwd)}, whose test command is pending`);
    else if (cwd === "") findings.push(`\`${text}\` runs at the root, which is not a component`);
    else findings.push(`\`${text}\` runs in ${cwd}, which is not a component`);
  }
  for (const dir of Object.keys(contract.established)) if (!covered.has(dir)) findings.push(`the test command does not run ${componentName(dir)}`);
  return findings;
}

/**
 * Check set 2's recipe rule. The command comes from the established components (none: no command); the approved
 * quality level then decides activation: Full pipeline enables both stages, Tests only enables TEST, Minimal enables
 * neither, and without a command nothing is enabled.
 */
export function recipeFindings(stages: TestStages, contract: RecipeContract, level: QualityLevel | null): string[] {
  if (stages.kind === "abort") return [`the guide would refuse to start: ${stages.reason}`];
  if (level === null) return ["the approved package names no single quality level (a `Quality level:` line naming Full pipeline, Tests only or Minimal)"];
  const dirs = Object.keys(contract.established);
  if (dirs.length === 0 || level === "minimal") {
    if (stages.kind === "disabled") return [];
    return [level === "minimal" ? `Minimal expects both test stages disabled, got ${stages.command}` : `no component has an established test command, so both test stages are disabled, got ${stages.command}`];
  }
  if (stages.kind === "disabled") return [`expected test commands for ${dirs.map(componentName).join(", ")}, got both disabled`];
  const findings: string[] = [];
  if (level === "full" && !(stages.writeTests && stages.test)) findings.push("Full pipeline enables both WRITE_TESTS and TEST");
  if (level === "tests-only" && !(stages.test && !stages.writeTests)) findings.push("Tests only enables TEST and disables WRITE_TESTS");
  return [...findings, ...testCommandFindings(stages.command, contract)];
}

/** One parsed `Verification tooling to establish:` line. */
export interface PendingLine { readonly stage: string; readonly component: string; readonly merged: boolean }

const PENDING_LINE = /^Verification tooling to establish: (.+?)(?: \(([^()]+)\))?: (.+) \(pending: (.+)\)\.?$/;
const STAGE_NAMES = /\b(WRITE_TESTS|TEST|BUILD|VERIFY)\b/g;

/** Every pending-tooling line in the exact grammar (setup-flow.md, 1f), list markers and emphasis stripped. */
export function pendingLines(text: string): PendingLine[] {
  const out: PendingLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(LIST_MARKER, "").replace(/^(?:\*\*|__)|(?:\*\*|__)$/g, "").replace(/`/g, "").trim();
    const m = PENDING_LINE.exec(line);
    if (m === null) continue;
    const stages = m[1]!.match(STAGE_NAMES) ?? [];
    out.push({ stage: m[1]!.trim(), component: m[2]?.trim() ?? "", merged: stages.length > 1 });
  }
  return out;
}

/** The pending lines a summary owes: each pending component (named when the project has several) for each stage the level uses. */
export function pendingInventory(contract: RecipeContract, level: QualityLevel): { readonly stage: string; readonly component: string }[] {
  const several = Object.keys(contract.established).length + contract.pending.length > 1;
  return contract.pending.flatMap((dir) => stagesUsed(level).map((stage) => ({ stage, component: several ? dir : "" })));
}

export function pendingFindings(summary: string, inventory: readonly { readonly stage: string; readonly component: string }[]): string[] {
  const lines = pendingLines(summary);
  const findings: string[] = [];
  if (lines.some((l) => l.merged)) findings.push("pending tooling line names more than one stage");
  for (const item of inventory) {
    if (!lines.some((l) => !l.merged && l.stage === item.stage && l.component === item.component)) findings.push(`pending tooling line missing: ${item.stage}${item.component ? ` (${item.component})` : ""}`);
  }
  return findings;
}

// --- check set 2: the review status line --------------------------------------------------

export type ReviewStatus =
  | { readonly kind: "result"; readonly verdict: string; readonly ref: string }
  | { readonly kind: "skip" }
  | { readonly kind: "none" }
  | { readonly kind: "several" };

const STATUS_RESULT = /^Independent review: (.+), invocation (R[1-9][0-9]*)$/;
const STATUS_SKIP = /^Independent review: skipped at the owner's request$/;
export const NOT_RERUN = /^Review not rerun: (.+) changes no ticket's scope, dependencies or responsibilities\.$/;

/** A line as the exact forms read it: list marker, surrounding emphasis or code marks and trailing spaces stripped, a typographic apostrophe read as `'`. */
function formLine(raw: string): string {
  return raw.replace(/\s+$/, "").trim().replace(LIST_MARKER, "").replace(/^(?:\*\*|__|[*_`])+|(?:\*\*|__|[*_`])+$/g, "").replace(/’/g, "'").trim();
}

/** The review status of a package or summary: exactly one line in one of the two forms, each anchored to its whole line. */
export function reviewStatus(text: string): ReviewStatus {
  const found: ReviewStatus[] = [];
  for (const raw of text.split("\n")) {
    const line = formLine(raw);
    const r = STATUS_RESULT.exec(line);
    if (r !== null) { found.push({ kind: "result", verdict: r[1]!.trim(), ref: r[2]! }); continue; }
    if (STATUS_SKIP.test(line)) found.push({ kind: "skip" });
  }
  return found.length === 0 ? { kind: "none" } : found.length > 1 ? { kind: "several" } : found[0]!;
}

/** The `Review not rerun:` declarations in a package, as written. */
export function notRerunLines(text: string): string[] {
  return text.split("\n").map(formLine).filter((l) => NOT_RERUN.test(l));
}

// --- check set 2: a plain-text discovery turn ends at its question -----------------------------

/** What follows the last question of a plain-text discovery stop: the rest of its paragraph and every later one; "" when nothing does. */
export function discoveryTail(stopText: string): string {
  const paragraphs = stopText.split(/\n\s*\n/);
  let at = -1;
  for (let k = paragraphs.length - 1; k >= 0; k--) if (hasQuestion(paragraphs[k]!)) { at = k; break; }
  if (at < 0) return "";
  const paragraph = paragraphs[at]!;
  const marks = [...paragraph.matchAll(/\?[*_"'”’)\]]*(?=\s|$)/g)];
  const last = marks.at(-1)!;
  const rest = paragraph.slice(last.index! + last[0].length);
  return [rest, ...paragraphs.slice(at + 1)].map((x) => x.trim()).filter(Boolean).join("\n\n");
}

/** The labels every implementation ticket's description carries (setup-flow.md, 1c2), in template order. */
export const TICKET_TEMPLATE_FIELDS = ["Outcome:", "Scope:", "Excludes:", "Acceptance:", "Behaviour:", "Verification:", "Prerequisites:", "Assumptions:"] as const;
/** Labels that must say something concrete; the others may say `none`. */
const SUBSTANTIVE_FIELDS = new Set<string>(["Outcome:", "Scope:", "Acceptance:", "Verification:"]);
const NOT_APPLICABLE = /^(none|n\/a|not applicable)\.?$/i;

/** setup-flow.md's checkpoint convention: the title starts `Checkpoint:`. Nothing else makes a ticket a checkpoint. */
export function isCheckpointTicket(t: { readonly title: string }): boolean {
  return /^Checkpoint:/.test(t.title.trim());
}

/** Each label's text, up to the next known label. Missing labels are absent from the map. */
export function labelValues(description: string, labels: readonly string[]): Map<string, string> {
  const found: { label: string; at: number }[] = [];
  for (const label of labels) {
    const m = new RegExp(`(^|[\\s.])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(description);
    if (m) found.push({ label, at: m.index + m[1]!.length });
  }
  found.sort((a, b) => a.at - b.at);
  const out = new Map<string, string>();
  found.forEach((f, k) => {
    const end = k + 1 < found.length ? found[k + 1]!.at : description.length;
    out.set(f.label, description.slice(f.at + f.label.length, end).trim().replace(/[.\s]+$/, "").trim());
  });
  return out;
}

export interface LedgerTicket {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly blockedBy: readonly string[];
}

/** Every dependency cycle among the created tickets, each as a path that returns to its start. */
export function dependencyCycles(tickets: readonly LedgerTicket[]): string[][] {
  const edges = new Map(tickets.map((t) => [t.id, t.blockedBy.filter((d) => d !== t.id)]));
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, "open");
    stack.push(id);
    for (const dep of edges.get(id) ?? []) {
      if (!edges.has(dep)) continue;
      if (state.get(dep) === "open") {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        const key = [...cycle.slice(0, -1)].sort().join(",");
        if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      } else if (!state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const t of tickets) if (!state.has(t.id)) visit(t.id);
  return cycles;
}

export function ticketFindings(tickets: readonly LedgerTicket[]): string[] {
  const findings: string[] = [];
  const ids = new Set(tickets.map((t) => t.id));
  for (const t of tickets) {
    if (isCheckpointTicket(t)) {
      const v = labelValues(t.description, ["Question:", "Criteria:"]);
      if (!(v.get("Question:") || v.get("Criteria:"))) findings.push(`${t.id} "${t.title}" is a checkpoint with no Question: or Criteria:`);
    } else {
      const v = labelValues(t.description, TICKET_TEMPLATE_FIELDS);
      const missing = TICKET_TEMPLATE_FIELDS.filter((f) => !v.has(f));
      if (missing.length > 0) findings.push(`${t.id} "${t.title}" lacks ${missing.join(", ")}`);
      const empty = TICKET_TEMPLATE_FIELDS.filter((f) => v.has(f) && (v.get(f) === "" || (SUBSTANTIVE_FIELDS.has(f) && NOT_APPLICABLE.test(v.get(f)!))));
      if (empty.length > 0) findings.push(`${t.id} "${t.title}" leaves ${empty.join(", ")} empty`);
    }
    for (const dep of t.blockedBy) {
      if (dep === t.id) findings.push(`${t.id} is blockedBy itself`);
      else if (!ids.has(dep)) findings.push(`${t.id} blockedBy ${dep}, which no created ticket has`);
    }
  }
  for (const cycle of dependencyCycles(tickets)) findings.push(`dependency cycle: ${cycle.join(" -> ")}`);
  return findings;
}

/** "Created 5 phases, 18 tickets" from the completion summary; null when the summary gives no count. */
export function summaryCounts(text: string): { readonly phases: number | null; readonly tickets: number | null } {
  const phases = /(\d+)\s+phases?\b/i.exec(text);
  const tickets = /(\d+)\s+tickets?\b/i.exec(text);
  return { phases: phases ? Number(phases[1]) : null, tickets: tickets ? Number(tickets[1]) : null };
}

/** Handover and note text in a project, for the coverage, review and pending-tooling checks. */
export function setupRecordText(storyDir: string): string {
  const parts: string[] = [];
  for (const sub of ["handovers", "notes"]) {
    const dir = join(storyDir, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!/\.(md|json)$/.test(name)) continue;
      parts.push(readFileSync(join(dir, name), "utf-8"));
    }
  }
  return parts.join("\n\n");
}

// --- reviewer, degraded discovery and the verdict ------------------------------------

/**
 * The check set a run is graded under. Version 1 is every record written before check set 2 existed (they carry no
 * version); a replay runs each record under its own version, so a record never meets checks it was not graded by.
 */
export const CHECK_SET_VERSION = 2;
export const KNOWN_CHECK_SETS: readonly number[] = [1, 2];

/**
 * A fixture rubric as a check set reads it. Check set 1 drops the `checkSet2` overlay, so the rubric serialises
 * byte for byte as before it existed; check set 2 replaces each overlaid key in place and appends the new ones.
 */
export function rubricFor(raw: Record<string, unknown>, checkSet: number): Record<string, unknown> {
  const { checkSet2, ...legacy } = raw;
  if (checkSet < 2 || checkSet2 === undefined || checkSet2 === null || typeof checkSet2 !== "object") return legacy;
  const out: Record<string, unknown> = {};
  const overlay = checkSet2 as Record<string, unknown>;
  for (const [k, v] of Object.entries(legacy)) out[k] = k in overlay ? overlay[k] : v;
  for (const [k, v] of Object.entries(overlay)) if (!(k in legacy)) out[k] = v;
  return out;
}

export interface ReviewerInvocation {
  readonly via: "codex-exec" | "review_plan" | "agent";
  /**
   * Succeeded and returned something. Still only a candidate: whether it was
   * given the proposal and returned a review of it is a semantic ruling the
   * judge makes, citing this invocation's index.
   */
  readonly ok: boolean;
  readonly index: number;
  /** What the reviewer was given (the command, the plan, the agent prompt), verbatim, for the judge. */
  readonly input: string;
  /** What it returned, verbatim. */
  readonly result: string;
  /** Check set 2: the `Review id: R<n>` its input names, or null. */
  readonly reviewId?: string | null;
  /** Check set 2: the `verdict` string of its captured response, or null. */
  readonly verdict?: string | null;
  /** Check set 2: where the review started and where its response was captured; equal for a synchronous call. */
  readonly startIndex?: number;
  readonly completionIndex?: number;
  /** Check set 2: why a not-ok entry is not a review. */
  readonly reason?: string;
}

const REVIEW_ID = /(?:^|\n)[ \t]*Review id: (R[1-9][0-9]*)[ \t]*(?=\r?\n|$)/;

/** The review id the first `Review id: R<n>` line of a reviewer's input names, or null. */
export function reviewIdOf(text: string): string | null {
  return REVIEW_ID.exec(text)?.[1] ?? null;
}

/** Every top-level JSON object in `text`, in order, strings honoured; text that is not JSON is skipped. */
function jsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]!;
    if (inString) {
      if (ch === "\\") k++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) { inString = true; continue; }
    if (ch === "{") { if (depth === 0) start = k; depth++; continue; }
    if (ch === "}" && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(text.slice(start, k + 1))); } catch { /* not JSON */ }
    }
  }
  return out;
}

function verdictIn(v: unknown, depth: number): string | null {
  if (depth > 4 || v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(v) && typeof o.verdict === "string") return o.verdict;
  for (const key of ["structuredContent", "structured_content", "result"]) {
    const r = verdictIn(o[key], depth + 1);
    if (r !== null) return r;
  }
  const content = Array.isArray(v) ? v : o.content;
  if (Array.isArray(content)) {
    for (let k = content.length - 1; k >= 0; k--) {
      const item = content[k] as { text?: unknown } | null;
      const r = typeof item?.text === "string" ? verdictOfDepth(item.text, depth + 1) : verdictIn(item, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

function verdictOfDepth(text: string, depth: number): string | null {
  const objects = jsonObjects(text);
  for (let k = objects.length - 1; k >= 0; k--) {
    const r = verdictIn(objects[k], depth);
    if (r !== null) return r;
  }
  if (/^\s*\[/.test(text)) { try { return verdictIn(JSON.parse(text), depth); } catch { /* not JSON */ } }
  return null;
}

/**
 * The `verdict` of a captured reviewer response: the last top-level JSON object carrying a string `verdict`
 * (codex exec's schema output, an agent's final message), looking through an MCP result's content text.
 */
export function verdictOf(text: string): string | null {
  return verdictOfDepth(text, 0);
}

/** The text a reviewer was given: the plan argument, the agent prompt, or the command with its here-document. */
function reviewSource(call: EvalCall, fallback: string): string {
  const input = call.input as { plan?: unknown; prompt?: unknown } | null;
  if (typeof input?.plan === "string") return input.plan;
  if (typeof input?.prompt === "string") return input.prompt;
  return fallback;
}

interface TrackedAgent { readonly id: string; readonly spawnIndex: number; readonly prompt: string; done: boolean; failure: string | null }

/** The body of the first here-document in `text` with a simple delimiter, or null when there is none or it never ends. */
function heredocBody(text: string): string | null {
  const m = /<<(-?)[ \t]*(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)"|\\?([A-Za-z0-9_]+))/.exec(text);
  if (m === null) return null;
  const delimiter = m[2] ?? m[3] ?? m[4]!;
  const nl = text.indexOf("\n", m.index + m[0].length);
  if (nl < 0) return null;
  const body: string[] = [];
  for (const line of text.slice(nl + 1).split("\n")) {
    if ((m[1] === "-" ? line.replace(/^\t+/, "") : line) === delimiter) return body.join("\n");
    body.push(line);
  }
  return null;
}

/**
 * Check set 2: what a `codex exec` review was actually given. The shell call must be that one command (through
 * wrappers and a nested shell), so neither its input nor its output can come from another command: its prompt is the
 * here-document it reads when its prompt argument is `-`, otherwise its last argument. Anything else is refused.
 */
function codexExecAttribution(text: string, depth: number): { readonly source: string } | { readonly reason: string } {
  const { commands } = shellSequence(text);
  if (commands.length !== 1) return { reason: "the codex exec review shares its shell call with other commands, so its input and output cannot be attributed to it" };
  const { argv, inner } = unwrap(commands[0]!.words);
  if (inner !== null) return depth < 3 ? codexExecAttribution(inner, depth + 1) : { reason: "the codex exec review is nested too deeply to attribute" };
  const args = argv.slice(argv.indexOf("exec") + 1);
  if (!args.includes("-")) return { source: args.at(-1) ?? "" };
  // Closed form: the command's redirections must be exactly one quoted (literal) here-document on standard input plus,
  // at most, `2>/dev/null` and `2>&1`. The shell reads the LAST standard-input redirection and a descriptor duplication
  // (`3<file ... 0<&3`) can replace it, so any other redirection leaves what Codex read unattributable.
  const command = commands[0]!;
  const redirections = redirectionsOf(command.bare);
  const heredocs = redirections.filter((r) => (r.op === "<<" || r.op === "<<-") && (r.fd === "" || r.fd === "0"));
  if (heredocs.length === 0) return { reason: "the codex exec review reads standard input that is not a here-document in the same call" };
  if (heredocs.length > 1) return { reason: "the codex exec review has more than one standard input redirection, so what it read is the last one, not the here-document" };
  if (redirections.some((r) => !heredocs.includes(r) && !ALLOWED_CODEX_REDIRECTION.has(`${r.fd}${r.op}${r.target}`))) {
    return { reason: "the codex exec review carries a redirection other than its here-document, so what it read cannot be attributed" };
  }
  const body = !command.heredocUnquoted && !command.heredocComplex ? heredocBody(text) : null;
  return body === null ? { reason: "the codex exec review reads standard input that is not a here-document in the same call" } : { source: body };
}

/** The only redirections a codex exec review may carry besides its here-document: its standard error discarded or merged. */
const ALLOWED_CODEX_REDIRECTION: ReadonlySet<string> = new Set(["2>/dev/null", "2>&1"]);

/**
 * Every redirection in a command's skeleton line (a here-document body appended below it is not read): its descriptor
 * (digits or `{name}` opening the word, else empty), its operator (an optional `&`, a `<` or `>`, then any run of
 * `<`, `>`, `&`, `|` and `-`) and its target word, which ends at a space or the next `<` or `>`.
 */
function redirectionsOf(bare: string): { readonly fd: string; readonly op: string; readonly target: string }[] {
  const line = bare.split("\n")[0]!;
  const out: { fd: string; op: string; target: string }[] = [];
  for (const m of line.matchAll(/(^|\s)?((?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?)(&?[<>][<>&|-]*)[ \t]*([^\s<>]*)/g)) {
    out.push({ fd: m[1] === undefined ? "" : m[2]!, op: m[3]!, target: m[4]! });
  }
  return out;
}

/** The agent id a Claude background launch acknowledged (`agentId: <id>`), or null. */
function launchedAgentId(result: string): string | null {
  return /\bagent_?id["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i.exec(result)?.[1] ?? null;
}

/** An output-tool read of a background agent: its id, status and final output, or null when the call is not one. */
function agentOutput(call: EvalCall): { readonly id: string | null; readonly status: string | null; readonly output: string } | null {
  if (call.name !== "TaskOutput" && call.name !== "AgentOutputTool") return null;
  const input = call.input as Record<string, unknown> | null;
  const raw = input?.task_id ?? input?.taskId ?? input?.agentId ?? input?.agent_id;
  const result = call.result ?? "";
  let status = /<status>\s*([A-Za-z_]+)\s*<\/status>/.exec(result)?.[1] ?? null;
  let output = /<output>([\s\S]*?)<\/output>/.exec(result)?.[1] ?? null;
  if (status === null) {
    try {
      const parsed = JSON.parse(result) as { status?: unknown; output?: unknown };
      if (typeof parsed.status === "string") status = parsed.status;
      if (typeof parsed.output === "string") output = parsed.output;
    } catch { /* not JSON */ }
  }
  return { id: typeof raw === "string" ? raw : null, status: status?.toLowerCase() ?? null, output: output ?? "" };
}

/**
 * Check set 2's reviewer invocations. A synchronous call (codex exec, review_plan, a foreground Agent/Task) starts and
 * completes at its own index. A spawned agent is identified by the spawn's receiver_thread_ids and tracked across
 * every later wait: running, pending or timed out keeps it open, and its first completed state with a non-empty
 * message is its completion, one invocation per agent at that wait's index. An agent that never completes is one
 * not-ok entry at its spawn; a wait on no agent, or on an id no spawn listed, is a not-ok entry of its own.
 */
function reviewerInvocationsV2(calls: readonly EvalCall[]): ReviewerInvocation[] {
  const out: ReviewerInvocation[] = [];
  const sync = (via: ReviewerInvocation["via"], ok: boolean, index: number, input: string, result: string, source: string): void => {
    out.push({ via, ok, index, input, result, reviewId: reviewIdOf(source), verdict: ok ? verdictOf(result) : null, startIndex: index, completionIndex: index });
  };
  const agents = new Map<string, TrackedAgent>();
  const background = new Map<string, TrackedAgent>();
  const unknown = new Set<string>();
  calls.forEach((call, index) => {
    const result = call.result ?? "";
    const ok = !call.isError && result.trim().length > 0;
    const input = typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? null);
    if (call.name === "collab:spawn_agent") {
      if (call.isError) return;
      const spawn = call.input as { receiver_thread_ids?: unknown; prompt?: unknown } | null;
      const ids = Array.isArray(spawn?.receiver_thread_ids) ? spawn.receiver_thread_ids.filter((x): x is string => typeof x === "string") : [];
      for (const id of ids) if (!agents.has(id)) agents.set(id, { id, spawnIndex: index, prompt: typeof spawn?.prompt === "string" ? spawn.prompt : "", done: false, failure: null });
      return;
    }
    if (call.name === "collab:wait") {
      // A failed wait captures nothing: every agent it named stays open for a later successful wait.
      if (call.isError) return;
      const wait = call.input as { receiver_thread_ids?: unknown } | null;
      const receivers = Array.isArray(wait?.receiver_thread_ids) ? wait.receiver_thread_ids.filter((x): x is string => typeof x === "string") : [];
      let states: Record<string, { status?: unknown; message?: unknown }> = {};
      try { const parsed = JSON.parse(result) as unknown; if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) states = parsed as typeof states; } catch { /* no states */ }
      const ids = [...new Set([...receivers, ...Object.keys(states)])];
      if (ids.length === 0) {
        out.push({ via: "agent", ok: false, index, input, result, reviewId: null, verdict: null, startIndex: index, completionIndex: index, reason: "a wait on no agent" });
        return;
      }
      for (const id of ids) {
        const agent = agents.get(id);
        if (agent === undefined) {
          if (!unknown.has(id)) { unknown.add(id); out.push({ via: "agent", ok: false, index, input, result, reviewId: null, verdict: null, startIndex: index, completionIndex: index, reason: `a wait on unknown agent ${id}` }); }
          continue;
        }
        if (agent.done) continue;
        const state = states[id];
        const status = typeof state?.status === "string" ? state.status : null;
        const message = typeof state?.message === "string" ? state.message : "";
        if (status === "completed" && message.trim().length > 0) {
          agent.done = true;
          out.push({ via: "agent", ok: true, index, input: agent.prompt, result: message, reviewId: reviewIdOf(agent.prompt), verdict: verdictOf(message), startIndex: agent.spawnIndex, completionIndex: index });
        } else if (status === "completed") agent.failure = "incomplete: completed with an empty message";
        else if (status !== null && ["errored", "interrupted", "shutdown", "not_found"].includes(status)) agent.failure = `agent ended ${status}`;
      }
      return;
    }
    if (call.name === "review_plan") { sync("review_plan", ok, index, input, result, reviewSource(call, input)); return; }
    if ((call.name === "Agent" || call.name === "Task") && !call.nested) {
      const launched = (call.input as { run_in_background?: unknown } | null)?.run_in_background === true;
      if (!launched) { sync("agent", ok, index, input, result, reviewSource(call, input)); return; }
      // A background launch returns an acknowledgement; its review arrives later, through an output read of that agent.
      const id = ok ? launchedAgentId(result) : null;
      if (id === null || background.has(id)) {
        out.push({ via: "agent", ok: false, index, input, result, reviewId: reviewIdOf(reviewSource(call, input)), verdict: null, startIndex: index, completionIndex: index, reason: "acknowledgement only" });
        return;
      }
      background.set(id, { id, spawnIndex: index, prompt: reviewSource(call, input), done: false, failure: null });
      return;
    }
    const read = call.nested ? null : agentOutput(call);
    if (read !== null) {
      const agent = read.id === null ? undefined : background.get(read.id);
      if (agent === undefined) {
        out.push({ via: "agent", ok: false, index, input, result, reviewId: null, verdict: null, startIndex: index, completionIndex: index, reason: `an output read for unknown agent ${read.id ?? "(none)"}` });
        return;
      }
      // A failed read, or one that finds the agent still running, captures nothing and leaves it open.
      if (agent.done || call.isError) return;
      if (read.status === "completed" && read.output.trim().length > 0) {
        agent.done = true;
        out.push({ via: "agent", ok: true, index, input: agent.prompt, result: read.output, reviewId: reviewIdOf(agent.prompt), verdict: verdictOf(read.output), startIndex: agent.spawnIndex, completionIndex: index });
      } else if (read.status === "completed") agent.failure = "incomplete: completed with an empty message";
      else if (read.status !== null && ["failed", "error", "errored", "killed", "cancelled", "interrupted"].includes(read.status)) agent.failure = `agent ended ${read.status}`;
      return;
    }
    const cmd = commandOf(call);
    if (cmd === null) return;
    if (!runsCodexExec(cmd, 0)) return;
    const attribution = codexExecAttribution(cmd, 0);
    if ("reason" in attribution) {
      out.push({ via: "codex-exec", ok: false, index, input: cmd, result, reviewId: null, verdict: null, startIndex: index, completionIndex: index, reason: attribution.reason });
      return;
    }
    sync("codex-exec", ok, index, cmd, result, attribution.source);
  });
  for (const agent of [...agents.values(), ...background.values()]) {
    if (agent.done) continue;
    out.push({ via: "agent", ok: false, index: agent.spawnIndex, input: agent.prompt, result: "", reviewId: reviewIdOf(agent.prompt), verdict: null, startIndex: agent.spawnIndex, completionIndex: agent.spawnIndex, reason: agent.failure ?? "acknowledgement only" });
  }
  return out.map((r, k) => ({ r, k })).sort((a, b) => a.r.index - b.r.index || a.k - b.k).map(({ r }) => r);
}

/** Whether a shell command runs `codex exec` (help and version probes excluded), through wrappers and nested shells. */
function runsCodexExec(text: string, depth: number): boolean {
  return shellCommands(text).some((words) => {
    const { argv, inner } = unwrap(words);
    if (inner !== null) return depth < 3 && runsCodexExec(inner, depth + 1);
    if (baseName(argv[0] ?? "") !== "codex") return false;
    const at = argv.indexOf("exec");
    return at > 0 && !isCodexProbe(argv.slice(at + 1));
  });
}

/** `codex exec` asked for help or its version: a probe, never a review. */
function isCodexProbe(execArgs: readonly string[]): boolean {
  return execArgs.some((a) => /^(-h|--help|-V|--version)$/.test(a)) || firstPositional(execArgs)[0] === "help";
}

/**
 * Every candidate reviewer invocation, in call order: a `codex exec` command
 * (help and version probes excluded), the `review_plan` MCP tool, or a
 * main-agent Agent/Task call. `ok` means it succeeded AND returned something;
 * a failed or empty call is not a review, and neither is a background agent
 * launch: its result is an acknowledgement, and the agent's final response
 * never arrives as this tool result, so nothing here can capture it. Nothing here decides that a
 * candidate reviewed the proposal: an unrelated agent task passes this filter.
 */
export function reviewerInvocations(calls: readonly EvalCall[], checkSet = 1): ReviewerInvocation[] {
  if (checkSet >= 2) return reviewerInvocationsV2(calls);
  const out: ReviewerInvocation[] = [];
  calls.forEach((call, index) => {
    const result = call.result ?? "";
    const ok = !call.isError && result.trim().length > 0;
    const input = typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? null);
    if (call.name === "review_plan") { out.push({ via: "review_plan", ok, index, input, result }); return; }
    if ((call.name === "Agent" || call.name === "Task") && !call.nested) {
      const launched = (call.input as { run_in_background?: unknown } | null)?.run_in_background === true;
      out.push({ via: "agent", ok: ok && !launched, index, input, result });
      return;
    }
    const cmd = commandOf(call);
    if (cmd === null) return;
    if (runsCodexExec(cmd, 0)) out.push({ via: "codex-exec", ok, index, input: cmd, result });
  });
  return out;
}

export const CREATION_TOOLS = ["storybloq_phase_create", "storybloq_ticket_create", "storybloq_ticket_update", "storybloq_issue_create", "storybloq_snapshot"] as const;
const CLI_CREATE = /\bstorybloq\s+(phase|ticket)\s+create\b/;

/**
 * The degraded variant's assertion. The condition must be established (the
 * session started without the creation tools loaded); then, between init (or
 * the start, for a reused scaffold) and the first MCP creation call, the model
 * must either search for the missing tools by name or fall back to the CLI
 * successfully. A broad discovery before init does not count.
 */
export function degradedFindings(calls: readonly EvalCall[], initTools: readonly string[] | null): string[] {
  if (initTools === null) return ["degraded: the client reported no initial tool list, so the missing-tool condition is unproven"];
  const loaded = initTools.map(bareToolName).filter((t) => (CREATION_TOOLS as readonly string[]).includes(t));
  if (loaded.length > 0) return [`degraded: condition not established, creation tools loaded at start (${loaded.join(", ")})`];
  const initAt = calls.findIndex((c) => c.name === "storybloq_init" || /\bstorybloq\s+init\b/.test(commandOf(c) ?? ""));
  const from = initAt < 0 ? 0 : initAt + 1;
  const firstCreate = calls.findIndex((c, k) => k >= from && (CREATION_TOOLS as readonly string[]).includes(c.name));
  const window = calls.slice(from, firstCreate < 0 ? calls.length : firstCreate);
  const searched = window.some((c) => (c.name === "ToolSearch" || c.name === "tool_search") && !c.isError && CREATION_TOOLS.some((t) => JSON.stringify(c.input ?? "").includes(t)));
  const fellBack = calls.slice(from).some((c) => !c.isError && CLI_CREATE.test(commandOf(c) ?? ""));
  if (firstCreate >= 0 && !searched) return ["degraded: an MCP creation call came before any search naming the missing creation tools after init"];
  if (firstCreate < 0 && !fellBack) return ["degraded: nothing was created by MCP or by a successful CLI fallback"];
  return [];
}

/** One semantic rubric line the judge rules on. */
export interface JudgeLine {
  readonly line: string;
  readonly verdict: "pass" | "fail";
  readonly reason: string;
  /** The evidence indices the ruling rests on; required for a line that must be bound to specific invocations. */
  readonly citations?: readonly number[];
}

/** The judge's result, bound to the exact grading packet it read. */
export interface JudgeResult {
  readonly packetSha256: string;
  readonly observedModel: string;
  readonly lines: readonly JudgeLine[];
}

export type RunVerdict =
  | { readonly verdict: "FAIL"; readonly reasons: readonly string[] }
  | { readonly verdict: "PENDING_SEMANTIC"; readonly reasons: readonly string[] }
  | { readonly verdict: "PASS"; readonly reasons: readonly string[] };

/**
 * Overall PASS needs a clean mechanical record AND a judge result for this
 * packet with every semantic line passing. A line in `bound` passes only when
 * the judge cites at least one index, every one of them from that line's
 * allowed candidates: a ruling cannot rest on an invocation the packet did not
 * offer as evidence.
 */
export function runVerdict(
  mechanicalFailures: readonly string[], packetText: string, judge: JudgeResult | null, requiredLines: readonly string[],
  bound: Readonly<Record<string, readonly number[]>> = {},
): RunVerdict {
  if (mechanicalFailures.length > 0) return { verdict: "FAIL", reasons: mechanicalFailures };
  if (judge === null) return { verdict: "PENDING_SEMANTIC", reasons: ["mechanical checks passed; no judge result yet"] };
  const reasons: string[] = [];
  if (judge.packetSha256 !== sha256(packetText)) reasons.push("the judge result is bound to a different grading packet");
  if (judge.observedModel.trim() === "") reasons.push("the judge result names no observed model");
  for (const line of requiredLines) {
    const ruled = judge.lines.find((l) => l.line === line);
    if (!ruled) { reasons.push(`the judge did not rule on: ${line}`); continue; }
    if (ruled.verdict !== "pass") { reasons.push(`semantic: ${line}: ${ruled.reason}`); continue; }
    const allowed = bound[line];
    if (allowed === undefined) continue;
    const cited = ruled.citations ?? [];
    if (cited.length === 0) reasons.push(`the judge passed without citing an invocation: ${line}`);
    const stray = cited.filter((c) => !allowed.includes(c));
    if (stray.length > 0) reasons.push(`the judge cited ${stray.join(", ")}, which are not candidates for: ${line}`);
  }
  return reasons.length > 0 ? { verdict: "FAIL", reasons } : { verdict: "PASS", reasons: [] };
}
