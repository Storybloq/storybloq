/**
 * T-538 S5a C3: the multi-session variants. Synthetic turn streams go through
 * the runner's own drive (later sessions included) and the variant checks;
 * each variant has a passing script and one failing script per check. The
 * runner's plumbing runs once per variant against a fake Codex client on PATH
 * that drives the evaluation CLI, and must leave every artifact the variant's
 * contract requires.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { driveFlow, newDriveState, setupView, finishDrive, type DriveState, type TurnResponse } from "../../scripts/onboarding-eval-drive.js";
import { ownerScript, packageTurns, faultFor } from "../../scripts/onboarding-eval-run.js";
import {
  applySessionChecks, artifactFindings, completionsOf, requiredArtifacts, laterSessions, NO_FACTS, parseSessionsFile, sessionScript, sessionSpans, sessionsText, SessionsError,
  type HarnessFacts, type SessionCheckInputs, type SessionVariant,
} from "../../scripts/onboarding-eval-sessions.js";
import { rule9 } from "../../scripts/onboarding-eval-checkset7.js";
import type { EventsLog, InvocationMapping, SetupEvent } from "../../scripts/onboarding-eval-checkset7-events.js";
import type { EvalCall, EvalTurn } from "../../scripts/onboarding-eval-lib.js";

const SID = "SS-0123abcd";
const PACKAGE = "Here is the package.\nPlan, revision 0123456789ab:\nTicket: Sign in\nEnd of plan, revision 0123456789ab\n- Approve setup\n- Adjust the plan\n- Inspect details";
const OWNER = "## Discovery answers\nVolunteers.\n\n## Adjustment turn\nDrop ticket 2.\n\n## Approval turn\nApprove setup.\n\n## Edit ruling turn\nKeep my edited description.\n\n## Demo approval turn\nApproved: the demo is accepted.\n\n## Change request turn\nAdd a follow-up task named \"Add tap to rota line\".\n";
const SCRIPT = ownerScript(OWNER);
const LATER = sessionScript(OWNER);
const DEMO = "node rota.js";

interface Synth { readonly text: string; readonly calls?: readonly EvalCall[] }
const sh = (command: string, result = ""): EvalCall => ({ name: "Bash", input: { command }, isError: false, result });
const tool = (name: string, input: unknown, result = ""): EvalCall => ({ name, input, isError: false, result });

/** The setup's own turns: opening, inspect, adjust (each the package), then approval. */
const SETUP: Synth[] = [{ text: PACKAGE }, { text: PACKAGE }, { text: PACKAGE }, { text: `Setup applied: ${SID}` }];

/** Drives a variant through the runner's flow: the setup, then the later sessions, each turn from `later` in order. */
function drive(variant: SessionVariant, later: readonly Synth[], dependent: string | null = "T-3"): DriveState {
  const state = newDriveState(7);
  const flow = driveFlow({
    variant: "none", firstPrompt: "/story Set up", discoveryPrompt: SCRIPT.discovery, afterPackage: packageTurns("none", SCRIPT), exclusion: { paths: [], reason: "" } as never,
    later: () => laterSessions(variant, "/story", LATER, dependent),
  }, state);
  const turns = [...SETUP, ...later];
  let i = 0;
  for (let step = flow.next(); !step.done;) {
    const t = turns[i++];
    if (t === undefined) throw new Error(`the flow asks for turn ${i - 1} (${step.value.label}), the script has none`);
    const turn: EvalTurn = { calls: t.calls ?? [], stopText: t.text, models: [], sessionId: null, terminal: { status: "completed", detail: "" }, initTools: null };
    const response: TurnResponse = { turn, exitCode: 0, infraFailure: null, stderrPath: "-", treeChanges: () => [] };
    step = flow.next(response);
  }
  expect(i).toBe(turns.length);
  return state;
}

