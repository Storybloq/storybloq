/**
 * T-538 commit 2a (plan 5.1 to 5.4, Addendum B): the host route's turn mechanics as parts. How a process result
 * reads, the leftover check, the capture limits, the server's sandboxed launch, the environment table, Codex's
 * tool approvals, the evaluation entry's self-probe and allow-list, and the pinned inventory against the real
 * bundle. The rows that need the real `codex sandbox` wrapper are opt-in (STORYBLOQ_REAL_CODEX=1 with
 * STORYBLOQ_REAL_CODEX_BIN), as in the setup-review real-codex suite: skipped without it, failing when it is
 * asked for and missing.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  codexApprovalProblems, codexApprovalTables, envFor, envKeyProblems, heldServerLaunches, launchHeld, leftoverCheck, NO_SANDBOXED_SERVER, serverLaunchFailure, serverLaunchLines, UNSANDBOXED_SERVER, mcpEnvFor, parseLsof, processOutcome, sandboxSettings, serverLaunch, writeServerLauncher,
  TURN_LIMITS, TurnCapture, type EnvInputs,
} from "../../scripts/onboarding-eval-host.js";
import { allowList, collector, outsideProbe, readEvalArgs, restrictTools } from "../../scripts/eval-fault-mcp.js";
import { parseEventsLog } from "../../scripts/onboarding-eval-checkset7-events.js";
import { claudeToolSets, isolationProblems, TOOL_SETS_FILE, turnInfraFailure, type TurnFailureFacts } from "../../scripts/onboarding-eval-run.js";
import { codexSandboxArgs, codexSandboxProblems, turnArgs } from "../../scripts/onboarding-eval-lib.js";
import { attemptBase, configProblems, fileEntry } from "../../scripts/onboarding-eval-config.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVAL_MCP = join(PKG, ".eval-dist", "eval-mcp.js");
const REAL = process.env.STORYBLOQ_REAL_CODEX === "1";
const CODEX = process.env.STORYBLOQ_REAL_CODEX_BIN ?? "";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(d, 0o755); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const scratch = (p = "t538-2a-"): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

// --- Addendum B ruling 1: how a process result reads -----------------------------------------------------

describe("a process result reads by its launch kind, never by its number", () => {
  it("unwrapped keeps today's forms", () => {
    expect(processOutcome(null, "SIGKILL", false)).toEqual({ exitCode: null, signal: "SIGKILL", wrapped: false, form: "killed by SIGKILL", killedBy: "SIGKILL" });
    expect(processOutcome(137, null, false)).toEqual({ exitCode: 137, signal: null, wrapped: false, form: "exit 137", killedBy: null });
    expect(processOutcome(1, null, false).form).toBe("exit 1");
    expect(processOutcome(0, null, false)).toEqual({ exitCode: 0, signal: null, wrapped: false, form: null, killedBy: null });
  });

  it("wrapped 128 + n with no signal is the wrapped form, with killedBy derived and the raw fields kept", () => {
    expect(processOutcome(137, null, true)).toEqual({ exitCode: 137, signal: null, wrapped: true, form: "exit 137 (wrapped, signal 9 inside the sandbox)", killedBy: "SIGKILL" });
    expect(processOutcome(143, null, true)).toMatchObject({ form: "exit 143 (wrapped, signal 15 inside the sandbox)", killedBy: "SIGTERM" });
    // SIGABRT and SIGIOT share 6: the first name is the one given.
    expect(processOutcome(134, null, true).killedBy).toBe("SIGABRT");
    expect(processOutcome(137, null, true).form).not.toMatch(/^killed by/);
  });

  it("wrapped with an ordinary exit, a number past every signal, or a signal of its own reads as unwrapped would", () => {
    expect(processOutcome(1, null, true)).toMatchObject({ form: "exit 1", killedBy: null });
    expect(processOutcome(128, null, true)).toMatchObject({ form: "exit 128", killedBy: null });
    expect(processOutcome(250, null, true)).toMatchObject({ form: "exit 250", killedBy: null });
    expect(processOutcome(null, "SIGTERM", true)).toMatchObject({ form: "killed by SIGTERM", killedBy: "SIGTERM" });
    expect(processOutcome(0, null, true)).toMatchObject({ form: null, killedBy: null });
  });
});

// --- 5.1: the turn's failure order, the leftover check and the limits ------------------------------------

const FACTS: TurnFailureFacts = {
  spawnError: null, launch: null, inputError: null, limit: null, timedOut: false, timeoutMs: 1000, outcome: processOutcome(0, null, false),
  terminal: { status: "completed", detail: "" }, cleanup: "confirmed", cleanupDetail: null, leftover: { status: "clean", holders: [], reason: null },
};

describe("a turn's infrastructure failure, in order", () => {
  it("a clean turn is null; each fact alone names itself", () => {
    expect(turnInfraFailure(FACTS)).toBeNull();
    expect(turnInfraFailure({ ...FACTS, limit: "limit: stdout over 67108864 bytes" })).toBe("limit: stdout over 67108864 bytes");
    expect(turnInfraFailure({ ...FACTS, outcome: processOutcome(137, null, true) })).toBe("exit 137 (wrapped, signal 9 inside the sandbox)");
    expect(turnInfraFailure({ ...FACTS, leftover: parseLsof("p42\ncnode\nfcwd\n", "") })).toBe("cleanup: leftover: 42 node");
    expect(turnInfraFailure({ ...FACTS, leftover: parseLsof("", "lsof: WARNING: can't stat() apfs file system /x\n") })).toBe("cleanup: leftover check failed: lsof: WARNING: can't stat() apfs file system /x");
  });

  it("the limit comes after input and before the deadline; the leftover comes last, after the group's own cleanup", () => {
    const limit = "limit: stderr over 8388608 bytes";
    expect(turnInfraFailure({ ...FACTS, inputError: "EPIPE", limit })).toBe("input: EPIPE");
    expect(turnInfraFailure({ ...FACTS, launch: "x", limit })).toBe("launch: x");
    expect(turnInfraFailure({ ...FACTS, limit, timedOut: true })).toBe(limit);
    expect(turnInfraFailure({ ...FACTS, limit, outcome: processOutcome(null, "SIGTERM", false) })).toBe(limit);
    // 2b (5.5): the request folder's failure ranks right after the limit, above the timeout and the exit.
    const review = "review requests: poll unanswered";
    expect(turnInfraFailure({ ...FACTS, limit, review })).toBe(limit);
    expect(turnInfraFailure({ ...FACTS, inputError: "EPIPE", review })).toBe("input: EPIPE");
    expect(turnInfraFailure({ ...FACTS, review, timedOut: true, outcome: processOutcome(null, "SIGTERM", false) })).toBe(review);
    const leftover = parseLsof("p7\ncsleep\n", "");
    expect(turnInfraFailure({ ...FACTS, leftover, cleanup: "unconfirmed", cleanupDetail: "pgid 9" })).toBe("cleanup: unconfirmed: pgid 9");
    expect(turnInfraFailure({ ...FACTS, leftover, terminal: { status: "failed", detail: "d" } })).toBe("terminal failed: d");
    expect(turnInfraFailure({ ...FACTS, leftover, outcome: processOutcome(3, null, false) })).toBe("exit 3");
  });
});

describe("the leftover check reads lsof's output only (Addendum B)", () => {
  it("parses holders from p and c lines, ignores f lines, and treats empty output as clean", () => {
    expect(parseLsof("", "")).toEqual({ status: "clean", holders: [], reason: null });
    expect(parseLsof("p10\ncnode\nfcwd\nf3\np11\ncsleep\nf1\n", "")).toEqual({
      status: "holders", holders: [{ pid: 10, command: "node" }, { pid: 11, command: "sleep" }], reason: "leftover: 10 node, 11 sleep",
    });
  });

  it("any stderr is a failed check named by its first line, and any line it cannot read is a failed check", () => {
    expect(parseLsof("p10\ncnode\n", "\nlsof: status error on /x: No such file or directory\nmore\n")).toEqual({ status: "failed", holders: [], reason: "leftover check failed: lsof: status error on /x: No such file or directory" });
    expect(parseLsof("p10\nnname\n", "").status).toBe("failed");
    expect(parseLsof("px\n", "").status).toBe("failed");
    expect(parseLsof("cnode\n", "").status).toBe("failed");
  });

  it("the real lsof's three cases read by output alone: no holder, a holder, a missing tree", () => {
    const tree = scratch();
    expect(leftoverCheck(tree)).toEqual({ status: "clean", holders: [], reason: null });
    const r = spawnSync(LSOF_PROBE.cmd, LSOF_PROBE.args(tree), { encoding: "utf-8" });
    expect(r.status).toBe(1);
    const sleeper = spawn("/bin/sleep", ["30"], { cwd: tree, stdio: "ignore" });
    try {
      waitFor(() => leftoverCheck(tree).status === "holders");
      const held = leftoverCheck(tree);
      expect(held.holders).toEqual([{ pid: sleeper.pid, command: "sleep" }]);
      // The plan measured exit 1 here; this machine's lsof exits 0 with a holder. The check never reads it.
      expect([0, 1]).toContain(spawnSync(LSOF_PROBE.cmd, LSOF_PROBE.args(tree), { encoding: "utf-8" }).status);
    } finally { sleeper.kill("SIGKILL"); }
    const missing = leftoverCheck(join(tree, "gone"));
    expect(missing.status).toBe("failed");
    expect(missing.reason).toMatch(/^leftover check failed: \S/);
    expect(spawnSync(LSOF_PROBE.cmd, LSOF_PROBE.args(join(tree, "gone")), { encoding: "utf-8" }).status).toBe(1);
  });

  it("a descendant that left the group with setsid and keeps a file open under the tree is found", () => {
    const tree = scratch();
    const file = join(tree, "held.txt");
    const child = spawn(process.execPath, ["-e", `const fs=require("fs");const fd=fs.openSync(${JSON.stringify(file)},"w");process.chdir("/");setInterval(()=>{},1000);`], { detached: true, stdio: "ignore", cwd: "/" });
    child.unref();
    try {
      waitFor(() => leftoverCheck(tree).status === "holders");
      expect(leftoverCheck(tree).holders.map((h) => h.pid)).toEqual([child.pid]);
    } finally { process.kill(child.pid!, "SIGKILL"); }
  });

  it("a launch failure of lsof itself is a failed check, never clean", () => {
    expect(leftoverCheck(scratch(), 60_000, "/nonexistent/lsof")).toMatchObject({ status: "failed", reason: expect.stringMatching(/^leftover check failed: /) });
  });
});

const LSOF_PROBE = { cmd: "/usr/sbin/lsof", args: (t: string) => ["-n", "-P", "-F", "pc", "+D", t] };
function waitFor(ok: () => boolean, ms = 10_000): void {
  const until = Date.now() + ms;
  while (!ok()) { if (Date.now() > until) throw new Error("waitFor timed out"); spawnSync("/bin/sleep", ["0.1"]); }
}

describe("the turn's capture limits (5.1)", () => {
  const limits = { deadlineMs: 1000, stdoutBytes: 10, stderrBytes: 4, attemptCaptureBytes: 16, graceMs: 1 };
  it("pins the plan's values", () => {
    expect(TURN_LIMITS).toEqual({ deadlineMs: 40 * 60_000, stdoutBytes: 64 << 20, stderrBytes: 8 << 20, attemptCaptureBytes: 256 << 20, graceMs: 15_000 });
  });

  it("truncates at a stream's limit, names it, and stops once; later chunks are dropped, nothing throws", () => {
    let stops = 0;
    const c = new TurnCapture({ used: 0 }, () => { stops += 1; }, limits);
    expect(c.take("stdout", Buffer.from("123456")).toString()).toBe("123456");
    expect(c.take("stdout", Buffer.from("789abc")).toString()).toBe("789a");
    expect(c.exceeded).toBe("limit: stdout over 10 bytes");
    expect(c.take("stderr", Buffer.from("x")).length).toBe(0);
    expect(c.take("stdout", Buffer.from("y")).length).toBe(0);
    expect(stops).toBe(1);
  });

  it("stderr has its own limit", () => {
    let stops = 0;
    const c = new TurnCapture({ used: 0 }, () => { stops += 1; }, limits);
    expect(c.take("stderr", Buffer.from("abcdef")).toString()).toBe("abcd");
    expect(c.exceeded).toBe("limit: stderr over 4 bytes");
    expect(stops).toBe(1);
  });

  it("the attempt's capture is shared across turns and is named when it is the limit reached", () => {
    const attempt = { used: 0 };
    const t1 = new TurnCapture(attempt, () => {}, limits);
    t1.take("stdout", Buffer.from("1234567890"));
    expect(t1.exceeded).toBeNull();
    const t2 = new TurnCapture(attempt, () => {}, limits);
    expect(t2.take("stdout", Buffer.from("abcdefgh")).toString()).toBe("abcdef");
    expect(t2.exceeded).toBe("limit: attempt capture over 16 bytes");
    expect(attempt.used).toBe(16);
  });

  it("a stop that throws is swallowed", () => {
    const c = new TurnCapture({ used: 0 }, () => { throw new Error("boom"); }, limits);
    expect(() => c.take("stdout", Buffer.alloc(11))).not.toThrow();
    expect(c.exceeded).toBe("limit: stdout over 10 bytes");
  });
});

// --- 5.2: the server's launch and its self-probe -----------------------------------------------------------

describe("the tool server's sandboxed launch (5.2)", () => {
  it("is the launcher with the column's names, then the codex wrapper with the plan's five settings, then node, the bundle and --entry mcp", () => {
    const roots = ["/w/project", "/w/project/.git", "/w/tmp"];
    expect(serverLaunch("/opt/codex/bin/codex", "/usr/bin/node", "/pkg/.eval-dist/eval-mcp.js", roots, "/w/server-launcher.sh", ["PATH", "HOME"])).toEqual({
      command: "/bin/sh",
      args: [
        "/w/server-launcher.sh", "HOME", "PATH", "--", "/opt/codex/bin/codex", "sandbox", "-c", 'sandbox_mode="workspace-write"', "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`, "-c", "sandbox_workspace_write.network_access=false",
        "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "--", "/usr/bin/node", "/pkg/.eval-dist/eval-mcp.js", "--entry", "mcp",
      ],
    });
    expect(sandboxSettings(roots)).toHaveLength(5);
  });

  it("refuses a codex that is not an absolute path (never a PATH lookup)", () => {
    expect(() => serverLaunch("codex", "/usr/bin/node", "/b.js", [], "/l.sh", [])).toThrow(/not an absolute path/);
    expect(() => serverLaunch("/c", "/usr/bin/node", "/b.js", [], "l.sh", [])).toThrow(/launcher l\.sh is not an absolute path/);
    for (const bad of ["path", "A-B", "1A", "", "A=B"]) expect(() => serverLaunch("/c", "/usr/bin/node", "/b.js", [], "/l.sh", [bad])).toThrow(/not a variable name/);
  });

  it("F2: the launcher runs its command with exactly the named variables that are set, values intact, nothing inherited", () => {
    const d = scratch("t538-f2-launcher-");
    const launcher = writeServerLauncher(d);
    const odd = "a b\"c'$(x)`y`\\n";
    const r = spawnSync("/bin/sh", [launcher, "KEEP", "ODD", "UNSET_ONE", "--", process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: { PATH: "/usr/bin:/bin", KEEP: "1", ODD: odd, CLAUDE_CODE_OAUTH_TOKEN: "placeholder-not-a-token", DROP: "x" }, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    // macOS adds __CF_USER_TEXT_ENCODING to every new process itself; the launcher was given no such variable.
    const { __CF_USER_TEXT_ENCODING: _os, ...got } = JSON.parse(r.stdout) as Record<string, string>;
    expect(got).toEqual({ KEEP: "1", ODD: odd });
    expect(spawnSync("/bin/sh", [launcher, "bad-name", "--", "/usr/bin/true"], { encoding: "utf-8" }).status).toBe(64);
    expect(spawnSync("/bin/sh", [launcher, "A"], { encoding: "utf-8" }).status).toBe(64);
  });

  it("F2: the manifest check refuses the launcher when its mode or its bytes differ from the manifest entry", () => {
    const d = scratch("t538-f2-manifest-");
    const launcher = writeServerLauncher(d);
    const m = { folders: [d], entries: [fileEntry(launcher)] };
    expect(m.entries[0]).toMatchObject({ kind: "file", path: launcher, mode: 0o500 });
    expect(configProblems(m)).toEqual([]);
    chmodSync(launcher, 0o700);
    expect(configProblems(m)).toEqual([`config: ${launcher} changed mode`]);
    writeFileSync(launcher, readFileSync(launcher, "utf-8").replace("exec /usr/bin/env -i", "exec /usr/bin/env"));
    chmodSync(launcher, 0o500);
    expect(configProblems(m)).toEqual([`config: ${launcher} changed`]);
  });

  it("the entry's probe: a folder it cannot write is held, one it can is absent and the file is gone, any other error throws", () => {
    const d = scratch();
    expect(outsideProbe(d)).toBe("absent");
    expect(existsSync(d) && spawnSync("/bin/ls", ["-A", d], { encoding: "utf-8" }).stdout).toBe("");
    const locked = join(d, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    expect(outsideProbe(locked)).toBe("held");
    chmodSync(locked, 0o755);
    expect(() => outsideProbe(join(d, "missing"))).toThrow(/the outside probe .* failed: ENOENT/);
  });

  it("the entry's variables: the probe folder and the inventory only for entry mcp", () => {
    const env = { STORYBLOQ_EVAL_EVENTS: "/e", STORYBLOQ_EVAL_OUTSIDE: "/o", STORYBLOQ_EVAL_TOOLS: "/t" };
    expect(readEvalArgs(["node", "b", "--entry", "mcp"], env)).toMatchObject({ entry: "mcp", outside: "/o", tools: "/t" });
    expect(readEvalArgs(["node", "b", "--entry", "cli"], env)).toMatchObject({ entry: "cli", outside: null, tools: null });
    // Q4 ruling: entry mcp refuses without either, before anything is written; entry cli needs neither.
    expect(() => readEvalArgs(["node", "b", "--entry", "mcp"], { ...env, STORYBLOQ_EVAL_OUTSIDE: "" })).toThrow("eval-fault-mcp: STORYBLOQ_EVAL_OUTSIDE is required for entry mcp");
    expect(() => readEvalArgs(["node", "b", "--entry", "mcp"], { STORYBLOQ_EVAL_EVENTS: "/e", STORYBLOQ_EVAL_TOOLS: "/t" })).toThrow("eval-fault-mcp: STORYBLOQ_EVAL_OUTSIDE is required for entry mcp");
    expect(() => readEvalArgs(["node", "b", "--entry", "mcp"], { STORYBLOQ_EVAL_EVENTS: "/e", STORYBLOQ_EVAL_OUTSIDE: "/o" })).toThrow("eval-fault-mcp: STORYBLOQ_EVAL_TOOLS is required for entry mcp");
    expect(readEvalArgs(["node", "b", "--entry", "cli"], { STORYBLOQ_EVAL_EVENTS: "/e" })).toMatchObject({ entry: "cli", outside: null, tools: null });
  });

  it("the launch line carries what the entry was given, on the attempt line", () => {
    const d = scratch();
    const events = join(d, "e.jsonl");
    collector(events, null, "mcp", () => {}, { sandbox: "held", tools: "a".repeat(64) });
    const line = JSON.parse(readFileSync(events, "utf-8").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ entry: "mcp", sandbox: "held", tools: "a".repeat(64) });
    expect(Object.keys(line).sort()).toEqual(["attempt", "entry", "pid", "sandbox", "tools"]);
  });

  it("only held mcp launches with the pinned inventory count for a turn", () => {
    const t = "b".repeat(64);
    const lines = [
      { attempt: "a1", pid: 1, entry: "mcp", sandbox: "held", tools: t },
      { attempt: "a2", pid: 2, entry: "mcp", sandbox: "absent", tools: t },
      { attempt: "a3", pid: 3, entry: "cli", sandbox: "held", tools: t },
      { attempt: "a4", pid: 4, entry: "mcp", sandbox: "held", tools: "c".repeat(64) },
      { attempt: "a5", pid: 5, entry: "mcp", tools: t },
      { seq: 0, attempt: "a1", entry: "mcp", sandbox: "held", tools: t },
    ].map((l) => JSON.stringify(l)).join("\n");
    expect(heldServerLaunches(`${lines}\nnot json\n`, t)).toEqual(["a1"]);
    expect(heldServerLaunches("", t)).toEqual([]);
    // P1: every mcp launch line, whatever its keys, in log order; cli lines and event lines are not launches.
    expect(serverLaunchLines(`${lines}\nnot json\n`).map((l) => l.attempt)).toEqual(["a1", "a2", "a4", "a5"]);
  });

  it("P1: the first launch not held with the pinned inventory is the turn's launch failure, then none held", () => {
    const t = "b".repeat(64);
    const held = { attempt: "h", sandbox: "held", tools: t };
    expect(serverLaunchFailure([held], t)).toBeNull();
    expect(serverLaunchFailure([], t)).toBe(NO_SANDBOXED_SERVER);
    expect(serverLaunchFailure([held, { attempt: "k" }], t)).toBe(`${UNSANDBOXED_SERVER} k`);
    expect(serverLaunchFailure([held, { attempt: "x", sandbox: "absent", tools: t }], t)).toBe("unsandboxed storybloq server launch x");
    expect(serverLaunchFailure([held, { attempt: "w", sandbox: "held", tools: "c".repeat(64) }], t)).toBe("unsandboxed storybloq server launch w");
    expect(serverLaunchFailure([held, { attempt: "o", sandbox: "held" }, { attempt: "k" }], t)).toBe("unsandboxed storybloq server launch o");
    expect(launchHeld(held, t)).toBe(true);
    expect(launchHeld({ attempt: "n", tools: t }, t)).toBe(false);
  });
});

// --- 5.3: one environment table ---------------------------------------------------------------------------

const INPUTS: EnvInputs = {
  client: "codex", path: "/w/cli-bin:/usr/bin:/bin", home: "/w/home", tmp: "/w/tmp", lang: "en_US.UTF-8", clientCodexHome: "/w/home/.codex",
  runnerHome: "/w/sandbox-runner-home", globalDir: "/w/storybloq-global", events: "/w/eval-events/events.jsonl", fault: null, reviewStore: "/w/storybloq-setup-review-store",
  outside: "/w/outside-probe", tools: "/pkg/scripts/onboarding-eval-tools.json", degraded: false,
};
const CLAUDE_INPUTS: EnvInputs = { ...INPUTS, client: "claude", clientCodexHome: undefined, claudeConfigDir: "/w/claude-config", oauthToken: "token-not-read", degraded: true };

describe("one environment table (5.3)", () => {
  it("the Codex client column", () => {
    expect(envFor("client", INPUTS)).toEqual({
      PATH: INPUTS.path, HOME: "/w/home", TMPDIR: "/w/tmp", LANG: "en_US.UTF-8", NO_UPDATE_NOTIFIER: "1", CODEX_HOME: "/w/home/.codex", STORYBLOQ_CLIENT: "codex", STORYBLOQ_GLOBAL_DIR: "/w/storybloq-global",
      STORYBLOQ_EVAL_EVENTS: INPUTS.events, STORYBLOQ_SETUP_REVIEW_DIR: INPUTS.reviewStore,
    });
  });

  it("the Claude client column: config dir and token, no CODEX_HOME, ENABLE_TOOL_SEARCH only when degraded", () => {
    expect(envFor("client", CLAUDE_INPUTS)).toEqual({
      PATH: INPUTS.path, HOME: "/w/home", TMPDIR: "/w/tmp", LANG: "en_US.UTF-8", NO_UPDATE_NOTIFIER: "1", CLAUDE_CONFIG_DIR: "/w/claude-config", CLAUDE_CODE_OAUTH_TOKEN: "token-not-read", STORYBLOQ_CLIENT: "claude",
      STORYBLOQ_GLOBAL_DIR: "/w/storybloq-global", STORYBLOQ_EVAL_EVENTS: INPUTS.events, STORYBLOQ_SETUP_REVIEW_DIR: INPUTS.reviewStore, ENABLE_TOOL_SEARCH: "true",
    });
    expect(envFor("client", { ...CLAUDE_INPUTS, degraded: false }).ENABLE_TOOL_SEARCH).toBeUndefined();
  });

  it("the server column is the same for both clients but the client name: the runner home, the probe folder and the inventory, no client secrets", () => {
    const want = {
      PATH: INPUTS.path, HOME: "/w/home", TMPDIR: "/w/tmp", LANG: "en_US.UTF-8", NO_UPDATE_NOTIFIER: "1", CODEX_HOME: "/w/sandbox-runner-home", STORYBLOQ_CLIENT: "codex", STORYBLOQ_GLOBAL_DIR: "/w/storybloq-global",
      STORYBLOQ_EVAL_EVENTS: INPUTS.events, STORYBLOQ_SETUP_REVIEW_DIR: INPUTS.reviewStore, STORYBLOQ_EVAL_OUTSIDE: "/w/outside-probe", STORYBLOQ_EVAL_TOOLS: INPUTS.tools,
    };
    expect(mcpEnvFor(INPUTS)).toEqual(want);
    expect(envFor("server", CLAUDE_INPUTS)).toEqual({ ...want, STORYBLOQ_CLIENT: "claude" });
  });

  it("the fault variables are in both columns only while armed", () => {
    const armed = { ...INPUTS, fault: "step:handover", faultId: "f1" };
    for (const role of ["client", "server"] as const) {
      expect(envFor(role, armed)).toMatchObject({ STORYBLOQ_EVAL_FAULT: "step:handover", STORYBLOQ_EVAL_FAULT_ID: "f1" });
      expect(Object.keys(envFor(role, INPUTS)).filter((k) => k.startsWith("STORYBLOQ_EVAL_FAULT"))).toEqual([]);
    }
  });

  it("an undefined or empty required value throws before anything is written", () => {
    expect(() => envFor("client", { ...INPUTS, clientCodexHome: undefined })).toThrow(/CODEX_HOME has no value for the client environment/);
    expect(() => envFor("client", { ...CLAUDE_INPUTS, oauthToken: undefined })).toThrow(/CLAUDE_CODE_OAUTH_TOKEN has no value/);
    expect(() => envFor("server", { ...INPUTS, outside: "" })).toThrow(/STORYBLOQ_EVAL_OUTSIDE has no value for the server environment/);
    expect(() => envFor("server", { ...INPUTS, lang: "" })).toThrow(/LANG has no value/);
  });

  it("the key set is exact: a missing key and an extra key are each a problem", () => {
    const col = envFor("client", INPUTS);
    expect(envKeyProblems({ ...col }, col, "client")).toEqual([]);
    const { LANG: _l, ...missing } = col;
    expect(envKeyProblems(missing, col, "client")).toEqual(["LANG is missing from the client environment"]);
    expect(envKeyProblems({ ...col, USER: "me" }, col, "client")).toEqual(["USER is not in the client column"]);
    expect(isolationProblems({ ...col, HOME: "/w/home", TMPDIR: "/w/tmp" }, "/w", "codex", col)).toEqual([]);
    expect(isolationProblems({ ...col, SHELL: "/bin/zsh" }, "/w", "codex", col)).toEqual(["SHELL is not in the client column"]);
  });

  it("Codex gets the server column on every turn, first and resumed, and the policy check holds those exact keys", () => {
    const server = mcpEnvFor(INPUTS);
    const roots = ["/w/home", "/w/tmp"];
    const keys = Object.keys(server).sort().map((k) => `mcp_servers.storybloq.env.${k}=${JSON.stringify(server[k])}`);
    for (const first of [true, false]) {
      const args = turnArgs({ client: "codex", model: "m", project: "/w/project", claudeArgs: [], sessionId: "th", first, writableRoots: roots, serverEnv: server }, "hi");
      const configs = args.flatMap((x, i) => (x === "-c" ? [args[i + 1]!] : []));
      expect(configs.slice(7)).toEqual(keys);
      expect(codexSandboxProblems(args, roots, server)).toEqual([]);
      // Without the keys the turn does not hold.
      expect(codexSandboxProblems(args, roots, { ...server, STORYBLOQ_EVAL_FAULT: "x" })).toContain('mcp_servers.storybloq.env.STORYBLOQ_EVAL_FAULT="x" is missing');
    }
    const plain = codexSandboxArgs(roots);
    expect(codexSandboxProblems([...plain, "-c", 'mcp_servers.storybloq.env.HOME="/w/home"', "--", "p"], roots)).toEqual(['mcp_servers.storybloq.env.HOME="/w/home" is refused: the policy does not name mcp_servers.storybloq.env.HOME']);
    const args = turnArgs({ client: "codex", model: "m", project: "/p", claudeArgs: [], sessionId: null, first: true, writableRoots: roots, serverEnv: server }, "hi");
    const i = args.indexOf(`mcp_servers.storybloq.env.HOME=${JSON.stringify("/w/home")}`);
    const edited = [...args];
    edited[i] = 'mcp_servers.storybloq.env.HOME="/elsewhere/home"';
    expect(codexSandboxProblems(edited, roots, server)[0]).toMatch(/conflicts with mcp_servers\.storybloq\.env\.HOME=/);
  });
});

// --- 5.4: the inventory, the approvals and the allow-list -------------------------------------------------

describe("Codex's tool approvals (Addendum B, ruling 2)", () => {
  const union = ["storybloq_status", "storybloq_init", "storybloq_ticket_get"];
  it("one approval table per name in the union, sorted, nothing else", () => {
    const text = codexApprovalTables([...union, "storybloq_status"]);
    expect(text).toBe([
      '[mcp_servers.storybloq.tools.storybloq_init]\napproval_mode = "approve"\n',
      '[mcp_servers.storybloq.tools.storybloq_status]\napproval_mode = "approve"\n',
      '[mcp_servers.storybloq.tools.storybloq_ticket_get]\napproval_mode = "approve"\n',
    ].join("\n"));
    expect(codexApprovalProblems(text, union)).toEqual([]);
  });

  it("a name missing from the config, or one added to it, fails", () => {
    expect(codexApprovalProblems(codexApprovalTables(union.slice(1)), union)).toEqual(["storybloq_status has no approval table"]);
    expect(codexApprovalProblems(codexApprovalTables([...union, "storybloq_bus_send"]), union)).toEqual(["[mcp_servers.storybloq.tools.storybloq_bus_send] approves a name outside the inventory"]);
  });

  it("an approval for another server, a twice-listed name, a weaker mode or a stray approval_mode is refused", () => {
    const ok = codexApprovalTables(union);
    expect(codexApprovalProblems(`${ok}\n[mcp_servers.other.tools.read]\napproval_mode = "approve"\n`, union)).toEqual(["[mcp_servers.other.tools.read] approves a tool of another server"]);
    expect(codexApprovalProblems(`${ok}\n[mcp_servers.storybloq.tools.storybloq_init]\napproval_mode = "approve"\n`, union)).toEqual(["[mcp_servers.storybloq.tools.storybloq_init] appears twice"]);
    expect(codexApprovalProblems(ok.replace('approval_mode = "approve"', 'approval_mode = "prompt"'), union)).toEqual(["storybloq_init is not approved"]);
    expect(codexApprovalProblems(`approval_mode = "approve"\n${ok}`, union)).toEqual(["approval_mode outside an approval table"]);
  });
});

describe("the pinned inventory file (5.4)", () => {
  const pinned = JSON.parse(readFileSync(TOOL_SETS_FILE, "utf-8")) as { degraded: string[]; full: string[]; withheld: Record<string, string> };
  it("names the degraded and full lists, and the thirteen withheld names with their reasons", () => {
    expect(Object.keys(pinned).sort()).toEqual(["degraded", "full", "withheld"]);
    expect(Object.keys(pinned.withheld).sort()).toEqual([
      "storybloq_bus_ack", "storybloq_bus_poll", "storybloq_bus_redeliver", "storybloq_bus_send", "storybloq_bus_thread_get", "storybloq_bus_thread_update", "storybloq_export",
      "storybloq_node_add", "storybloq_node_init", "storybloq_node_update", "storybloq_projection_write", "storybloq_register_subprocess", "storybloq_unregister_subprocess",
    ]);
    for (const n of [...pinned.degraded, ...pinned.full]) expect(Object.hasOwn(pinned.withheld, n), n).toBe(false);
    expect(pinned.full).toContain("storybloq_setup_verify");
    expect(claudeToolSets(null)).toEqual({ degraded: pinned.degraded, full: pinned.full });
  });

  it("with no --tool-sets and no pinned file, a run is refused before anything starts", () => {
    expect(() => claudeToolSets(null, join(scratch(), "none.json"))).toThrow("onboarding-eval: no pinned tool inventory (plan 5.4)");
  });
});

describe("the allow-list in the bundle (5.4)", () => {
  it("a name outside the list is never registered: an inert handle, logged once", () => {
    const registered: string[] = [];
    const proto = { registerTool(this: unknown, name: string) { registered.push(name); return { real: name }; } };
    const withheld: string[] = [];
    const restore = restrictTools(new Set(["storybloq_status"]), (n) => withheld.push(n), proto as never);
    const ok = (proto.registerTool as (n: string) => unknown)("storybloq_status");
    const h1 = (proto.registerTool as unknown as (n: string) => { remove(): void; enable(): void; disable(): void; update(x: unknown): void; enabled: boolean })("storybloq_bus_send");
    const h2 = (proto.registerTool as (n: string) => unknown)("storybloq_bus_send");
    expect(ok).toEqual({ real: "storybloq_status" });
    expect(registered).toEqual(["storybloq_status"]);
    expect(withheld).toEqual(["storybloq_bus_send"]);
    expect(h1).toBe(h2);
    expect(() => { h1.remove(); h1.enable(); h1.disable(); h1.update({}); }).not.toThrow();
    expect(h1.enabled).toBe(false);
    restore();
    (proto.registerTool as (n: string) => unknown)("storybloq_bus_send");
    expect(registered).toEqual(["storybloq_status", "storybloq_bus_send"]);
  });

  it("the allow-list is the union of the file's two lists and the file's sha256", () => {
    const d = scratch();
    const f = join(d, "t.json");
    writeFileSync(f, JSON.stringify({ degraded: ["a"], full: ["b", "a"], withheld: { c: "why" } }));
    const a = allowList(f);
    expect([...a.names].sort()).toEqual(["a", "b"]);
    expect(a.sha256).toBe(sha(readFileSync(f)));
    writeFileSync(f, JSON.stringify({ degraded: [], full: ["b"] }));
    expect(() => allowList(f)).toThrow(/is not the tool inventory/);
  });

  it("withheld lines are read by the events parser, as are the launch fields; malformed ones are refused", () => {
    const t = "d".repeat(64);
    const log = parseEventsLog([
      JSON.stringify({ attempt: "a", pid: 1, entry: "mcp", sandbox: "held", tools: t }),
      JSON.stringify({ seq: 0, attempt: "a", type: "tool-withheld", name: "storybloq_bus_send" }),
      JSON.stringify({ attempt: "b", pid: 2, entry: "cli" }),
    ].join("\n") + "\n");
    expect(log.attempts).toEqual([{ line: 0, attempt: "a", pid: 1, entry: "mcp", sandbox: "held", tools: t }, { line: 2, attempt: "b", pid: 2, entry: "cli" }]);
    expect(log.withheld).toEqual([{ line: 1, attempt: "a", name: "storybloq_bus_send" }]);
    expect(log.events).toEqual([]);
    expect(() => parseEventsLog(`${JSON.stringify({ attempt: "a", pid: 1, entry: "mcp", sandbox: "maybe" })}\n`)).toThrow(/is not an attempt line/);
    expect(() => parseEventsLog(`${JSON.stringify({ attempt: "a", pid: 1, entry: "mcp", tools: "short" })}\n`)).toThrow(/is not an attempt line/);
    expect(() => parseEventsLog(`${JSON.stringify({ attempt: "a", pid: 1, entry: "mcp" })}\n${JSON.stringify({ seq: 0, attempt: "a", type: "tool-withheld" })}\n`)).toThrow(/is not a withheld-tool record/);
  });
});

// --- 5.4 against the real bundle: the pin, advertised versus permitted -------------------------------------

interface Session { readonly client: Client; close(): Promise<void>; readonly notified: () => number }

async function session(cwd: string, env: Record<string, string>, launch?: { command: string; args: string[] }): Promise<Session> {
  const transport = new StdioClientTransport({ command: launch?.command ?? process.execPath, args: launch?.args ?? [EVAL_MCP, "--entry", "mcp"], cwd, env, stderr: "pipe" });
  const client = new Client({ name: "t538-2a", version: "1" }, { capabilities: {} });
  let changed = 0;
  client.fallbackNotificationHandler = async (n) => { if (n.method === "notifications/tools/list_changed") changed += 1; };
  await client.connect(transport);
  return { client, close: () => client.close(), notified: () => changed };
}

const names = async (c: Client): Promise<string[]> => (await c.listTools()).tools.map((t) => t.name).sort();

/** A probe folder this process cannot write (mode 0555): with no wrapper, the entry's probe reads it as held. */
function lockedOutside(d: string): string {
  const o = join(d, "locked-outside");
  mkdirSync(o, { recursive: true });
  chmodSync(o, 0o555);
  return o;
}

