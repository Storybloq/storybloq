/**
 * T-538 S5a C2: check set 7 over a run. The engine runs in this process with
 * the evaluation collector installed (scripts/eval-fault-mcp.ts), so every
 * events log here is one the engine wrote; a kill is the collector's throw
 * plus the log cut where a SIGKILL would have cut it.
 */
import { describe, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { it, ownSeam } from "./t538-seam-owner.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAfterWriteFault, setupApplySeams } from "../../src/core/setup-apply.js";
import { evidenceFileSeams } from "../../src/core/checkpoint-evidence-files.js";
import { transactionSeams } from "../../src/core/project-loader.js";
import { setupPaths } from "../../src/core/setup-review.js";
import { handleSetupApply } from "../../src/cli/commands/setup-apply.js";
import { handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { collector } from "../../scripts/eval-fault-mcp.js";
import {
  checkSetupRun, cs7FinalLedger, cs7SnapshotLedger, rule8, rule9,
  type Cs7Call, type Cs7FinalLedger, type Cs7RunInputs, type Cs7Turn, type EvidenceObservation,
} from "../../scripts/onboarding-eval-checkset7.js";
import { mapInvocations, parseEventsLog, rule7, type EventsLog, type SetupCallRef, type SetupEvent } from "../../scripts/onboarding-eval-checkset7-events.js";
import { ledgerWriteFindings } from "../../scripts/onboarding-eval-checkset7-writes.js";
import { createdLines, enginePendingFindings, enginePendingInventory, type EvalCall } from "../../scripts/onboarding-eval-lib.js";

// These run a whole real setup on disk, which outlasts the 5 s default under load. The leak an abandoned run could cause is closed by ownSeam.
vi.setConfig({ testTimeout: 30_000 });

const SID = "SS-0123abcd";
const APPROVE = "Approve setup";

let scratch: string;
let reviewDir: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "t538-s5a-cs7-")));
  reviewDir = join(scratch, "review-store");
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
const seamDefaults = { evidence: evidenceFileSeams.afterCreate, afterTemp: transactionSeams.afterTemp, afterCommitEntry: transactionSeams.afterCommitEntry };
afterEach(() => {
  setupApplySeams.fault = () => {};
  evidenceFileSeams.afterCreate = seamDefaults.evidence;
  transactionSeams.afterTemp = seamDefaults.afterTemp;
  transactionSeams.afterCommitEntry = seamDefaults.afterCommitEntry;
});

let n = 0;
function folder(): string {
  const d = join(scratch, `p${n++}`);
  mkdirSync(d);
  return d;
}

function payload(): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: {
      level: "full",
      verifyApplies: false,
      components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: { command: "npm run build", status: "pending", reason: "no build script yet" }, verify: null }],
    },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] },
    git: { init: false, gitignore: ["node_modules/"] },
    phases: [
      { key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" },
      { key: "K6", id: "polish", name: "Polish", label: "POLISH", description: "" },
    ],
    tickets: [
      { key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] },
      { key: "K3", title: "Profile", type: "feature", phase: "K6", description: "d", blockedBy: ["K2"] },
    ],
    checkpoints: [{ key: "K4", title: "Accept sign in", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: ["K3"] }],
    issues: [{ key: "K5", title: "Imported", body: "b", labels: ["bug"], source: 7 }],
    coverage: [{ requirement: "R1", text: "sign in", source: "brief", keys: ["K2", "K4"] }],
  };
}

const PACKAGE = [
  "Here is the setup package.",
  "Plan, revision 0123456789ab:",
  "Ticket: Sign in",
  "Ticket: Profile",
  "Checkpoint (acceptance, owner Sam): Accept sign in",
  "End of plan, revision 0123456789ab",
].join("\n");

const heredoc = (p: unknown) => `storybloq setup-apply <<'STORYBLOQ_SETUP'\n${JSON.stringify(p)}\nSTORYBLOQ_SETUP`;
const shell = (command: string, output: string, isError = false): Cs7Call => ({ name: "Bash", command, input: { command }, output, isError });
const env = () => ({ PATH: process.env.PATH ?? "", HOME: scratch, STORYBLOQ_SETUP_REVIEW_DIR: reviewDir });

class Killed extends Error {}

/** One setup-apply invocation in this process, its events going to `events` under a collector for one attempt. */
async function apply(root: string, opts: { resume?: boolean; setup?: string; resolve?: string }, stdin = ""): Promise<string> {
  const r = await handleSetupApply({ cwd: root, env: env(), stdin: () => Buffer.from(stdin) }, opts);
  return r.stdout;
}

function attempt(events: string, selector: string | null = null): void {
  ownSeam(collector(events, selector, "cli", () => { throw new Killed("killed"); }));
}

/** The log as a SIGKILL at `point` in attempt `index` leaves it: nothing of that attempt after the point's line. */
function cutAfter(text: string, point: string): string {
  const lines = text.split("\n").filter(Boolean);
  const at = lines.findIndex((l) => (JSON.parse(l) as { point?: string }).point === point);
  const attemptId = (JSON.parse(lines[at]!) as { attempt: string }).attempt;
  return `${lines.filter((l, i) => i <= at || (JSON.parse(l) as { attempt: string }).attempt !== attemptId).join("\n")}\n`;
}

function writeSkippedReview(root: string): void {
  const paths = setupPaths({ STORYBLOQ_SETUP_REVIEW_DIR: reviewDir }, root, SID);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.setupFile, JSON.stringify({ setupId: SID, projectKey: paths.projectKey, createdAt: "2026-10-18T00:00:00Z", cycle: 2, cycleReasons: {}, probe: null, probedAt: "2026-10-18T00:00:00Z", skipped: { at: "2026-10-18T00:00:00Z" } }));
}

function finalLedger(root: string): Cs7FinalLedger {
  const story = join(root, ".story");
  return cs7FinalLedger({ exists: (rel) => existsSync(join(story, rel)), read: (rel) => readFileSync(join(story, rel), "utf-8"), list: (rel) => readdirSync(join(story, rel)) });
}

const opening: Cs7Turn[] = [
  { owner: "Set this project up", calls: [], text: "What are you building?" },
  { owner: "A habit tracker", calls: [], text: PACKAGE },
];

const allCallsOf = (turns: readonly Cs7Turn[]): EvalCall[] => turns.flatMap((t) => t.calls.map((c) => ({ name: c.name, input: c.input, isError: c.isError === true, result: c.output })));

