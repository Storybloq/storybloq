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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { driveFlow, newDriveState, setupView, finishDrive, type DriveState, type TurnResponse } from "../../scripts/onboarding-eval-drive.js";
import { archiveProject, ARCHIVE_OMITTED_FILE, ownerScript, packageTurns, faultFor, spawnedResult } from "../../scripts/onboarding-eval-run.js";
import {
  applySessionChecks, demoFacts, artifactFindings, attemptBypass, completionsOf, ledgerDigest, requiredArtifacts, laterSessions, NO_FACTS, parseSessionsFile, sessionScript, sessionSpans, sessionsText, SessionsError,
  type BypassAttempt, type HarnessFacts, type SessionCheckInputs, type SessionVariant,
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
    expect(check(drive("interrupted", [resumed]), "interrupted", { mapping: [map(4, 0)], harness: { fault: "step:handover", fired: true } })).toEqual([]);
  });
  it("fails a fault that never fired", () => {
    expect(check(drive("interrupted", [resumed]), "interrupted", { mapping: [map(4, 0)], harness: { fault: "step:handover", fired: false } })).toEqual(["interrupted: the fault step:handover never fired (no .fired marker after session 1)"]);
  });
  it("fails a discovery question in session 2", () => {
    expect(check(drive("interrupted", [{ text: "Before I continue: who will use the app?" }]), "interrupted", { mapping: [map(4, 0)], harness: { fired: true } })).toEqual(["interrupted: session 2 asked a discovery question (turn 5)"]);
  });
  it("fails a duplicated key and a repeated archive step", () => {
    const twice = log("step:item:K2", "step:item:K2", "archive-committed", "step:archive", "step:archive");
    expect(check(drive("interrupted", [resumed]), "interrupted", { mapping: [map(4, 0)], harness: { fired: true }, log: twice })).toEqual(["interrupted: item:K2 committed 2 times", "interrupted: archive committed 2 times"]);
  });
  it("fails a retry that finished the setup in session 1, with session 2 doing nothing", () => {
    expect(check(drive("interrupted", [{ text: "Nothing to do." }]), "interrupted", { mapping: [{ ...map(2, 0), exitCode: null }, map(3, 0)], harness: { fired: true } })).toEqual([
      "interrupted: session 1 finished the setup itself (turn 4), so the resume was never exercised",
      "interrupted: no setup-apply call in session 2 finished the setup",
    ]);
  });
  it("fails a session 2 whose resume did not finish", () => {
    expect(check(drive("interrupted", [resumed]), "interrupted", { mapping: [map(4, 7)], harness: { fired: true } })).toEqual(["interrupted: no setup-apply call in session 2 finished the setup"]);
  });
});

