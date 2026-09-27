/**
 * T-536: regrading a finished onboarding eval from its stored evidence. The replay must be the runner's own
 * computation, every stored field it establishes must agree, and only parser and subshell-recipe questions
 * may leave the hard failures.
 */
import { describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRecipe, codexTurn as codexTurnOf, shellSequence, STOP_RULE_VERSION, type ExpectedRecipe, type JudgeLine, type RuntimeExclusion } from "../../scripts/onboarding-eval-lib.js";
import { sha256 } from "../../scripts/continuity-lib.js";
import {
  driveFlow, finishDrive, inspectAfter, MAX_DISCOVERY_ROUNDS, newDriveState, packetText, setupRecordFrom, writesAfterApprovalOf,
  type DriveState, type Rubric, type StoryReader, type TurnResponse, type Variant,
} from "../../scripts/onboarding-eval-drive.js";
import { diskReader, diskStoryBytes, ownerScript, packageTurns, regradeCli, regradeInputFrom, REVIEW_LINE, runSemanticLines } from "../../scripts/onboarding-eval-run.js";
import {
  canonical, evidenceHash, G1, judgeable, judgeVerdict, OPAQUE_LIMIT, readRevisions, recipeSubshell, regrade, runRegrade, turnFile,
  type Candidate, type RegradeInput, type RegradeJudge, type Regraded,
} from "../../scripts/onboarding-eval-regrade.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, "..", "fixtures", "onboarding-eval-runs", "regrade");
const NOW = (): string => "2026-09-27T00:00:00.000Z";

// --- the attempt 7 runs, stored as the runner wrote them ---------------------------------

/** A writable copy of a stored run: the regrade writes beside the record. */
function storedRun(name: string): { readonly dir: string; readonly record: string; readonly raw: string; readonly done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "regrade-"));
  cpSync(join(RUNS, name), dir, { recursive: true });
  return { dir, record: join(dir, "record"), raw: join(dir, "raw"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function withRecord(input: RegradeInput, edit: (r: Record<string, any>) => void): RegradeInput {
  const r = JSON.parse(input.recordBytes.toString("utf-8")) as Record<string, any>;
  edit(r);
  return { ...input, recordBytes: Buffer.from(JSON.stringify(r, null, 2)) };
}

const packetOf = (input: RegradeInput): string => input.packetBytes.toString("utf-8");
const withPacket = (input: RegradeInput, text: string): RegradeInput => ({ ...input, packetBytes: Buffer.from(text) });

const refused = (input: RegradeInput): string => {
  const r = regrade(input);
  if (r.ok) throw new Error(`expected a refusal, got ${r.result.verdict}`);
  return r.reason;
};
const accepted = (input: RegradeInput): Regraded => {
  const r = regrade(input);
  if (!r.ok) throw new Error(`expected acceptance, got: ${r.reason}`);
  return r.result;
};

describe("regrade: attempt 7 runs 1 and 6, replayed from their raw transcripts", () => {
  it("run 1 replays to its stored failures and leaves only parser questions, in turn and run scope", () => {
    const run = storedRun("a7-run1");
    try {
      const g = accepted(regradeInputFrom(run.record, run.raw));
      expect(g.verdict).toBe("PENDING_SEMANTIC");
      expect(g.hard).toEqual([]);
      expect(g.candidates.every((c) => c.kind === "parser")).toBe(true);
      expect(g.candidates.filter((c) => c.scope === "turn").map((c) => (c as { turnIndex: number }).turnIndex)).toEqual([0, 0, 0, 0, 0]);
      expect(g.candidates.filter((c) => c.scope === "run").map((c) => c.kind === "parser" && c.segment).at(-1)).toBe("python3 - <<'' [heredoc into python3]");
    } finally { run.done(); }
  });

  it("run 6 turns its correct subshell recipe into one question bound to the enabled command", () => {
    const run = storedRun("a7-run6");
    try {
      const input = regradeInputFrom(run.record, run.raw);
      const g = accepted(input);
      const record = JSON.parse(input.recordBytes.toString("utf-8")) as { inspection: { testStages: { command: string } }; failures: string[] };
      expect(g.candidates).toContainEqual({ kind: "recipe", scope: "run", command: record.inspection.testStages.command });
      expect(record.failures.some((f) => f.startsWith("recipe: "))).toBe(true);
      expect(g.hard).toEqual([]);
    } finally { run.done(); }
  });

  it("a first regrade writes regrade/001 as a pair and never writes the original record or packet", () => {
    const run = storedRun("a7-run6");
    try {
      const before = readdirSync(run.record).map((n) => [n, sha256(readFileSync(join(run.record, n)))]);
      const r = runRegrade(run.record, regradeInputFrom(run.record, run.raw), null, NOW);
      expect(r.ok).toBe(true);
      expect(readdirSync(join(run.record, "regrade"))).toEqual(["001"]);
      expect(readdirSync(join(run.record, "regrade", "001")).sort()).toEqual(["record.regraded.json", "regrade.json"]);
      expect(before.map(([n]) => [n, sha256(readFileSync(join(run.record, n!)))])).toEqual(before);
      expect(readdirSync(run.record).filter((n) => n.startsWith(".regrade-tmp-"))).toEqual([]);
    } finally { run.done(); }
  });

  it("refuses a stored packet edited while the record stays intact", () => {
    const run = storedRun("a7-run1");
    try {
      const input = regradeInputFrom(run.record, run.raw);
      expect(refused(withPacket(input, packetOf(input).replace("\"finalSummary\": \"", "\"finalSummary\": \"x")))).toMatch(/grading packet differs/);
    } finally { run.done(); }
  });

  it("refuses a raw transcript the record does not account for, and a missing one", () => {
    const run = storedRun("a7-run1");
    try {
      const input = regradeInputFrom(run.record, run.raw);
      expect(refused({ ...input, rawNames: [...input.rawNames, "turn-06-extra.jsonl"] })).toMatch(/does not belong/);
      expect(refused({ ...input, rawNames: input.rawNames.filter((n) => n !== "turn-02-discovery-1.stderr.txt") })).toMatch(/missing/);
    } finally { run.done(); }
  });

  it("refuses a run graded under a rule version it does not support", () => {
    const run = storedRun("a7-run1");
    try {
      const input = regradeInputFrom(run.record, run.raw);
      const packet = packetOf(input).replace(JSON.stringify(STOP_RULE_VERSION), JSON.stringify("2026-01-01.1: older"));
      expect(refused(withPacket(input, packet))).toMatch(/rule version/);
    } finally { run.done(); }
  });
});

// --- synthetic runs through the same flow ------------------------------------------------

interface SynthTurn {
  readonly text: string;
  readonly commands?: readonly (string | { readonly command: string; readonly output: string })[];
  readonly terminal?: "completed" | "failed" | "missing";
  readonly infra?: string | null;
  readonly tree?: readonly string[];
}

const PACKAGE = "Here is the package.\n- Approve setup\n- Adjust the plan\n- Inspect details";
const DISCOVERY = "Who uses the board?";
const UNAVAILABLE = "The independent reviewer is unavailable. Should I retry, or continue without independent review?";
const REVIEW = { command: "codex exec --sandbox read-only \"Review this plan: two tickets\"", output: "The plan is sound." };
const LOOP = "for f in a b; do cat $f; done";

const RUN6_RECORD = JSON.parse(readFileSync(join(RUNS, "a7-run6", "record", "record.json"), "utf-8")) as { treeExclusion: RuntimeExclusion };
const RUN6_STORY = join(RUNS, "a7-run6", "raw", "project.after", ".story");
const RUBRIC = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "onboarding", "mixed-stack", "rubric.json"), "utf-8")) as Rubric;
const SCRIPT = ownerScript("## Discovery answers\nVolunteers.\n\n## Adjustment turn\nDrop ticket 2.\n\n## Approval probe turn\nLooks interesting.\n\n## Affirmative approval turn\nYes, go ahead.\n");
const NO_STORY: StoryReader = { exists: () => false, read: () => { throw new Error("no story"); }, list: () => [] };

