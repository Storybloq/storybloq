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
import { claudeToolSets, TOOL_SETS_FILE, turnInfraFailure, type TurnFailureFacts } from "../../scripts/onboarding-eval-run.js";
import { envFor, NO_SANDBOXED_SERVER, processOutcome } from "../../scripts/onboarding-eval-host.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(PKG, "node_modules", "tsx", "dist", "cli.mjs");
const RUNNER = join(PKG, "scripts", "onboarding-eval-run.ts");
const BYPASS = ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto"] as const;

const SERVER_START = join(PKG, "test", "fixtures", "t538-server-start.cjs");

/**
 * The stand-in `codex`: as the client it records its argv, starts the tool server its config.toml names with
 * the environment the turn delivered (T-538 5.2, 5.3) and answers; as `codex sandbox` it is the wrapper's
 * stand-in; `--version` answers. Its settings are written into it, since the client environment is the table's.
 */
interface SentinelCfg {
  log: string; text: string; server?: boolean;
  /** T-538 2a: leave a detached process holding the project folder open, its pid appended to this file. */
  leave?: string;
  /** T-538 2a: write this many bytes of stdout. */
  flood?: number;
  /** T-538 2a: on a resumed turn, ignore SIGTERM and never finish. */
  hangResume?: boolean;
  /**
   * P1: on the first turn, after the sandboxed server, also start the server command outside the wrapper:
   * "keyless" with no outside probe and no inventory, "absent" with the probe pointed at a folder it can write.
   * "keyless-line": no server at all; the stand-in itself appends a keyless mcp attempt line to the events log,
   * a launch line from something that is not the real entry.
   */
  rogue?: "keyless" | "absent" | "keyless-line";
  /** Where the stand-in writes the rogue launch's stderr, so a row can see that it ran. */
  rogueOut?: string;
  /** 2b: on the first turn, run `storybloq setup-review <argv>` through the bundle CLI on PATH, each result one line in reviewOut. */
  review?: { readonly argv: readonly string[]; readonly stdin?: string }[];
  reviewOut?: string;
  /** F2: as the wrapper of a tool server launch, append the names (never the values) of its own environment here. */
  envNames?: string;
  /** F2: start the server with the client's whole environment under the delivered keys, as the worst client would. */
  inheritAll?: boolean;
}
const sentinel = (cfg: SentinelCfg): string => `
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const S = require(${JSON.stringify(SERVER_START)});
const CFG = ${JSON.stringify(cfg)};
const a = process.argv.slice(2);
if (a[0] === "--version") { process.stdout.write("codex-cli 0.0.0-stand-in\\n"); process.exit(0); }
if (a[0] === "sandbox") {
  if (CFG.envNames && a[a.length - 1] === "mcp") {
    // F5: whether the review store the server is told about lies under a root the wrapper makes writable (a boolean, never the path).
    const set = a.find((x) => x.startsWith("sandbox_workspace_write.writable_roots="));
    const roots = set ? JSON.parse(set.slice(set.indexOf("=") + 1)) : [];
    const store = process.env.STORYBLOQ_SETUP_REVIEW_DIR || "";
    const storeUnderRoot = roots.some((r) => store === r || store.startsWith(r + "/"));
    appendFileSync(CFG.envNames, JSON.stringify({ names: Object.keys(process.env).sort(), storeUnderRoot }) + "\\n");
  }
  S.sandboxStandIn(a);
}
else (async () => {
  appendFileSync(CFG.log, JSON.stringify(a) + "\\n");
  const launch = S.codexLaunchFromConfig(join(process.env.CODEX_HOME, "config.toml"));
  const delivered = CFG.inheritAll ? { ...process.env, ...S.codexServerEnv(a) } : { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...S.codexServerEnv(a) };
  if (launch !== null && CFG.server !== false) await S.startServer(launch, delivered, process.cwd());
  if (launch !== null && CFG.rogue && a[1] !== "resume") {
    const cmd = launch.args.slice(launch.args.lastIndexOf("--") + 1);
    const env = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ...S.codexServerEnv(a) };
    if (CFG.rogue === "keyless-line") appendFileSync(env.STORYBLOQ_EVAL_EVENTS, JSON.stringify({ attempt: "rogue-keyless-1", pid: process.pid, entry: "mcp" }) + "\\n");
    else {
      if (CFG.rogue === "keyless") { delete env.STORYBLOQ_EVAL_OUTSIDE; delete env.STORYBLOQ_EVAL_TOOLS; }
      else env.STORYBLOQ_EVAL_OUTSIDE = require("node:fs").mkdtempSync(join(process.env.TMPDIR, "open-"));
      const res = await S.startServer({ command: cmd[0], args: cmd.slice(1) }, env, process.cwd());
      if (CFG.rogueOut) appendFileSync(CFG.rogueOut, res.stderr);
    }
  }
  if (CFG.review && a[1] !== "resume") {
    for (const r of CFG.review) {
      const x = require("node:child_process").spawnSync("storybloq", ["setup-review", ...r.argv], { cwd: process.cwd(), env: process.env, input: r.stdin ?? "", timeout: 120000 });
      appendFileSync(CFG.reviewOut, JSON.stringify({ argv: r.argv, status: x.status, stdout: (x.stdout || Buffer.alloc(0)).toString("base64"), stderr: (x.stderr || Buffer.alloc(0)).toString("base64") }) + "\\n");
    }
  }
  if (CFG.hangResume && a[1] === "resume") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); return; }
  if (CFG.leave) {
    const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
    c.unref();
    appendFileSync(CFG.leave, c.pid + "\\n");
  }
  if (CFG.flood) { const chunk = Buffer.alloc(1 << 20, 120); for (let i = 0; i < CFG.flood / chunk.length; i++) if (!process.stdout.write(chunk)) await new Promise((r) => process.stdout.once("drain", r)); }
  const lines = [{ type: "thread.started", thread_id: "th-sentinel" }, { type: "item.completed", item: { type: "agent_message", text: CFG.text } }, { type: "turn.completed", usage: {} }];
  process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
})();
`;

