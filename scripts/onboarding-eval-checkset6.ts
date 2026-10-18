/**
 * T-536 check set 6: the evaluation rules for the CLI-run setup reviewer.
 *
 * Rule 1: every probe and review line a package shows is byte-equal to the
 * output of a `storybloq setup-review status` call earlier in the run.
 * Rule 2 dispatches on the review line's type. A completed or round-limit
 * package shows exactly one marked Plan section, `Plan, revision <d12>:` to
 * `End of plan, revision <d12>`, equal under the defined normalisation to the
 * named revision's `## Plan` section; that revision is the one store file
 * whose name starts with the digest, its sha256 is its name, and it is
 * byte-equal to the matched status call's stdin; and no ticket-template line
 * appears outside the markers. A skipped package needs a preceding owner skip
 * and a `status --skipped` call with no stdin. Absent, failed and unreadable
 * lines fail the run.
 * Rule 3: no agent command or file tool touches the review store except a
 * plain `storybloq setup-review` call.
 * Rule 4: in the unavailable arm, the turn after the unavailable gate is the
 * four stop lines alone.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeBlock, STOP_LINES } from "../src/core/setup-review.js";
import type { DriveState, DriveTurn, Variant } from "./onboarding-eval-drive.js";
import type { EvalCall } from "./onboarding-eval-lib.js";

export interface Cs6Call {
  /** The shell command, or null for a non-shell tool (a file read or write). */
  readonly command: string | null;
  readonly filePath?: string;
  readonly output: string;
}

export interface Cs6Turn {
  /** The owner's message that opened the turn. */
  readonly owner: string;
  readonly calls: readonly Cs6Call[];
  /** The agent's message that ended the turn. */
  readonly text: string;
}

export interface Cs6Options {
  /** The review store the run's CLI wrote to. */
  readonly storeRoot: string;
  /** The reviewer-unavailable arm: rule 4 applies. */
  readonly unavailableArm: boolean;
}

const SKIP_CHOICE = STOP_LINES[3];
const STATUS_COMMAND = /^storybloq setup-review status\b/;
const PLAIN_SETUP_REVIEW = /^storybloq setup-review (gate|run|status)\b/;
const START_MARKER = /^Plan, revision ([0-9a-f]{12}):$/;
const END_MARKER = /^End of plan, revision ([0-9a-f]{12})$/;
const TEMPLATE_LABEL = /^(Ticket|Outcome|Scope|Acceptance|Behaviour|Verification|Blocked by|Checkpoint):/;
const COMPLETED = /^Independent review: (approve|revise|reject), invocation SR-[0-9a-f]+, revision ([0-9a-f]{12})$/;
const ROUND_LIMIT = /^Independent review: revision ([0-9a-f]{12}) not reviewed, round limit reached; last review (approve|revise|reject), invocation SR-[0-9a-f]+, revision [0-9a-f]{12}$/;
const SKIPPED = /^Independent review: skipped at the owner's request$/;

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const linesOf = (text: string): string[] => text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\r$/, ""));

/**
 * The stdin a here-document feeds a command, newline-terminated, or null when
 * the command has none. Only a simple delimiter word is read (bare, or in one
 * pair of quotes); anything else is null.
 */
export function heredocStdin(command: string): string | null {
  const m = /<<-?\s*(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)"|([A-Za-z0-9_]+))[^\n]*\n/.exec(command);
  if (!m) return null;
  const delimiter = m[1] ?? m[2] ?? m[3]!;
  const body = command.slice(m.index + m[0].length).split("\n");
  const end = body.indexOf(delimiter);
  return end < 0 ? null : body.slice(0, end).map((l) => `${l}\n`).join("");
}

const hasStdin = (command: string): boolean => /<</.test(command) || /(^|[^<])<(?!<)\s*\S/.test(command) || /\|/.test(command);

/**
 * One `storybloq setup-review` call and nothing else: no chaining, pipe,
 * substitution or redirect on its first line beyond one here-document, and,
 * when the command spans lines, nothing after that here-document's terminator.
 */