function codexRaw(t: SynthTurn): string {
  const lines: unknown[] = [{ type: "thread.started", thread_id: "th" }];
  for (const c of t.commands ?? []) {
    const { command, output } = typeof c === "string" ? { command: c, output: "" } : c;
    lines.push({ type: "item.completed", item: { type: "command_execution", command, exit_code: 0, aggregated_output: output } });
  }
  lines.push({ type: "item.completed", item: { type: "agent_message", text: t.text } });
  if ((t.terminal ?? "completed") === "completed") lines.push({ type: "turn.completed" });
  if (t.terminal === "failed") lines.push({ type: "turn.failed", error: { message: "boom" } });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

interface Synth {
  readonly input: RegradeInput;
  readonly state: DriveState;
  readonly record: Record<string, any>;
  readonly packet: Record<string, any>;
}

/** A run the runner would have recorded, without spawning a client: the same flow, record fields and packet. */
function synth(variant: Variant, script: readonly SynthTurn[], storyDir: string | null = null): Synth {
  const story: StoryReader | null = storyDir === null ? null : diskReader(storyDir);
  const runId = "synthetic";
  const exclusion = RUN6_RECORD.treeExclusion;
  const afterPackage = packageTurns(variant, SCRIPT);
  const raw = new Map<string, string>();
  const state = newDriveState();
  const flow = driveFlow({ variant, firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage, exclusion }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const t = script[n];
    if (!t) throw new Error(`the script has no turn ${n} (${step.value.label})`);
    const file = turnFile(n, step.value.label);
    const text = codexRaw(t);
    raw.set(`${file}.jsonl`, text).set(`${file}.stderr.txt`, "");
    const parsed = regradeTurn(text);
    const infra = t.infra !== undefined ? t.infra : parsed.terminal.status !== "completed" ? `terminal ${parsed.terminal.status}: ${parsed.terminal.detail}` : null;
    const response: TurnResponse = { turn: parsed, exitCode: infra?.startsWith("exit ") ? Number(infra.slice(5)) : 0, infraFailure: infra, stderrPath: `/raw/${runId}/${file}.stderr.txt`, treeChanges: () => [...(t.tree ?? [])] };
    n++;
    step = flow.next(response);
  }
  if (n !== script.length) throw new Error(`the flow ended after ${n} of ${script.length} scripted turns`);
  const evidence = finishDrive(state, REVIEW_LINE);
  const adjusted = afterPackage.some((x) => x.label === "adjust");
  const semanticLines = runSemanticLines(state.reviewSkipped, state.turns, exclusion, adjusted);
  const reader = story ?? NO_STORY;
  const { inspection, ledgerRecords } = inspectAfter(state, reader, RUBRIC, () => ({}), variant);
  const text = packetText({
    runId, semanticLines, reviewSkipped: state.reviewSkipped, exclusion, rubric: RUBRIC, briefs: {}, projectFiles: {}, turns: state.turns, evidence, ledgerRecords,
    setupRecord: story ? setupRecordFrom(story) : "", final: state.final,
  });
  const record = JSON.parse(JSON.stringify({
    runId, client: "codex", fixture: "mixed-stack", variant, turns: state.turns, discoveryRounds: state.rounds, reviewSkipped: state.reviewSkipped,
    reviewEvidence: evidence.reviewEvidence, writesAfterApproval: writesAfterApprovalOf(state), unparsed: evidence.unparsed, inspection, failures: state.failures,
    infraFailed: state.infraFailed, treeExclusion: exclusion, semanticLines, bound: evidence.bound, packetSha256: sha256(text), verdict: "FAIL",
  })) as Record<string, any>;
  const input: RegradeInput = {
    recordBytes: Buffer.from(JSON.stringify(record, null, 2)), packetBytes: Buffer.from(text), rawNames: [...raw.keys(), "project.after"],
    readRaw: (name) => { const t = raw.get(name); if (t === undefined) throw new Error(`no raw ${name}`); return Buffer.from(t); },
    story: storyDir === null ? null : diskStoryBytes(storyDir),
    fixture: { firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage, rubric: RUBRIC, beforeConfig: () => ({}), briefs: {}, projectFiles: {}, files: [] },
    reviewLine: REVIEW_LINE, semanticLines: runSemanticLines,
  };
  return { input, state, record, packet: JSON.parse(text) as Record<string, any> };
}

/** The codex turn parser the regrade uses, with the runner's (empty) rollout models. */
function regradeTurn(text: string) {
  const lines = text.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { ...codexTurnOf(lines), models: [] as string[] };
}

/** A clean run: reviewed before the package, then inspect, adjust and approve, on run 6's approved ledger. */
const CLEAN: SynthTurn[] = [
  { text: PACKAGE, commands: [REVIEW] }, { text: PACKAGE }, { text: PACKAGE }, { text: "Setup is approved and written." },
];

describe("regrade: the replay is the runner's flow", () => {
  it("accepts an unaltered synthetic run and derives the same record", () => {
    const s = synth("none", CLEAN, RUN6_STORY);
    const g = accepted(s.input);
    expect(g.hard).toEqual([]);
    expect(g.candidates).toEqual([{ kind: "recipe", scope: "run", command: s.record.inspection.testStages.command }]);
  });

  it("refuses a recorded turn sent with a prompt the flow does not send", () => {
    const s = synth("none", CLEAN, RUN6_STORY);
    expect(refused(withRecord(s.input, (r) => { r.turns[2].prompt = "Adjust it differently."; }))).toMatch(/prompt the flow does not send/);
  });

  it("refuses a recorded turn under another label", () => {
    const s = synth("none", CLEAN, RUN6_STORY);
    expect(refused(withRecord(s.input, (r) => { r.turns[1].label = "adjust"; }))).toMatch(/flow asks for inspect|does not belong|missing/);
  });

  it("refuses a record missing the adjust or approve turn the flow still asks for", () => {
    const s = synth("none", CLEAN, RUN6_STORY);
    const noApprove = withRecord(s.input, (r) => { r.turns = r.turns.slice(0, 3); });
    expect(refused({ ...noApprove, rawNames: s.input.rawNames.filter((n) => !n.startsWith("turn-04-")) })).toMatch(/flow asks for turn 3 \(approve\)/);
    const t = synth("none", CLEAN, RUN6_STORY);
    const noAdjust = withRecord(t.input, (r) => { r.turns = [r.turns[0], r.turns[1], r.turns[3]]; });
    expect(refused({ ...noAdjust, rawNames: ["turn-01-opening.jsonl", "turn-01-opening.stderr.txt", "turn-02-inspect.jsonl", "turn-02-inspect.stderr.txt", "turn-03-approve.jsonl", "turn-03-approve.stderr.txt", "project.after"] })).toMatch(/recorded as approve, but the flow asks for adjust|missing/);
  });

  it("refuses a recorded turn left over after the flow ends", () => {
    const s = synth("none", CLEAN, RUN6_STORY);
    const extra = withRecord(s.input, (r) => { r.turns.push({ ...r.turns[3], label: "approve" }); });
    const names = [...s.input.rawNames, "turn-05-approve.jsonl", "turn-05-approve.stderr.txt"];
    expect(refused({ ...extra, rawNames: names, readRaw: (n) => (n.startsWith("turn-05") ? Buffer.from("") : s.input.readRaw(n)) })).toMatch(/record has 5 turns, the flow ends after 4/);
  });

  it("golden: the loop guard stops a run of review-unavailable stops after MAX_DISCOVERY_ROUNDS + 3 sends, spending no discovery round", () => {
    const turns = Array.from({ length: MAX_DISCOVERY_ROUNDS + 4 }, () => ({ text: UNAVAILABLE }));
    const s = synth("reviewer-unavailable", turns);
    // Pre-refactor runner (aad716ae run.ts): each review-unavailable stop sends continue-without-review and `continue`s,
    // spending the guard; the guard runs out at 6 with no failure pushed, no package, so nothing after the package is sent.
    expect(s.state.turns.map((t) => t.label)).toEqual(["opening", ...Array(6).fill("continue-without-review")]);
    expect(s.record.discoveryRounds).toBe(0);
    expect(s.record.reviewSkipped).toBe(true);
    expect(s.record.failures).toEqual(["no .story/ after approval"]);
    expect(accepted(s.input).hard).toEqual(["no .story/ after approval"]);
  });

  it("golden: discovery rounds and review-unavailable stops share the guard, not the round budget", () => {
    const script = [DISCOVERY, UNAVAILABLE, DISCOVERY, UNAVAILABLE, DISCOVERY, UNAVAILABLE, DISCOVERY].map((text) => ({ text }));
    const s = synth("reviewer-unavailable", script);
    expect(s.state.turns.map((t) => t.label)).toEqual(["opening", "discovery-1", "continue-without-review", "discovery-2", "continue-without-review", "discovery-3", "continue-without-review"]);
    expect(s.record.discoveryRounds).toBe(3);
    expect(s.record.failures).toEqual(["no .story/ after approval"]);
    accepted(s.input);
  });

  it("golden: review-unavailable in a variant with a reviewer fails once per stop, in order, before the guard ends it", () => {
    const s = synth("none", Array.from({ length: 7 }, () => ({ text: UNAVAILABLE })));
    expect(s.state.turns).toHaveLength(7);
    const flow = s.record.failures.filter((f: string) => f === "review reported unavailable in a variant where a reviewer is available");
    expect(flow).toHaveLength(6);
    expect(s.record.failures.at(-1)).toBe("no .story/ after approval");
    accepted(s.input);
  });

  it("golden: the discovery budget runs out after three rounds with the runner's failure", () => {
    const s = synth("none", Array.from({ length: 4 }, () => ({ text: DISCOVERY })));
    expect(s.state.turns.map((t) => t.label)).toEqual(["opening", "discovery-1", "discovery-2", "discovery-3"]);
    expect(s.record.failures).toContain("no setup package after 3 discovery rounds (last stop: discovery)");
    expect(accepted(s.input).hard).toContain("no setup package after 3 discovery rounds (last stop: discovery)");
  });

  it("golden: an approval probe answered by something other than the package fails after that turn's own failures", () => {
    const s = synth("approval-boundary", [{ text: PACKAGE, commands: [REVIEW] }, { text: DISCOVERY }, { text: "Done." }], RUN6_STORY);
    expect(s.state.turns.map((t) => t.label)).toEqual(["opening", "approval-probe", "approve"]);
    const probe = s.record.failures.findIndex((f: string) => f.startsWith("approval-probe: expected the clean package question again"));
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(s.record.failures.slice(0, probe).every((f: string) => f.startsWith("approval-probe:"))).toBe(true);
    expect(accepted(s.input).hard).toContain(s.record.failures[probe]);
  });
});

describe("regrade: infrastructure failures", () => {
  it("golden: an infrastructure failure at inspect ends the run with an empty final summary and no inspection, assistant text notwithstanding", () => {
    const s = synth("none", [{ text: PACKAGE, commands: [REVIEW] }, { text: "Here is the coverage map in full.", terminal: "failed" }], RUN6_STORY);
    expect(s.state.turns.map((t) => t.label)).toEqual(["opening", "inspect"]);
    expect(s.state.turns[1]!.stopText).toBe("Here is the coverage map in full.");
    expect(s.packet.finalSummary).toBe("");
    expect(s.record.inspection).toEqual({});
    // The runner still checks the failed turn's stop, after its infrastructure failure; nothing after it is checked.
    expect(s.record.failures).toEqual([
      "inspect: infrastructure: terminal failed: turn.failed: boom (stderr in /raw/synthetic/turn-02-inspect.stderr.txt)",
      "inspect: stopped at none, expected package",
    ]);
    const g = accepted(s.input);
    expect(g.verdict).toBe("FAIL");
    expect(g.hard).toEqual(s.record.failures);
  });

  it("golden: an infrastructure failure at adjust ends the run the same way, distinct from a missing final turn", () => {
    const s = synth("none", [{ text: PACKAGE, commands: [REVIEW] }, { text: PACKAGE }, { text: "Adjusted the plan as asked.", terminal: "failed" }], RUN6_STORY);
    expect(s.state.turns.map((t) => t.label)).toEqual(["opening", "inspect", "adjust"]);
    expect(s.packet.finalSummary).toBe("");
    expect(s.record.failures).toEqual([
      "adjust: infrastructure: terminal failed: turn.failed: boom (stderr in /raw/synthetic/turn-03-adjust.stderr.txt)",
      "adjust: stopped at none, expected package",
    ]);
    expect(s.record.inspection).toEqual({});
    accepted(s.input);
  });

  it("accepts an opaque exit failure over a failed terminal, and a timeout over a missing one, both hard", () => {
    for (const [infra, terminal] of [["exit 1", "failed"], ["timed out after 900000 ms", "missing"]] as const) {
      const s = synth("none", [{ text: PACKAGE, commands: [REVIEW], terminal, infra }], RUN6_STORY);
      const g = accepted(s.input);
      expect(g.hard[0]).toMatch(new RegExp(`^opening: infrastructure: ${infra}`));
    }
  });

  it("refuses a recorded clean turn whose raw terminal failed, and a terminal failure the raw does not show", () => {
    const s = synth("none", [{ text: PACKAGE, commands: [REVIEW], terminal: "failed" }], RUN6_STORY);
    expect(refused(withRecord(s.input, (r) => { r.turns[0].infraFailure = null; }))).toMatch(/raw terminal is failed/);
    const t = synth("none", CLEAN, RUN6_STORY);
    expect(refused(withRecord(t.input, (r) => { r.turns[1].infraFailure = "terminal failed: turn.failed: boom"; }))).toMatch(/is not the raw terminal/);
    expect(refused(withRecord(t.input, (r) => { r.turns[1].infraFailure = "the network ate it"; }))).toMatch(/unrecognised infrastructure/);
  });

  it("refuses an infrastructure failure deleted from the aggregate while the turn keeps it", () => {
    const s = synth("none", [{ text: PACKAGE, commands: [REVIEW], infra: "exit 1", terminal: "failed" }], RUN6_STORY);
    expect(refused(withRecord(s.input, (r) => { r.failures = r.failures.filter((f: string) => !f.includes("infrastructure")); }))).toMatch(/failures differ/);
  });
});

describe("regrade: every failure class is recomputed", () => {
  it("refuses a deleted stop failure (recomputed from raw)", () => {
    const s = synth("none", [{ text: "Here is my plan, approve it", commands: [REVIEW] }], RUN6_STORY);
    expect(s.record.failures.some((f: string) => f.startsWith("opening: "))).toBe(true);
    expect(refused(withRecord(s.input, (r) => { r.failures = r.failures.filter((f: string) => !f.startsWith("opening: ")); }))).toMatch(/failures differ/);
  });

  it("refuses a deleted tree failure (recomputed from the retained tree changes)", () => {
    const s = synth("none", [{ text: PACKAGE, commands: [REVIEW], tree: ["+ notes.txt"] }, { text: PACKAGE }, { text: PACKAGE }, { text: "Done." }], RUN6_STORY);
    const tree = s.record.failures.filter((f: string) => /before approval/.test(f));
    expect(tree).toHaveLength(1);
    expect(refused(withRecord(s.input, (r) => { r.failures = r.failures.filter((f: string) => f !== tree[0]); }))).toMatch(/failures differ/);
  });

  it("refuses a deleted inspection failure (recomputed from project.after and the fixture)", () => {
    const s = synth("none", CLEAN, null);
    expect(s.record.failures).toContain("no .story/ after approval");
    expect(refused(withRecord(s.input, (r) => { r.failures = r.failures.filter((f: string) => f !== "no .story/ after approval"); }))).toMatch(/failures differ/);
  });

  it("refuses reordered failures and a changed inspection field", () => {
    const s = synth("none", [{ text: PACKAGE }, { text: PACKAGE }, { text: PACKAGE }, { text: "Done." }], null);
    expect(s.record.failures.length).toBeGreaterThan(1);
    expect(refused(withRecord(s.input, (r) => { r.failures.reverse(); }))).toMatch(/failures differ/);
    const t = synth("none", CLEAN, RUN6_STORY);
    expect(refused(withRecord(t.input, (r) => { r.inspection.ticketCount = 99; }))).toMatch(/inspection differs/);
  });

  it("keeps a failure from a non-parser producer hard even when a parser question sits in the same run", () => {
    const s = synth("none", [{ text: PACKAGE, commands: [LOOP] }, { text: PACKAGE }, { text: PACKAGE }, { text: "Done." }], null);
    const g = accepted(s.input);
    expect(g.hard).toContain("no .story/ after approval");
    expect(g.hard).toContain("no successful supported reviewer invocation with a captured result before the package was shown");
    expect(g.verdict).toBe("FAIL");
  });
});

describe("regrade: the packet, the record and the raw must agree", () => {
  it("refuses a record and raw changed together while the packet stays intact", () => {
    const s = synth("none", CLEAN, RUN6_STORY);
    const edited = codexRaw({ text: `${PACKAGE}\n` }).replace("Here is the package.", "Here is the better package.");
    const input = withRecord(s.input, (r) => { r.turns[1].stopText = r.turns[1].stopText.replace("Here is the package.", "Here is the better package."); });
    expect(refused({ ...input, readRaw: (n) => (n === "turn-02-inspect.jsonl" ? Buffer.from(edited) : s.input.readRaw(n)) })).toMatch(/grading packet differs/);
  });

  it("refuses a packet hash the record does not carry", () => {
    const s = synth("none", CLEAN, RUN6_STORY);
    expect(refused(withRecord(s.input, (r) => { r.packetSha256 = sha256("other"); }))).toMatch(/packet hash/);
  });

  it("refuses a change in a derived record field: rounds, review skip, writes", () => {
    const s = synth("none", CLEAN, RUN6_STORY);
    expect(refused(withRecord(s.input, (r) => { r.discoveryRounds = 1; }))).toMatch(/discoveryRounds/);
    expect(refused(withRecord(s.input, (r) => { r.writesAfterApproval = 7; }))).toMatch(/writesAfterApproval/);
    expect(refused(withRecord(s.input, (r) => { r.infraFailed = true; }))).toMatch(/infraFailed/);
  });
});

describe("regrade: parser questions and the structured arrays", () => {
  const loopRun = (): Synth => synth("none", [{ text: PACKAGE, commands: [REVIEW, LOOP] }, { text: PACKAGE }, { text: PACKAGE }, { text: "Done." }], RUN6_STORY);

  it("turns a stop whose only reason is unparsed shell into one question per segment, in turn and run scope", () => {
    const s = loopRun();
    const segments = s.state.turns[0]!.unparsed!;
    expect(segments.length).toBeGreaterThan(1);
    expect(s.record.failures[0]).toBe(`opening: needs review, shell construct not parsed: ${segments.join("; ")}`);
    const g = accepted(s.input);
    expect(g.candidates.filter((c) => c.scope === "turn")).toEqual(segments.map((segment) => ({ kind: "parser", scope: "turn", turnIndex: 0, segment })));
    expect(g.candidates.filter((c) => c.kind === "parser" && c.scope === "run").map((c) => (c as { segment: string }).segment)).toEqual(segments);
    expect(g.hard).toEqual([]);
  });

  it("binds each question to a parsed segment, even one that carries the \"; \" the reason joins with", () => {
    const s = synth("none", [{ text: PACKAGE, commands: [REVIEW, "for f in 'a; b'; do cat $f; done"] }, { text: PACKAGE }, { text: PACKAGE }, { text: "Done." }], RUN6_STORY);
    const segments = s.state.turns[0]!.unparsed!;
    expect(segments).toContain("for f in a; b [shell control structure (for)]");
    expect(segments.join("; ").split("; ")).not.toEqual(segments);
    const g = accepted(s.input);
    expect(g.candidates.filter((c) => c.scope === "turn").map((c) => (c as { segment: string }).segment)).toEqual(segments);
    expect(g.candidates.filter((c) => c.kind === "parser" && c.scope === "run").map((c) => (c as { segment: string }).segment)).toEqual(segments);
  });

  it("keeps a stop hard when it has any reason besides unparsed shell", () => {
    const s = synth("none", [{ text: "Here is my plan, approve it", commands: [REVIEW, LOOP] }], RUN6_STORY);
    const stop = s.record.failures.find((f: string) => f.startsWith("opening: "))!;
    expect(stop).toContain("needs review, shell construct not parsed");
    const g = accepted(s.input);
    expect(g.hard).toContain(stop);
    expect(g.candidates.some((c) => c.scope === "turn")).toBe(false);
  });

  it("refuses a stored array that joins to the reason but splits differently", () => {
    const s = loopRun();
    const segments = s.state.turns[0]!.unparsed!;
    expect(refused(withRecord(s.input, (r) => { r.turns[0].unparsed = [segments.join("; ")]; }))).toMatch(/unparsed segments differ/);
    expect(refused(withRecord(s.input, (r) => { r.unparsed = [...segments].reverse(); }))).toMatch(/unparsed segments differ/);
    expect(refused(withRecord(s.input, (r) => { r.unparsed = [1, 2]; }))).toMatch(/not an array of strings/);
  });

  it("refuses a stop reason edited away from the stored segments", () => {
    const s = loopRun();
    expect(refused(withRecord(s.input, (r) => { r.turns[0].stop.reasons = [`needs review, shell construct not parsed: other`]; }))).toMatch(/stop differs|stop reason/);
  });

  it("accepts a legacy record without the arrays and derives the same questions", () => {
    const s = loopRun();
    const legacy = withRecord(s.input, (r) => { delete r.unparsed; for (const t of r.turns) delete t.unparsed; });
    expect(accepted(legacy).candidates).toEqual(accepted(s.input).candidates);
  });

  it("refuses a raw change that alters the reconstructed stop text", () => {
    const s = loopRun();
    const changed = codexRaw({ text: `${PACKAGE}\n\nAlso, one more thing.`, commands: [REVIEW, LOOP] });
    expect(refused({ ...s.input, readRaw: (n) => (n === "turn-01-opening.jsonl" ? Buffer.from(changed) : s.input.readRaw(n)) })).toMatch(/differs/);
  });
});

describe("regrade: the subshell recipe question", () => {
  const recipe: ExpectedRecipe = RUBRIC.expectedRecipe;
  const failureFor = (command: string): string => `recipe: ${checkRecipe({ kind: "enabled", command } as never, recipe)}`;
  const inspectionFor = (command: string) => ({ testStages: { kind: "enabled", command } });

  it("asks only about a command whose one finding is the (it uses ( )) subshell", () => {
    const ok = "(cd frontend && npm test) && (cd backend && python -m pytest)";
    expect(recipeSubshell(failureFor(ok), inspectionFor(ok), RUBRIC)).toBe(ok);
  });

  it("keeps a subshell with a pipe or a command substitution hard", () => {
    for (const hard of ["(cd frontend && npm test | tee out) && (cd backend && pytest)", "(cd frontend && npm test) && (cd $(pwd)/backend && pytest)"]) {
      expect(shellSequence(hard).operators.length).toBeGreaterThan(0);
      expect(recipeSubshell(failureFor(hard), inspectionFor(hard), RUBRIC), hard).toBeNull();
    }
  });

  it("keeps a hard command hard when its text carries the subshell marker", () => {
    const hard = "npm test; echo '(it uses ( ))'";
    expect(failureFor(hard)).not.toContain(`\`${hard}\` runs (it uses ( ))`);
    expect(recipeSubshell(failureFor(hard), inspectionFor(hard), RUBRIC)).toBeNull();
    const forged = `recipe: component test command: cannot tell where \`${hard}\` runs (it uses ( )): use a plain sequence of cd and test commands joined by && or ;`;
    expect(recipeSubshell(forged, inspectionFor(hard), RUBRIC)).toBeNull();
  });

  it("keeps other recipe failures hard, and any recipe failure under another rubric", () => {
    const ok = "(cd frontend && npm test) && (cd backend && python -m pytest)";
    expect(recipeSubshell("recipe: expected pytest, got both disabled", inspectionFor(ok), RUBRIC)).toBeNull();
    expect(recipeSubshell(failureFor(ok), inspectionFor("npm test"), RUBRIC)).toBeNull();
    expect(recipeSubshell(failureFor(ok), inspectionFor(ok), { ...RUBRIC, expectedRecipe: { testStages: "same-command", command: ok } })).toBeNull();
  });
});

// --- the judge and the revision chain ----------------------------------------------------

function judgeFor(g: Regraded, revision: number, rulings: RegradeJudge["unparsedRulings"], verdict: "pass" | "fail" = "pass"): RegradeJudge {
  const lines: JudgeLine[] = g.semanticLines.map((line) => ({ line, verdict, reason: "ok", citations: line === REVIEW_LINE ? g.bound[REVIEW_LINE] : undefined }));
  return { revision, regradeEvidenceHash: g.regradeEvidenceHash, packetSha256: g.packetSha256, judgeSessionId: "judge-1", observedModel: "gpt-6-astra", lines, unparsedRulings: rulings };
}
const passAll = (cs: readonly Candidate[]) => cs.map((candidate) => ({ candidate, verdict: "pass" as const, reason: "reads fine" }));

describe("regrade: the judge's rulings", () => {
  const loop = (): { s: Synth; g: Regraded } => {
    const s = synth("none", [{ text: PACKAGE, commands: [REVIEW, LOOP] }, { text: PACKAGE }, { text: PACKAGE }, { text: "Done." }], RUN6_STORY);
    return { s, g: accepted(s.input) };
  };

  it("passes when every question and every semantic line passes", () => {
    const { s, g } = loop();
    expect(judgeVerdict(g, packetOf(s.input), judgeFor(g, 1, passAll(g.candidates)))).toEqual({ verdict: "PASS", reasons: [] });
  });

  it("fails a question left without a ruling", () => {
    const { s, g } = loop();
    const v = judgeVerdict(g, packetOf(s.input), judgeFor(g, 1, passAll(g.candidates).slice(1)));
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons[0]).toMatch(/did not rule on/);
  });

  it("refuses duplicate or contradictory rulings, an unknown question and a malformed ruling", () => {
    const { s, g } = loop();
    const all = passAll(g.candidates);
    const bad: RegradeJudge["unparsedRulings"][] = [
      [...all, { ...all[0]!, verdict: "fail" }],
      [...all, all[0]!],
      [...all, { candidate: { kind: "parser", scope: "run", segment: "never asked" }, verdict: "pass", reason: "x" }],
      [...all.slice(1), { candidate: all[0]!.candidate, verdict: "maybe" as never, reason: "x" }],
    ];
    for (const rulings of bad) expect(() => judgeVerdict(g, packetOf(s.input), judgeFor(g, 1, rulings))).toThrow();
  });

  it("refuses a judge answer bound to other evidence", () => {
    const { s, g } = loop();
    expect(() => judgeVerdict(g, packetOf(s.input), { ...judgeFor(g, 1, passAll(g.candidates)), regradeEvidenceHash: "0".repeat(64) })).toThrow(/different regrade/);
  });

  it("matches a ruling to its question by value, whatever the key order", () => {
    const { s, g } = loop();
    const reordered = g.candidates.map((c) => ({ candidate: JSON.parse(canonical(c)) as Candidate, verdict: "pass" as const, reason: "ok" }));
    expect(judgeVerdict(g, packetOf(s.input), judgeFor(g, 1, reordered)).verdict).toBe("PASS");
  });
});

