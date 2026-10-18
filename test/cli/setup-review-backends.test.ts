/**
 * T-536: the two reviewers the CLI starts itself. The flags are pinned against
 * help text captured from the real binaries (test/fixtures/setup-review/), so
 * a flag that a CLI renames or drops shows up here rather than as a failed
 * review in a user's setup.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeArgs, codexArgs, parseReviewerOutput, probeBackend, reviewerEnv, runReviewer, SETUP_REVIEW_SCHEMA } from "../../src/core/setup-review-backends.js";
import { makeFakeBin } from "../helpers/setup-review-fakes.js";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { shouldSkipHousekeeping } from "../../src/cli/housekeeping.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "setup-review");
const claudeHelp = readFileSync(join(FIXTURES, "claude-help-2.1.302.txt"), "utf-8");
const codexHelp = readFileSync(join(FIXTURES, "codex-exec-help-0.163.0.txt"), "utf-8");

describe("setup reviewer backends (T-536)", () => {
  it("runs codex read-only, ephemeral, with a schema file and an output file, the prompt on stdin", () => {
    const args = codexArgs("/s/schema.json", "/s/out.json");
    expect(args).toEqual(["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--output-schema", "/s/schema.json", "-o", "/s/out.json", "-"]);
    for (const flag of args.filter((a) => a.startsWith("-") && a !== "-")) expect(codexHelp).toContain(flag);
  });

  it("runs claude in print mode with JSON output, the schema, no tools, no MCP servers and no saved session", () => {
    const args = claudeArgs(JSON.stringify(SETUP_REVIEW_SCHEMA));
    expect(args).toEqual(["-p", "--output-format", "json", "--json-schema", JSON.stringify(SETUP_REVIEW_SCHEMA), "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none"]);
    for (const flag of args.filter((a) => a.startsWith("--"))) expect(claudeHelp).toContain(flag);
    expect(args).not.toContain("--bare");
  });

  it("removes the parent Claude Code session from the claude reviewer's environment only", () => {
    const env = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "x", HOME: "/h" };
    expect(reviewerEnv("claude", env)).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(reviewerEnv("codex", env)).toEqual(env);
  });

  it("uses a strict-mode schema: every property required, plan verdicts only", () => {
    const s = SETUP_REVIEW_SCHEMA as { required: string[]; properties: Record<string, { enum?: string[]; items?: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean } }>; additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(s.properties));
    expect(s.properties.verdict!.enum).toEqual(["approve", "revise", "reject"]);
    const item = s.properties.findings!.items!;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(Object.keys(item.properties));
  });

  it("parses each backend's raw output and refuses anything outside the schema", () => {
    const review = { verdict: "revise", findings: [{ severity: "major", requirement: "R3", description: "missing" }] };
    expect(parseReviewerOutput("codex", Buffer.from(JSON.stringify(review)))).toEqual(review);
    expect(parseReviewerOutput("claude", Buffer.from(JSON.stringify({ type: "result", is_error: false, structured_output: review, session_id: "s" })))).toEqual({ ...review, sessionId: "s" });
    expect(() => parseReviewerOutput("codex", Buffer.from(JSON.stringify({ verdict: "maybe", findings: [] })))).toThrow();
    expect(() => parseReviewerOutput("codex", Buffer.from(JSON.stringify({ verdict: "approve", findings: "none" })))).toThrow();
    expect(() => parseReviewerOutput("codex", Buffer.from("not json"))).toThrow();
    expect(() => parseReviewerOutput("claude", Buffer.from(JSON.stringify({ type: "result", is_error: true, structured_output: review })))).toThrow();
    expect(() => parseReviewerOutput("claude", Buffer.from(JSON.stringify({ type: "result", is_error: false, result: "approve" })))).toThrow();
  });

  it("skips per-invocation housekeeping for setup-review, which runs before any project exists", () => {
    expect(shouldSkipHousekeeping(["setup-review", "gate"])).toBe(true);
    expect(shouldSkipHousekeeping(["setup-review", "status", "--setup", "SS-00000000", "--skipped"])).toBe(true);
  });
});

describe("reviewer processes always end (T-536)", () => {
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const within = <T>(p: Promise<T>, ms: number): Promise<T | "hung"> => Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);

  it("a probe whose backend ignores SIGTERM settles as unavailable and the backend is killed", async () => {
    const fake = makeFakeBin(["codex"]);
    const pidFile = join(fake.stdinDir, "probe.pid");
    const env = { PATH: fake.path, FAKE_CODEX_VERSION_HANG: "1", FAKE_PID_FILE: pidFile };
    expect(await within(probeBackend("codex", env, { timeoutMs: 300, killGraceMs: 200 }), 8_000)).toBeNull();
    const pid = Number(readFileSync(pidFile, "utf-8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("a probe that answers only after the timeout's SIGTERM is not startable", async () => {
    const fake = makeFakeBin(["codex"]);
    const env = { PATH: fake.path, FAKE_CODEX_VERSION_TERM_OK: "1" };
    expect(await within(probeBackend("codex", env, { timeoutMs: 300, killGraceMs: 200 }), 8_000)).toBeNull();
  }, 15_000);

  it("a review timeout kills the reviewer's whole process group and settles even while a child holds the pipes", async () => {
    const fake = makeFakeBin(["codex"]);
    const pidFile = join(fake.stdinDir, "grandchild.pid");
    const env = { PATH: fake.path, FAKE_CODEX_MODE: "wrapper", FAKE_PID_FILE: pidFile };
    const run = await within(runReviewer("codex", ["exec"], { cwd: fake.stdinDir, env, input: "packet", timeoutMs: 500, killGraceMs: 200 }), 8_000);
    const pid = Number(readFileSync(pidFile, "utf-8"));
    await new Promise((r) => setTimeout(r, 200));
    const gone = !alive(pid);
    if (!gone) process.kill(pid, "SIGKILL");
    expect(run).not.toBe("hung");
    expect(run).toMatchObject({ timedOut: true });
    expect(gone).toBe(true);
  }, 15_000);

  it("a review timeout settles a bounded time after SIGKILL even when a process outside the group holds the pipes", async () => {
    const fake = makeFakeBin(["codex"]);
    const pidFile = join(fake.stdinDir, "escaped.pid");
    const env = { PATH: fake.path, FAKE_CODEX_MODE: "escape", FAKE_PID_FILE: pidFile };
    const started = Date.now();
    const run = await within(runReviewer("codex", ["exec"], { cwd: fake.stdinDir, env, input: "packet", timeoutMs: 300, killGraceMs: 200 }), 8_000);
    const elapsed = Date.now() - started;
    try { process.kill(Number(readFileSync(pidFile, "utf-8")), "SIGKILL"); } catch { /* gone */ }
    expect(run).toMatchObject({ timedOut: true, exitCode: null });
    expect(elapsed).toBeLessThan(3_000);
  }, 15_000);

  for (const mode of ["review", "probe"] as const) {
    it(`a process that timed out a ${mode} exits by itself while the escaped child is still alive`, async () => {
      const fake = makeFakeBin(["codex"]);
      const project = mkdtempSync(join(tmpdir(), "sr-exit-project-"));
      const store = mkdtempSync(join(tmpdir(), "sr-exit-store-"));
      const pidFile = join(fake.stdinDir, "escaped.pid");
      const fixture = join(import.meta.dirname, "fixtures", "setup-review-exit-worker.ts");
      const child = spawn(process.execPath, ["--import", "tsx", fixture, mode, project, store, fake.path, pidFile], { stdio: ["ignore", "pipe", "inherit"] });
      let stdout = "";
      child.stdout.on("data", (c) => { stdout += String(c); });
      const exited = await within(new Promise<number | null>((r) => child.once("exit", (code) => r(code))), 10_000);
      const pid = Number(readFileSync(pidFile, "utf-8"));
      const stillAlive = alive(pid);
      if (exited === "hung") child.kill("SIGKILL");
      try {
        expect(exited).toBe(0);
        expect(stillAlive).toBe(true);
        expect(stdout).toMatch(mode === "probe" ? /"version":null/ : /"exitCode":3/);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
    }, 20_000);
  }
});

