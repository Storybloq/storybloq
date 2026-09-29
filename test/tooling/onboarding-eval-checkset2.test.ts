/**
 * T-536 skill fix batch 2: check set 2. The review status line and its evidence binding, the adjustment-status
 * validator, spawn-and-wait reviewer agents, pending-tooling lines, the command-evidence contract and grammar, the
 * discovery tail, and the versioning that keeps every run graded under the checks it was recorded with. Each hard
 * check asserts its exact diagnostic, so the mutant named beside it is killed here.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHECK_SET_VERSION, codexTurn, discoveryTail, notRerunLines, pendingFindings, pendingInventory, pendingLines, qualityLevel, recipeContract,
  recipeFindings, resolveTestStages, reviewerInvocations, reviewStatus, rubricFor, runVerdict, shellQuote, testCommandFindings, verdictOf,
  type EvalCall, type ExpectedRecipe, type RecipeContract, type RuntimeExclusion,
} from "../../scripts/onboarding-eval-lib.js";
import { sha256 } from "../../scripts/continuity-lib.js";
import {
  driveFlow, finishDrive, inspectAfter, newDriveState, packetText, setupRecordFrom, writesAfterApprovalOf,
  type DriveEvidence, type DriveState, type PackageTurn, type Rubric, type StoryReader, type TurnResponse, type Variant,
} from "../../scripts/onboarding-eval-drive.js";
import { restatementLine } from "../../scripts/onboarding-eval-drive.js";
import { ownerScript, packageTurns, REVIEW_LINE, REVIEW_STATEMENTS_LINE, runSemanticLines } from "../../scripts/onboarding-eval-run.js";
import { regrade, turnFile, type RegradeInput } from "../../scripts/onboarding-eval-regrade.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "onboarding");
const RUNS = join(HERE, "..", "fixtures", "onboarding-eval-runs", "regrade");
const RECIPES = join(HERE, "..", "fixtures", "onboarding-recipe");
const EXCLUSION = (JSON.parse(readFileSync(join(RUNS, "a7-run6", "record", "record.json"), "utf-8")) as { treeExclusion: RuntimeExclusion }).treeExclusion;
const rubricOf = (fixture: string, cs = 2): Rubric => rubricFor(JSON.parse(readFileSync(join(FIXTURES, fixture, "rubric.json"), "utf-8")) as Record<string, unknown>, cs) as unknown as Rubric;
const MIXED = rubricOf("mixed-stack");
const SCRIPT = ownerScript("## Discovery answers\nVolunteers.\n\n## Adjustment turn\nRename ticket C.\n\n## Approval probe turn\nLooks interesting.\n\n## Affirmative approval turn\nYes, go ahead.\n");
const PYTEST = ["pytest", "python -m pytest", "python3 -m pytest"];

// --- a synthetic Codex run under check set 2 ----------------------------------------------

type Item =
  | { readonly cmd: string; readonly out?: string; readonly exit?: number }
  | { readonly collab: "spawn_agent" | "wait"; readonly receivers: readonly string[]; readonly prompt?: string; readonly states?: Record<string, { status: string; message?: string }>; readonly failed?: boolean }
  | { readonly mcp: string; readonly args: unknown; readonly result: unknown };

interface Turn2 { readonly text: string; readonly items?: readonly Item[] }

function raw2(t: Turn2): string {
  const lines: unknown[] = [{ type: "thread.started", thread_id: "th" }];
  for (const it of t.items ?? []) {
    if ("cmd" in it) lines.push({ type: "item.completed", item: { type: "command_execution", command: it.cmd, exit_code: it.exit ?? 0, aggregated_output: it.out ?? "" } });
    else if ("collab" in it) lines.push({ type: "item.completed", item: { type: "collab_tool_call", tool: it.collab, sender_thread_id: "th", receiver_thread_ids: it.receivers, prompt: it.prompt ?? null, agents_states: it.states ?? {}, status: it.failed ? "failed" : "completed" } });
    else lines.push({ type: "item.completed", item: { type: "mcp_tool_call", tool: it.mcp, arguments: it.args, result: it.result, status: "completed" } });
  }
  lines.push({ type: "item.completed", item: { type: "agent_message", text: t.text } });
  lines.push({ type: "turn.completed" });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

const turnOf = (text: string, cs = 2) => ({ ...codexTurn(text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>), cs), models: [] as string[] });

interface Drive2 {
  readonly state: DriveState;
  readonly evidence: DriveEvidence;
  readonly semanticLines: string[];
  readonly raw: Map<string, string>;
  readonly afterPackage: readonly PackageTurn[];
  readonly inspection: Record<string, unknown>;
  readonly ledgerRecords: unknown[];
}

/** The runner's flow and checks under check set 2, over scripted turns, without spawning a client. */
function drive2(variant: Variant, turns: readonly Turn2[], o: { afterPackage?: readonly PackageTurn[]; story?: StoryReader; rubric?: Rubric } = {}): Drive2 {
  const afterPackage = o.afterPackage ?? packageTurns(variant, SCRIPT);
  const state = newDriveState(2);
  const raw = new Map<string, string>();
  const flow = driveFlow({ variant, firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage, exclusion: EXCLUSION }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const t = turns[n];
    if (!t) throw new Error(`the script has no turn ${n} (${step.value.label})`);
    const file = turnFile(n, step.value.label);
    const text = raw2(t);
    raw.set(`${file}.jsonl`, text).set(`${file}.stderr.txt`, "");
    const response: TurnResponse = { turn: turnOf(text), exitCode: 0, infraFailure: null, stderrPath: `/raw/synthetic/${file}.stderr.txt`, treeChanges: () => [] };
    n++;
    step = flow.next(response);
  }
  if (n !== turns.length) throw new Error(`the flow ended after ${n} of ${turns.length} scripted turns`);
  const evidence = finishDrive(state, REVIEW_LINE);
  const semanticLines = runSemanticLines(state.reviewSkipped, state.turns, EXCLUSION, afterPackage.some((x) => x.label === "adjust"), 2, evidence.reviewLines);
  const { inspection, ledgerRecords } = inspectAfter(state, o.story ?? storyOf(null), o.rubric ?? MIXED, () => ({}), variant);
  return { state, evidence, semanticLines, raw, afterPackage, inspection, ledgerRecords };
}

const failuresOf = (s: DriveState, kind: string): string[] => s.failures.filter((_, i) => s.sources[i]!.kind === kind);