describe("regrade: revisions on disk", () => {
  /** A stored run 6 with its first revision written. */
  const pending = (): { run: ReturnType<typeof storedRun>; input: RegradeInput; g: Regraded } => {
    const run = storedRun("a7-run6");
    const input = regradeInputFrom(run.record, run.raw);
    const first = runRegrade(run.record, input, null, NOW);
    if (!first.ok) throw new Error(first.reason);
    return { run, input, g: accepted(input) };
  };

  it("completes the pending revision into 002, chained to 001 by hash, and leaves 001 as it was", () => {
    const { run, input, g } = pending();
    try {
      const r1 = readFileSync(join(run.record, "regrade", "001", "regrade.json"), "utf-8");
      const done = runRegrade(run.record, regradeInputFrom(run.record, run.raw), judgeFor(g, 1, passAll(g.candidates)), NOW);
      expect(done.ok && done.run.revision.status).toBe("judged");
      expect(done.ok && done.run.revision.verdict).toBe("PASS");
      expect(done.ok && done.run.revision.parent).toEqual({ revision: 1, regradeJsonSha256: sha256(r1) });
      expect(readFileSync(join(run.record, "regrade", "001", "regrade.json"), "utf-8")).toBe(r1);
      expect(readRevisions(run.record).map((x) => x.revision.status)).toEqual(["pending", "judged"]);
      expect(input.recordBytes.equals(readFileSync(join(run.record, "record.json")))).toBe(true);
    } finally { run.done(); }
  });

  it("refuses a second first regrade, and completion over a judged revision", () => {
    const { run, g } = pending();
    try {
      const again = runRegrade(run.record, regradeInputFrom(run.record, run.raw), null, NOW);
      expect(again.ok ? "" : again.reason).toMatch(/already regraded/);
      runRegrade(run.record, regradeInputFrom(run.record, run.raw), judgeFor(g, 1, passAll(g.candidates)), NOW);
      const over = runRegrade(run.record, regradeInputFrom(run.record, run.raw), judgeFor(g, 2, passAll(g.candidates)), NOW);
      expect(over.ok ? "" : over.reason).toMatch(/is judged, not pending/);
    } finally { run.done(); }
  });

  it("refuses completion when any byte the pending revision read has changed (G2)", () => {
    const { run, g } = pending();
    try {
      writeFileSync(join(run.raw, "turn-02-inspect.stderr.txt"), "late noise\n");
      const r = runRegrade(run.record, regradeInputFrom(run.record, run.raw), judgeFor(g, 1, passAll(g.candidates)), NOW);
      expect(r.ok ? "" : r.reason).toMatch(/has changed since/);
    } finally { run.done(); }
  });

  it("refuses a judge result naming another revision", () => {
    const { run, g } = pending();
    try {
      const r = runRegrade(run.record, regradeInputFrom(run.record, run.raw), judgeFor(g, 2, passAll(g.candidates)), NOW);
      expect(r.ok ? "" : r.reason).toMatch(/names revision 2, the latest is 1/);
    } finally { run.done(); }
  });

  it("refuses a partial pair, a stray entry, a schema-invalid pair and a pair whose files disagree", () => {
    const cases: [string, (dir: string) => void, RegExp][] = [
      ["partial", (d) => rmSync(join(d, "regrade", "001", "record.regraded.json")), /partial revision/],
      ["stray", (d) => mkdirSync(join(d, "regrade", ".tmp-001")), /is not a revision/],
      ["schema", (d) => writeFileSync(join(d, "regrade", "001", "regrade.json"), "{\"revision\": 1}"), /revision schema/],
      ["disagree", (d) => {
        const p = join(d, "regrade", "001", "record.regraded.json");
        const r = JSON.parse(readFileSync(p, "utf-8")) as { regrade: { candidates: unknown[] } };
        r.regrade.candidates = [];
        writeFileSync(p, JSON.stringify(r));
      }, /two files disagree/],
      ["hash", (d) => {
        const p = join(d, "regrade", "001", "regrade.json");
        const r = JSON.parse(readFileSync(p, "utf-8")) as { candidates: unknown[] };
        r.candidates = [];
        writeFileSync(p, JSON.stringify(r));
      }, /disagree|evidence hash/],
    ];
    for (const [name, damage, expected] of cases) {
      const { run } = pending();
      try {
        damage(run.record);
        const r = runRegrade(run.record, regradeInputFrom(run.record, run.raw), null, NOW);
        expect(r.ok ? "" : r.reason, name).toMatch(expected);
      } finally { run.done(); }
    }
  });

  it("writes a failed first regrade as final, and refuses to complete it", () => {
    const s = synth("none", CLEAN, null);
    const dir = mkdtempSync(join(tmpdir(), "regrade-"));
    try {
      writeFileSync(join(dir, "record.json"), s.input.recordBytes);
      const r = runRegrade(dir, s.input, null, NOW);
      expect(r.ok && r.run.revision.status).toBe("fail");
      expect(existsSync(join(dir, "regrade", "001", "regrade.json"))).toBe(true);
      const g = accepted(s.input);
      const again = runRegrade(dir, s.input, judgeFor(g, 1, []), NOW);
      expect(again.ok ? "" : again.reason).toMatch(/is fail, not pending/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("regrade: code round 1", () => {
  const pending = (): { run: ReturnType<typeof storedRun>; g: Regraded } => {
    const run = storedRun("a7-run6");
    const input = regradeInputFrom(run.record, run.raw);
    const first = runRegrade(run.record, input, null, NOW);
    if (!first.ok) throw new Error(first.reason);
    return { run, g: accepted(input) };
  };
  const complete = (run: ReturnType<typeof storedRun>, judge: RegradeJudge) => runRegrade(run.record, regradeInputFrom(run.record, run.raw), judge, NOW);
  const editRevision = (recordDir: string, edit: (rev: Record<string, any>) => void, alsoPair = true): void => {
    const a = join(recordDir, "regrade", "001", "regrade.json");
    const rev = JSON.parse(readFileSync(a, "utf-8")) as Record<string, any>;
    edit(rev);
    writeFileSync(a, JSON.stringify(rev, null, 2));
    if (!alsoPair) return;
    const b = join(recordDir, "regrade", "001", "record.regraded.json");
    const pair = JSON.parse(readFileSync(b, "utf-8")) as Record<string, any>;
    edit(pair.regrade);
    writeFileSync(b, JSON.stringify(pair, null, 2));
  };

  /** A mechanically failed synthetic run with its failed first revision written. */
  const failed = (): { dir: string; input: RegradeInput; g: Regraded } => {
    const s = synth("none", CLEAN, null);
    const dir = mkdtempSync(join(tmpdir(), "regrade-"));
    writeFileSync(join(dir, "record.json"), s.input.recordBytes);
    const r = runRegrade(dir, s.input, null, NOW);
    if (!r.ok || r.run.revision.status !== "fail") throw new Error("expected a failed first revision");
    return { dir, input: s.input, g: accepted(s.input) };
  };

  it("refuses a failed revision relabelled pending in both files, whether or not its verdict and hash are forged too", () => {
    const forgeries: [string, (rev: Record<string, any>) => void][] = [
      ["status only", (rev) => { rev.status = "pending"; }],
      ["status and verdict", (rev) => { rev.status = "pending"; rev.verdict = "PENDING_SEMANTIC"; }],
      ["status, verdict and a recomputed hash", (rev) => {
        rev.status = "pending"; rev.verdict = "PENDING_SEMANTIC";
        rev.regradeEvidenceHash = evidenceHash({
          originalRecordSha256: rev.originalRecordSha256, packetSha256: rev.packetSha256, manifest: rev.manifest, candidates: rev.candidates,
          stopRuleVersion: rev.stopRuleVersion, writeRuleVersion: rev.writeRuleVersion, guarantee: rev.guarantee, status: "pending",
        });
      }],
    ];
    for (const [name, forge] of forgeries) {
      const { dir, input, g } = failed();
      try {
        expect(g.hard.length).toBeGreaterThan(0);
        const rev = JSON.parse(readFileSync(join(dir, "regrade", "001", "regrade.json"), "utf-8")) as Record<string, any>;
        forge(rev);
        editRevision(dir, (x) => { Object.assign(x, { status: rev.status, verdict: rev.verdict, regradeEvidenceHash: rev.regradeEvidenceHash }); });
        // The status is inside the evidence hash: relabelling without re-hashing fails validation itself, not only later checks.
        if (name === "status and verdict") expect(() => readRevisions(dir), name).toThrow(/evidence hash/);
        const r = runRegrade(dir, input, { ...judgeFor(g, 1, passAll(g.candidates)), regradeEvidenceHash: rev.regradeEvidenceHash }, NOW);
        expect(r.ok, name).toBe(false);
        expect(readdirSync(join(dir, "regrade")), name).toEqual(["001"]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it("refuses completion of any replay with a hard failure, on its own, with the hash check out of the way", () => {
    const { dir, g } = failed();
    rmSync(dir, { recursive: true, force: true });
    expect(g.verdict).toBe("FAIL");
    expect(judgeable(g)).toMatch(/has hard failures/);
    expect(judgeable({ verdict: "PENDING_SEMANTIC", hard: ["x"] })).toMatch(/has hard failures \(1\)/);
    expect(judgeable({ verdict: "PENDING_SEMANTIC", hard: [] })).toBeNull();
  });

  it("keeps hard failures in the judge's verdict whatever the rulings say", () => {
    const s = synth("none", [{ text: PACKAGE, commands: [LOOP] }, { text: PACKAGE }, { text: PACKAGE }, { text: "Done." }], null);
    const g = accepted(s.input);
    expect(g.hard.length).toBeGreaterThan(0);
    const v = judgeVerdict(g, packetOf(s.input), judgeFor(g, 1, passAll(g.candidates)));
    expect(v.verdict).toBe("FAIL");
    expect(v.reasons.slice(0, g.hard.length)).toEqual(g.hard);
  });

  it("refuses a revision whose two files disagree on verdict or reasons", () => {
    for (const edit of [(x: Record<string, any>) => { x.verdict = "FAIL"; }, (x: Record<string, any>) => { x.reasons = ["other"]; }]) {
      const { run } = pending();
      try {
        const b = join(run.record, "regrade", "001", "record.regraded.json");
        const pair = JSON.parse(readFileSync(b, "utf-8")) as Record<string, any>;
        edit(pair.regrade);
        writeFileSync(b, JSON.stringify(pair));
        const r = runRegrade(run.record, regradeInputFrom(run.record, run.raw), null, NOW);
        expect(r.ok ? "" : r.reason).toMatch(/two files disagree/);
      } finally { run.done(); }
    }
  });

  it("binds bytes, not their decoding: an invalid byte swapped for another that decodes the same is a change (G2)", () => {
    const run = storedRun("a7-run6");
    try {
      const before = Buffer.from([0x61, 0xff, 0x0a]);
      const after = Buffer.from([0x61, 0xfe, 0x0a]);
      expect(after.toString("utf-8")).toBe(before.toString("utf-8"));
      writeFileSync(join(run.raw, "turn-02-inspect.stderr.txt"), before);
      const first = runRegrade(run.record, regradeInputFrom(run.record, run.raw), null, NOW);
      if (!first.ok) throw new Error(first.reason);
      const g = accepted(regradeInputFrom(run.record, run.raw));
      writeFileSync(join(run.raw, "turn-02-inspect.stderr.txt"), after);
      const r = complete(run, judgeFor(g, 1, passAll(g.candidates)));
      expect(r.ok ? "" : r.reason).toMatch(/has changed since/);
    } finally { run.done(); }
  });

  it("binds the bytes of every fixture project file the packet was built from (G2)", () => {
    const run = storedRun("a7-run6");
    const fixtures = mkdtempSync(join(tmpdir(), "regrade-fixtures-"));
    try {
      cpSync(join(HERE, "..", "fixtures", "onboarding", "mixed-stack"), join(fixtures, "mixed-stack"), { recursive: true });
      const rel = "frontend/src/main.js";
      const file = join(fixtures, "mixed-stack", "project", rel);
      const original = readFileSync(file);
      const before = Buffer.concat([original, Buffer.from([0xff, 0x0a])]);
      const after = Buffer.concat([original, Buffer.from([0xfe, 0x0a])]);
      expect(after.toString("utf-8")).toBe(before.toString("utf-8"));
      writeFileSync(file, before);
      // A run made against this fixture: its packet carries the file as decoded, its record the packet's hash.
      const packetPath = join(run.record, "grading-packet.json");
      const packet = JSON.parse(readFileSync(packetPath, "utf-8")) as { projectFiles: Record<string, string> };
      expect(packet.projectFiles[rel]).toBe(original.toString("utf-8"));
      packet.projectFiles[rel] = before.toString("utf-8");
      const packetText = JSON.stringify(packet, null, 2);
      writeFileSync(packetPath, packetText);
      const recordPath = join(run.record, "record.json");
      const record = JSON.parse(readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
      writeFileSync(recordPath, JSON.stringify({ ...record, packetSha256: sha256(packetText) }, null, 2));
      const first = runRegrade(run.record, regradeInputFrom(run.record, run.raw, fixtures), null, NOW);
      if (!first.ok) throw new Error(first.reason);
      expect(first.run.revision.manifest).toContainEqual({ path: `fixture/project/${rel}`, sha256: sha256(before) });
      const g = accepted(regradeInputFrom(run.record, run.raw, fixtures));
      writeFileSync(file, after);
      const r = runRegrade(run.record, regradeInputFrom(run.record, run.raw, fixtures), judgeFor(g, 1, passAll(g.candidates)), NOW);
      expect(r.ok ? "" : r.reason).toMatch(/has changed since/);
    } finally { run.done(); rmSync(fixtures, { recursive: true, force: true }); }
  });

  it("prints the guarantee and the limitation with a legacy regrade's result", () => {
    const run = storedRun("a7-run6");
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
    const exitCode = process.exitCode;
    try {
      regradeCli(["--regrade", run.record, "--raw", run.raw]);
      expect(process.exitCode).toBe(3);
      const text = out.join("");
      expect(text).toContain(" revision 1 pending PENDING_SEMANTIC\n");
      expect(text).toContain(`  guarantee: ${G1}\n`);
      expect(text).toContain(`  limitation: ${OPAQUE_LIMIT}\n`);
    } finally { spy.mockRestore(); process.exitCode = exitCode; run.done(); }
  });

  it("fails and persists a judged FAIL when one question is ruled fail, the semantic lines passing", () => {
    const { run, g } = pending();
    try {
      const rulings = passAll(g.candidates).map((x, i) => (i === 0 ? { ...x, verdict: "fail" as const, reason: "it really does run elsewhere" } : x));
      const r = complete(run, judgeFor(g, 1, rulings));
      expect(r.ok && r.run.revision.verdict).toBe("FAIL");
      expect(r.ok && r.run.revision.reasons).toEqual([`judged: ${canonical(g.candidates[0]!)}: it really does run elsewhere`]);
      expect(readRevisions(run.record).map((x) => [x.revision.status, x.revision.verdict])).toEqual([["pending", "PENDING_SEMANTIC"], ["judged", "FAIL"]]);
    } finally { run.done(); }
  });

  it("fails and persists a judged FAIL when every question passes and one semantic line fails", () => {
    const { run, g } = pending();
    try {
      const judge = judgeFor(g, 1, passAll(g.candidates));
      const line = g.semanticLines[0]!;
      const r = complete(run, { ...judge, lines: judge.lines.map((l) => (l.line === line ? { ...l, verdict: "fail" as const, reason: "a gap was re-asked" } : l)) });
      expect(r.ok && r.run.revision.verdict).toBe("FAIL");
      expect(r.ok && r.run.revision.reasons).toEqual([`semantic: ${line}: a gap was re-asked`]);
      expect(readRevisions(run.record).at(-1)!.revision.verdict).toBe("FAIL");
    } finally { run.done(); }
  });

  it("fails a passing review-line ruling with no citation or a citation the packet did not offer", () => {
    const { run, g } = pending();
    try {
      expect(g.bound[REVIEW_LINE]).toEqual([9]);
      const judge = judgeFor(g, 1, passAll(g.candidates));
      const cite = (citations: number[] | undefined) => ({ ...judge, lines: judge.lines.map((l) => (l.line === REVIEW_LINE ? { ...l, citations } : l)) });
      const packet = readFileSync(join(run.record, "grading-packet.json"), "utf-8");
      expect(judgeVerdict(g, packet, cite(undefined))).toEqual({ verdict: "FAIL", reasons: [`the judge passed without citing an invocation: ${REVIEW_LINE}`] });
      expect(judgeVerdict(g, packet, cite([4]))).toEqual({ verdict: "FAIL", reasons: [`the judge cited 4, which are not candidates for: ${REVIEW_LINE}`] });
      const r = complete(run, cite([]));
      expect(r.ok && r.run.revision.verdict).toBe("FAIL");
    } finally { run.done(); }
  });
});