describe.skipIf(process.platform === "win32")("a signal during a setup review ends the reviewer's group (ISS-1391)", () => {
  type Ended = { code: number | null; signal: NodeJS.Signals | null };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return true; await sleep(25); }
    return cond();
  };
  const groupAlive = (pgid: number): boolean => {
    try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  const pidIn = (file: string): number => (existsSync(file) ? Number(readFileSync(file, "utf-8").trim()) : 0);

  /** Starts the signal worker, waits until the reviewer is up, sends `sig` (if any) and reports how the worker ended. */
  async function run(mode: string, sig: NodeJS.Signals | null, listener?: string): Promise<{ ended: Ended | "hung"; stdout: string; groupGone: boolean }> {
    const fake = makeFakeBin(["codex"]);
    const project = mkdtempSync(join(tmpdir(), "sr-signal-project-"));
    const store = mkdtempSync(join(tmpdir(), "sr-signal-store-"));
    const pidFile = join(fake.stdinDir, "reviewer.pid");
    const fixture = join(import.meta.dirname, "fixtures", "setup-review-signal-worker.ts");
    const args = ["--import", "tsx", fixture, mode, project, store, fake.path, pidFile, ...(listener ? [listener] : [])];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    const exit = new Promise<Ended>((r) => child.once("exit", (code, signal) => r({ code, signal })));
    let pgid = 0;
    try {
      // review-exit ends its own group at once, so the worker records the group id before it exits.
      const pgidFile = `${pidFile}.pgid`;
      const up = await until(() => (mode === "review-exit" ? pidIn(pgidFile) > 0 : pidIn(pidFile) > 0 && (mode !== "overlap" || stdout.includes("ready\n"))), 15_000);
      expect(up).toBe(true);
      pgid = mode === "review-exit" ? pidIn(pgidFile) : Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pidIn(pidFile))], { encoding: "utf-8" }).trim());
      expect(pgid).toBeGreaterThan(0);
      if (sig) child.kill(sig);
      const ended = await within(exit, 8_000);
      const groupGone = await until(() => !groupAlive(pgid), 3_000);
      return { ended, stdout, groupGone };
    } finally {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      if (pgid > 0) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
    }
  }
  const within = <T>(p: Promise<T>, ms: number): Promise<T | "hung"> => Promise.race([p, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);
  const count = (stdout: string, word: string): number => stdout.split("\n").filter((l) => l === word).length;

  it.each([
    ["review", "SIGINT"],
    ["review", "SIGTERM"],
    ["probe", "SIGINT"],
    ["review", "SIGHUP"],
  ] as const)("a %s that gets %s kills the reviewer's group and the CLI ends by that signal", async (mode, sig) => {
    const { ended, groupGone } = await run(mode, sig);
    expect(ended).toEqual({ code: null, signal: sig });
    expect(groupGone).toBe(true);
  }, 30_000);

  it("a caller's synchronous SIGINT listener still owns the exit and the group is killed", async () => {
    const { ended, stdout, groupGone } = await run("review", "SIGINT", "exit-sync");
    expect(count(stdout, "own")).toBe(1);
    expect(ended).toEqual({ code: 130, signal: null });
    expect(groupGone).toBe(true);
  }, 30_000);

  it("the signal listeners are back at their pre-run count once a review settles", async () => {
    const sigs = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const before = sigs.map((s) => process.listenerCount(s));
    const fake = makeFakeBin(["codex"]);
    const env = { PATH: fake.path, FAKE_CODEX_MODE: "exit1" };
    await runReviewer("codex", ["exec"], { cwd: fake.stdinDir, env, input: "packet", timeoutMs: 10_000, killGraceMs: 200 });
    expect(sigs.map((s) => process.listenerCount(s))).toEqual(before);
  }, 15_000);

  it("a caller's persistent SIGINT listener runs once and finishes its own shutdown", async () => {
    const { ended, stdout, groupGone } = await run("review", "SIGINT", "persistent-delayed");
    expect(count(stdout, "own")).toBe(1);
    expect(count(stdout, "cleanup-done")).toBe(1);
    expect(ended).toEqual({ code: 130, signal: null });
    expect(groupGone).toBe(true);
  }, 30_000);

  it("a caller's once SIGTERM listener finishes its async shutdown with its own code", async () => {
    const { ended, stdout, groupGone } = await run("review", "SIGTERM", "once-async");
    expect(count(stdout, "cleanup-done")).toBe(1);
    expect(ended).toEqual({ code: 42, signal: null });
    expect(groupGone).toBe(true);
  }, 30_000);

  it("a run that settles while another is live leaves the handler installed for the live one", async () => {
    const { ended, stdout, groupGone } = await run("overlap", "SIGINT");
    const baseline = Number(/^baseline:(\d+)$/m.exec(stdout)?.[1]);
    expect(stdout).toMatch(new RegExp(`^listeners:${baseline + 1}$`, "m"));
    expect(ended).toEqual({ code: null, signal: "SIGINT" });
    expect(groupGone).toBe(true);
  }, 30_000);

  it("a CLI that exits normally while the reviewer runs kills the reviewer's group", async () => {
    const { ended, groupGone } = await run("review-exit", null);
    expect(ended).toEqual({ code: 130, signal: null });
    expect(groupGone).toBe(true);
  }, 30_000);
});