describe("interrupted-edited", () => {
  const edits = { edgeTicket: "T-3", blocker: "T-1", describedTicket: "T-1", description: "edited" };
  const resolve = JSON.stringify([{ target: "K2 (T-1)", resolution: "accept-current", ownerWords: "Keep my edited description." }]);
  const described = { ...ticket("T-1"), description: "edited" };
  const sessions: Synth[] = [
    { text: "The description of T-1 changed. Keep yours or mine?", calls: [sh(`storybloq setup-apply --resume --setup ${SID}`, "Ambiguity: T-1")] },
    { text: `Setup applied: ${SID}`, calls: [sh(`storybloq setup-apply --setup ${SID} --resolve '${resolve}'`, `Setup applied: ${SID}`)] },
  ];
  const ok = { harness: { fired: true, edits, storeRevisions: 2 }, mapping: [map(4, 4), map(5, 0)], tickets: [described, ticket("T-3", ["T-1"])] };
  it("passes when the edge is kept, the edit stops at exit 4, and accept-current carries the owner's words", () => {
    expect(check(drive("interrupted-edited", sessions), "interrupted-edited", ok)).toEqual([]);
  });
  it("fails a lost edge", () => {
    expect(check(drive("interrupted-edited", sessions), "interrupted-edited", { ...ok, tickets: [described, ticket("T-3")] })).toEqual(["interrupted-edited: T-3 lost the owner's blockedBy edge on T-1"]);
  });
  it("fails a description edit that did not stop the run", () => {
    expect(check(drive("interrupted-edited", sessions), "interrupted-edited", { ...ok, mapping: [map(4, 0), map(5, 0)] })).toEqual(["interrupted-edited: no setup-apply call in session 2 stopped at exit 4 on the edited description"]);
  });
  it("fails a resolution in words the owner never said, and an amendment with no review", () => {
    const other = JSON.stringify([{ target: "K2 (T-1)", resolution: "accept-current", ownerWords: "keep theirs" }]);
    const s = drive("interrupted-edited", [sessions[0]!, { text: "Done.", calls: [sh(`storybloq setup-apply --setup ${SID} --resolve '${other}'`)] }]);
    expect(check(s, "interrupted-edited", { ...ok, harness: { ...ok.harness, storeRevisions: 1 } })).toEqual([
      "interrupted-edited: the accept-current resolution at turn 6 carries words no owner turn of session 2 said (\"keep theirs\")",
      "interrupted-edited: the setup review store holds no review of the amendment",
    ]);
  });
  it("fails a final description that is not the owner's edit", () => {
    expect(check(drive("interrupted-edited", sessions), "interrupted-edited", { ...ok, tickets: [{ ...described, description: "restored" }, ticket("T-3", ["T-1"])] })).toEqual(["interrupted-edited: T-1's final description is not the owner's edit"]);
    expect(check(drive("interrupted-edited", sessions), "interrupted-edited", { ...ok, tickets: [ticket("T-3", ["T-1"])] })).toEqual(["interrupted-edited: T-1's final description is not the owner's edit"]);
  });
  it("fails accept-current on any target but the edited tickets", () => {
    const elsewhere = JSON.stringify([{ target: "K9 (T-9)", resolution: "accept-current", ownerWords: "Keep my edited description." }]);
    const s = drive("interrupted-edited", [sessions[0]!, { text: "Done.", calls: [sh(`storybloq setup-apply --setup ${SID} --resolve '${elsewhere}'`)] }]);
    expect(check(s, "interrupted-edited", ok)).toEqual([
      "interrupted-edited: session 2 never resolved the edited description with accept-current",
      "interrupted-edited: the accept-current resolution at turn 6 targets K9 (T-9), which the harness did not edit",
    ]);
  });
  it("accepts the owner's edge edit too", () => {
    const both = JSON.stringify([{ target: "K2 (T-1)", resolution: "accept-current", ownerWords: "Keep my edited description." }, { target: "K3 (T-3)", resolution: "accept-current", ownerWords: "Keep my edited description." }]);
    const s = drive("interrupted-edited", [sessions[0]!, { text: "Done.", calls: [sh(`storybloq setup-apply --setup ${SID} --resolve '${both}'`)] }]);
    expect(check(s, "interrupted-edited", ok)).toEqual([]);
  });
});