function inputs(root: string, events: string, over: Partial<Cs7RunInputs> = {}): Cs7RunInputs {
  return {
    eventsText: existsSync(events) ? readFileSync(events, "utf-8") : null,
    snapshotText: existsSync(`${events}.setup-snapshot.json`) ? readFileSync(`${events}.setup-snapshot.json`, "utf-8") : null,
    final: finalLedger(root),
    baselineIds: [],
    baselinePhases: [],
    approval: APPROVE,
    projectRoot: root,
    contract: { established: { "": ["npm test"] }, pending: [] },
    observations: null,
    followUp: null,
    ...over,
  };
}

const grade = (turns: Cs7Turn[], i: Cs7RunInputs) => checkSetupRun(turns, allCallsOf(turns), i);

/** A clean run: one apply, its report shown whole. */
async function cleanRun(): Promise<{ root: string; events: string; turns: Cs7Turn[] }> {
  const root = folder();
  const events = join(root, "..", `${n}-events.jsonl`);
  attempt(events);
  const out = await apply(root, {}, JSON.stringify(payload()));
  expect(out).toContain(`Setup applied: ${SID}`);
  return { root, events, turns: [...opening, { owner: APPROVE, calls: [shell(heredoc(payload()), out)], text: out }] };
}

describe("check set 7 over a run: completion and the boundary", () => {
  it("a clean run passes, with its one invocation mapped and the boundary at the apply call", async () => {
    const { root, events, turns } = await cleanRun();
    const r = grade(turns, inputs(root, events));
    expect(r.failures).toEqual([]);
    expect(r.boundary).toEqual({ turn: 2, call: 0 });
    expect(r.invocations.map((m) => [m.turn, m.call, m.kind, m.exitCode])).toEqual([[2, 0, "apply", 0]]);
  });

  it("follow-up work in the completion turn, after the boundary, is not judged by rules 1 to 6", async () => {
    const { root, events, turns } = await cleanRun();
    const last = turns[2]!;
    const more = [...turns.slice(0, 2), { ...last, calls: [...last.calls, shell("storybloq ticket create --title 'Next' --type task --phase build", "Created ticket T-009")] }];
    expect(grade(more, inputs(root, events)).failures).toEqual([]);
    // The same call before the boundary is setup work and fails rule 5.
    const before = [...turns.slice(0, 2), { ...last, calls: [more[2]!.calls[1]!, last.calls[0]!] }];
    expect(grade(before, inputs(root, events)).failures).toContain("rule 5: turn 3 ran storybloq ticket create; the setup engine is the only writer");
  });

  it("a run with no events log, or no archive, fails as setup incomplete and is graded no further", async () => {
    const { root, events, turns } = await cleanRun();
    expect(grade(turns, inputs(root, events, { eventsText: null })).failures).toEqual(["setup incomplete: the run has no events log"]);
    const text = readFileSync(events, "utf-8").split("\n").filter((l) => !l.includes('"point":"archive-committed"') && !l.includes('"point":"step:archive"')).join("\n");
    const r = grade(turns, inputs(root, events, { eventsText: text }));
    expect(r.failures).toEqual(["setup incomplete: no archive-committed event"]);
    expect(r.boundary).toBeNull();
  });

  it("a snapshot that is not the one archive-committed names fails as setup incomplete", async () => {
    const { root, events, turns } = await cleanRun();
    const snapshot = readFileSync(`${events}.setup-snapshot.json`, "utf-8").replace("Sign in", "Signed in");
    expect(grade(turns, inputs(root, events, { snapshotText: snapshot })).failures).toEqual(["setup incomplete: the setup snapshot does not match archive-committed's digest"]);
    expect(grade(turns, inputs(root, events, { snapshotText: null })).failures).toEqual(["setup incomplete: the archive-committed snapshot is missing"]);
  });

  it("a step:archive missing from an invocation that ended, or naming another snapshot, fails", async () => {
    const { root, events, turns } = await cleanRun();
    const lines = readFileSync(events, "utf-8").split("\n").filter(Boolean);
    const without = `${lines.filter((l) => !l.includes('"point":"step:archive"')).join("\n")}\n`;
    expect(grade(turns, inputs(root, events, { eventsText: without })).failures).toEqual([expect.stringMatching(/^completion: invocation [0-9a-f]{16} ended after archive-committed with no step:archive$/)]);
    const other = `${lines.map((l) => (l.includes('"point":"step:archive"') ? l.replace(/"snapshotSha256":"[0-9a-f]{64}"/, `"snapshotSha256":"${"0".repeat(64)}"`) : l)).join("\n")}\n`;
    expect(grade(turns, inputs(root, events, { eventsText: other })).failures).toEqual(["completion: step:archive's snapshot digest differs from archive-committed's"]);
  });

  it.each(["step:archive", "archive-committed"])("a kill at %s, then an already-complete resume in session 2, passes", async (point) => {
    const root = folder();
    const events = join(root, "..", `${n}-killed.jsonl`);
    attempt(events, point);
    const first = await apply(root, {}, JSON.stringify(payload()));
    expect(first).toContain("killed");
    writeFileSync(events, cutAfter(readFileSync(events, "utf-8"), point));
    attempt(events);
    const resumed = await apply(root, { resume: true, setup: SID });
    expect(resumed).toContain(`Setup applied: ${SID} (already complete; nothing written)`);
    const turns: Cs7Turn[] = [
      ...opening,
      { owner: APPROVE, calls: [shell(heredoc(payload()), "", true)], text: "The setup was interrupted." },
      { owner: "Continue", calls: [shell(`storybloq setup-apply --resume --setup ${SID}`, resumed)], text: resumed },
    ];
    const r = grade(turns, inputs(root, events));
    expect(r.failures).toEqual([]);
    expect(r.boundary).toEqual({ turn: 3, call: 0 });
    expect(r.invocations.map((m) => [m.turn, m.kind, m.exitCode])).toEqual([[2, "apply", null], [3, "resume", 0]]);
  });

  it("a commit event from an invocation that started after archive-committed fails", async () => {
    const { root, events, turns } = await cleanRun();
    const text = readFileSync(events, "utf-8");
    const { attempt: a } = JSON.parse(text.split("\n")[0]!) as { attempt: string };
    const late = [
      { seq: 900, attempt: a, point: "invocation-start", setupId: SID, invocation: "feedfacefeedface", revision: null, kind: "resume", argSha256: "x" },
      { seq: 901, attempt: a, point: "step:config", setupId: SID, invocation: "feedfacefeedface", revision: null },
    ].map((e) => JSON.stringify(e)).join("\n");
    expect(grade(turns, inputs(root, events, { eventsText: `${text}${late}\n` })).failures).toContain("completion: step:config in invocation feedfacefeedface, which started after archive-committed");
  });
});

