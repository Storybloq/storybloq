/**
 * T-536: `storybloq setup-review`, the setup reviewer the agent cannot narrate.
 *
 * The CLI starts the reviewer itself, stores its raw answer bound to the exact
 * review packet, and is the only producer of the package's two review lines.
 * These tests run the handlers in-process against fake `codex` and `claude`
 * binaries (test/helpers/setup-review-fakes.ts), so every spawn is real and
 * countable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { fork, spawn, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleSetupReviewGate, handleSetupReviewRun, handleSetupReviewStatus, type SetupReviewIo, type SetupReviewResult,
} from "../../src/cli/commands/setup-review.js";
import { projectKeyFor, STOP_LINES } from "../../src/core/setup-review.js";
import { acquireProjectLockAsync, releaseProjectLock } from "../../src/core/project-lock.js";
import { captureProcessSignatureSync } from "../../src/core/process-identity.js";
import { makeFakeBin, REVIEW_PACKET, type FakeBin } from "../helpers/setup-review-fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const d12 = (s: string): string => sha(s).slice(0, 12);
const STOP = STOP_LINES.join("\n");

let project: string;
let store: string;
let fake: FakeBin;
let extraEnv: Record<string, string>;
const cleanups: string[] = [];

function io(stdin?: string, deps: SetupReviewIo["deps"] = {}): SetupReviewIo {
  return {
    cwd: project,
    env: {
      PATH: fake.path,
      STORYBLOQ_SETUP_REVIEW_DIR: store,
      FAKE_LOG: fake.log,
      FAKE_STDIN_DIR: fake.stdinDir,
      HOME: project,
      ...extraEnv,
    },
    stdin: () => {
      if (stdin === undefined) throw new Error("stdin must not be read");
      return Buffer.from(stdin);
    },
    deps: { timeoutMs: 2_000, ...deps },
  };
}

function setupIdOf(r: SetupReviewResult): string {
  const m = /^Setup id: (SS-[0-9a-f]{8})$/m.exec(r.stdout);
  if (!m) throw new Error(`no setup id in:\n${r.stdout}`);
  return m[1]!;
}

function setupDir(setupId: string): string {
  return join(store, projectKeyFor(project), setupId);
}

function recordsOf(setupId: string): Array<Record<string, unknown> & { recordId: string }> {
  const dir = join(setupDir(setupId), "records");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("SR-")).map((n) => JSON.parse(readFileSync(join(dir, n, "record.json"), "utf-8")));
}

async function gate(setup?: string): Promise<SetupReviewResult> {
  return handleSetupReviewGate(io(), setup ? { setup } : {});
}

async function openSetup(): Promise<string> {
  const r = await gate();
  expect(r.exitCode).toBe(0);
  return setupIdOf(r);
}

const reviews = (): number => fake.invocations().length;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "sr-project-"));
  store = mkdtempSync(join(tmpdir(), "sr-store-"));
  fake = makeFakeBin(["codex", "claude"]);
  extraEnv = {};
  cleanups.push(project, store);
});

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("gate (T-536)", () => {
  it("opens a setup and names the startable backend, with nothing for the agent to decide", async () => {
    const r = await gate();
    const id = setupIdOf(r);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`Setup id: ${id}\nReviewer probe: codex codex-cli 9.9.9\nNext: storybloq setup-review run --setup ${id} with the review packet on stdin\n`);
    expect(existsSync(join(setupDir(id), "setup.json"))).toBe(true);
    expect(readdirSync(project)).toEqual([]);
  });

  it("falls to claude when codex is absent, and prints the unconditional stop when neither can start", async () => {
    fake = makeFakeBin(["claude"]);
    expect((await gate()).stdout).toContain("Reviewer probe: claude 9.9.9 (Claude Code)\n");
    fake = makeFakeBin([]);
    const r = await gate();
    const id = setupIdOf(r);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith(`Setup id: ${id}\nReviewer probe: none available\n`)).toBe(true);
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(r.stdout).not.toMatch(/setup-review run|--matched|code SR-/);
  });

  it("treats a claude whose --help lacks a review flag as not startable, so an old claude gets the stop, not a failed review", async () => {
    fake = makeFakeBin(["claude"]);
    extraEnv = { FAKE_CLAUDE_OLD: "1" };
    const r = await gate();
    expect(r.stdout).toContain("Reviewer probe: none available\n");
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
    const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: setupIdOf(r) });
    expect(run.exitCode).toBe(3);
    expect(recordsOf(setupIdOf(r))).toEqual([]);
    expect(reviews()).toBe(0);
  });

  it("treats a backend whose --version fails as not startable", async () => {
    extraEnv = { FAKE_CODEX_VERSION_FAIL: "1" };
    expect((await gate()).stdout).toContain("Reviewer probe: claude 9.9.9 (Claude Code)\n");
  });

  it("re-probes inside an existing setup on retry and refuses an unknown or malformed setup id", async () => {
    const id = await openSetup();
    const again = await gate(id);
    expect(setupIdOf(again)).toBe(id);
    expect((await gate("SS-00000000")).exitCode).toBe(2);
    expect((await gate("../../etc")).exitCode).toBe(2);
  });
});

describe("run and status: the completed path (T-536)", () => {
  it("reviews the packet, publishes a completed record and makes status print the two package lines", async () => {
    const id = await openSetup();
    const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(run.exitCode).toBe(0);
    const [rec] = recordsOf(id);
    expect(rec).toMatchObject({ state: "completed", setupId: id, cycle: 1, round: 1, revisionSha256: sha(REVIEW_PACKET), backend: "codex", backendVersion: "codex-cli 9.9.9", verdict: "approve", findingsCount: 0 });
    expect(run.stdout.startsWith(`Reviewer probe: codex codex-cli 9.9.9\nIndependent review: approve, invocation ${rec!.recordId}, revision ${d12(REVIEW_PACKET)}\n`)).toBe(true);
    const status = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(status).toEqual({ exitCode: 0, stdout: `Reviewer probe: codex codex-cli 9.9.9\nIndependent review: approve, invocation ${rec!.recordId}, revision ${d12(REVIEW_PACKET)}\n` });
    expect(readdirSync(project)).toEqual([]);
  });

  it("hands the reviewer the whole packet, so a requirement missing from tickets and map reaches it", async () => {
    const id = await openSetup();
    await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    const [stdin] = fake.stdins();
    expect(stdin!.includes(Buffer.from(REVIEW_PACKET))).toBe(true);
    expect(stdin!.toString()).toContain("R3: Club staff can block courts for maintenance");
    expect(stdin!.toString()).toMatch(/every R<n>|each requirement/i);
  });

  it("prints findings as the reviewer returned them", async () => {
    extraEnv = { FAKE_CODEX_MODE: "revise" };
    const id = await openSetup();
    const run = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(run.stdout).toContain("Independent review: revise, invocation SR-");
    expect(run.stdout).toContain("R3 is covered by no ticket and no coverage row");
  });

  it("rejects a malformed packet without starting a reviewer", async () => {
    const id = await openSetup();
    const r = await handleSetupReviewRun(io("## Plan\nonly\n"), { setup: id });
    expect(r.exitCode).toBe(2);
    expect(reviews()).toBe(0);
  });

  it("scrubs the parent Claude Code session from the claude reviewer's environment and runs it outside the project", async () => {
    fake = makeFakeBin(["claude"]);
    extraEnv = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "parent" };
    const id = await openSetup();
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
    const [inv] = fake.invocations();
    expect(inv!.claudecode).toBeNull();
    expect(inv!.claudeSession).toEqual([]);
    expect(inv!.cwd.startsWith(project)).toBe(false);
  });
});

describe("cycles and rounds (T-536)", () => {
  const revised = REVIEW_PACKET.replace("Coverage map:", "Ticket: Block courts\nOutcome: staff block a court, from brief.md Staff tools\nScope: block action. Excludes: none\nAcceptance: a blocked court cannot be booked\nBehaviour: none\nVerification: a test blocks a court. Prerequisites: none. Assumptions: none\nBlocked by: Book a court\n\nCoverage map:\nR3 -> Block courts");
  const final = revised.replace("Excludes: refunds", "Excludes: refunds and credits");

  it("allows two rounds, refuses a third without spawning, and shows the round-limit line for an unreviewed final revision", async () => {
    const id = await openSetup();
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
    expect((await handleSetupReviewRun(io(revised), { setup: id })).exitCode).toBe(0);
    const third = await handleSetupReviewRun(io(final), { setup: id });
    expect(third.exitCode).toBe(5);
    expect(reviews()).toBe(2);
    const last = recordsOf(id).find((r) => r.round === 2)!;
    const status = await handleSetupReviewStatus(io(final), { setup: id });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toBe(`Reviewer probe: codex codex-cli 9.9.9\nIndependent review: revision ${d12(final)} not reviewed, round limit reached; last review approve, invocation ${last.recordId}, revision ${d12(revised)}\n`);
    expect(readFileSync(join(setupDir(id), "revisions", `${sha(final)}.md`), "utf-8")).toBe(final);
  });

  it("gives two more rounds in a new cycle opened for an owner adjustment, with the owner's words recorded", async () => {
    const id = await openSetup();
    await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    await handleSetupReviewRun(io(revised), { setup: id });
    const r = await handleSetupReviewRun(io(final), { setup: id, newCycle: true, reason: "Exclude credits from cancellation" });
    expect(r.exitCode).toBe(0);
    expect(recordsOf(id).find((x) => x.cycle === 2)).toMatchObject({ round: 1, newCycleReason: "Exclude credits from cancellation" });
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
    expect((await handleSetupReviewRun(io(revised), { setup: id })).exitCode).toBe(5);
  });

  it("refuses a new cycle with no completed round, and a new cycle without a reason", async () => {
    const id = await openSetup();
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id, newCycle: true, reason: "x" })).exitCode).toBe(2);
    await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect((await handleSetupReviewRun(io(revised), { setup: id, newCycle: true })).exitCode).toBe(2);
    expect(reviews()).toBe(1);
  });

  it("does not count failed runs as rounds", async () => {
    extraEnv = { FAKE_CODEX_MODE: "exit1" };
    const id = await openSetup();
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(3);
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(3);
    extraEnv = {};
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
    expect((await handleSetupReviewRun(io(revised), { setup: id })).exitCode).toBe(0);
    expect((await handleSetupReviewRun(io(final), { setup: id })).exitCode).toBe(5);
  });

  it("keeps two setups in one project on the same day independent", async () => {
    const a = await openSetup();
    const b = await openSetup();
    expect(a).not.toBe(b);
    for (const id of [a, b]) {
      expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
      expect((await handleSetupReviewRun(io(revised), { setup: id })).exitCode).toBe(0);
    }
    expect(reviews()).toBe(4);
    expect((await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: b })).stdout).toContain(`invocation ${recordsOf(b).find((r) => r.round === 1)!.recordId}`);
  });
});

describe("concurrency, through the repo's hardened lock (T-536)", () => {
  it("lets one of two simultaneous runs in a setup start a reviewer; the other exits 7 without spawning", async () => {
    extraEnv = { FAKE_CODEX_MODE: "slow", FAKE_SLOW_MS: "1500" };
    const id = await openSetup();
    const results = await Promise.all([
      handleSetupReviewRun(io(REVIEW_PACKET), { setup: id }),
      handleSetupReviewRun(io(REVIEW_PACKET), { setup: id }),
    ]);
    expect(results.map((r) => r.exitCode).sort()).toEqual([0, 7]);
    expect(results.find((r) => r.exitCode === 7)!.stdout).toContain("a review is already running in this setup");
    expect(reviews()).toBe(1);
    expect(existsSync(join(setupDir(id), "run.lock"))).toBe(false);
  });

  it("holds the lock on the setup's run.lock, never on .story/.lock", async () => {
    const id = await openSetup();
    const held = await acquireProjectLockAsync(join(setupDir(id), "run.lock"));
    try {
      const r = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
      expect(r.exitCode).toBe(7);
      expect(reviews()).toBe(0);
    } finally {
      releaseProjectLock(held);
    }
    expect(existsSync(join(project, ".story"))).toBe(false);
  });

  it("reclaims a lock left by a dead holder exactly once when two runs race for it", async () => {
    extraEnv = { FAKE_CODEX_MODE: "slow", FAKE_SLOW_MS: "1000" };
    const id = await openSetup();
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    const deadPid = Number(dead.stdout);
    writeFileSync(join(setupDir(id), "run.lock"), JSON.stringify({ pid: deadPid, token: "dead", acquiredAt: Date.now() - 60_000, processSignature: "darwin:dead" }));
    const results = await Promise.all([
      handleSetupReviewRun(io(REVIEW_PACKET), { setup: id }),
      handleSetupReviewRun(io(REVIEW_PACKET), { setup: id }),
    ]);
    expect(results.map((r) => r.exitCode).sort()).toEqual([0, 7]);
    expect(reviews()).toBe(1);
  });

  it("reclaims a lock whose pid was reused by another live process, and never one whose live holder matches", async () => {
    const id = await openSetup();
    const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const lock = join(setupDir(id), "run.lock");
      writeFileSync(lock, JSON.stringify({ pid: sleeper.pid, token: "reused", acquiredAt: Date.now() - 60_000, processSignature: "darwin:not-this-process" }));
      expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
      expect(reviews()).toBe(1);
      writeFileSync(lock, JSON.stringify({ pid: sleeper.pid, token: "live", acquiredAt: Date.now(), processSignature: captureProcessSignatureSync(sleeper.pid!) }));
      expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(7);
      expect(reviews()).toBe(1);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("publishes nothing when the lock is lost before the publishing rename", async () => {
    const id = await openSetup();
    const stolen = await handleSetupReviewRun(
      io(REVIEW_PACKET, { beforePublish: (lockPath: string) => writeFileSync(lockPath, JSON.stringify({ pid: 1, token: "thief", acquiredAt: Date.now(), processSignature: null })) }),
      { setup: id },
    );
    expect(stolen.exitCode).toBe(7);
    expect(stolen.stdout).not.toContain("Independent review: approve");
    expect(stolen.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(recordsOf(id)).toEqual([]);
    expect(reviews()).toBe(1);
  });
});

describe("failed records are not unreadable (T-536)", () => {
  it("a timeout, then a good retry, gives the completed line", async () => {
    extraEnv = { FAKE_CODEX_MODE: "timeout" };
    const id = await openSetup();
    const t = await handleSetupReviewRun(io(REVIEW_PACKET, { timeoutMs: 300 }), { setup: id });
    expect(t.exitCode).toBe(3);
    expect(t.stdout).toContain(`Independent review: failed for revision ${d12(REVIEW_PACKET)}, invocation SR-`);
    expect(t.stdout.trimEnd().endsWith(STOP)).toBe(true);
    const [failed] = recordsOf(id);
    expect(failed).toMatchObject({ state: "failed", failure: "timeout", outputSha256: null });
    expect(failed).not.toHaveProperty("verdict");
    expect(failed).not.toHaveProperty("round");
    const failedStatus = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(failedStatus.exitCode).toBe(3);
    extraEnv = {};
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(s.exitCode).toBe(0);
    expect(s.stdout).toContain("Independent review: approve, invocation");
  });

  it("a schema-invalid answer is kept with its hash, then a good retry gives the completed line", async () => {
    extraEnv = { FAKE_CODEX_MODE: "invalid" };
    const id = await openSetup();
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(3);
    const [failed] = recordsOf(id);
    expect(failed).toMatchObject({ state: "failed", failure: "schema-invalid" });
    expect(typeof failed!.outputSha256).toBe("string");
    extraEnv = {};
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
    expect((await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
  });

  it("a failed record whose kept output was changed is unreadable", async () => {
    extraEnv = { FAKE_CODEX_MODE: "invalid" };
    const id = await openSetup();
    await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    const [failed] = recordsOf(id);
    writeFileSync(join(setupDir(id), "records", failed!.recordId, "reviewer-output.json"), "{}");
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(s.exitCode).toBe(8);
    expect(s.stdout).toContain(`Independent review: record unreadable, invocation ${failed!.recordId}`);
  });

  it("a backend that exits 0 with no output file is a failed run, never a verdict", async () => {
    extraEnv = { FAKE_CODEX_MODE: "no-output" };
    const id = await openSetup();
    const r = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).not.toMatch(/Independent review: (approve|revise|reject)/);
  });
});

describe("the store fails closed (T-536)", () => {
  it("checks the store is writable before spawning the paid reviewer", async () => {
    const id = await openSetup();
    mkdirSync(join(setupDir(id), "records"), { recursive: true });
    chmodSync(join(setupDir(id), "records"), 0o500);
    try {
      const r = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
      expect(r.exitCode).toBe(6);
      expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
      expect(reviews()).toBe(0);
    } finally {
      chmodSync(join(setupDir(id), "records"), 0o700);
    }
  });

  it("an interrupted publication reads as absent and is cleaned up by the next run", async () => {
    const id = await openSetup();
    const r = await handleSetupReviewRun(io(REVIEW_PACKET, { publish: () => { throw new Error("killed before rename"); } }), { setup: id });
    expect(r.exitCode).toBe(6);
    expect(r.stdout).not.toContain("Independent review: approve");
    expect(readdirSync(join(setupDir(id), "records")).some((n) => n.startsWith(".staging-"))).toBe(true);
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(s).toMatchObject({ exitCode: 4 });
    expect(s.stdout).toContain(`Independent review: none for revision ${d12(REVIEW_PACKET)}`);
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
    expect(readdirSync(join(setupDir(id), "records")).some((n) => n.startsWith(".staging-"))).toBe(false);
  });

  it("an output write failure after the backend succeeded prints the stop and no verdict, even when the failed record cannot be written", async () => {
    fake = makeFakeBin(["claude"]);
    const id = await openSetup();
    const r1 = await handleSetupReviewRun(io(REVIEW_PACKET, { writeOutput: () => { throw new Error("disk full"); } }), { setup: id });
    expect(r1.exitCode).toBe(6);
    expect(r1.stdout).not.toMatch(/Independent review: approve/);
    expect(r1.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(recordsOf(id).map((x) => x.state)).toEqual(["failed"]);
    const r2 = await handleSetupReviewRun(io(REVIEW_PACKET, {
      writeOutput: () => { throw new Error("disk full"); },
      writeRecord: () => { throw new Error("disk full"); },
    }), { setup: id });
    expect(r2.exitCode).toBe(6);
    expect(r2.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(fake.invocations()).toHaveLength(2);
  });

  it("an output write failure stops the run even when the next record write would succeed: no completed record without its answer", async () => {
    fake = makeFakeBin(["claude"]);
    const id = await openSetup();
    let writes = 0;
    const r = await handleSetupReviewRun(io(REVIEW_PACKET, {
      writeOutput: () => { throw new Error("disk full"); },
      // The failed record's write fails; space comes back before any later write.
      writeRecord: (path: string, text: string) => { if (writes++ === 0) throw new Error("disk full"); writeFileSync(path, text); },
    }), { setup: id });
    expect(r.exitCode).toBe(6);
    expect(r.stdout).not.toMatch(/Independent review: approve/);
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(recordsOf(id).filter((x) => x.state === "completed")).toEqual([]);
  });

  it("status persists the revision before printing, and fails closed when it cannot", async () => {
    const id = await openSetup();
    const ok = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(ok.exitCode).toBe(4);
    expect(existsSync(join(setupDir(id), "revisions", `${sha(REVIEW_PACKET)}.md`))).toBe(true);
    chmodSync(join(setupDir(id), "revisions"), 0o500);
    try {
      const other = REVIEW_PACKET.replace("one-hour", "two-hour");
      const r = await handleSetupReviewStatus(io(other), { setup: id });
      expect(r.exitCode).toBe(6);
      expect(r.stdout).not.toContain("Independent review:");
    } finally {
      chmodSync(join(setupDir(id), "revisions"), 0o700);
    }
  });
});

describe("unreadable is not absent (T-536)", () => {
  async function completed(): Promise<{ id: string; rec: string }> {
    const id = await openSetup();
    await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    return { id, rec: recordsOf(id)[0]!.recordId };
  }

  it("a corrupt record.json blocks every revision", async () => {
    const { id, rec } = await completed();
    writeFileSync(join(setupDir(id), "records", rec, "record.json"), "{not json");
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET.replace("one-hour", "two-hour")), { setup: id });
    expect(s.exitCode).toBe(8);
    expect(s.stdout).toContain(`Independent review: record unreadable, invocation ${rec}`);
  });

  it("a missing packet or a changed raw output is unreadable, never absent", async () => {
    const a = await completed();
    rmSync(join(setupDir(a.id), "records", a.rec, "packet.md"));
    expect((await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: a.id })).exitCode).toBe(8);
    const b = await completed();
    writeFileSync(join(setupDir(b.id), "records", b.rec, "reviewer-output.json"), JSON.stringify({ verdict: "approve", findings: [] }) + " ");
    expect((await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: b.id })).exitCode).toBe(8);
  });

  it("a completed record whose verdict disagrees with its raw output is unreadable", async () => {
    const { id, rec } = await completed();
    const file = join(setupDir(id), "records", rec, "record.json");
    const body = JSON.parse(readFileSync(file, "utf-8"));
    writeFileSync(file, JSON.stringify({ ...body, verdict: "reject" }));
    expect((await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(8);
  });
});

describe("probe identity and the skip path (T-536)", () => {
  it("names the reviewer of the cited record, not the gate's choice", async () => {
    const id = await openSetup();
    const r = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id, backend: "claude" });
    expect(r.exitCode).toBe(0);
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(s.stdout.split("\n")[0]).toBe("Reviewer probe: claude 9.9.9 (Claude Code)");
  });

  it("refuses --backend naming a backend that cannot start, without spawning", async () => {
    fake = makeFakeBin(["codex"]);
    const id = await openSetup();
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id, backend: "claude" })).exitCode).toBe(2);
    expect(reviews()).toBe(0);
  });

  it("goes from an unavailable reviewer to the owner's skip without reading stdin or inventing probe text", async () => {
    fake = makeFakeBin([]);
    const id = await openSetup();
    const s = await handleSetupReviewStatus(io(undefined), { setup: id, skipped: true });
    expect(s).toEqual({ exitCode: 0, stdout: "Reviewer probe: none available\nIndependent review: skipped at the owner's request\n" });
    const setup = JSON.parse(readFileSync(join(setupDir(id), "setup.json"), "utf-8"));
    expect(setup.skipped).toMatchObject({ at: expect.any(String) });
  });

  it("prints the absent line with the gate's probe when nothing was reviewed", async () => {
    const id = await openSetup();
    expect(await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id })).toEqual({
      exitCode: 4,
      stdout: `Reviewer probe: codex codex-cli 9.9.9\nIndependent review: none for revision ${d12(REVIEW_PACKET)}\n`,
    });
  });

  it("with no backend at run time prints the stop and starts nothing", async () => {
    const id = await openSetup();
    fake = makeFakeBin([]);
    const r = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain("Reviewer probe: none available");
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
  });
});

describe("the review's own bytes and the setup's identity (T-536)", () => {
  it("publishes no completed record when the stored packet changes while the reviewer runs", async () => {
    extraEnv = { FAKE_CODEX_MODE: "tamper" };
    const id = await openSetup();
    const r = await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    expect(r.exitCode).toBe(3);
    expect(r.stdout).not.toMatch(/Independent review: (approve|revise|reject)/);
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(recordsOf(id).filter((x) => x.state === "completed")).toEqual([]);
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(s.stdout).not.toMatch(/Independent review: (approve|revise|reject)/);
  });

  it("a record copied from another setup neither certifies nor counts there", async () => {
    const a = await openSetup();
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: a })).exitCode).toBe(0);
    const b = await openSetup();
    const rec = recordsOf(a)[0]!.recordId;
    mkdirSync(join(setupDir(b), "records"), { recursive: true });
    spawnSync("/bin/cp", ["-R", join(setupDir(a), "records", rec), join(setupDir(b), "records", rec)]);
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: b });
    expect(s.exitCode).toBe(8);
    expect(s.stdout).not.toContain("Independent review: approve");
    const other = REVIEW_PACKET.replace("one-hour", "two-hour");
    expect((await handleSetupReviewRun(io(other), { setup: b })).exitCode).toBe(0);
    expect(recordsOf(b).filter((x) => x.setupId === b && x.state === "completed")).toHaveLength(1);
    expect(recordsOf(b).find((x) => x.recordId !== rec)).toMatchObject({ round: 1 });
  });

  it("refuses a setup.json whose identity names another setup", async () => {
    const a = await openSetup();
    const b = await openSetup();
    writeFileSync(join(setupDir(b), "setup.json"), readFileSync(join(setupDir(a), "setup.json")));
    expect((await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: b })).exitCode).toBe(2);
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: b })).exitCode).toBe(2);
    expect(reviews()).toBe(0);
  });

  it("prints the stop under an unreadable record, byte for byte", async () => {
    const id = await openSetup();
    await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id });
    const rec = recordsOf(id)[0]!.recordId;
    writeFileSync(join(setupDir(id), "records", rec, "record.json"), "{not json");
    expect(await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id })).toEqual({
      exitCode: 8,
      stdout: `Reviewer probe: codex codex-cli 9.9.9\nIndependent review: record unreadable, invocation ${rec}\n${STOP}\n`,
    });
  });
});

describe("gate and skip write the setup under its lock (T-536)", () => {
  it("a gate re-probe running beside run --new-cycle keeps the new cycle", async () => {
    const id = await openSetup();
    expect((await handleSetupReviewRun(io(REVIEW_PACKET), { setup: id })).exitCode).toBe(0);
    extraEnv = { FAKE_CODEX_VERSION_SLOW_MS: "1500" };
    const slowGate = gate(id);
    extraEnv = {};
    const other = REVIEW_PACKET.replace("one-hour", "two-hour");
    expect((await handleSetupReviewRun(io(other), { setup: id, newCycle: true, reason: "Owner adjustment" })).exitCode).toBe(0);
    expect((await slowGate).exitCode).toBe(0);
    const setup = JSON.parse(readFileSync(join(setupDir(id), "setup.json"), "utf-8"));
    expect(setup.cycle).toBe(2);
    expect(setup.cycleReasons).toEqual({ "2": "Owner adjustment" });
    expect(setup.probe).toEqual({ backend: "codex", version: "codex-cli 9.9.9" });
  });

  it("a gate re-probe while the setup's lock is held exits 7 and leaves setup.json alone", async () => {
    const id = await openSetup();
    const before = readFileSync(join(setupDir(id), "setup.json"), "utf-8");
    const held = await acquireProjectLockAsync(join(setupDir(id), "run.lock"));
    try {
      expect((await gate(id)).exitCode).toBe(7);
    } finally {
      releaseProjectLock(held);
    }
    expect(readFileSync(join(setupDir(id), "setup.json"), "utf-8")).toBe(before);
  });

  it("the owner's skip while the setup's lock is held exits 7 and records nothing", async () => {
    const id = await openSetup();
    const before = readFileSync(join(setupDir(id), "setup.json"), "utf-8");
    const held = await acquireProjectLockAsync(join(setupDir(id), "run.lock"));
    try {
      const s = await handleSetupReviewStatus(io(undefined), { setup: id, skipped: true });
      expect(s.exitCode).toBe(7);
      expect(s.stdout).not.toContain("skipped at the owner's request");
    } finally {
      releaseProjectLock(held);
    }
    expect(readFileSync(join(setupDir(id), "setup.json"), "utf-8")).toBe(before);
  });
});

describe("a published record is durable before it counts (T-536)", () => {
  const eio = (): never => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); };

  it("a directory sync failure after publishing prints the stop, and the next status reads the failure, never the verdict", async () => {
    const id = await openSetup();
    let calls = 0;
    const r = await handleSetupReviewRun(io(REVIEW_PACKET, { syncDir: () => { if (calls++ === 0) eio(); } }), { setup: id });
    expect(r.exitCode).toBe(6);
    expect(r.stdout).not.toMatch(/Independent review: (approve|revise|reject)/);
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(recordsOf(id).map((x) => x.state)).toEqual(["failed"]);
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(s.exitCode).toBe(3);
    expect(s.stdout).not.toContain("Independent review: approve");
  });

  it("when no directory sync succeeds, nothing certifies afterwards", async () => {
    const id = await openSetup();
    const r = await handleSetupReviewRun(io(REVIEW_PACKET, { syncDir: eio }), { setup: id });
    expect(r.exitCode).toBe(6);
    expect(r.stdout.trimEnd().endsWith(STOP)).toBe(true);
    expect(recordsOf(id).filter((x) => x.state === "completed")).toEqual([]);
    const s = await handleSetupReviewStatus(io(REVIEW_PACKET), { setup: id });
    expect(s.stdout).not.toContain("Independent review: approve");
  });
});

describe("a run killed inside publication, in fresh processes (T-536)", () => {
  function worker(mode: "run-pause" | "run" | "status", id: string): { child: ReturnType<typeof fork>; first: Promise<unknown> } {
    const fixture = join(import.meta.dirname, "fixtures", "setup-review-crash-worker.ts");
    const child = fork(fixture, [mode, project, store, id, fake.path, REVIEW_PACKET], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const first = new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("exit", (code) => reject(new Error(`worker exited ${code} before reporting`)));
    });
    return { child, first };
  }

  it("leaves no record, a stale lock the next run recovers, and exactly one completed retry", async () => {
    const id = await openSetup();
    const paused = worker("run-pause", id);
    expect(await paused.first).toBe("paused");
    const records = join(setupDir(id), "records");
    const staged = readdirSync(records).find((n) => n.startsWith(".staging-"))!;
    expect(existsSync(join(records, staged, "record.json"))).toBe(true);
    const exited = new Promise((r) => paused.child.once("exit", r));
    paused.child.kill("SIGKILL");
    await exited;
    expect(existsSync(join(setupDir(id), "run.lock"))).toBe(true);

    const status = worker("status", id);
    expect(await status.first).toMatchObject({ exitCode: 4, stdout: expect.stringContaining(`Independent review: none for revision ${d12(REVIEW_PACKET)}`) });
    const retry = worker("run", id);
    expect(await retry.first).toMatchObject({ exitCode: 0 });
    expect(readdirSync(records).filter((n) => n.startsWith(".staging-"))).toEqual([]);
    expect(recordsOf(id).filter((x) => x.state === "completed")).toHaveLength(1);
    expect(existsSync(join(setupDir(id), "run.lock"))).toBe(false);
  });
});

describe("the fake reviewers (T-536)", () => {
  it("puts nothing but the scratch bin on PATH, so an omitted reviewer cannot be found", () => {
    const only = makeFakeBin(["codex"]);
    expect(only.path).toBe(only.dir);
    const found = spawnSync(join(only.dir, "node"), ["-e", "require('node:child_process').execFileSync('claude', ['--version'])"], { env: { PATH: only.path } });
    expect(found.status).not.toBe(0);
  });
});
