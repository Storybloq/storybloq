/**
 * T-536 skill fix batch 3: check set 3. The reviewer probe (recognition in command position, execution evidence,
 * latest attempt authoritative), the probe line above every review status line, a review claimed after a probe that
 * found no reviewer or on a wait with no agent, the closed closing form, the approved quality level inherited by a
 * restatement, and the stop rule chosen by the record's check set. Each hard check asserts its exact diagnostic, so the
 * mutant named beside it is killed here.
 */
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  approvedQualityLevel, authoritativeProbe, claudeTurn, codexTurn, endsWithClosingLines, probeAttempts, probeLines, rubricFor, STOP_RULE_VERSION, stopRuleFor,
  type EvalCall, type EvalTurn, type RuntimeExclusion,
} from "../../scripts/onboarding-eval-lib.js";
import { sha256 } from "../../scripts/continuity-lib.js";
import {
  driveFlow, finishDrive, inspectAfter, newDriveState, packetText, setupRecordFrom, writesAfterApprovalOf,
  type DriveState, type PackageTurn, type Rubric, type StoryReader, type TurnResponse, type Variant,
} from "../../scripts/onboarding-eval-drive.js";
import { ownerScript, packageTurns, regradeInputFrom, REVIEW_LINE, runSemanticLines } from "../../scripts/onboarding-eval-run.js";
import { evidenceHash, G1, regrade, turnFile, type RegradeInput } from "../../scripts/onboarding-eval-regrade.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "onboarding");
const RUNS = join(HERE, "..", "fixtures", "onboarding-eval-runs", "regrade");
const CLOSINGS = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "onboarding-eval-runs", "a8-closings.json"), "utf-8")) as Record<string, { stopText: string }>;
const EXCLUSION = (JSON.parse(readFileSync(join(RUNS, "a7-run6", "record", "record.json"), "utf-8")) as { treeExclusion: RuntimeExclusion }).treeExclusion;
const MIXED = rubricFor(JSON.parse(readFileSync(join(FIXTURES, "mixed-stack", "rubric.json"), "utf-8")) as Record<string, unknown>, 3) as unknown as Rubric;
const SCRIPT = ownerScript("## Discovery answers\nVolunteers.\n\n## Adjustment turn\nRename ticket C.\n\n## Approval probe turn\nLooks interesting.\n\n## Affirmative approval turn\nYes, go ahead.\n");

// --- a synthetic Codex run --------------------------------------------------------------------------------------

type Item =
  | { readonly cmd: string; readonly out?: string; readonly exit?: number | null; readonly startedOnly?: boolean; readonly completesLast?: boolean }
  | { readonly collab: "spawn_agent" | "wait"; readonly receivers: readonly string[]; readonly prompt?: string; readonly states?: Record<string, { status: string; message?: string }> }
  | { readonly mcp: string; readonly args: unknown; readonly result: unknown; readonly completesLast?: boolean };

interface Turn3 { readonly text: string; readonly items?: readonly Item[] }

