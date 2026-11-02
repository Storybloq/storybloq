/**
 * T-538 S5a, check set 7 rule 10: the ledger is written only through
 * storybloq, for the whole run. Its own detector: `writeCalls`, `commandOf`
 * and check sets 1 to 6 are untouched.
 *
 * A file-edit call (Write, Edit, MultiEdit, NotebookEdit, apply_patch) fails
 * when a target is under `<project>/.story/`, or when it has no readable
 * target and its input mentions `.story`. A shell call (Bash, shell,
 * exec_command; `input.command`, else `input.cmd`) is split by
 * `shellSequence` and each simple command is judged alone: storybloq writes
 * through its lock, a pure reader without a redirection reads, and anything
 * else that may touch `.story/` fails. What the detector cannot read fails
 * closed whenever the operation, or anything earlier in the call, mentions
 * `.story`.
 */
import { posix } from "node:path";
import { shellQuote, shellSequence, unwrap, type EvalCall, type ShellCommand } from "./onboarding-eval-lib.js";

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command"]);
const READERS = new Set(["cat", "ls", "head", "tail", "wc", "grep", "rg", "find", "stat", "test", "[", "jq", "diff"]);
const GIT_READS = new Set(["status", "diff", "log", "show"]);
const WRITERS = new Set(["tee", "cp", "mv", "rm", "touch", "mkdir", "ln", "install", "truncate", "chmod", "dd", "rsync"]);
/** Commands that write nothing of their own; only a redirection can make them write. */
const QUIET = new Set(["echo", "printf", "true", "false", ":", "pwd", "date", "sleep", "which", "type", "wait", "exit", "export", "set", "unset"]);
const INLINE: Readonly<Record<string, RegExp>> = {
  node: /^(-e|-p|--eval|--print|-pe|-ep)$/,
  python: /^-[A-Za-z]*c$/,
  perl: /^-[A-Za-z]*[eE]$/,
  ruby: /^-[A-Za-z]*e$/,
};
const REDIRECT = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\}|&)?(>>|>\||>&?|<>|&>>|&>)(.*)$/;
const DESCRIPTOR = /^&?-?\d*-?$/;

