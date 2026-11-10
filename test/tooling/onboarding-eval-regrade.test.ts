/**
 * T-536: regrading a finished onboarding eval from its stored evidence. The replay must be the runner's own
 * computation, every stored field it establishes must agree, and only parser and subshell-recipe questions
 * may leave the hard failures.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeTurn, checkRecipe, codexTurn as codexTurnOf, recipeContract, shellSequence, STOP_RULE_VERSION, type ExpectedRecipe, type JudgeLine, type RuntimeExclusion } from "../../scripts/onboarding-eval-lib.js";
import { parseStream, sha256 } from "../../scripts/continuity-lib.js";
import { CLAUDE_INIT_TOOLS, claudePolicyObject, READBACK_REQUESTS, type ReadbackExpected, type ReadbackStep } from "../../scripts/headless-policy.js";
import { createRequire } from "node:module";
import {
  driveFlow, finishDrive, inspectAfter, inventoryFor, MAX_DISCOVERY_ROUNDS, newDriveState, packetText, setupRecordFrom, writesAfterApprovalOf,
  type DriveState, type Rubric, type StoryReader, type TurnResponse, type Variant,
} from "../../scripts/onboarding-eval-drive.js";
import { diskReader, diskStoryBytes, invocationsText, ownerScript, packageTurns, regradeCli, regradeInputFrom, REVIEW_LINE, runSemanticLines } from "../../scripts/onboarding-eval-run.js";
import { applySetupRunChecks, cs7FinalLedger } from "../../scripts/onboarding-eval-checkset7.js";
import {
  canonical, evidenceHash, G1, judgeable, judgeVerdict, OPAQUE_LIMIT, readRevisions, recipeSubshell, regrade, runRegrade, turnFile,
  type Candidate, type RegradeInput, type RegradeJudge, type Regraded,
} from "../../scripts/onboarding-eval-regrade.js";
import { applySetupReviewChecks, checkSetupReview, cs6TurnsFrom, STORE_COPY, STORE_COPY_MISSING } from "../../scripts/onboarding-eval-checkset6.js";
import { createHash } from "node:crypto";
import { setAfterWriteFault, setupApplySeams } from "../../src/core/setup-apply.js";
import { evidenceFileSeams } from "../../src/core/checkpoint-evidence-files.js";
import { transactionSeams } from "../../src/core/project-loader.js";
import { handleSetupApply } from "../../src/cli/commands/setup-apply.js";
import { collector } from "../../scripts/eval-fault-mcp.js";
import { HOST_CHECKS_RAW, hostChecksText, type TurnHostChecks } from "../../scripts/onboarding-eval-host.js";
import { parseServedLines, POLL_UNANSWERED, SERVED_RAW, type ServedLine } from "../../scripts/onboarding-eval-review.js";
import { UNSERVED_RECORD } from "../../scripts/onboarding-eval-checkset6.js";

/** A served log as the synthetic run reads it; a malformed one grades as none, so the regrade's refusal is what a row sees. */
const servedFrom = (text: string): ServedLine[] => { const p = parseServedLines(text); return "lines" in p ? p.lines : []; };

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

/** T-538 commit 1: a Claude host-v2 run. Each turn's raw is a Claude stream and carries a readback, which `steps` may change. */
interface HostV2 {
  readonly steps?: (turn: number, steps: ReadbackStep[]) => ReadbackStep[];
  /** Changes a turn's init event as the stream reports it. */
  readonly init?: (turn: number, init: Record<string, unknown>) => Record<string, unknown> | null;
  /** T-538 2a: changes a turn's host checks (by default one held server launch, a clean leftover check, no limit). */
  readonly hostTurn?: (turn: number, hc: TurnHostChecks) => TurnHostChecks;
  /** P1: the tool server launch lines the turn adds to the events log, given its own held one (none on a launch failure). */
  readonly turnLaunches?: (turn: number, own: Record<string, unknown>[]) => Record<string, unknown>[];
  /** 2b: the served commands' log as the run wrote it (default: none ran). */
  readonly served?: string;
  /** 2b: changes the review store before the run's checks read it. */
  readonly plantStore?: (store: string) => void;
  /** F1: changes the host-check entries as written (add, drop, reorder). */
  readonly entries?: (hcs: TurnHostChecks[]) => TurnHostChecks[];
  /** F1: launch lines appended to the events log after every turn's own. */
  readonly extraLaunches?: readonly Record<string, unknown>[];
}
/** The pinned inventory's sha256 as the synthetic events log's held launches carry it. */
const HOST_TOOLS_SHA = "e".repeat(64);
const HOST_TOOLS = ["storybloq_status", "storybloq_init", "storybloq_session_guard"];
const CLAUDE_SID = "0f6c2a8e-1b2c-4d3e-8f90-123456789abc";
const goodResponses = (createRequire(import.meta.url)("../fixtures/t538-claude-sentinel.cjs") as { goodResponses: (x: ReadbackExpected) => Record<string, unknown> }).goodResponses;

/** The Claude stream a turn like `t` writes: the init event, each command as a Bash call and its result, the text, the result event. */
function claudeRaw(t: SynthTurn, init: (e: Record<string, unknown>) => Record<string, unknown> | null = (e) => e): string {
  const ev: unknown[] = [init({
    type: "system", subtype: "init", session_id: CLAUDE_SID, permissionMode: "dontAsk", apiKeySource: "none", mcp_servers: [{ name: "storybloq", status: "connected" }],
    tools: [...CLAUDE_INIT_TOOLS, ...HOST_TOOLS.map((x) => `mcp__storybloq__${x}`)],
  })];
  (t.commands ?? []).forEach((c, i) => {
    const { command, output } = typeof c === "string" ? { command: c, output: "" } : c;
    ev.push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: `tu${i}`, name: "Bash", input: { command } }] } });
    ev.push({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: `tu${i}`, content: output, is_error: false }] } });
  });
  ev.push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: t.text }] } });
  if ((t.terminal ?? "completed") === "completed") ev.push({ type: "result", subtype: "success", is_error: false, result: t.text, session_id: CLAUDE_SID, permission_denials: [] });
  if (t.terminal === "failed") ev.push({ type: "result", subtype: "error_during_execution", is_error: true, session_id: CLAUDE_SID, permission_denials: [] });
  return ev.filter((e) => e !== null).map((e) => JSON.stringify(e)).join("\n");
}