describe("check set 7: the invocation mapping", () => {
  it("several invocations in one attempt map one to one, and an extra call or a changed digest fails", async () => {
    const root = folder();
    writeFileSync(join(root, "CLAUDE.md"), "# mine\n");
    const events = join(root, "..", `${n}-several.jsonl`);
    attempt(events);
    const stop = await apply(root, {}, JSON.stringify(payload()));
    expect(stop).toMatch(/^Ambiguity: /m);
    writeSkippedReview(root);
    const resolve = JSON.stringify([{ target: "CLAUDE.md", resolution: "keep-current", ownerWords: "keep mine" }]);
    const done = await apply(root, { setup: SID, resolve });
    expect(done).toContain(`Setup applied: ${SID}`);
    const turns: Cs7Turn[] = [
      ...opening,
      { owner: APPROVE, calls: [shell(heredoc(payload()), stop)], text: stop },
      { owner: "keep mine", calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '${resolve}'`, done)], text: done },
    ];
    const r = grade(turns, inputs(root, events));
    expect(r.failures).toEqual([]);
    expect(r.invocations.map((m) => [m.turn, m.kind])).toEqual([[2, "apply"], [3, "resolve"]]);
    const extra = [...turns.slice(0, 3), { ...turns[3]!, calls: [...turns[3]!.calls, shell(`storybloq setup-apply --resume --setup ${SID}`, done)] }];
    expect(grade(extra, inputs(root, events)).failures).toEqual(["mapping: turn 4 call 2 maps to no invocation"]);
    const changed = [...turns.slice(0, 3), { ...turns[3]!, calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '${resolve.replace("keep mine", "keep it")}'`, done)] }];
    expect(grade(changed, inputs(root, events)).failures).toContainEqual(expect.stringMatching(/^mapping: turn 4 call 1's argument digest differs from invocation [0-9a-f]{16}'s$/));
  });
});

