/**
 * T-538 S5b, plan line 806: no host bypass at any commit. A sentinel client on
 * PATH, the runner's real entry, every variant and argv form. The sentinel
 * records every argv it is started with; the flag never reaches it on the host.
 * These assertions stay unchanged through the commit that adds the container route.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAUDE_BYPASS, claudeTurnArgs, type ClaudeExpected } from "../../scripts/headless-policy.js";
import { turnInfraFailure, type TurnFailureFacts } from "../../scripts/onboarding-eval-run.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(PKG, "node_modules", "tsx", "dist", "cli.mjs");
const RUNNER = join(PKG, "scripts", "onboarding-eval-run.ts");
const BYPASS = ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto"] as const;

const SENTINEL = `
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.SENTINEL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const lines = [{ type: "thread.started", thread_id: "th-sentinel" }, { type: "item.completed", item: { type: "agent_message", text: process.env.SENTINEL_TEXT } }, { type: "turn.completed", usage: {} }];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
`;

/** A setup package, so the runner goes on past the opening to its resumed turns. */
const PACKAGE = "Here is the package.\nPlan, revision 0123456789ab:\nTicket: Sign in\nEnd of plan, revision 0123456789ab\n- Approve setup\n- Adjust the plan\n- Inspect details";

interface Run { readonly status: number | null; readonly output: string; readonly argvs: readonly string[][] }

function runHost(extra: readonly string[]): Run {
  // A short name: tsx's IPC pipe lives under TMPDIR and a long one truncates that socket path.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538h-")));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), `#!${process.execPath}\n${SENTINEL}`, { mode: 0o755 });
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}\n");
    const home = join(dir, "home");
    mkdirSync(home);
    const log = join(dir, "sentinel.log");
    const env: NodeJS.ProcessEnv = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: home, TMPDIR: dir, CODEX_HOME: codexHome, SENTINEL_LOG: log, SENTINEL_TEXT: PACKAGE };
    const r = spawnSync(process.execPath, [TSX, RUNNER, "--client", "codex", "--out", join(dir, "out"), "--raw-out", join(dir, "raw"), ...extra], { cwd: PKG, env, encoding: "utf-8", timeout: 280_000 });
    const argvs = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
    return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, argvs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The options of an argv: what follows the terminator is the prompt, which may quote anything. */
const optionsOf = (argv: readonly string[]): readonly string[] => { const end = argv.indexOf("--"); return end === -1 ? argv : argv.slice(0, end); };
const carrying = (r: Run): string[][] => r.argvs.filter((a) => optionsOf(a).some((x) => (BYPASS as readonly string[]).includes(x)));
const turns = (r: Run): string[][] => r.argvs.filter((a) => a[0] === "exec");

describe("no host run hands the client its bypass flag", () => {
  it.each([
    ["none", "empty-idea", []],
    ["reviewer-unavailable", "empty-idea", []],
    ["approval-boundary", "brief-only", []],
    ["interrupted", "empty-idea", ["--fault", "step:handover"]],
    ["interrupted-edited", "empty-idea", ["--fault", "step:handover"]],
    ["milestone-demo", "checkpoint-demo", []],
    ["empty-idea-verify", "empty-idea", []],
    ["restart", "empty-idea", []],
  ] as const)("variant %s", (variant, fixture, more) => {
    const r = runHost(["--fixture", fixture, "--variant", variant, ...more]);
    expect(turns(r).length, r.output).toBeGreaterThan(0);
    expect(carrying(r)).toEqual([]);
  }, 300_000);

  it("the first turn and a resumed turn are both seen, and neither carries it", () => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "none"]);
    expect(turns(r).some((a) => a[1] !== "resume"), r.output).toBe(true);
    expect(turns(r).some((a) => a[1] === "resume"), r.output).toBe(true);
    expect(carrying(r)).toEqual([]);
  }, 300_000);

  it.each(BYPASS)("%s on the runner's own command line does not reach the client", (flag) => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "none", flag]);
    expect(carrying(r)).toEqual([]);
  }, 300_000);

  it.each([...BYPASS, "--sandbox=danger-full-access"])("%s smuggled in as the model is refused before any turn starts", (flag) => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "none", "--model", flag]);
    expect(turns(r)).toEqual([]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toMatch(/the turn's sandbox does not hold/);
  }, 300_000);

  it("the degraded variant stays refused for this client, so it starts nothing", () => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "degraded"]);
    expect(r.status).not.toBe(0);
    expect(r.argvs).toEqual([]);
  }, 300_000);
});