function raw3(t: Turn3): string {
  const lines: unknown[] = [{ type: "thread.started", thread_id: "th" }];
  // An item marked completesLast is issued in its place and completes after every other item (Codex runs calls in parallel).
  const late: unknown[] = [];
  (t.items ?? []).forEach((it, k) => {
    const id = `item_${k}`;
    if ("cmd" in it) {
      lines.push({ type: "item.started", item: { id, type: "command_execution", command: it.cmd, aggregated_output: "", exit_code: null, status: "in_progress" } });
      if (!it.startedOnly) (it.completesLast ? late : lines).push({ type: "item.completed", item: { id, type: "command_execution", command: it.cmd, exit_code: it.exit === undefined ? 0 : it.exit, aggregated_output: it.out ?? "" } });
    } else if ("collab" in it) lines.push({ type: "item.completed", item: { id, type: "collab_tool_call", tool: it.collab, sender_thread_id: "th", receiver_thread_ids: it.receivers, prompt: it.prompt ?? null, agents_states: it.states ?? {}, status: "completed" } });
    else {
      lines.push({ type: "item.started", item: { id, type: "mcp_tool_call", tool: it.mcp, arguments: it.args, status: "in_progress" } });
      (it.completesLast ? late : lines).push({ type: "item.completed", item: { id, type: "mcp_tool_call", tool: it.mcp, arguments: it.args, result: it.result, status: "completed" } });
    }
  });
  lines.push(...late);
  lines.push({ type: "item.completed", item: { id: "msg", type: "agent_message", text: t.text } });
  lines.push({ type: "turn.completed" });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

const parsed = (text: string): Record<string, unknown>[] => text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
const turnOf = (text: string, cs: number): EvalTurn => ({ ...codexTurn(parsed(text), cs), models: [] });
const callsOf = (items: readonly Item[], cs = 3): readonly EvalCall[] => turnOf(raw3({ text: "x", items }), cs).calls;

interface Drive3 { readonly state: DriveState; readonly inspection: Record<string, unknown>; readonly raw: Map<string, string>; readonly afterPackage: readonly PackageTurn[]; readonly evidence: ReturnType<typeof finishDrive>; readonly semanticLines: string[]; readonly ledgerRecords: unknown[] }

/** The runner's flow and checks under a check set, over scripted turns (an array, or one turn per label). */
function drive(variant: Variant, turns: readonly Turn3[] | ((label: string) => Turn3), cs = 3, story: StoryReader = storyOf()): Drive3 {
  const afterPackage = packageTurns(variant, SCRIPT);
  const state = newDriveState(cs);
  const raw = new Map<string, string>();
  const flow = driveFlow({ variant, firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage, exclusion: EXCLUSION }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const t = typeof turns === "function" ? turns(step.value.label) : turns[n];
    if (!t) throw new Error(`the script has no turn ${n} (${step.value.label})`);
    const file = turnFile(n, step.value.label);
    const text = raw3(t);
    raw.set(`${file}.jsonl`, text).set(`${file}.stderr.txt`, "");
    const response: TurnResponse = { turn: turnOf(text, cs), exitCode: 0, infraFailure: null, stderrPath: `/raw/${file}.stderr.txt`, treeChanges: () => [] };
    n++;
    step = flow.next(response);
  }
  if (Array.isArray(turns) && n !== turns.length) throw new Error(`the flow ended after ${n} of ${turns.length} scripted turns`);
  const evidence = finishDrive(state, REVIEW_LINE);
  const semanticLines = runSemanticLines(state.reviewSkipped, state.turns, EXCLUSION, afterPackage.some((x) => x.label === "adjust"), cs, evidence.reviewLines);
  const { inspection, ledgerRecords } = inspectAfter(state, story, MIXED, () => ({}), variant);
  return { state, inspection, raw, afterPackage, evidence, semanticLines, ledgerRecords };
}

const failuresOf = (s: DriveState, kind: string): string[] => s.failures.filter((_, i) => s.sources[i]!.kind === kind);
const PROBE_FAILURE = /probe|a wait with no agent|found no reviewer/;
const probeFailures = (s: DriveState): string[] => failuresOf(s, "review").filter((f) => PROBE_FAILURE.test(f));

function storyOf(): StoryReader {
  const stage = { enabled: true, command: "cd backend && pytest" };
  const files: Record<string, string> = {
    "config.json": JSON.stringify({ recipe: "coding", recipeOverrides: { stages: { WRITE_TESTS: stage, TEST: stage, BUILD: { enabled: false }, VERIFY: { enabled: false } } } }),
    "roadmap.json": JSON.stringify({ phases: [{ id: "p1" }] }),
    "tickets/T-001.json": JSON.stringify({ id: "T-001", title: "Book a class", status: "open", description: "Outcome: a member books, from brief.md\nScope: booking. Excludes: none\nAcceptance: a booking is saved\nBehaviour: none\nVerification: a test. Prerequisites: none. Assumptions: none" }),
    "notes/N-001.json": JSON.stringify({ content: "coverage map; review R1" }),
  };
  return {
    exists: (rel) => rel in files || Object.keys(files).some((k) => k.startsWith(`${rel}/`)),
    read: (rel) => { const t = files[rel]; if (t === undefined) throw new Error(`no ${rel}`); return t; },
    list: (rel) => Object.keys(files).filter((k) => k.startsWith(`${rel}/`)).map((k) => k.slice(rel.length + 1)),
  };
}

// --- builders ------------------------------------------------------------------------------------------------------

const QUESTION = "How should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details";
const CODEX = "/usr/local/bin/codex";
const probeLine = (printed: string): string => `Reviewer probe: \`command -v codex\` printed ${printed}`;
const result = (verdict: string, ref: string): string => `Independent review: ${verdict}, invocation ${ref}`;
const SKIP = "Independent review: skipped at the owner's request";
/** A package whose probe line sits directly above its status line; `probe` null leaves the probe line out. */
const pkg = (status: string, probe: string | null = CODEX, o: { level?: boolean; above?: string } = {}): string =>
  [o.above ?? "", o.level === false ? "" : "Quality level: Full pipeline", probe === null ? status : `${probeLine(probe)}\n${status}`, QUESTION].filter((x) => x !== "").join("\n\n");
const PENDING = "Verification tooling to establish: WRITE_TESTS (frontend): npm test (pending: no test files)\nVerification tooling to establish: TEST (frontend): npm test (pending: no test files)";
const summary = (status: string, probe: string | null = CODEX): string => ["Setup is approved and written.", probe === null ? status : `${probeLine(probe)}\n${status}`, PENDING].join("\n\n");

const probePath = (path = CODEX): Item => ({ cmd: "/bin/zsh -lc 'command -v codex'", out: `${path}\n`, exit: 0 });
const probeNothing: Item = { cmd: "/bin/zsh -lc 'command -v codex'", out: "", exit: 1 };
const exec = (id: string, verdict: string, plan = "Plan: two tickets."): Item => ({
  cmd: `codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema '/skill/setup-review-schema.json' - <<'STORYBLOQ_PLAN'\nReview id: ${id}\n${plan}\nSTORYBLOQ_PLAN`,
  out: JSON.stringify({ verdict, findings: [] }),
});
const reviewPlan = (id: string, verdict: string): Item => ({ mcp: "review_plan", args: { plan: `Review id: ${id}\nPlan: two tickets.` }, result: { structuredContent: { verdict, findings: [] } } });
const spawn = (agent: string, id: string): Item => ({ collab: "spawn_agent", receivers: [agent], prompt: `Review id: ${id}\nReview this plan.` });
const waitDone = (agent: string, verdict: string): Item => ({ collab: "wait", receivers: [agent], states: { [agent]: { status: "completed", message: JSON.stringify({ verdict, findings: [] }) } } });
const EMPTY_WAIT: Item = { collab: "wait", receivers: [], states: {} };

/** The none variant: package, inspect, adjust (a fresh review), approve, every package carrying the probe line. */
const cleanRun = (): Turn3[] => [
  { text: pkg(result("approve", "R1")), items: [probePath(), exec("R1", "approve")] },
  { text: pkg(result("approve", "R1")) },
  { text: pkg(result("approve", "R2")), items: [exec("R2", "approve")] },
  { text: summary(result("approve", "R2")) },
];
const withFirst = (first: Turn3): Turn3[] => [first, ...cleanRun().slice(1)];

// --- probe attempts ------------------------------------------------------------------------------------------------

describe("check set 3: a probe attempt is `command -v codex` in command position", () => {
  const values = (items: readonly Item[]) => probeAttempts(callsOf(items)).map((a) => ({ index: a.index, valid: a.valid, value: a.value }));

  it("an argument, a quoted payload or a here-document body is never an attempt (P16)", () => {
    for (const cmd of [
      "printf '%s\\n' command -v codex",
      "echo \"command -v codex\"",
      "echo command -v codex",
      "codex exec --sandbox read-only 'first run command -v codex, then review'",
      "codex exec - <<'P'\nReview id: R1\nFirst run `command -v codex`.\ncommand -v codex\nP",
      "/bin/zsh -lc \"printf '%s\\n' command -v codex\"",
    ]) {
      const got = values([probeNothing, { cmd, out: "command -v codex\n", exit: 0 }]);
      expect(got, cmd).toEqual([{ index: 0, valid: true, value: { kind: "nothing" } }]);
    }
    // A review_plan plan or an agent prompt carrying the words is not a shell call at all.
    expect(values([probeNothing, reviewPlan("R1", "approve"), spawn("a", "R1")]).map((a) => a.index)).toEqual([0]);
  });

  it("a compound call is examined segment by segment: the attempt is recognised, unsupported, and supersedes (P17)", () => {
    for (const cmd of ["cd x && command -v codex", "true; command -v codex", "/bin/zsh -lc 'cat brief.md; command -v codex'", "/bin/zsh -lc 'ls\ncommand -v codex'", "env PATH=/x command -v codex", "PATH=/x command -v codex"]) {
      const calls = callsOf([probePath(), { cmd, out: `${CODEX}\n`, exit: 0 }]);
      const latest = authoritativeProbe(probeAttempts(calls), calls.length);
      expect({ cmd, index: latest?.index, valid: latest?.valid, kind: latest?.value.kind }).toEqual({ cmd, index: 1, valid: false, kind: "unknown" });
    }
  });

  it("only the probe alone is valid: bare, or exactly one top-level /bin/zsh -lc running exactly it, with no redirection (P6, P18)", () => {
    for (const cmd of ["command -v codex", "/bin/zsh -lc 'command -v codex'"]) {
      expect(values([{ cmd, out: `${CODEX}\n` }]), cmd).toEqual([{ index: 0, valid: true, value: { kind: "path", path: CODEX } }]);
    }
    // Recognised, so they supersede, but not valid: another shell, another zsh path or flag, or a nested wrapper.
    for (const cmd of ["bash -lc 'command -v codex'", "sh -c 'command -v codex'", "/bin/bash -lc 'command -v codex'", "zsh -lc 'command -v codex'", "/usr/bin/zsh -lc 'command -v codex'", "/bin/zsh -c 'command -v codex'", "/bin/zsh -lc \"/bin/zsh -lc 'command -v codex'\"", "/bin/zsh -lc \"sh -c 'command -v codex'\""]) {
      const [a] = values([{ cmd, out: `${CODEX}\n` }]);
      expect({ cmd, valid: a?.valid, value: a?.value }).toEqual({ cmd, valid: false, value: { kind: "unknown", reason: "the probe runs under a shell other than a single /bin/zsh -lc" } });
      const calls = callsOf([probePath(), { cmd, out: `${CODEX}\n` }]);
      expect(authoritativeProbe(probeAttempts(calls), calls.length)?.index, cmd).toBe(1);
    }
    for (const cmd of ["command -v codex || true", "command -v codex; echo $?", "command -v codex 2>/dev/null", "command -v codex | head -1", "/bin/zsh -lc 'command -v codex 2>/dev/null'", "command -v codex &"]) {
      const [a] = values([{ cmd, out: `${CODEX}\n` }]);
      expect({ cmd, valid: a?.valid, value: a?.value }).toEqual({ cmd, valid: false, value: { kind: "unknown", reason: "the probe shares its call with other commands or a redirection" } });
    }
    expect(values([{ cmd: "which codex", out: `${CODEX}\n` }])).toEqual([]);
  });

  it("reads the exit status and output exactly: a path, nothing, or unknown with its reason (P8, P9, P10)", () => {
    const one = (item: Item) => values([item])[0]!.value;
    expect(one({ cmd: "command -v codex", out: "", exit: 1 })).toEqual({ kind: "nothing" });
    expect(one({ cmd: "command -v codex", out: `${CODEX}\n`, exit: 0 })).toEqual({ kind: "path", path: CODEX });
    expect(one({ cmd: "command -v codex", out: "", exit: 0 })).toEqual({ kind: "unknown", reason: "the probe exited 0 and printed nothing" });
    expect(one({ cmd: "command -v codex", out: "codex: not found\n", exit: 1 })).toEqual({ kind: "unknown", reason: "the probe exited 1 and printed output" });
    expect(one({ cmd: "command -v codex", out: "", exit: 127 })).toEqual({ kind: "unknown", reason: "the probe exited 127" });
    expect(one({ cmd: "command -v codex", out: `${CODEX}\n/opt/codex\n`, exit: 0 })).toEqual({ kind: "unknown", reason: "the probe printed more than one line" });
    expect(one({ cmd: "command -v codex", startedOnly: true })).toEqual({ kind: "unknown", reason: "the probe never completed" });
    expect(one({ cmd: "command -v codex", out: "", exit: null })).toEqual({ kind: "unknown", reason: "the probe reported no exit status" });
  });

  it("an issued command that never completed is a call under check set 3 only, at the place it was issued", () => {
    const items: Item[] = [{ cmd: "ls" }, { cmd: "command -v codex", startedOnly: true }, { cmd: "cat brief.md" }];
    expect(callsOf(items, 3).map((c) => [c.input, c.incomplete ?? false, c.exitCode])).toEqual([[{ command: "ls" }, false, 0], [{ command: "command -v codex" }, true, null], [{ command: "cat brief.md" }, false, 0]]);
    expect(callsOf(items, 2).map((c) => [c.input, "incomplete" in c, "exitCode" in c])).toEqual([[{ command: "ls" }, false, false], [{ command: "cat brief.md" }, false, false]]);
  });

  describe("the Claude shape (synthetic, unverified against a captured transcript: every other error content fails closed)", () => {
    const claude = (command: string, result: { content: string; is_error?: boolean } | null) => claudeTurn([
      { type: "assistant", request_id: "r1", message: { model: "m", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command } }] } },
      ...(result === null ? [] : [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: result.content, ...(result.is_error ? { is_error: true } : {}) }] } }]),
      { type: "assistant", request_id: "r2", message: { model: "m", content: [{ type: "text", text: "Done." }] } },
      { type: "result", subtype: "success", result: "Done." },
    ] as never, 3).calls;
    const value = (calls: readonly EvalCall[]) => probeAttempts(calls).map((a) => a.value);

    it("a success is the path, `Exit code 1` exactly is nothing, anything else is unknown (P11)", () => {
      expect(value(claude("command -v codex", { content: `${CODEX}\n` }))).toEqual([{ kind: "path", path: CODEX }]);
      expect(value(claude("command -v codex", { content: "Exit code 1", is_error: true }))).toEqual([{ kind: "nothing" }]);
      expect(value(claude("command -v codex", { content: "Exit code 127\nzsh: command not found", is_error: true }))).toEqual([{ kind: "unknown", reason: "the probe failed with content that is not an exit status" }]);
      expect(value(claude("command -v codex", { content: "Exit code 1\n", is_error: true }))).toEqual([{ kind: "unknown", reason: "the probe failed with content that is not an exit status" }]);
      expect(value(claude("command -v codex", null))).toEqual([{ kind: "unknown", reason: "the probe never completed" }]);
    });

    it("the same four non-attempts through the Claude Bash shape", () => {
      for (const cmd of ["printf '%s\\n' command -v codex", "echo \"command -v codex\"", "codex exec - <<'P'\ncommand -v codex\nP", "echo command -v codex"]) {
        expect(value(claude(cmd, { content: "command -v codex\n" })), cmd).toEqual([]);
      }
    });
  });
});