/** A setup package, so the runner goes on past the opening to its resumed turns. */
const PACKAGE = "Here is the package.\nPlan, revision 0123456789ab:\nTicket: Sign in\nEnd of plan, revision 0123456789ab\n- Approve setup\n- Adjust the plan\n- Inspect details";

interface Run {
  readonly status: number | null; readonly output: string; readonly argvs: readonly string[][]; readonly record: Record<string, unknown> | null;
  /** 2b: the run's served-reviews.jsonl, and what the stand-in client saw for each setup-review call. */
  readonly served: string | null; readonly reviews: readonly { argv: string[]; status: number | null; stdout: string; stderr: string }[];
}

function runHost(extra: readonly string[], more: Partial<SentinelCfg> = {}): Run {
  return hostRun(extra, more, (args, opts) => spawnSync(process.execPath, args, opts));
}

/** runHost without blocking the test worker, for the long rows: vitest's worker keeps answering while it runs. */
function runHostAsync(extra: readonly string[], more: Partial<SentinelCfg> = {}): Promise<Run> {
  return new Promise((done) => {
    hostRun(extra, more, (args, opts) => ({ async: spawn(process.execPath, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeout }) }), done);
  });
}

type Spawner = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; encoding: "utf-8"; timeout: number }) => { status?: number | null; stdout?: string; stderr?: string; async?: ReturnType<typeof spawn> };

function hostRun(extra: readonly string[], more: Partial<SentinelCfg>, run: Spawner, finished?: (r: Run) => void): Run {
  // A short name: tsx's IPC pipe lives under TMPDIR and a long one truncates that socket path.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538h-")));
  let keep = false;
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "sentinel.log");
    writeFileSync(join(bin, "codex"), `#!${process.execPath}\n${sentinel({ log, text: PACKAGE, reviewOut: join(dir, "reviews.jsonl"), ...more })}`, { mode: 0o755 });
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}\n");
    const home = join(dir, "home");
    mkdirSync(home);
    const env: NodeJS.ProcessEnv = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: home, TMPDIR: dir, CODEX_HOME: codexHome };
    const started = run([TSX, RUNNER, "--client", "codex", "--out", join(dir, "out"), "--raw-out", join(dir, "raw"), "--attempt-base", join(dir, "att"), ...extra], { cwd: PKG, env, encoding: "utf-8", timeout: 280_000 });
    if (started.async !== undefined) {
      const child = started.async;
      let stdout = ""; let stderr = "";
      child.stdout!.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      child.stderr!.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
      child.on("close", (status) => {
        try { finished!(collect(dir, log, { status, stdout, stderr })); } finally { rmSync(dir, { recursive: true, force: true }); }
      });
      keep = true;
      return { status: null, output: "", argvs: [], record: null, served: null, reviews: [] };
    }
    return collect(dir, log, started);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