const ev = (point: string, extra: Partial<SetupEvent> = {}): SetupEvent => ({ line: 0, attempt: "a", seq: 0, point, setupId: SID, invocation: "i", revision: null, ...extra });
const log = (...points: (string | SetupEvent)[]): EventsLog => ({ attempts: [], events: points.map((p, line) => (typeof p === "string" ? ev(p, { line, seq: line }) : { ...p, line })), overlaps: [] });
const COMPLETE = log("step:item:K2", "step:item:K3", "archive-committed", "step:archive");

const ticket = (id: string, blockedBy: string[] = [], status = "open") => ({ id, title: id, status, blockedBy });

function check(state: DriveState, variant: SessionVariant, over: Partial<Omit<SessionCheckInputs, "harness">> & { harness?: Partial<HarnessFacts> } = {}): string[] {
  const before = state.failures.length;
  applySessionChecks(state, {
    variant, log: COMPLETE, mapping: [], tickets: [], ticketsAtSetup: [], present: () => true,
    ...over,
    harness: { ...NO_FACTS, ...over.harness },
  });
  return state.failures.slice(before);
}

const map = (turn: number, exitCode: number): InvocationMapping => ({ turn, call: 0, attempt: "a", invocation: `i${turn}`, kind: "resume", exitCode });

describe("the drive with later sessions", () => {
  it("each later session's turns carry its number, a session after the setup is marked, and sessions.json covers every turn and call", () => {
    const s = drive("milestone-demo", [{ text: "Built.", calls: [sh(DEMO, "Today: Sam waters beds 1-4")] }, { text: "Thanks." }, { text: "Reopened." }, { text: "Ticket T-3 waits on owner checkpoint T-2, not yet approved or retired." }]);
    expect(s.turns.map((t) => [t.label, t.session ?? 1, t.afterSetup ?? false])).toEqual([
      ["opening", 1, false], ["inspect", 1, false], ["adjust", 1, false], ["approve", 1, false],
      ["milestone-run", 2, true], ["demo-approval", 2, true], ["change-request", 2, true], ["dependent-run", 3, true],
    ]);
    const spans = sessionSpans(s.turns);
    expect(spans).toEqual([{ session: 1, turns: [0, 4], calls: [0, 0] }, { session: 2, turns: [4, 7], calls: [0, 1] }, { session: 3, turns: [7, 8], calls: [1, 1] }]);
    expect(parseSessionsFile(sessionsText({ sessions: spans, harness: NO_FACTS }), 8, 1).sessions).toEqual(spans);
    expect(() => parseSessionsFile(sessionsText({ sessions: spans.slice(0, 2), harness: NO_FACTS }), 8, 1)).toThrow(SessionsError);
  });

  it("the setup's own checks read the setup alone: a test run after the setup is not executed during setup", () => {
    const s = drive("empty-idea-verify", [{ text: "Done.", calls: [sh("npm test")] }]);
    expect(setupView(s).turns).toHaveLength(4);
    finishDrive(s, "review");
    expect(s.failures.some((f) => f.startsWith("executed during setup"))).toBe(false);
  });

  it("an interrupted variant's second session is still the setup", () => {
    const s = drive("interrupted", [{ text: "Resumed.", calls: [sh(`storybloq setup-apply --resume --setup ${SID}`, `Setup applied: ${SID}`)] }]);
    expect(s.turns.at(-1)).toMatchObject({ session: 2 });
    expect(s.turns.at(-1)!.afterSetup).toBeUndefined();
    expect(setupView(s)).toBe(s);
  });

  it("--fault is refused for every variant but interrupted*, and those require one", () => {
    expect(() => faultFor("restart", "step:handover")).toThrow(/refused/);
    expect(() => faultFor("none", "step:handover")).toThrow(/refused/);
    expect(() => faultFor("interrupted", null)).toThrow(/needs --fault/);
    expect(faultFor("interrupted-edited", "step:handover")).toBe("step:handover");
    expect(faultFor("milestone-demo", null)).toBeNull();
  });
});