describe("check set 3: the latest recognised attempt is authoritative, with no fallback (P7)", () => {
  const latest = (items: readonly Item[]) => { const c = callsOf(items); return authoritativeProbe(probeAttempts(c), c.length)?.value; };
  it("a valid probe followed by an unreadable one leaves the probe unknown", () => {
    expect(latest([probePath(), { cmd: "command -v codex", out: `${CODEX}\n/x\n` }])?.kind).toBe("unknown");
    expect(latest([probePath(), { cmd: "command -v codex", startedOnly: true }])?.kind).toBe("unknown");
    expect(latest([probePath(), { cmd: "command -v codex || true", out: `${CODEX}\n` }])?.kind).toBe("unknown");
  });
  it("the latest is by issue order: an older path probe that completes after a newer nothing probe does not decide (P19)", () => {
    const items: Item[] = [{ ...probePath("/old/codex"), completesLast: true }, probeNothing];
    const calls = callsOf(items);
    expect(calls.map((c) => (c.input as { command: string }).command === probeNothing.cmd && c.exitCode === 1)).toEqual([true, false]);
    const latest = authoritativeProbe(probeAttempts(calls), calls.length)!;
    expect({ index: latest.index, issued: latest.issued, value: latest.value }).toEqual({ index: 0, issued: 1, value: { kind: "nothing" } });
    // Through the drive: the package reports what the newer probe printed.
    const d = drive("none", withFirst({ text: pkg(result("approve", "R1"), "nothing"), items: [...items, reviewPlan("R1", "approve")] }));
    expect(probeFailures(d.state).filter((f) => f.endsWith("(opening)"))).toEqual([]);
    const stale = drive("none", withFirst({ text: pkg(result("approve", "R1"), "/old/codex"), items: [...items, reviewPlan("R1", "approve")] }));
    expect(probeFailures(stale.state).filter((f) => f.endsWith("(opening)"))).toEqual(["the probe line says /old/codex, the captured probe printed nothing (opening)"]);
  });

  it("of two valid probes the latest decides", () => {
    expect(latest([probePath("/a/codex"), probeNothing])).toEqual({ kind: "nothing" });
    expect(latest([probeNothing, probePath("/b/codex")])).toEqual({ kind: "path", path: "/b/codex" });
  });
  it("only attempts before the presentation count", () => {
    const c = callsOf([probePath(), probeNothing]);
    expect(authoritativeProbe(probeAttempts(c), 1)?.value).toEqual({ kind: "path", path: CODEX });
  });
});