function collect(dir: string, log: string, r: { status?: number | null; stdout?: string; stderr?: string }): Run {
  {
    const argvs = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
    const runs = existsSync(join(dir, "out")) ? readdirSync(join(dir, "out")) : [];
    const recordFile = runs.length === 1 ? join(dir, "out", runs[0]!, "record.json") : null;
    const record = recordFile !== null && existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf-8")) as Record<string, unknown> : null;
    const raws = existsSync(join(dir, "raw")) ? readdirSync(join(dir, "raw")) : [];
    const servedFile = raws.length === 1 ? join(dir, "raw", raws[0]!, "served-reviews.jsonl") : null;
    const served = servedFile !== null && existsSync(servedFile) ? readFileSync(servedFile, "utf-8") : null;
    const reviewsFile = join(dir, "reviews.jsonl");
    const reviews = existsSync(reviewsFile) ? readFileSync(reviewsFile, "utf-8").split("\n").filter(Boolean).map((l) => {
      const v = JSON.parse(l) as { argv: string[]; status: number | null; stdout: string; stderr: string };
      return { ...v, stdout: Buffer.from(v.stdout, "base64").toString("utf-8"), stderr: Buffer.from(v.stderr, "base64").toString("utf-8") };
    }) : [];
    return { status: r.status ?? null, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, argvs, record, served, reviews };
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
    // Section 3 and 5.6: five roots; the client home and the review store lie beside them.
    const expected = [project, join(project, ".git"), join(work, "tmp"), join(work, "storybloq-global"), join(work, "eval-events")];
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
        // T-538 2a (5.3): the server column, delivered on every turn, first and resumed.
        ...SERVER_KEYS.map((k) => expect.stringMatching(new RegExp(`^mcp_servers\\.storybloq\\.env\\.${k}=`))),
      ]);
    }
  }, 300_000);

  it("T-538 2a: a turn whose client started no sandboxed server is a launch failure", async () => {
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none"], { server: false });
    const ts = (r.record?.turns ?? []) as { infraFailure: string | null }[];
    expect(ts.length, r.output).toBeGreaterThan(0);
    expect(ts[0]!.infraFailure).toBe(`launch: ${NO_SANDBOXED_SERVER}`);
  }, 300_000);

  it("P1: a turn with a held server plus an absent launch outside the wrapper is the launch failure naming that launch", async () => {
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none"], { rogue: "absent" });
    const ts = (r.record?.turns ?? []) as { infraFailure: string | null }[];
    expect(ts.length, r.output).toBeGreaterThan(0);
    expect(ts[0]!.infraFailure).toMatch(/^launch: unsandboxed storybloq server launch [0-9a-f-]{36}$/);
  }, 300_000);

  // Q4 ruling: the real entry refuses a launch with no probe folder and no inventory before it writes a launch
  // line. The row proves the stand-in's launch ran (its refusal text) and the turn shows only its held server.
  it("Q4: a keyless launch of the real entry outside the wrapper refuses before it serves, and the turn shows only its held server", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "t538-rogue-")), "stderr.txt");
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none"], { rogue: "keyless", rogueOut: out });
    const ts = (r.record?.turns ?? []) as { infraFailure: string | null }[];
    expect(ts.length, r.output).toBeGreaterThan(0);
    expect(readFileSync(out, "utf-8")).toContain("is required for entry mcp");
    expect(ts[0]!.infraFailure ?? "").not.toMatch(/unsandboxed|no sandboxed/);
  }, 300_000);

  // P1 after Q4: a launch line from something that is not the real entry, with neither key, fails the turn.
  it("P1: a keyless mcp launch line the stand-in writes itself is the unsandboxed launch failure naming it", async () => {
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none"], { rogue: "keyless-line" });
    const ts = (r.record?.turns ?? []) as { infraFailure: string | null }[];
    expect(ts.length, r.output).toBeGreaterThan(0);
    expect(ts[0]!.infraFailure).toBe("launch: unsandboxed storybloq server launch rogue-keyless-1");
  }, 300_000);

  it("T-538 2a: the fault variables reach the server in the faulted session only", async () => {
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "interrupted", "--fault", "step:handover"]);
    const armed = turns(r).map((a) => a.some((x) => x.startsWith("mcp_servers.storybloq.env.STORYBLOQ_EVAL_FAULT=")));
    expect(armed.length, r.output).toBeGreaterThan(1);
    expect(armed[0]).toBe(true);
    expect(armed.at(-1)).toBe(false);
    // Once cleared, never back.
    expect(armed.slice(armed.indexOf(false)).every((x) => !x)).toBe(true);
  }, 300_000);
});