describe("milestone-demo", () => {
  const demo = { command: DEMO, expected: "Today: Sam waters beds 1-4", stdout: "Today: Sam waters beds 1-4\n", status: 0, signal: null, error: null };
  const run: Synth[] = [
    { text: "Milestone 1 is built; here is the demo.", calls: [sh(DEMO, demo.expected)] },
    { text: "Recorded your approval." },
    { text: "Reopened and added the follow-up." },
    { text: "Ticket T-3 waits on owner checkpoint T-2, not yet approved or retired." },
  ];
  const refused: BypassAttempt = { ticket: "T-3", exitCode: 1, output: ["storybloq: skill files not refreshed", "Cannot update T-3: it waits on owner checkpoint T-2, not yet approved or retired."], ledgerChanged: false };
  it("passes when the demo ran, printed the rubric's line, and the dependent comes back checkpoint-blocked", () => {
    expect(check(drive("milestone-demo", run), "milestone-demo", { harness: { demo, dependent: "T-3", bypass: refused } })).toEqual([]);
  });
  it("fails a demo shown by narration only", () => {
    const narrated = [{ text: "Milestone 1 is built; it prints the rota line." }, ...run.slice(1)];
    expect(check(drive("milestone-demo", narrated), "milestone-demo", { harness: { demo, dependent: "T-3", bypass: refused } })).toEqual(["milestone-demo: the demo was shown by narration only; no call before the approval ran node rota.js"]);
  });
  it("fails a demo that printed something else, and a dependent run that went ahead", () => {
    const s = drive("milestone-demo", [...run.slice(0, 3), { text: "Built T-3." }]);
    expect(check(s, "milestone-demo", { harness: { demo: { ...demo, stdout: "Today: nobody" }, dependent: "T-3", bypass: refused } })).toEqual([
      "milestone-demo: the demo command printed \"Today: nobody\", not the rubric's \"Today: Sam waters beds 1-4\"",
      "milestone-demo: the targeted run on T-3 did not come back checkpoint-blocked",
    ]);
  });
  it.each([
    ["a non-zero exit", { status: 1 }, "status 1, signal none, error none"],
    ["a signal", { status: null, signal: "SIGKILL" }, "status none, signal SIGKILL, error none"],
    ["a spawn error", { status: null, error: "spawnSync /bin/sh ETIMEDOUT" }, "status none, signal none, error spawnSync /bin/sh ETIMEDOUT"],
    ["a record with no status", { status: undefined }, "status none, signal none, error none"],
  ])("fails a demo with the right stdout and %s", (_label, over, detail) => {
    expect(check(drive("milestone-demo", run), "milestone-demo", { harness: { demo: { ...demo, ...over } as never, dependent: "T-3", bypass: refused } })).toEqual([`milestone-demo: the demo command did not exit 0 (${detail})`]);
  });
  it("records what the demo's process did", () => {
    expect(demoFacts("c", "e", { status: 3, signal: null, stdout: "x" })).toEqual({ command: "c", expected: "e", stdout: "x", status: 3, signal: null, error: null });
    expect(demoFacts("c", "e", { status: null, signal: "SIGTERM", stdout: null, error: new Error("boom") })).toEqual({ command: "c", expected: "e", stdout: "", status: null, signal: "SIGTERM", error: "boom" });
  });
  it("fails a status update that never exited, even with the checkpoint's words and an unchanged ledger", () => {
    const s = drive("milestone-demo", run);
    const with_ = (bypass: BypassAttempt) => check(s, "milestone-demo", { harness: { demo, dependent: "T-3", bypass } });
    expect(with_({ ...refused, exitCode: null, signal: "SIGKILL" })).toEqual(["milestone-demo: the status update on T-3 did not exit (signal SIGKILL, error none)"]);
    expect(with_({ ...refused, exitCode: null, error: "spawnSync ETIMEDOUT" })).toEqual(["milestone-demo: the status update on T-3 did not exit (signal none, error spawnSync ETIMEDOUT)"]);
    expect(with_({ ...refused, exitCode: null })).toEqual(["milestone-demo: the status update on T-3 did not exit (signal none, error none)"]);
  });
  it("a process killed by a signal or never started reaches the record as no exit status, with how it ended", () => {
    const story = join(realpathSync(mkdtempSync(join(tmpdir(), "t538b-"))), ".story");
    try {
      mkdirSync(story);
      const killed = attemptBypass(story, "T-3", () => spawnedResult(spawnSync("/bin/sh", ["-c", "kill -KILL $$"], { encoding: "utf-8" })));
      expect(killed).toMatchObject({ exitCode: null, signal: "SIGKILL" });
      const missing = attemptBypass(story, "T-3", () => spawnedResult(spawnSync("/nonexistent/storybloq", [], { encoding: "utf-8" })));
      expect(missing.exitCode).toBeNull();
      expect(missing.error).toMatch(/ENOENT/);
    } finally {
      rmSync(dirname(story), { recursive: true, force: true });
    }
  });
  describe("a ledger the turn left hostile", () => {
    const withStory = (build: (story: string, root: string) => void, check: (story: string) => void): void => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "t538l-")));
      const story = join(root, ".story");
      try {
        mkdirSync(join(story, "tickets"), { recursive: true });
        writeFileSync(join(story, "tickets", "T-3.json"), "{}\n");
        build(story, root);
        check(story);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    const inTime = (argv: readonly string[]): string => {
      // A FIFO would block a plain read for ever, so the digest runs in a child with a deadline.
      const r = spawnSync(process.execPath, [TSX, "-e", `import(${JSON.stringify(join(PKG, "scripts", "onboarding-eval-sessions.ts"))}).then((m) => console.log(JSON.stringify(m.ledgerState(${JSON.stringify(argv[0])}))))`], { encoding: "utf-8", timeout: 30_000, env: process.env });
      expect(r.status, `${String(r.signal)} ${r.stderr}`).toBe(0);
      return r.stdout.trim().split("\n").at(-1)!;
    };
    it("the file read opens no link and waits on no FIFO, whatever an earlier look at the name said", () => {
      withStory((story, root) => {
        writeFileSync(join(root, "plain.txt"), "x\n");
        symlinkSync(join(root, "plain.txt"), join(story, "link"));
        expect(spawnSync("/usr/bin/mkfifo", [join(story, "pipe")]).status).toBe(0);
      }, (story) => {
        const r = spawnSync(process.execPath, [TSX, "-e", `import(${JSON.stringify(join(PKG, "scripts", "onboarding-eval-sessions.ts"))}).then((m) => { console.log(JSON.stringify([m.regularFileDigest(${JSON.stringify(join(story, "link"))}), m.regularFileDigest(${JSON.stringify(join(story, "pipe"))}), m.regularFileDigest(${JSON.stringify(join(dirname(story), "plain.txt"))})])); process.exit(0); })`], { encoding: "utf-8", timeout: 30_000, env: process.env });
        expect(r.status, `${String(r.signal)} ${r.stderr}`).toBe(0);
        const [link, pipe, plain] = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as (string | null)[];
        expect(link).toBeNull();
        expect(pipe).toBeNull();
        expect(plain).toMatch(/^[0-9a-f]{64}$/);
      });
    });
    it("a link to a file outside is recorded by its target, its bytes never read", () => {
      withStory((story, root) => {
        writeFileSync(join(root, "outside.txt"), "one\n");
        symlinkSync(join(root, "outside.txt"), join(story, "tickets", "out.json"));
      }, (story) => {
        const before = ledgerDigest(story);
        writeFileSync(join(dirname(story), "outside.txt"), "two\n");
        expect(ledgerDigest(story)).toBe(before);
        rmSync(join(story, "tickets", "out.json"));
        symlinkSync("/elsewhere", join(story, "tickets", "out.json"));
        expect(ledgerDigest(story)).not.toBe(before);
      });
    });
    it("a link to a folder outside is not walked", () => {
      withStory((story, root) => {
        mkdirSync(join(root, "outside"));
        writeFileSync(join(root, "outside", "a.txt"), "one\n");
        symlinkSync(join(root, "outside"), join(story, "outside"));
      }, (story) => {
        const before = ledgerDigest(story);
        writeFileSync(join(dirname(story), "outside", "a.txt"), "two\n");
        expect(ledgerDigest(story)).toBe(before);
      });
    });
    it("a folder cycle ends, with no finding", () => {
      withStory((story) => { symlinkSync("..", join(story, "tickets", "loop")); }, (story) => {
        expect(JSON.parse(inTime([story])).problems).toEqual([]);
      });
    });
    it("a .story that is itself a link is not walked", () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "t538l-")));
      try {
        mkdirSync(join(root, "real"));
        writeFileSync(join(root, "real", "a.txt"), "one\n");
        symlinkSync(join(root, "real"), join(root, ".story"));
        const before = ledgerDigest(join(root, ".story"));
        writeFileSync(join(root, "real", "a.txt"), "two\n");
        expect(ledgerDigest(join(root, ".story"))).toBe(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it("a FIFO never blocks, and is reported, and the check fails on it", () => {
      withStory((story) => { expect(spawnSync("/usr/bin/mkfifo", [join(story, "tickets", "pipe.json")]).status).toBe(0); }, (story) => {
        expect(JSON.parse(inTime([story])).problems).toEqual(["tickets/pipe.json is not a regular file, a folder or a link"]);
        const attempt = attemptBypass(story, "T-3", () => ({ status: 1, stdout: "", stderr: "it waits on owner checkpoint T-2\n" }));
        expect(attempt.ledgerProblems).toEqual(["tickets/pipe.json is not a regular file, a folder or a link"]);
        expect(check(drive("milestone-demo", run), "milestone-demo", { harness: { demo, dependent: "T-3", bypass: attempt } })).toEqual(["milestone-demo: the ledger could not be read as evidence: tickets/pipe.json is not a regular file, a folder or a link"]);
      });
    });
  });
  it("the bypass record keeps how the process ended", () => {
    const story = join(realpathSync(mkdtempSync(join(tmpdir(), "t538b-"))), ".story");
    try {
      mkdirSync(story);
      expect(attemptBypass(story, "T-3", () => ({ status: null, signal: "SIGTERM", error: new Error("boom"), stdout: "", stderr: "" }))).toMatchObject({ exitCode: null, signal: "SIGTERM", error: "boom" });
    } finally {
      rmSync(dirname(story), { recursive: true, force: true });
    }
  });
  it("fails a status update that went around the checkpoint, one refused for another reason, one that wrote, and none at all", () => {
    const s = drive("milestone-demo", run);
    const with_ = (bypass: BypassAttempt | null) => check(s, "milestone-demo", { harness: { demo, dependent: "T-3", bypass } });
    expect(with_({ ...refused, exitCode: 0, output: ["Updated T-3"] })).toEqual(["milestone-demo: the status update completing T-3 went through"]);
    expect(with_({ ...refused, output: ["storybloq: skill files not refreshed", "Ticket T-3 not found"] })).toEqual(["milestone-demo: the status update on T-3 was refused for another reason (\"storybloq: skill files not refreshed | Ticket T-3 not found\")"]);
    expect(with_({ ...refused, ledgerChanged: true })).toEqual(["milestone-demo: the status update on T-3 changed the ledger"]);
    expect(with_(null)).toEqual(["milestone-demo: the harness made no status-update attempt on T-3"]);
  });
  it("fails a missing follow-up (rule 9)", () => {
    const followUp = { titlePattern: "^Add tap to rota line", checkpoint: { kind: "acceptance" as const, owner: "Robin" } };
    const cp = { id: "T-2", title: "Watering rota demo", setup: { setupId: SID, key: "K4" }, ownerCheckpoint: { kind: "acceptance", owner: "Robin", resolution: { response: "ok", rulingId: "r-1" } } };
    expect(rule9(followUp, { tickets: [cp], issues: [], phases: [] }, { tickets: [cp], issues: [], phases: [], notes: [], rulings: ["r-1"] }, [])).toEqual(["rule 9: 0 tickets created after the setup match /^Add tap to rota line/; expected exactly one"]);
  });
});