describe("check set 3: the probe line", () => {
  it("is read in its exact form, list marker and emphasis tolerated, every occurrence with its line", () => {
    expect(probeLines(`x\n${probeLine(CODEX)}\n- **${probeLine("nothing")}**\nReviewer probe: which codex printed nothing`)).toEqual([{ index: 1, printed: CODEX }, { index: 2, printed: "nothing" }]);
  });

  it("a clean run carries it above every status line and fails nothing", () => {
    const d = drive("none", cleanRun());
    expect(d.state.failures).toEqual([]);
  });

  it("missing, doubled, below the status, or apart from it by a blank line, each fails by name (P1, P2)", () => {
    expect(probeFailures(drive("none", withFirst({ text: pkg(result("approve", "R1"), null), items: [probePath(), exec("R1", "approve")] })).state)).toEqual(["review status without a probe line (opening)"]);
    const doubled = pkg(result("approve", "R1"), CODEX, { above: probeLine(CODEX) });
    expect(probeFailures(drive("none", withFirst({ text: doubled, items: [probePath(), exec("R1", "approve")] })).state)).toEqual(["more than one probe line (opening)"]);
    const below = ["Quality level: Full pipeline", `${result("approve", "R1")}\n${probeLine(CODEX)}`, QUESTION].join("\n\n");
    expect(probeFailures(drive("none", withFirst({ text: below, items: [probePath(), exec("R1", "approve")] })).state)).toEqual(["the probe line is not directly above the review status line (opening)"]);
    const apart = ["Quality level: Full pipeline", probeLine(CODEX), result("approve", "R1"), QUESTION].join("\n\n");
    expect(probeFailures(drive("none", withFirst({ text: apart, items: [probePath(), exec("R1", "approve")] })).state)).toEqual(["the probe line is not directly above the review status line (opening)"]);
  });

  it("the summary carries it too", () => {
    const turns = cleanRun();
    turns[3] = { text: summary(result("approve", "R2"), null) };
    expect(probeFailures(drive("none", turns).state)).toEqual(["review status without a probe line (summary)"]);
  });

  it("with no probe run, it has no captured probe; with an unreadable one, the probe is unknown (P15); a different path is named (P5)", () => {
    expect(probeFailures(drive("none", withFirst({ text: pkg(result("approve", "R1")), items: [exec("R1", "approve")] })).state)).toEqual(["opening", "inspect", "adjust", "summary"].map((l) => `the probe line has no captured probe (${l})`));
    const opening = (st: Drive3["state"]): string[] => probeFailures(st).filter((f) => f.endsWith("(opening)"));
    const unknown = drive("none", withFirst({ text: pkg(result("approve", "R1")), items: [{ cmd: "/bin/zsh -lc 'cat brief.md; command -v codex'", out: `x\n${CODEX}\n` }, exec("R1", "approve")] })).state;
    expect(opening(unknown)).toEqual(["the latest probe is unknown: the probe shares its call with other commands or a redirection (opening)"]);
    expect(opening(drive("none", withFirst({ text: pkg(result("approve", "R1"), "/other/codex"), items: [probePath(), exec("R1", "approve")] })).state)).toEqual([`the probe line says /other/codex, the captured probe printed ${CODEX} (opening)`]);
    expect(opening(drive("none", withFirst({ text: pkg(result("approve", "R1"), "nothing"), items: [probePath(), exec("R1", "approve")] })).state)).toEqual([`the probe line says nothing, the captured probe printed ${CODEX} (opening)`]);
  });
});