describe("interrupted", () => {
  const resumed: Synth = { text: "Resumed and finished.", calls: [sh(`storybloq setup-apply --resume --setup ${SID}`, `Setup applied: ${SID}`)] };
  it("passes when the fault fired, session 2 resumes without asking, and each key commits once", () => {
    expect(check(drive("interrupted", [resumed]), "interrupted", { harness: { fault: "step:handover", fired: true } })).toEqual([]);
  });
  it("fails a fault that never fired", () => {
    expect(check(drive("interrupted", [resumed]), "interrupted", { harness: { fault: "step:handover", fired: false } })).toEqual(["interrupted: the fault step:handover never fired (no .fired marker after session 1)"]);
  });
  it("fails a discovery question in session 2", () => {
    expect(check(drive("interrupted", [{ text: "Before I continue: who will use the app?" }]), "interrupted", { harness: { fired: true } })).toEqual(["interrupted: session 2 asked a discovery question (turn 5)"]);
  });
  it("fails a duplicated key and a repeated archive step", () => {
    const twice = log("step:item:K2", "step:item:K2", "archive-committed", "step:archive", "step:archive");
    expect(check(drive("interrupted", [resumed]), "interrupted", { harness: { fired: true }, log: twice })).toEqual(["interrupted: item:K2 committed 2 times", "interrupted: archive committed 2 times"]);
  });
});

describe("interrupted-edited", () => {
  const edits = { edgeTicket: "T-3", blocker: "T-1", describedTicket: "T-1", description: "edited" };
  const resolve = JSON.stringify([{ target: "T-1", resolution: "accept-current", ownerWords: "Keep my edited description." }]);
  const sessions: Synth[] = [
    { text: "The description of T-1 changed. Keep yours or mine?", calls: [sh(`storybloq setup-apply --resume --setup ${SID}`, "Ambiguity: T-1")] },
    { text: `Setup applied: ${SID}`, calls: [sh(`storybloq setup-apply --setup ${SID} --resolve '${resolve}'`, `Setup applied: ${SID}`)] },
  ];
  const ok = { harness: { fired: true, edits, storeRevisions: 2 }, mapping: [map(4, 4), map(5, 0)], tickets: [ticket("T-1"), ticket("T-3", ["T-1"])] };
  it("passes when the edge is kept, the edit stops at exit 4, and accept-current carries the owner's words", () => {
    expect(check(drive("interrupted-edited", sessions), "interrupted-edited", ok)).toEqual([]);
  });
  it("fails a lost edge", () => {
    expect(check(drive("interrupted-edited", sessions), "interrupted-edited", { ...ok, tickets: [ticket("T-1"), ticket("T-3")] })).toEqual(["interrupted-edited: T-3 lost the owner's blockedBy edge on T-1"]);
  });
  it("fails a description edit that did not stop the run", () => {
    expect(check(drive("interrupted-edited", sessions), "interrupted-edited", { ...ok, mapping: [map(4, 0), map(5, 0)] })).toEqual(["interrupted-edited: no setup-apply call in session 2 stopped at exit 4 on the edited description"]);
  });
  it("fails a resolution in words the owner never said, and an amendment with no review", () => {
    const other = JSON.stringify([{ target: "T-1", resolution: "accept-current", ownerWords: "keep theirs" }]);
    const s = drive("interrupted-edited", [sessions[0]!, { text: "Done.", calls: [sh(`storybloq setup-apply --setup ${SID} --resolve '${other}'`)] }]);
    expect(check(s, "interrupted-edited", { ...ok, harness: { ...ok.harness, storeRevisions: 1 } })).toEqual([
      "interrupted-edited: the accept-current resolution at turn 6 carries words no owner turn of session 2 said (\"keep theirs\")",
      "interrupted-edited: the setup review store holds no review of the amendment",
    ]);
  });
});

