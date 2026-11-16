/**
 * C-v4.1 commit 4 fixup (Codex finding 1): a configured pattern is user
 * input that can arrive with a cloned repository, and a backtracking pattern
 * such as `(a+)+$` would block the CLI or the long-lived MCP server. Every
 * configured pattern therefore runs inside node:vm with a deadline over the
 * whole batch of inputs: V8 interrupts a running regex at the deadline (proven
 * by an adversarial test on node 22). A timed-out pattern makes the facts
 * unknown with reason "pattern timeout", never a hang.
 *
 * The built-in defaults (the landings matcher and the release default) are
 * fixed, linear patterns and run natively.
 */
import vm from "node:vm";
import { MAX_MATCH_INPUT_LENGTH } from "./snapshot.js";

/** The deadline for one batch of matches against one configured pattern. */
export const PATTERN_DEADLINE_MS = 1_000;

export class PatternTimeoutError extends Error {
  constructor(readonly field: string) {
    super(`${field}: the pattern did not finish within ${PATTERN_DEADLINE_MS} ms`);
  }
}

const cut = (s: string): string => (s.length > MAX_MATCH_INPUT_LENGTH ? s.slice(0, MAX_MATCH_INPUT_LENGTH) : s);

const TOKENS = new vm.Script(`(() => {
  const g = new RegExp(source, flags.includes("g") ? flags : flags + "g");
  const out = [];
  for (const text of inputs) {
    const seen = new Set();
    for (const m of text.matchAll(g)) {
      const t = m[1] ?? m[0];
      if (t.length > 0) seen.add(t);
    }
    out.push([...seen]);
  }
  return JSON.stringify(out);
})()`);

const TESTS = new vm.Script(`(() => {
  const re = new RegExp(source, flags.replace("g", "").replace("y", ""));
  return JSON.stringify(inputs.map((s) => re.test(s)));
})()`);

function run(script: vm.Script, field: string, re: RegExp, inputs: readonly string[], deadlineMs: number): string {
  try {
    return script.runInNewContext({ source: re.source, flags: re.flags, inputs: inputs.map(cut) }, { timeout: deadlineMs }) as string;
  } catch (e) {
    if ((e as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new PatternTimeoutError(field);
    throw e;
  }
}

/** Each input's tokens: every match's first capture group, or the whole match when it has none. */
export function sandboxTokens(field: string, re: RegExp, inputs: readonly string[], deadlineMs = PATTERN_DEADLINE_MS): string[][] {
  return JSON.parse(run(TOKENS, field, re, inputs, deadlineMs)) as string[][];
}

/** Whether each input matches. */
export function sandboxTests(field: string, re: RegExp, inputs: readonly string[], deadlineMs = PATTERN_DEADLINE_MS): boolean[] {
  return JSON.parse(run(TESTS, field, re, inputs, deadlineMs)) as boolean[];
}