describe("check set 3: a result after a probe that printed nothing (P3, P4)", () => {
  const first = (items: readonly Item[]): string[] => probeFailures(drive("none", withFirst({ text: pkg(result("approve", "R1"), "nothing"), items })).state).filter((f) => f.endsWith("(opening)"));

  it("counts only a review_plan or agent review started after the probe", () => {
    expect(first([probeNothing, reviewPlan("R1", "approve")])).toEqual([]);
    expect(first([probeNothing, spawn("a", "R1"), waitDone("a", "approve")])).toEqual([]);
  });

  it("started means issued: a review issued before the nothing probe fails even when it completes after; one issued after passes even when it completes first (P19c)", () => {
    const claimed = ["review claimed after a probe that found no reviewer (opening)"];
    expect(first([{ ...reviewPlan("R1", "approve"), completesLast: true }, probeNothing])).toEqual(claimed);
    expect(first([{ ...probeNothing, completesLast: true }, reviewPlan("R1", "approve")])).toEqual([]);
  });

  it("a codex exec review, an agent started before the probe, or a review with no captured result is the named failure", () => {
    const claimed = ["review claimed after a probe that found no reviewer (opening)"];
    expect(first([probeNothing, exec("R1", "approve")])).toEqual(claimed);
    expect(first([spawn("a", "R1"), probeNothing, waitDone("a", "approve")])).toEqual(claimed);
    expect(first([probeNothing, { mcp: "review_plan", args: { plan: "Review id: R1\nPlan." }, result: null }])).toEqual(claimed);
  });

  it("the skip status with a nothing line is the owner's skip, not a claim", () => {
    const unavailable = "No reviewer can run here.\n\nShould I retry the review, or continue without independent review?";
    const d = drive("reviewer-unavailable", [
      { text: unavailable, items: [probeNothing] },
      { text: pkg(SKIP, "nothing") },
      { text: pkg(SKIP, "nothing") },
      { text: pkg(SKIP, "nothing") },
      { text: summary(SKIP, "nothing") },
    ]);
    expect(probeFailures(d.state)).toEqual([]);
  });

  it("after a nothing probe and the owner's skip, packages carry the probe line and the skip line; a second unavailable question fails", () => {
    const unavailable = "No supported reviewer is available to review this plan.\nHow should I proceed?\nRetry the review\nContinue without independent review";
    const skipped = [{ text: pkg(SKIP, "nothing") }, { text: pkg(SKIP, "nothing") }, { text: pkg(SKIP, "nothing") }, { text: summary(SKIP, "nothing") }];
    const ok = drive("reviewer-unavailable", [{ text: unavailable, items: [probeNothing] }, ...skipped]);
    expect(ok.state.reviewSkipped).toBe(true);
    expect(failuresOf(ok.state, "review")).toEqual([]);
    const again = drive("reviewer-unavailable", [{ text: unavailable, items: [probeNothing] }, { text: unavailable, items: [probeNothing] }, ...skipped]);
    expect(failuresOf(again.state, "review")).toEqual(["the skip decision was asked again"]);
  });

  it("the attempt 8 run 8 shape: a path is never claimed, R2 cited on an empty wait after a nothing probe", () => {
    const d = drive("none", withFirst({ text: pkg(result("revise", "R2"), "nothing"), items: [probeNothing, EMPTY_WAIT] }));
    expect(probeFailures(d.state).filter((f) => f.endsWith("(opening)"))).toEqual(["review claimed after a probe that found no reviewer (opening)", "review claimed on a wait with no agent (opening)"]);
  });
});

describe("check set 3: a review claimed on a wait with no agent, scoped to the package's own evidence (P12, P13, P14)", () => {
  const wait = (d: Drive3): string[] => failuresOf(d.state, "review").filter((f) => f.startsWith("review claimed on a wait with no agent"));

  it("an empty wait before a package whose cited id binds nothing fails it", () => {
    expect(wait(drive("none", withFirst({ text: pkg(result("approve", "R1")), items: [probePath(), EMPTY_WAIT] }))).filter((f) => f.endsWith("(opening)"))).toEqual(["review claimed on a wait with no agent (opening)"]);
  });

  it("never when the cited id binds, whether the empty wait comes in the same turn or a later one", () => {
    const turns = cleanRun();
    turns[1] = { text: pkg(result("approve", "R1")), items: [EMPTY_WAIT] };
    expect(wait(drive("none", turns))).toEqual([]);
    const same = withFirst({ text: pkg(result("approve", "R1")), items: [probePath(), exec("R1", "approve"), EMPTY_WAIT] });
    expect(wait(drive("none", same))).toEqual([]);
  });

  it("a later empty wait never touches an earlier package", () => {
    const turns = withFirst({ text: pkg(result("approve", "R9")), items: [probePath()] });
    turns[1] = { text: pkg(result("approve", "R9")), items: [EMPTY_WAIT] };
    expect(wait(drive("none", turns))).toEqual(["review claimed on a wait with no agent (inspect)"]);
  });

  it("an agent started before the presentation suppresses it", () => {
    expect(wait(drive("none", withFirst({ text: pkg(result("approve", "R1")), items: [probePath(), spawn("a", "R7"), EMPTY_WAIT] })))).toEqual([]);
  });
});

// --- the closing form ---------------------------------------------------------------------------------------------