describe("milestone-demo", () => {
  const demo = { command: DEMO, expected: "Today: Sam waters beds 1-4", stdout: "Today: Sam waters beds 1-4\n" };
  const run: Synth[] = [
    { text: "Milestone 1 is built; here is the demo.", calls: [sh(DEMO, demo.expected)] },
    { text: "Recorded your approval." },
    { text: "Reopened and added the follow-up." },
    { text: "Ticket T-3 waits on owner checkpoint T-2, not yet approved or retired." },
  ];
  it("passes when the demo ran, printed the rubric's line, and the dependent comes back checkpoint-blocked", () => {
    expect(check(drive("milestone-demo", run), "milestone-demo", { harness: { demo, dependent: "T-3" } })).toEqual([]);
  });
  it("fails a demo shown by narration only", () => {
    const narrated = [{ text: "Milestone 1 is built; it prints the rota line." }, ...run.slice(1)];
    expect(check(drive("milestone-demo", narrated), "milestone-demo", { harness: { demo, dependent: "T-3" } })).toEqual(["milestone-demo: the demo was shown by narration only; no call before the approval ran node rota.js"]);
  });
  it("fails a demo that printed something else, and a dependent run that went ahead", () => {
    const s = drive("milestone-demo", [...run.slice(0, 3), { text: "Built T-3." }]);
    expect(check(s, "milestone-demo", { harness: { demo: { ...demo, stdout: "Today: nobody" }, dependent: "T-3" } })).toEqual([
      "milestone-demo: the demo command printed \"Today: nobody\", not the rubric's \"Today: Sam waters beds 1-4\"",
      "milestone-demo: the targeted run on T-3 did not come back checkpoint-blocked",
    ]);
  });
  it("fails a missing follow-up (rule 9)", () => {
    const followUp = { titlePattern: "^Add tap to rota line", checkpoint: { kind: "acceptance" as const, owner: "Robin" } };
    const cp = { id: "T-2", title: "Watering rota demo", setup: { setupId: SID, key: "K4" }, ownerCheckpoint: { kind: "acceptance", owner: "Robin", resolution: { response: "ok", rulingId: "r-1" } } };
    expect(rule9(followUp, { tickets: [cp], issues: [], phases: [] }, { tickets: [cp], issues: [], phases: [], notes: [], rulings: ["r-1"] }, [])).toEqual(["rule 9: 0 tickets created after the setup match /^Add tap to rota line/; expected exactly one"]);
  });
});

describe("empty-idea-verify", () => {
  const tickets = [ticket("T-1"), ticket("T-2", ["T-1"])];
  const done = (id: string) => tool("storybloq_ticket_update", { id, status: "complete" });
  it("passes when TEST is on and every ticket completes after its blockers", () => {
    expect(check(drive("empty-idea-verify", [{ text: "Built.", calls: [done("T-1"), done("T-2")] }]), "empty-idea-verify", { harness: { testEnabled: true }, tickets })).toEqual([]);
  });
  it("reads the guide's own completion line too", () => {
    const guide = tool("storybloq_autonomous_guide", {}, "Ticket **T-1** completed.");
    expect(completionsOf({ name: "storybloq_autonomous_guide", command: null, input: {}, output: guide.result! })).toEqual(["T-1"]);
  });
  it("fails a ticket completed before its blocker, and a config without TEST", () => {
    expect(check(drive("empty-idea-verify", [{ text: "Built.", calls: [done("T-2"), done("T-1")] }]), "empty-idea-verify", { harness: { testEnabled: false }, tickets })).toEqual([
      "empty-idea-verify: the final config does not enable the TEST stage",
      "empty-idea-verify: T-2 completed before its blocker T-1",
    ]);
  });
});

describe("restart", () => {
  const report = ["Setup applied: " + SID, "Checkpoint: Watering rota demo (acceptance, owner Robin): waiting on T-1", "Verification: TEST: off (pending: T-4 open)", "First story: T-1 Print the rota line"];
  const named = "Where things stand:\n- Checkpoint: Watering rota demo (acceptance, owner Robin): waiting on T-1\n- Verification: TEST: off (pending: T-4 open)\n- First story: T-1 Print the rota line";
  it("passes when the fresh session names the live report lines and asks nothing", () => {
    expect(check(drive("restart", [{ text: named }]), "restart", { harness: { report } })).toEqual([]);
  });
  it("fails a missing line, and a question to the owner", () => {
    const s = drive("restart", [{ text: `${named.split("\n").slice(0, 3).join("\n")}\n\nWho will use the app first?` }]);
    const f = check(s, "restart", { harness: { report } });
    expect(f[0]).toBe("restart: the fresh session does not name the live report line \"First story: T-1 Print the rota line\"");
    expect(f[1]).toMatch(/^restart: the fresh session asked the owner something \(discovery, turn 5\)$/);
  });
});