/** Check set 7's raw inputs for a synthetic run (T-538 S5a): the events log, the snapshot, and where the project was. */
interface Cs7Raw { readonly events: string; readonly snapshot: string | null; readonly projectRoot: string }

/** A run the runner would have recorded, without spawning a client: the same flow, record fields and packet. */
function synth(variant: Variant, script: readonly SynthTurn[], storyDir: string | null = null, cs6: { readonly store: string } | null = null, cs7: Cs7Raw | null = null, host: HostV2 | null = null): Synth {
  const cs = cs7 !== null ? 7 : cs6 === null ? 1 : 6;
  const rubric = RUBRIC;
  const story: StoryReader | null = storyDir === null ? null : diskReader(storyDir);
  const runId = "synthetic";
  const exclusion = RUN6_RECORD.treeExclusion;
  const afterPackage = packageTurns(variant, SCRIPT);
  const raw = new Map<string, string>();
  const state = newDriveState(cs);
  const replayInputs: { path: string; sha256: string }[] = [];
  const hostTurns: TurnHostChecks[] = [];
  /** The launch lines the turns add to the events log, in order, whatever a test then claims in the host checks. */
  const launchLines: Record<string, unknown>[] = [];
  // A host-v2 run's base events log: its tool server launches are held with the pinned inventory, and the first turn added them.
  const baseLaunches: string[] = [];
  const baseEvents = host === null || cs7 === null ? cs7?.events ?? "" : cs7.events.split("\n").map((l) => {
    if (l === "") return l;
    const x = JSON.parse(l) as Record<string, unknown>;
    if (x.seq !== undefined || x.entry !== "mcp") return l;
    baseLaunches.push(x.attempt as string);
    return JSON.stringify({ ...x, sandbox: "held", tools: HOST_TOOLS_SHA });
  }).join("\n");
  const projectRoot = cs7?.projectRoot ?? "/w/project";
  const roots = [projectRoot, join(projectRoot, ".git"), "/w/tmp", "/w/storybloq-global", "/w/eval-events"];
  const launch = { project: projectRoot, roots, policy: claudePolicyObject(roots, HOST_TOOLS), mcpLaunch: { command: "/usr/bin/node", args: ["/pkg/eval-mcp.js"] }, toolSets: {} as Record<string, string[]> };
  const flow = driveFlow({ variant, firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage, exclusion }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const t = script[n];
    if (!t) throw new Error(`the script has no turn ${n} (${step.value.label})`);
    const file = turnFile(n, step.value.label);
    const launchFailed = host !== null && (t.infra ?? "").startsWith("launch: ");
    const turnNo = n;
    if (host !== null) {
      const own: Record<string, unknown>[] = launchFailed ? [] : [{ attempt: `srv-${n}`, pid: 9000 + n, entry: "mcp", sandbox: "held", tools: HOST_TOOLS_SHA }];
      const added = host.turnLaunches ? host.turnLaunches(n, own) : own;
      launchLines.push(...added);
      const ids = [...(n === 0 ? baseLaunches : []), ...added.map((l) => l.attempt as string)];
      const held = new Set([...baseLaunches, ...added.filter((l) => l.sandbox === "held" && l.tools === HOST_TOOLS_SHA).map((l) => l.attempt as string)]);
      const hc: TurnHostChecks = { file, launches: ids, servers: ids.filter((id) => held.has(id)), leftover: { status: "clean", reason: null }, limit: null, review: null };
      hostTurns.push(host.hostTurn ? host.hostTurn(turnNo, hc) : hc);
    }
    const text = host === null ? codexRaw(t) : launchFailed ? "" : claudeRaw(t, (e) => (host.init ? host.init(turnNo, e) : e));
    raw.set(`${file}.jsonl`, text).set(`${file}.stderr.txt`, "");
    const parsed = host === null ? regradeTurn(text, cs) : { ...claudeTurn(parseStream(text).events, cs), models: [] as string[] };
    if (host !== null) {
      const answers = goodResponses({ ...launch, mcpTools: HOST_TOOLS });
      const good: ReadbackStep[] = READBACK_REQUESTS.map((subtype, i) => ({ requestId: `r${i + 1}`, subtype, outcome: "success", response: answers[subtype] }));
      // The runner records the raw result's permission denials, and none when the stream has no result event.
      const result = parseStream(text).events.find((e) => e.type === "result") as { permission_denials?: unknown } | undefined;
      const rb = `${JSON.stringify({ steps: host.steps ? host.steps(n, good) : good, permissionDenials: result?.permission_denials ?? null }, null, 2)}\n`;
      raw.set(`${file}.readback.json`, rb);
      replayInputs.push({ path: `${file}.readback.json`, sha256: sha256(rb) });
      launch.toolSets[`${file}.readback.json`] = HOST_TOOLS;
    }
    const infra = t.infra !== undefined ? t.infra : parsed.terminal.status !== "completed" ? `terminal ${parsed.terminal.status}: ${parsed.terminal.detail}` : null;
    const response: TurnResponse = { turn: parsed, exitCode: infra?.startsWith("exit ") ? Number(infra.slice(5)) : 0, infraFailure: infra, stderrPath: `/raw/${runId}/${file}.stderr.txt`, treeChanges: () => [...(t.tree ?? [])] };
    n++;
    step = flow.next(response);
  }
  if (n !== script.length) throw new Error(`the flow ended after ${n} of ${script.length} scripted turns`);
  const servedText = host?.served ?? "";
  if (cs6 !== null) host?.plantStore?.(cs6.store);
  if (cs6 !== null) applySetupReviewChecks(state, cs6.store, variant, host === null ? null : servedFrom(servedText));
  const approval = afterPackage.find((x) => x.label === "approve")?.prompt ?? "";
  if (cs7 !== null) {
    // A host-v2 run's events log also holds each turn's sandboxed server launch (T-538 2a, plan 5.2).
    const launches = [...launchLines, ...(host?.extraLaunches ?? [])].map((l) => `${JSON.stringify(l)}\n`).join("");
    const eventsText = host === null ? cs7.events : `${baseEvents}${baseEvents.endsWith("\n") ? "" : "\n"}${launches}`;
    const r = applySetupRunChecks(state, {
      eventsText, snapshotText: cs7.snapshot, final: cs7FinalLedger(story ?? NO_STORY), baselineIds: [], baselinePhases: [], approval,
      projectRoot: cs7.projectRoot, contract: recipeContract(rubric.expectedRecipe), observations: null, followUp: null,
    });
    const files: [string, string | null][] = [["events.jsonl", eventsText], ["invocations.json", invocationsText(cs7.projectRoot, r.invocations)], ["setup-snapshot.json", cs7.snapshot],
      ...(host !== null ? [[HOST_CHECKS_RAW, hostChecksText(host.entries ? host.entries(hostTurns) : hostTurns, HOST_TOOLS_SHA)] as [string, string], [SERVED_RAW, servedText] as [string, string]] : [])];
    for (const [name, text] of files) {
      if (text === null) continue;
      raw.set(name, text);
      replayInputs.push({ path: name, sha256: sha256(text) });
    }
  }
  const evidence = finishDrive(state, REVIEW_LINE);
  const adjusted = afterPackage.some((x) => x.label === "adjust");
  const semanticLines = runSemanticLines(state.reviewSkipped, state.turns, exclusion, adjusted, cs, evidence.reviewLines, evidence.judgeLines ?? []);
  const reader = story ?? NO_STORY;
  const { inspection, ledgerRecords } = inspectAfter(state, reader, rubric, () => ({}), variant);
  const text = packetText({
    runId, semanticLines, reviewSkipped: state.reviewSkipped, exclusion, rubric: rubric, briefs: {}, projectFiles: {}, turns: state.turns, evidence, ledgerRecords,
    setupRecord: story ? setupRecordFrom(story) : "", final: state.final, ...(cs6 !== null ? { checkSet: cs } : {}),
  });
  const record = JSON.parse(JSON.stringify({
    runId, client: host === null ? "codex" : "claude", ...(host !== null ? { route: "host-v2", claudeLaunch: launch } : {}), fixture: "mixed-stack", variant, turns: state.turns, discoveryRounds: state.rounds, reviewSkipped: state.reviewSkipped,
    reviewEvidence: evidence.reviewEvidence, writesAfterApproval: writesAfterApprovalOf(state), unparsed: evidence.unparsed, inspection, failures: state.failures,
    infraFailed: state.infraFailed, treeExclusion: exclusion, semanticLines, bound: evidence.bound, packetSha256: sha256(text), verdict: "FAIL",
    ...(cs6 !== null ? {
      checkSetVersion: cs, ...(evidence.reviewerCapability !== undefined ? { reviewerCapability: evidence.reviewerCapability } : {}),
      reviewerInventory: inventoryFor(variant), skillCitations: evidence.skillCitations ?? [], instructionContext: { status: "unknown" },
    } : {}),
    ...(cs7 !== null || host !== null ? { replayInputs } : {}),
  })) as Record<string, any>;
  const input: RegradeInput = {
    recordBytes: Buffer.from(JSON.stringify(record, null, 2)), packetBytes: Buffer.from(text), rawNames: [...raw.keys(), "project.after", ...(cs6 !== null ? [STORE_COPY] : [])],
    readRaw: (name) => { const t = raw.get(name); if (t === undefined) throw new Error(`no raw ${name}`); return Buffer.from(t); },
    story: storyDir === null ? null : diskStoryBytes(storyDir),
    ...(cs6 !== null ? { setupReviewStore: cs6.store } : {}),
    fixture: {
      firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage, rubric: rubric, beforeConfig: () => ({}), briefs: {}, projectFiles: {}, files: [], checkSet: cs,
      ...(cs7 !== null ? { baseline: { baselineIds: [], baselinePhases: [] }, approval } : {}),
    },
    reviewLine: REVIEW_LINE, semanticLines: runSemanticLines,
  };
  return { input, state, record, packet: JSON.parse(text) as Record<string, any> };
}