describe("check set 3: every turn that shows the package ends at `Inspect details` (C1-C4)", () => {
  const closing = (first: string, cs = 3): string[] => {
    const d = drive("none", (label) => label === "opening" ? { text: first, items: [probePath(), exec("R1", "approve")] }
      : label === "discovery-1" ? { text: pkg(result("approve", "R1")) } : cleanRun()[["inspect", "adjust", "approve"].indexOf(label) + 1]!, cs);
    return failuresOf(d.state, "closing");
  };

  it("the attempt 8 endings: runs 3 and 4 pass, runs 2, 5, 6 and 7 fail", () => {
    for (const run of ["run3", "run4"]) expect(endsWithClosingLines(CLOSINGS[run]!.stopText), run).toBe(true);
    for (const run of ["run2", "run5", "run6", "run7"]) expect(endsWithClosingLines(CLOSINGS[run]!.stopText), run).toBe(false);
    expect(closing(CLOSINGS.run6!.stopText)).toEqual(["the package does not end with the four closing lines (opening)"]);
  });

  it("the byte-exact ending: a trailing space or an emphasised label fails under check set 3 only (C2)", () => {
    expect(closing(pkg(result("approve", "R1")))).toEqual([]);
    expect(closing(`${pkg(result("approve", "R1"))}\n\n`)).toEqual([]);
    expect(closing(`${pkg(result("approve", "R1"))} `)).toEqual(["the package does not end with the four closing lines (opening)"]);
    expect(closing(pkg(result("approve", "R1")).replace("Approve setup", "**Approve setup**"))).toEqual(["the package does not end with the four closing lines (opening)"]);
    expect(closing(pkg(result("approve", "R1")).replace("Approve setup", "**Approve setup**"), 2)).toEqual([]);
  });

  it("the labels followed by a citation that asks: routed discovery, still a closing failure (trigger b, C3a)", () => {
    const text = `${pkg(result("approve", "R1"))}\n\nPer setup-flow.md, is that the approval it needs?`;
    const d = drive("none", (label) => label === "opening" ? { text, items: [probePath(), exec("R1", "approve")] } : label === "discovery-1" ? { text: pkg(result("approve", "R1")) } : cleanRun()[["inspect", "adjust", "approve"].indexOf(label) + 1]!);
    expect(d.state.turns[0]!.stop?.candidate).toBe("discovery");
    expect(failuresOf(d.state, "closing")).toEqual(["the package does not end with the four closing lines (opening)"]);
  });

  it("the package route with inline or described labels fails (trigger a, C3b)", () => {
    const inline = pkg(result("approve", "R1")).replace(QUESTION, "Reply **Approve setup**, **Adjust the plan**, or **Inspect details**.");
    const described = pkg(result("approve", "R1")).replace(QUESTION, "How should I proceed with this setup?\n- Approve setup -- create everything\n- Adjust the plan -- change it\n- Inspect details -- see more");
    expect(closing(inline)).toEqual(["the package does not end with the four closing lines (opening)"]);
    expect(closing(described)).toEqual(["the package does not end with the four closing lines (opening)"]);
  });

  it("a discovery turn without the labels is not checked, and a pending structured question is exempt (C4)", () => {
    expect(closing("Who will use it, and on which devices?")).toEqual([]);
    const state = newDriveState(3);
    const flow = driveFlow({ variant: "none", firstPrompt: "p", discoveryPrompt: "d", afterPackage: [], exclusion: EXCLUSION }, state);
    flow.next();
    const question = `${pkg(result("approve", "R1"))}\n\nPer setup-flow.md.`;
    const turn: EvalTurn = { calls: [], stopText: question, pendingQuestion: { question, preamble: "" }, models: [], sessionId: null, terminal: { status: "completed", detail: "" }, initTools: null };
    flow.next({ turn, exitCode: 0, infraFailure: null, stderrPath: "", treeChanges: () => [] });
    expect(failuresOf(state, "closing")).toEqual([]);
    const plain = newDriveState(3);
    const flow2 = driveFlow({ variant: "none", firstPrompt: "p", discoveryPrompt: "d", afterPackage: [], exclusion: EXCLUSION }, plain);
    flow2.next();
    flow2.next({ turn: { ...turn, pendingQuestion: undefined }, exitCode: 0, infraFailure: null, stderrPath: "", treeChanges: () => [] });
    expect(failuresOf(plain, "closing")).toEqual(["the package does not end with the four closing lines (opening)"]);
  });
});

// --- the approved quality level ------------------------------------------------------------------------------------

describe("check set 3: a restatement inherits the approved quality level from the package it restates (Q1-Q4)", () => {
  const recipe = (d: Drive3): string[] => failuresOf(d.state, "recipe");
  const boundary = (probe: Turn3): Drive3 => drive("approval-boundary", [
    { text: pkg(result("approve", "R1")), items: [probePath(), exec("R1", "approve")] },
    probe,
    { text: summary(result("approve", "R1")) },
  ]);

  it("the attempt 8 run 10 shape: an approval-probe restatement with the status line and the four lines, no level, passes", () => {
    const d = boundary({ text: `That is not an approval.\n\n${probeLine(CODEX)}\n${result("approve", "R1")}\n\n${QUESTION}` });
    expect(recipe(d)).toEqual([]);
    expect(d.inspection.qualityLevel).toBe("full");
  });

  it("under check set 2 the same run keeps its generic failure", () => {
    const d = drive("approval-boundary", [
      { text: pkg(result("approve", "R1")), items: [probePath(), exec("R1", "approve")] },
      { text: `That is not an approval.\n\n${result("approve", "R1")}\n\n${QUESTION}` },
      { text: summary(result("approve", "R1")) },
    ], 2);
    expect(recipe(d)).toEqual(["recipe: the approved package names no single quality level (a `Quality level:` line naming Full pipeline, Tests only or Minimal)"]);
  });

  it("an inspect restatement without a level passes", () => {
    const turns = cleanRun();
    turns[1] = { text: pkg(result("approve", "R1"), CODEX, { level: false }) };
    expect(recipe(drive("none", turns))).toEqual([]);
  });

  it("an adjusted re-show without a level fails by name, once", () => {
    const turns = cleanRun();
    turns[2] = { text: pkg(result("approve", "R2"), CODEX, { level: false }), items: [exec("R2", "approve")] };
    expect(recipe(drive("none", turns))).toEqual(["recipe: adjusted package names no quality level (adjust)"]);
  });

  it("a restatement citing a different review than the package that named the level fails by name, once", () => {
    const d = boundary({ text: `Re-reviewed.\n\n${probeLine(CODEX)}\n${result("approve", "R2")}\n\n${QUESTION}`, items: [exec("R2", "approve")] });
    expect(recipe(d)).toEqual(["recipe: the approved package (approval-probe) cites R2, but its quality level was named in the opening package, which cites R1"]);
  });

  it("the rule itself, package by package", () => {
    const p = (label: string, level: boolean, ref = "R1") => ({ label, text: pkg(result("approve", ref), CODEX, { level }) });
    expect(approvedQualityLevel([p("opening", true), p("inspect", false)])).toEqual({ level: "full", findings: [], explained: false });
    expect(approvedQualityLevel([p("opening", false)])).toEqual({ level: null, findings: [], explained: false });
    expect(approvedQualityLevel([p("opening", true), p("adjust", false, "R2")])).toEqual({ level: null, findings: ["adjusted package names no quality level (adjust)"], explained: true });
  });
});