describe("what every host turn carries instead", () => {
  it("the same write policy on the first and the resumed form, naming the attempt's own folders", () => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "none"]);
    expect(turns(r).length, r.output).toBeGreaterThan(1);
    const first = turns(r).find((a) => a[1] !== "resume")!;
    const project = first[first.indexOf("-C") + 1]!;
    const work = dirname(project);
    const expected = [join(work, "home"), join(work, "tmp"), join(work, "storybloq-global"), join(work, "storybloq-setup-review-store"), join(work, "eval-events"), join(project, ".git")];
    for (const a of turns(r)) {
      const configs = a.flatMap((x, i) => (x === "-c" ? [a[i + 1]!] : []));
      expect(configs).toEqual([
        'sandbox_mode="workspace-write"',
        'approval_policy="never"',
        `sandbox_workspace_write.writable_roots=${JSON.stringify(expected)}`,
        "sandbox_workspace_write.exclude_slash_tmp=true",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        'web_search="disabled"',
        "features.multi_agent=false",
      ]);
    }
  }, 300_000);
});

// --- T-538 commit 1 (ISS-1463): the Claude route, against a stand-in that speaks the control protocol ------

const CLAUDE_SENTINEL = join(PKG, "test", "fixtures", "t538-claude-sentinel.cjs");
const DEGRADED = ["storybloq_status", "storybloq_init", "storybloq_session_guard"];
const FULL = ["storybloq_status", "storybloq_ticket_get", "storybloq_session_guard"];
const MARK = "toolsets-mark-5e0b2c";

interface ClaudeRun {
  readonly status: number | null;
  readonly output: string;
  readonly log: readonly Record<string, unknown>[];
  readonly record: Record<string, unknown> | null;
  readonly recordDir: string | null;
  readonly rawDir: string | null;
  readonly dir: string;
}

interface ClaudeOpts {
  readonly fixture?: string;
  readonly variant?: string;
  readonly extra?: readonly string[];
  readonly mutate?: Record<string, unknown>;
  readonly tamper?: string;
  readonly sets?: { degraded: string[]; full: string[] } | null;
  readonly answerSets?: { degraded: string[]; full: string[] };
  readonly split?: string;
  readonly early?: boolean;
  readonly noInit?: boolean;
}