/** An in-memory `.story/` after approval: the recipe stages given, one phase, one ticket, a setup note. */
function storyOf(testCommand: string | null, o: { writeTests?: boolean; test?: boolean } = {}): StoryReader {
  const stage = (enabled: boolean): Record<string, unknown> => (testCommand === null || !enabled ? { enabled: false } : { enabled: true, command: testCommand });
  const files: Record<string, string> = {
    "config.json": JSON.stringify({ recipe: "coding", recipeOverrides: { stages: { WRITE_TESTS: stage(o.writeTests ?? true), TEST: stage(o.test ?? true), BUILD: { enabled: false }, VERIFY: { enabled: false } } } }),
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

// --- turn builders -------------------------------------------------------------------------

const QUESTION = "How should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details";
const pkg = (status: string | null, above = ""): string => [above, "Quality level: Full pipeline", status ?? "", QUESTION].filter((x) => x !== "").join("\n\n");
const result = (verdict: string, ref: string): string => `Independent review: ${verdict}, invocation ${ref}`;
const SKIP = "Independent review: skipped at the owner's request";
const summary = (status: string | null, extra = ""): string => ["Setup is approved and written.", status ?? "", extra].filter((x) => x !== "").join("\n\n");
const declare = (what: string): string => `Review not rerun: ${what} changes no ticket's scope, dependencies or responsibilities.`;
const PENDING = "Verification tooling to establish: WRITE_TESTS (frontend): npm test (pending: no test files)\nVerification tooling to establish: TEST (frontend): npm test (pending: no test files)";

/** A native Codex review whose here-document carries `Review id: <id>`, returning the schema's verdict. */
const exec = (id: string, verdict: string, plan = "Plan: two tickets.", exit = 0): Item => ({
  cmd: `codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema '/skill/setup-review-schema.json' - <<'STORYBLOQ_PLAN'\nReview id: ${id}\n${plan}\nSTORYBLOQ_PLAN`,
  out: exit === 0 ? JSON.stringify({ verdict, findings: [] }) : "error: model unavailable",
  exit,
});
const reviewPlan = (id: string, verdict: string): Item => ({ mcp: "review_plan", args: { plan: `Review id: ${id}\nPlan: two tickets.` }, result: { structuredContent: { verdict, findings: [] } } });
const spawn = (agent: string, id: string): Item => ({ collab: "spawn_agent", receivers: [agent], prompt: `Review id: ${id}\nReview this plan.` });
const wait = (agent: string, state?: { status: string; message?: string }): Item => ({ collab: "wait", receivers: [agent], states: state === undefined ? {} : { [agent]: state } });
const done = (verdict: string): { status: string; message: string } => ({ status: "completed", message: JSON.stringify({ verdict, findings: [] }) });

/** The standard none-variant run: first package, inspect, adjust, approve. */
const run = (first: Turn2, inspect: Turn2, adjust: Turn2, approve: Turn2, story?: StoryReader): Drive2 => drive2("none", [first, inspect, adjust, approve], { story });
const clean = (): Turn2[] => [
  { text: pkg(result("approve", "R1")), items: [exec("R1", "approve")] },
  { text: pkg(result("approve", "R1")) },
  { text: pkg(result("approve", "R1"), declare("the title of ticket C")) },
  { text: summary(result("approve", "R1"), PENDING) },
];

// --- the status line -------------------------------------------------------------------------

describe("check set 2: the review status line", () => {
  it("parses the two exact forms per line, and nothing else (M2)", () => {
    expect(reviewStatus("Independent review: approve, invocation R1")).toEqual({ kind: "result", verdict: "approve", ref: "R1" });
    expect(reviewStatus("- **Independent review: pass with minor revisions, invocation R12**  ")).toEqual({ kind: "result", verdict: "pass with minor revisions", ref: "R12" });
    expect(reviewStatus("Independent review: skipped at the owner’s request")).toEqual({ kind: "skip" });
    expect(reviewStatus("Independent review: passed")).toEqual({ kind: "none" });
    expect(reviewStatus("The reviewer approved it")).toEqual({ kind: "none" });
    expect(reviewStatus("Independent review could not run, but the plan passed my own checks")).toEqual({ kind: "none" });
    expect(reviewStatus("codex was not found. Independent review: skipped at the owner's request")).toEqual({ kind: "none" });
    expect(reviewStatus("codex was not found.\nIndependent review: skipped at the owner's request")).toEqual({ kind: "skip" });
    expect(reviewStatus(`${result("approve", "R1")}\n${result("approve", "R2")}`)).toEqual({ kind: "several" });
    expect(reviewStatus("Independent review: approve, invocation R0")).toEqual({ kind: "none" });
    expect(reviewStatus("The reviewer wrote Independent review: approve, invocation R1")).toEqual({ kind: "none" });
    expect(reviewStatus("Independent review: approve, invocation R1, then more")).toEqual({ kind: "none" });
  });

  it("a clean run: status lines bind, the summary cites the approved package, no review failure", () => {
    const d = run(...(clean() as [Turn2, Turn2, Turn2, Turn2]), storyOf("cd backend && pytest"));
    expect(failuresOf(d.state, "review")).toEqual([]);
    expect(d.semanticLines).toContain(REVIEW_STATEMENTS_LINE);
  });

  it("a package with no status line fails (M1)", () => {
    const t = clean();
    const d = run({ ...t[0]!, text: pkg(null) }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("review status line missing (opening)");
  });

  it("run 8's shape replayed under check set 2: an outcome narrated with no status line fails as missing", () => {
    const text = pkg(null, "Independent review returned **“pass with minor revisions”** and **“No blocking coverage gaps.”**");
    const d = run({ text }, { text: pkg(null) }, { text: pkg(null, "Independent review returned **“pass”**, with no blocking findings.") }, { text: summary(null, "Independent review passed; validation found no errors or warnings.") });
    expect(failuresOf(d.state, "review")).toEqual(["review status line missing (opening)", "review status line missing (inspect)", "review status line missing (adjust)", "review status line missing (summary)"]);
    expect(failuresOf(d.state, "no-reviewer")).toHaveLength(1);
  });

  it("two status lines in one package fail (Ms0)", () => {
    const t = clean();
    const d = run({ ...t[0]!, text: pkg(`${result("approve", "R1")}\n${result("approve", "R1")}`) }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("more than one review status line (opening)");
  });

  it("a reference with no captured invocation fails (Mr1)", () => {
    const t = clean();
    const d = run({ ...t[0]!, text: pkg(result("approve", "R2")) }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("review reference R2 matches no captured invocation (opening)");
  });

  it("a reference two invocations carry fails (Mr2)", () => {
    const t = clean();
    const d = run({ ...t[0]!, items: [exec("R1", "approve"), exec("R1", "approve")] }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("review reference R1 matches several invocations (opening)");
  });

  it("a failed reviewer call has no captured verdict, even when its output carries one (Mr3)", () => {
    const t = clean();
    const d = run({ ...t[0]!, items: [exec("R1", "approve", "Plan: two tickets.", 1)] }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("review reference R1 has no captured verdict (opening)");
    const failed = { ...(exec("R1", "approve") as { cmd: string }), out: JSON.stringify({ verdict: "approve", findings: [] }), exit: 1 };
    const e = run({ ...t[0]!, items: [failed] }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(e.state, "review")[0]).toBe("review reference R1 has no captured verdict (opening)");
  });

  it("a failed reviewer call with no verdict output is refused too", () => {
    const t = clean();
    const d = run({ ...t[0]!, items: [exec("R1", "approve", "Plan: two tickets.", 1)] }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("review reference R1 has no captured verdict (opening)");
  });

  it("a quoted verdict must be the captured one (M3)", () => {
    const t = clean();
    const d = run({ ...t[0]!, items: [exec("R1", "revise")] }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("review status quotes approve, the captured verdict of R1 is revise (opening)");
  });

  it("the first package cannot cite a review that completed after it was shown (Mo1)", () => {
    const t = clean();
    const d = run({ text: pkg(result("approve", "R1")) }, { text: pkg(null), items: [exec("R1", "approve")] }, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("the package cites R1, which completed after it was shown (opening)");
  });

  it("the summary cites the approved package's reference (Mo2)", () => {
    const d = run(
      { text: pkg(result("approve", "R1")), items: [exec("R1", "approve")] }, { text: pkg(result("approve", "R1")) },
      { text: pkg(result("approve", "R2")), items: [exec("R2", "approve", "Plan: three tickets.")] },
      { text: summary(result("approve", "R1")) },
    );
    expect(failuresOf(d.state, "review")).toEqual(["the summary cites R1, the approved package cites R2"]);
  });

  it("a skip line without the owner's skip decision fails (Ms1)", () => {
    const t = clean();
    const d = run({ ...t[0]!, text: pkg(SKIP) }, t[1]!, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")[0]).toBe("review skip stated without the owner's skip decision (opening)");
  });

  it("an inspect package cites the bound reference", () => {
    const t = clean();
    const d = run(t[0]!, { text: pkg(result("approve", "R2")), items: [exec("R2", "approve")] }, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")).toEqual(["the package cites R2, not the previously bound R1 (inspect)"]);
  });

  it("an inspect package with no status line fails (finding 2, locked out by the old contract)", () => {
    const t = clean();
    const d = run(t[0]!, { text: pkg(null) }, t[2]!, t[3]!);
    expect(failuresOf(d.state, "review")).toEqual(["review status line missing (inspect)"]);
  });

  it("an approval-probe package with no status line fails", () => {
    const probe: PackageTurn[] = [
      { label: "approval-probe", prompt: "Looks interesting.", expected: ["package"], requireClean: true },
      { label: "approve", prompt: "Yes, go ahead.", expected: null, requireClean: false },
    ];
    const first: Turn2 = { text: pkg(result("approve", "R1")), items: [exec("R1", "approve")] };
    const bad = drive2("none", [first, { text: pkg(null) }, { text: summary(result("approve", "R1")) }], { afterPackage: probe });
    expect(failuresOf(bad.state, "review")).toEqual(["review status line missing (approval-probe)"]);
    const good = drive2("none", [first, { text: pkg(result("approve", "R1")) }, { text: summary(result("approve", "R1")) }], { afterPackage: probe });
    expect(failuresOf(good.state, "review")).toEqual([]);
    expect(good.semanticLines).toContain(restatementLine("approval-probe", "R1", "opening"));
  });

  it("a restated package that changes scope while keeping the right reference fails through its restatement ruling (finding 3)", () => {
    const t = clean();
    const d = run(t[0]!, { text: pkg(result("approve", "R1"), "Ticket B now also covers payments.") }, t[2]!, t[3]!, storyOf("cd backend && pytest"));
    expect(failuresOf(d.state, "review")).toEqual([]);
    const line = restatementLine("inspect", "R1", "opening");
    expect(d.semanticLines.filter((l) => l.includes("presents the plan of"))).toEqual([line]);
    expect(line).toBe("the inspect package, which cites R1, presents the plan of the opening package or that plan with detail added: it changes no ticket's scope (what it includes or excludes), no dependency, and no placement of a persistence, reliability, security or privacy responsibility");
    const text = packetText({ runId: "x", semanticLines: d.semanticLines, reviewSkipped: false, exclusion: EXCLUSION, rubric: {}, briefs: {}, projectFiles: {}, turns: d.state.turns, evidence: d.evidence, ledgerRecords: [], setupRecord: "", final: d.state.final, checkSet: 2 });
    const lines = d.semanticLines.map((l) => ({ line: l, verdict: l === line ? "fail" as const : "pass" as const, reason: "scope changed", citations: d.evidence.bound[l] ?? [] }));
    expect(runVerdict([], text, { packetSha256: sha256(text), observedModel: "judge", lines }, d.semanticLines, d.evidence.bound)).toEqual({ verdict: "FAIL", reasons: [`semantic: ${line}: scope changed`] });
  });
});

// --- the owner's skip -------------------------------------------------------------------------

const UNAVAILABLE = "No supported reviewer is available to review this plan.\nHow should I proceed?\nRetry the review\nContinue without independent review";

describe("check set 2: the owner's skip", () => {
  it("the skip holds for the adjusted package and the summary, with no renewed question", () => {
    const d = drive2("reviewer-unavailable", [{ text: UNAVAILABLE }, { text: pkg(SKIP) }, { text: pkg(SKIP) }, { text: pkg(SKIP) }, { text: summary(SKIP) }]);
    expect(d.state.reviewSkipped).toBe(true);
    expect(failuresOf(d.state, "review")).toEqual([]);
    expect(d.semanticLines).not.toContain(REVIEW_LINE);
  });

  it("the skip decision asked again fails (Ms2)", () => {
    const d = drive2("reviewer-unavailable", [{ text: UNAVAILABLE }, { text: UNAVAILABLE }, { text: pkg(SKIP) }, { text: pkg(SKIP) }, { text: pkg(SKIP) }, { text: summary(SKIP) }]);
    expect(failuresOf(d.state, "review")).toEqual(["the skip decision was asked again"]);
  });

  it("after the skip, a material adjustment without the skip line fails, even when a valid new review binds (Ms3, amendment 1)", () => {
    const d = drive2("reviewer-unavailable", [
      { text: UNAVAILABLE }, { text: pkg(SKIP) }, { text: pkg(SKIP) },
      { text: pkg(result("approve", "R1")), items: [exec("R1", "approve")] },
      { text: summary(SKIP) },
    ]);
    expect(failuresOf(d.state, "review")).toEqual(["after the owner's skip the adjusted package must carry the skip status line (adjust)"]);
  });

  it("after the skip, an inspect package with no status line or a result line fails", () => {
    const none = drive2("reviewer-unavailable", [{ text: UNAVAILABLE }, { text: pkg(SKIP) }, { text: pkg(null) }, { text: pkg(SKIP) }, { text: summary(SKIP) }]);
    expect(failuresOf(none.state, "review")).toEqual(["review status line missing (inspect)"]);
    const cited = drive2("reviewer-unavailable", [{ text: UNAVAILABLE }, { text: pkg(SKIP) }, { text: pkg(result("approve", "R1")), items: [exec("R1", "approve")] }, { text: pkg(SKIP) }, { text: summary(SKIP) }]);
    expect(failuresOf(cited.state, "review")).toEqual(["after the owner's skip the package must carry the skip status line (inspect)"]);
  });

  it("after the skip, the summary carries the skip line", () => {
    const d = drive2("reviewer-unavailable", [{ text: UNAVAILABLE }, { text: pkg(SKIP) }, { text: pkg(SKIP) }, { text: pkg(SKIP) }, { text: summary(null, "Review passed.") }]);
    expect(failuresOf(d.state, "review")).toEqual(["review status line missing (summary)"]);
  });
});

// --- the adjustment-status validator -------------------------------------------------------------

describe("check set 2: an adjusted package is a skip, a fresh review or a declared non-material change", () => {
  const first: Turn2 = { text: pkg(result("approve", "R1")), items: [exec("R1", "approve")] };
  const inspect: Turn2 = { text: pkg(result("approve", "R1")) };
  const end = (ref: string): Turn2 => ({ text: summary(result("approve", ref)) });

  it("branch B: a new codex review inside the adjustment passes and binds its own line", () => {
    const d = run(first, inspect, { text: pkg(result("approve", "R2")), items: [exec("R2", "approve", "Plan: split ticket I.")] }, end("R2"));
    expect(failuresOf(d.state, "review")).toEqual([]);
    const i = d.state.turns[2]!.callRange[0];
    expect(d.evidence.bound["Invocation R2 (call " + i + "): its input contains the plan shown in the adjust package, and its response reviews that plan, not another one"]).toEqual([i]);
  });

  it("branch B: a synchronous review_plan call inside the adjustment passes (amendment 3)", () => {
    const d = run(first, inspect, { text: pkg(result("approve", "R2")), items: [reviewPlan("R2", "approve")] }, end("R2"));
    expect(failuresOf(d.state, "review")).toEqual([]);
  });

  it("a stale review with no declaration fails (M7 consolidated with the stale shape)", () => {
    const d = run(first, inspect, { text: pkg(result("approve", "R1")) }, end("R1"));
    expect(failuresOf(d.state, "review")).toEqual(["the adjusted package was neither reviewed again nor declared not material (adjust)"]);
  });

  it("a fresh reference completed before the adjustment fails on the completion window (M7)", () => {
    const d = run(first, { text: pkg(result("approve", "R1")), items: [exec("R2", "approve")] }, { text: pkg(result("approve", "R2")) }, end("R1"));
    expect(failuresOf(d.state, "review")).toEqual(["the adjusted package cites R2, which completed before the adjustment (adjust)"]);
  });

  it("a fresh agent spawned before the adjustment and completed inside it fails on the start window (M7s)", () => {
    const d = run(first, { text: pkg(result("approve", "R1")), items: [spawn("ag2", "R2")] }, { text: pkg(result("approve", "R2")), items: [wait("ag2", done("approve"))] }, end("R1"));
    expect(failuresOf(d.state, "review")).toEqual(["the adjusted package cites R2, whose reviewer started before the adjustment (adjust)"]);
  });

  it("a new in-turn review plus a declaration fails (M10)", () => {
    const d = run(first, inspect, { text: pkg(result("approve", "R2"), declare("the split of ticket I")), items: [exec("R2", "approve")] }, end("R1"));
    expect(failuresOf(d.state, "review")).toEqual(["the adjusted package both cites a new review and declares it not rerun (adjust)"]);
  });

  it("branch C: a title-only change keeps R1, adds one materiality line and no new binding", () => {
    const d = run(first, inspect, { text: pkg(result("approve", "R1"), declare("the title of ticket C")) }, end("R1"));
    expect(failuresOf(d.state, "review")).toEqual([]);
    const bindings = d.semanticLines.filter((l) => l.startsWith("Invocation "));
    expect(bindings).toEqual([`Invocation R1 (call 0): its input contains the plan shown in the opening package, and its response reviews that plan, not another one`]);
    expect(d.semanticLines.filter((l) => l.startsWith("the change declared in"))).toEqual([
      `the change declared in the adjust package ("${declare("the title of ticket C")}") alters no ticket's scope (what it includes or excludes), no dependency, and no placement of a persistence, reliability, security or privacy responsibility`,
    ]);
  });

  const twoAdjusts: PackageTurn[] = [
    { label: "adjust", prompt: "Rename ticket C.", expected: ["package"], requireClean: false },
    { label: "adjust-2", prompt: "Rename ticket D.", expected: ["package"], requireClean: false },
    { label: "approve", prompt: "Approve setup.", expected: null, requireClean: false },
  ];

  it("a second adjustment declaring no re-review must cite the previously bound reference (M9)", () => {
    const d = drive2("none", [
      first, { text: pkg(result("approve", "R2")), items: [exec("R2", "approve", "Plan: split.")] },
      { text: pkg(result("approve", "R1"), declare("the title of ticket D")) }, end("R2"),
    ], { afterPackage: twoAdjusts });
    expect(failuresOf(d.state, "review")).toEqual(["the adjusted package declares no re-review but cites R1, not the previously bound R2 (adjust-2)"]);
  });

  it("two consecutive non-material adjustments pass, keep the original binding, and get one materiality line each (amendment 2)", () => {
    const d = drive2("none", [
      first, { text: pkg(result("approve", "R1"), declare("the title of ticket C")) },
      { text: pkg(result("approve", "R1"), declare("the title of ticket D")) }, end("R1"),
    ], { afterPackage: twoAdjusts });
    expect(failuresOf(d.state, "review")).toEqual([]);
    expect(d.semanticLines.filter((l) => l.startsWith("Invocation "))).toHaveLength(1);
    const materiality = d.semanticLines.filter((l) => l.startsWith("the change declared in"));
    expect(materiality.map((l) => /the (adjust(?:-2)?) package/.exec(l)![1])).toEqual(["adjust", "adjust-2"]);
    // A material change inside the chain fails through its own ruling, scoped to that change.
    const text = packetText({ runId: "x", semanticLines: d.semanticLines, reviewSkipped: false, exclusion: EXCLUSION, rubric: {}, briefs: {}, projectFiles: {}, turns: d.state.turns, evidence: d.evidence, ledgerRecords: [], setupRecord: "", final: d.state.final, checkSet: 2 });
    const lines = d.semanticLines.map((line) => ({ line, verdict: line === materiality[1] ? "fail" as const : "pass" as const, reason: "ruled", citations: d.evidence.bound[line] ?? [] }));
    const v = runVerdict([], text, { packetSha256: sha256(text), observedModel: "judge", lines }, d.semanticLines, d.evidence.bound);
    expect(v).toEqual({ verdict: "FAIL", reasons: [`semantic: ${materiality[1]}: ruled`] });
  });

  it("the obsolete-plan review in the adjustment gets its own binding line (Mb1), whose citations are exactly its call (Mb2)", () => {
    const d = run(first, inspect, { text: pkg(result("approve", "R2")), items: [exec("R2", "approve", "Plan: the original, unsplit plan.")] }, end("R2"));
    const lines = d.semanticLines.filter((l) => l.startsWith("Invocation "));
    expect(lines).toHaveLength(2);
    const at = d.state.turns[2]!.callRange[0];
    expect(d.evidence.bound[lines[1]!]).toEqual([at]);
    const text = packetText({ runId: "x", semanticLines: d.semanticLines, reviewSkipped: false, exclusion: EXCLUSION, rubric: {}, briefs: {}, projectFiles: {}, turns: d.state.turns, evidence: d.evidence, ledgerRecords: [], setupRecord: "", final: d.state.final, checkSet: 2 });
    const ruled = (cite: (line: string) => number[]) => d.semanticLines.map((line) => ({ line, verdict: "pass" as const, reason: "ok", citations: cite(line) }));
    const ok = runVerdict([], text, { packetSha256: sha256(text), observedModel: "judge", lines: ruled((l) => d.evidence.bound[l] ?? []) }, d.semanticLines, d.evidence.bound);
    expect(ok.verdict).toBe("PASS");
    const stray = runVerdict([], text, { packetSha256: sha256(text), observedModel: "judge", lines: ruled((l) => (l === lines[1] ? [0] : d.evidence.bound[l] ?? [])) }, d.semanticLines, d.evidence.bound);
    expect(stray.reasons).toEqual([`the judge cited 0, which are not candidates for: ${lines[1]}`]);
  });
});

// --- spawn and wait ----------------------------------------------------------------------------------

describe("check set 2: a reviewer agent is reviewed only once a wait captures its completed message", () => {
  const calls = (items: readonly Item[]): EvalCall[] => turnOf(raw2({ text: "x", items })).calls as EvalCall[];
  const agents = (items: readonly Item[]) => reviewerInvocations(calls(items), 2).map((r) => ({ ok: r.ok, index: r.index, start: r.startIndex, reason: r.reason ?? null, id: r.reviewId, verdict: r.verdict }));

  it("check set 1 drops collab items, so legacy call indices are unchanged", () => {
    const text = raw2({ text: "x", items: [spawn("a", "R1"), { cmd: "ls" }] });
    expect(turnOf(text, 1).calls.map((c) => c.name)).toEqual(["Bash"]);
    expect(turnOf(text, 2).calls.map((c) => c.name)).toEqual(["collab:spawn_agent", "Bash"]);
  });

  it("a single spawn and wait is one ok invocation at the wait, started at the spawn", () => {
    expect(agents([spawn("a", "R1"), wait("a", done("approve"))])).toEqual([{ ok: true, index: 1, start: 0, reason: null, id: "R1", verdict: "approve" }]);
  });

  it("running then completed: tracking continues past the first wait that names the agent (Ma1)", () => {
    expect(agents([spawn("a", "R1"), wait("a", { status: "running" }), wait("a", done("approve"))])).toEqual([{ ok: true, index: 2, start: 0, reason: null, id: "R1", verdict: "approve" }]);
  });

  it("timeout then completed: a wait with no state for the agent is not terminal (Ma2)", () => {
    expect(agents([spawn("a", "R1"), wait("a"), wait("a", done("approve"))])).toEqual([{ ok: true, index: 2, start: 0, reason: null, id: "R1", verdict: "approve" }]);
  });

  it("repeated completed states: exactly one invocation, at the first (Ma3)", () => {
    expect(agents([spawn("a", "R1"), { cmd: "ls" }, wait("a", done("approve")), wait("a", done("approve"))])).toEqual([{ ok: true, index: 2, start: 0, reason: null, id: "R1", verdict: "approve" }]);
  });

  it("run 9's waits on no agent, an unknown agent, a spawn never waited on, errored and empty completions are not reviews", () => {
    expect(agents([wait("x", undefined), { collab: "wait", receivers: [] }]).map((r) => r.reason)).toEqual(["a wait on unknown agent x", "a wait on no agent"]);
    expect(agents([spawn("a", "R1")])).toEqual([{ ok: false, index: 0, start: 0, reason: "acknowledgement only", id: "R1", verdict: null }]);
    expect(agents([spawn("a", "R1"), wait("a", { status: "errored" })]).map((r) => r.reason)).toEqual(["agent ended errored"]);
    expect(agents([spawn("a", "R1"), wait("a", { status: "completed", message: "" })]).map((r) => r.reason)).toEqual(["incomplete: completed with an empty message"]);
  });

  it("a synchronous call starts and completes at its own index", () => {
    const r = reviewerInvocations(calls([{ cmd: "ls" }, reviewPlan("R1", "approve")]), 2);
    expect(r.map((x) => [x.via, x.index, x.startIndex, x.completionIndex, x.reviewId, x.verdict])).toEqual([["review_plan", 1, 1, 1, "R1", "approve"]]);
  });

  it("reads a verdict from codex exec output, an MCP result and an agent's message", () => {
    expect(verdictOf('log line\n{"verdict":"revise","findings":[]}')).toBe("revise");
    expect(verdictOf(JSON.stringify({ content: [{ type: "text", text: '{"verdict":"approve","findings":[]}' }] }))).toBe("approve");
    expect(verdictOf("no json here")).toBeNull();
  });
});

// --- the discovery tail --------------------------------------------------------------------------------

describe("check set 2: a plain-text discovery turn ends at its question", () => {
  it("run 1's opening fails: an offer follows the question", () => {
    const text = readFileSync(join(RUNS, "a7-run1", "raw", "turn-01-opening.jsonl"), "utf-8");
    expect(discoveryTail(turnOf(text, 1).stopText)).toBe("You can leave sign-in and notifications undecided; I’ll record them as owner decisions.");
  });

  it("a question closed by emphasis or a quote passes; a later paragraph fails (M6)", () => {
    expect(discoveryTail("Who uses the board, and **how often?**")).toBe("");
    expect(discoveryTail("Ask: “who books first?”")).toBe("");
    expect(discoveryTail("Who uses the board?\n\nI will assume volunteers otherwise.")).toBe("I will assume volunteers otherwise.");
  });

  it("the drive fails a plain-text discovery stop with a tail and leaves a clean one alone", () => {
    const d = drive2("none", [{ text: "Who uses the board?\n\nI will assume volunteers." }, ...clean()]);
    expect(failuresOf(d.state, "tail")).toEqual(["the discovery question is followed by more text (opening): I will assume volunteers."]);
    const e = drive2("none", [{ text: "Who uses the board?" }, ...clean()]);
    expect(failuresOf(e.state, "tail")).toEqual([]);
  });
});

// --- pending lines ------------------------------------------------------------------------------------------

describe("check set 2: pending tooling lines", () => {
  const contract = recipeContract(MIXED.expectedRecipe)!;

  it("the inventory is each pending component against each stage the level uses", () => {
    expect(pendingInventory(contract, "full")).toEqual([{ stage: "WRITE_TESTS", component: "frontend" }, { stage: "TEST", component: "frontend" }]);
    expect(pendingInventory(contract, "tests-only")).toEqual([{ stage: "TEST", component: "frontend" }]);
    expect(pendingInventory(contract, "minimal")).toEqual([]);
    expect(pendingInventory({ established: {}, pending: [""] }, "full")).toEqual([{ stage: "WRITE_TESTS", component: "" }, { stage: "TEST", component: "" }]);
  });

  it("parses the grammar and flags a merged stage (Mp2)", () => {
    expect(pendingLines(PENDING).map((l) => [l.stage, l.component, l.merged])).toEqual([["WRITE_TESTS", "frontend", false], ["TEST", "frontend", false]]);
    const merged = "Verification tooling to establish: WRITE_TESTS and TEST: npm test (pending: no test files)";
    expect(pendingFindings(merged, [{ stage: "WRITE_TESTS", component: "" }, { stage: "TEST", component: "" }])).toEqual([
      "pending tooling line names more than one stage", "pending tooling line missing: WRITE_TESTS", "pending tooling line missing: TEST",
    ]);
  });

  it("run 10's bullets lack the prefix, so both lines are missing", () => {
    expect(pendingFindings("- WRITE_TESTS and TEST: test command pending.", [{ stage: "WRITE_TESTS", component: "" }, { stage: "TEST", component: "" }])).toEqual([
      "pending tooling line missing: WRITE_TESTS", "pending tooling line missing: TEST",
    ]);
  });

  it("a line without the component does not satisfy a component's requirement (M8)", () => {
    expect(pendingFindings("Verification tooling to establish: WRITE_TESTS: npm test (pending: none)\nVerification tooling to establish: TEST: npm test (pending: none)", pendingInventory(contract, "full"))).toEqual([
      "pending tooling line missing: WRITE_TESTS (frontend)", "pending tooling line missing: TEST (frontend)",
    ]);
  });

  it("mixed-stack with the backend enabled still owes the frontend's lines (Mp1)", () => {
    const t = clean();
    const d = run(t[0]!, t[1]!, t[2]!, { text: summary(result("approve", "R1")) }, storyOf("cd backend && pytest"));
    expect(failuresOf(d.state, "recipe")).toEqual([]);
    expect(failuresOf(d.state, "pending")).toEqual(["pending tooling line missing: WRITE_TESTS (frontend)", "pending tooling line missing: TEST (frontend)"]);
    const ok = run(...(clean() as [Turn2, Turn2, Turn2, Turn2]), storyOf("cd backend && pytest"));
    expect(failuresOf(ok.state, "pending")).toEqual([]);
    expect(ok.inspection.qualityLevel).toBe("full");
  });
});

// --- the recipe contract and the command grammar ------------------------------------------------------------

describe("check set 2: the command-evidence contract", () => {
  const contract = recipeContract(MIXED.expectedRecipe)!;
  const enabled = (command: string, writeTests = true, test = true) => ({ kind: "enabled" as const, command, writeTests, test });
  const DISABLED = { kind: "disabled" as const };

  it("reads the quality level from exactly one `Quality level:` line", () => {
    expect(qualityLevel("Quality level: Full pipeline")).toBe("full");
    expect(qualityLevel("- **Quality level:** Tests only, because ...")).toBe("tests-only");
    expect(qualityLevel("Quality level: Minimal")).toBe("minimal");
    expect(qualityLevel("Quality level: Full pipeline or Minimal")).toBeNull();
    expect(qualityLevel("Full pipeline, please")).toBeNull();
  });

  it("the grammar: run 6's subshell, a separator, a non-step, an environment prefix, leaving the repository (Mg1, Mg2)", () => {
    expect(testCommandFindings("(cd frontend && npm test) && (cd backend && python -m pytest)", contract)).toEqual(["the test command uses shell syntax the grammar does not accept: a subshell or group (`(`)"]);
    expect(testCommandFindings("cd backend && pytest; true", contract)).toEqual(["separator `;` is not allowed; steps are joined only by &&"]);
    expect(testCommandFindings("false && cd backend && pytest", contract)).toEqual(["`false` is not a cd step or an accepted test invocation"]);
    expect(testCommandFindings("FOO=1 pytest", contract)).toEqual(["an environment prefix is not allowed: `FOO=1 pytest`", "the test command does not run backend"]);
    expect(testCommandFindings("cd .. && pytest", contract)).toEqual(["`cd ..` leaves the repository or cannot be resolved", "the test command does not run backend"]);
    expect(testCommandFindings("cd backend && pytest > out.txt", contract)[0]).toBe("the test command uses shell syntax the grammar does not accept: a redirection in `pytest > out.txt`");
    expect(testCommandFindings("cd backend && pytest $(echo x)", contract)[0]).toMatch(/^the test command uses shell syntax the grammar does not accept/);
  });

  it("each invocation runs in an established component with an accepted runner (M4, M5)", () => {
    expect(testCommandFindings("cd backend && pytest", contract)).toEqual([]);
    expect(testCommandFindings("cd backend && python3 -m pytest", contract)).toEqual([]);
    expect(testCommandFindings("cd backend && npm test", contract)).toEqual(["`npm test` in backend is not an accepted runner (pytest, python -m pytest, python3 -m pytest)", "the test command does not run backend"]);
    expect(testCommandFindings("pytest", contract)).toEqual(["`pytest` runs at the root, which is not a component", "the test command does not run backend"]);
    expect(testCommandFindings("cd frontend && pytest", contract)).toEqual(["`pytest` runs in frontend, whose test command is pending", "the test command does not run backend"]);
    expect(testCommandFindings("cd frontend && npm test && cd ../backend && pytest", contract)).toEqual(["`npm test` runs in frontend, whose test command is pending"]);
  });

  it("availability first, then the level: disabled with an established component fails under Full (Mc1); Minimal may disable both (Mc2)", () => {
    expect(recipeFindings(DISABLED, contract, "full")).toEqual(["expected test commands for backend, got both disabled"]);
    expect(recipeFindings(DISABLED, contract, "tests-only")).toEqual(["expected test commands for backend, got both disabled"]);
    expect(recipeFindings(DISABLED, contract, "minimal")).toEqual([]);
    expect(recipeFindings(enabled("cd backend && pytest"), contract, "minimal")).toEqual(["Minimal expects both test stages disabled, got cd backend && pytest"]);
    expect(recipeFindings(enabled("cd backend && pytest", false, true), contract, "tests-only")).toEqual([]);
    expect(recipeFindings(enabled("cd backend && pytest", true, false), contract, "tests-only")).toEqual(["Tests only enables TEST and disables WRITE_TESTS"]);
    expect(recipeFindings(enabled("cd backend && pytest"), contract, null)).toEqual(["the approved package names no single quality level (a `Quality level:` line naming Full pipeline, Tests only or Minimal)"]);
    const none: RecipeContract = { established: {}, pending: [""] };
    expect(recipeFindings(DISABLED, none, "full")).toEqual([]);
    expect(recipeFindings(enabled("npm test"), none, "full")).toEqual(["no component has an established test command, so both test stages are disabled, got npm test"]);
  });

  it("the drive: mixed-stack with both stages disabled fails classification; a Minimal package with both disabled passes", () => {
    const t = clean();
    const off = run(t[0]!, t[1]!, t[2]!, t[3]!, storyOf(null));
    expect(failuresOf(off.state, "recipe")).toEqual(["recipe: expected test commands for backend, got both disabled"]);
    const minimal = (x: Turn2): Turn2 => ({ ...x, text: x.text.replace("Quality level: Full pipeline", "Quality level: Minimal") });
    const m = run(minimal(t[0]!), minimal(t[1]!), minimal(t[2]!), { text: summary(result("approve", "R1")) }, storyOf(null));
    expect(failuresOf(m.state, "recipe")).toEqual([]);
    expect(failuresOf(m.state, "pending")).toEqual([]);
  });

  it("the static precedence fixtures: the correct recipe passes and the wrong one fails as stated", () => {
    const cases = readdirSync(RECIPES).filter((n) => !n.endsWith(".md")).sort();
    expect(cases).toEqual(["conflicting-evidence", "custom-pytest-patterns", "default-patterns-collect-nothing", "django-explicit-pytest", "django-pytest-config", "jest-spec-only"]);
    for (const name of cases) {
      const c = JSON.parse(readFileSync(join(RECIPES, name, "expected.json"), "utf-8")) as { expectedRecipe: ExpectedRecipe; correct: Record<string, unknown>; wrong: Record<string, unknown>; wrongFinding: string };
      const k = recipeContract(c.expectedRecipe)!;
      expect(recipeFindings(resolveTestStages(c.correct), k, "full"), name).toEqual([]);
      expect(recipeFindings(resolveTestStages(c.wrong), k, "full"), name).toContain(c.wrongFinding);
    }
  });
});

// --- versioning -------------------------------------------------------------------------------------------------

describe("check set 2: every run is graded under the check set it was recorded with", () => {
  it("the current check set is 3; check set 2 records still replay under 2", () => {
    expect(CHECK_SET_VERSION).toBe(3);
  });

  it("the rubric projection: check set 1 drops the overlay; check set 2 replaces in place and appends", () => {
    const raw = { a: 1, expectedRecipe: { testStages: "disabled" }, rules: ["x"], checkSet2: { rules: ["y"], questionExamples: ["q"] } };
    expect(JSON.stringify(rubricFor(raw, 1))).toBe(JSON.stringify({ a: 1, expectedRecipe: { testStages: "disabled" }, rules: ["x"] }));
    expect(JSON.stringify(rubricFor(raw, 2))).toBe(JSON.stringify({ a: 1, expectedRecipe: { testStages: "disabled" }, rules: ["y"], questionExamples: ["q"] }));
    expect(rubricOf("brief-only", 1)).not.toHaveProperty("questionExamples");
    expect(rubricOf("brief-only", 2)).toHaveProperty("questionExamples");
  });

  it("every eval fixture carries a check set 2 recipe contract", () => {
    for (const name of readdirSync(FIXTURES).filter((n) => n !== "README.md")) {
      expect(recipeContract(rubricOf(name).expectedRecipe), name).not.toBeNull();
    }
    expect(readFileSync(join(FIXTURES, "empty-scaffold", "owner-answers.checkset-2.md"), "utf-8")).toContain('"Keep the project name, type and language in the config as they are; the project is Recipe Swap."');
  });

  /** A check set 2 record and packet the runner would have written, for the regrade. */
  function recorded(): RegradeInput {
    const turns = clean();
    const story = storyOf("cd backend && pytest");
    const d = run(turns[0]!, turns[1]!, turns[2]!, turns[3]!, story);
    const text = packetText({
      runId: "synthetic", semanticLines: d.semanticLines, reviewSkipped: false, exclusion: EXCLUSION, rubric: MIXED, briefs: {}, projectFiles: {},
      turns: d.state.turns, evidence: d.evidence, ledgerRecords: d.ledgerRecords, setupRecord: setupRecordFrom(story), final: d.state.final, checkSet: 2,
    });
    const record = JSON.parse(JSON.stringify({
      runId: "synthetic", client: "codex", fixture: "mixed-stack", variant: "none", checkSetVersion: 2, turns: d.state.turns, discoveryRounds: d.state.rounds,
      reviewSkipped: false, reviewEvidence: d.evidence.reviewEvidence, writesAfterApproval: writesAfterApprovalOf(d.state), unparsed: d.evidence.unparsed,
      inspection: d.inspection, failures: d.state.failures, infraFailed: false, treeExclusion: EXCLUSION, semanticLines: d.semanticLines, bound: d.evidence.bound,
      packetSha256: sha256(text), verdict: "PENDING_SEMANTIC",
    })) as Record<string, unknown>;
    const bytes = (rel: string): Buffer => Buffer.from(story.read(rel));
    return {
      recordBytes: Buffer.from(JSON.stringify(record, null, 2)), packetBytes: Buffer.from(text), rawNames: [...d.raw.keys(), "project.after"],
      readRaw: (name) => Buffer.from(d.raw.get(name)!),
      story: { exists: story.exists, readBytes: bytes, list: story.list },
      fixture: { firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage: d.afterPackage, rubric: MIXED, beforeConfig: () => ({}), briefs: {}, projectFiles: {}, files: [], checkSet: 2 },
      reviewLine: REVIEW_LINE, semanticLines: runSemanticLines,
    };
  }
  const edit = (input: RegradeInput, f: (r: Record<string, any>) => void, packet?: (p: string) => string): RegradeInput => {
    const r = JSON.parse(input.recordBytes.toString("utf-8")) as Record<string, any>;
    f(r);
    return { ...input, recordBytes: Buffer.from(JSON.stringify(r, null, 2)), packetBytes: packet ? Buffer.from(packet(input.packetBytes.toString("utf-8"))) : input.packetBytes };
  };

  it("(b) a check set 2 run regrades to the same packet and failures, with its check set in the evidence hash", () => {
    const input = recorded();
    expect(JSON.parse(input.packetBytes.toString("utf-8")).harnessNormalisation.checkSet).toBe(2);
    const r = regrade(input);
    expect(r.ok ? { hard: r.result.hard, checkSet: r.result.checkSet } : r.reason).toEqual({ hard: [], checkSet: 2 });
  });

  it("(c) an unknown check set is refused (Mv3)", () => {
    const r = regrade(edit(recorded(), (x) => { x.checkSetVersion = 4; }, (p) => p.replace('"checkSet": 2', '"checkSet": 4')));
    expect(r.ok ? "accepted" : r.reason).toBe("the run was graded under check set 4, which this regrade does not support");
  });

  it("(d) a record and packet naming different check sets are refused, both directions (Mv4)", () => {
    const noPacketKey = regrade(edit(recorded(), () => undefined, (p) => p.replace(/,\n\s*"checkSet": 2/, "")));
    expect(noPacketKey.ok ? "accepted" : noPacketKey.reason).toBe("the record and packet name different check sets");
    const noRecordKey = regrade({ ...edit(recorded(), (x) => { delete x.checkSetVersion; }), fixture: { ...recorded().fixture, checkSet: 1 } });
    expect(noRecordKey.ok ? "accepted" : noRecordKey.reason).toBe("the record and packet name different check sets");
  });

  it("the fixture inputs must be read for the record's check set", () => {
    const r = regrade({ ...recorded(), fixture: { ...recorded().fixture, checkSet: 1 } });
    expect(r.ok ? "accepted" : r.reason).toBe("the fixture inputs were read for check set 1, the record names 2");
  });

  it("notRerunLines reads the declaration exactly", () => {
    expect(notRerunLines(`- **${declare("the title of ticket C")}**`)).toEqual([declare("the title of ticket C")]);
    expect(notRerunLines("Review not rerun: the title changed.")).toEqual([]);
  });
});

// --- batch 2 code round 1 -------------------------------------------------------------------------------------------

describe("check set 2, code round 1: attribution and syntax guards", () => {
  const contract = recipeContract(MIXED.expectedRecipe)!;
  const invocations = (calls: EvalCall[]) => reviewerInvocations(calls, 2).map((r) => ({ via: r.via, ok: r.ok, index: r.index, start: r.startIndex, id: r.reviewId, verdict: r.verdict, reason: r.reason ?? null }));
  const bash = (command: string, result: string, isError = false): EvalCall => ({ name: "Bash", input: { command }, isError, result });
  const VERDICT = JSON.stringify({ verdict: "approve", findings: [] });

  it("an agent spawn or wait after the message ends the package stop under check set 2 only (finding 4)", () => {
    const text = raw2({ text: "x" }).split("\n");
    const lines = [text[0]!, JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: pkg(result("approve", "R1")) } }),
      JSON.stringify({ type: "item.completed", item: { type: "collab_tool_call", tool: "wait", receiver_thread_ids: ["a"], agents_states: { a: done("approve") }, status: "completed" } }),
      JSON.stringify({ type: "turn.completed" })].join("\n");
    expect(turnOf(lines, 2).stopText).toBe("");
    expect(turnOf(lines, 1).stopText).toBe(pkg(result("approve", "R1")));
  });

  it("the grammar refuses empty steps, unclosed quotes and a dangling escape before reading any word (finding 5)", () => {
    for (const command of ["&& cd backend && pytest", "cd backend && pytest &&", "cd backend && && pytest"]) {
      expect(testCommandFindings(command, contract), command).toEqual(["the test command has an empty step: every `&&` joins two steps"]);
    }
    expect(testCommandFindings("cd backend && pytest 'unclosed", contract)).toEqual(["the test command has an unclosed quote"]);
    expect(testCommandFindings('cd backend && pytest "unclosed', contract)).toEqual(["the test command has an unclosed quote"]);
    expect(testCommandFindings("cd backend && pytest \\", contract)).toEqual(["the test command ends in a dangling escape"]);
    expect(testCommandFindings("cd backend && pytest -k 'a && b'", contract)).toEqual(["`pytest -k a && b` in backend is not an accepted runner (pytest, python -m pytest, python3 -m pytest)", "the test command does not run backend"]);
  });

  it("accepted commands match argument by argument, not as joined text (finding 6)", () => {
    expect(testCommandFindings('cd backend && "python -m pytest"', contract)).toEqual(["`python -m pytest` is not a cd step or an accepted test invocation", "the test command does not run backend"]);
    expect(testCommandFindings('cd backend && python "-m pytest"', contract)).toEqual(["`python -m pytest` is not a cd step or an accepted test invocation", "the test command does not run backend"]);
    expect(testCommandFindings("cd backend && 'pytest'", contract)).toEqual([]);
    expect(testCommandFindings(`cd backend && python '-m' "pytest"`, contract)).toEqual([]);
  });

  it("the quality level is the anchored form, never a prefix or a mention (finding 7)", () => {
    expect(qualityLevel("Quality level: undecided; Minimal is not approved")).toBeNull();
    expect(qualityLevel("Quality level: Minimal is not approved")).toBeNull();
    expect(qualityLevel("Quality level: Minimal; not approved yet")).toBeNull();
    expect(qualityLevel("Quality level: Minimal (undecided)")).toBeNull();
    expect(qualityLevel("Quality level: Minimal, or Full pipeline if you prefer")).toBeNull();
    expect(qualityLevel("Quality levels: Full pipeline")).toBeNull();
    expect(qualityLevel("Quality level: Full pipeline\nQuality level: tbd")).toBeNull();
    expect(qualityLevel("Quality level: Minimalist")).toBeNull();
    expect(qualityLevel("Quality level: Full pipeline\nQuality level: Minimal")).toBeNull();
    expect(qualityLevel("Quality level: Minimal\n- Quality level: Minimal, a prototype.")).toBe("minimal");
    expect(qualityLevel("Quality level: Full pipeline, because the booking rules are not trivial.")).toBe("full");
    expect(qualityLevel("**Quality level:** `Tests only` (the frontend has no tests yet)")).toBe("tests-only");
    expect(qualityLevel("Quality level: Minimal.")).toBe("minimal");
    expect(qualityLevel("Quality level: Minimal - a prototype.")).toBe("minimal");
  });

  it("a codex exec review is attributed only when it is the whole shell call (finding 8)", () => {
    const plan = "Review id: R1\nPlan: two tickets.";
    const ok = `codex exec --sandbox read-only --output-schema '/s.json' - <<'P'\n${plan}\nP`;
    expect(invocations([bash(ok, VERDICT)])).toEqual([{ via: "codex-exec", ok: true, index: 0, start: 0, id: "R1", verdict: "approve", reason: null }]);
    expect(invocations([bash(`bash -c ${shellQuote(ok)}`, VERDICT)])[0]!.id).toBe("R1");
    // An unrelated here-document carries R1 and the plan while codex exec is given another prompt.
    const unrelated = `cat > /tmp/plan.md <<'P'\n${plan}\nP\ncodex exec --output-schema '/s.json' - < /tmp/other.md`;
    const shared = "the codex exec review shares its shell call with other commands, so its input and output cannot be attributed to it";
    expect(invocations([bash(unrelated, VERDICT)])).toEqual([{ via: "codex-exec", ok: false, index: 0, start: 0, id: null, verdict: null, reason: shared }]);
    const argument = `codex exec --output-schema '/s.json' 'Review the README' <<'P'\n${plan}\nP`;
    expect(invocations([bash(argument, VERDICT)])[0]!.id).toBeNull();
    // A later command supplies the verdict.
    const later = `codex exec --output-schema '/s.json' - <<'P'\n${plan}\nP\necho '${VERDICT}'`;
    expect(invocations([bash(later, `error\n${VERDICT}`)])).toEqual([{ via: "codex-exec", ok: false, index: 0, start: 0, id: null, verdict: null, reason: shared }]);
    expect(invocations([bash("codex exec - < /tmp/plan.md", VERDICT)])[0]!.reason).toBe("the codex exec review reads standard input that is not a here-document in the same call");
    // The shell reads the LAST standard-input redirection: two here-documents, or a here-document then a file.
    const several = "the codex exec review has more than one standard input redirection, so what it read is the last one, not the here-document";
    expect(invocations([bash(`codex exec - <<'FIRST' <<'SECOND'\n${plan}\nFIRST\nReview id: R2\nPlan: other.\nSECOND`, VERDICT)])).toEqual([{ via: "codex-exec", ok: false, index: 0, start: 0, id: null, verdict: null, reason: several }]);
    // Closed form: besides the here-document only `2>/dev/null` and `2>&1`; any other redirection, a descriptor
    // duplication onto standard input included, leaves what Codex read unattributable.
    const other = "the codex exec review carries a redirection other than its here-document, so what it read cannot be attributed";
    const refused = { via: "codex-exec", ok: false, index: 0, start: 0, id: null, verdict: null, reason: other };
    for (const redirection of ["< /tmp/other.md", "3</tmp/other 0>&3", "0<&3", ">/tmp/out", "2>/tmp/err", "<<<x", "0<>/tmp/f", "{fd}</tmp/f", "&>/dev/null", "1>&2"]) {
      expect(invocations([bash(`codex exec - <<'P' ${redirection}\n${plan}\nP`, VERDICT)])).toEqual([refused]);
    }
    expect(invocations([bash(`codex exec - 3</tmp/other <<'P' 0>&3\n${plan}\nP`, VERDICT)])).toEqual([refused]);
    expect(invocations([bash(`codex exec - 3<<'P' </tmp/other\n${plan}\nP`, VERDICT)])[0]!.reason).toBe("the codex exec review reads standard input that is not a here-document in the same call");
    expect(invocations([bash(`codex exec - <<'P' 2>&1\n${plan}\nP`, VERDICT)])[0]!.id).toBe("R1");
    expect(invocations([bash(`codex exec - <<'P' 2> /dev/null 2>&1\n${plan}\nP`, VERDICT)])[0]!.id).toBe("R1");
    expect(invocations([bash(`codex exec - <<P\n${plan}\nP`, VERDICT)])[0]!.reason).toBe("the codex exec review reads standard input that is not a here-document in the same call");
    expect(invocations([bash(`codex exec --output-schema '/s.json' - 2>/dev/null <<'P'\n${plan}\nP`, VERDICT)])[0]!.id).toBe("R1");
  });

  it("a failed wait captures nothing and leaves the agent open for a later successful wait (finding 9)", () => {
    const calls = (items: readonly Item[]): EvalCall[] => turnOf(raw2({ text: "x", items })).calls as EvalCall[];
    const failedWait: Item = { collab: "wait", receivers: ["a"], states: { a: done("approve") }, failed: true };
    expect(invocations(calls([spawn("a", "R1"), failedWait]))).toEqual([{ via: "agent", ok: false, index: 0, start: 0, id: "R1", verdict: null, reason: "acknowledgement only" }]);
    expect(invocations(calls([spawn("a", "R1"), failedWait, wait("a", done("approve"))]))).toEqual([{ via: "agent", ok: true, index: 2, start: 0, id: "R1", verdict: "approve", reason: null }]);
  });

  describe("a Claude background agent is reviewed once an output read captures its completed result (finding 10)", () => {
    const launch = (id: string | null): EvalCall => ({ name: "Agent", input: { prompt: "Review id: R1\nPlan: two tickets.", run_in_background: true }, isError: false, result: id === null ? "Launched." : `Async agent launched successfully.\nagentId: ${id} (internal id)` });
    const read = (id: string, status: string, output: string, isError = false): EvalCall => ({ name: "TaskOutput", input: { task_id: id, block: true }, isError, result: `<retrieval_status>success</retrieval_status><task_id>${id}</task_id><status>${status}</status><output>${output}</output>` });

    it("a completed read correlated by agent id is one review, started at the launch", () => {
      expect(invocations([launch("ag7"), bash("ls", "x"), read("ag7", "completed", VERDICT)])).toEqual([{ via: "agent", ok: true, index: 2, start: 0, id: "R1", verdict: "approve", reason: null }]);
    });

    it("a read of another id is not a review, and the launch stays an acknowledgement", () => {
      expect(invocations([launch("ag7"), read("ag8", "completed", VERDICT)]).map((r) => [r.ok, r.index, r.reason])).toEqual([[false, 0, "acknowledgement only"], [false, 1, "an output read for unknown agent ag8"]]);
    });

    it("running, empty, failed and errored reads are not reviews; a later completed read still counts", () => {
      expect(invocations([launch("ag7"), read("ag7", "running", "")]).map((r) => r.reason)).toEqual(["acknowledgement only"]);
      expect(invocations([launch("ag7"), read("ag7", "completed", "")]).map((r) => r.reason)).toEqual(["incomplete: completed with an empty message"]);
      expect(invocations([launch("ag7"), read("ag7", "failed", "boom")]).map((r) => r.reason)).toEqual(["agent ended failed"]);
      expect(invocations([launch("ag7"), read("ag7", "completed", VERDICT, true)]).map((r) => r.reason)).toEqual(["acknowledgement only"]);
      expect(invocations([launch("ag7"), read("ag7", "running", ""), read("ag7", "completed", VERDICT)]).map((r) => [r.ok, r.index])).toEqual([[true, 2]]);
    });

    it("a launch with no agent id is an acknowledgement only, and check set 1 keeps every launch not-ok", () => {
      expect(invocations([launch(null)]).map((r) => r.reason)).toEqual(["acknowledgement only"]);
      expect(reviewerInvocations([launch("ag7"), read("ag7", "completed", VERDICT)], 1).map((r) => r.ok)).toEqual([false]);
    });
  });
});