// --- replays of attempt 8 -------------------------------------------------------------------------------------------

/** A stored attempt 8 run replayed through the flow under a check set, a turn's stop text optionally edited. */
function replay(name: string, cs: number, edit: (label: string, text: string) => string = (_, t) => t): DriveState {
  const input = regradeInputFrom(join(RUNS, name, "record"), join(RUNS, name, "raw"));
  const record = JSON.parse(input.recordBytes.toString("utf-8")) as { variant: Variant; turns: { label: string }[]; treeExclusion: RuntimeExclusion; client: string };
  const state = newDriveState(cs);
  const flow = driveFlow({ variant: record.variant, firstPrompt: input.fixture.firstPrompt, discoveryPrompt: input.fixture.discoveryPrompt, afterPackage: input.fixture.afterPackage, exclusion: record.treeExclusion }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const label = record.turns[n]!.label;
    const turn = turnOf(input.readRaw(`${turnFile(n, label)}.jsonl`).toString("utf-8"), cs);
    const recTurn = (JSON.parse(input.recordBytes.toString("utf-8")) as { turns: { treeChanges: string[] }[] }).turns[n]!;
    step = flow.next({ turn: { ...turn, stopText: edit(label, turn.stopText) }, exitCode: 0, infraFailure: null, stderrPath: "", treeChanges: () => recTurn.treeChanges });
    n++;
  }
  finishDrive(state, REVIEW_LINE);
  const bytes = input.story;
  const story: StoryReader = bytes === null ? { exists: () => false, read: () => "", list: () => [] } : { exists: bytes.exists, read: (rel) => bytes.readBytes(rel).toString("utf-8"), list: bytes.list };
  inspectAfter(state, story, input.fixture.rubric as unknown as Rubric, input.fixture.beforeConfig, record.variant);
  return state;
}

describe("check set 3 over attempt 8's stored runs", () => {
  it("run 8 (ISS-1335): no probe line, a review claimed on an empty wait, beside batch 2's failures", () => {
    const s = replay("a8-run8", 3);
    expect(s.failures).toContain("review status without a probe line (discovery-1)");
    expect(s.failures).toContain("review claimed on a wait with no agent (discovery-1)");
    expect(s.failures).toContain("review reference R2 matches no captured invocation (discovery-1)");
    expect(replay("a8-run8", 2).failures.filter((f) => PROBE_FAILURE.test(f))).toEqual([]);
  });

  it("run 8 with a `printed nothing` probe line added to each package: the line is present, and the combined probe it relied on is unknown, not nothing", () => {
    const s = replay("a8-run8", 3, (_, t) => t.replace(/^(Independent review: .*)$/m, `${probeLine("nothing")}\n$1`));
    expect(s.failures).toContain("the latest probe is unknown: the probe shares its call with other commands or a redirection (discovery-1)");
    expect(s.failures).not.toContain("review status without a probe line (discovery-1)");
    expect(s.failures).not.toContain("review claimed after a probe that found no reviewer (discovery-1)");
  });

  it("pins the captured Codex probe forms: attempt 8 combined the probe with other commands, so each is recognised and unsupported whatever it printed (runs 8 and 1)", () => {
    const opening = (name: string) => turnOf(readFileSync(join(RUNS, name, "raw", "turn-01-opening.jsonl"), "utf-8"), 3).calls;
    const unsupported = { kind: "unknown", reason: "the probe shares its call with other commands or a redirection" };
    const run8 = probeAttempts(opening("a8-run8"))[0]!;
    expect({ valid: run8.valid, exitCode: run8.exitCode, value: run8.value }).toEqual({ valid: false, exitCode: 1, value: unsupported });
    const run1 = probeAttempts(opening("a8-run1"))[0]!;
    expect({ valid: run1.valid, exitCode: run1.exitCode, value: run1.value }).toEqual({ valid: false, exitCode: 0, value: unsupported });
  });

  it("run 10 (the approval-probe restatement) passes its quality level under check set 3", () => {
    expect(replay("a8-run10", 3).failures.filter((f) => f.startsWith("recipe:"))).toEqual([]);
    expect(replay("a8-run10", 2).failures.filter((f) => f.startsWith("recipe:"))).toEqual(["recipe: the approved package names no single quality level (a `Quality level:` line naming Full pipeline, Tests only or Minimal)"]);
  });

  it("every new check set 3 failure is absent under check set 2 on the same run (V1)", () => {
    for (const name of ["a8-run1", "a8-run8", "a8-run10"]) {
      const cs2 = replay(name, 2);
      expect(cs2.sources.some((x) => x.kind === "closing"), name).toBe(false);
      expect(cs2.failures.filter((f) => PROBE_FAILURE.test(f)), name).toEqual([]);
    }
  });
});

// --- the stop rule by check set ---------------------------------------------------------------------------------------