/** Runs the runner's real entry for --client claude with the stand-in on PATH; `then` reads the results before cleanup. */
async function withClaude<T>(opts: ClaudeOpts, then: (r: ClaudeRun) => T): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538c-")));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const sets = opts.sets === undefined ? { degraded: DEGRADED, full: FULL } : opts.sets;
    const config = { log: join(dir, "sentinel.log"), sets: opts.answerSets ?? sets ?? { degraded: DEGRADED, full: FULL }, text: PACKAGE, mark: MARK, mutate: opts.mutate ?? null, tamper: opts.tamper ?? null, split: opts.split ?? null, early: opts.early ?? false, noInit: opts.noInit ?? false };
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nrequire(${JSON.stringify(CLAUDE_SENTINEL)}).main(${JSON.stringify(config)});\n`, { mode: 0o755 });
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}\n");
    const home = join(dir, "home");
    mkdirSync(home);
    const setsFile = join(dir, `sets-${MARK}.json`);
    if (sets !== null) writeFileSync(setsFile, JSON.stringify(sets));
    const env: NodeJS.ProcessEnv = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: home, TMPDIR: dir, CODEX_HOME: codexHome, CLAUDE_CODE_OAUTH_TOKEN: "placeholder-not-a-token" };
    const args = [TSX, RUNNER, "--client", "claude", "--fixture", opts.fixture ?? "empty-idea", "--variant", opts.variant ?? "none", "--out", join(dir, "out"), "--raw-out", join(dir, "raw"),
      ...(sets !== null ? ["--tool-sets", setsFile] : []), ...(opts.extra ?? [])];
    // Asynchronous, so the test worker keeps answering vitest while the runner works.
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, args, { cwd: PKG, env, stdio: ["ignore", "pipe", "pipe"], timeout: 280_000 });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
    const log = existsSync(config.log) ? readFileSync(config.log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    const runs = existsSync(join(dir, "out")) ? readdirSync(join(dir, "out")) : [];
    const recordDir = runs.length === 1 ? join(dir, "out", runs[0]!) : null;
    const record = recordDir !== null && existsSync(join(recordDir, "record.json")) ? JSON.parse(readFileSync(join(recordDir, "record.json"), "utf-8")) as Record<string, unknown> : null;
    const rawDir = runs.length === 1 ? join(dir, "raw", runs[0]!) : null;
    return then({ status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, log, record, recordDir, rawDir, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const argvsOf = (r: ClaudeRun): string[][] => r.log.filter((e) => e.kind === "argv").map((e) => e.argv as string[]);
const usersOf = (r: ClaudeRun): Record<string, unknown>[] => r.log.filter((e) => e.kind === "user");
const turnsOf = (r: ClaudeRun): { infraFailure: string | null }[] => (r.record?.turns ?? []) as { infraFailure: string | null }[];

describe("T-538 commit 1: no Claude turn carries a bypass", () => {
  it.each([
    ["none", "empty-idea", []],
    ["reviewer-unavailable", "empty-idea", []],
    ["approval-boundary", "brief-only", []],
    ["degraded", "empty-idea", []],
    ["interrupted", "empty-idea", ["--fault", "step:handover"]],
    ["milestone-demo", "checkpoint-demo", []],
    ["restart", "empty-idea", []],
  ] as const)("variant %s: every argv is free of every bypass spelling and of --disallowedTools", async (variant, fixture, extra) => {
    await withClaude({ variant, fixture, extra }, (r) => {
      expect(argvsOf(r).length, r.output).toBeGreaterThan(0);
      for (const a of argvsOf(r)) {
        expect(a.filter((x) => (CLAUDE_BYPASS as readonly string[]).includes(x) || x === "--disallowedTools")).toEqual([]);
        expect(a.some((x) => x.startsWith("--dangerously"))).toBe(false);
      }
    });
  }, 300_000);

  it("the first turn and each resumed turn carry exactly the 4.2 argv, and the prompt only on stdin", async () => {
    await withClaude({}, (r) => {
      const argvs = argvsOf(r);
      expect(argvs.length, r.output).toBeGreaterThan(1);
      const work = dirname((r.record as { claudeLaunch: { project: string } }).claudeLaunch.project);
      const e = { model: "claude-opus-5-5", policyFile: join(work, "claude-policy.json"), mcpFile: join(work, "mcp.json"), maxBudgetUsd: 15 } as ClaudeExpected;
      const id = argvs[0]![argvs[0]!.indexOf("--session-id") + 1]!;
      expect(argvs[0]).toEqual(claudeTurnArgs(e, { kind: "first", id }));
      for (const a of argvs.slice(1)) expect(a).toEqual(claudeTurnArgs(e, { kind: "resume", id }));
      // Every turn's prompt arrived as the user message, after all six answers.
      expect(usersOf(r).length).toBe(argvs.length);
      for (const u of usersOf(r)) expect(u.answered).toBe(6);
      expect(String(usersOf(r)[0]!.content)).toMatch(/^\/story/);
    });
  }, 300_000);

  it.each(CLAUDE_BYPASS)("%s on the runner's own command line does not reach the client", async (flag) => {
    await withClaude({ extra: [flag] }, (r) => {
      expect(argvsOf(r).length, r.output).toBeGreaterThan(0);
      for (const a of argvsOf(r)) expect(a).not.toContain(flag);
    });
  }, 300_000);

  it.each([...CLAUDE_BYPASS, "--permission-mode=bypassPermissions"])("%s smuggled in as the model is refused before any turn starts", async (flag) => {
    await withClaude({ extra: ["--model", flag] }, (r) => {
      expect(argvsOf(r)).toEqual([]);
      expect(r.status, r.output).not.toBe(0);
      expect(r.output).toMatch(/the turn's sandbox does not hold/);
    });
  }, 300_000);
});

describe("T-538 commit 1: the tool inventory is the runner's alone", () => {
  it("with no --tool-sets and no pinned file, a Claude run is refused before anything starts", async () => {
    await withClaude({ sets: null, answerSets: { degraded: DEGRADED, full: FULL } }, (r) => {
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/onboarding-eval: no pinned tool inventory \(plan 5\.4\)/);
      expect(r.log).toEqual([]);
    });
  }, 300_000);

  it("the --tool-sets value reaches neither the client's argv nor its environment", async () => {
    await withClaude({}, (r) => {
      const entries = r.log.filter((e) => e.kind === "argv");
      expect(entries.length, r.output).toBeGreaterThan(0);
      for (const e of entries) { expect(e.markInArgv).toBe(false); expect(e.markInEnv).toBe(false); }
    });
  }, 300_000);

  it.each([["degraded", "empty-idea", DEGRADED], ["full", "empty-scaffold", FULL]] as const)("the %s state (%s) expects its own set; the other set, an extra tool and a missing tool each fail the launch", async (_s, fixture, set) => {
    await withClaude({ fixture }, (r) => {
      expect(turnsOf(r)[0]?.infraFailure, r.output).toBeNull();
      expect(Object.values((r.record as { claudeLaunch: { toolSets: Record<string, string[]> } }).claudeLaunch.toolSets)[0]).toEqual(set);
    });
    const answering = (wrong: string[]) => (fixture === "empty-idea" ? { degraded: wrong, full: FULL } : { degraded: DEGRADED, full: wrong });
    for (const wrong of [fixture === "empty-idea" ? FULL : DEGRADED, [...set, "storybloq_bus_send"], set.slice(1)]) {
      await withClaude({ fixture, answerSets: answering(wrong) }, (r) => {
        expect(turnsOf(r)[0]?.infraFailure, `${JSON.stringify(wrong)}\n${r.output}`).toBe("launch: mcp_status.mcpServers.tools");
        expect(usersOf(r)).toEqual([]);
      });
    }
  }, 300_000);
});

/** One changed answer each; the turn is the launch failure naming the field, and no user message is sent. */
const LAUNCH_ROWS: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["a third settings source", { sub: "get_settings", how: "set", path: "sources", value: { append: { source: "localSettings", settings: {} } } }, "get_settings.sources"],
  ["a policySettings source", { sub: "get_settings", how: "set", path: "sources", value: { append: { source: "policySettings", settings: {} } } }, "get_settings.sources"],
  ["the flag source with a hook", { sub: "get_settings", how: "set", path: "sources", value: { flagHooks: { Stop: [] } } }, "get_settings.sources"],
  ["sandbox disabled", { sub: "get_sandbox_dialog", how: "set", path: "enabled", value: false }, "get_sandbox_dialog.enabled"],
  ["sandbox not enabled in settings", { sub: "get_sandbox_dialog", how: "set", path: "enabled_in_settings", value: false }, "get_sandbox_dialog.enabled_in_settings"],
  ["sandbox not locked", { sub: "get_sandbox_dialog", how: "set", path: "locked", value: false }, "get_sandbox_dialog.locked"],
  ["sandbox overrides not locked", { sub: "get_sandbox_dialog", how: "set", path: "overrides_locked", value: false }, "get_sandbox_dialog.overrides_locked"],
  ["the unsandboxed fallback on", { sub: "get_sandbox_dialog", how: "set", path: "unsandboxed_fallback", value: true }, "get_sandbox_dialog.unsandboxed_fallback"],
  ["an excluded command", { sub: "get_sandbox_dialog", how: "set", path: "excluded_commands", value: ["git"] }, "get_sandbox_dialog.excluded_commands"],
  ["an extra writable path", { sub: "get_sandbox_dialog", how: "set", path: "restrictions.fs_allow_write", value: { append: "/" } }, "get_sandbox_dialog.restrictions"],
  ["a missing writable root", { sub: "get_sandbox_dialog", how: "set", path: "restrictions.fs_allow_write", value: { dropFirst: true } }, "get_sandbox_dialog.restrictions"],
  ["an allowed domain", { sub: "get_sandbox_dialog", how: "set", path: "restrictions.network_allowed_domains", value: ["example.com"] }, "get_sandbox_dialog.restrictions"],
  ["an extra allow rule", { sub: "list_permission_rules", how: "set", path: "state.rules", value: { append: { behavior: "allow", source: "flagSettings", rule: "WebFetch" } } }, "list_permission_rules.state.rules"],
  ["a workspace directory", { sub: "list_permission_rules", how: "set", path: "state.workspaceDirectories", value: ["/"] }, "list_permission_rules.state.workspaceDirectories"],
  ["another original cwd", { sub: "list_permission_rules", how: "set", path: "state.originalCwd", value: "/" }, "list_permission_rules.state.originalCwd"],
  ["a second MCP server", { sub: "mcp_status", how: "set", path: "mcpServers", value: { append: { name: "other", status: "connected", tools: [] } } }, "mcp_status.mcpServers"],
  ["the server launched another way", { sub: "mcp_status", how: "set", path: "mcpServers", value: { configArgs: ["/elsewhere/mcp.js"] } }, "mcp_status.mcpServers.config"],
  ["a hook", { sub: "get_hooks_listing", how: "set", path: "hooks", value: [{ event: "PreToolUse" }] }, "get_hooks_listing.hooks"],
  ["a policy hook", { sub: "get_hooks_listing", how: "set", path: "policy.policyHookCount", value: 1 }, "get_hooks_listing.policy.policyHookCount"],
  ["an API key token source", { sub: "initialize", how: "set", path: "account.tokenSource", value: "apiKeyHelper" }, "initialize.account.tokenSource"],
  ["another provider", { sub: "initialize", how: "set", path: "account.apiProvider", value: "bedrock" }, "initialize.account.apiProvider"],
  ["another permission mode", { sub: "initialize", how: "set", path: "current_permission_mode", value: "bypassPermissions" }, "initialize.current_permission_mode"],
  ["an error answer", { sub: "get_sandbox_dialog", how: "error" }, "get_sandbox_dialog: error response"],
  ["no answer", { sub: "mcp_status", how: "drop" }, "mcp_status: no response within 30000 ms"],
  ["a late answer", { sub: "get_settings", how: "late", ms: 3000 }, "get_settings: no response within 30000 ms"],
];

describe("T-538 commit 1: the readback holds before the prompt is written", () => {
  it.each(LAUNCH_ROWS)("%s: the launch fails on that field and no user message arrives", async (_name, mutate, field) => {
    await withClaude({ mutate, extra: ["--readback-timeout-ms", "500"] }, (r) => {
      expect(turnsOf(r).length, r.output).toBe(1);
      expect(turnsOf(r)[0]!.infraFailure).toBe(`launch: ${field}`);
      expect(usersOf(r)).toEqual([]);
      expect(argvsOf(r).length).toBe(1);
    });
  }, 300_000);

  it.each([
    ["the init event's permission mode", { sub: "init", how: "set", path: "permissionMode", value: "bypassPermissions" }, "init.permissionMode"],
    ["the init event's key source", { sub: "init", how: "set", path: "apiKeySource", value: "ANTHROPIC_API_KEY" }, "init.apiKeySource"],
    ["another server's tool in the init event", { sub: "init", how: "set", path: "tools", value: { append: "mcp__other__run" } }, "init.tools.mcp"],
  ] as const)("%s fails the turn after the fact", async (_n, mutate, field) => {
    await withClaude({ mutate }, (r) => {
      expect(turnsOf(r)[0]?.infraFailure, r.output).toBe(`launch: ${field}`);
    });
  }, 300_000);
});

describe("T-538 commit 1: the launch files are checked before every turn", () => {
  it.each(["edit", "chmod", "link"])("a policy file %s after the first turn refuses the second before it starts", async (tamper) => {
    await withClaude({ tamper }, (r) => {
      expect(argvsOf(r).length, r.output).toBe(1);
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/the turn's sandbox does not hold: .*claude-policy\.json/);
    });
  }, 300_000);

  it("a byte-identical replacement with the same mode and owner is accepted (the stated contract)", async () => {
    await withClaude({ tamper: "same" }, (r) => {
      expect(argvsOf(r).length, r.output).toBeGreaterThan(1);
    });
  }, 300_000);
});

describe("T-538 commit 1: the runner records each readback for the regrade (plan 6.4)", () => {
  it("a Claude record is route host-v2, and every turn's readback is a pinned replay input with its tool set", async () => {
    await withClaude({}, (r) => {
      expect(r.record?.route, r.output).toBe("host-v2");
      const names = readdirSync(r.rawDir!).filter((n) => n.endsWith(".readback.json")).sort();
      expect(names.length).toBe(turnsOf(r).length);
      const pinned = (r.record as { replayInputs: { path: string; sha256: string }[] }).replayInputs;
      for (const n of names) {
        const entry = pinned.find((e) => e.path === n);
        expect(entry?.sha256, n).toBe(createHash("sha256").update(readFileSync(join(r.rawDir!, n))).digest("hex"));
        const rb = JSON.parse(readFileSync(join(r.rawDir!, n), "utf-8")) as { steps: { requestId: string; outcome: string }[]; permissionDenials: unknown };
        expect(rb.steps.map((x) => `${x.requestId}:${x.outcome}`)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"].map((x) => `${x}:success`));
        expect(rb.permissionDenials).toEqual([]);
      }
      expect(Object.keys((r.record as { claudeLaunch: { toolSets: Record<string, unknown> } }).claudeLaunch.toolSets).sort()).toEqual(names);
    });
  }, 300_000);

  it("a launch failure's readback is recorded too, stopping at the failed request", async () => {
    await withClaude({ mutate: { sub: "get_sandbox_dialog", how: "error" } }, (r) => {
      const names = readdirSync(r.rawDir!).filter((n) => n.endsWith(".readback.json"));
      expect(names.length, r.output).toBe(1);
      const rb = JSON.parse(readFileSync(join(r.rawDir!, names[0]!), "utf-8")) as { steps: { outcome: string }[]; permissionDenials: unknown };
      expect(rb.steps.map((x) => x.outcome)).toEqual(["success", "success", "error"]);
      expect(rb.permissionDenials).toBeNull();
    });
  }, 300_000);
});

describe("T-538 commit 1 round 1: the runner's own reading of a turn", () => {
  it.each(["\u00e9", "\u20ac", "\u{1F600}"])("a character %s split across two writes on stdout and on stderr is kept exactly (F4)", async (ch) => {
    await withClaude({ split: ch }, (r) => {
      expect(turnsOf(r)[0]?.infraFailure, r.output).toBeNull();
      const first = readdirSync(r.rawDir!).filter((n) => n.endsWith(".jsonl") && existsSync(join(r.rawDir!, n.replace(/\.jsonl$/, ".stderr.txt")))).sort()[0]!;
      const raw = readFileSync(join(r.rawDir!, first), "utf-8");
      const stderr = readFileSync(join(r.rawDir!, first.replace(/\.jsonl$/, ".stderr.txt")), "utf-8");
      expect(raw).toContain(`"id":"msg-sentinel${ch}"`);
      expect(stderr).toContain(`sentinel stderr ${ch} end`);
      expect(`${raw}${stderr}`).not.toContain("\ufffd");
    });
  }, 300_000);

  it("a prompt the input refuses because the result already ended it is an input failure, never a clean turn (F5)", async () => {
    await withClaude({ early: true }, (r) => {
      expect(turnsOf(r).length, r.output).toBe(1);
      expect(turnsOf(r)[0]!.infraFailure).toBe("input: write after endInput");
      expect(usersOf(r)).toEqual([]);
    });
  }, 300_000);

  it("an input failure with exit 0 and no init event is recorded as the input failure, never as the init check (G1)", async () => {
    await withClaude({ early: true, noInit: true }, (r) => {
      expect(turnsOf(r).length, r.output).toBe(1);
      expect(turnsOf(r)[0]!.infraFailure).toBe("input: write after endInput");
    });
  }, 300_000);

  const CLEAN: TurnFailureFacts = {
    spawnError: null, launch: null, inputError: null, timedOut: false, timeoutMs: 900_000, signal: null, exitCode: 0,
    terminal: { status: "completed", detail: "" }, cleanup: "confirmed", cleanupDetail: null,
  };
  const UNCONFIRMED = { cleanup: "unconfirmed", cleanupDetail: "process group 4242 still present 2000 ms after the last signal" } as const;
  it("a clean turn has no failure, and exit 0 with a completed result but an unconfirmed cleanup is a cleanup failure (F5)", () => {
    expect(turnInfraFailure(CLEAN)).toBeNull();
    expect(turnInfraFailure({ ...CLEAN, ...UNCONFIRMED })).toBe("cleanup: unconfirmed: process group 4242 still present 2000 ms after the last signal");
    expect(turnInfraFailure({ ...CLEAN, cleanup: "unconfirmed" })).toBe("cleanup: unconfirmed");
  });
  it.each([
    ["spawn failed", { spawnError: "ENOENT" }, "spawn failed: ENOENT"],
    ["launch", { launch: "init.permissionMode" }, "launch: init.permissionMode"],
    ["input", { inputError: "EPIPE" }, "input: EPIPE"],
    ["timed out", { timedOut: true, signal: "SIGTERM", exitCode: null }, "timed out after 900000 ms"],
    ["killed", { signal: "SIGKILL", exitCode: null }, "killed by SIGKILL"],
    ["exit", { exitCode: 3 }, "exit 3"],
    ["terminal", { terminal: { status: "missing", detail: "no result event" } }, "terminal missing: no result event"],
  ] as const)("the order holds: %s outranks everything after it (F5)", (_n, facts, want) => {
    const later: Partial<TurnFailureFacts>[] = [
      { inputError: "write after exit" }, { timedOut: true }, { signal: "SIGTERM" }, { exitCode: 1 }, { terminal: { status: "failed", detail: "x" } }, UNCONFIRMED,
    ];
    const at = ["spawn failed", "launch", "input", "timed out", "killed", "exit", "terminal"].indexOf(_n);
    const below = Object.assign({}, ...later.slice(Math.max(0, at - 1)));
    expect(turnInfraFailure({ ...CLEAN, ...below, ...facts })).toBe(want);
  });
});