describe("T-538 2a: the runner's own turn checks, end to end", () => {
  const record = (r: Run): { infraFailure: string | null }[] => (r.record?.turns ?? []) as { infraFailure: string | null }[];

  it("a descendant left holding the attempt's tree is a cleanup failure naming it", async () => {
    const pids = join(realpathSync(mkdtempSync(join(tmpdir(), "t538l-"))), "pids");
    try {
      const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none"], { leave: pids });
      const first = record(r)[0];
      expect(first, r.output).toBeDefined();
      const pid = readFileSync(pids, "utf-8").split("\n")[0];
      expect(first!.infraFailure).toMatch(new RegExp(`^cleanup: leftover: (.+, )?${pid} node`));
    } finally {
      if (existsSync(pids)) for (const p of readFileSync(pids, "utf-8").split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } }
      rmSync(dirname(pids), { recursive: true, force: true });
    }
  }, 300_000);

  it("a turn writing past the stdout limit is stopped and named", async () => {
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none"], { flood: 65 << 20 });
    expect(record(r)[0]?.infraFailure, r.output).toBe("limit: stdout over 67108864 bytes");
  }, 300_000);

  it("a resumed turn that ignores SIGTERM is timed out and killed after the grace", async () => {
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none", "--timeout-ms", "20000"], { hangResume: true });
    const ts = record(r);
    expect(ts.length, r.output).toBeGreaterThan(1);
    expect(ts[0]!.infraFailure).toBeNull();
    expect(ts.at(-1)!.infraFailure).toBe("timed out after 20000 ms");
  }, 300_000);
});

/** The server column's keys (5.3) for a Codex run with no fault armed. */
const SERVER_KEYS = ["CODEX_HOME", "HOME", "LANG", "PATH", "STORYBLOQ_CLIENT", "STORYBLOQ_EVAL_EVENTS", "STORYBLOQ_EVAL_OUTSIDE", "STORYBLOQ_EVAL_REVIEW_RESPONSES", "STORYBLOQ_EVAL_TOOLS", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_SETUP_REVIEW_DIR", "TMPDIR"];

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
  readonly server?: boolean;
  /** F2: where the wrapper stand-in appends its environment's names for each server launch. */
  readonly envNames?: string;
}