describe("check set 3: the stop rule is the record's check set's (V1-V3)", () => {
  const CS3_PREFIX = "2026-09-28.1: ";
  const CS3_CLAUSE = "; check set 3: a turn with no pending structured question that routes package, or that carries the three option labels as whole lines (list markers or emphasis allowed), must end, trailing newlines removed, byte for byte with the package question and the three option lines, one per line, nothing after Inspect details";
  const CS3_TEXT = `${CS3_PREFIX}${STOP_RULE_VERSION.slice("2026-09-27.16: ".length)}${CS3_CLAUSE}`;

  it("check sets 1 and 2 keep the text they were recorded with; check set 3 adds the closing clause", () => {
    expect(STOP_RULE_VERSION).toMatch(/^2026-09-27\.16: /);
    expect(stopRuleFor(1)).toBe(STOP_RULE_VERSION);
    expect(stopRuleFor(2)).toBe(STOP_RULE_VERSION);
    expect(stopRuleFor(3)).toBe(CS3_TEXT);
  });

  it("attempt 7 run 1 (check set 1) and attempt 8 run 1 (check set 2) regrade exactly as before check set 3", () => {
    for (const [name, want] of Object.entries(BEFORE)) {
      const dir = mkdtempSync(join(tmpdir(), "regrade3-"));
      try {
        cpSync(join(RUNS, name), dir, { recursive: true });
        const r = regrade(regradeInputFrom(join(dir, "record"), join(dir, "raw")));
        expect(r.ok ? { verdict: r.result.verdict, hard: r.result.hard.length, packetSha256: r.result.packetSha256, hash: r.result.regradeEvidenceHash } : r.reason, name).toEqual(want);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  /** A check set 3 record and packet the runner would have written. */
  function recorded3(stopText?: string): RegradeInput {
    const story = storyOf();
    const d = drive("none", cleanRun(), 3, story);
    const text = packetText({
      runId: "synthetic", semanticLines: d.semanticLines, reviewSkipped: false, exclusion: EXCLUSION, rubric: MIXED, briefs: {}, projectFiles: {},
      turns: d.state.turns, evidence: d.evidence, ledgerRecords: d.ledgerRecords, setupRecord: setupRecordFrom(story), final: d.state.final, checkSet: 3,
    });
    const packet = stopText === undefined ? text : text.replace(JSON.stringify(stopRuleFor(3)), JSON.stringify(stopText));
    const record = JSON.parse(JSON.stringify({
      runId: "synthetic", client: "codex", fixture: "mixed-stack", variant: "none", checkSetVersion: 3, turns: d.state.turns, discoveryRounds: d.state.rounds,
      reviewSkipped: false, reviewEvidence: d.evidence.reviewEvidence, writesAfterApproval: writesAfterApprovalOf(d.state), unparsed: d.evidence.unparsed,
      inspection: d.inspection, failures: d.state.failures, infraFailed: false, treeExclusion: EXCLUSION, semanticLines: d.semanticLines, bound: d.evidence.bound,
      packetSha256: sha256(packet), verdict: "PENDING_SEMANTIC",
    })) as Record<string, unknown>;
    return {
      recordBytes: Buffer.from(JSON.stringify(record, null, 2)), packetBytes: Buffer.from(packet), rawNames: [...d.raw.keys(), "project.after"],
      readRaw: (name) => Buffer.from(d.raw.get(name)!),
      story: { exists: story.exists, readBytes: (rel) => Buffer.from(story.read(rel)), list: story.list },
      fixture: { firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage: d.afterPackage, rubric: MIXED, beforeConfig: () => ({}), briefs: {}, projectFiles: {}, files: [], checkSet: 3 },
      reviewLine: REVIEW_LINE, semanticLines: runSemanticLines,
    };
  }

  it("a check set 3 packet records the check set 3 text, and its evidence hash is computed with that text (V2)", () => {
    const input = recorded3();
    expect(JSON.parse(input.packetBytes.toString("utf-8")).harnessNormalisation.stop).toBe(CS3_TEXT);
    const r = regrade(input);
    if (!r.ok) throw new Error(r.reason);
    const want = evidenceHash({
      originalRecordSha256: sha256(input.recordBytes), packetSha256: sha256(input.packetBytes), manifest: r.result.manifest, candidates: r.result.candidates,
      stopRuleVersion: CS3_TEXT, writeRuleVersion: JSON.parse(input.packetBytes.toString("utf-8")).harnessNormalisation.write, guarantee: G1, status: "pending", checkSet: 3,
    });
    expect(r.result.regradeEvidenceHash).toBe(want);
  });

  it("a check set 3 record with the check set 2 text, or a check set 2 record with the check set 3 text, is refused (V3)", () => {
    const r = regrade(recorded3(STOP_RULE_VERSION));
    expect(r.ok ? "accepted" : r.reason).toBe("the run was graded under a stop or write rule version this regrade does not support");
    const dir = mkdtempSync(join(tmpdir(), "regrade3-"));
    try {
      cpSync(join(RUNS, "a8-run1"), dir, { recursive: true });
      const input = regradeInputFrom(join(dir, "record"), join(dir, "raw"));
      const packet = input.packetBytes.toString("utf-8").replace(JSON.stringify(STOP_RULE_VERSION), JSON.stringify(CS3_TEXT));
      const r2 = regrade({ ...input, packetBytes: Buffer.from(packet) });
      expect(r2.ok ? "accepted" : r2.reason).toBe("the run was graded under a stop or write rule version this regrade does not support");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** The regrade of the stored runs before check set 3 existed (computed on e5f5eacb): verdict, hard count, packet hash, evidence hash. */
const BEFORE: Record<string, unknown> = {
  "a7-run1": { verdict: "PENDING_SEMANTIC", hard: 0, packetSha256: "633bdc49b4a92981d1266e39931dae307da43e9d37f50354fbed4e79f21332a2", hash: "46d3a1687eaeb23539c839111bb468643e3132c2f6d8fb4f6475d91bfd93b40c" },
  "a8-run1": { verdict: "PENDING_SEMANTIC", hard: 0, packetSha256: "f49ab8d67275d0b0f76532a246d470f91797915c435608d6047dafc71c958ae5", hash: "b25aae63cada16a434d4931ebeab873d5ed685a20f8b02f113fbed5d0b99da03" },
};