describe("empty-idea-verify", () => {
  const atSetup = [{ ...ticket("T-1"), setup: { setupId: SID, key: "K2", establishes: { component: "root", stage: "test", scaffold: "K1" } } }, ticket("T-2", ["T-1"]), ticket("T-9")];
  const finished = [ticket("T-1", [], "complete"), ticket("T-2", ["T-1"], "complete"), ticket("T-9")];
  const inputs = { harness: { testEnabled: true }, ticketsAtSetup: atSetup, tickets: finished };
  const done = (id: string) => tool("storybloq_ticket_update", { id, status: "complete" }, "Updated");
  const built = (...calls: EvalCall[]) => drive("empty-idea-verify", [{ text: "Built.", calls }]);
  const NO_T1 = "empty-idea-verify: establishment ticket T-1 never completed successfully in session 2";
  const NO_T2 = "empty-idea-verify: T-2, which waits on establishment ticket T-1, never completed successfully in session 2";
  it("passes when TEST is on and the establishment ticket then its dependent complete", () => {
    expect(check(built(done("T-1"), done("T-2")), "empty-idea-verify", inputs)).toEqual([]);
  });
  it("reads the guide's own completion line too", () => {
    const guide = tool("storybloq_autonomous_guide", {}, "Ticket **T-1** completed.");
    expect(completionsOf({ name: "storybloq_autonomous_guide", command: null, input: {}, output: guide.result! })).toEqual(["T-1"]);
    expect(check(built(guide, done("T-2")), "empty-idea-verify", inputs)).toEqual([]);
  });
  it("fails a run that completed nothing", () => {
    expect(check(built(), "empty-idea-verify", inputs)).toEqual([NO_T1, NO_T2]);
  });
  it("fails a completion of an unrelated ticket", () => {
    expect(check(built(done("T-9")), "empty-idea-verify", inputs)).toEqual([NO_T1, NO_T2]);
  });
  it("fails the establishment ticket alone", () => {
    expect(check(built(done("T-1")), "empty-idea-verify", inputs)).toEqual([NO_T2]);
  });
  it("fails evidence that disagrees with the final ledger", () => {
    const reopened = [ticket("T-1", [], "complete"), ticket("T-2", ["T-1"], "open"), ticket("T-9")];
    expect(check(built(done("T-1"), done("T-2")), "empty-idea-verify", { ...inputs, tickets: reopened })).toEqual(["empty-idea-verify: T-2 completed in session 2, but its final status is open"]);
    expect(check(built(done("T-1"), done("T-2")), "empty-idea-verify", { ...inputs, tickets: [ticket("T-2", ["T-1"], "complete")] })).toEqual(["empty-idea-verify: T-1 completed in session 2, but its final status is missing"]);
  });
  it("fails a snapshot with no establishment ticket, and one with nothing waiting on it", () => {
    expect(check(built(done("T-1"), done("T-2")), "empty-idea-verify", { ...inputs, ticketsAtSetup: [ticket("T-1"), ticket("T-2", ["T-1"])] })).toEqual(["empty-idea-verify: the setup snapshot holds no establishment ticket"]);
    expect(check(built(done("T-1")), "empty-idea-verify", { ...inputs, ticketsAtSetup: [atSetup[0]!], tickets: [finished[0]!] })).toEqual(["empty-idea-verify: nothing in the setup snapshot waits on establishment ticket T-1"]);
  });
  it("does not count a failed status update as a completion", () => {
    const failed = { ...done("T-1"), isError: true };
    expect(check(built(failed, done("T-2")), "empty-idea-verify", inputs)).toEqual(["empty-idea-verify: T-2 completed before its blocker T-1", NO_T1]);
    const unanswered = tool("storybloq_ticket_update", { id: "T-1", status: "complete" });
    expect(check(built(unanswered), "empty-idea-verify", inputs)).toEqual([NO_T1, NO_T2]);
    const cli = { ...sh("storybloq ticket update T-1 --status complete", "Error: refused"), isError: true };
    expect(check(built(cli), "empty-idea-verify", inputs)).toEqual([NO_T1, NO_T2]);
  });
  it("fails a ticket completed before its blocker, and a config without TEST", () => {
    expect(check(built(done("T-2"), done("T-1")), "empty-idea-verify", { ...inputs, harness: { testEnabled: false } })).toEqual([
      "empty-idea-verify: the final config does not enable the TEST stage",
      "empty-idea-verify: T-2 completed before its blocker T-1",
    ]);
  });
  it("holds the snapshot's order even when the final ledger lost the edge", () => {
    const edgeless = [ticket("T-1", [], "complete"), ticket("T-2", [], "complete")];
    expect(check(built(done("T-2"), done("T-1")), "empty-idea-verify", { ...inputs, tickets: edgeless })).toEqual(["empty-idea-verify: T-2 completed before its blocker T-1"]);
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
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
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
else if (prompt.startsWith("$story auto milestone")) { if (process.env.FAKE_KILL_BYPASS === "1") run("L=$(command -v storybloq); cp \\"$L\\" \\"$L.real\\"; printf '%s\\\\n' '#!/bin/sh' 'case \\"$*\\" in \\"ticket update \\"*\\"--status complete\\"*) echo \\"it waits on owner checkpoint T-2\\" >&2; kill -KILL $$;; esac' 'exec \\"$0.real\\" \\"$@\\"' > \\"$L\\""); writeFileSync("rota.js", "console.log('Today: Sam waters beds 1-4');\\n"); text = "Milestone 1 is built. The demo prints: " + run("${DEMO}"); }
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

/** The runner finished on its own: 0 or 1 (a graded failure), never a refusal, a timeout or a signal. */
function expectRunnerFinished(r: { status: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string }): void {
  expect([0, 1], `status ${String(r.status)} signal ${String(r.signal ?? null)}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`).toContain(r.status);
}

describe("the archive's own record file", () => {
  /** A project whose tree holds a symlink at the record's name, pointing at a file outside. */
  function planted(withDependencies: boolean): { root: string; project: string; dest: string; sentinel: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "t538a-")));
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "app.js"), "1\n");
    if (withDependencies) { mkdirSync(join(project, "node_modules")); writeFileSync(join(project, "node_modules", "x.js"), "x\n"); }
    const sentinel = join(root, "sentinel.txt");
    writeFileSync(sentinel, "untouched\n");
    symlinkSync(sentinel, join(project, ARCHIVE_OMITTED_FILE));
    return { root, project, dest: join(root, "dest"), sentinel };
  }
  it("a project's symlink at that name is not followed: the record is a new regular file and the target is unchanged", () => {
    const p = planted(true);
    try {
      expect(archiveProject(p.project, p.dest).map((o) => o.path)).toEqual(["node_modules"]);
      expect(readFileSync(p.sentinel, "utf-8")).toBe("untouched\n");
      expect(lstatSync(join(p.dest, ARCHIVE_OMITTED_FILE)).isFile()).toBe(true);
      expect(JSON.parse(readFileSync(join(p.dest, ARCHIVE_OMITTED_FILE), "utf-8")).omitted[0].path).toBe("node_modules");
      expect(existsSync(join(p.dest, "app.js"))).toBe(true);
    } finally { rmSync(p.root, { recursive: true, force: true }); }
  });
  it("with nothing omitted the planted link is not copied either", () => {
    const p = planted(false);
    try {
      expect(archiveProject(p.project, p.dest)).toEqual([]);
      expect(() => lstatSync(join(p.dest, ARCHIVE_OMITTED_FILE))).toThrow(/ENOENT/);
    } finally { rmSync(p.root, { recursive: true, force: true }); }
  });
  it("only the top-level name is the record: a deeper file of that name is project content", () => {
    const p = planted(false);
    try {
      mkdirSync(join(p.project, "docs"));
      writeFileSync(join(p.project, "docs", ARCHIVE_OMITTED_FILE), "mine\n");
      archiveProject(p.project, p.dest);
      expect(readFileSync(join(p.dest, "docs", ARCHIVE_OMITTED_FILE), "utf-8")).toBe("mine\n");
    } finally { rmSync(p.root, { recursive: true, force: true }); }
  });
  it("a link already at the destination is refused, not written through", () => {
    const p = planted(true);
    try {
      mkdirSync(p.dest);
      symlinkSync(p.sentinel, join(p.dest, ARCHIVE_OMITTED_FILE));
      expect(() => archiveProject(p.project, p.dest)).toThrow(/EEXIST/);
      expect(readFileSync(p.sentinel, "utf-8")).toBe("untouched\n");
    } finally { rmSync(p.root, { recursive: true, force: true }); }
  });
});