/** Runs the runner's real entry for --client claude with the stand-in on PATH; `then` reads the results before cleanup. */
async function withClaude<T>(opts: ClaudeOpts, then: (r: ClaudeRun) => T): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538c-")));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const sets = opts.sets === undefined ? { degraded: DEGRADED, full: FULL } : opts.sets;
    const config = { log: join(dir, "sentinel.log"), sets: opts.answerSets ?? sets ?? { degraded: DEGRADED, full: FULL }, text: PACKAGE, mark: MARK, mutate: opts.mutate ?? null, tamper: opts.tamper ?? null, split: opts.split ?? null, early: opts.early ?? false, noInit: opts.noInit ?? false, server: opts.server ?? true };
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nrequire(${JSON.stringify(CLAUDE_SENTINEL)}).main(${JSON.stringify(config)});\n`, { mode: 0o755 });
    // The tool server's wrapper (5.2): the stand-in, so these rows need no real codex.
    writeFileSync(join(bin, "codex"), `#!${process.execPath}\n${sentinel({ log: join(dir, "codex.log"), text: "", ...(opts.envNames ? { envNames: opts.envNames } : {}) })}`, { mode: 0o755 });
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}\n");
    const home = join(dir, "home");
    mkdirSync(home);
    const setsFile = join(dir, `sets-${MARK}.json`);
    if (sets !== null) writeFileSync(setsFile, JSON.stringify(sets));
    const env: NodeJS.ProcessEnv = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: home, TMPDIR: dir, CODEX_HOME: codexHome, CLAUDE_CODE_OAUTH_TOKEN: "placeholder-not-a-token" };
    const args = [TSX, RUNNER, "--client", "claude", "--fixture", opts.fixture ?? "empty-idea", "--variant", opts.variant ?? "none", "--out", join(dir, "out"), "--raw-out", join(dir, "raw"), "--attempt-base", join(dir, "att"),
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

  it("F11: a faulted Claude run reaches session 2 with the manifest check on, the MCP file's entry following its rewrite", async () => {
    await withClaude({ variant: "interrupted", fixture: "empty-idea", extra: ["--fault", "step:handover"] }, (r) => {
      expect(r.output).not.toContain("harness stop before the turn");
      expect(argvsOf(r).filter((a) => a.includes("--session-id")).length, r.output).toBeGreaterThanOrEqual(2);
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
  // T-538 2a pinned the inventory file, so a run with no --tool-sets now reads it; the refusal for a missing
  // pin is held as a unit row (the same check, without deleting a tracked file).
  it("with no --tool-sets and no pinned file, a Claude run is refused before anything starts", () => {
    expect(() => claudeToolSets(null, join(tmpdir(), "t538-no-such-inventory.json"))).toThrow("onboarding-eval: no pinned tool inventory (plan 5.4)");
    expect(existsSync(TOOL_SETS_FILE)).toBe(true);
  });

  it("T-538 2a: a Claude turn whose client started no sandboxed server is a launch failure", async () => {
    await withClaude({ server: false }, (r) => {
      expect(turnsOf(r).length, r.output).toBeGreaterThan(0);
      expect(turnsOf(r)[0]!.infraFailure).toBe(`launch: ${NO_SANDBOXED_SERVER}`);
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

describe("T-538 2c: the client's configuration and the project are checked before every turn (plan 5.6)", () => {
  it.each([
    ["skill", /harness stop before the turn: config: \S*\/claude-config\/skills\/story\/SKILL\.md changed/],
    ["extra", /harness stop before the turn: config: \S*\/claude-config\/extra\.json is not in the manifest/],
    ["plant", /harness stop before the turn: project: \S*\/project\/\.claude: a client loads this name/],
  ] as const)("a %s after the first turn stops the run before the second", async (tamper, message) => {
    await withClaude({ tamper }, (r) => {
      expect(argvsOf(r).length, r.output).toBe(1);
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(message);
    });
  }, 300_000);

  it("Claude's own state under its config folder is not a stop", async () => {
    await withClaude({ tamper: "state" }, (r) => {
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
    spawnError: null, launch: null, inputError: null, limit: null, timedOut: false, timeoutMs: 900_000, outcome: processOutcome(0, null, false),
    terminal: { status: "completed", detail: "" }, cleanup: "confirmed", cleanupDetail: null, leftover: { status: "clean", holders: [], reason: null },
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
    ["timed out", { timedOut: true, outcome: processOutcome(null, "SIGTERM", false) }, "timed out after 900000 ms"],
    ["killed", { outcome: processOutcome(null, "SIGKILL", false) }, "killed by SIGKILL"],
    ["exit", { outcome: processOutcome(3, null, false) }, "exit 3"],
    ["terminal", { terminal: { status: "missing", detail: "no result event" } }, "terminal missing: no result event"],
  ] as const)("the order holds: %s outranks everything after it (F5)", (_n, facts, want) => {
    const later: Partial<TurnFailureFacts>[] = [
      { inputError: "write after exit" }, { timedOut: true }, { outcome: processOutcome(null, "SIGTERM", false) }, { outcome: processOutcome(1, null, false) }, { terminal: { status: "failed", detail: "x" } }, UNCONFIRMED,
    ];
    const at = ["spawn failed", "launch", "input", "timed out", "killed", "exit", "terminal"].indexOf(_n);
    const below = Object.assign({}, ...later.slice(Math.max(0, at - 1)));
    expect(turnInfraFailure({ ...CLEAN, ...below, ...facts })).toBe(want);
  });
});

describe("T-538 2b: served reviews through the real bundle CLI (plan 5.5)", () => {
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const SS = "SS-0123abcd";

  it("gate and status are served on the host and come back byte for byte; a grammar violation is refused 64; the log is a replay input", async () => {
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none"], {
      review: [{ argv: ["gate"] }, { argv: ["status", "--setup", SS] }, { argv: ["run", "--setup", SS, "--backend", "claude"], stdin: "plan" }],
    });
    expect(r.reviews.map((x) => x.argv[0]), r.output).toEqual(["gate", "status", "run"]);
    const lines = (r.served ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] | null; exit: number; stdoutSha256: string; stderrSha256: string; refused?: string });
    expect(lines, r.output).toHaveLength(3);
    r.reviews.forEach((seen, i) => {
      expect(seen.status, `${seen.argv.join(" ")}: ${seen.stderr}`).toBe(lines[i]!.exit);
      expect(sha(seen.stdout)).toBe(lines[i]!.stdoutSha256);
      expect(sha(seen.stderr)).toBe(lines[i]!.stderrSha256);
    });
    // The product's own output: the gate's probe line, from this checkout's CLI.
    expect(r.reviews[0]!.stdout).toMatch(/^Reviewer probe: /m);
    expect(lines[0]!.refused).toBeUndefined();
    expect(r.reviews[2]!.status).toBe(64);
    expect(r.reviews[2]!.stderr).toMatch(/^setup-review: refused: /);
    expect(lines[2]!.refused).toBeDefined();
    const inputs = (r.record?.replayInputs ?? []) as { path: string }[];
    expect(inputs.map((x) => x.path)).toContain("served-reviews.jsonl");
    expect(JSON.stringify(r.record?.failures ?? [])).not.toContain("a review record no served command produced");
  }, 300_000);

  it("reviewer-unavailable: the served gate finds no reviewer, since reviewer-bin holds no codex and never claude", async () => {
    const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "reviewer-unavailable"], { review: [{ argv: ["gate"] }] });
    expect(r.reviews, r.output).toHaveLength(1);
    expect(r.reviews[0]!.stdout, r.reviews[0]!.stderr).toContain("Reviewer probe: none available");
    // Served by the harness on the host, not run in place: one served line, its output the one the client saw.
    const lines = (r.served ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdoutSha256: string });
    expect(lines.map((l) => l.argv), r.output).toEqual([["gate"]]);
    expect(lines[0]!.stdoutSha256).toBe(sha(r.reviews[0]!.stdout));
  }, 300_000);
});

// --- F2: the tool server's environment is exactly the server column, whatever the client inherits --------------

/** The server column's names for an unarmed session (plan 5.3), from the table itself. */
const SERVER_NAMES = Object.keys(envFor("server", {
  client: "claude", path: "/p", home: "/h", tmp: "/t", lang: "C", runnerHome: "/r", globalDir: "/g", events: "/e", reviewStore: "/s", outside: "/o", tools: "/tl", degraded: false, reviewResponses: "/rr",
})).sort();
const CLIENT_ONLY = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ENABLE_TOOL_SEARCH"];
// macOS adds __CF_USER_TEXT_ENCODING to every new process itself; no launch hands it over, so it is left out.
const launchesSeen = (file: string): { names: string[]; storeUnderRoot: boolean }[] => (existsSync(file) ? readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { names: string[]; storeUnderRoot: boolean }).map((x) => ({ ...x, names: x.names.filter((n) => n !== "__CF_USER_TEXT_ENCODING") })) : []);

describe("F2: the tool server gets exactly the server column", () => {
  it("Claude (degraded, so the client column holds the token, the config folder and ENABLE_TOOL_SEARCH): every server launch's environment names are the column's", async () => {
    const side = realpathSync(mkdtempSync(join(tmpdir(), "t538f2-")));
    try {
      const file = join(side, "names.jsonl");
      await withClaude({ variant: "degraded", envNames: file }, (r) => {
        const seen = launchesSeen(file);
        expect(seen.length, r.output).toBeGreaterThan(0);
        for (const { names, storeUnderRoot } of seen) {
          // F5: the review store the server reads is outside every root the wrapper makes writable.
          expect(storeUnderRoot).toBe(false);
          expect(names).toEqual(SERVER_NAMES);
          for (const n of CLIENT_ONLY) expect(names).not.toContain(n);
        }
      });
    } finally { rmSync(side, { recursive: true, force: true }); }
  }, 300_000);

  it("Codex, with a client that hands the server its whole environment: every server launch's environment names are the column's", async () => {
    const side = realpathSync(mkdtempSync(join(tmpdir(), "t538f2-")));
    try {
      const file = join(side, "names.jsonl");
      const r = await runHostAsync(["--fixture", "empty-idea", "--variant", "none"], { envNames: file, inheritAll: true });
      const seen = launchesSeen(file);
      expect(seen.length, r.output).toBeGreaterThan(0);
      for (const { names, storeUnderRoot } of seen) {
        // F5: the review store the server reads is outside every root the wrapper makes writable.
        expect(storeUnderRoot).toBe(false);
        expect(names).toEqual(SERVER_NAMES.map((n) => n).sort());
        for (const n of [...CLIENT_ONLY, "STORYBLOQ_EVAL_FAULT"]) expect(names).not.toContain(n);
      }
    } finally { rmSync(side, { recursive: true, force: true }); }
  }, 300_000);
});