describe("check set 7 rule 7: ordered events", () => {
  it("one process finalizes, stops, accepts an amendment and finalizes again at the new revision: passes", async () => {
    const root = folder();
    const events = join(root, "..", `${n}-amend.jsonl`);
    attempt(events, "step:handover");
    const first = await apply(root, {}, JSON.stringify(payload()));
    expect(first).toMatch(/^Setup stopped: /m);
    await handleTicketUpdate("T-001", { title: "Log in" }, "json", root);
    const stop = await apply(root, { resume: true, setup: SID });
    expect(stop).toMatch(/^Ambiguity: owned field edited · K2 \(T-001\)/m);
    writeSkippedReview(root);
    const resolve = JSON.stringify([{ target: "K2 (T-001)", resolution: "accept-current", ownerWords: "keep Log in" }]);
    const done = await apply(root, { setup: SID, resolve });
    expect(done).toContain(`Setup applied: ${SID}`);
    const log = parseEventsLog(readFileSync(events, "utf-8"));
    expect(new Set(log.events.filter((e) => e.point === "step:freeze").map((e) => e.revision)).size).toBe(2);
    const turns: Cs7Turn[] = [
      ...opening,
      { owner: APPROVE, calls: [shell(heredoc(payload()), first)], text: first },
      { owner: "Continue", calls: [shell(`storybloq setup-apply --resume --setup ${SID}`, stop)], text: stop },
      { owner: "keep Log in", calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '${resolve}'`, done)], text: done },
    ];
    expect(grade(turns, inputs(root, events)).failures).toEqual([]);
  });

  it("a same-revision recommit, an out-of-order step and an unknown revision each fail", async () => {
    const { root, events, turns } = await cleanRun();
    const text = readFileSync(events, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    const config = lines.find((l) => l.includes('"point":"step:config"'))!;
    const again = `${lines.join("\n")}\n${config.replace(/"seq":\d+/, '"seq":999')}\n`;
    expect(grade(turns, inputs(root, events, { eventsText: again })).failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/^rule 7: step:config committed again at the same revision [0-9a-f]{12}$/),
      expect.stringMatching(/^rule 7: step:config follows step:archive for setup SS-0123abcd$/),
    ]));
    const configAt = lines.indexOf(config);
    const freezeAt = lines.findIndex((l) => l.includes('"point":"step:freeze"'));
    const swapped = [...lines];
    [swapped[configAt], swapped[freezeAt]] = [swapped[freezeAt]!, swapped[configAt]!];
    expect(grade(turns, inputs(root, events, { eventsText: `${swapped.join("\n")}\n` })).failures).toContainEqual(expect.stringMatching(/^rule 7: step:config is out of the plan's order in invocation [0-9a-f]{16}$/));
    const plans = () => null;
    expect(rule7(parseEventsLog(text), plans)[0]).toMatch(/^rule 7: step:enable is at revision [0-9a-f]{12}, which no amendment of the archived payload produces$/);
  });

  it("a recommit from a second process at the same revision fails: a key commits once per setup, not once per process", () => {
    const revision = "a".repeat(64);
    const step = (attempt: string) => JSON.stringify({ attempt, seq: 1, point: "step:config", setupId: SID, invocation: null, revision });
    const text = [JSON.stringify({ attempt: "a1", pid: 1, entry: "cli" }), step("a1"), JSON.stringify({ attempt: "a2", pid: 2, entry: "cli" }), step("a2")].join("\n") + "\n";
    expect(rule7(parseEventsLog(text), () => ["config"])).toEqual(["rule 7: step:config committed again at the same revision aaaaaaaaaaaa"]);
  });
});

describe("check set 7: the summary's pending and Created: lines", () => {
  const level = "full" as const;
  const one = [{ id: "root", workdir: "." }];
  const two = [{ id: "web", workdir: "web" }, { id: "api", workdir: "api" }];

  it("a single component: one line per stage, no component named; a missing, repeated or merged line fails", () => {
    const inv = enginePendingInventory({ established: {}, pending: [""] }, level, one);
    const ok = "Pending: WRITE_TESTS: npm test (pending: no runner).\nPending: TEST: npm test (pending: no runner).";
    expect(enginePendingFindings(ok, inv)).toEqual([]);
    expect(enginePendingFindings("Pending: TEST: npm test (pending: no runner).", inv)).toEqual(["pending line missing: WRITE_TESTS"]);
    expect(enginePendingFindings(`${ok}\nPending: TEST: npm test (pending: no runner).`, inv)).toEqual(["pending line repeated: TEST appears 2 times"]);
    expect(enginePendingFindings("Pending: WRITE_TESTS and TEST: npm test (pending: no runner).", inv)).toEqual([
      "pending line names more than one stage: Pending: WRITE_TESTS and TEST: npm test (pending: no runner).",
      "pending line missing: WRITE_TESTS", "pending line missing: TEST",
    ]);
  });

  it("several components: each line names the payload's component id", () => {
    const inv = enginePendingInventory({ established: { web: ["npm test"] }, pending: ["api"] }, level, two);
    expect(inv).toEqual([{ stage: "WRITE_TESTS", component: "api" }, { stage: "TEST", component: "api" }]);
    expect(enginePendingFindings("Pending: WRITE_TESTS (api): pytest (pending: none).\nPending: TEST (api): pytest (pending: none).", inv)).toEqual([]);
    expect(enginePendingFindings("Pending: WRITE_TESTS (web): pytest (pending: none).\nPending: TEST (api): pytest (pending: none).", inv)).toEqual(["pending line missing: WRITE_TESTS (api)"]);
  });

  it("a summary whose Created: line is not the engine's fails; one with none fails", async () => {
    const { root, events, turns } = await cleanRun();
    const out = turns[2]!.calls[0]!.output;
    const created = createdLines(out)[0]!;
    const changed = [...turns.slice(0, 2), { ...turns[2]!, text: out.replace(created, "Created: 9 phases") }];
    expect(grade(changed, inputs(root, events)).failures).toEqual([`summary: "Created: 9 phases" is not the engine's "${created}"`]);
    const none = [...turns.slice(0, 2), { ...turns[2]!, text: `Setup applied: ${SID}` }];
    expect(grade(none, inputs(root, events)).failures).toEqual(["summary: the final report shows no Created: line"]);
  });

  it("a recorded engine summary with a pending component fails check set 6's pendingFindings, which pins the conflict", async () => {
    const { pendingFindings, pendingInventory } = await import("../../scripts/onboarding-eval-lib.js");
    const summary = "Pending: WRITE_TESTS: npm test (pending: no runner).\nPending: TEST: npm test (pending: no runner).";
    const contract = { established: {}, pending: [""] };
    expect(enginePendingFindings(summary, enginePendingInventory(contract, level, one))).toEqual([]);
    expect(pendingFindings(summary, pendingInventory(contract, level)).length).toBeGreaterThan(0);
  });
});

describe("check set 7 rule 8: checkpoints and evidence", () => {
  const resolveCall = (response: string): Cs7Call => ({ name: "mcp__storybloq__storybloq_checkpoint_resolve", command: null, input: { id: "T-003", response }, output: "resolved" });

  it("a resolve the owner's words authorise passes; one before or inside the completion turn without them fails", () => {
    const ok: Cs7Turn[] = [{ owner: "Accepted: sign in works", calls: [resolveCall("Accepted: sign in works")], text: "" }];
    expect(rule8(ok, [], null, null)).toEqual([]);
    const early: Cs7Turn[] = [{ owner: "Set it up", calls: [resolveCall("Accepted: sign in works")], text: "" }, { owner: "Accepted: sign in works", calls: [], text: "" }];
    expect(rule8(early, [], null, null)).toEqual(["rule 8: turn 1 call 1 resolves a checkpoint with a response no owner turn up to it quotes"]);
    const cli = `storybloq checkpoint resolve T-003 --generation 1 --revision 1 --digest d --response 'Looks right'`;
    const inside: Cs7Turn[] = [{ owner: APPROVE, calls: [shell(heredoc(payload()), `Setup applied: ${SID}`), shell(cli, "resolved")], text: "" }];
    expect(rule8(inside, [], null, null)).toEqual(["rule 8: turn 1 call 2 resolves a checkpoint with a response no owner turn up to it quotes"]);
    expect(rule8(inside, [{ name: "Bash", input: { command: cli }, isError: false, nested: true }], null, null)).toContain("rule 8: a nested agent resolved a checkpoint (Bash)");
  });

  it("an evidence file whose digest changed after its creation fails, as does one nothing observed", () => {
    const log = parseEventsLog(`${JSON.stringify({ attempt: "a", pid: 1, entry: "mcp" })}\n${JSON.stringify({ seq: 0, attempt: "a", point: "evidence-created:ev/1.png", setupId: null, invocation: null, revision: null, sha256: "a".repeat(64) })}\n`);
    const at = (kind: "event" | "turn", index: number) => ({ kind, index });
    const same: EvidenceObservation[] = [{ ref: "ev/1.png", sha256: "a".repeat(64), at: at("event", 0) }, { ref: "ev/1.png", sha256: "a".repeat(64), at: at("turn", 3) }];
    expect(rule8([], [], log, same)).toEqual([]);
    expect(rule8([], [], log, [...same, { ref: "ev/1.png", sha256: "b".repeat(64), at: at("turn", 5) }])).toEqual([`rule 8: evidence ev/1.png changed: created as ${"a".repeat(12)}, observed as ${"b".repeat(12)} at turn 5`]);
    expect(rule8([], [], log, null)).toEqual(["rule 8: evidence ev/1.png was created, but nothing observed it afterwards"]);
  });
});

describe("check set 7 rule 9: follow-up rulings", () => {
  const followUp = { titlePattern: "^Follow up", checkpoint: { kind: "acceptance" as const, owner: "Robin" } };
  const cp = (rulingId?: string, over: { id?: string; key?: string; kind?: string; owner?: string; title?: string } = {}) => ({
    id: over.id ?? "T-003", title: over.title ?? "Accept", setup: { setupId: SID, key: over.key ?? "K4" },
    ownerCheckpoint: { kind: over.kind ?? "acceptance", owner: over.owner ?? "Robin", resolution: rulingId === undefined ? { response: "ok" } : { response: "ok", rulingId } },
  });
  const atBoundary = { tickets: [cp()], issues: [], phases: [] };
  const final = (tickets: object[], rulings: string[]): Cs7FinalLedger => ({ tickets, issues: [], phases: [], notes: [], rulings });

  it("one follow-up citing the ruling on the one matching checkpoint passes", () => {
    expect(rule9(followUp, atBoundary, final([cp("r-1"), { id: "T-009", title: "Follow up on sign in", citesRulings: ["r-1"] }], ["r-1"]), [])).toEqual([]);
  });

  it("a missing follow-up, a missing ruling and a wrong reference each fail", () => {
    expect(rule9(followUp, atBoundary, final([cp("r-1")], ["r-1"]), [])).toEqual(["rule 9: 0 tickets created after the setup match /^Follow up/; expected exactly one"]);
    expect(rule9(followUp, atBoundary, final([cp("r-1"), { id: "T-009", title: "Follow up", citesRulings: ["r-1"] }], []), [])).toEqual(["rule 9: ruling r-1, recorded on T-003, does not exist"]);
    expect(rule9(followUp, atBoundary, final([cp("r-1"), { id: "T-009", title: "Follow up", citesRulings: ["r-2"] }], ["r-1", "r-2"]), [])).toEqual(["rule 9: T-009 does not cite r-1, the ruling on T-003"]);
    expect(rule9(followUp, atBoundary, final([cp(), { id: "T-009", title: "Follow up", citesRulings: [] }], []), [])).toEqual(["rule 9: checkpoint T-003 (key K4) records no ruling"]);
  });

  it("the checkpoint is found by kind and owner in the snapshot: zero and two matches each fail by name, never the first", () => {
    const follow = { id: "T-009", title: "Follow up", citesRulings: ["r-1"] };
    const none = { tickets: [cp(undefined, { owner: "Sam" })], issues: [], phases: [] };
    expect(rule9(followUp, none, final([cp("r-1", { owner: "Sam" }), follow], ["r-1"]), [])).toEqual(["rule 9: no checkpoint matches (acceptance, owner Robin)"]);
    const two = { tickets: [cp(), cp(undefined, { id: "T-005", key: "K6" })], issues: [], phases: [] };
    expect(rule9(followUp, two, final([cp("r-1"), cp("r-1", { id: "T-005", key: "K6" }), follow], ["r-1"]), [])).toEqual(["rule 9: 2 checkpoints match (acceptance, owner Robin)"]);
  });

  it("a title is a second filter only: a title match with the wrong kind fails, and the title separates two of the right kind", () => {
    const titled = { titlePattern: "^Follow up", checkpoint: { kind: "acceptance" as const, owner: "Robin", titlePattern: "demo" } };
    const follow = { id: "T-009", title: "Follow up", citesRulings: ["r-1"] };
    const wrongKind = { tickets: [cp(undefined, { kind: "decision", title: "Rota demo" })], issues: [], phases: [] };
    expect(rule9(titled, wrongKind, final([cp("r-1", { kind: "decision", title: "Rota demo" }), follow], ["r-1"]), [])).toEqual(["rule 9: no checkpoint matches (acceptance, owner Robin, title /demo/)"]);
    const two = { tickets: [cp(undefined, { title: "Rota demo" }), cp(undefined, { id: "T-005", key: "K6", title: "Release sign-off" })], issues: [], phases: [] };
    expect(rule9(titled, two, final([cp("r-1", { title: "Rota demo" }), cp(undefined, { id: "T-005", key: "K6" }), follow], ["r-1"]), [])).toEqual([]);
  });
});

describe("check set 7 rule 10 inside a run", () => {
  it("a ledger write anywhere in the run fails by call index", async () => {
    const { root, events, turns } = await cleanRun();
    const last = turns[2]!;
    const wrote = [...turns.slice(0, 2), { ...last, calls: [...last.calls, shell("sed -i '' 's/a/b/' .story/tickets/T-001.json", "")] }];
    expect(grade(wrote, inputs(root, events)).failures).toEqual(["rule 10: call 2: ledger write: sed -i on .story/tickets/T-001.json: sed -i '' s/a/b/ .story/tickets/T-001.json"]);
  });
});

describe("the snapshot ledger", () => {
  it("reads tickets, issues and the roadmap's phases from the archive's snapshot", async () => {
    const { events } = await cleanRun();
    const ledger = cs7SnapshotLedger(readFileSync(`${events}.setup-snapshot.json`, "utf-8"));
    expect(ledger.phases).toEqual(["build", "polish"]);
    expect(ledger.tickets.map((t) => (t as { title: string }).title).sort()).toEqual(["Accept sign in", "Profile", "Sign in"]);
    expect(ledger.issues).toHaveLength(1);
    expect(() => cs7SnapshotLedger("{}")).toThrow("the setup snapshot holds no files");
  });
});

describe("check set 7 rule 10: the ledger is written only through storybloq", () => {
  const ROOT = "/tmp/proj";
  const bash = (command: string) => ({ name: "Bash", input: { command } });
  const findings = (...calls: Array<{ name: string; input: unknown }>) => ledgerWriteFindings(calls, ROOT);

  it.each([
    ["an Edit", { name: "Edit", input: { file_path: "/tmp/proj/.story/tickets/T-001.json", old_string: "a", new_string: "b" } }, "Edit on /tmp/proj/.story/tickets/T-001.json"],
    ["a Write", { name: "Write", input: { file_path: ".story/tickets/T-001.json", content: "{}" } }, "Write on .story/tickets/T-001.json"],
    ["an apply_patch", { name: "apply_patch", input: { input: "*** Begin Patch\n*** Update File: .story/tickets/T-001.json\n@@\n-a\n+b\n*** End Patch" } }, "apply_patch on .story/tickets/T-001.json"],
    ["sed -i", bash("sed -i 's/a/b/' .story/tickets/T-001.json"), "sed -i on .story/tickets/T-001.json"],
    ["a > redirect", bash("echo x > .story/notes/n.json"), "a redirection (>) into .story/notes/n.json"],
    ["a >> redirect", bash("echo x >> .story/config.json"), "a redirection (>>) into .story/config.json"],
    ["node -e", bash(`node -e "require('fs').writeFileSync('.story/x','y')"`), "node inline code that names .story"],
    ["python -c", bash(`python -c "open('.story/x','w')"`), "python inline code that names .story"],
    ["a pipe into tee", bash("echo x | tee .story/x"), "tee on .story/x"],
    ["a write after a storybloq command", bash("storybloq ticket update T-001 --status complete && echo x > .story/tickets/T-001.json"), "a redirection (>) into .story/tickets/T-001.json"],
    ["a write after a cd into .story", bash("cd .story && echo x > tickets/T-001.json"), "a redirection (>) into tickets/T-001.json"],
    ["an exec_command write in cmd", { name: "exec_command", input: { cmd: ["bash", "-lc", "echo x > .story/x"] } }, "a redirection (>) into .story/x"],
    ["an expansion target", bash("F=.story/x; echo y > $F"), "a redirection to an expansion ($F) in a call that names .story"],
    ["a command the detector cannot classify", bash("frobnicate .story/x"), "frobnicate is a command the detector cannot classify, in a call that names .story"],
  ])("%s fails", (_label, call, reason) => {
    expect(findings(call).map((f) => f.replace(/^rule 10: call 1: ledger write: /, "").split(": ")[0])).toContain(reason);
  });

  it.each([
    ["a storybloq command", bash("storybloq ticket update T-001 --status complete")],
    ["cat", bash("cat .story/tickets/T-001.json")],
    ["ls", bash("ls .story")],
    ["a write outside .story", bash("echo x > notes.txt")],
    ["an Edit to src", { name: "Edit", input: { file_path: "/tmp/proj/src/app.ts", old_string: "a", new_string: "b" } }],
    ["a storybloq MCP write", { name: "mcp__storybloq__storybloq_ticket_update", input: { id: "T-001", title: ".story" } }],
  ])("%s passes", (_label, call) => {
    expect(findings(call)).toEqual([]);
  });

  it("names the call index and the operation", () => {
    expect(findings(bash("ls"), bash("sed -i 's/a/b/' .story/tickets/T-001.json"))).toEqual(["rule 10: call 2: ledger write: sed -i on .story/tickets/T-001.json: sed -i s/a/b/ .story/tickets/T-001.json"]);
  });
});

describe("every seam the collector installs is reset between tests", () => {
  it("a test installs the collector", () => {
    setAfterWriteFault(() => {});
    expect(transactionSeams.afterTemp).not.toBe(seamDefaults.afterTemp);
  });
  it("the next test sees the defaults on all of them", () => {
    expect(evidenceFileSeams.afterCreate).toBe(seamDefaults.evidence);
    expect(transactionSeams.afterTemp).toBe(seamDefaults.afterTemp);
    expect(transactionSeams.afterCommitEntry).toBe(seamDefaults.afterCommitEntry);
  });
});

describe("rule 8 reads every resolution in a shell call", () => {
  const OWNER = "Yes, that works for me.";
  const QUOTED = "--response 'Yes, that works for me.'";
  const turn = (command: string): Cs7Turn => ({ owner: OWNER, text: "", calls: [{ name: "Bash", command, input: { command }, output: "ok", isError: false }] });
  const graded = (command: string) => rule8([turn(command)], [], null, null);
  const UNQUOTED = "rule 8: turn 1 call 1 resolves a checkpoint with a response no owner turn up to it quotes";
  const UNREADABLE = "rule 8: turn 1 call 1 resolves a checkpoint with a response the transcript cannot read";

  it.each([
    ["a second resolution after &&", `storybloq checkpoint resolve T-1 ${QUOTED} && storybloq checkpoint resolve T-2 --response 'made up'`],
    ["a second resolution on the next line", `storybloq checkpoint resolve T-1 ${QUOTED}\nstorybloq checkpoint resolve T-2 --response 'made up'`],
    ["a resolution after a reader", `cat notes.txt; storybloq checkpoint resolve T-2 --response 'made up'`],
    ["sh -c", `sh -c "storybloq checkpoint resolve T-2 --response 'made up'"`],
    ["bash -lc after a real one", `storybloq checkpoint resolve T-1 ${QUOTED}; bash -lc "storybloq checkpoint resolve T-2 --response fake"`],
    ["env", `env A=1 storybloq checkpoint resolve T-2 --response 'made up'`],
    ["npx", `npx storybloq checkpoint resolve T-2 --response 'made up'`],
    ["npx -p -c", `npx -p @storybloq/storybloq -c 'storybloq checkpoint resolve T-2 --response fake'`],
    ["npx --package= --call=", `npx --package=storybloq --call='storybloq checkpoint resolve T-2 --response fake'`],
    ["npx -p into a shell", `npx -p storybloq sh -c 'storybloq checkpoint resolve T-2 --response fake'`],
    ["bunx -p", `bunx -p storybloq storybloq checkpoint resolve T-2 --response fake`],
    ["pnpx", `pnpx storybloq checkpoint resolve T-2 --response fake`],
    ["pnpm dlx", `pnpm dlx storybloq checkpoint resolve T-2 --response fake`],
    ["pnpm --package dlx -c", `pnpm --package=storybloq dlx -c 'storybloq checkpoint resolve T-2 --response fake'`],
    ["pnpm exec", `pnpm exec storybloq checkpoint resolve T-2 --response fake`],
    ["yarn dlx -p", `yarn dlx -p storybloq storybloq checkpoint resolve T-2 --response fake`],
    ["yarn exec", `yarn exec storybloq checkpoint resolve T-2 --response fake`],
    ["npm exec --", `npm exec --package=storybloq -- storybloq checkpoint resolve T-2 --response fake`],
    ["npm exec -c", `npm exec -c 'storybloq checkpoint resolve T-2 --response fake'`],
    ["bun x", `bun x storybloq checkpoint resolve T-2 --response fake`],
    ["a global option first", `storybloq --format json checkpoint resolve T-2 --response 'made up'`],
    ["an assignment prefix", `A=1 storybloq checkpoint resolve T-2 --response 'made up'`],
    ["an absolute path", `/usr/local/bin/storybloq checkpoint resolve T-2 --response 'made up'`],
    ["the = form", `storybloq checkpoint resolve T-2 --response='made up'`],
    ["a live substitution", `echo "$(storybloq checkpoint resolve T-2 --response fake)"`],
    ["an expansion the owner never said", `R=fake; storybloq checkpoint resolve T-2 --response "$R"`],
  ])("%s with fabricated words fails", (_label, command) => {
    expect(graded(command)).toEqual([UNQUOTED]);
  });

  it.each([
    ["no value", "storybloq checkpoint resolve T-2 --response"],
    ["no flag", "storybloq checkpoint resolve T-2"],
    ["the flag twice", `storybloq checkpoint resolve T-2 ${QUOTED} --response 'made up'`],
    ["eval", `eval "storybloq checkpoint resolve T-2 --response fake"`],
    ["a here-document", "sh <<'EOF'\nstorybloq checkpoint resolve T-2 --response fake\nEOF"],
    ["node running the CLI by path", "node dist/cli.js checkpoint resolve T-2 --response fake"],
    ["interpreter code", `python3 -c "import os; os.system('storybloq checkpoint resolve T-2 --response fake')"`],
    ["text piped into a shell", "echo 'storybloq checkpoint resolve T-2 --response fake' | sh"],
    ["a package option then an interpreter", `npx -p storybloq node -e "require('child_process').execSync('storybloq checkpoint resolve T-2 --response fake')"`],
    ["a package option, an interpreter and argv", `npx -p storybloq node run.js storybloq checkpoint resolve T-2`],
    ["a runner's command string held in a variable", `C='storybloq checkpoint resolve T-2 --response fake'; npx -c "$C"`],
    ["a runner option this cannot place", `npx -yc 'storybloq checkpoint resolve T-2 --response fake'`],
    ["a package manager subcommand that runs a script", `pnpm run storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["npx with an unknown option's value ending in echo", "npx --cache /tmp/echo storybloq checkpoint resolve T-2 --response fake"],
    ["npx with an unknown option's value ending in cat", "npx --cache /tmp/cat storybloq checkpoint resolve T-2 --response fake"],
    ["pnpm dlx with an unknown option's value ending in echo", "pnpm dlx --cache /tmp/echo storybloq checkpoint resolve T-2 --response fake"],
    ["yarn dlx with an unknown option's value ending in cat", "yarn dlx --cache /tmp/cat storybloq checkpoint resolve T-2 --response fake"],
    ["bunx with an unknown option's value ending in echo", "bunx --cache /tmp/echo storybloq checkpoint resolve T-2 --response fake"],
    ["an unknown option before the subcommand", "pnpm --cache dlx echo storybloq checkpoint resolve T-2 --response fake"],
    ["an unknown --flag=value before a quoted resolution", `npx --flag=value storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["an unknown --flag=value before a command string", `npx --flag=value -c "storybloq checkpoint resolve T-1 ${QUOTED}"`],
    ["npm exec --yes true -- before a resolve", "npm exec --yes true -- storybloq checkpoint resolve T-2 --response fake"],
    ["npm exec --yes false -- before a resolve", "npm exec --yes false -- storybloq checkpoint resolve T-2 --response fake"],
    ["a runner running echo", "npx echo storybloq checkpoint resolve T-2 --response fake"],
    ["a runner running cat", "npx cat storybloq checkpoint resolve T-2 --response fake"],
    ["a runner running git commit", "npx git commit -m 'storybloq checkpoint resolve T-2'"],
    ["a runner's direct target with the command in a variable", "C='storybloq checkpoint resolve T-2 --response fake'; npx true -- $C"],
    ["an unknown option before the subcommand and a quoted resolution", `pnpm --cache dlx storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["a command held in a variable", "CMD='storybloq checkpoint resolve T-2 --response x'; $CMD"],
    ["words fed to xargs", "echo checkpoint resolve T-2 | xargs storybloq"],
    ["a git alias defined inline", "git -c alias.x='!storybloq checkpoint resolve T-2' x"],
    ["interpreter code in a here-document", "python3 <<'EOF'\nimport os; os.system('storybloq checkpoint resolve T-2')\nEOF"],
    ["a nested shell too deep", `sh -c "sh -c \\"sh -c \\\\\\"sh -c 'sh -c storybloq\\\\ checkpoint\\\\ resolve'\\\\\\"\\""`],
  ])("%s fails closed", (_label, command) => {
    expect(graded(command)).toContain(UNREADABLE);
  });

  it.each([
    ["one quoted resolution", `storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["two quoted resolutions", `storybloq checkpoint resolve T-1 ${QUOTED} && storybloq checkpoint resolve T-2 ${QUOTED}`],
    ["a wrapped quoted resolution", `sh -c "storybloq checkpoint resolve T-1 ${QUOTED}"`],
    ["a quoted resolution through npx -c", `npx -p storybloq -c "storybloq checkpoint resolve T-1 ${QUOTED}"`],
    ["a quoted resolution through pnpm dlx", `pnpm dlx storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["a quoted resolution through yarn dlx", `yarn dlx @storybloq/storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["a quoted resolution through a versioned package", `npx storybloq@latest checkpoint resolve T-1 ${QUOTED}`],
    ["a quoted resolution through npx --yes", `npx --yes storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["a quoted resolution through npm exec --yes --", `npm exec --yes -- storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["a quoted resolution through npx", `npx -y @storybloq/storybloq checkpoint resolve T-1 ${QUOTED}`],
    ["a quoted resolution after a global option", `storybloq --format json checkpoint resolve T-1 ${QUOTED}`],
    ["a reader over the docs", "grep 'storybloq checkpoint resolve' README.md"],
    ["echo text", "echo 'next: storybloq checkpoint resolve T-2 --response x'"],
    ["echo words", "echo storybloq checkpoint resolve T-2"],
    ["a note held in a variable", `NOTE='storybloq checkpoint resolve'; echo "$NOTE"`],
    ["echo inside a runner's command string", "npx -c 'echo storybloq checkpoint resolve'"],
    ["another storybloq command through a runner", "pnpm dlx storybloq ticket create --title checkpoint resolve"],
    ["a runner with an unknown option, naming no resolve", "npx --cache /tmp/x cowsay hello"],
    ["a runner running echo, naming no resolve", "npx echo hello"],
    ["printf text", "printf '%s' 'storybloq checkpoint resolve'"],
    ["a commit message", "git commit -m 'docs: storybloq checkpoint resolve --response wording'"],
    ["a commit message from a here-document", "git commit -F - <<'EOF'\nstorybloq checkpoint resolve\nEOF"],
    ["a title with the bare words as separate arguments", "storybloq ticket create --title checkpoint resolve"],
    ["another checkpoint command", "storybloq checkpoint list"],
    ["another storybloq command that carries the words", "storybloq ticket create --title 'storybloq checkpoint resolve docs'"],
    ["a setup payload that carries the words", "storybloq setup-apply <<'EOF'\n{\"note\":\"storybloq checkpoint resolve\"}\nEOF"],
  ])("%s passes", (_label, command) => {
    expect(graded(command)).toEqual([]);
  });

  it("a nested agent's wrapped resolution fails", () => {
    const nested = { name: "Bash", input: { command: "sh -c 'storybloq checkpoint resolve T-2 --response x'" }, isError: false, result: "", nested: true } as EvalCall;
    expect(rule8([], [nested], null, null)).toEqual(["rule 8: a nested agent resolved a checkpoint (Bash)"]);
  });
});

describe("rule 10 keeps its state through nested shells and argv", () => {
  const ROOT = "/tmp/proj";
  const bash = (command: string) => ledgerWriteFindings([{ name: "Bash", input: { command } }], ROOT);

  it.each([
    ["a nested write after a cd", "cd .story && sh -c 'touch tickets/x.json'", "touch after a cd into .story"],
    ["a nested redirect after a cd", "cd .story && bash -c 'echo x > tickets/x.json'", "a redirection (>) into tickets/x.json"],
    ["two levels of nesting", `cd .story && sh -c "bash -c 'touch x'"`, "touch after a cd into .story"],
    ["a live substitution after a cd", `cd .story && echo "$(touch x)"`, "touch after a cd into .story"],
    ["an expansion that only the outer call names", "F=.story/x; sh -c 'echo y > $F'", "a redirection to an expansion ($F) in a call that names .story"],
    ["node -e with the path in argv", `node -e "require('fs').writeFileSync(process.argv[1],'y')" .story/config.json`, "node inline code with .story in its arguments"],
    ["python -c with the path in argv", `python3 -c "import sys;open(sys.argv[1],'w')" .story/x`, "python3 inline code with .story in its arguments"],
    ["ruby -e with the path in argv", `ruby -e "File.write(ARGV[0],'y')" .story/x`, "ruby inline code with .story in its arguments"],
    ["inline code with an expansion in argv", `F=.story/x; node -e "w(process.argv[1])" "$F"`, "node inline code in a call that names .story"],
    ["inline code reading an exported path", `export TARGET=.story/config.json; node -e 'require("fs").writeFileSync(process.env.TARGET,"{}")'`, "node inline code in a call that names .story"],
    ["inline code reading a prefix assignment", `TARGET=.story/config.json python3 -c "import os;open(os.environ['TARGET'],'w')"`, "python3 inline code in a call that names .story"],
    ["inline code after a cd", `cd .story && ruby -e "File.write('x','y')"`, "ruby after a cd into .story"],
  ])("%s fails", (_label, command, reason) => {
    expect(bash(command).map((f) => f.replace(/^rule 10: call 1: ledger write: /, "").split(": ")[0])).toContain(reason);
  });

  it.each([
    ["a nested write elsewhere", "cd src && sh -c 'touch x'"],
    ["a cd inside a nested shell does not leak out", "sh -c 'cd .story' && touch x"],
    ["inline code with other arguments", `node -e "console.log(process.argv[1])" notes.txt`],
    ["a nested reader after a cd", "cd .story && sh -c 'cat config.json'"],
  ])("%s passes", (_label, command) => {
    expect(bash(command)).toEqual([]);
  });
});

describe("the invocation mapping validates every event's lifecycle", () => {
  const e = (point: string, invocation: string | null = "i1", attempt = "a", extra: Partial<SetupEvent> = {}): SetupEvent => ({ line: 0, attempt, seq: 0, point, setupId: SID, invocation, revision: null, ...extra });
  const start = (invocation = "i1", attempt = "a") => e("invocation-start", invocation, attempt, { kind: "first", argSha256: "d" });
  const end = (invocation = "i1", attempt = "a") => e("invocation-end", invocation, attempt, { exitCode: 0 });
  const logOf = (entry: string, ...events: SetupEvent[]): EventsLog => ({
    attempts: [{ line: 0, attempt: "a", pid: 1, entry }, { line: 0, attempt: "b", pid: 2, entry }] as EventsLog["attempts"],
    events: events.map((x, i) => ({ ...x, line: i + 1, seq: i })),
    overlaps: [],
  });
  const call = (over: Partial<SetupCallRef> = {}): SetupCallRef => ({ turn: 0, call: 0, via: "cli", digest: "d", failed: false, ...over });
  const found = (calls: SetupCallRef[], log: EventsLog) => mapInvocations(calls, log).findings;

  it("a whole lifecycle maps clean, and a killed one needs no end", () => {
    expect(found([call()], logOf("cli", start(), e("step:config"), e("archive-committed"), e("step:archive"), end()))).toEqual([]);
    expect(found([call({ failed: true })], logOf("cli", start(), e("step:config")))).toEqual([]);
  });
  it.each([
    ["a step with no start", [e("step:config")], "mapping: step:config in invocation i1 has no invocation-start in attempt a"],
    ["a skip with no start", [e("skip:config")], "mapping: skip:config in invocation i1 has no invocation-start in attempt a"],
    ["an archive commit with no start", [e("archive-committed")], "mapping: archive-committed in invocation i1 has no invocation-start in attempt a"],
    ["an end with no start", [end()], "mapping: invocation-end in invocation i1 has no invocation-start in attempt a"],
    ["a step before its start", [e("step:config"), start(), end()], "mapping: step:config in invocation i1 has no invocation-start in attempt a"],
    ["a step after the end", [start(), end(), e("step:config")], "mapping: step:config in invocation i1 comes after its invocation-end"],
    ["a second end", [start(), end(), end()], "mapping: invocation-end in invocation i1 comes after its invocation-end"],
    ["a second start", [start(), start(), end()], "mapping: invocation i1 started twice in attempt a"],
    ["a step in another attempt", [start(), e("step:config", "i1", "b"), end()], "mapping: step:config in invocation i1 has no invocation-start in attempt b"],
    ["a step that names no invocation", [start(), e("step:config", null), end()], "mapping: step:config names no invocation"],
    ["an archive commit that names no invocation", [start(), e("archive-committed", null), end()], "mapping: archive-committed names no invocation"],
  ])("%s fails", (_label, events, finding) => {
    const starts = events.filter((x) => x.point === "invocation-start").length;
    expect(found(starts === 0 ? [] : Array.from({ length: starts }, () => call()), logOf("cli", ...events))).toContain(finding);
  });
  it("a CLI call cannot map to an MCP invocation, nor the other way", () => {
    expect(found([call({ via: "cli" })], logOf("mcp", start(), end()))).toEqual(["mapping: turn 1 call 1 went through the cli, but invocation i1 ran in a mcp process"]);
    expect(found([call({ via: "mcp" })], logOf("cli", start(), end()))).toEqual(["mapping: turn 1 call 1 went through the mcp, but invocation i1 ran in a cli process"]);
  });
  it("an invocation in an attempt with no attempt line fails", () => {
    const log = { ...logOf("cli", start("i1", "c"), end("i1", "c")), attempts: [] } as EventsLog;
    expect(found([call()], log)).toEqual(["mapping: invocation i1 ran in attempt c, which has no attempt line"]);
  });
});
