/**
 * T-536 skill fix batch 5: check set 5. A package that cites the setup skill (an immutable corpus of its explanatory
 * sentences, historical ones included, and its file paths) fails; a citation outside the package is recorded, never
 * failed. The closing block gains a skill-owned line above the fixed line. When the harness establishes every reviewer
 * path as absent, the reviewer-unavailable stop opens the run alone. A wrapper word made of single and double quoted
 * segments is read as the inner shell receives it. The analysis reads attempt 10 under the new detectors, writing
 * nothing but its own artifact. Check sets 1 to 4 replay byte for byte. Every export is read through its module
 * namespace, so a missing one fails its own test, not the file.
 */
import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import * as lib from "../../scripts/onboarding-eval-lib.js";
import type { EvalCall, EvalTurn, RuntimeExclusion } from "../../scripts/onboarding-eval-lib.js";
import * as drv from "../../scripts/onboarding-eval-drive.js";
import type { DriveState, Rubric, StoryReader, TurnResponse, Variant } from "../../scripts/onboarding-eval-drive.js";
import * as run from "../../scripts/onboarding-eval-run.js";
import * as rg from "../../scripts/onboarding-eval-regrade.js";
import * as corpus from "../../scripts/onboarding-eval-corpus-5.js";
import * as an from "../../scripts/onboarding-eval-analyse.js";
import { sha256 } from "../../scripts/continuity-lib.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "onboarding");
const RUNS = join(HERE, "..", "fixtures", "onboarding-eval-runs", "regrade");
const EXCLUSION = (JSON.parse(readFileSync(join(RUNS, "a7-run6", "record", "record.json"), "utf-8")) as { treeExclusion: RuntimeExclusion }).treeExclusion;
const MIXED = lib.rubricFor(JSON.parse(readFileSync(join(FIXTURES, "mixed-stack", "rubric.json"), "utf-8")) as Record<string, unknown>, 4) as unknown as Rubric;
const SCRIPT = run.ownerScript("## Discovery answers\nVolunteers.\n\n## Adjustment turn\nRename ticket C.\n\n## Approval probe turn\nLooks interesting.\n\n## Affirmative approval turn\nYes, go ahead.\n");

// --- a synthetic Codex run (as in the check set 3 and 4 tests) ---------------------------------------------------

type Item =
  | { readonly cmd: string; readonly out?: string; readonly exit?: number | null }
  | { readonly collab: "spawn_agent" | "wait"; readonly receivers: readonly string[]; readonly prompt?: string; readonly states?: Record<string, { status: string; message?: string }> }
  | { readonly mcp: string; readonly args: unknown; readonly result: unknown };

/** `ask`: the turn ends on an unanswered structured question, `text` being what the agent wrote before it. */
interface Turn5 { readonly text: string; readonly items?: readonly Item[]; readonly ask?: { readonly question: string; readonly labels: readonly string[] } }

