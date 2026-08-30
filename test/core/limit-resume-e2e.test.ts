/**
 * T-424 E2E simulation: the full limit-stop -> ledger -> waker -> resume flow
 * against the BUILT bundle. `npm run build` must have produced a current
 * dist/cli.js before this file can pass (same dependency as the other
 * *-e2e.test.ts suites).
 *
 * No real limit and no real `claude`: a fake transcript JSONL carries the
 * rate_limit entry, the StopFailure payload is piped to
 * `storybloq session limit-stop`, and a `claude` shim on PATH logs its argv +
 * env. HOME and STORYBLOQ_GLOBAL_DIR are pointed at temp dirs so the spawned
 * CLI can never touch the developer's real settings or ledger, and
 * STORYBLOQ_DISABLE_WAKER_SPAWN suppresses the automatic detached waker so the
 * test drives ticks explicitly with `waker-run --once`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { wakeClaimPath } from "../../src/autonomous/wake-claim.js";
import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { E2ECliFixture } from "../helpers/e2e-cli.js";

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(pkgRoot, "dist", "cli.js");

const TASK_ID = "e2e-limit-task-0001";
const KEY = `claude:${TASK_ID}`;

let root: string;
let home: string;
let globalDir: string;
let shimDir: string;
let shimLog: string;
let savedGlobalDir: string | undefined;
let gitHeadHash: string; // real HEAD of the test repo, so guide resume validates cleanly
// ISS-1091: a fresh fixture per test (matching this file's existing
// per-test home/globalDir lifecycle, not a shared per-suite instance) --
// home/globalDir are re-pointed at the fixture's own scratch paths so the
// spawned CLI also gets isolated CODEX_HOME/XDG_CONFIG_HOME (F9: confirmed
// per-test, no per-suite fixture needed here).
let fixture: E2ECliFixture;

interface LedgerFile {
  schemaVersion: number;
  records: Record<string, Record<string, unknown>>;
}

function readLedgerRawFile(): LedgerFile {
  return JSON.parse(readFileSync(join(globalDir, "limit-ledger.json"), "utf-8")) as LedgerFile;
}

function rewindNextAttempt(key: string): void {
  const ledger = readLedgerRawFile();
  ledger.records[key]!.nextAttemptAt = Date.now() - 1_000;
  writeFileSync(join(globalDir, "limit-ledger.json"), JSON.stringify(ledger));
}

function runCli(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [cliPath, ...args], {
    cwd: root,
    encoding: "utf-8",
    input: opts.input,
    env: fixture.env({
      SHIM_LOG: shimLog,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      ...opts.env,
    }),
    timeout: 30_000,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  fixture.recordResult({ stdout, stderr });
  return { code: r.status ?? 1, stdout, stderr };
}

function stopFailurePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: TASK_ID,
    cwd: root,
    transcript_path: join(root, "transcript.jsonl"),
    error_type: "rate_limit",
    permission_mode: "acceptEdits",
    hook_event_name: "StopFailure",
    ...overrides,
  });
}

function writeTranscript(banner: string): void {
  const entry = {
    isApiErrorMessage: true,
    error: "rate_limit",
    sessionId: TASK_ID,
    cwd: root,
    message: { content: [{ type: "text", text: banner }] },
  };
  writeFileSync(
    join(root, "transcript.jsonl"),
    JSON.stringify({ type: "assistant", message: "working" }) + "\n" + JSON.stringify(entry) + "\n",
  );
}

function setupProject(config: Record<string, unknown> = {}): void {
  const storyDir = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "e2e", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...config,
    // After ...config so a caller's limitResume overrides merge INTO the
    // notify:false default instead of replacing it (tests must never fire
    // real desktop notifications).
    limitResume: { notify: false, ...(config.limitResume as object | undefined ?? {}) },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "e2e", date: "2026-03-30",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "E2E ticket", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
    blockedBy: [], parentTicket: null,
  }));
  // A REAL git repo (not a hand-written .git) so the in-process guide resume
  // validates HEAD against expectedHead cleanly instead of erroring on git.
  const git = (...a: string[]): void => {
    const r = spawnSync("git", a, { cwd: root, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "e2e@test.local");
  git("config", "user.name", "E2E");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "e2e\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  gitHeadHash = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).stdout.trim();
}

function makeOwnedSession(overrides: Partial<FullSessionState> = {}): { state: FullSessionState; sessDir: string } {
  const session = createSession(root, "coding", realpathSync(root));
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const state = writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    ownerTask: { client: "claude", id: TASK_ID, boundAt: new Date().toISOString() },
    ticket: { id: "T-001", title: "E2E ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: gitHeadHash, expectedHead: gitHeadHash, initHead: gitHeadHash },
    reviews: { plan: [], code: [] },
    ...overrides,
  } as FullSessionState);
  return { state, sessDir };
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

beforeEach(async () => {
  fixture = await E2ECliFixture.create();
  home = fixture.home;
  globalDir = fixture.globalDir;
  root = mkdtempSync(join(tmpdir(), "t424-e2e-"));
  shimDir = join(root, "shim-bin");
  mkdirSync(shimDir, { recursive: true });
  shimLog = join(root, "claude-shim.log");

  // Fake `claude`: answers --version (waker preflight), logs everything else.
  const shim = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi',
    'printf \'ARGS %s\\n\' "$*" >> "$SHIM_LOG"',
    'printf \'WAKE %s\\n\' "$STORYBLOQ_WAKE_ATTEMPT" >> "$SHIM_LOG"',
    "exit 0",
  ].join("\n") + "\n";
  writeFileSync(join(shimDir, "claude"), shim);
  chmodSync(join(shimDir, "claude"), 0o755);

  // The in-process helpers (createSession) must write against the same ledger env.
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  setupProject();
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await fixture.cleanup();
});

describe("limit-resume E2E (built CLI)", () => {
  it("full autonomous cycle: detect -> park -> wake with posture + env token -> resumed", async () => {
    const { state, sessDir } = makeOwnedSession();
    writeTranscript("You've hit your 5-hour limit · resets 6:40pm");

    // 1. StopFailure hook fires.
    const detect = runCli(["session", "limit-stop"], { input: stopFailurePayload() });
    expect(detect.code).toBe(0);

    const parked = readState(sessDir);
    expect(parked.state).toBe("COMPACT");
    expect(parked.compactPending).toBe(true);
    expect(parked.interruptionKind).toBe("limit");
    expect(parked.limitPermissionMode).toBe("acceptEdits");

    let rec = readLedgerRawFile().records[KEY]!;
    expect(rec.status).toBe("stopped");
    expect(rec.sessionType).toBe("autonomous");
    expect(rec.mode).toBe("headless");
    expect(rec.limitType).toBe("session");
    expect(rec.resetSource).toBe("absolute");
    expect(rec.limitEventId).toBe(parked.limitEventId);

    // 2. Reset arrives (simulated) -> one waker tick dispatches the wake.
    rewindNextAttempt(KEY);
    const wake = runCli(["waker-run", "--sb-waker", "--once"]);
    expect(wake.code).toBe(0);

    const log = readFileSync(shimLog, "utf-8");
    expect(log).toContain(`-p --resume ${TASK_ID}`);
    expect(log).toContain("storybloq_autonomous_guide");
    expect(log).toContain(state.sessionId);
    expect(log).toContain("--permission-mode acceptEdits");

    rec = readLedgerRawFile().records[KEY]!;
    expect(rec.status).toBe("resuming");
    const attempt = rec.attempt as { id: string; token: string; childPid: number };
    expect(log).toContain(`WAKE ${attempt.id}.${attempt.token}`);
    expect(existsSync(wakeClaimPath(sessDir))).toBe(true);

    // 3. Drive the REAL guide resume (not a hand-written state.json): this is
    //    what the wake child's prompt instructs. It exercises actual HEAD
    //    validation, interruption clearing, and resume state-machine
    //    advancement against the state the built CLI parked.
    const result = await handleAutonomousGuide(root, {
      action: "resume", sessionId: state.sessionId, clientTaskId: TASK_ID,
    });
    expect(result.isError).toBeFalsy();

    const resumed = readState(sessDir);
    expect(resumed.state).not.toBe("COMPACT"); // left COMPACT via the real resume
    expect(resumed.compactPending).toBe(false);
    expect(resumed.interruptionKind ?? null).toBeNull();
    expect(resumed.limitStopPending).toBe(false);
    expect(resumed.limitResumeAt ?? null).toBeNull();
    expect(resumed.limitPermissionMode ?? null).toBeNull();
    expect(resumed.limitEventId ?? null).toBeNull();

    // 4. The verify tick observes the session left COMPACT and settles the record.
    const verify = runCli(["waker-run", "--sb-waker", "--once"]);
    expect(verify.code).toBe(0);
    rec = readLedgerRawFile().records[KEY]!;
    expect(rec.status).toBe("resumed");
    expect(rec.attempt).toBeNull();
  });

  it("plain session: notify record, no spawn, notified at reset", () => {
    writeTranscript("You've hit your weekly limit · resets Jul 15 at 12:30am");
    const detect = runCli(["session", "limit-stop"], { input: stopFailurePayload() });
    expect(detect.code).toBe(0);

    let rec = readLedgerRawFile().records[KEY]!;
    expect(rec.sessionType).toBe("plain");
    expect(rec.mode).toBe("notify");
    expect(rec.limitType).toBe("weekly");

    rewindNextAttempt(KEY);
    const wake = runCli(["waker-run", "--sb-waker", "--once"]);
    expect(wake.code).toBe(0);

    expect(existsSync(shimLog)).toBe(false); // never spawned
    rec = readLedgerRawFile().records[KEY]!;
    expect(rec.status).toBe("notified");
  });

  it("unparseable banner falls back to the configured reset window", () => {
    writeTranscript("Some completely unrecognizable failure text");
    const before = Date.now();
    runCli(["session", "limit-stop"], { input: stopFailurePayload() });

    const rec = readLedgerRawFile().records[KEY]!;
    expect(rec.resetSource).toBe("fallback");
    const resetAt = rec.resetAt as number;
    expect(resetAt).toBeGreaterThanOrEqual(before + 18_000_000);
    expect(resetAt).toBeLessThanOrEqual(Date.now() + 18_000_000 + 120_000);
  });

  it("duplicate StopFailure within the window stays a single record", () => {
    writeTranscript("You've hit your 5-hour limit · resets 6:40pm");
    runCli(["session", "limit-stop"], { input: stopFailurePayload() });
    runCli(["session", "limit-stop"], { input: stopFailurePayload() });

    const ledger = readLedgerRawFile();
    expect(Object.keys(ledger.records)).toEqual([KEY]);
    expect(ledger.records[KEY]!.generation).toBe(1);
  });

  it("CONCURRENT duplicate StopFailures converge on a single generation-1 record", async () => {
    // Two detections racing (separate processes launched together, no ordering
    // barrier): the ledger-first intent + link-lock + dedupe window must still
    // yield exactly one record at generation 1 with one owner-controlled
    // activation -- never two records, a double generation bump, or a torn file.
    const { sessDir } = makeOwnedSession();
    writeTranscript("You've hit your 5-hour limit · resets 6:40pm");

    const runDetect = (): Promise<number> => new Promise((res) => {
      const child = spawn("node", [cliPath, "session", "limit-stop"], {
        cwd: root,
        stdio: ["pipe", "ignore", "ignore"],
        env: fixture.env({
          SHIM_LOG: shimLog,
          PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
        }),
      });
      child.stdin!.end(stopFailurePayload());
      child.on("close", (code) => res(code ?? 1));
    });
    // Both children are spawned before either exits: they genuinely race.
    const [a, b] = await Promise.all([runDetect(), runDetect()]);
    expect(a).toBe(0);
    expect(b).toBe(0);

    const ledger = readLedgerRawFile();
    expect(Object.keys(ledger.records)).toEqual([KEY]); // exactly one record
    const rec = ledger.records[KEY]!;
    expect(rec.generation).toBe(1); // one episode, not double-bumped
    expect(rec.status).toBe("stopped"); // owner-activated, not stuck preparing
    // The session was parked exactly once, with the record's event id.
    const parked = readState(sessDir);
    expect(parked.limitEventId).toBe(rec.limitEventId);
  });

  it("non-rate_limit StopFailure is a silent no-op with exit 0", () => {
    const r = runCli(["session", "limit-stop"], {
      input: stopFailurePayload({ error_type: "overloaded" }),
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(false);
  });

  it("manual resume before reset: waker marks the record resumed without spawning", () => {
    const { sessDir } = makeOwnedSession();
    writeTranscript("You've hit your 5-hour limit · resets 6:40pm");
    runCli(["session", "limit-stop"], { input: stopFailurePayload() });

    // The user reopened and resumed by hand: session leaves COMPACT.
    const current = readState(sessDir);
    writeSessionSync(sessDir, {
      ...current,
      state: "IMPLEMENT",
      compactPending: false,
      interruptionKind: null,
      limitStopPending: false,
      limitEventId: null,
    } as FullSessionState);

    rewindNextAttempt(KEY);
    runCli(["waker-run", "--sb-waker", "--once"]);

    expect(existsSync(shimLog)).toBe(false);
    expect(readLedgerRawFile().records[KEY]!.status).toBe("resumed");
  });

  it("resume-prompt on a limit-parked session emits limit-aware wording", () => {
    makeOwnedSession();
    writeTranscript("You've hit your 5-hour limit · resets 6:40pm");
    runCli(["session", "limit-stop"], { input: stopFailurePayload() });

    const r = runCli(["session", "resume-prompt"], {
      input: JSON.stringify({ source: "resume", session_id: TASK_ID, cwd: root }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage limit");
  });

  it("clear-compact requires --force for limit-parked sessions and cancels on force", () => {
    const { state, sessDir } = makeOwnedSession();
    writeTranscript("You've hit your 5-hour limit · resets 6:40pm");
    runCli(["session", "limit-stop"], { input: stopFailurePayload() });

    const refused = runCli(["session", "clear-compact", state.sessionId]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain("--force");

    const forced = runCli(["session", "clear-compact", state.sessionId, "--force"]);
    expect(forced.code).toBe(0);
    // This record has NO attempt (never dispatched): cancellation completes
    // SYNCHRONOUSLY. Anything short of `cancelled` here means the two-phase
    // completion did not run, leaving a dispatchable-looking record behind.
    const rec = readLedgerRawFile().records[KEY]!;
    expect(rec.status).toBe("cancelled");
    // And the session's limit interruption is fully cleared: still resumable as
    // a plain compact, no limit gating left.
    const after = readState(sessDir);
    expect(after.interruptionKind ?? null).toBeNull();
    expect(after.limitStopPending).toBe(false);
    expect(after.limitEventId ?? null).toBeNull();
    expect(after.compactPending).toBe(true);
  });

  it("limit-status lists the pending record and cancels it", () => {
    writeTranscript("You've hit your 5-hour limit · resets 6:40pm");
    runCli(["session", "limit-stop"], { input: stopFailurePayload() });

    const list = runCli(["limit-status"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(KEY);

    const cancel = runCli(["limit-status", "--cancel", KEY]);
    expect(cancel.code).toBe(0);
    expect(readLedgerRawFile().records[KEY]!.status).toBe("cancelled");

    const after = runCli(["limit-status"]);
    expect(after.stdout).toContain("No pending limit auto-resumes");
  });
});