/** The codex turn parser the regrade uses, with the runner's (empty) rollout models. */
function regradeTurn(text: string, cs = 1) {
  const lines = text.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { ...codexTurnOf(lines, cs), models: [] as string[] };
}

/** A clean run: reviewed before the package, then inspect, adjust and approve, on run 6's approved ledger. */
const CLEAN: SynthTurn[] = [
  { text: PACKAGE, commands: [REVIEW] }, { text: PACKAGE }, { text: PACKAGE }, { text: "Setup is approved and written." },
];

describe("regrade: check set 6 reads the run's copy of its setup review store (T-536)", () => {
  const SETUP = "SS-0a1b2c3d";
  const PROBE = "Reviewer probe: codex codex-cli 9.9.9";
  const sha = (x: string): string => createHash("sha256").update(x).digest("hex");
  const packet = "## Context\nA club board.\n\n## Plan\nT-001 Board\nT-002 Members\n";
  const lines = `${PROBE}\nIndependent review: approve, invocation SR-11112222, revision ${sha(packet).slice(0, 12)}`;
  const shown = `Here is the package.\n\nPlan, revision ${sha(packet).slice(0, 12)}:\nT-001 Board\nT-002 Members\nEnd of plan, revision ${sha(packet).slice(0, 12)}\n\n${lines}\n- Approve setup\n- Adjust the plan\n- Inspect details`;
  const heredoc = (verb: string): string => `storybloq setup-review ${verb} --setup ${SETUP} <<'STORYBLOQ_PACKET'\n${packet}STORYBLOQ_PACKET`;
  const SCRIPT6: SynthTurn[] = [
    { text: shown, commands: [{ command: "storybloq setup-review gate", output: `Setup id: ${SETUP}\n${PROBE}\n` }, { command: heredoc("run"), output: `${lines}\n` }, { command: heredoc("status"), output: `${lines}\n` }] },
    { text: shown }, { text: shown }, { text: "Setup is approved and written." },
  ];
  function withStore<T>(f: (store: string, revision: string) => T): T {
    const store = mkdtempSync(join(tmpdir(), "regrade6-"));
    try {
      const dir = join(store, "0123456789abcdef", SETUP, "revisions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sha(packet)}.md`), packet);
      return f(store, join(dir, `${sha(packet)}.md`));
    } finally { rmSync(store, { recursive: true, force: true }); }
  }

  it("a check set 6 run regrades from the copy, rule 2 included, and pins the copy's files", () => {
    withStore((store) => {
      const s = synth("none", SCRIPT6, RUN6_STORY, { store });
      const turns = cs6TurnsFrom(s.state.turns, s.state.allCalls);
      // Rule 2 passes on this package only because the copy holds its revision.
      expect(checkSetupReview(turns, { storeRoot: store, unavailableArm: false }).failures.filter((f) => /revision|Plan/.test(f))).toEqual([]);
      const g = accepted(s.input);
      expect(g.checkSet).toBe(6);
      expect(g.manifest.map((m) => m.path)).toContain(`${STORE_COPY}/0123456789abcdef/${SETUP}/revisions/${sha(packet)}.md`);
    });
  });

  it("a check set 6 run whose copy is gone is refused by name", () => {
    withStore((store) => {
      const s = synth("none", SCRIPT6, RUN6_STORY, { store });
      const r = regrade({ ...s.input, setupReviewStore: null, rawNames: s.input.rawNames.filter((x) => x !== STORE_COPY) });
      expect(r.ok ? "accepted" : r.reason).toBe(STORE_COPY_MISSING);
      expect(STORE_COPY_MISSING).toBe("the run's setup review store copy (setup-review-store) is missing");
    });
  });

  it("a copy that lost the revision the run read replays different failures and is refused", () => {
    withStore((store, revision) => {
      const s = synth("none", SCRIPT6, RUN6_STORY, { store });
      rmSync(revision);
      const r = regrade(s.input);
      expect(r.ok ? "accepted" : r.reason).toBe("the record's failures differ from the replayed run's (a failure was added, removed, reordered or changed)");
    });
  });
});

describe("regrade: check set 7 reads its replay inputs (T-538 S5a)", () => {
  const SID = "SS-0123abcd";
  let scratch: string;
  let n = 0;
  beforeAll(() => { scratch = realpathSync(mkdtempSync(join(tmpdir(), "regrade7-"))); });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
  const seamDefaults = { evidence: evidenceFileSeams.afterCreate, afterTemp: transactionSeams.afterTemp, afterCommitEntry: transactionSeams.afterCommitEntry };
  afterEach(() => {
    setupApplySeams.fault = () => {};
    evidenceFileSeams.afterCreate = seamDefaults.evidence;
    transactionSeams.afterTemp = seamDefaults.afterTemp;
    transactionSeams.afterCommitEntry = seamDefaults.afterCommitEntry;
  });
  it("a test installs the collector", () => {
    setAfterWriteFault(() => {});
    expect(transactionSeams.afterTemp).not.toBe(seamDefaults.afterTemp);
  });
  it("the next test sees the default on every seam it installed", () => {
    expect(evidenceFileSeams.afterCreate).toBe(seamDefaults.evidence);
    expect(transactionSeams.afterTemp).toBe(seamDefaults.afterTemp);
    expect(transactionSeams.afterCommitEntry).toBe(seamDefaults.afterCommitEntry);
  });

  const payload = {
    version: 1, setupId: SID, review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved"] }, ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: { level: "full", verifyApplies: false, components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: null, verify: null }] },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] },
    git: { init: false, gitignore: [] },
    phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" }],
    tickets: [{ key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] }],
    checkpoints: [], issues: [], coverage: [],
  };
  const heredoc = `storybloq setup-apply <<'STORYBLOQ_SETUP'\n${JSON.stringify(payload)}\nSTORYBLOQ_SETUP`;
  const resume = `storybloq setup-apply --resume --setup ${SID}`;
  class Killed extends Error {}
  /** The package with its plan marked, so rule 3 sees the plan the approval approves. */
  const PACKAGE7 = "Here is the package.\nPlan, revision 0123456789ab:\nTicket: Sign in\nEnd of plan, revision 0123456789ab\n- Approve setup\n- Adjust the plan\n- Inspect details";

  /** The log as a SIGKILL at `point` leaves it: nothing of that attempt after the point's line. */
  function cutAfter(text: string, point: string): string {
    const lines = text.split("\n").filter(Boolean);
    const at = lines.findIndex((l) => (JSON.parse(l) as { point?: string }).point === point);
    const attempt = (JSON.parse(lines[at]!) as { attempt: string }).attempt;
    return `${lines.filter((l, i) => i <= at || (JSON.parse(l) as { attempt: string }).attempt !== attempt).join("\n")}\n`;
  }

  /**
   * G11: the setup is killed at archive-committed, and the approve turn resumes it. The engine runs in this
   * process under the evaluation collector, so the events log and snapshot are ones it wrote.
   */
  async function g11(): Promise<{ readonly s: Synth; readonly events: string; readonly snapshot: string }> {
    const r = await killed("archive-committed", true);
    return { s: r.s, events: r.events, snapshot: r.snapshot! };
  }

  /** A setup killed at `point`; `resumed` says the approve turn resumes it in the approve turn, else the run ends with the setup unfinished. */
  async function killed(point: string, resumes: boolean, host: HostV2 | null = null, only: readonly SynthTurn[] | null = null): Promise<{ readonly s: Synth; readonly events: string; readonly snapshot: string | null; readonly root: string; readonly store: string }> {
    const root = join(scratch, `p${n++}`);
    mkdirSync(root);
    const store = join(scratch, `store${n}`);
    mkdirSync(store);
    const eventsPath = join(scratch, `${n}-events.jsonl`);
    const env = { PATH: process.env.PATH ?? "", HOME: scratch, STORYBLOQ_SETUP_REVIEW_DIR: join(scratch, "review-store") };
    setAfterWriteFault(collector(eventsPath, point, "cli", () => { throw new Killed("killed"); }));
    await handleSetupApply({ cwd: root, env, stdin: () => Buffer.from(JSON.stringify(payload)) }, {});
    writeFileSync(eventsPath, cutAfter(readFileSync(eventsPath, "utf-8"), point));
    let last: SynthTurn = { text: "The setup was interrupted.", commands: [{ command: heredoc, output: "" }] };
    if (resumes) {
      setAfterWriteFault(collector(eventsPath, null, "cli", () => { throw new Killed("killed"); }));
      const resumed = (await handleSetupApply({ cwd: root, env, stdin: () => Buffer.from("") }, { resume: true, setup: SID })).stdout;
      expect(resumed).toContain(`Setup applied: ${SID}`);
      last = { text: resumed, commands: [{ command: heredoc, output: "" }, { command: resume, output: resumed }] };
    }
    const events = readFileSync(eventsPath, "utf-8");
    const snapshotPath = `${eventsPath}.setup-snapshot.json`;
    const snapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf-8") : null;
    const script: readonly SynthTurn[] = only ?? [{ text: PACKAGE7 }, { text: PACKAGE7 }, { text: PACKAGE7 }, last];
    return { s: synth("none", script, join(root, ".story"), { store }, { events, snapshot, projectRoot: root }, host), events, snapshot, root, store };
  }

  /** The input with raw `name` replaced by `text`; `pin` also records the new bytes' sha256, so only the content is wrong. */
  function withRaw(input: RegradeInput, name: string, text: string, pin = false): RegradeInput {
    const base = pin ? withRecord(input, (r) => { r.replayInputs = r.replayInputs.map((e: { path: string; sha256: string }) => (e.path === name ? { path: name, sha256: sha256(text) } : e)); }) : input;
    return { ...base, readRaw: (x) => (x === name ? Buffer.from(text) : input.readRaw(x)) };
  }
  const without = (input: RegradeInput, name: string): RegradeInput => ({ ...input, rawNames: input.rawNames.filter((x) => x !== name) });

  it("G11: a kill at archive-committed resumed in the approve turn regrades accepted, with no check set 7 failure", async () => {
    const { s } = await g11();
    expect(s.state.failures.filter((_, i) => s.state.sources[i]?.kind === "setup")).toEqual([]);
    const g = accepted(s.input);
    expect(g.checkSet).toBe(7);
    expect(g.manifest.map((m) => m.path)).toEqual(expect.arrayContaining(["events.jsonl", "invocations.json", "setup-snapshot.json"]));
    expect(g.manifest.some((m) => m.path.startsWith("project.after/.story#cs7:"))).toBe(true);
  });

  it("refuses an events log that is missing, tampered, empty, cut before its attempt line, or archived without its commit", async () => {
    const { s, events } = await g11();
    expect(refused(without(s.input, "events.jsonl"))).toBe("replay input events.jsonl is missing");
    expect(refused(withRaw(s.input, "events.jsonl", events.replace(SID, "SS-ffffffff")))).toBe("replay input events.jsonl does not match its recorded sha256");
    expect(refused(withRaw(s.input, "events.jsonl", "", true))).toMatch(/^replay input events\.jsonl is malformed or incomplete: /);
    expect(refused(withRaw(s.input, "events.jsonl", `${events.split("\n").slice(1).join("\n")}`, true))).toMatch(/^replay input events\.jsonl is malformed or incomplete: /);
    // The commit lines deleted with no step:archive left: completion evidence is gone while the snapshot is still pinned.
    const archiveless = `${events.split("\n").filter((l) => l !== "" && !l.includes('"point":"archive-committed"')).join("\n")}\n`;
    expect(refused(withRaw(s.input, "events.jsonl", archiveless, true))).toBe("replay input events.jsonl is incomplete: the record pins setup-snapshot.json but the log has no archive-committed");
    // The kill left no step:archive, so the archive's commit line is turned into one: a step:archive with no commit.
    const uncommitted = events.replace('"point":"archive-committed"', '"point":"step:archive"');
    expect(refused(withRaw(s.input, "events.jsonl", uncommitted, true))).toBe("replay input events.jsonl is incomplete: step:archive with no archive-committed");
  });

  it("refuses a snapshot that is missing, tampered, or not the one archive-committed names", async () => {
    const { s, snapshot } = await g11();
    expect(refused(without(s.input, "setup-snapshot.json"))).toBe("replay input setup-snapshot.json is missing");
    const other = snapshot.replace("Sign in", "Signed in");
    expect(refused(withRaw(s.input, "setup-snapshot.json", other))).toBe("replay input setup-snapshot.json does not match its recorded sha256");
    expect(refused(withRaw(s.input, "setup-snapshot.json", other, true))).toBe("replay input setup-snapshot.json is not the snapshot archive-committed names");
  });

  it("a log with archive-committed and no pinned snapshot is refused by name", async () => {
    const { s } = await g11();
    const unpinned = withRecord(s.input, (r) => { r.replayInputs = r.replayInputs.filter((e: { path: string }) => e.path !== "setup-snapshot.json"); });
    expect(refused(without(unpinned, "setup-snapshot.json"))).toBe("replay input setup-snapshot.json is missing");
  });

  it("a setup killed before its archive and never resumed regrades accepted, judged incomplete by name", async () => {
    const { s, snapshot } = await killed("step:handover", false);
    expect(snapshot).toBeNull();
    expect(s.state.failures).toContain("setup incomplete: no archive-committed event");
    const g = accepted(s.input);
    expect(g.checkSet).toBe(7);
    expect(g.manifest.map((m) => m.path)).not.toContain("setup-snapshot.json");
  });

  it("refuses an invocation mapping that is missing, tampered, malformed, or not the replayed run's", async () => {
    const { s } = await g11();
    const stored = s.input.readRaw("invocations.json").toString("utf-8");
    expect(refused(without(s.input, "invocations.json"))).toBe("replay input invocations.json is missing");
    expect(refused(withRaw(s.input, "invocations.json", `${stored} `))).toBe("replay input invocations.json does not match its recorded sha256");
    expect(refused(withRaw(s.input, "invocations.json", "{", true))).toBe("replay input invocations.json is malformed");
    expect(refused(withRaw(s.input, "invocations.json", "{}", true))).toBe("replay input invocations.json is malformed");
    expect(refused(withRaw(s.input, "invocations.json", "null", true))).toBe("replay input invocations.json is malformed");
    expect(refused(withRaw(s.input, "invocations.json", "[]", true))).toBe("replay input invocations.json is malformed");
    const differs = JSON.stringify({ ...(JSON.parse(stored) as object), mapping: [] }, null, 2) + "\n";
    expect(refused(withRaw(s.input, "invocations.json", differs, true))).toBe("invocations.json differs from the mapping the replayed run produces");
  });

  it("refuses a record with no replay inputs, an input it does not name, or one check set 7 does not read", async () => {
    const { s } = await g11();
    expect(refused(withRecord(s.input, (r) => { delete r.replayInputs; }))).toBe("the check set 7 record names no replay inputs");
    expect(refused(withRecord(s.input, (r) => { r.replayInputs = r.replayInputs.filter((e: { path: string }) => e.path !== "setup-snapshot.json"); }))).toBe("replay input setup-snapshot.json is not named in the record's replay inputs");
    const extra = { ...withRecord(s.input, (r) => { r.replayInputs.push({ path: "notes.txt", sha256: sha256("x") }); }), rawNames: [...s.input.rawNames, "notes.txt"] };
    expect(refused({ ...extra, readRaw: (x) => (x === "notes.txt" ? Buffer.from("x") : s.input.readRaw(x)) })).toBe("the record names replay input notes.txt, which check set 7 does not read");
  });

  it("refuses fixture inputs read without the baseline ledger and approval", async () => {
    const { s } = await g11();
    const { baseline: _b, approval: _a, ...fixture } = s.input.fixture as typeof s.input.fixture & { baseline?: unknown; approval?: unknown };
    expect(refused({ ...s.input, fixture })).toBe("check set 7 needs the fixture's baseline ledger and approval");
  });

  // --- T-538 commit 1 (plan 6.4): a host-v2 Claude record replays its readbacks -------------------------
  const unlocked = (steps: ReadbackStep[]): ReadbackStep[] => steps.map((x) => (x.subtype === "get_sandbox_dialog" ? { ...x, response: { ...(x.response as object), locked: false } } : x));
  const readbackName = (s: Synth): string => s.input.rawNames.find((x) => x.endsWith(".readback.json"))!;

  it("host-v2: a clean Claude run regrades accepted, every turn's readback a replay input", async () => {
    const { s } = await killed("archive-committed", true, {});
    expect(s.record.client).toBe("claude");
    const g = accepted(s.input);
    const names = s.input.rawNames.filter((x) => x.endsWith(".readback.json"));
    expect(names.length).toBe(s.record.turns.length);
    expect(g.manifest.map((m) => m.path)).toEqual(expect.arrayContaining(names));
  });

  it("host-v2: a missing readback is refused by name", async () => {
    const { s } = await killed("archive-committed", true, {});
    expect(refused(without(s.input, readbackName(s)))).toBe(`replay input ${readbackName(s)} is missing`);
  });

  it("host-v2: an edited readback is refused, on its bytes and, re-pinned, on the replayed comparison", async () => {
    const { s } = await killed("archive-committed", true, {});
    const name = readbackName(s);
    const edited = s.input.readRaw(name).toString("utf-8").replace('"locked": true', '"locked": false');
    expect(edited).not.toBe(s.input.readRaw(name).toString("utf-8"));
    expect(refused(withRaw(s.input, name, edited))).toBe(`replay input ${name} does not match its recorded sha256`);
    expect(refused(withRaw(s.input, name, edited, true))).toMatch(/the replayed readback finds "launch: get_sandbox_dialog\.locked", but the record states no infrastructure failure/);
  });

  it("host-v2: a recorded launch failure replays as the same field, and another field is refused", async () => {
    const { s } = await killed("archive-committed", false, { steps: (_n, steps) => unlocked(steps) }, [{ text: "", terminal: "missing", infra: "launch: get_sandbox_dialog.locked" }]);
    expect(accepted(s.input).checkSet).toBe(7);
    const other = withRecord(s.input, (r) => { r.turns[0].infraFailure = "launch: get_sandbox_dialog.enabled"; });
    expect(refused(other)).toMatch(/the recorded launch failure "launch: get_sandbox_dialog\.enabled" is not the replayed readback's "launch: get_sandbox_dialog\.locked"/);
  });

  it("host-v2: a malformed stored step or an empty recorded policy is refused by name, never thrown (F3)", async () => {
    const { s } = await killed("archive-committed", true, { steps: (n, steps) => (n === 0 ? [null as unknown as ReadbackStep] : steps) });
    let r: ReturnType<typeof regrade> | null = null;
    expect(() => { r = regrade(s.input); }).not.toThrow();
    expect(r!.ok).toBe(false);
    expect((r as unknown as { reason: string }).reason).toMatch(/the replayed readback finds "launch: readback\.steps\[0\] is malformed", but the record states no infrastructure failure/);
    const { s: clean } = await killed("archive-committed", true, {});
    const empty = withRecord(clean.input, (rec) => { rec.claudeLaunch.policy = {}; });
    let e: ReturnType<typeof regrade> | null = null;
    expect(() => { e = regrade(empty); }).not.toThrow();
    expect(e!.ok).toBe(false);
    expect((e as unknown as { reason: string }).reason).toMatch(/launch: readback\.expected\.policy\.permissions is malformed/);
  });

  it("host-v2: a turn with no result event replays to its terminal check, and its init event is still checked (F7, F2)", async () => {
    const missing = [{ text: "", terminal: "missing" as const }];
    const { s } = await killed("archive-committed", false, {}, missing);
    const infra = s.record.turns[0].infraFailure as string;
    expect(infra).toMatch(/^terminal missing: /);
    expect(accepted(s.input).checkSet).toBe(7);
    const { s: bad } = await killed("archive-committed", false, { init: (_n, e) => ({ ...e, permissionMode: "bypassPermissions" }) }, missing);
    expect(bad.record.turns[0].infraFailure).toBe(infra);
    expect(refused(bad.input)).toMatch(/the replayed readback finds "launch: init\.permissionMode", but the record states "terminal missing: /);
  });

  const badInit = { init: (_n: number, e: Record<string, unknown>) => ({ ...e, permissionMode: "bypassPermissions" }) };
  it("host-v2: an input failure with exit 0 and no init event in the raw is accepted (G1)", async () => {
    const { s } = await killed("archive-committed", false, { init: () => null }, [{ text: "", infra: "input: EPIPE" }]);
    expect(s.record.turns[0].exitCode).toBe(0);
    expect(s.input.readRaw(s.input.rawNames.find((x) => x.endsWith(".jsonl") && x.startsWith("turn-"))!).toString("utf-8")).not.toContain('"subtype":"init"');
    expect(accepted(s.input).checkSet).toBe(7);
  });

  it("host-v2: an input failure is accepted with a wrong init event too, since init is not consulted for it (G1)", async () => {
    const { s } = await killed("archive-committed", false, badInit, [{ text: "", infra: "input: EPIPE" }]);
    expect(accepted(s.input).checkSet).toBe(7);
  });

  it("host-v2: the same wrong init event recorded under a cleanup failure is refused (G1)", async () => {
    const { s } = await killed("archive-committed", false, badInit, [{ text: "", infra: "cleanup: unconfirmed" }]);
    expect(refused(s.input)).toMatch(/the replayed readback finds "launch: init\.permissionMode", but the record states "cleanup: unconfirmed"/);
  });

  it.each(["input: write after endInput", "cleanup: unconfirmed: process group 4242 still present 2000 ms after the last signal"])("host-v2: the group's own failure %s replays on host-v2 and is refused off it (F5)", async (infra) => {
    const { s } = await killed("archive-committed", false, {}, [{ text: "", infra }]);
    expect(s.record.turns[0].infraFailure).toBe(infra);
    expect(accepted(s.input).checkSet).toBe(7);
    const { s: codex } = await killed("archive-committed", false, null, [{ text: "", infra }]);
    expect(refused(codex.input)).toContain(`unrecognised infrastructure failure "${infra}"`);
  });

  // --- T-538 commit 2a (plan 5.1, 5.2): each turn's host checks are a replay input --------------------------
  const one = (n: number, change: (hc: TurnHostChecks) => TurnHostChecks) => ({ hostTurn: (t: number, hc: TurnHostChecks) => (t === n ? change(hc) : hc) });

  it("host-v2 2a: the host checks are a replay input; missing or edited, the record is refused", async () => {
    const { s } = await killed("archive-committed", true, {});
    expect(accepted(s.input).manifest.map((m) => m.path)).toContain(HOST_CHECKS_RAW);
    expect(refused(without(s.input, HOST_CHECKS_RAW))).toBe(`replay input ${HOST_CHECKS_RAW} is missing`);
    const edited = s.input.readRaw(HOST_CHECKS_RAW).toString("utf-8").replace('"srv-0"', '"srv-1"');
    expect(refused(withRaw(s.input, HOST_CHECKS_RAW, edited))).toBe(`replay input ${HOST_CHECKS_RAW} does not match its recorded sha256`);
    expect(refused(withRaw(s.input, HOST_CHECKS_RAW, "{", true))).toBe(`replay input ${HOST_CHECKS_RAW} is malformed`);
  });

  it("host-v2 2a: a server launch the events log does not hold as sandboxed with the pinned inventory is refused", async () => {
    const { s } = await killed("archive-committed", true, one(1, (hc) => ({ ...hc, servers: ["srv-elsewhere"] })));
    expect(refused(s.input)).toMatch(/turn turn-02-inspect names server launch srv-elsewhere, which the events log does not hold as a sandboxed launch with the pinned inventory/);
  });

  it("host-v2 2a: a turn with no sandboxed server but a clean record is refused", async () => {
    const { s } = await killed("archive-committed", true, { turnLaunches: (t, own) => (t === 1 ? [] : own) });
    expect(refused(s.input)).toMatch(/"launch: no sandboxed storybloq server", but the record states no infrastructure failure/);
    const { s: claimed } = await killed("archive-committed", true, one(0, (hc) => ({ ...hc, servers: [] })));
    expect(refused(claimed.input)).toMatch(/^replay input host-checks\.json: turn turn-01-\S+ leaves out held server launches it names as launched$/);
  });

  // --- P1: every tool server launch a turn added must be held with the pinned inventory --------------------
  const keyless = (id: string) => ({ attempt: id, pid: 7001, entry: "mcp" });
  const absent = (id: string) => ({ attempt: id, pid: 7002, entry: "mcp", sandbox: "absent", tools: HOST_TOOLS_SHA });
  const otherSha = (id: string) => ({ attempt: id, pid: 7003, entry: "mcp", sandbox: "held", tools: "d".repeat(64) });
  for (const [what, line] of [["a launch with no probe and no inventory", keyless], ["a launch whose probe found the outside writable", absent], ["a launch with another inventory", otherSha]] as const) {
    it(`host-v2 P1: one held launch plus ${what} is the launch failure naming it, and a clean record is refused`, async () => {
      const extra = { turnLaunches: (t: number, own: Record<string, unknown>[]) => (t === 1 ? [...own, line("srv-x")] : own) };
      const { s } = await killed("archive-committed", true, extra);
      expect(refused(s.input)).toMatch(/"launch: unsandboxed storybloq server launch srv-x", but the record states no infrastructure failure/);
      const { s: kept } = await killed("archive-committed", false, { turnLaunches: (t: number, own: Record<string, unknown>[]) => (t === 0 ? [...own, line("srv-x")] : own) },
        [{ text: "", infra: "launch: unsandboxed storybloq server launch srv-x" }]);
      expect(accepted(kept.input).checkSet).toBe(7);
    });
  }

  it("host-v2 P1: the turns must name every server launch in the events log, each once and in log order", async () => {
    const extra = { turnLaunches: (t: number, own: Record<string, unknown>[]) => (t === 1 ? [...own, keyless("srv-x")] : own) };
    const { s } = await killed("archive-committed", true, { ...extra, ...one(1, (hc) => ({ ...hc, launches: hc.launches.filter((id) => id !== "srv-x") })) });
    expect(refused(s.input)).toBe(`replay input ${HOST_CHECKS_RAW}: the turns do not name the events log's server launches, each once and in log order`);
    const { s: unknown } = await killed("archive-committed", true, one(1, (hc) => ({ ...hc, launches: [...hc.launches, "srv-nowhere"] })));
    expect(refused(unknown.input)).toMatch(/turn turn-02-inspect names server launch srv-nowhere, which the events log does not hold$/);
  });

  // --- F1: the host checks are exactly the record's turns, in order ---------------------------------------------
  const F1_REFUSAL = `replay input ${HOST_CHECKS_RAW}: the host checks do not name the record's turns, each once and in turn order`;
  it("host-v2 F1: an extra entry no recorded turn has, carrying an unheld launch, is refused", async () => {
    const extra: TurnHostChecks = { file: "turn-99-extra", launches: ["srv-x"], servers: [], leftover: { status: "clean", reason: null }, limit: null, review: null };
    const { s } = await killed("archive-committed", true, { extraLaunches: [keyless("srv-x")], entries: (hcs) => [...hcs, extra] });
    expect(refused(s.input)).toBe(F1_REFUSAL);
  });

  it("host-v2 F1: a missing entry is refused", async () => {
    const { s } = await killed("archive-committed", true, { entries: (hcs) => hcs.slice(0, -1) });
    expect(refused(s.input)).toBe(F1_REFUSAL);
  });

  it("host-v2 F1: reordered entries are refused", async () => {
    const { s } = await killed("archive-committed", true, { entries: (hcs) => [hcs[1]!, hcs[0]!, ...hcs.slice(2)] });
    expect(refused(s.input)).toBe(F1_REFUSAL);
  });

  it("host-v2 2a: a limit the host checks name must be the recorded failure, both ways", async () => {
    const limit = "limit: stdout over 67108864 bytes";
    const { s } = await killed("archive-committed", true, one(2, (hc) => ({ ...hc, limit })));
    expect(refused(s.input)).toMatch(new RegExp(`the host checks name "${limit}", but the record states no infrastructure failure`));
    const { s: kept } = await killed("archive-committed", false, one(0, (hc) => ({ ...hc, limit })), [{ text: "", terminal: "missing", infra: limit }]);
    expect(accepted(kept.input).checkSet).toBe(7);
    const { s: unnamed } = await killed("archive-committed", false, {}, [{ text: "", terminal: "missing", infra: limit }]);
    expect(refused(unnamed.input)).toMatch(new RegExp(`the recorded limit "${limit}" is not the host checks' no limit`));
  });

  it("host-v2 2a: a leftover the host checks find must be the recorded cleanup failure", async () => {
    const leftover = { status: "holders" as const, reason: "leftover: 42 node" };
    const { s } = await killed("archive-committed", true, one(3, (hc) => ({ ...hc, leftover })));
    expect(refused(s.input)).toMatch(/the host checks find "cleanup: leftover: 42 node", but the record states no infrastructure failure/);
    const { s: kept } = await killed("archive-committed", false, one(0, (hc) => ({ ...hc, leftover })), [{ text: "", infra: "cleanup: leftover: 42 node" }]);
    expect(accepted(kept.input).checkSet).toBe(7);
    const { s: other } = await killed("archive-committed", false, one(0, (hc) => ({ ...hc, leftover })), [{ text: "", infra: "cleanup: leftover: 7 sleep" }]);
    expect(refused(other.input)).toMatch(/the recorded "cleanup: leftover: 7 sleep" is not the host checks' "cleanup: leftover: 42 node"/);
    const failed = { status: "failed" as const, reason: "leftover check failed: lsof: status error" };
    const { s: unread } = await killed("archive-committed", false, one(0, (hc) => ({ ...hc, leftover: failed })), [{ text: "", infra: "cleanup: leftover check failed: lsof: status error" }]);
    expect(accepted(unread.input).checkSet).toBe(7);
  });

  // --- T-538 commit 2b (plan 5.5): the served commands are a replay input, and a record must trace to one -------
  it("host-v2 2b: the served log is a replay input; missing or malformed, the record is refused", async () => {
    const { s } = await killed("archive-committed", true, {});
    expect(accepted(s.input).manifest.map((m) => m.path)).toContain(SERVED_RAW);
    expect(refused(without(s.input, SERVED_RAW))).toBe(`replay input ${SERVED_RAW} is missing`);
    expect(refused(withRaw(s.input, SERVED_RAW, "{\n", true))).toBe(`replay input ${SERVED_RAW} is malformed: line 1 is not JSON`);
    expect(refused(withRaw(s.input, SERVED_RAW, `${JSON.stringify({ id: "../x", argv: null, stdinSha256: null, exit: 64, stdoutSha256: "0".repeat(64), stderrSha256: "0".repeat(64), start: "s", end: "e", published: [] })}\n`, true)))
      .toBe(`replay input ${SERVED_RAW} is malformed: line 1 is not a served line`);
  }, 20_000);

  it("host-v2 2b: a completed record planted in the store fails the run by name, and the regrade replays it; planted after the run, the record is refused", async () => {
    const rec = { setupId: "SS-0123abcd", cycle: 1, recordId: "planted", revisionSha256: "a".repeat(64), state: "completed" };
    const plantStore = (store: string): void => { mkdirSync(join(store, "pk", "SS-0123abcd", "records"), { recursive: true }); writeFileSync(join(store, "pk", "SS-0123abcd", "records", "planted.json"), JSON.stringify(rec)); };
    const { s } = await killed("archive-committed", true, { plantStore });
    expect(s.record.failures).toContain(`${UNSERVED_RECORD}: pk/SS-0123abcd/records/planted.json`);
    expect(accepted(s.input).checkSet).toBe(7);
    const { s: clean, store } = await killed("archive-committed", true, {});
    plantStore(store);
    expect(refused(clean.input)).toMatch(/failures differ|does not match/);
  }, 20_000);

  it("host-v2 2b: a request folder failure the host checks name must be the recorded failure, both ways", async () => {
    const { s } = await killed("archive-committed", true, one(2, (hc) => ({ ...hc, review: POLL_UNANSWERED })));
    expect(refused(s.input)).toMatch(new RegExp(`the host checks name "${POLL_UNANSWERED}", but the record states no infrastructure failure`));
    const { s: kept } = await killed("archive-committed", false, one(0, (hc) => ({ ...hc, review: POLL_UNANSWERED })), [{ text: "", terminal: "missing", infra: POLL_UNANSWERED }]);
    expect(accepted(kept.input).checkSet).toBe(7);
    const { s: unnamed } = await killed("archive-committed", false, {}, [{ text: "", terminal: "missing", infra: POLL_UNANSWERED }]);
    expect(refused(unnamed.input)).toMatch(new RegExp(`the recorded "${POLL_UNANSWERED}" is not the host checks' no request folder failure`));
    const { s: malformed } = await killed("archive-committed", true, one(0, (hc) => ({ ...hc, review: "poll unanswered" })));
    expect(refused(malformed.input)).toBe(`replay input ${HOST_CHECKS_RAW} is malformed`);
  }, 20_000);

  it("host-v2: an unknown route, a missing claudeLaunch, and a launch failure off the host-v2 route are refused", async () => {
    const { s } = await killed("archive-committed", true, {});
    expect(refused(withRecord(s.input, (r) => { r.route = "container-v1"; }))).toBe("the record's route container-v1 is not one this regrade supports");
    expect(refused(withRecord(s.input, (r) => { delete r.claudeLaunch; }))).toBe("the host-v2 Claude record has no valid claudeLaunch");
    const { s: codex } = await killed("archive-committed", false, null, [{ text: "", terminal: "missing", infra: "launch: get_sandbox_dialog.locked" }]);
    expect(refused(codex.input)).toMatch(/unrecognised infrastructure failure "launch: get_sandbox_dialog\.locked"/);
  });
});

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