const mentions = (text: string) => text.includes(".story");
const baseName = (w: string) => w.replace(/^.*\//, "");
const expands = (w: string) => /[$`]/.test(w);
/** An operation's words as a finding prints them: an empty word shows as '', so no argument vanishes. */
const shown = (words: readonly string[]) => words.map((w) => (w === "" ? "''" : w)).join(" ");

/** Paths compared without the macOS `/private` prefix, so /tmp and /private/tmp are one place. */
const canonical = (p: string) => posix.normalize(p).replace(/^\/private(?=\/)/, "");

function underStory(target: string, projectRoot: string): boolean {
  const abs = canonical(target.startsWith("/") ? target : posix.join(projectRoot, target));
  const story = canonical(posix.join(projectRoot, ".story"));
  return abs === story || abs.startsWith(`${story}/`);
}

/** The interpreter an argv[0] names, by family. */
function interpreter(bin: string): keyof typeof INLINE | null {
  if (bin === "node" || bin === "nodejs") return "node";
  if (/^python(\d+(\.\d+)?)?$/.test(bin)) return "python";
  if (bin === "perl") return "perl";
  if (bin === "ruby") return "ruby";
  return null;
}

interface Redirect { readonly target: string; readonly op: string }

/** The command's output redirections (input-only `<` never writes), with their targets. */
function redirects(words: readonly string[]): Redirect[] {
  const out: Redirect[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = REDIRECT.exec(words[i]!);
    if (m === null) continue;
    const target = m[2] !== "" ? m[2]! : words[i + 1] ?? "";
    if (m[1] === ">&" && DESCRIPTOR.test(target)) continue;
    out.push({ op: m[1]!, target });
    if (m[2] === "") i++;
  }
  return out;
}

/** The argv without its redirections. */
function withoutRedirects(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const m = REDIRECT.exec(argv[i]!);
    if (m === null) { out.push(argv[i]!); continue; }
    if (m[2] === "") i++;
  }
  return out;
}

export function isReader(argv: readonly string[]): boolean {
  const bin = baseName(argv[0] ?? "");
  if (bin === "git") return GIT_READS.has(argv.slice(1).find((w) => !w.startsWith("-")) ?? "");
  if (!READERS.has(bin)) return false;
  if (bin === "find") return !argv.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w));
  return true;
}

function inPlace(bin: string, args: readonly string[]): boolean {
  if (bin === "sed") return args.some((w) => /^-[A-Za-z]*i/.test(w) || w.startsWith("--in-place"));
  if (bin === "perl") return args.some((w) => /^-[A-Za-z]*i/.test(w));
  return false;
}

interface Judged { readonly reason: string | null; readonly entersStory: boolean }

/**
 * One simple command: why it may write `.story/`, or null. `context` is the
 * call's text up to and including this operation; `inStory` says an earlier
 * `cd` moved into `.story/`; `pipedInto` says a `|` feeds it.
 */
function judge(cmd: ShellCommand, argv: readonly string[], context: string, inStory: boolean, pipedInto: boolean, root: string, fullText: string): Judged {
  const bin = baseName(argv[0] ?? "");
  const text = argv.join(" ");
  const risky = mentions(context) || inStory;
  for (const r of redirects(argv)) {
    if (r.target === "/dev/null") continue;
    if (expands(r.target) && risky) return { reason: `a redirection to an expansion (${r.target}) in a call that names .story`, entersStory: false };
    if (mentions(r.target) || (inStory && !r.target.startsWith("/"))) return { reason: `a redirection (${r.op}) into ${r.target}`, entersStory: false };
  }
  if (cmd.heredocComplex && risky) return { reason: "a here-document the detector cannot read, in a call that names .story", entersStory: false };
  const args = withoutRedirects(argv).slice(1);
  if (bin === "cd" || bin === "pushd") {
    const dest = args.find((w) => !w.startsWith("-")) ?? "";
    return { reason: null, entersStory: mentions(dest) || (expands(dest) && risky) };
  }
  if (bin === "storybloq") return { reason: null, entersStory: false };
  if (isReader(withoutRedirects(argv))) return { reason: null, entersStory: false };
  // A writer naming .story is reported as that write, ahead of the pipe and cd rules it may also break.
  const writer = WRITERS.has(bin) || inPlace(bin, args);
  if (writer) {
    const named = args.find((w) => mentions(w) || (bin === "dd" && /^of=.*\.story/.test(w)));
    if (named !== undefined) return { reason: `${bin}${inPlace(bin, args) ? " -i" : ""} on ${named}`, entersStory: false };
    if (args.some(expands) && risky) return { reason: `${bin} on an expansion, in a call that names .story`, entersStory: false };
  }
  if (pipedInto && risky && !QUIET.has(bin)) return { reason: "a pipe into a command that is not a pure reader, in a call that names .story", entersStory: false };
  if (inStory && !QUIET.has(bin)) return { reason: `${bin} after a cd into .story`, entersStory: false };
  if (writer) return { reason: null, entersStory: false };
  const family = interpreter(bin);
  if (family !== null) {
    const flag = INLINE[family]!;
    const at = args.findIndex((w) => flag.test(w));
    if (at >= 0 && mentions(args[at + 1] ?? "")) return { reason: `${bin} inline code that names .story`, entersStory: false };
    if (at >= 0 && args.slice(at + 2).some(mentions)) return { reason: `${bin} inline code with .story in its arguments`, entersStory: false };
    if (at >= 0 && risky && args.slice(at + 1).some(expands)) return { reason: `${bin} inline code with an expansion in its arguments, in a call that names .story`, entersStory: false };
    if (cmd.heredoc && mentions(fullText)) return { reason: `${bin} reading a here-document, in a call that names .story`, entersStory: false };
    if (at >= 0 || cmd.heredoc) return { reason: null, entersStory: false };
  }
  if (QUIET.has(bin)) return { reason: null, entersStory: false };
  if (argv.length === 0) return { reason: null, entersStory: false };
  if (risky) return { reason: `${bin || text} is a command the detector cannot classify, in a call that names .story`, entersStory: false };
  return { reason: null, entersStory: false };
}

/** The operators the detector models between commands: `&&`, `||`, `;`, a newline, and `|` into a reader. */
const MODELLED = new Set(["&&", "||", ";", "\n", "|", ""]);

/** A nested shell starts where its parent stands and knows what the parent's text named; its own `cd` stays inside it. */
function shellFindings(text: string, root: string, depth = 0, inherited: { inStory: boolean; context: string } = { inStory: false, context: "" }): string[] {
  const findings: string[] = [];
  const { commands, operators } = shellSequence(text);
  let inStory = inherited.inStory;
  let context = inherited.context;
  let pipedInto = false;
  const unmodelled = operators.filter((o) => !MODELLED.has(o));
  if (unmodelled.length > 0 && mentions(text)) findings.push(`an operator the detector does not model (${[...new Set(unmodelled)].join(" ")}) in a call that names .story`);
  for (const cmd of commands) {
    context += ` ${cmd.words.join(" ")} ${cmd.live.join(" ")}`;
    const u = unwrap(cmd.words);
    if (u.inner !== null) {
      if (depth < 3) findings.push(...shellFindings(u.inner, root, depth + 1, { inStory, context }));
      else if (mentions(u.inner)) findings.push("a nested shell too deep to read, in a call that names .story");
    } else {
      const j = judge(cmd, u.argv.length > 0 ? u.argv : cmd.words.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)), context, inStory, pipedInto, root, text);
      if (j.reason !== null) findings.push(`${j.reason}: ${shown(cmd.words)}`);
      if (j.entersStory) inStory = true;
    }
    for (const live of cmd.live) if (mentions(live) || inStory) findings.push(...shellFindings(live, root, depth + 1, { inStory, context }));
    pipedInto = cmd.sep === "|";
  }
  return findings;
}

/** The paths an apply_patch input names. */
function patchTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) out.push(m[1]!.trim());
  return out;
}

/** The shell text a call carries: `input.command`, else `input.cmd`; an argv array is quoted word by word. */
export function shellTextOf(input: unknown): string | null {
  const x = (input ?? {}) as { command?: unknown; cmd?: unknown };
  const c = x.command ?? x.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((w) => shellQuote(String(w))).join(" ");
  return null;
}

/**
 * Rule 10 over the whole run's calls (the agent's and nested ones): every
 * file-edit and shell call that may write `.story/` outside storybloq.
 * `projectRoot` resolves relative targets.
 */
export function ledgerWriteFindings(calls: readonly Pick<EvalCall, "name" | "input">[], projectRoot: string): string[] {
  const findings: string[] = [];
  calls.forEach((call, i) => {
    const name = call.name.replace(/^.*__/, "");
    const where = `rule 10: call ${i + 1}`;
    if (FILE_EDIT_TOOLS.has(name)) {
      const input = call.input as Record<string, unknown> | string | null;
      const patch = typeof input === "string" ? input : typeof input?.input === "string" ? input.input : typeof input?.patch === "string" ? input.patch : null;
      const targets = name === "apply_patch" && patch !== null
        ? patchTargets(patch)
        : (["file_path", "path", "notebook_path"] as const).map((k) => (typeof input === "object" && input !== null ? input[k] : undefined)).filter((v): v is string => typeof v === "string");
      if (targets.length === 0) {
        if (mentions(JSON.stringify(call.input ?? null))) findings.push(`${where}: ledger write: ${name} with no readable target names .story`);
        return;
      }
      for (const t of targets) if (underStory(t, projectRoot)) findings.push(`${where}: ledger write: ${name} on ${t}`);
      return;
    }
    if (SHELL_TOOLS.has(name)) {
      const text = shellTextOf(call.input);
      if (text === null) {
        if (mentions(JSON.stringify(call.input ?? null))) findings.push(`${where}: ledger write: a shell call with no readable command names .story`);
        return;
      }
      for (const f of shellFindings(text, projectRoot)) findings.push(`${where}: ledger write: ${f}`);
    }
  });
  return findings;
}