describe("the harness's status-update bypass", () => {
  it("keeps every output line, stderr first, and sees a ledger write but not a cache or lock write", () => {
    const story = join(realpathSync(mkdtempSync(join(tmpdir(), "t538b-"))), ".story");
    try {
      mkdirSync(join(story, "tickets"), { recursive: true });
      mkdirSync(join(story, "cache"));
      writeFileSync(join(story, "tickets", "T-3.json"), "{\"status\":\"open\"}\n");
      const before = ledgerDigest(story);
      const seen: (readonly string[])[] = [];
      const quiet = attemptBypass(story, "T-3", (args) => {
        seen.push(args);
        writeFileSync(join(story, "cache", "derived.json"), "{}\n");
        writeFileSync(join(story, ".lock"), "1\n");
        return { status: 1, stdout: "after\n", stderr: "storybloq: an advisory\n\n  Cannot update T-3: it waits on owner checkpoint T-2, not yet approved or retired.\n" };
      });
      expect(seen).toEqual([["ticket", "update", "T-3", "--status", "complete"]]);
      expect(quiet).toEqual({ ticket: "T-3", exitCode: 1, output: ["storybloq: an advisory", "Cannot update T-3: it waits on owner checkpoint T-2, not yet approved or retired.", "after"], ledgerChanged: false });
      expect(ledgerDigest(story)).toBe(before);
      const wrote = attemptBypass(story, "T-3", () => {
        writeFileSync(join(story, "tickets", "T-3.json"), "{\"status\":\"complete\"}\n");
        return { status: 0, stdout: "Updated T-3\n", stderr: "" };
      });
      expect(wrote).toEqual({ ticket: "T-3", exitCode: 0, output: ["Updated T-3"], ledgerChanged: true });
      const added = attemptBypass(story, "T-3", () => {
        writeFileSync(join(story, "tickets", "T-9.json"), "{}\n");
        return { status: 1, stdout: "", stderr: "" };
      });
      expect(added.ledgerChanged).toBe(true);
      expect(added.output).toEqual([]);
    } finally {
      rmSync(dirname(story), { recursive: true, force: true });
    }
  });
});