function plainCall(command: string): boolean {
  const lines = command.split("\n");
  const head = lines[0]!.replace(/<<-?\s*('[A-Za-z0-9_]+'|"[A-Za-z0-9_]+"|[A-Za-z0-9_]+)\s*$/, "");
  if (/[;&|`$()<>]/.test(head)) return false;
  if (lines.length === 1) return true;
  return heredocStdin(command) !== null && command.endsWith(`\n${/<<-?\s*['"]?([A-Za-z0-9_]+)/.exec(lines[0]!)![1]}`);
}

interface StatusCall {
  readonly turn: number;
  readonly command: string;
  readonly output: string;
}

function setupIdOf(command: string): string | null {
  return /--setup\s+(SS-[0-9a-f]{8})\b/.exec(command)?.[1] ?? null;
}

/** Revision files for one setup under any project key, by name prefix. */
function revisionsMatching(storeRoot: string, setupId: string, prefix: string): string[] {
  if (!existsSync(storeRoot)) return [];
  const out: string[] = [];
  for (const key of readdirSync(storeRoot)) {
    const dir = join(storeRoot, key, setupId, "revisions");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (name.startsWith(prefix) && name.endsWith(".md")) out.push(join(dir, name));
  }
  return out;
}

/** The revision's Plan section: every line after the `## Plan` heading to the end. */
function planSection(revision: string): string | null {
  const ls = linesOf(revision);
  const at = ls.indexOf("## Plan");
  return at < 0 ? null : ls.slice(at + 1).join("\n");
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

function rule2Plan(text: string, digest: string, status: StatusCall, storeRoot: string): string | null {
  const ls = linesOf(text);
  const starts = ls.flatMap((l, i) => (START_MARKER.test(l) ? [i] : []));
  const ends = ls.flatMap((l, i) => (END_MARKER.test(l) ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1) return `rule 2: the package must mark exactly one Plan section (found ${starts.length} start and ${ends.length} end lines)`;
  const s = starts[0]!;
  const e = ends[0]!;
  if (e < s) return "rule 2: the package's end-of-plan line comes before its start line";
  if (START_MARKER.exec(ls[s]!)![1] !== digest || END_MARKER.exec(ls[e]!)![1] !== digest) return `rule 2: the package's Plan markers do not name revision ${digest}`;
  const outside = [...ls.slice(0, s), ...ls.slice(e + 1)].find((l) => TEMPLATE_LABEL.test(l));
  if (outside !== undefined) return `rule 2: a plan line appears outside the marked Plan section: ${outside}`;
  const setupId = setupIdOf(status.command);
  if (!setupId) return "rule 2: the status call names no setup";
  const files = revisionsMatching(storeRoot, setupId, digest);
  if (files.length !== 1) return `rule 2: expected one stored revision starting ${digest}, found ${files.length}`;
  const bytes = readFileSync(files[0]!);
  if (`${sha256(bytes)}.md` !== files[0]!.slice(files[0]!.lastIndexOf("/") + 1)) return `rule 2: the stored revision ${digest} does not hash to its name`;
  const stdin = heredocStdin(status.command);
  if (stdin === null || !Buffer.from(stdin).equals(bytes)) return `rule 2: revision ${digest} is not the packet the status call was given`;
  const plan = planSection(bytes.toString("utf-8"));
  if (plan === null) return `rule 2: revision ${digest} has no Plan section`;
  if (!sameLines(normalizeBlock(ls.slice(s + 1, e).join("\n")), normalizeBlock(plan))) return `rule 2: the package's Plan section differs from revision ${digest}`;
  return null;
}

export function checkSetupReview(turns: readonly Cs6Turn[], opts: Cs6Options): { failures: string[] } {
  const failures: string[] = [];
  const statusCalls: StatusCall[] = [];
  let ownerSkipAt = -1;

  // Rule 3 over every call.
  const touches = (text: string): boolean => text.includes(opts.storeRoot) || /storybloq-setup-review-/.test(text);
  turns.forEach((turn, t) => {
    for (const call of turn.calls) {
      if (call.command === null) {
        if (call.filePath !== undefined && touches(call.filePath)) failures.push(`rule 3: turn ${t + 1} opened ${call.filePath} inside the review store`);
        continue;
      }
      const head = call.command.split("\n")[0]!;
      if (PLAIN_SETUP_REVIEW.test(call.command) && plainCall(call.command)) continue;
      if (PLAIN_SETUP_REVIEW.test(call.command)) failures.push(`rule 3: turn ${t + 1} chained another command onto storybloq setup-review: ${head}`);
      else if (touches(call.command)) failures.push(`rule 3: turn ${t + 1} reached the review store other than through storybloq setup-review: ${head}`);
    }
  });

  turns.forEach((turn, t) => {
    if (turn.owner.trim() === SKIP_CHOICE && ownerSkipAt < 0) ownerSkipAt = t;
    for (const call of turn.calls) if (call.command !== null && STATUS_COMMAND.test(call.command)) statusCalls.push({ turn: t, command: call.command, output: call.output });

    const ls = linesOf(turn.text);
    const reviewAt = ls.findIndex((l) => l.startsWith("Independent review:"));
    if (reviewAt < 0) return;
    const review = ls[reviewAt]!;
    const probe = reviewAt > 0 ? ls[reviewAt - 1]! : "";

    // Rule 1: the latest earlier status call whose output starts with exactly these two lines.
    const pair = `${probe}\n${review}\n`;
    const matched = [...statusCalls].reverse().find((c) => c.output.startsWith(pair));
    if (!probe.startsWith("Reviewer probe:") || !matched) {
      failures.push(`rule 1: turn ${t + 1}'s review lines were not printed by an earlier setup-review status call`);
      return;
    }

    let m: RegExpExecArray | null;
    if ((m = COMPLETED.exec(review))) {
      const f = rule2Plan(turn.text, m[2]!, matched, opts.storeRoot);
      if (f) failures.push(f);
    } else if ((m = ROUND_LIMIT.exec(review))) {
      const f = rule2Plan(turn.text, m[1]!, matched, opts.storeRoot);
      if (f) failures.push(f);
    } else if (SKIPPED.test(review)) {
      if (ownerSkipAt < 0 || ownerSkipAt > matched.turn) failures.push("rule 2: a skipped package with no owner message choosing to continue without independent review before the skip");
      if (!/\s--skipped\b/.test(matched.command)) failures.push("rule 2: the skipped line was not printed by status --skipped");
      if (hasStdin(matched.command)) failures.push("rule 2: the status --skipped call was given stdin");
      if (matched.output !== pair) failures.push("rule 2: the skipped package's lines differ from its status --skipped output");
    } else {
      failures.push(`rule 2: the package carries a review line that does not permit approval: ${review}`);
    }
  });

  // Rule 4: the message after an unavailable gate is the four stop lines alone.
  if (opts.unavailableArm) {
    const gateTurn = turns.findIndex((turn) => turn.calls.some((c) => c.command !== null && /^storybloq setup-review gate\b/.test(c.command) && c.output.includes("Reviewer probe: none available")));
    if (gateTurn < 0) failures.push("rule 4: the unavailable arm has no setup-review gate call reporting no reviewer");
    else if (turns[gateTurn]!.text.replace(/\r\n/g, "\n").trim() !== STOP_LINES.join("\n")) failures.push(`rule 4: turn ${gateTurn + 1} is not the four stop lines alone`);
  }

  return { failures };
}

const SHELLS = new Set(["sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh"]);

/** A shell call's command as the shell ran it: an exec wrapper's script (`bash -lc "<script>"`) is unwrapped. */
function shellCommandOf(call: EvalCall): string | null {
  if (call.name !== "Bash" && call.name !== "shell" && call.name !== "exec_command") return null;
  const c = (call.input as { command?: unknown; cmd?: unknown } | null)?.command ?? (call.input as { cmd?: unknown } | null)?.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const argv = c.map(String);
    if (argv.length === 3 && SHELLS.has(argv[0]!) && (argv[1] === "-c" || argv[1] === "-lc")) return argv[2]!;
    return argv.join(" ");
  }
  return null;
}

/** The run's main-agent turns as check set 6 reads them: the owner's prompt, each call's command or file path and output, the final text. */
export function cs6TurnsFrom(turns: readonly DriveTurn[], allCalls: readonly EvalCall[]): Cs6Turn[] {
  return turns.map((t) => ({
    owner: t.prompt,
    text: t.stopText,
    calls: allCalls.slice(t.callRange[0], t.callRange[1]).map((c): Cs6Call => {
      const command = shellCommandOf(c);
      const input = (c.input ?? {}) as { file_path?: unknown; path?: unknown };
      const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
      return { command, ...(command === null && filePath !== undefined ? { filePath } : {}), output: c.result ?? "" };
    }),
  }));
}

/** The run's directory name for its review store copy, beside the turn transcripts. */
export const STORE_COPY = "setup-review-store";
export const STORE_COPY_MISSING = `the run's setup review store copy (${STORE_COPY}) is missing`;

/**
 * Check set 6 as the run applies it and the regrade and cross-check replay it: the failures go after the
 * flow's own, each as a review failure, read against `storeRoot` (the live store, or the run's copy of it).
 */
export function applySetupReviewChecks(state: DriveState, storeRoot: string, variant: Variant): void {
  const cs6 = checkSetupReview(cs6TurnsFrom(state.turns, state.allCalls), { storeRoot, unavailableArm: variant === "reviewer-unavailable" });
  for (const f of cs6.failures) { state.failures.push(f); state.sources.push({ kind: "review" }); }
}