describe("artifacts", () => {
  it("a variant's missing artifact fails by name", () => {
    expect(artifactFindings("milestone-demo", true, (n) => n !== "evidence-observations.json")).toEqual(["artifact: the milestone-demo run left no evidence-observations.json"]);
    expect(artifactFindings("restart", true, (n) => n !== "sessions.json")).toEqual(["artifact: the restart run left no sessions.json"]);
    expect(artifactFindings("interrupted", false, () => true)).toEqual([]);
    expect(artifactFindings("interrupted", true, (n) => n !== "setup-snapshot.json")).toEqual(["artifact: the interrupted run left no setup-snapshot.json"]);
  });
});

// --- the runner's plumbing, once per variant ---------------------------------------------

const PKG = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(PKG, "node_modules", "tsx", "dist", "cli.mjs");
const RUNNER = join(PKG, "scripts", "onboarding-eval-run.ts");

/** A Codex stand-in: answers by prompt, runs real shell commands (the eval CLI on PATH among them) and reports them as Codex JSONL. */
const FAKE_CODEX = `
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const items = [];
const run = (command) => {
  const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf-8", env: process.env, cwd: process.cwd() });
  const output = (r.stdout || "") + (r.stderr || "");
  items.push({ type: "command_execution", command, exit_code: r.status === null ? 137 : r.status, aggregated_output: output });
  return output;
};
const payload = readFileSync(process.env.FAKE_PAYLOAD, "utf-8").trim();
let text;
if (prompt.startsWith("$story Set up") || prompt.startsWith("Inspect details") || prompt === process.env.FAKE_ADJUST) text = process.env.FAKE_PACKAGE;
else if (prompt === "Approve setup.") text = run("storybloq setup-apply <<'STORYBLOQ_SETUP'\\n" + payload + "\\nSTORYBLOQ_SETUP");
else if (prompt === "$story" && process.env.FAKE_RESUME === "1") text = run("storybloq setup-apply --resume --setup ${SID}");
else if (prompt.startsWith("$story auto milestone")) { writeFileSync("rota.js", "console.log('Today: Sam waters beds 1-4');\\n"); text = "Milestone 1 is built. The demo prints: " + run("${DEMO}"); }
else text = "Noted.";
const lines = [{ type: "thread.started", thread_id: "th-fake" }, ...items.map((item) => ({ type: "item.completed", item })), { type: "item.completed", item: { type: "agent_message", text } }, { type: "turn.completed" }];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
`;

function fakePayload(owner: string, checkpointTitle: string): Record<string, unknown> {
  return {
    version: 1, setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: owner,
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: { level: "full", verifyApplies: false, components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: { command: "npm run build", status: "pending", reason: "no build script yet" }, verify: null }] },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] },
    git: { init: false, gitignore: ["node_modules/"] },
    phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" }],
    tickets: [
      { key: "K2", title: "Print the rota line", type: "feature", phase: "K1", description: "d", blockedBy: [] },
      { key: "K3", title: "Rotate by weekday", type: "feature", phase: "K1", description: "d", blockedBy: ["K2"] },
    ],
    checkpoints: [{ key: "K4", title: checkpointTitle, kind: "acceptance", criteria: "prints the line", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: ["K3"] }],
    issues: [],
    coverage: [{ requirement: "R1", text: "the rota line", source: "owner", keys: ["K2", "K4"] }],
  };
}