describe("the final-tree archive", () => {
  it("leaves dependency install folders out at any depth, records each with its size, and keeps lockfiles and the ledger", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538a-")));
    try {
      const project = join(dir, "project");
      const put = (rel: string, text: string): void => { mkdirSync(dirname(join(project, rel)), { recursive: true }); writeFileSync(join(project, rel), text); };
      put(".story/tickets/T-1.json", "{}\n");
      put("package-lock.json", "{\"lockfileVersion\":3}\n");
      put("rota.js", "console.log(1)\n");
      put("node_modules/a/index.js", "12345");
      put("node_modules/a/node_modules/b/x.js", "123");
      put("web/node_modules/c.js", "1234567");
      put(".venv/lib/site.py", "12");
      put("src/venv.txt", "not a folder");
      const dest = join(dir, "project.after");
      const omitted = archiveProject(project, dest);
      const expected = [{ path: ".venv", files: 1, bytes: 2 }, { path: "node_modules", files: 2, bytes: 8 }, { path: "web/node_modules", files: 1, bytes: 7 }];
      expect(omitted).toEqual(expected);
      expect(JSON.parse(readFileSync(join(dest, ARCHIVE_OMITTED_FILE), "utf-8"))).toEqual({ omitted: expected });
      expect(readdirSync(dest).sort()).toEqual([".eval-archive-omitted.json", ".story", "package-lock.json", "rota.js", "src", "web"]);
      expect(readdirSync(join(dest, "web"))).toEqual([]);
      expect(readFileSync(join(dest, ".story", "tickets", "T-1.json"), "utf-8")).toBe("{}\n");
      expect(readFileSync(join(dest, "src", "venv.txt"), "utf-8")).toBe("not a folder");
      // Nothing to leave out: no record file either.
      const clean = join(dir, "clean");
      expect(archiveProject(join(project, ".story"), clean)).toEqual([]);
      expect(readdirSync(clean)).toEqual(["tickets"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the runner's plumbing per variant", () => {
  it.each([[null, "SIGKILL"], [null, null], [2, null]] as const)("status %s signal %s is not a finished run", (status, signal) => {
    expect(() => expectRunnerFinished({ status, signal })).toThrow();
  });
  it("a status update that prints the checkpoint's words and then dies by a signal is kept as no exit status, and fails the grade", () => {
    const p = PLUMBING.find((x) => x.variant === "milestone-demo")!;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538s-")));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "codex"), `#!${process.execPath}\n${FAKE_CODEX}`, { mode: 0o755 });
      const codexHome = join(dir, "codex-home");
      mkdirSync(codexHome);
      writeFileSync(join(codexHome, "auth.json"), "{}\n");
      const payloadFile = join(dir, "payload.json");
      writeFileSync(payloadFile, JSON.stringify(fakePayload("Robin", "Watering rota demo")));
      const env: NodeJS.ProcessEnv = {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: join(dir, "home"), TMPDIR: dir, CODEX_HOME: codexHome,
        FAKE_ARGV_LOG: join(dir, "argv.log"), FAKE_PAYLOAD: payloadFile, FAKE_PACKAGE: PACKAGE, FAKE_RESUME: "0", FAKE_KILL_BYPASS: "1",
        FAKE_ADJUST: ownerScript(readFileSync(join(PKG, "test", "fixtures", "onboarding", p.fixture, "owner-answers.md"), "utf-8")).adjustment,
      };
      mkdirSync(env.HOME!);
      const out = join(dir, "out");
      const raw = join(dir, "raw");
      const r = spawnSync(process.execPath, [TSX, RUNNER, "--client", "codex", "--fixture", p.fixture, "--variant", p.variant, "--out", out, "--raw-out", raw], { cwd: PKG, env, encoding: "utf-8", timeout: 280_000 });
      expectRunnerFinished(r);
      const runId = readdirSync(raw)[0]!;
      const sessions = JSON.parse(readFileSync(join(raw, runId, "sessions.json"), "utf-8")) as { harness: HarnessFacts };
      expect(sessions.harness.bypass, JSON.stringify(sessions.harness.bypass)).toMatchObject({ exitCode: null, signal: "SIGKILL", output: expect.arrayContaining([expect.stringMatching(/waits on owner checkpoints? /)]) });
      const record = JSON.parse(readFileSync(join(out, runId, "record.json"), "utf-8")) as { failures: string[] };
      expect(record.failures.filter((f) => f.includes("did not exit"))).toEqual([expect.stringContaining("signal SIGKILL")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
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
          FAKE_ARGV_LOG: join(dir, "argv.log"), FAKE_PAYLOAD: payloadFile, FAKE_PACKAGE: PACKAGE, FAKE_RESUME: p.resume ? "1" : "0",
          FAKE_ADJUST: ownerScript(readFileSync(join(PKG, "test", "fixtures", "onboarding", p.fixture, "owner-answers.md"), "utf-8")).adjustment,
        };
        mkdirSync(env.HOME!);
        const out = join(dir, "out");
        const raw = join(dir, "raw");
        const args = [TSX, RUNNER, "--client", "codex", "--fixture", p.fixture, "--variant", p.variant, "--out", out, "--raw-out", raw, ...(p.fault ? ["--fault", p.fault] : [])];
        const r = spawnSync(process.execPath, args, { cwd: PKG, env, encoding: "utf-8", timeout: 280_000 });
        expectRunnerFinished(r);
        // Plan line 806: these runs reach every later session, so the whole run is read for the client's bypass flag.
        const argvs = readFileSync(join(dir, "argv.log"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
        expect(argvs.filter((a) => a[0] === "exec" && a[1] === "resume").length, p.variant).toBeGreaterThan(0);
        expect(argvs.filter((a) => (a.includes("--") ? a.slice(0, a.indexOf("--")) : a).some((x) => ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto"].includes(x)))).toEqual([]);
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
        if (p.variant === "milestone-demo") expect(sessions.harness.demo).toHaveProperty("status");
        expect(sessions.sessions.length).toBeGreaterThanOrEqual(2);
        // T-538 S5b: the final project tree is archived beside the transcript, so a result cites inspected files.
        expect(names).toContain("project.after");
        if (p.fault) expect(sessions.harness.fired).toBe(true);
        if (p.variant === "interrupted-edited") expect(sessions.harness.edits).not.toBeNull();
        if (p.variant === "milestone-demo") {
          expect(sessions.harness.demo?.stdout.trim()).toBe("Today: Sam waters beds 1-4");
          expect(sessions.harness.dependent).toMatch(/\S/);
          expect(sessions.harness.bypass, JSON.stringify(sessions.harness.bypass)).toMatchObject({ ticket: sessions.harness.dependent, ledgerChanged: false, output: expect.arrayContaining([expect.stringMatching(/waits on owner checkpoints? /)]) });
          expect(sessions.harness.bypass?.exitCode).toBe(1);
        }
        if (p.variant === "restart") expect(sessions.harness.report?.some((l) => l.startsWith("Checkpoint: "))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