function serverEnv(d: string, extra: Record<string, string> = {}): Record<string, string> {
  for (const f of ["home", "g", "ev"]) mkdirSync(join(d, f), { recursive: true });
  return { PATH: "/usr/bin:/bin", HOME: join(d, "home"), TMPDIR: d, STORYBLOQ_GLOBAL_DIR: join(d, "g"), STORYBLOQ_EVAL_EVENTS: join(d, "ev", "events.jsonl"), ...extra };
}

describe("the pinned inventory against the real bundle (5.4)", () => {
  const pinned = JSON.parse(readFileSync(TOOL_SETS_FILE, "utf-8")) as { degraded: string[]; full: string[]; withheld: Record<string, string> };
  const sorted = (x: readonly string[]): string[] => [...x].sort();

  // Q4 ruling: the real bundle refuses entry mcp with either variable missing, before it writes a launch line.
  for (const missing of ["STORYBLOQ_EVAL_TOOLS", "STORYBLOQ_EVAL_OUTSIDE"] as const) {
    it(`with no ${missing}, the bundle's entry mcp refuses before it serves or writes a launch line`, () => {
      const d = scratch("t538-2a-req-");
      mkdirSync(join(d, "p"));
      const env = serverEnv(d, { STORYBLOQ_EVAL_TOOLS: TOOL_SETS_FILE, STORYBLOQ_EVAL_OUTSIDE: lockedOutside(d) });
      delete env[missing];
      const r = spawnSync(process.execPath, [EVAL_MCP, "--entry", "mcp"], { cwd: join(d, "p"), env, input: "", encoding: "utf-8", timeout: 60_000 });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`eval-fault-mcp: ${missing} is required for entry mcp`);
      expect(existsSync(env.STORYBLOQ_EVAL_EVENTS!)).toBe(false);
      expect(pinned.degraded).toHaveLength(6);
      expect(pinned.degraded).toContain("storybloq_setup_apply");
    }, 60_000);
  }

  it("restricted, tools/list is the degraded set, then the full set after storybloq_init with the list-changed notice; withheld names are logged once each", async () => {
    const d = scratch("t538-2a-res-");
    mkdirSync(join(d, "p"));
    const env = serverEnv(d, { STORYBLOQ_EVAL_TOOLS: TOOL_SETS_FILE, STORYBLOQ_EVAL_OUTSIDE: lockedOutside(d) });
    const s = await session(join(d, "p"), env);
    try {
      expect(await names(s.client)).toEqual(sorted(pinned.degraded));
      await s.client.callTool({ name: "storybloq_init", arguments: { name: "inv" } });
      expect(await names(s.client)).toEqual(sorted(pinned.full));
      expect(s.notified()).toBeGreaterThan(0);
    } finally { await s.close(); }
    const log = parseEventsLog(readFileSync(env.STORYBLOQ_EVAL_EVENTS!, "utf-8"));
    expect(log.attempts[0]).toMatchObject({ entry: "mcp", tools: sha(readFileSync(TOOL_SETS_FILE)) });
    expect(sorted((log.withheld ?? []).map((w) => w.name))).toEqual(sorted(Object.keys(pinned.withheld)));
  }, 60_000);

  it("a fresh server on a project that exists advertises the full set; a call to a withheld name is an error and changes no ledger byte", async () => {
    const d = scratch("t538-2a-call-");
    const p = join(d, "p");
    mkdirSync(p);
    const env = serverEnv(d, { STORYBLOQ_EVAL_TOOLS: TOOL_SETS_FILE, STORYBLOQ_EVAL_OUTSIDE: lockedOutside(d) });
    const a = await session(p, env);
    await a.client.callTool({ name: "storybloq_init", arguments: { name: "inv" } });
    await a.close();
    const digest = (): string => sha(spawnSync("/bin/sh", ["-c", "find .story -type f | sort | xargs cat"], { cwd: p, encoding: "utf-8" }).stdout);
    const before = digest();
    const b = await session(p, env);
    try {
      expect(await names(b.client)).toEqual(sorted(pinned.full));
      const r = await b.client.callTool({ name: "storybloq_export", arguments: { all: true } }).then((x) => ({ isError: x.isError === true, text: JSON.stringify(x.content) }), (e: unknown) => ({ isError: true, text: String(e) }));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/storybloq_export/);
    } finally { await b.close(); }
    expect(digest()).toBe(before);
  }, 60_000);

  it("given a probe folder it can write (no wrapper), the entry writes sandbox absent and refuses to serve", () => {
    const d = scratch("t538-2a-abs-");
    mkdirSync(join(d, "out"));
    mkdirSync(join(d, "p"));
    const env = serverEnv(d, { STORYBLOQ_EVAL_TOOLS: TOOL_SETS_FILE, STORYBLOQ_EVAL_OUTSIDE: join(d, "out") });
    const r = spawnSync(process.execPath, [EVAL_MCP, "--entry", "mcp"], { cwd: join(d, "p"), env, input: "", encoding: "utf-8", timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/can write outside every root; it does not serve/);
    expect(parseEventsLog(readFileSync(env.STORYBLOQ_EVAL_EVENTS!, "utf-8")).attempts).toEqual([expect.objectContaining({ entry: "mcp", sandbox: "absent" })]);
    expect(spawnSync("/bin/ls", ["-A", join(d, "out")], { encoding: "utf-8" }).stdout).toBe("");
  }, 60_000);
});