function raw5(t: Turn5): string {
  const lines: unknown[] = [{ type: "thread.started", thread_id: "th" }];
  (t.items ?? []).forEach((it, k) => {
    const id = `item_${k}`;
    if ("cmd" in it) {
      lines.push({ type: "item.started", item: { id, type: "command_execution", command: it.cmd, aggregated_output: "", exit_code: null, status: "in_progress" } });
      lines.push({ type: "item.completed", item: { id, type: "command_execution", command: it.cmd, exit_code: it.exit === undefined ? 0 : it.exit, aggregated_output: it.out ?? "" } });
    } else if ("collab" in it) lines.push({ type: "item.completed", item: { id, type: "collab_tool_call", tool: it.collab, sender_thread_id: "th", receiver_thread_ids: it.receivers, prompt: it.prompt ?? null, agents_states: it.states ?? {}, status: "completed" } });
    else {
      lines.push({ type: "item.started", item: { id, type: "mcp_tool_call", tool: it.mcp, arguments: it.args, status: "in_progress" } });
      lines.push({ type: "item.completed", item: { id, type: "mcp_tool_call", tool: it.mcp, arguments: it.args, result: it.result, status: "completed" } });
    }
  });
  lines.push({ type: "item.completed", item: { id: "msg", type: "agent_message", text: t.text } });
  lines.push({ type: "turn.completed" });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

const parsed = (text: string): Record<string, unknown>[] => text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
const turnOf = (text: string, cs: number): EvalTurn => ({ ...lib.codexTurn(parsed(text), cs), models: [] });
const callsOf = (cmds: readonly string[], cs: number): readonly EvalCall[] => turnOf(raw5({ text: "x", items: cmds.map((cmd) => ({ cmd })) }), cs).calls;
const analyse = (cmds: readonly string[], label = "approve", cs = 5) => lib.analyseCalls(callsOf(cmds, cs), [{ label, callRange: [0, cmds.length] }], cs);

type Inventory = { cli: "absent" | "present" | "unknown"; reviewPlan: "absent" | "present" | "unknown"; agent: "absent" | "present" | "unknown" };

interface Drive5 { readonly state: DriveState; readonly evidence: ReturnType<typeof drv.finishDrive> }

/** Drives a scripted run; `inventory` overrides the variant's fixture contract (synthetic reviewer paths only). */
function drive5(variant: Variant, turns: readonly Turn5[], cs = 5, inventory?: Inventory): Drive5 {
  const afterPackage = run.packageTurns(variant, SCRIPT);
  const state = drv.newDriveState(cs);
  const options = { variant, firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage, exclusion: EXCLUSION, ...(inventory === undefined ? {} : { reviewerInventory: inventory }) };
  const flow = drv.driveFlow(options, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const t = turns[n];
    if (!t) throw new Error(`the script has no turn ${n} (${step.value.label})`);
    const question = t.ask === undefined ? null : [t.ask.question, ...t.ask.labels].join("\n");
    const turn: EvalTurn = question === null ? turnOf(raw5(t), cs) : { ...turnOf(raw5(t), cs), stopText: [t.text, question].filter(Boolean).join("\n"), pendingQuestion: { question, preamble: t.text } };
    const response: TurnResponse = { turn, exitCode: 0, infraFailure: null, stderrPath: "", treeChanges: () => [] };
    n++;
    step = flow.next(response);
  }
  if (n !== turns.length) throw new Error(`the flow ended after ${n} of ${turns.length} scripted turns`);
  const evidence = drv.finishDrive(state, run.REVIEW_LINE);
  drv.inspectAfter(state, storyOf(), MIXED, () => ({}), variant);
  return { state, evidence };
}

const failuresOf = (s: DriveState, kind: string): string[] => s.failures.filter((_, i) => s.sources[i]!.kind === kind);

function storyOf(): StoryReader {
  const stage = { enabled: true, command: "cd backend && pytest" };
  const files: Record<string, string> = {
    "config.json": JSON.stringify({ recipe: "coding", recipeOverrides: { stages: { WRITE_TESTS: stage, TEST: stage, BUILD: { enabled: false }, VERIFY: { enabled: false } } } }),
    "roadmap.json": JSON.stringify({ phases: [{ id: "p1" }] }),
    "tickets/T-001.json": JSON.stringify({ id: "T-001", title: "Book a class", status: "open", description: "Outcome: a member books, from brief.md\nScope: booking. Excludes: none\nAcceptance: a booking is saved\nBehaviour: none\nVerification: a test. Prerequisites: none. Assumptions: none" }),
    "notes/N-001.json": JSON.stringify({ content: "coverage map; review R1; the review skip, where the owner chose one, is recorded" }),
  };
  return {
    exists: (rel) => rel in files || Object.keys(files).some((k) => k.startsWith(`${rel}/`)),
    read: (rel) => { const t = files[rel]; if (t === undefined) throw new Error(`no ${rel}`); return t; },
    list: (rel) => Object.keys(files).filter((k) => k.startsWith(`${rel}/`)).map((k) => k.slice(rel.length + 1)),
  };
}

// --- builders ------------------------------------------------------------------------------------------------------

const SHAPE = "Your answers shape the plan; creating it is your choice.";
const FIXED = "Nothing is written until you choose Approve setup.";
const QUESTION = "How should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details";
const CODEX = "/usr/local/bin/codex";
const probeLine = (printed: string): string => `Reviewer probe: \`command -v codex\` printed ${printed}`;
const result = (verdict: string, ref: string): string => `Independent review: ${verdict}, invocation ${ref}`;
const SKIP = "Independent review: skipped at the owner's request";
const GOVERNANCE = "Governance files to write: AGENTS.md, RULES.md and REVIEW.md. Sources: brief.md and docs/schedule.md.";
/** A check set 5 package: governance, level, probe and status lines, the two fixed lines, one blank line, the four lines. */
const pkg5 = (status: string, probe: string = CODEX, above = "", closing = `${SHAPE}\n${FIXED}`): string =>
  [above, GOVERNANCE, "Quality level: Full pipeline", `${probeLine(probe)}\n${status}`, closing, QUESTION].filter((x) => x !== "").join("\n\n");
const PENDING = "Verification tooling to establish: WRITE_TESTS (frontend): npm test (pending: no test files)\nVerification tooling to establish: TEST (frontend): npm test (pending: no test files)";
const summary = (status: string, probe: string = CODEX): string => ["Setup is approved and written.", `${probeLine(probe)}\n${status}`, PENDING].join("\n\n");
const DISCO = "Who will use the first version?";
const UNAV = "No supported reviewer is available to review this plan.\nHow should I proceed?\nRetry the review\nContinue without independent review";

const probePath: Item = { cmd: "/bin/zsh -lc 'command -v codex'", out: `${CODEX}\n`, exit: 0 };
const probeNothing: Item = { cmd: "/bin/zsh -lc 'command -v codex'", out: "", exit: 1 };
const exec = (id: string, verdict: string, exit = 0): Item => ({
  cmd: `codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema '/skill/setup-review-schema.json' - <<'STORYBLOQ_PLAN'\nReview id: ${id}\nPlan: two tickets.\nSTORYBLOQ_PLAN`,
  out: exit === 0 ? JSON.stringify({ verdict, findings: [] }) : "error: model unavailable",
  exit,
});
const reviewPlan = (id: string, verdict: string): Item => ({ mcp: "review_plan", args: { plan: `Review id: ${id}\nPlan: two tickets.` }, result: { structuredContent: { verdict, findings: [] } } });
const spawn = (agent: string, id: string): Item => ({ collab: "spawn_agent", receivers: [agent], prompt: `Review id: ${id}\nReview this plan.` });
const waitDone = (agent: string, verdict: string): Item => ({ collab: "wait", receivers: [agent], states: { [agent]: { status: "completed", message: JSON.stringify({ verdict, findings: [] }) } } });

/** The none variant under check set 5: discovery (the probe in the first turn), package, inspect, adjust (a fresh review), approve. */
const cleanRun5 = (packageAbove = "", openingText = DISCO): Turn5[] => [
  { text: openingText, items: [probePath] },
  { text: pkg5(result("approve", "R1"), CODEX, packageAbove), items: [exec("R1", "approve")] },
  { text: pkg5(result("approve", "R1")) },
  { text: pkg5(result("approve", "R2")), items: [exec("R2", "approve")] },
  { text: summary(result("approve", "R2")) },
];

/** The reviewer-unavailable variant under check set 5: the stop alone, the skip, discovery, then the package turns. */
const skippedRun5 = (opening: Turn5 = { text: UNAV, items: [probeNothing] }): Turn5[] => [
  opening,
  { text: DISCO },
  { text: pkg5(SKIP, "nothing") },
  { text: pkg5(SKIP, "nothing") },
  { text: pkg5(SKIP, "nothing") },
  { text: summary(SKIP, "nothing") },
];

const CITES = (label: string): string => `the package cites the setup skill (${label})`;
const OPENING = "the reviewer-unavailable stop did not open the run";

// --- version and rule text -------------------------------------------------------------------------------------------

describe("check set 5: version and rule text", () => {
  it("V1: check set 5 is current and known; its rules extend check set 4's, which are unchanged", () => {
    expect(lib.CHECK_SET_VERSION).toBe(5);
    expect(lib.KNOWN_CHECK_SETS).toContain(5);
    expect(createHash("sha256").update(lib.WRITE_RULE_VERSION_4).digest("hex")).toBe("ffba587587ca1a9407bf098df6d60e2ef73514d2a629d1f3c1771a28cb7e54fd");
    expect(createHash("sha256").update(lib.STOP_RULE_VERSION_4).digest("hex")).toBe("2e39b1aba90f59eb8408bb93d374f9524afd9aec2a11668ef5865c90401d3aa9");
    expect(lib.writeRuleFor(4)).toBe(lib.WRITE_RULE_VERSION_4);
    expect(lib.stopRuleFor(4)).toBe(lib.STOP_RULE_VERSION_4);
    expect(lib.writeRuleFor(5)).toBe(lib.WRITE_RULE_VERSION_5);
    expect(lib.stopRuleFor(5)).toBe(lib.STOP_RULE_VERSION_5);
    expect(lib.WRITE_RULE_VERSION_5.startsWith(`2026-10-01.1: ${lib.WRITE_RULE_VERSION_4.slice("2026-09-30.1: ".length)}; check set 5: `)).toBe(true);
    expect(lib.STOP_RULE_VERSION_5.startsWith(`2026-10-01.1: ${lib.STOP_RULE_VERSION_4.slice("2026-09-30.1: ".length)}; check set 5: `)).toBe(true);
  });
});

// --- A1: the package cites the setup skill -------------------------------------------------------------------------

describe("check set 5 (A1): a package that cites the setup skill fails", () => {
  it("A1a: a complete compliant package passes: both fixed lines, the four labels, probe and status lines, governance files and source references", () => {
    const d = drive5("none", cleanRun5());
    expect(d.state.failures).toEqual([]);
    expect(corpus.findSkillCitations(pkg5(result("approve", "R1")))).toEqual([]);
  });

  it("A1b: a link-only paragraph to a skill file fails the package turn", () => {
    const d = drive5("none", cleanRun5("[setup rules](/home/u/.agents/skills/story/setup-flow.md)"));
    expect(failuresOf(d.state, "closing")).toEqual([CITES("discovery-1")]);
  });

  it("A1c: a bare setup-flow.md or SKILL.md mention fails the package turn", () => {
    for (const above of ["The plan follows setup-flow.md.", "As SKILL.md says, the package comes first."]) {
      expect(failuresOf(drive5("none", cleanRun5(above)).state, "closing"), above).toEqual([CITES("discovery-1")]);
    }
  });

  const ENTRIES = [
    "One approval of the setup package authorises all of it.",
    "Nothing is written before approval.",
    "One approval covers everything listed.",
    "Nothing is created until you approve it.",
  ];

  it("A1d: the corpus is the four entries, frozen with check set 5", () => {
    expect([...corpus.PROHIBITED_SENTENCES]).toEqual(ENTRIES);
  });

  it("A1e: each corpus entry quoted alone in an otherwise compliant package fails", () => {
    for (const entry of ENTRIES) {
      expect(failuresOf(drive5("none", cleanRun5(entry)).state, "closing"), entry).toEqual([CITES("discovery-1")]);
      expect(corpus.findSkillCitations(`Before you choose: ${entry} Then pick.`).length, entry).toBeGreaterThan(0);
    }
  });

  it("A1f: a near match passes: one word changed, or a letter glued on so a boundary is missing", () => {
    for (const near of [
      "One approval of the setup package authorises none of it.",
      "Nothing is written before review.",
      "Nothing is written before approvals.",
      "Done approval covers everything listed.",
      "Nothing is created until you approve items.",
    ]) {
      expect(failuresOf(drive5("none", cleanRun5(near)).state, "closing"), near).toEqual([]);
      expect(corpus.findSkillCitations(near), near).toEqual([]);
    }
  });

  it("A1g: normalisation: case, typographic quotes and collapsed whitespace still match", () => {
    for (const variant of ["“NOTHING is written before approval”", "One  approval covers\neverything listed", "‘nothing is created until you approve it’."]) {
      expect(corpus.findSkillCitations(variant).length, variant).toBeGreaterThan(0);
    }
    expect(failuresOf(drive5("none", cleanRun5("“NOTHING is written before approval”")).state, "closing")).toEqual([CITES("discovery-1")]);
  });

  it("A1h: mandated output text and the governance files are never flagged", () => {
    for (const text of [SHAPE, FIXED, QUESTION, probeLine(CODEX), result("approve", "R1"), SKIP, "AGENTS.md RULES.md REVIEW.md CLAUDE.md", "See brief.md and docs/plan.md."]) {
      expect(corpus.findSkillCitations(text), text).toEqual([]);
    }
  });

  it("A1i: check set 4 does not run the corpus detector", () => {
    const cs4 = drive5("none", cleanRun5("Nothing is written before approval.").map((t) => ({ ...t, text: t.text.replace(`${SHAPE}\n`, "") })), 4);
    expect(cs4.state.failures.filter((f) => f.startsWith("the package cites the setup skill"))).toEqual([]);
  });
});

// --- A2: the two-line closing block --------------------------------------------------------------------------------

describe("check set 5 (A2): the skill-owned line above the fixed line", () => {
  it("A2a: check set 5 requires both lines, in order, ending the paragraph above the question; check set 4 is unchanged", () => {
    const two = pkg5(result("approve", "R1"));
    const one = pkg5(result("approve", "R1"), CODEX, "", FIXED);
    const swapped = pkg5(result("approve", "R1"), CODEX, "", `${FIXED}\n${SHAPE}`);
    expect(lib.hasFixedLine(two, 5)).toBe(true);
    expect(lib.hasFixedLine(one, 5)).toBe(false);
    expect(lib.hasFixedLine(swapped, 5)).toBe(false);
    expect(lib.hasFixedLine(one, 4)).toBe(true);
    expect(lib.hasFixedLine(one)).toBe(true);
    expect(lib.SHAPE_LINE).toBe(SHAPE);
  });

  it("A2b: a check set 5 package with the fixed line alone fails the closing check", () => {
    const turns = cleanRun5();
    turns[1] = { ...turns[1]!, text: pkg5(result("approve", "R1"), CODEX, "", FIXED) };
    expect(failuresOf(drive5("none", turns).state, "closing")).toEqual(["the package does not carry the fixed line above the question (discovery-1)"]);
  });
});

// --- A3: citations outside the package -------------------------------------------------------------------------------

describe("check set 5 (A3): citations outside the package are recorded, never failed", () => {
  it("A3a: an opening citation is recorded with its line; nothing fails", () => {
    const line = "Per setup-flow.md, I ask before drafting.";
    const d = drive5("none", cleanRun5("", `${line}\n\n${DISCO}`));
    expect(d.state.failures).toEqual([]);
    expect(d.evidence.skillCitations).toEqual([{ turn: "opening", line }]);
  });

  it("A3c: a path citation on one line and a corpus sentence broken across the next two: all three lines are recorded", () => {
    const cited = ["Per setup-flow.md, I ask before drafting.", "One approval covers", "everything listed."];
    expect(corpus.citingLines(`Intro line.\n${cited.join("\n")}\n\n${DISCO}`)).toEqual(cited);
    const d = drive5("none", cleanRun5("", `${cited.join("\n")}\n\n${DISCO}`));
    expect(d.state.failures).toEqual([]);
    expect(d.evidence.skillCitations).toEqual(cited.map((line) => ({ turn: "opening", line })));
  });

  it("A3d: one corpus sentence broken across two lines and whole on the second: both lines are recorded, never the whole copy alone", () => {
    const text = ["One approval covers", "everything listed. One approval covers everything listed.", "Unrelated."].join("\n");
    expect(corpus.citingLines(text)).toEqual(["One approval covers", "everything listed. One approval covers everything listed."]);
    expect(corpus.citingLines("One approval covers everything listed.\nUnrelated.\nOne approval\ncovers everything\nlisted.")).toEqual(["One approval covers everything listed.", "One approval", "covers everything", "listed."]);
    expect(corpus.citingLines("xOne approval covers\neverything listed.\nOne approval covers\neverything listedx")).toEqual([]);
  });

  it("A3b: a package citation is a failure, not a record entry", () => {
    const d = drive5("none", cleanRun5("Nothing is written before approval."));
    expect(d.evidence.skillCitations).toEqual([]);
  });
});

// --- B2: the reviewer inventory and the opening stop ---------------------------------------------------------------

describe("check set 5 (B2): the reviewer-unavailable stop opens the run only when every reviewer path is absent", () => {
  it("B2-inventory: the fixture contract sets the inventory, never the agent's probe", () => {
    expect(drv.inventoryFor("reviewer-unavailable")).toEqual({ cli: "absent", reviewPlan: "absent", agent: "absent" });
    for (const v of ["none", "degraded", "approval-boundary"] as const) expect(drv.inventoryFor(v), v).toEqual({ cli: "present", reviewPlan: "absent", agent: "unknown" });
  });

  it("B2-1: all absent: the stop alone opens, then continue, discovery, package, inspect, adjust, approve: passes", () => {
    const d = drive5("reviewer-unavailable", skippedRun5());
    expect(d.state.failures).toEqual([]);
  });

  it("B2-2: all absent: the opening carries the stop and a discovery question: fails", () => {
    const d = drive5("reviewer-unavailable", skippedRun5({ text: `${DISCO}\n\n${UNAV}`, items: [probeNothing] }));
    expect(failuresOf(d.state, "flow")).toContain(OPENING);
  });

  it("B2-2b: all absent: a discovery question directly above the stop, no blank line between, or on the stop's own question line: fails", () => {
    const sameParagraph = drive5("reviewer-unavailable", skippedRun5({ text: `${DISCO}\n${UNAV}`, items: [probeNothing] }));
    expect(failuresOf(sameParagraph.state, "flow")).toContain(OPENING);
    const sameLine = drive5("reviewer-unavailable", skippedRun5({ text: UNAV.replace("How should I proceed?", `${DISCO} How should I proceed?`), items: [probeNothing] }));
    expect(failuresOf(sameLine.state, "flow")).toContain(OPENING);
  });

  it("B2-2c: all absent: a later paragraph that mentions retry, or a question added to an option line, is not an option line: fails", () => {
    const laterParagraph = drive5("reviewer-unavailable", skippedRun5({ text: `${UNAV}\n\nShould we retry with PostgreSQL?`, items: [probeNothing] }));
    expect(failuresOf(laterParagraph.state, "flow")).toContain(OPENING);
    const onOption = drive5("reviewer-unavailable", skippedRun5({ text: `${UNAV}, or should we use PostgreSQL?`, items: [probeNothing] }));
    expect(failuresOf(onOption.state, "flow")).toContain(OPENING);
    const afterOption = drive5("reviewer-unavailable", skippedRun5({ text: `${UNAV}. Which database do you want?`, items: [probeNothing] }));
    expect(failuresOf(afterOption.state, "flow")).toContain(OPENING);
  });

  it("B2-2d: all absent: the stop with its option lines as a list, in bold or closed by a full stop still passes the opening rule", () => {
    for (const text of [
      UNAV,
      UNAV.replace("Retry the review", "- Retry the review").replace("Continue without", "- Continue without"),
      UNAV.replace("Retry the review", "1. **Retry the review**").replace("Continue without independent review", "2. **Continue without independent review**"),
      `${UNAV}.`,
    ]) {
      const d = drive5("reviewer-unavailable", skippedRun5({ text, items: [probeNothing] }));
      expect(d.state.failures, text).not.toContain(OPENING);
    }
  });

  it("B2-2e: all absent: a stop that does not end with the two option lines, Retry then Continue, fails: one sentence, an added choice, the other order", () => {
    for (const text of [
      "The independent reviewer is unavailable. Should I retry, or continue without independent review?",
      "No supported reviewer is available to review this plan.\nShould I retry the review, continue without independent review, or switch to PostgreSQL?",
      "No supported reviewer is available to review this plan.\nHow should I proceed?\nContinue without independent review\nRetry the review",
    ]) {
      const d = drive5("reviewer-unavailable", skippedRun5({ text, items: [probeNothing] }));
      expect(d.state.turns[0]!.stop?.kind, text).toBe("review-unavailable");
      expect(failuresOf(d.state, "flow"), text).toContain(OPENING);
    }
  });

  it("B2-2f: all absent: the stop asked as a structured question with the two option labels passes, alone or after the unavailable sentence", () => {
    const labels = ["Retry the review", "Continue without independent review"];
    const NONE = "No supported reviewer is available to review this plan.";
    const toolOnly = drive5("reviewer-unavailable", skippedRun5({ text: "", items: [probeNothing], ask: { question: `${NONE} How should I proceed?`, labels } }));
    expect(toolOnly.state.failures).not.toContain(OPENING);
    const textThenTool = drive5("reviewer-unavailable", skippedRun5({ text: NONE, items: [probeNothing], ask: { question: "How should I proceed?", labels } }));
    expect(textThenTool.state.turns[0]!.stop).toMatchObject({ kind: "semantic", candidate: "review-unavailable" });
    expect(textThenTool.state.failures).not.toContain(OPENING);
    expect(textThenTool.state.failures).not.toContain("the reviewer-unavailable stop never came");
    expect(textThenTool.state.turns.slice(0, 3).map((t) => [t.label, t.prompt])).toEqual([
      ["opening", "$story set it up"],
      ["continue-without-review", "Continue without independent review."],
      ["discovery-1", SCRIPT.discovery],
    ]);
  });

  it("B2-2h: check set 4 reads the same text-then-question turn as before: a semantic stop with the discovery candidate", () => {
    const question = "How should I proceed?\nRetry the review\nContinue without independent review";
    const turn = { ...turnOf(raw5({ text: "x" }), 4), stopText: `No supported reviewer is available to review this plan.\n${question}`, pendingQuestion: { question, preamble: "No supported reviewer is available to review this plan." } };
    expect(lib.readTurnStop(turn, 4)).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(lib.readTurnStop(turn)).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(lib.checkStop(turn, ["discovery"], 4)).toMatchObject({ kind: "semantic", candidate: "discovery", ok: true });
    expect(lib.checkStop(turn, ["review-unavailable"], 5)).toMatchObject({ kind: "semantic", candidate: "review-unavailable", ok: true });
  });

  it("B2-2g: all absent: a structured question whose preceding text asks a discovery question, or whose Retry label is shortened, fails", () => {
    const labels = ["Retry the review", "Continue without independent review"];
    const NONE = "No supported reviewer is available to review this plan.";
    const asked = drive5("reviewer-unavailable", skippedRun5({ text: `${NONE}\n${DISCO}`, items: [probeNothing], ask: { question: "How should I proceed?", labels } }));
    expect(failuresOf(asked.state, "flow")).toContain(OPENING);
    const onlyDiscovery = drive5("reviewer-unavailable", skippedRun5({ text: DISCO, items: [probeNothing], ask: { question: "How should I proceed?", labels } }));
    expect(failuresOf(onlyDiscovery.state, "flow")).toContain(OPENING);
    const shortLabel = drive5("reviewer-unavailable", skippedRun5({ text: NONE, items: [probeNothing], ask: { question: "How should I proceed?", labels: ["Retry", labels[1]!] } }));
    expect(failuresOf(shortLabel.state, "flow")).toContain(OPENING);
  });

  it("B2-3: all absent: discovery in the opening, the stop in discovery-1: fails", () => {
    const d = drive5("reviewer-unavailable", [
      { text: DISCO, items: [probeNothing] },
      { text: UNAV },
      { text: pkg5(SKIP, "nothing") },
      { text: pkg5(SKIP, "nothing") },
      { text: pkg5(SKIP, "nothing") },
      { text: summary(SKIP, "nothing") },
    ]);
    expect(failuresOf(d.state, "flow")).toContain(OPENING);
  });

  it("B2-4: the owner's reply answers only the review decision; the driver then sends the discovery prompt, never an invented reply", () => {
    const d = drive5("reviewer-unavailable", skippedRun5());
    expect(d.state.turns.map((t) => [t.label, t.prompt])).toEqual([
      ["opening", "$story set it up"],
      ["continue-without-review", "Continue without independent review."],
      ["discovery-1", SCRIPT.discovery],
      ["inspect", "Inspect details: show me the coverage map."],
      ["adjust", SCRIPT.adjustment],
      ["approve", SCRIPT.approval],
    ]);
  });

  it("B2-5: cli absent, review_plan present: discovery, then a review_plan review: no opening-stop failure", () => {
    const d = drive5("none", [
      { text: DISCO, items: [probeNothing] },
      { text: pkg5(result("approve", "R1"), "nothing"), items: [reviewPlan("R1", "approve")] },
      { text: pkg5(result("approve", "R1"), "nothing") },
      { text: pkg5(result("approve", "R2"), "nothing"), items: [reviewPlan("R2", "approve")] },
      { text: summary(result("approve", "R2"), "nothing") },
    ], 5, { cli: "absent", reviewPlan: "present", agent: "unknown" });
    expect(d.state.failures).not.toContain(OPENING);
  });

  it("B2-6: cli and review_plan absent, an agent present: discovery, then an agent review: no opening-stop failure", () => {
    const d = drive5("none", [
      { text: DISCO, items: [probeNothing] },
      { text: pkg5(result("approve", "R1"), "nothing"), items: [spawn("a", "R1"), waitDone("a", "approve")] },
      { text: pkg5(result("approve", "R1"), "nothing") },
      { text: pkg5(result("approve", "R2"), "nothing"), items: [spawn("b", "R2"), waitDone("b", "approve")] },
      { text: summary(result("approve", "R2"), "nothing") },
    ], 5, { cli: "absent", reviewPlan: "absent", agent: "present" });
    expect(d.state.failures).not.toContain(OPENING);
  });

  it("B2-7: cli present: discovery, a failed codex invocation, then the stop alone: allowed", () => {
    const d = drive5("reviewer-unavailable", [
      { text: DISCO, items: [probePath] },
      { text: UNAV, items: [exec("R1", "approve", 1)] },
      { text: pkg5(SKIP) },
      { text: pkg5(SKIP) },
      { text: pkg5(SKIP) },
      { text: summary(SKIP) },
    ], 5, { cli: "present", reviewPlan: "absent", agent: "unknown" });
    expect(d.state.failures).not.toContain(OPENING);
  });

  it("B2-8: check set 4 replays attempt 10 byte for byte; the opening rule fires on run 8 only under check set 5", () => {
    for (const [name, want] of Object.entries(A10_PINS)) {
      const dir = mkdtempSync(join(tmpdir(), "regrade5-"));
      try {
        cpSync(join(RUNS, name), dir, { recursive: true });
        const r = rg.regrade(run.regradeInputFrom(join(dir, "record"), join(dir, "raw")));
        expect(r.ok ? sha256(rg.canonical(r.result)) : r.reason, name).toBe(want);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    expect(replay("a10-run8", 4).state.failures).not.toContain(OPENING);
    expect(replay("a10-run8", 5).state.failures).toContain(OPENING);
  });

  it("B2-9: unknown is not absence: cli and review_plan absent, agent unknown: discovery first, then the stop: allowed", () => {
    const d = drive5("reviewer-unavailable", [
      { text: DISCO, items: [probeNothing] },
      { text: UNAV },
      { text: pkg5(SKIP, "nothing") },
      { text: pkg5(SKIP, "nothing") },
      { text: pkg5(SKIP, "nothing") },
      { text: summary(SKIP, "nothing") },
    ], 5, { cli: "absent", reviewPlan: "absent", agent: "unknown" });
    expect(d.state.failures).not.toContain(OPENING);
  });
});

// --- B3: the client's instruction context ----------------------------------------------------------------------------

describe("check set 5 (B3): the rollout's instruction context, or unknown", () => {
  it("B3a: a session_meta with base instructions gives their sha256 and the CLI version; none gives unknown", () => {
    const text = "You are Codex.";
    const lines = [
      { type: "session_meta", payload: { cli_version: "0.153.4", base_instructions: { provenance: "builtin", text } } },
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
    ];
    expect(lib.rolloutInstructions(lines)).toEqual({ status: "observed", sha256: sha256(text), cliVersion: "0.153.4" });
    expect(lib.rolloutInstructions([{ type: "turn_context", payload: { model: "m" } }])).toEqual({ status: "unknown" });
    expect(lib.rolloutInstructions([{ type: "session_meta", payload: { cli_version: "0.153.4" } }])).toEqual({ status: "unknown" });
  });
});

// --- C1: a wrapper word of single and double quoted segments ---------------------------------------------------------

/** Attempt 10 run 9, approve: the python heredoc in a wrapper word of double and single quoted segments. */
const RUN9_HEREDOC = ((): string => {
  for (const l of readFileSync(join(RUNS, "a10-run9", "raw", "turn-05-approve.jsonl"), "utf-8").split("\n")) {
    if (l.trim() === "") continue;
    const e = JSON.parse(l) as { type?: string; item?: { type?: string; command?: string } };
    if (e.type === "item.completed" && e.item?.type === "command_execution" && (e.item.command ?? "").includes("<<'PY'")) return e.item.command!;
  }
  throw new Error("run 9's heredoc is not in the fixture");
})();
/** sha256 of the heredoc body as POSIX shell quoting yields it (python shlex, posix), taken independently of this parser. */
const RUN9_BODY_SHA = "21afbbba78a0e3e6698ab2e69be05a290f2a7ed28d03943446977af047c988b8";

describe("check set 5 (C1): a mixed single and double quoted wrapper word is read as the inner shell receives it", () => {
  it("C1a: run 9's heredoc is one interpreter script with the exact body and no unparsed entry; check set 4 keeps the unparsed entry", () => {
    const a = analyse([RUN9_HEREDOC], "approve", 5);
    expect(a.unresolved).toEqual([]);
    expect(a.interpreterScripts).toHaveLength(1);
    expect(sha256(a.interpreterScripts[0]!.body)).toBe(RUN9_BODY_SHA);
    const wrapper = a.interpreterScripts[0]!.wrapper as { shell: string; quote: string; segments: { kind: string; text: string }[] };
    expect(wrapper.quote).toBe("mixed");
    expect(new Set(wrapper.segments.map((s) => s.kind))).toEqual(new Set(["double", "single"]));
    const cs4 = analyse([RUN9_HEREDOC], "approve", 4);
    expect(cs4.unresolved.length).toBeGreaterThan(0);
    expect(cs4.interpreterScripts).toEqual([]);
  });

  it("C1b: the reading concatenates the segments; check set 4 and the default keep a mixed word unread", () => {
    const cmd = `/bin/zsh -lc "a \\"b\\" \\\\ c"'d $x'`;
    expect(lib.readWrapper(cmd, 5)).toMatchObject({ shell: "/bin/zsh", quote: "mixed", inner: 'a "b" \\ cd $x' });
    expect(lib.readWrapper(cmd, 4)).toBeNull();
    expect(lib.readWrapper(cmd)).toBeNull();
    expect(lib.readWrapper("/bin/zsh -lc 'echo hi'", 5)).toEqual({ shell: "/bin/zsh", quote: "single", inner: "echo hi" });
  });

  it("C1c: a bare segment stays unread (M-C1a)", () => {
    expect(lib.readWrapper(`/bin/zsh -lc "a"b'c'`, 5)).toBeNull();
  });

  it("C1d: a $, a backtick or a backslash-newline in a double segment is undecidable (M-C1b)", () => {
    expect(lib.readWrapper(`/bin/zsh -lc "echo $HOME"'x'`, 5)).toBe("undecidable");
    expect(lib.readWrapper("/bin/zsh -lc \"a `x`\"'b'", 5)).toBe("undecidable");
    expect(lib.readWrapper(`/bin/zsh -lc "a \\\nb"'c'`, 5)).toBe("undecidable");
  });

  it("C1e: a substitution assembled across segments is code in the inner shell: needs-review", () => {
    const cmd = `/bin/zsh -lc "echo "'$('"touch x"')'`;
    expect(lib.readWrapper(cmd, 5)).toMatchObject({ quote: "mixed", inner: "echo $(touch x)" });
    expect(analyse([cmd], "approve", 5).unresolved.length).toBeGreaterThan(0);
  });

  const mixedHeredoc = (tail: string): string => `/bin/zsh -lc "python3 - <<'PY'\nimport pathlib\n"'print("$story")'"\nPY${tail}"`;

  it("C1f: a counted write after a qualifying heredoc is still counted", () => {
    const a = analyse([mixedHeredoc("\ngit init")], "approve", 5);
    expect(a.interpreterScripts).toHaveLength(1);
    expect(a.interpreterScripts[0]!.body).toBe('import pathlib\nprint("$story")');
    expect(a.writes).toHaveLength(1);
  });

  it("C1g: an unresolved write after a qualifying heredoc stays unresolved, never dropped", () => {
    const a = analyse([mixedHeredoc("\nprintf x > out.txt")], "approve", 5);
    expect(a.unresolved.length).toBeGreaterThan(0);
  });
});

// --- replay pins and the analysis ------------------------------------------------------------------------------------

/** Taken at 12e94f38 before any change: sha256 of the canonical regrade result per attempt 10 run, under check set 4. */
const A10_PINS: Record<string, string> = {
  "a10-run1": "0e49113a8a78d1e3e80bcf32be734b420806a42e0dbf8cfcd227b1d965790636",
  "a10-run6": "ef0c1e383563e3e0bbfaa5c3ce12e4a5c202b9218b330e50d7a1360776c10b82",
  "a10-run8": "c18f9e772f311a04f60319db1af085bcb748f98bf814d138b4840e3f448ab193",
  "a10-run9": "74e2e089407ac06dc82429a587d9a399161fb62546ace29d7a26ee8f1b8f2056",
  "a10-run12": "adb921dd758f38f5f3df36af612c72d68c83455dcd5231cfc553841d928a9d1f",
};

/** A stored run replayed through the flow under a check set, with the variant's fixture inventory. */
function replay(name: string, cs: number): { state: DriveState } {
  const input = run.regradeInputFrom(join(RUNS, name, "record"), join(RUNS, name, "raw"));
  const record = JSON.parse(input.recordBytes.toString("utf-8")) as { variant: Variant; turns: { label: string; treeChanges: string[] }[]; treeExclusion: RuntimeExclusion };
  const state = drv.newDriveState(cs);
  const flow = drv.driveFlow({ variant: record.variant, firstPrompt: input.fixture.firstPrompt, discoveryPrompt: input.fixture.discoveryPrompt, afterPackage: input.fixture.afterPackage, exclusion: record.treeExclusion, reviewerInventory: drv.inventoryFor(record.variant) }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const label = record.turns[n]!.label;
    const turn = turnOf(input.readRaw(`${rg.turnFile(n, label)}.jsonl`).toString("utf-8"), cs);
    const changes = record.turns[n]!.treeChanges;
    step = flow.next({ turn, exitCode: 0, infraFailure: null, stderrPath: "", treeChanges: () => changes });
    n++;
  }
  return { state };
}

const ANALYSIS_KEYS = ["flowIncompatibility", "packageCitations", "packetSha256", "recordSha256", "skillCitations", "sourceCheckSet", "targetCheckSet", "wrapper"];
const PACKAGE_TURNS = new Set(["discovery-1", "discovery-2", "discovery-3", "continue-without-review", "inspect", "adjust", "approval-probe"]);
const RUN5_OPENING_CITATION = "The [story setup flow](/private/tmp/cc-cpm-w4-t536/onboarding-eval-8VV1xt/home/.agents/skills/story/setup-flow.md) says to “let the user rule before planning depends on it” when sources conflict. Nothing has been written.";
const STOP_ALONE = { turn: "opening", targetFlow: "the reviewer-unavailable stop alone", captured: "discovery questions" };

describe("the attempt 10 analysis under check set 5's detectors: observational, written apart", () => {
  const analysed = (name: string): ReturnType<typeof an.analysePaths> => an.analysePaths(join(RUNS, name, "record"), join(RUNS, name, "raw"));

  it("AN1: the artifact carries the source hashes and check sets, the detector results and the flow list, and no verdict or failure list", () => {
    const r = analysed("a10-run1");
    expect(Object.keys(r).sort()).toEqual(ANALYSIS_KEYS);
    expect(r.recordSha256).toBe(sha256(readFileSync(join(RUNS, "a10-run1", "record", "record.json"))));
    expect(r.packetSha256).toBe(sha256(readFileSync(join(RUNS, "a10-run1", "record", "grading-packet.json"))));
    expect([r.sourceCheckSet, r.targetCheckSet]).toEqual([4, 5]);
  });

  it("AN2: package citations on runs 1, 6 and 8, on package turns only; none on runs 9 and 12", () => {
    for (const name of ["a10-run1", "a10-run6", "a10-run8"]) {
      const r = analysed(name);
      expect(r.packageCitations.length, name).toBeGreaterThan(0);
      for (const c of r.packageCitations) expect(PACKAGE_TURNS.has(c.turn), `${name} ${c.turn}`).toBe(true);
    }
    for (const name of ["a10-run9", "a10-run12"]) expect(analysed(name).packageCitations, name).toEqual([]);
  });

  it("AN3: run 9's approve heredoc reads as one script with no unparsed entry under the target; the other runs show no wrapper difference", () => {
    const r9 = analysed("a10-run9");
    expect(r9.wrapper.source.unparsed.length).toBeGreaterThan(0);
    expect(r9.wrapper.target.unparsed).toEqual([]);
    expect(r9.wrapper.target.scripts).toEqual([...r9.wrapper.source.scripts, expect.objectContaining({ turn: "approve", bodySha256: RUN9_BODY_SHA })]);
    for (const name of ["a10-run1", "a10-run6", "a10-run8", "a10-run12"]) {
      const r = analysed(name);
      expect(r.wrapper.target, name).toEqual(r.wrapper.source);
    }
  });

  it("AN4: the flow incompatibility lists the opening of runs 8 and 9 only", () => {
    for (const name of ["a10-run8", "a10-run9"]) expect(analysed(name).flowIncompatibility, name).toEqual([STOP_ALONE]);
    for (const name of ["a10-run1", "a10-run6", "a10-run12"]) expect(analysed(name).flowIncompatibility, name).toEqual([]);
  });

  it("AN6: run 5's opening citation is listed in skillCitations with its turn and line, and is not a package citation", () => {
    const r = analysed("a10-run5");
    expect(r.skillCitations).toEqual([{ turn: "opening", line: RUN5_OPENING_CITATION }]);
    expect(r.packageCitations.length).toBeGreaterThan(0);
    for (const c of r.packageCitations) {
      expect(PACKAGE_TURNS.has(c.turn), c.turn).toBe(true);
      expect(c.line).not.toBe(RUN5_OPENING_CITATION);
    }
  });

  it("AN5: the command writes analysis-cs5.json to --out only, refuses to overwrite it, and leaves the record and raw unchanged", () => {
    const out = mkdtempSync(join(tmpdir(), "analyse5-"));
    try {
      const record = join(RUNS, "a10-run9", "record");
      const raw = join(RUNS, "a10-run9", "raw");
      const before = [lib.treeDigest(record), lib.treeDigest(raw)];
      an.main(["--record", record, "--raw", raw, "--out", out]);
      expect(readdirSync(out)).toEqual(["analysis-cs5.json"]);
      expect(JSON.parse(readFileSync(join(out, "analysis-cs5.json"), "utf-8"))).toEqual(analysed("a10-run9"));
      expect(() => an.main(["--record", record, "--raw", raw, "--out", out])).toThrow();
      expect([lib.treeDigest(record), lib.treeDigest(raw)]).toEqual(before);
      expect(existsSync(join(record, "analysis-cs5.json"))).toBe(false);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it("AN6: --raw is required; a missing raw directory or another run's raw is refused before anything is written", () => {
    const out = mkdtempSync(join(tmpdir(), "analyse5-"));
    try {
      const record = join(RUNS, "a10-run6", "record");
      expect(() => an.main(["--record", record, "--out", out])).toThrow(/--raw/);
      expect(() => an.main(["--record", record, "--raw", join(out, "missing"), "--out", out])).toThrow();
      expect(() => an.main(["--record", record, "--raw", join(RUNS, "a10-run1", "raw"), "--out", out])).toThrow();
      expect(readdirSync(out)).toEqual([]);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