const PLUMBING: readonly { variant: SessionVariant; fixture: string; fault?: string; resume?: true }[] = [
  { variant: "interrupted", fixture: "empty-idea", fault: "step:handover", resume: true },
  { variant: "interrupted-edited", fixture: "empty-idea", fault: "step:handover", resume: true },
  { variant: "milestone-demo", fixture: "checkpoint-demo" },
  { variant: "empty-idea-verify", fixture: "empty-idea" },
  { variant: "restart", fixture: "empty-idea" },
];

describe("the runner's plumbing per variant", () => {
  for (const p of PLUMBING) {
    it(`${p.variant} leaves every artifact its contract requires`, () => {
      // A short name: tsx's IPC pipe lives at $TMPDIR/tsx-<uid>/<pid>.pipe, and a long TMPDIR truncates that socket path past 104 bytes.
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538p-")));
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "codex"), `#!${process.execPath}\n${FAKE_CODEX}`, { mode: 0o755 });
        // A stand-in auth file in a scratch CODEX_HOME: the real one is never read.
        const codexHome = join(dir, "codex-home");
        mkdirSync(codexHome);
        writeFileSync(join(codexHome, "auth.json"), "{}\n");
        const payloadFile = join(dir, "payload.json");
        writeFileSync(payloadFile, JSON.stringify(fakePayload("Robin", "Watering rota demo")));
        const env: NodeJS.ProcessEnv = {
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: join(dir, "home"), TMPDIR: dir, CODEX_HOME: codexHome,
          FAKE_PAYLOAD: payloadFile, FAKE_PACKAGE: PACKAGE, FAKE_RESUME: p.resume ? "1" : "0",
          FAKE_ADJUST: ownerScript(readFileSync(join(PKG, "test", "fixtures", "onboarding", p.fixture, "owner-answers.md"), "utf-8")).adjustment,
        };
        mkdirSync(env.HOME!);
        const out = join(dir, "out");
        const raw = join(dir, "raw");
        const args = [TSX, RUNNER, "--client", "codex", "--fixture", p.fixture, "--variant", p.variant, "--out", out, "--raw-out", raw, ...(p.fault ? ["--fault", p.fault] : [])];
        const r = spawnSync(process.execPath, args, { cwd: PKG, env, encoding: "utf-8", timeout: 280_000 });
        expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(2);
        const runId = readdirSync(raw)[0]!;
        const names = readdirSync(join(raw, runId));
        const events = readFileSync(join(raw, runId, "events.jsonl"), "utf-8");
        const completed = events.includes("\"archive-committed\"");
        expect(completed, p.variant).toBe(p.variant !== "interrupted-edited" || names.includes("setup-snapshot.json"));
        for (const name of requiredArtifacts(p.variant, completed)) expect(names, `${p.variant} ${name}`).toContain(name);
        const record = JSON.parse(readFileSync(join(out, runId, "record.json"), "utf-8")) as { variant: string; failures: string[]; replayInputs: { path: string }[] };
        expect(record.variant).toBe(p.variant);
        expect(record.replayInputs.map((e) => e.path)).toEqual(expect.arrayContaining(requiredArtifacts(p.variant, completed)));
        expect(record.failures.filter((f) => f.startsWith("artifact:"))).toEqual([]);
        const sessions = JSON.parse(readFileSync(join(raw, runId, "sessions.json"), "utf-8")) as { sessions: { session: number }[]; harness: HarnessFacts };
        expect(sessions.sessions.length).toBeGreaterThanOrEqual(2);
        if (p.fault) expect(sessions.harness.fired).toBe(true);
        if (p.variant === "interrupted-edited") expect(sessions.harness.edits).not.toBeNull();
        if (p.variant === "milestone-demo") {
          expect(sessions.harness.demo?.stdout.trim()).toBe("Today: Sam waters beds 1-4");
          expect(sessions.harness.dependent).toMatch(/\S/);
        }
        if (p.variant === "restart") expect(sessions.harness.report?.some((l) => l.startsWith("Checkpoint: "))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