// Off by default: these rows need a codex executable on the machine and start the real macOS sandbox, which
// the plain suite neither assumes nor installs. A skip names its reason in the test title, so it is never a
// silent pass; asked for (STORYBLOQ_REAL_CODEX=1) with no executable, the first row fails instead.
const REAL_SKIP = REAL ? "" : " [skipped: set STORYBLOQ_REAL_CODEX=1 and STORYBLOQ_REAL_CODEX_BIN=<codex executable> to run]";

describe("the real codex wrapper is asked for", () => {
  it.skipIf(!REAL)(`STORYBLOQ_REAL_CODEX=1 needs STORYBLOQ_REAL_CODEX_BIN to name the codex executable${REAL_SKIP}`, () => {
    expect(existsSync(CODEX), `STORYBLOQ_REAL_CODEX_BIN=${CODEX}`).toBe(true);
  });
});

describe("the real bundle under the real wrapper (5.2)", () => {
  it.skipIf(!REAL || !existsSync(CODEX))(`F5: a write into the review store fails under the server wrapper's settings and under the Codex client's own sandbox arguments, while a root stays writable${REAL_SKIP}`, () => {
    // The runner's layout: the attempt folder under the per-user temp folder, the store beside the roots, never in them.
    mkdirSync(attemptBase(), { recursive: true });
    const work = realpathSync(mkdtempSync(join(attemptBase(), "f5-")));
    try {
      const p = join(work, "project");
      const store = join(work, "storybloq-setup-review-store");
      for (const f of [p, store, join(work, "tmp"), join(work, "storybloq-global"), join(work, "eval-events"), join(work, "runner")]) mkdirSync(f, { recursive: true });
      spawnSync("git", ["init", "-q"], { cwd: p });
      const roots = [p, join(p, ".git"), join(work, "tmp"), join(work, "storybloq-global"), join(work, "eval-events")];
      const launch = serverLaunch(realpathSync(CODEX), process.execPath, EVAL_MCP, roots, writeServerLauncher(work), ["PATH"]);
      const wrapper = launch.args.slice(launch.args.indexOf("sandbox") + 1, launch.args.lastIndexOf("--"));
      const client = codexSandboxArgs(roots);
      // The client's arguments exclude both temp defaults, so the attempt folder under the temp folder is not writable by default.
      expect(client).toEqual(expect.arrayContaining(["sandbox_workspace_write.exclude_slash_tmp=true", "sandbox_workspace_write.exclude_tmpdir_env_var=true"]));
      const env = { PATH: "/usr/bin:/bin", HOME: work, CODEX_HOME: join(work, "runner"), TMPDIR: join(work, "tmp") };
      for (const [name, settings] of [["wrapper", wrapper], ["client", client]] as const) {
        const r = spawnSync(realpathSync(CODEX), ["sandbox", ...settings, "--", "/bin/sh", "-c", `printf x > '${join(p, name)}'; printf x > '${join(store, name)}' 2>/dev/null; echo store=$?`], { cwd: p, env, encoding: "utf-8" });
        expect(r.status, `${name}: ${r.stderr}`).toBe(0);
        expect(existsSync(join(p, name)), `${name}: the root write`).toBe(true);
        expect(r.stdout, name).toMatch(/store=[1-9]/);
        expect(existsSync(join(store, name)), `${name}: the store write`).toBe(false);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!REAL || !existsSync(CODEX))(`answers tools/list with the degraded set, its launch line held, and nothing written outside${REAL_SKIP}`, async () => {
    const d = scratch("t538-2a-real-");
    const p = join(d, "p");
    for (const f of ["p", "out", "runner", "tmp"]) mkdirSync(join(d, f));
    spawnSync("git", ["init", "-q"], { cwd: p });
    const env = serverEnv(d, { TMPDIR: join(d, "tmp"), CODEX_HOME: join(d, "runner"), STORYBLOQ_EVAL_TOOLS: TOOL_SETS_FILE, STORYBLOQ_EVAL_OUTSIDE: join(d, "out") });
    const launch = serverLaunch(realpathSync(CODEX), process.execPath, EVAL_MCP, [p, join(p, ".git"), join(d, "tmp"), join(d, "g"), join(d, "ev")], writeServerLauncher(d), Object.keys(env));
    const s = await session(p, env, { command: launch.command, args: [...launch.args] });
    try {
      expect(await names(s.client)).toEqual([...JSON.parse(readFileSync(TOOL_SETS_FILE, "utf-8")).degraded].sort());
    } finally { await s.close(); }
    expect(parseEventsLog(readFileSync(env.STORYBLOQ_EVAL_EVENTS!, "utf-8")).attempts).toEqual([expect.objectContaining({ entry: "mcp", sandbox: "held" })]);
    expect(spawnSync("/bin/ls", ["-A", join(d, "out")], { encoding: "utf-8" }).stdout).toBe("");
  }, 90_000);
});

