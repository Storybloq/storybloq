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
  for (const ev of events) {
    if (ev.type !== "assistant" || (ev.parent_tool_use_id ?? null) !== null) continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as readonly Record<string, unknown>[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") lastMain = { kind: "text" };
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
  const stopText = last?.kind === "text" ? resultText
    : pendingQuestion !== "" ? [resultText, pendingQuestion].filter(Boolean).join("\n")
    : "";
  const sessionId = (usage.initEvent?.session_id as string | undefined) ?? null;
  const terminal: TurnTerminal = result === null
    ? { status: "missing", detail: "no result event" }
    : result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")
      ? { status: "failed", detail: `result ${String(result.subtype)}` }
      : { status: "completed", detail: "result success" };
  const tools = usage.initEvent?.tools;
  const initTools = Array.isArray(tools) ? tools.map(String) : null;
  return { calls, stopText, models: usage.mainModels, sessionId, terminal, initTools };
}

/** Codex item types that are activity after which an earlier agent message is no longer where the turn stopped. */
const CODEX_ACTIVITY = new Set(["command_execution", "mcp_tool_call", "file_change", "web_search"]);

/**
 * A Codex `exec --json` turn. Items are read from their completed events only.
 * The terminal interaction is the last agent message, and only when no tool
 * activity followed it: a message superseded by more work is stale.
 */
export function codexTurn(lines: readonly Record<string, unknown>[]): EvalTurn {
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
    if (typeof item.type === "string" && CODEX_ACTIVITY.has(item.type)) activityAt = at;
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
/** A shell redirect into a file (not a descriptor, not /dev/null), or tee. */
const SHELL_FILE_WRITE = /(?:^|[^0-9&>])>>?\s*(?!&|\/dev\/null)[^\s|&;]+|\btee\s/;

function commandOf(call: EvalCall): string | null {
  if (call.name !== "Bash" && call.name !== "shell" && call.name !== "exec_command") return null;
  const c = (call.input as { command?: unknown } | null)?.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(String).join(" ");
  return null;
}

/** Every call that writes setup state: storybloq writes by MCP or CLI, file edits, shell redirects, `git init`. */
export function writeCalls(calls: readonly EvalCall[]): EvalCall[] {
  return calls.filter((call) => {
    if (WRITE_TOOLS.has(call.name)) return true;
    if (STORYBLOQ_WRITE.test(call.name)) return true;
    const cmd = commandOf(call);
    return cmd !== null && (STORYBLOQ_CLI_WRITE.test(cmd) || GIT_INIT.test(cmd) || SHELL_FILE_WRITE.test(cmd));
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

export interface ShellCommand {
  readonly words: readonly string[];
  /** The operator that ended the command (`&&`, `||`, `;`, `;;`, newline, `|`, `&`, a paren or brace), or "" at the end. */
  readonly sep: string;
}

/**
 * Split one shell command into simple commands, honouring quotes, and report
 * every operator seen (including a bare `(` that ends no command), so a caller
 * can refuse structures it does not model. A `&` inside a redirect (`2>&1`,
 * `&>file`) is part of the word.
 */
export function shellSequence(command: string): { readonly commands: readonly ShellCommand[]; readonly operators: readonly string[] } {
  const commands: ShellCommand[] = [];
  const operators: string[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = (): void => { if (inWord) { words.push(word); word = ""; inWord = false; } };
  const endCommand = (sep: string): void => { endWord(); if (words.length > 0) commands.push({ words, sep }); words = []; if (sep) operators.push(sep); };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const stop = close < 0 ? command.length : close;
      word += command.slice(i + 1, stop); inWord = true; i = stop; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) { word += command[j + 1]; j += 2; continue; }
        word += command[j]; j++;
      }
      inWord = true; i = j; continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      if (command[i + 1] === "\n") { i++; continue; }
      word += command[i + 1]; inWord = true; i++; continue;
    }
    if (ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) { word += ch; inWord = true; continue; }
    if (ch === "&" || ch === "|" || ch === ";") {
      const two = command[i + 1] === ch;
      if (two) i++;
      endCommand(two ? ch + ch : ch);
      continue;
    }
    if (ch === "\n" || ch === "(" || ch === ")" || ((ch === "{" || ch === "}") && !inWord)) { endCommand(ch); continue; }
    if (ch === " " || ch === "\t") { endWord(); continue; }
    if (ch === "#" && !inWord) { const nl = command.indexOf("\n", i); i = nl < 0 ? command.length : nl - 1; continue; }
    word += ch; inWord = true;
  }
  endCommand("");
  return { commands, operators };
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

/** Shell commands that run a build, test, install or dev server, from every call including nested agents'. Reading a manifest never matches. */
export function executionCalls(calls: readonly EvalCall[]): ExecutionHit[] {
  const hits: ExecutionHit[] = [];
  const scan = (call: EvalCall, cmd: string, depth: number): void => {
    for (const line of cmd.split("\n")) if (UNSUPPORTED.test(line.trim())) hits.push({ call, segment: line.trim(), kind: "review" });
    for (const words of shellCommands(cmd)) {
      const { argv, inner, ambiguous } = unwrap(words);
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

// --- stop points -------------------------------------------------------------------

export type StopKind = "discovery" | "package" | "review-unavailable" | "none";

const PACKAGE_OPTIONS = ["Approve setup", "Adjust the plan", "Inspect details"] as const;

/**
 * What the turn stopped at, read from its terminal interaction only (see
 * `EvalTurn.stopText`). Each kind also requires that interaction to END by
 * asking the owner: the last non-empty paragraph must carry the question or
 * the options, so a package shown mid-turn and followed by other text fails.
 */
export function classifyStop(stopText: string): StopKind {
  const paragraphs = stopText.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const tail = paragraphs.slice(-2).join("\n");
  const lastLine = stopText.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (PACKAGE_OPTIONS.every((o) => tail.includes(o)) && PACKAGE_OPTIONS.some((o) => lastLine.includes(o) || /\?$/.test(lastLine))) return "package";
  if (/continue without (an )?independent review/i.test(tail) && /retry/i.test(tail) && (/\?$/.test(lastLine) || /continue without|retry/i.test(lastLine))) return "review-unavailable";
  if (/\?\s*$/.test(paragraphs[paragraphs.length - 1] ?? "")) return "discovery";
  return "none";
}

export interface StopCheck {
  readonly kind: StopKind;
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/** A pre-approval stop: the turn ended at the expected question and wrote nothing. */
export function checkStop(turn: EvalTurn, expected: readonly StopKind[]): StopCheck {
  const kind = classifyStop(turn.stopText);
  const reasons: string[] = [];
  if (!expected.includes(kind)) reasons.push(`stopped at ${kind}, expected ${expected.join(" or ")}`);
  const writes = writeCalls(turn.calls);
  if (writes.length > 0) reasons.push(`wrote before approval: ${writes.map((w) => commandOf(w) ?? w.name).join("; ")}`);
  const execs = executionCalls(turn.calls);
  const ran = execs.filter((e) => e.kind === "execution");
  const unclear = execs.filter((e) => e.kind === "review");
  if (ran.length > 0) reasons.push(`executed during setup: ${ran.map((e) => (e.call.nested ? `[nested] ${e.segment}` : e.segment)).join("; ")}`);
  if (unclear.length > 0) reasons.push(`needs review, shell construct not parsed: ${unclear.map((e) => e.segment).join("; ")}`);
  return { kind, ok: reasons.length === 0, reasons };
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

export function digestChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
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
  readonly testStages: "disabled" | "same-command" | "same-command-or-disabled" | "disabled-or-components";
  readonly command?: string;
  /** For `disabled-or-components`: every part's directory; an enabled command must run each part's tests from it. */
  readonly components?: readonly string[];
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
    const f = componentCommandFindings(stages.command, expected.components ?? []);
    return f.length === 0 ? null : `component test command: ${f.join("; ")}`;
  }
  if (expected.testStages === "disabled") return stages.kind === "disabled" ? null : `expected both test stages disabled, got ${stages.command}`;
  if (stages.kind === "disabled") return expected.testStages === "same-command-or-disabled" ? null : `expected ${expected.command}, got both disabled`;
  if (expected.command && stages.command !== expected.command) return `expected ${expected.command}, got ${stages.command}`;
  return null;
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
}

/** `codex exec` asked for help or its version: a probe, never a review. */
function isCodexProbe(execArgs: readonly string[]): boolean {
  return execArgs.some((a) => /^(-h|--help|-V|--version)$/.test(a)) || firstPositional(execArgs)[0] === "help";
}

/**
 * Every candidate reviewer invocation, in call order: a `codex exec` command
 * (help and version probes excluded), the `review_plan` MCP tool, or a
 * main-agent Agent/Task call. `ok` means it succeeded AND returned something;
 * a failed or empty call is not a review. Nothing here decides that a
 * candidate reviewed the proposal: an unrelated agent task passes this filter.
 */
export function reviewerInvocations(calls: readonly EvalCall[]): ReviewerInvocation[] {
  const out: ReviewerInvocation[] = [];
  calls.forEach((call, index) => {
    const result = call.result ?? "";
    const ok = !call.isError && result.trim().length > 0;
    const input = typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? null);
    if (call.name === "review_plan") { out.push({ via: "review_plan", ok, index, input, result }); return; }
    if ((call.name === "Agent" || call.name === "Task") && !call.nested) { out.push({ via: "agent", ok, index, input, result }); return; }
    const cmd = commandOf(call);
    if (cmd === null) return;
    const runsCodexExec = (text: string, depth: number): boolean => shellCommands(text).some((words) => {
      const { argv, inner } = unwrap(words);
      if (inner !== null) return depth < 3 && runsCodexExec(inner, depth + 1);
      if (baseName(argv[0] ?? "") !== "codex") return false;
      const at = argv.indexOf("exec");
      return at > 0 && !isCodexProbe(argv.slice(at + 1));
    });
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
