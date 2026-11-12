/**
 * ISS-1486: the continuity runner launches Claude under the shared launch policy. Model free: the client is the
 * stand-in test/fixtures/continuity-claude-sentinel.cjs (a real child process speaking the control protocol) or an
 * in-process fake for the rows that need exact timing. Nothing here starts a model or reads a credential.
 */
import { afterAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { connect as netConnect } from "node:net";
import { spawn as nodeSpawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, chmodSync, realpathSync, copyFileSync, cpSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  LAUNCH_POLICY, PILOT_EVIDENCE, PILOT_FILE, PILOT_PROBES, classifyDenial, decideCell, experimentHash, fixtureCredentialAllowlist, judgePilot, pathMapping, readPilot, sha256, verifyAttemptDir,
  INPUT_PATHS, MAX_INVALID_RETRIES, configInventoryDrift, type PilotFacts, type StreamEvent,
} from "../../scripts/continuity-lib.js";
import {
  continuityTools, continuityOptions, effectiveConfigHash, launchEnv, prepareLaunch, provisionFreshConfig, runAttempt, runMatrix, runPilot, LaunchPolicyStopError, RETAINED_WORKDIR_FILE, type Launch,
  withheldTools, bundleProblems, launchProblems, EVAL_MCP_BUNDLE, CONTINUITY_SERVER_COLUMN, ONBOARDING_TOOLS_FILE, codexFingerprint, codexProblems, buildManifestHash,
  type Preflight, type RunOptions, type SpawnFn,
} from "../../scripts/continuity-run.js";
import { CLAUDE_TOOLS, ONBOARDING_OPTIONS, readbackProblems, type ReadbackExpected, type ReadbackStep } from "../../scripts/headless-policy.js";

import { writeVerifiedPilot, PILOT_TEMPLATE, PILOT_TEMPLATE_ID } from "./continuity-pilot-fixture.js";
import { removeKeptWorkdirs } from "../helpers/kept-workdirs.js";

const PKG = resolve(__dirname, "../..");
const FIXTURE = resolve(__dirname, "../fixtures/continuity");
const SENTINEL = join(PKG, "test", "fixtures", "continuity-claude-sentinel.cjs");
const tmp = (p: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); made.push(d); return d; };
// ISS-1497: every directory this file makes is tracked and removed when the file ends, pass or fail.
const made: string[] = [];
afterAll(() => {
  // A work folder a row kept is named under one of these roots; it goes first, then the roots.
  removeKeptWorkdirs(made);
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOOLS = continuityTools();
/** G2: the server runs the evaluation bundle; preflight records its sha256, and so does every row's preflight. */
const BUNDLE_SHA = existsSync(EVAL_MCP_BUNDLE) ? sha256(readFileSync(EVAL_MCP_BUNDLE)) : "bundle-missing";
const SERVER_START = join(PKG, "test", "fixtures", "t538-server-start.cjs");
/**
 * G2: a stand-in `codex` for the server's wrapper (no real codex needed): it runs the command after `--` with the
 * server's outside probe on a folder it cannot write (t538-server-start.cjs, a stand-in, never a sandbox). With a
 * names file it first appends the names (never the values) of the environment it was given.
 */
function codexStandIn(namesFile: string | null = null): string {
  const file = join(tmp("c1486-codex-"), "codex");
  const names = namesFile === null ? "" : `require("node:fs").appendFileSync(${JSON.stringify(namesFile)}, JSON.stringify(Object.keys(process.env).sort()) + "\\n");\n`;
  writeFileSync(file, `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === "--version") { process.stdout.write("codex-cli 0.0.0-stand-in\\n"); process.exit(0); }\n${names}require(${JSON.stringify(SERVER_START)}).sandboxStandIn(a);\n`, { mode: 0o755 });
  return file;
}
const CODEX = codexStandIn();
const CODEX_FP = codexFingerprint(CODEX);
const BUILT_INS = continuityOptions("high").builtInTools;
const sentinel = createRequire(import.meta.url)("../fixtures/t538-claude-sentinel.cjs") as { goodResponses: (x: Record<string, unknown>) => Record<string, Record<string, unknown>> };

const FAKE_DIST: Record<string, string> = { "dist/mcp.js": "1".repeat(64), "dist/cli.js": "2".repeat(64), "dist/index.js": "3".repeat(64), "dist/presence.js": "4".repeat(64) };
const FAKE_INPUTS: Record<string, string> = Object.fromEntries(INPUT_PATHS.map((p, i) => [p, String(i % 10).repeat(64)]));
const EXP = "e".repeat(64);

function preflight(over: Partial<Preflight> = {}): Preflight {
  const template = tmp("c1486-template-"); provisionFreshConfig(template);
  const cfg = effectiveConfigHash(template);
  // J2: the manifest records the fingerprint of the codex this preflight names, as the real preflight does.
  const codex = codexFingerprint(over.codexBin ?? CODEX);
  return {
    build: { workspaceHead: "h", nodeVersion: process.version, packageJsonSha256: "p", lockfileSha256: "l", installedLockSha256: null, tsupConfigSha256: "t", dist: { ...FAKE_DIST }, storybloqVersion: "1.15.9", storybloqExecutable: join(PKG, "dist", "cli.js"), claudeVersion: "2.1.322 (Claude Code)", evalMcpSha256: BUNDLE_SHA, ...codex },
    buildManifestHash: "bmh", inputTreeHash: "ith", experiment: EXP, isolation: "fresh", sharedConfigDir: null, tools: TOOLS, configHash: cfg.sha256, configInventory: cfg.inventory,
    inputHashes: { ...FAKE_INPUTS }, taskMaterialHash: "a".repeat(64), taskMaterialHashes: {}, skillMarker: null, allowlist: fixtureCredentialAllowlist(join(FIXTURE, "core")), codexBin: CODEX, ...over,
  };
}

/** A verified pilot for one arm: a real one the runner published (G4: the reader recomputes it from its evidence). */
function writePilot(expDir: string, over: Record<string, unknown> = {}): void {
  writeVerifiedPilot(expDir, EXP, 1, over);
}

function options(over: Partial<RunOptions> = {}, pilot = true): RunOptions {
  const o: RunOptions = { arm: 1, tasks: ["T-4"], repeats: 1, model: "claude-opus-5", effort: "high", isolation: "fresh", out: tmp("c1486-out-"), rawOut: tmp("c1486-raw-"), timeoutMs: 20_000, sigkillGraceMs: 300, maxBudgetUsd: 1, ...over };
  if (pilot) writePilot(join(o.out, EXP.slice(0, 12)));
  return o;
}

type Extra = { readonly signals?: EventEmitter; readonly readbackTimeoutMs?: number; readonly beforeSpawnCheck?: Parameters<typeof runAttempt>[5] extends infer D ? D extends { beforeSpawnCheck?: infer B } ? B : never : never };
const deps = (spawnFn: SpawnFn, extra: Extra = {}) => ({
  spawnFn, distHashes: () => ({ ...FAKE_DIST }), inputHashes: () => ({ hashes: { ...FAKE_INPUTS }, errors: {} }), loadSample: () => ({ load1: 1, swapFreeBytes: 8 * 1024 ** 3 }), log: () => {}, ...extra,
});

const pubDir = (o: RunOptions, task = "T-4", repeat = 1, attempt = 1): string => join(o.out, EXP.slice(0, 12), task, `repeat-${repeat}`, `attempt-${String(attempt).padStart(3, "0")}`);
const recordOf = (o: RunOptions, attempt = 1, task = "T-4"): Record<string, unknown> => JSON.parse(readFileSync(join(pubDir(o, task, 1, attempt), "record.json"), "utf-8")) as Record<string, unknown>;

// --- the stand-in client as a real child process -------------------------------------------------

interface Launched { readonly args: string[]; readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly log: string }

function sentinelSpawn(configFor: (n: number) => Record<string, unknown>, seen: Launched[]): SpawnFn {
  const dir = tmp("c1486-sentinel-");
  return (_cmd, args, opts) => {
    const n = seen.length;
    const log = join(dir, `log-${n}.jsonl`);
    const config = { tools: TOOLS, builtIns: BUILT_INS, fingerprint: FAKE_DIST["dist/mcp.js"], log, ...configFor(n) };
    const wrapper = join(dir, `claude-${n}.cjs`);
    writeFileSync(wrapper, `require(${JSON.stringify(SENTINEL)}).main(${JSON.stringify(config)});\n`);
    seen.push({ args: [...args], env: opts.env as NodeJS.ProcessEnv, cwd: opts.cwd as string, log });
    return nodeSpawn(process.execPath, [wrapper, ...args], opts as Parameters<typeof nodeSpawn>[2]);
  };
}
const logOf = (l: Launched): { kind: string; [k: string]: unknown }[] => (existsSync(l.log) ? readFileSync(l.log, "utf-8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x) as { kind: string }) : []);

// --- an in-process client for exact timing ----------------------------------------------------

class IpChild extends EventEmitter {
  pid = 0;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: string[] = [];
  constructor(private readonly ignoreTerm: boolean) { super(); }
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(sig);
    if (sig === "SIGTERM" && this.ignoreTerm) return true;
    this.finish(null, sig);
    return true;
  }
  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = signal;
    this.stdout.end();
    setTimeout(() => this.emit("close", code, signal), 0);
  }
}

interface Script {
  readonly ignoreTerm?: boolean;
  /** Per request: send the answer (`reply`), or anything else. Default: reply. */
  readonly onRequest?: (sub: string, reply: () => void, c: IpChild, answers: Record<string, Record<string, unknown>>) => void;
  /** After the prompt arrives. Default: an init event, a result, exit 0. */
  readonly onPrompt?: (c: IpChild) => void;
}

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const INIT = { type: "system", subtype: "init", session_id: "s", model: "claude-opus-5", permissionMode: "dontAsk", apiKeySource: "none", mcp_servers: [{ name: "storybloq", status: "connected" }], tools: [...BUILT_INS, ...TOOLS.map((t) => `mcp__storybloq__${t}`)] };
const RESULT = { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, usage: {}, permission_denials: [] };

function ipSpawn(script: Script, seen: IpChild[]): SpawnFn {
  return (_cmd, args, opts) => {
    const c = new IpChild(script.ignoreTerm === true);
    seen.push(c);
    const opt = (k: string): string => args[args.indexOf(k) + 1] ?? "";
    const policy = JSON.parse(readFileSync(opt("--settings"), "utf-8")) as { sandbox: { filesystem: { allowWrite: string[] } } };
    const server = (JSON.parse(readFileSync(opt("--mcp-config"), "utf-8")) as { mcpServers: { storybloq: { command: string; args: string[]; env: Record<string, string> } } }).mcpServers.storybloq;
    const answers = sentinel.goodResponses({ project: opts.cwd, roots: policy.sandbox.filesystem.allowWrite, policy, mcpTools: TOOLS, mcpLaunch: { command: server.command, args: server.args } });
    for (const s of answers.mcp_status!.mcpServers as { config: Record<string, unknown> }[]) s.config = { ...s.config, env: { ...server.env } };
    let pending = "";
    c.stdin.on("data", (d: Buffer) => {
      pending += d.toString("utf-8");
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const text = pending.slice(0, nl); pending = pending.slice(nl + 1);
        const msg = JSON.parse(text) as { type: string; request_id?: string; request?: { subtype: string } };
        if (msg.type === "control_request") {
          const sub = msg.request!.subtype;
          const reply = (): void => { c.stdout.write(line({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: answers[sub] } })); };
          (script.onRequest ?? ((_s, r) => r()))(sub, reply, c, answers);
        } else if (msg.type === "user") {
          (script.onPrompt ?? ((ch: IpChild) => { ch.stdout.write(line(INIT)); ch.stdout.write(line(RESULT)); }))(c);
        }
      }
    });
    c.stdin.on("end", () => c.finish(0, null));
    return c as unknown as ChildProcess;
  };
}

// --- 1, 7, 12: a clean launch end to end ----------------------------------------------------

describe("ISS-1486 launch: argv, prompt, environment and evidence", () => {
  it("1 and 7: every attempt, first and retry, carries exactly the policy argv and no bypass; the prompt arrives once over stdin; the evidence pair is published and hashed", async () => {
    const o = options({ tasks: ["T-4", "T-3"], timeoutMs: 4000 }); const pf = preflight(); const seen: Launched[] = [];
    // The first attempt hangs after its prompt and times out (a counted invalid): the retry must launch the same way.
    const r = await runMatrix(o, pf, deps(sentinelSpawn((n) => (n === 0 ? { hang: true } : {}), seen)));
    expect(seen).toHaveLength(3);
    expect(r.summary).toEqual(expect.arrayContaining(["T-4#1: satisfied by attempt-002", "T-3#1: satisfied by attempt-001"]));
    for (const l of seen) {
      expect(l.args.join(" ")).not.toMatch(/dangerously|bypass|--yolo|--full-auto|danger-full-access/);
      expect(l.args.some((a) => a.includes("/story auto"))).toBe(false);
      expect(l.args[l.args.indexOf("--effort") + 1]).toBe("high");
      expect(l.args).toContain("--no-session-persistence");
      const log = logOf(l);
      expect(log.filter((e) => e.kind === "request").map((e) => e.subtype)).toEqual(["initialize", "get_settings", "get_sandbox_dialog", "list_permission_rules", "mcp_status", "get_hooks_listing"]);
      expect(log.filter((e) => e.kind === "user")).toHaveLength(1);
      // D3: the environment is the table, and nothing else.
      const keys = (log[0]!.env as string[]).filter((k) => !["LANG", "LC_ALL", "CLAUDE_CODE_OAUTH_TOKEN", "__CF_USER_TEXT_ENCODING"].includes(k));
      expect(keys).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "PATH", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_PROJECT_ROOT", "TMPDIR"]);
      expect(l.env.STORYBLOQ_PROJECT_ROOT).toBe(l.cwd);
    }
    expect(logOf(seen[1]!).find((e) => e.kind === "user")!.content).toBe("/story auto T-4");
    expect(logOf(seen[1]!).at(-1)!.kind).toBe("end");
    expect(recordOf(o, 1)).toMatchObject({ validity: "invalid", killKind: "timeout", launchPolicy: LAUNCH_POLICY, launchPolicyFailure: null });
    const pub = pubDir(o, "T-4", 1, 2);
    const record = recordOf(o, 2);
    expect(record).toMatchObject({ validity: "valid", launchPolicy: LAUNCH_POLICY, launchPolicyFailure: null, inputFailure: null, promptDelivered: true });
    expect(record.requiredArtefacts).toEqual(expect.arrayContaining(["readback.json", "launch.json"]));
    const hashes = JSON.parse(readFileSync(join(pub, "artefacts.sha256.json"), "utf-8")) as Record<string, string>;
    for (const f of ["readback.json", "launch.json"]) expect(hashes[f]).toBe(sha256(readFileSync(join(pub, f))));
    const launch = readFileSync(join(pub, "launch.json"), "utf-8");
    expect(launch).toContain("<WORK>"); expect(launch).not.toContain(seen[1]!.cwd);
    expect(JSON.parse(launch).envNames).toEqual(expect.arrayContaining(["PATH", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "STORYBLOQ_PROJECT_ROOT"]));
    expect(verifyAttemptDir(pub).evidenceComplete).toBe(true);
    for (const f of ["readback.json", "launch.json"]) {
      const copy = tmp("c1486-verify-"); cpSync(pub, copy, { recursive: true });
      rmSync(join(copy, f));
      expect(verifyAttemptDir(copy).evidenceComplete, `${f} removed`).toBe(false);
      const edit = tmp("c1486-verify-"); cpSync(pub, edit, { recursive: true });
      writeFileSync(join(edit, f), `${readFileSync(join(edit, f), "utf-8")} `);
      expect(verifyAttemptDir(edit).evidenceComplete, `${f} edited`).toBe(false);
    }
  }, 60_000);

  it("11: a temp folder reached through a link launches with canonical roots and passes the readback", async () => {
    const real = tmp("c1486-realtmp-"); const link = join(tmp("c1486-link-"), "t"); symlinkSync(real, link);
    const was = process.env.TMPDIR;
    process.env.TMPDIR = link;
    try {
      const o = options(); const pf = preflight(); const seen: Launched[] = [];
      const r = await runAttempt(o, pf, "T-4", 1, 1, deps(sentinelSpawn(() => ({}), seen)));
      expect(r.validity).toBe("valid");
      expect(seen[0]!.cwd.startsWith(`${real}/`)).toBe(true);
      expect(seen[0]!.env.TMPDIR!.startsWith(`${real}/`)).toBe(true);
    } finally {
      if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
    }
  }, 30_000);
});

// --- 3, 4, 5: launch-policy refusals ----------------------------------------------------------

describe("ISS-1486 launch policy: refusals before and after the spawn", () => {
  const tamper: Record<string, (l: { expected: { policyFile: string; mcpFile: string } }) => void> = {
    "an edited policy file": (l) => { chmodSync(l.expected.policyFile, 0o600); writeFileSync(l.expected.policyFile, " ", { flag: "a" }); chmodSync(l.expected.policyFile, 0o400); },
    "an edited MCP file": (l) => { writeFileSync(l.expected.mcpFile, " ", { flag: "a" }); },
    "a wrong mode": (l) => { chmodSync(l.expected.policyFile, 0o644); },
    "a link": (l) => { const p = l.expected.policyFile; copyFileSync(p, `${p}.real`); rmSync(p); symlinkSync(`${p}.real`, p); },
  };
  for (const [name, fn] of Object.entries(tamper)) {
    it(`3: ${name} refuses before the spawn as launch-policy, stops the matrix, spends nothing`, async () => {
      const o = options({ tasks: ["T-4", "T-3"] }); const pf = preflight(); let spawned = 0;
      const err = await runMatrix(o, pf, deps(() => { spawned++; throw new Error("spawned"); }, { beforeSpawnCheck: fn as never })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LaunchPolicyStopError);
      expect(spawned).toBe(0);
      expect(recordOf(o)).toMatchObject({ validity: "invalid", invalidReasons: ["launch-policy"], completion: "not-started", launchPolicy: LAUNCH_POLICY });
      expect(String(recordOf(o).launchPolicyFailure)).not.toBe("null");
      expect(existsSync(join(pubDir(o), "launch.json"))).toBe(true);
      expect(existsSync(join(o.out, EXP.slice(0, 12), "T-3"))).toBe(false);
    });
  }

  const wrong: [string, string, unknown, RegExp][] = [
    ["initialize", "current_permission_mode", "default", /^initialize\.current_permission_mode/],
    ["get_settings", "sources", [], /^get_settings\.sources/],
    ["get_sandbox_dialog", "enabled", false, /^get_sandbox_dialog\.enabled/],
    ["list_permission_rules", "state.rules", [], /^list_permission_rules\.state\.rules/],
    ["mcp_status", "mcpServers.0.config.args", ["/elsewhere/mcp.js"], /^mcp_status\.mcpServers/],
    ["get_hooks_listing", "policy.policyHookCount", 1, /^get_hooks_listing\.policy\.policyHookCount/],
    // Ruling 1: until the pilot shows the real client echoes the server's environment, a missing echo fails closed.
    ["mcp_status", "mcpServers.0.config.env", {}, /^mcp_status\.mcpServers/],
  ];
  for (const [sub, path, value, want] of wrong) {
    it(`4: ${sub}.${path} wrong: no prompt, a policy stop, launch-policy, no retry, the cell not satisfied`, async () => {
      const o = options({ tasks: ["T-4", "T-3"] }); const pf = preflight(); const seen: Launched[] = [];
      const err = await runMatrix(o, pf, deps(sentinelSpawn(() => ({ mutate: { sub, path, value } }), seen))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LaunchPolicyStopError);
      expect(seen).toHaveLength(1);
      expect(logOf(seen[0]!).some((e) => e.kind === "user")).toBe(false);
      const record = recordOf(o);
      expect(record).toMatchObject({ validity: "invalid", killKind: "policy-stop", promptDelivered: false, inputFailure: null });
      expect(record.invalidReasons).toContain("launch-policy");
      expect(String(record.launchPolicyFailure)).toMatch(want);
      expect(readdirSync(join(o.out, EXP.slice(0, 12), "T-4", "repeat-1"))).toEqual(["attempt-001"]);
    }, 30_000);
  }

  const init: [string, Record<string, unknown>, RegExp][] = [
    ["missing", { noInit: true }, /^init: no system init event/],
    ["a wrong permission mode", { mutate: { sub: "init", path: "permissionMode", value: "default" } }, /^init\.permissionMode/],
    ["a wrong key source", { mutate: { sub: "init", path: "apiKeySource", value: "user" } }, /^init\.apiKeySource/],
    ["an extra tool", { mutate: { sub: "init", path: "tools", value: [...BUILT_INS, "WebFetch"] } }, /^init\.tools/],
    ["a second server", { mutate: { sub: "init", path: "mcp_servers", value: [{ name: "storybloq", status: "connected" }, { name: "other", status: "connected" }] } }, /^init\.mcp_servers/],
  ];
  for (const [name, config, want] of init) {
    it(`5: an init event with ${name} is launch-policy and stops the matrix`, async () => {
      const o = options({ tasks: ["T-4", "T-3"] }); const pf = preflight(); const seen: Launched[] = [];
      const err = await runMatrix(o, pf, deps(sentinelSpawn(() => config, seen))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LaunchPolicyStopError);
      expect(seen).toHaveLength(1);
      expect(String(recordOf(o).launchPolicyFailure)).toMatch(want);
      expect(recordOf(o).invalidReasons).toContain("launch-policy");
    }, 30_000);
  }
});

// --- 6: the lifecycle during the readback -------------------------------------------------------

describe("ISS-1486 lifecycle during the readback (in-process client)", () => {
  const run = async (script: Script, over: Partial<RunOptions> = {}, extra: Extra = {}) => {
    const o = options(over); const pf = preflight(); const seen: IpChild[] = [];
    const out = await runAttempt(o, pf, "T-4", 1, 1, deps(ipSpawn(script, seen), extra));
    return { out, record: recordOf(o), seen };
  };

  it("a spawn failure is neither launch-policy nor input-failure", async () => {
    const o = options(); const pf = preflight();
    const spawnFn: SpawnFn = () => { const c = new IpChild(false); setTimeout(() => c.emit("error", new Error("ENOENT")), 1); return c as unknown as ChildProcess; };
    const r = await runAttempt(o, pf, "T-4", 1, 1, deps(spawnFn));
    expect(r).toMatchObject({ validity: "invalid", launchPolicy: null, inputFailure: null });
  });
  it("a child that closes during the readback (EPIPE or early exit) is input-failure with an incomplete readback, not launch-policy", async () => {
    const { out, record } = await run({ onRequest: (sub, reply, c) => { if (sub === "get_settings") { c.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); c.finish(0, null); } else reply(); } });
    expect(out).toMatchObject({ validity: "invalid", launchPolicy: null, inputFailure: "EPIPE" });
    expect(record).toMatchObject({ readbackIncomplete: true, promptDelivered: false, killKind: null });
    expect(record.invalidReasons).toContain("input-failure");
    const early = await run({ onRequest: (sub, reply, c) => { if (sub === "initialize") c.finish(0, null); else reply(); } });
    expect(early.out).toMatchObject({ launchPolicy: null, inputFailure: "the child ended before the prompt was written" });
  });
  it("a clean readback then EPIPE on the prompt is input-failure", async () => {
    const { out, record } = await run({ onPrompt: (c) => { c.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); c.finish(0, null); } });
    expect(out).toMatchObject({ validity: "invalid", launchPolicy: null, inputFailure: "EPIPE" });
    expect(record).toMatchObject({ promptDelivered: false, readbackIncomplete: false });
  });
  it("G6: a clean readback, EPIPE on the prompt write, then a result and exit 0 is input-failure: a later result never excuses an earlier input error", async () => {
    // The result comes on a later turn of the loop, after the prompt's write completed: only the input error decides.
    const { out, record } = await run({ onPrompt: (c) => { c.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); setImmediate(() => { c.stdout.write(line(INIT)); c.stdout.write(line(RESULT)); c.finish(0, null); }); } });
    expect(out).toMatchObject({ validity: "invalid", launchPolicy: null, inputFailure: "EPIPE" });
    expect(record).toMatchObject({ promptDelivered: false, readbackIncomplete: false });
    expect(record.invalidReasons).toContain("input-failure");
  });
  it("G6: a result that arrives before the prompt's write has completed is input-failure", async () => {
    const { out, record } = await run({ onPrompt: (c) => { c.stdout.write(line(INIT)); c.stdout.write(line(RESULT)); } });
    expect(out).toMatchObject({ launchPolicy: null, inputFailure: "a result arrived before the prompt was written" });
    expect(record).toMatchObject({ promptDelivered: false });
  });
  it("G6: an input error only after the result (ending the input) leaves the prompt delivered", async () => {
    // The answer comes on a later turn of the loop, as from a real process: the prompt's write has completed by then.
    const { out, record } = await run({ onPrompt: (c) => { setImmediate(() => { c.stdout.write(line(INIT)); c.stdout.write(line(RESULT)); }); setTimeout(() => { c.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); c.finish(0, null); }, 20); } });
    expect(out).toMatchObject({ launchPolicy: null, inputFailure: null });
    expect(record).toMatchObject({ promptDelivered: true });
  });
  it("a result coalesced with the final control response is input-failure: the prompt is never written", async () => {
    const { out, seen } = await run({ onRequest: (sub, reply, c) => { if (sub === "get_hooks_listing") c.stdout.write(line(RESULT)); reply(); } });
    expect(out).toMatchObject({ launchPolicy: null, inputFailure: "a result arrived before the prompt was written" });
    expect(seen[0]!.exitCode).toBe(0);
  });
  it("an external SIGKILL during the prompt write keeps its class: interrupted, no input-failure", async () => {
    const { out, record } = await run({ onPrompt: (c) => { c.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); c.finish(null, "SIGKILL"); } });
    expect(out).toMatchObject({ interrupted: true, launchPolicy: null, inputFailure: null });
    expect(record.killKind).toBe("external-kill");
  });
  it("the attempt timeout during the prompt write or during the readback keeps the timeout class", async () => {
    const during = await run({ onPrompt: () => { /* hangs */ } }, { timeoutMs: 120, sigkillGraceMs: 40 });
    expect(during.record).toMatchObject({ killKind: "timeout", launchPolicyFailure: null, inputFailure: null });
    const rb = await run({ onRequest: () => { /* never answers */ } }, { timeoutMs: 120, sigkillGraceMs: 40 }, { readbackTimeoutMs: 10_000 });
    expect(rb.record).toMatchObject({ killKind: "timeout", launchPolicyFailure: null, inputFailure: null, readbackIncomplete: true });
  });
  it("a missing response with the child alive is launch-policy with a policy stop", async () => {
    const { out, record } = await run({ onRequest: (sub, reply) => { if (sub !== "get_settings") reply(); } }, {}, { readbackTimeoutMs: 60 });
    expect(out.launchPolicy).toMatch(/^get_settings: no response/);
    expect(record).toMatchObject({ killKind: "policy-stop", promptDelivered: false });
  });
  it("a child that ignores SIGTERM after a policy stop is killed after the grace; SIGINT during that grace is the operator's", async () => {
    const bad: Script = { ignoreTerm: true, onRequest: (sub, reply, _c, answers) => { if (sub === "initialize") answers.initialize!.current_permission_mode = "default"; reply(); } };
    const a = await run(bad, { sigkillGraceMs: 40 });
    expect(a.seen[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(a.record).toMatchObject({ killKind: "policy-stop", launchPolicyFailure: "initialize.current_permission_mode" });
    const signals = new EventEmitter();
    const b = await run({ ...bad, onRequest: (sub, reply, c, answers) => { bad.onRequest!(sub, reply, c, answers); if (sub === "initialize") setTimeout(() => signals.emit("SIGINT"), 20); } }, { sigkillGraceMs: 200 }, { signals });
    expect(b.out.interrupted).toBe(true);
    expect(b.record.killKind).toBe("runner-signal");
  });
  it("ruling 4: input-failure counts toward the retry budget; launch-policy consumes no retry", () => {
    const cell = { task: "T-4", repeat: 1 };
    const rec = (reason: string) => ({ validity: "invalid" as const, experimentHash: EXP, completed: true, evidenceComplete: true, task: "T-4", repeat: 1, launchPolicy: LAUNCH_POLICY, invalidReasons: [reason] });
    const many = (reason: string) => Array.from({ length: MAX_INVALID_RETRIES + 1 }, (_, i) => ({ name: `attempt-00${i + 1}`, record: rec(reason) }));
    expect(decideCell(many("input-failure"), EXP, cell).kind).toBe("exhausted");
    expect(decideCell(many("launch-policy"), EXP, cell).kind).toBe("run");
  });
});

// --- 8: denials -------------------------------------------------------------------------------

describe("ISS-1486 D7: permission denials, classified by tool", () => {
  const roots = ["/w", "/t"];
  it("each class", () => {
    expect(classifyDenial({ tool_name: "WebFetch" }, roots)).toBe("expected");
    expect(classifyDenial({ tool_name: "Task" }, roots)).toBe("expected");
    for (const t of ["Read", "Glob", "Grep", "Skill", "Agent", "mcp__storybloq__storybloq_status", "Unknown"]) expect(classifyDenial({ tool_name: t }, roots), t).toBe("blocked");
    expect(classifyDenial({ tool_name: "Edit", tool_input: { file_path: "/elsewhere/x" } }, roots)).toBe("expected");
    expect(classifyDenial({ tool_name: "Edit", tool_input: { file_path: "/w/src/x.ts" } }, roots)).toBe("blocked");
    expect(classifyDenial({ tool_name: "Write", tool_input: { file_path: "/w/../w/x" } }, roots)).toBe("blocked");
    expect(classifyDenial({ tool_name: "Edit", tool_input: { file_path: "relative" } }, roots)).toBe("blocked");
    expect(classifyDenial({ tool_name: "Bash", tool_input: { command: "npm test" } }, roots)).toBe("blocked");
    expect(classifyDenial({ tool_name: "Bash", tool_input: { command: "npm test" } }, roots, true)).toBe("expected");
  });
  it("an expected refusal leaves the attempt valid; a blocked required operation, or a denied fixture test command, stops as launch-policy and is never a scored failure", async () => {
    const o = options(); const pf = preflight(); const seen: Launched[] = [];
    const ok = await runAttempt(o, pf, "T-4", 1, 1, deps(sentinelSpawn(() => ({ denials: [{ tool_name: "WebFetch", tool_use_id: "w", tool_input: { url: "https://example.invalid" } }] }), seen)));
    expect(ok).toMatchObject({ validity: "valid", launchPolicy: null });
    for (const d of [{ tool_name: "Read", tool_use_id: "r", tool_input: { file_path: "/x" } }, { tool_name: "Bash", tool_use_id: "b", tool_input: { command: "node --test" } }]) {
      const o2 = options({ tasks: ["T-4", "T-3"] }); const seen2: Launched[] = [];
      const err = await runMatrix(o2, pf, deps(sentinelSpawn(() => ({ denials: [d] }), seen2))).catch((e: unknown) => e);
      expect(err, d.tool_name).toBeInstanceOf(LaunchPolicyStopError);
      const record = recordOf(o2);
      expect(record.validity).toBe("invalid");
      expect(record.launchPolicyFailure).toBe(`denied: ${d.tool_name}`);
      expect(seen2).toHaveLength(1);
    }
  }, 60_000);
});

// --- 9, 13: isolation, inventory and the hash input --------------------------------------------

describe("ISS-1486 D4 and D8: fresh provisioning and the record's hash input", () => {
  it("9: fresh provisioning writes no plugin inventory; any inventory file, empty or not, drifts and is named", () => {
    const a = tmp("c1486-cfg-"); provisionFreshConfig(a);
    expect(existsSync(join(a, "plugins"))).toBe(false);
    const base = effectiveConfigHash(a);
    for (const [file, text] of <[string, string][]>[["installed_plugins.json", JSON.stringify({ version: 2, plugins: {} })], ["known_marketplaces.json", "{}"], ["installed_plugins.json", "{ not json"], ["installed_plugins.json", "[]"], ["known_marketplaces.json", JSON.stringify({ m: { source: { repo: "a/m" } } })], ["installed_plugins.json", JSON.stringify({ version: 2, plugins: { "p@m": [{ version: "1" }] } })]]) {
      const b = tmp("c1486-cfg-"); provisionFreshConfig(b);
      mkdirSync(join(b, "plugins")); writeFileSync(join(b, "plugins", file), text);
      const h = effectiveConfigHash(b);
      expect(h.sha256, `${file} ${text}`).not.toBe(base.sha256);
      expect(configInventoryDrift(base.inventory, h.inventory)).toContain(`plugins/${file}`);
    }
  });
  it("13: the launch policy is in the experiment hash, and a record without it never satisfies a cell", () => {
    const i = { arm: 1 as const, inputTreeHash: "t", buildManifestHash: "b", model: "m", effort: "high", timeoutMs: 1, maxBudgetUsd: 2, clientVersion: "c", isolation: "fresh" as const, configHash: "cfg", launchPolicy: LAUNCH_POLICY };
    expect(experimentHash({ ...i, launchPolicy: 1 as unknown as typeof LAUNCH_POLICY })).not.toBe(experimentHash(i));
    const cell = { task: "T-4", repeat: 1 };
    const rec = { validity: "valid" as const, experimentHash: EXP, completed: true, evidenceComplete: true, task: "T-4", repeat: 1 };
    expect(decideCell([{ name: "attempt-001", record: { ...rec, launchPolicy: LAUNCH_POLICY } }], EXP, cell).kind).toBe("satisfied");
    expect(decideCell([{ name: "attempt-001", record: rec }], EXP, cell).kind).not.toBe("satisfied");
    expect(decideCell([{ name: "attempt-001", record: { ...rec, launchPolicy: 1 } }], EXP, cell).kind).not.toBe("satisfied");
  });
});

// --- 14, 14b: the pilot and the path mapping -----------------------------------------------------

describe("ISS-1486 D9: the pilot", () => {
  const pilot = async (p: Record<string, unknown> = {}) => {
    const o = options({}, false); const pf = preflight(); const seen: Launched[] = [];
    const r = await runPilot(o, pf, deps(sentinelSpawn(() => ({ pilot: p }), seen)));
    return { o, r, seen, expDir: join(o.out, EXP.slice(0, 12)) };
  };
  it("a conforming run passes, writes pilot.json and its three evidence files, and the shared reader accepts it", async () => {
    const { r, expDir, seen } = await pilot();
    expect(r.problems).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.probes.map((p) => p.probe)).toEqual([...PILOT_PROBES]);
    expect(readPilot(expDir, { experiment: EXP, arm: 1 })).toEqual({ ok: true, id: r.id });
    for (const f of PILOT_EVIDENCE) expect(existsSync(join(expDir, f)), f).toBe(true);
    const published = readdirSync(expDir).map((f) => readFileSync(join(expDir, f), "utf-8")).join("\n");
    expect(published).not.toContain(seen[0]!.cwd);
    expect(logOf(seen[0]!).find((e) => e.kind === "user")!.content).toContain(`pilot id ${r.id}`);
    // ISS-1497: a clean pilot (its two inside targets are held by pilot.facts.json) removes its work folder.
    expect(r.retainedWorkdir).toBeUndefined();
    expect(existsSync(seen[0]!.cwd)).toBe(false);
  }, 30_000);
  // ISS-1497: the pilot archives no ledger and no diff, so a .story edit or a commit made after its start keeps the folder.
  const pilotChanging = async (change: (work: string) => void) => {
    const o = options({}, false); const pf = preflight(); const seen: Launched[] = [];
    const r = await runPilot(o, pf, deps(sentinelSpawn(() => ({ pilot: {} }), seen), { beforeSpawnCheck: (l: Launch): void => change(l.dirs.work) }));
    return { r, cwd: seen[0]!.cwd, kept: join(o.rawOut, EXP.slice(0, 12), "pilot", r.id, RETAINED_WORKDIR_FILE) };
  };
  it("ISS-1497: a pilot whose work folder gains a .story edit keeps the folder, reason dirty", async () => {
    const { r, cwd, kept } = await pilotChanging((w) => writeFileSync(join(w, ".story", "pilot-ledger-edit.md"), "not archived\n"));
    expect(r.retainedWorkdir).toEqual({ path: cwd, reason: "dirty" });
    expect(existsSync(cwd)).toBe(true);
    expect(JSON.parse(readFileSync(kept, "utf-8"))).toEqual({ path: cwd, reason: "dirty" });
  }, 30_000);
  it("ISS-1497: a pilot whose work folder gains a committed source edit keeps the folder, reason dirty", async () => {
    const { r, cwd, kept } = await pilotChanging((w) => {
      writeFileSync(join(w, "src", "http", "router.ts"), `${readFileSync(join(w, "src", "http", "router.ts"), "utf-8")}\n// committed during the pilot\n`);
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      execFileSync("git", ["add", "-A"], { cwd: w, stdio: "ignore", env });
      execFileSync("git", ["commit", "-q", "-m", "a commit during the pilot"], { cwd: w, stdio: "ignore", env });
    });
    expect(r.retainedWorkdir).toEqual({ path: cwd, reason: "dirty" });
    expect(existsSync(cwd)).toBe(true);
    expect(JSON.parse(readFileSync(kept, "utf-8"))).toEqual({ path: cwd, reason: "dirty" });
  }, 30_000);
  const failing: [string, Record<string, unknown>, string, string?][] = [
    ["a skipped probe", { skip: "edit-inside" }, "edit-inside"],
    ["a probe made by the main session", { main: "bash-inside" }, "bash-inside"],
    ["a probe without the id", { noId: "edit-outside" }, "edit-outside"],
    ["a claim with no tool call", { claim: "network" }, "network"],
    ["an outside write that succeeded", { outside: true }, "bash-outside"],
    ["a network probe that reached the listener", { reach: true }, "network"],
    ["an echo stand-in for the outside write (G3)", { echo: "bash-outside" }, "bash-outside"],
    ["an echo stand-in for the network probe (G3)", { echo: "network" }, "network"],
    ["a network probe without its printf payload (G11)", { bare: "network" }, "network"],
    ["an outside write aimed at another path (G3)", { retarget: "bash-outside" }, "bash-outside"],
    ["an outside edit aimed at another path (G3)", { retarget: "edit-outside" }, "edit-outside"],
    ["a folder at the outside write's target (G9)", { plant: { probe: "bash-outside", kind: "dir" } }, "bash-outside", "the target is not a file the runner can read (not a regular file)"],
    ["a dangling link at the outside write's target (G9)", { plant: { probe: "bash-outside", kind: "link" } }, "bash-outside", "the target is not a file the runner can read (a link)"],
    ["an unreadable file at the outside write's target (G9)", { plant: { probe: "bash-outside", kind: "unreadable" } }, "bash-outside", "the target is not a file the runner can read (read EACCES)"],
    ["a dangling link at the outside edit's target (G9)", { plant: { probe: "edit-outside", kind: "link" } }, "edit-outside", "the target is not a file the runner can read (a link)"],
  ];
  for (const [name, p, probe, detail] of failing) {
    it(`fails for ${name}`, async () => {
      const { r, expDir } = await pilot(p);
      expect(r.pass).toBe(false);
      expect(r.probes.find((v) => v.probe === probe)!.pass).toBe(false);
      if (detail !== undefined) expect(r.probes.find((v) => v.probe === probe)!.detail).toBe(detail);
      expect(readPilot(expDir, { experiment: EXP, arm: 1 }).ok).toBe(false);
    }, 30_000);
  }
  it("J1: with no nc on the client's PATH, the pilot fails because the probe command does not work outside the sandbox", async () => {
    // Every /usr/bin and /bin tool but nc, so git and the rest still resolve and only the probe's nc is missing.
    const bin = tmp("j1-path-");
    for (const dir of ["/usr/bin", "/bin"]) for (const name of readdirSync(dir)) if (name !== "nc" && !existsSync(join(bin, name))) symlinkSync(join(dir, name), join(bin, name));
    const old = process.env.PATH;
    process.env.PATH = bin;
    let out: Awaited<ReturnType<typeof pilot>>;
    try { out = await pilot(); } finally { process.env.PATH = old; }
    expect(out.r.problems).toEqual([]);
    expect(out.r.pass).toBe(false);
    expect(out.r.probes.find((p) => p.probe === "network")).toMatchObject({ pass: false, detail: "network probe command does not work outside the sandbox" });
    expect(out.r.probes.filter((p) => !p.pass).map((p) => p.probe)).toEqual(["network"]);
    expect(readPilot(out.expDir, { experiment: EXP, arm: 1 }).ok).toBe(false);
  }, 30_000);
  // K1: an nc that sends the token and then holds its connection, in the probe's group ("held") or handed to a
  // process outside it ("escaped"). The pilot must still end within a bound, nothing it started stays alive in
  // its group, and its listener is closed.
  const holdingNc = (mode: "held" | "escaped"): { bin: string; pids: string } => {
    const dir = tmp(`k1-${mode}-`);
    const bin = join(dir, "bin"); mkdirSync(bin);
    const pids = join(dir, "pids");
    const holder = join(dir, "holder.cjs");
    writeFileSync(holder, [
      'const net = require("node:net"); const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");`,
      "const s = net.connect(Number(process.argv[3]), process.argv[2], () => { if (process.argv[4]) s.write(process.argv[4]); });",
      's.on("error", () => {});',
      'if (!process.argv[4]) process.stdin.on("data", (d) => s.write(d));',
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const escaper = join(dir, "escaper.cjs");
    writeFileSync(escaper, [
      'const { spawn } = require("node:child_process");',
      'let token = ""; process.stdin.on("data", (d) => { token += d; });',
      `process.stdin.on("end", () => { spawn(process.execPath, [${JSON.stringify(holder)}, process.argv[2], process.argv[3], token], { detached: true, stdio: "ignore" }).unref(); process.exit(0); });`,
    ].join("\n"));
    writeFileSync(join(bin, "nc"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mode === "held" ? holder : escaper)} "$@"\n`, { mode: 0o755 });
    return { bin, pids };
  };
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const mode of ["held", "escaped"] as const) {
    it(`K1: an nc that holds its connection open (${mode}) cannot hold the pilot: it ends within the bound, nothing of the probe's group survives, and the listener is closed`, async () => {
      const { bin, pids } = holdingNc(mode);
      const old = process.env.PATH;
      process.env.PATH = `${bin}:${old ?? "/usr/bin:/bin"}`;
      const t0 = Date.now();
      let out: Awaited<ReturnType<typeof pilot>> | "timeout";
      try { out = await Promise.race([pilot(), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]); } finally { process.env.PATH = old; }
      const held = existsSync(pids) ? readFileSync(pids, "utf-8").split("\n").filter(Boolean).map(Number) : [];
      try {
        expect(out).not.toBe("timeout");
        expect(Date.now() - t0).toBeLessThan(12_000);
        const r = out as Exclude<typeof out, "timeout">;
        expect(r.r.problems).toEqual([]);
        // The stand-in really connected and delivered the token, so the outside check passed.
        expect(held.length).toBe(1);
        expect(r.r.pass).toBe(true);
        if (mode === "held") expect(alive(held[0]!), "the held nc is in the probe's group and must be gone").toBe(false);
        const port = (JSON.parse(readFileSync(join(r.expDir, "pilot.facts.json"), "utf-8")) as { facts: { port: number } }).facts.port;
        const refused = await new Promise<boolean>((done) => { const s = netConnect(port, "127.0.0.1", () => { s.destroy(); done(false); }); s.on("error", () => done(true)); });
        expect(refused, "the listener must be closed").toBe(true);
      } finally {
        for (const pid of held) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      }
    }, 30_000);
  }
  it("J3: a distinctive LANG and a relative PATH entry reach no published file of the pilot or an attempt; the stored readback still compares equal, and a changed echo is still caught", async () => {
    const LANG_VALUE = "j3-lang-Qx7.UTF-8";
    const REL = "j3rel-Zw4/bin";
    const old = { LANG: process.env.LANG, PATH: process.env.PATH };
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
    const stored = (dir: string, prefix: string): string[] => {
      const rb = JSON.parse(readFileSync(join(dir, `${prefix}readback.json`), "utf-8")) as { steps: ReadbackStep[] };
      const ln = JSON.parse(readFileSync(join(dir, `${prefix}launch.json`), "utf-8")) as { expected: ReadbackExpected };
      return readbackProblems(rb.steps, ln.expected);
    };
    process.env.LANG = LANG_VALUE;
    process.env.PATH = `${REL}:${old.PATH ?? "/usr/bin:/bin"}`;
    try {
      const o = options({ tasks: ["T-4"] }, false); const pf = preflight(); const seen: Launched[] = [];
      const p = await runPilot(o, pf, deps(sentinelSpawn(() => ({ pilot: {} }), seen)));
      expect(p.problems).toEqual([]);
      expect(p.pass).toBe(true);
      // The values did reach the launch: the server column carries them, so their absence below is the mask's work.
      expect(seen[0]!.env.LANG).toBe(LANG_VALUE);
      expect(seen[0]!.env.PATH!.startsWith(`${REL}:`)).toBe(true);
      const expDir = join(o.out, EXP.slice(0, 12));
      await runMatrix(o, pf, deps(sentinelSpawn(() => ({}), seen)));
      const attempt = walk(o.out).find((f) => f.endsWith("/launch.json") && !f.endsWith("pilot.launch.json"))!;
      expect(attempt).toBeDefined();
      for (const f of walk(o.out)) {
        const text = readFileSync(f, "utf-8");
        expect(text, f).not.toContain("j3-lang-Qx7");
        expect(text, f).not.toContain("j3rel-Zw4");
      }
      // Every env value in the evidence is an opaque form, and the stored exchange still compares equal.
      for (const f of [join(expDir, "pilot.launch.json"), attempt]) {
        const env = (JSON.parse(readFileSync(f, "utf-8")) as { expected: ReadbackExpected }).expected.mcpLaunch.env!;
        expect(Object.values(env).every((v) => /^env-value:[0-9a-f]{24}$/.test(v)), f).toBe(true);
      }
      expect(stored(expDir, "pilot.")).toEqual([]);
      expect(stored(join(attempt, ".."), "")).toEqual([]);
      // A client that echoes another LANG: the stored, masked evidence still names the mismatch.
      const o2 = options({}, false);
      const bad = await runPilot(o2, pf, deps(sentinelSpawn(() => ({ pilot: {}, mutate: { sub: "mcp_status", path: "mcpServers.0.config.env.LANG", value: "j3-other-Kp2.UTF-8" } }), [])));
      expect(bad.pass).toBe(false);
      const badDir = join(o2.out, EXP.slice(0, 12));
      expect(stored(badDir, "pilot.")).toContain("mcp_status.mcpServers.config");
      for (const f of walk(o2.out)) expect(readFileSync(f, "utf-8"), f).not.toMatch(/j3-other-Kp2|j3-lang-Qx7|j3rel-Zw4/);
    } finally {
      if (old.LANG === undefined) delete process.env.LANG; else process.env.LANG = old.LANG;
      process.env.PATH = old.PATH;
    }
  }, 60_000);
  it("J4: the stored pilot fixture launches through the shared launcher under the sandbox, with exactly the permitted inventory and no withheld name", () => {
    const launch = JSON.parse(readFileSync(join(PILOT_TEMPLATE, "pilot.launch.json"), "utf-8")) as { argv: string[]; mcpTools: string[]; expected: ReadbackExpected };
    const readback = JSON.parse(readFileSync(join(PILOT_TEMPLATE, "pilot.readback.json"), "utf-8")) as { steps: ReadbackStep[] };
    const { command, args, env } = launch.expected.mcpLaunch;
    // The launcher (a mapped absolute path), the server column's names, then codex sandbox around node and the eval bundle.
    expect(command).toMatch(/^<ABS:\d+>$/);
    expect(args[0]).toMatch(/^<ABS:\d+>$/);
    const names = args.slice(1, args.indexOf("--"));
    expect(names).toEqual([...CONTINUITY_SERVER_COLUMN].filter((k) => names.includes(k)).sort());
    expect(names).toEqual(Object.keys(env!).sort());
    const rest = args.slice(args.indexOf("--") + 1);
    expect(rest[1]).toBe("sandbox");
    expect(rest).toContain("sandbox_workspace_write.network_access=false");
    expect(rest.slice(-3)).toEqual(["<PKG>/.eval-dist/eval-mcp.js", "--entry", "mcp"]);
    expect(JSON.stringify(launch)).not.toContain("dist/mcp.js\"");
    const permitted = continuityTools();
    const withheld = Object.keys(withheldTools());
    expect([...launch.mcpTools].sort()).toEqual([...permitted].sort());
    expect([...launch.expected.mcpTools].sort()).toEqual([...permitted].sort());
    const served = readback.steps.find((s) => s.subtype === "mcp_status")!.response as { mcpServers: { tools: { name: string }[] }[] };
    expect(served.mcpServers[0]!.tools.map((t) => t.name).sort()).toEqual([...permitted].sort());
    for (const text of [JSON.stringify(launch), JSON.stringify(readback), readFileSync(join(PILOT_TEMPLATE, "pilot.transcript.jsonl"), "utf-8")]) {
      for (const name of withheld) expect(text, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(readPilot(PILOT_TEMPLATE, { experiment: JSON.parse(readFileSync(join(PILOT_TEMPLATE, "pilot.json"), "utf-8")).experimentHash, arm: 1 })).toEqual({ ok: true, id: PILOT_TEMPLATE_ID });
  });
  it("G7: a failed pilot then a passing one for the same experiment: each run has its own raw folder, and the second passes on its own transcript", async () => {
    const o = options({}, false); const pf = preflight(); const seen: Launched[] = [];
    const first = await runPilot(o, pf, deps(sentinelSpawn(() => ({ pilot: { outside: true } }), seen)));
    expect(first.pass).toBe(false);
    const second = await runPilot(o, pf, deps(sentinelSpawn(() => ({ pilot: {} }), seen)));
    expect(second.problems).toEqual([]);
    expect(second.pass).toBe(true);
    expect(readPilot(join(o.out, EXP.slice(0, 12)), { experiment: EXP, arm: 1 })).toEqual({ ok: true, id: second.id });
    const raw = join(o.rawOut, EXP.slice(0, 12), "pilot");
    expect(readdirSync(raw).sort()).toEqual([first.id, second.id].sort());
    for (const r of [first, second]) {
      const t = readFileSync(join(raw, r.id, "transcript.jsonl"), "utf-8");
      expect(t).toContain(r.id);
      expect(t).not.toContain(r === first ? second.id : first.id);
    }
  }, 60_000);
  // G8: the attempt's checks before and after the run apply to the pilot, and the pilot records the hashes it saw.
  const g8 = async (dist: (n: number) => Record<string, string>, plant = false) => {
    const o = options({}, false); const pf = preflight(); const seen: Launched[] = [];
    let calls = 0;
    const spawn = sentinelSpawn(() => ({ pilot: {} }), seen);
    const spawnFn: SpawnFn = (cmd, args, opts) => {
      if (plant) {
        const c = (opts.env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR!;
        mkdirSync(join(c, "plugins"), { recursive: true });
        writeFileSync(join(c, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
      }
      return spawn(cmd, args, opts);
    };
    const r = await runPilot(o, pf, { ...deps(spawnFn), distHashes: () => dist(calls++) });
    const expDir = join(o.out, EXP.slice(0, 12));
    return { r, seen, expDir, facts: JSON.parse(readFileSync(join(expDir, "pilot.facts.json"), "utf-8")) as { checks: Record<string, unknown> } };
  };
  const moved = { ...FAKE_DIST, "dist/mcp.js": "9".repeat(64) };
  it("G8: dist changed before the pilot fails it, spawns nothing, and records the hashes", async () => {
    const { r, seen, expDir, facts } = await g8(() => moved);
    expect(r.pass).toBe(false);
    expect(seen).toHaveLength(0);
    expect(r.problems).toContain("dist/ changed since preflight before the pilot (dist/mcp.js)");
    expect(facts.checks.distBefore).toEqual(moved);
    expect(readPilot(expDir, { experiment: EXP, arm: 1 }).ok).toBe(false);
  }, 30_000);
  it("G8: dist changed during the pilot fails it, and the hashes after the run are recorded", async () => {
    const { r, seen, expDir, facts } = await g8((n) => (n === 0 ? { ...FAKE_DIST } : moved));
    expect(seen).toHaveLength(1);
    expect(r.pass).toBe(false);
    expect(r.problems).toContain("dist/ changed during the pilot (dist/mcp.js)");
    expect(facts.checks.distBefore).toEqual(FAKE_DIST);
    expect(facts.checks.distAfter).toEqual(moved);
    expect(readPilot(expDir, { experiment: EXP, arm: 1 }).ok).toBe(false);
  }, 30_000);
  it("G8: a plugin inventory the client created during the pilot fails it and is named", async () => {
    const { r, seen, expDir, facts } = await g8(() => ({ ...FAKE_DIST }), true);
    expect(seen).toHaveLength(1);
    expect(r.pass).toBe(false);
    expect(r.problems).toContain("config changed during the pilot: plugins/installed_plugins.json");
    expect(facts.checks.configBefore).not.toEqual(facts.checks.configAfter);
    expect(readPilot(expDir, { experiment: EXP, arm: 1 }).ok).toBe(false);
  }, 30_000);
  it("fails for a changed canary", async () => {
    const { r } = await pilot({ canary: true });
    expect(r.pass).toBe(false);
    expect(r.problems).toContain("the canary changed");
  }, 30_000);
  it("fails for a dead listener: a refusal proves nothing when the runner's own control connection failed", () => {
    const facts = { id: "pX", paths: { "bash-inside": "/w/a", "bash-outside": "/o/a", "edit-outside": "/o/b", "edit-inside": "/w/b" }, contents: { "bash-inside": null, "bash-outside": null, "edit-outside": null, "edit-inside": null }, canaryBefore: "c", canaryAfter: "c", port: 4000, listener: { started: true, received: "", controlOk: false, outsideOk: true } } as PilotFacts;
    const events = [
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "a", name: "Agent", input: {} }] } },
      { type: "assistant", parent_tool_use_id: "a", message: { content: [{ type: "tool_use", id: "n", name: "Bash", input: { command: "printf 'pX' | nc 127.0.0.1 4000 # pX-network" } }] } },
      { type: "user", parent_tool_use_id: "a", message: { content: [{ type: "tool_result", tool_use_id: "n", is_error: true }] } },
    ] as unknown as StreamEvent[];
    expect(judgePilot(events, facts).probes.find((p) => p.probe === "network")).toMatchObject({ pass: false, detail: expect.stringMatching(/control connection failed/) });
    expect(judgePilot(events, { ...facts, listener: { started: false, received: "", controlOk: false, outsideOk: false } }).problems).toContain("the loopback listener could not start");
  });
  it("G3: an exact probe whose result is not a refusal fails; the same call refused passes", () => {
    const facts = { id: "pX", paths: { "bash-inside": "/w/a", "bash-outside": "/o/a", "edit-outside": "/o/b", "edit-inside": "/w/b" }, contents: { "bash-inside": null, "bash-outside": null, "edit-outside": null, "edit-inside": null }, canaryBefore: "c", canaryAfter: "c", port: 4000, listener: { started: true, received: "", controlOk: true, outsideOk: true } } as PilotFacts;
    const run = (isError: boolean) => [
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "a", name: "Agent", input: {} }] } },
      { type: "assistant", parent_tool_use_id: "a", message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "printf 'pX bash-outside\\n' > /o/a # pX-bash-outside" } }] } },
      { type: "user", parent_tool_use_id: "a", message: { content: [{ type: "tool_result", tool_use_id: "b", is_error: isError }] } },
      { type: "assistant", parent_tool_use_id: "a", message: { content: [{ type: "tool_use", id: "n", name: "Bash", input: { command: "printf 'pX' | nc 127.0.0.1 4000 # pX-network" } }] } },
      { type: "user", parent_tool_use_id: "a", message: { content: [{ type: "tool_result", tool_use_id: "n", is_error: isError, content: isError ? netText : "" }] } },
    ] as unknown as StreamEvent[];
    let netText = "nc: connectx to 127.0.0.1 port 4000 (tcp) failed: Operation not permitted";
    for (const probe of ["bash-outside", "network"]) {
      expect(judgePilot(run(false), facts).probes.find((p) => p.probe === probe), probe).toMatchObject({ pass: false, detail: "the call's result is not a refusal" });
      expect(judgePilot(run(true), facts).probes.find((p) => p.probe === probe)!.pass, probe).toBe(true);
    }
    // J1: an error that is not the sandbox's refusal (nc missing, a port nobody listens on) proves nothing.
    for (const text of ["/bin/sh: nc: command not found", "nc: connectx to 127.0.0.1 port 4000 (tcp) failed: Connection refused", ""]) {
      netText = text;
      expect(judgePilot(run(true), facts).probes.find((p) => p.probe === "network"), text).toMatchObject({ pass: false, detail: "the call's result is not a sandbox refusal" });
    }
    // J1: and the refusal counts only when the same command worked outside the sandbox.
    netText = "nc: connectx to 127.0.0.1 port 4000 (tcp) failed: Operation not permitted";
    expect(judgePilot(run(true), { ...facts, listener: { ...facts.listener, outsideOk: false } }).probes.find((p) => p.probe === "network")).toMatchObject({ pass: false, detail: "network probe command does not work outside the sandbox" });
  });
  const editPilot = (expDir: string, over: Record<string, unknown>): void => {
    const p = JSON.parse(readFileSync(join(expDir, PILOT_FILE), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(expDir, PILOT_FILE), JSON.stringify({ ...p, ...over }));
  };
  it("G4: a failed pilot whose pilot.json alone is edited to pass is refused: the verdict is recomputed from the evidence", async () => {
    const { r, expDir } = await pilot({ outside: true });
    expect(r.pass).toBe(false);
    editPilot(expDir, { pass: true, probes: PILOT_PROBES.map((probe) => ({ probe, pass: true, toolUseId: null, detail: "t" })), problems: [] });
    expect(readPilot(expDir, { experiment: EXP, arm: 1 })).toEqual({ ok: false, reason: `${PILOT_FILE} disagrees with its evidence` });
  }, 30_000);
  it("G4: a pilot relabelled in pilot.json alone, to another arm or another experiment, is refused", () => {
    const relabel = (over: Record<string, unknown>, want: { experiment: string; arm: number }) => {
      const d = tmp("c1486-relabel-"); writePilot(d); editPilot(d, over); return readPilot(d, want);
    };
    expect(relabel({ arm: 2 }, { experiment: EXP, arm: 2 })).toEqual({ ok: false, reason: "the pilot evidence was recorded for another experiment, arm or run" });
    expect(relabel({ experimentHash: "f".repeat(64) }, { experiment: "f".repeat(64), arm: 1 })).toEqual({ ok: false, reason: "the pilot evidence was recorded for another experiment, arm or run" });
    expect(relabel({ id: "p0000000000000000" }, { experiment: EXP, arm: 1 })).toEqual({ ok: false, reason: "the pilot evidence was recorded for another experiment, arm or run" });
  });
  it("G4: pilot.json's launch policy, policy hash and MCP hash must be the launch evidence's", () => {
    for (const over of [{ launchPolicy: 1 }, { launchPolicy: undefined }, { policySha256: "0".repeat(64) }, { mcpSha256: "0".repeat(64) }]) {
      const d = tmp("c1486-bind-"); writePilot(d); editPilot(d, over);
      expect(readPilot(d, { experiment: EXP, arm: 1 }).ok, JSON.stringify(over)).toBe(false);
    }
    const d = tmp("c1486-bind-"); writePilot(d);
    expect(readPilot(d, { experiment: EXP, arm: 1 }).ok).toBe(true);
  });
  it("G5: a pilot.json that is null or not an object, or evidence that cannot be read, is a failed check, never a throw", () => {
    for (const text of ["null", "[]", "7"]) {
      const d = tmp("c1486-null-"); writePilot(d); writeFileSync(join(d, PILOT_FILE), text);
      expect(readPilot(d, { experiment: EXP, arm: 1 }), text).toEqual({ ok: false, reason: `${PILOT_FILE} is malformed` });
    }
    const d = tmp("c1486-eisdir-"); writePilot(d); rmSync(join(d, "pilot.transcript.jsonl")); mkdirSync(join(d, "pilot.transcript.jsonl"));
    expect(readPilot(d, { experiment: EXP, arm: 1 })).toEqual({ ok: false, reason: "the pilot could not be read (EISDIR)" });
    const e = tmp("c1486-eacces-"); writePilot(e); chmodSync(join(e, "pilot.readback.json"), 0);
    expect(readPilot(e, { experiment: EXP, arm: 1 })).toEqual({ ok: false, reason: "the pilot could not be read (EACCES)" });
    const f = tmp("c1486-eacces-"); writePilot(f); chmodSync(join(f, PILOT_FILE), 0);
    expect(readPilot(f, { experiment: EXP, arm: 1 })).toEqual({ ok: false, reason: "the pilot could not be read (EACCES)" });
  });
  const broken: [string, (expDir: string) => void][] = [
    ["missing", () => {}],
    ["failed", (d) => writePilot(d, { pass: false, probes: PILOT_PROBES.map((probe) => ({ probe, pass: probe !== "network", toolUseId: null, detail: "t" })) })],
    ["malformed", (d) => { writePilot(d); writeFileSync(join(d, PILOT_FILE), "{\"experimentHash\":1}"); }],
    ["tampered", (d) => { writePilot(d); writeFileSync(join(d, "pilot.readback.json"), "edited\n"); }],
    ["for another experiment", (d) => writePilot(d, { experimentHash: "f".repeat(64) })],
  ];
  for (const [name, make] of broken) {
    it(`enforcement: a ${name} pilot gives zero ordinary spawns, a launch-policy stop, and the shared reader refuses it`, async () => {
      const o = options({}, false); const pf = preflight(); let spawned = 0;
      const expDir = join(o.out, EXP.slice(0, 12)); make(expDir);
      expect(readPilot(expDir, { experiment: EXP, arm: 1 }).ok).toBe(false);
      const spawnFn: SpawnFn = () => { spawned++; throw new Error("spawned"); };
      await expect(runMatrix(o, pf, deps(spawnFn))).rejects.toBeInstanceOf(LaunchPolicyStopError);
      await expect(runAttempt(o, pf, "T-4", 1, 1, deps(spawnFn))).rejects.toBeInstanceOf(LaunchPolicyStopError);
      expect(spawned).toBe(0);
      expect(existsSync(join(expDir, "T-4"))).toBe(false);
    });
  }
  it("14b: one equality-preserving mapping: roots become tokens with their suffix, other paths stay distinct, a mismatch survives", () => {
    const map = pathMapping({ work: "/r/work", tmp: "/r/tmp", config: "/r/cfg", pkg: "/p/storybloq", home: "/h" });
    expect(map('{"cwd":"/r/work/src/a.ts","tmp":"/r/tmp"}')).toBe('{"cwd":"<WORK>/src/a.ts","tmp":"<TMP>"}');
    expect(map("/r/workshop/x")).toBe("<ABS:1>");
    const m2 = pathMapping({ work: "/r/work", tmp: "/r/tmp", config: "/r/cfg", pkg: "/p/storybloq", home: "/h" });
    const out = m2("expected /x/mcp.js observed /y/mcp.js again /x/mcp.js");
    expect(out).toBe("expected <ABS:1> observed <ABS:2> again <ABS:1>");
    expect(m2("/p/storybloq/dist/mcp.js")).toBe("<PKG>/dist/mcp.js");
  });
});

// --- 10, 15: the real server ----------------------------------------------------------------

describe("ISS-1486 D2 and D3 against the built server", () => {
  it("15 and 10 (G1, G2): the pinned list is what dist/mcp.js advertises less the onboarding withheld map; the server, started through the launcher, registers exactly it and works on the attempt's project whatever the runner's own overrides say", async () => {
    expect(existsSync(join(PKG, "dist", "mcp.js")), "build this checkout first").toBe(true);
    expect(existsSync(EVAL_MCP_BUNDLE), "build the evaluation bundle first (node scripts/build-eval.mjs)").toBe(true);
    // G1 pin: the advertised set minus the withheld map equals the file, and every withheld name is one the server has.
    const plain = tmp("c1486-plain-"); cpSync(join(FIXTURE, "core"), plain, { recursive: true });
    const direct = new Client({ name: "iss1486-direct", version: "0" });
    await direct.connect(new StdioClientTransport({ command: process.execPath, args: [join(PKG, "dist", "mcp.js")], cwd: plain, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp("c1486-dh-"), STORYBLOQ_PROJECT_ROOT: plain }, stderr: "ignore" }));
    let advertised: string[];
    try { advertised = (await direct.listTools()).tools.map((x) => x.name); } finally { await direct.close(); }
    const withheld = Object.keys(withheldTools());
    expect(advertised.filter((n) => !withheld.includes(n)).sort()).toEqual([...TOOLS].sort());
    expect(withheld.filter((n) => !advertised.includes(n))).toEqual([]);
    const work = tmp("c1486-work-"); cpSync(join(FIXTURE, "core"), work, { recursive: true });
    const decoy = tmp("c1486-decoy-"); cpSync(join(FIXTURE, "core"), decoy, { recursive: true });
    const cfg = JSON.parse(readFileSync(join(decoy, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(decoy, ".story", "config.json"), JSON.stringify({ ...cfg, project: "decoy-project" }));
    const dirs = { work, tmp: tmp("c1486-t-"), home: tmp("c1486-h-"), config: tmp("c1486-c-"), launch: tmp("c1486-l-") };
    const source = { PATH: process.env.PATH, STORYBLOQ_PROJECT_ROOT: decoy, CLAUDESTORY_PROJECT_ROOT: decoy };
    const launch = prepareLaunch(dirs, { model: "m", effort: "high", maxBudgetUsd: 1, tools: TOOLS, codexBin: CODEX, bundleSha256: BUNDLE_SHA, codex: CODEX_FP }, source);
    expect(launch.env.STORYBLOQ_PROJECT_ROOT).toBe(work);
    expect(launch.env.CLAUDESTORY_PROJECT_ROOT).toBeUndefined();
    const entry = (JSON.parse(readFileSync(launch.expected.mcpFile, "utf-8")) as { mcpServers: { storybloq: { command: string; args: string[]; env: Record<string, string> } } }).mcpServers.storybloq;
    // The client starts the server with its own environment plus the entry's; the server inherits nothing else.
    const env = { ...launch.env, ...entry.env } as Record<string, string>;
    const t = new StdioClientTransport({ command: entry.command, args: entry.args, cwd: work, env, stderr: "ignore" });
    const c = new Client({ name: "iss1486", version: "0" });
    await c.connect(t);
    try {
      const names = (await c.listTools()).tools.map((x) => x.name).sort();
      expect(names).toEqual([...TOOLS].sort());
      const status = JSON.stringify(await c.callTool({ name: "storybloq_status", arguments: {} }));
      expect(status).toContain("continuity-fixture");
      expect(status).not.toContain("decoy-project");
    } finally {
      await c.close();
    }
    expect(launchEnv(source, dirs)).toEqual(launch.env);
  }, 60_000);
});

// --- G1, G2: the withheld tools and the server's launch ------------------------------------------

describe("ISS-1486 G1 and G2: the server runs through the shared launcher with only the permitted tools", () => {
  it("G1: the withheld map is the onboarding inventory's own, the pinned list names none of it, and a list naming a withheld tool is refused before any launch", () => {
    const onboarding = (JSON.parse(readFileSync(ONBOARDING_TOOLS_FILE, "utf-8")) as { withheld: Record<string, string> }).withheld;
    expect(withheldTools()).toEqual(onboarding);
    expect(TOOLS.filter((t) => Object.hasOwn(onboarding, t))).toEqual([]);
    for (const name of ["storybloq_node_init", "storybloq_bus_send", "storybloq_register_subprocess"]) {
      const file = join(tmp("c1486-tools-"), "tools.json");
      writeFileSync(file, JSON.stringify({ tools: [...TOOLS, name] }));
      expect(() => continuityTools(file)).toThrow(`permits ${name} (${onboarding[name]!}), which the onboarding inventory withholds`);
    }
  });
  it("G1: with the fixture's config naming an outside canary project, node_init (also with force) cannot reach it through the launched server; the same call on dist/mcp.js alone does", async () => {
    const canaryFiles = (dir: string): Record<string, string> => Object.fromEntries((readdirSync(dir, { recursive: true }) as string[]).sort().map((f) => [f, existsSync(join(dir, f)) && !statSync(join(dir, f)).isDirectory() ? sha256(readFileSync(join(dir, f))) : "dir"]));
    const setUp = (): { work: string; canary: string } => {
      const work = tmp("c1486-orch-"); cpSync(join(FIXTURE, "core"), work, { recursive: true });
      const canary = tmp("c1486-canary-"); writeFileSync(join(canary, "keep.txt"), "canary\n");
      const cfg = JSON.parse(readFileSync(join(work, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
      writeFileSync(join(work, ".story", "config.json"), JSON.stringify({ ...cfg, type: "orchestrator", nodes: { canary: { path: canary } } }));
      return { work, canary };
    };
    // Control: the unrestricted server reaches the canary (the hazard is real).
    const ctl = setUp();
    const open = new Client({ name: "iss1486-open", version: "0" });
    await open.connect(new StdioClientTransport({ command: process.execPath, args: [join(PKG, "dist", "mcp.js")], cwd: ctl.work, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp("c1486-oh-"), STORYBLOQ_PROJECT_ROOT: ctl.work }, stderr: "ignore" }));
    try { await open.callTool({ name: "storybloq_node_init", arguments: { node: "canary" } }); } finally { await open.close(); }
    expect(existsSync(join(ctl.canary, ".story"))).toBe(true);
    // The launched server: the tool is not registered, so neither call reaches the canary.
    const { work, canary } = setUp();
    const before = canaryFiles(canary);
    const dirs = { work, tmp: tmp("c1486-t-"), home: tmp("c1486-h-"), config: tmp("c1486-c-"), launch: tmp("c1486-l-") };
    const launch = prepareLaunch(dirs, { model: "m", effort: "high", maxBudgetUsd: 1, tools: TOOLS, codexBin: CODEX, bundleSha256: BUNDLE_SHA, codex: CODEX_FP }, { PATH: process.env.PATH });
    const entry = (JSON.parse(readFileSync(launch.expected.mcpFile, "utf-8")) as { mcpServers: { storybloq: { command: string; args: string[]; env: Record<string, string> } } }).mcpServers.storybloq;
    const c = new Client({ name: "iss1486-launched", version: "0" });
    await c.connect(new StdioClientTransport({ command: entry.command, args: entry.args, cwd: work, env: { ...launch.env, ...entry.env } as Record<string, string>, stderr: "ignore" }));
    try {
      expect((await c.listTools()).tools.map((x) => x.name)).not.toContain("storybloq_node_init");
      for (const args of [{ node: "canary" }, { node: "canary", force: true }]) {
        const r = await c.callTool({ name: "storybloq_node_init", arguments: args }).then((v) => v as { isError?: boolean }, () => ({ isError: true }));
        expect(r.isError, JSON.stringify(args)).toBe(true);
      }
    } finally {
      await c.close();
    }
    expect(canaryFiles(canary)).toEqual(before);
  }, 60_000);
  it("G2: a pilot through the launcher: the client holds the OAuth token, the server's wrapper sees only the server column; the server registers only the permitted names and the readback holds", async () => {
    const names = join(tmp("c1486-names-"), "names.jsonl");
    const o = options({}, false); const pf = preflight({ codexBin: codexStandIn(names) }); const seen: Launched[] = [];
    const had = Object.hasOwn(process.env, "CLAUDE_CODE_OAUTH_TOKEN"); const old = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "placeholder-not-a-token-1486";
    let r: Awaited<ReturnType<typeof runPilot>>;
    try { r = await runPilot(o, pf, deps(sentinelSpawn(() => ({ pilot: {}, realServer: true }), seen))); } finally { if (had) process.env.CLAUDE_CODE_OAUTH_TOKEN = old; else delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
    const server = logOf(seen[0]!).find((e) => e.kind === "server") as { tools: string[] | null; stderr: string } | undefined;
    expect(server?.tools, server?.stderr).not.toBeNull();
    // The readback compares the server's real registered set with the list; it is checked first, so a server that
    // registers more fails here, by the runner's own check.
    expect(r.problems).toEqual([]);
    expect(r.pass).toBe(true);
    expect([...server!.tools!].sort()).toEqual([...TOOLS].sort());
    // Names only, never values: the client has the token; the wrapper (and so the server it starts) has the column alone.
    expect((logOf(seen[0]!).find((e) => e.kind === "argv") as unknown as { env: string[] }).env).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    const launches = readFileSync(names, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(launches).toHaveLength(1);
    // macOS adds __CF_USER_TEXT_ENCODING to every new process; it is the one name outside the column.
    expect(launches[0]!.filter((n) => n !== "__CF_USER_TEXT_ENCODING")).toEqual([...CONTINUITY_SERVER_COLUMN].filter((n) => n !== "LANG" || process.env.LANG !== undefined).sort());
  }, 60_000);
  it("J2: the manifest names the codex by bytes and version; a changed codex is a new experiment, so the earlier pilot does not verify for it, and a launch or pilot under a codex changed after preflight is refused before the spawn", async () => {
    const bin = codexStandIn();
    const pf = preflight({ codexBin: bin });
    const before = codexFingerprint(bin);
    expect({ codexSha256: pf.build.codexSha256, codexVersion: pf.build.codexVersion }).toEqual(before);
    expect(before.codexVersion).toBe("codex-cli 0.0.0-stand-in");
    const hashInput = (m: Preflight["build"]) => ({ arm: 1 as const, inputTreeHash: "t", buildManifestHash: buildManifestHash(m), model: "m", effort: "high", timeoutMs: 1, maxBudgetUsd: 1, clientVersion: "c", isolation: "fresh" as const, configHash: "cfg", launchPolicy: LAUNCH_POLICY });
    const expA = experimentHash(hashInput(pf.build));
    const dir = join(tmp("c1486-j2-"), "exp");
    writeVerifiedPilot(dir, expA, 1);
    expect(readPilot(dir, { experiment: expA, arm: 1 }).ok).toBe(true);
    // The same path, other bytes: a new build, a new experiment, and the earlier pilot is not its pilot.
    chmodSync(bin, 0o755); writeFileSync(bin, `${readFileSync(bin, "utf-8")}// another codex\n`);
    const after = codexFingerprint(bin);
    expect(after.codexSha256).not.toBe(before.codexSha256);
    const expB = experimentHash(hashInput({ ...pf.build, ...after }));
    expect(expB).not.toBe(expA);
    expect(readPilot(dir, { experiment: expB, arm: 1 }).ok).toBe(false);
    // A launch prepared under the recorded fingerprint is refused before the spawn.
    const l = prepareLaunch({ work: tmp("c1486-w-"), tmp: tmp("c1486-t-"), home: tmp("c1486-h-"), config: tmp("c1486-c-"), launch: tmp("c1486-l-") }, { model: "m", effort: "high", maxBudgetUsd: 1, tools: TOOLS, codexBin: bin, bundleSha256: BUNDLE_SHA, codex: before }, { PATH: "/usr/bin" });
    expect(launchProblems(l)).toEqual([`codex ${bin} is not the executable preflight recorded; rerun preflight`]);
    // Same bytes as recorded, another version: refused by version.
    expect(codexProblems(bin, { codexSha256: after.codexSha256, codexVersion: "codex-cli 9.9.9" })).toEqual([`codex ${bin} reports codex-cli 0.0.0-stand-in, not codex-cli 9.9.9 as preflight recorded; rerun preflight`]);
    // End to end: the pilot under the old preflight spawns nothing.
    const o = options({}, false); const seen: Launched[] = [];
    const r = await runPilot(o, pf, deps(sentinelSpawn(() => ({ pilot: {} }), seen)));
    expect(seen).toHaveLength(0);
    expect(r.pass).toBe(false);
    expect(r.problems[0]).toBe(`launch: codex ${bin} is not the executable preflight recorded; rerun preflight`);
  }, 30_000);
  it("G2: a launcher with a changed mode or changed bytes, a tools file changed, or a bundle missing or not the recorded one, is refused before the spawn", async () => {
    const fresh = () => prepareLaunch({ work: tmp("c1486-w-"), tmp: tmp("c1486-t-"), home: tmp("c1486-h-"), config: tmp("c1486-c-"), launch: tmp("c1486-l-") }, { model: "m", effort: "high", maxBudgetUsd: 1, tools: TOOLS, codexBin: CODEX, bundleSha256: BUNDLE_SHA, codex: CODEX_FP }, { PATH: "/usr/bin" });
    expect(launchProblems(fresh())).toEqual([]);
    const a = fresh(); chmodSync(a.server.launcher, 0o700);
    expect(launchProblems(a)).toEqual([`${a.server.launcher} has mode 700, not 500`]);
    const b = fresh(); chmodSync(b.server.launcher, 0o700); writeFileSync(b.server.launcher, "\necho changed\n", { flag: "a" }); chmodSync(b.server.launcher, 0o500);
    expect(launchProblems(b)).toEqual([`${b.server.launcher} is not the recorded bytes`]);
    const c = fresh(); chmodSync(c.server.toolsFile, 0o600); writeFileSync(c.server.toolsFile, JSON.stringify({ degraded: ["storybloq_node_init"], full: ["storybloq_node_init"] })); chmodSync(c.server.toolsFile, 0o400);
    expect(launchProblems(c)).toEqual([`${c.server.toolsFile} is not the recorded bytes`]);
    const d = prepareLaunch({ work: tmp("c1486-w-"), tmp: tmp("c1486-t-"), home: tmp("c1486-h-"), config: tmp("c1486-c-"), launch: tmp("c1486-l-") }, { model: "m", effort: "high", maxBudgetUsd: 1, tools: TOOLS, codexBin: CODEX, bundleSha256: "0".repeat(64), codex: CODEX_FP }, { PATH: "/usr/bin" });
    expect(launchProblems(d)).toEqual(["the evaluation bundle .eval-dist/eval-mcp.js is not the one preflight recorded; rerun preflight"]);
    expect(bundleProblems(join(tmp("c1486-nb-"), "eval-mcp.js"), BUNDLE_SHA)).toEqual(["the evaluation bundle .eval-dist/eval-mcp.js is missing; build it with node scripts/build-eval.mjs and rerun preflight"]);
    // End to end: a launcher changed after it was written stops the pilot before anything is spawned.
    const o = options({}, false); const pf = preflight(); const seen: Launched[] = [];
    const r = await runPilot(o, pf, deps(sentinelSpawn(() => ({ pilot: {} }), seen), { beforeSpawnCheck: (l) => chmodSync(l.server.launcher, 0o700) }));
    expect(seen).toHaveLength(0);
    expect(r.pass).toBe(false);
    expect(r.problems[0]).toMatch(/^launch: .*server-launcher\.sh has mode 700, not 500$/);
  }, 30_000);
});

// --- 2: this runner's options ------------------------------------------------------------------

describe("ISS-1486 D2: this runner's options", () => {
  it("2: the onboarding tools plus Agent, Agent allowed in the policy file and never on the argv, the denials and the two extras; onboarding still denies Agent", () => {
    expect(continuityOptions("high")).toEqual({
      builtInTools: [...CLAUDE_TOOLS, "Agent"], allowBuiltIns: ["Read", "Glob", "Grep", "Bash", "Skill", "Agent"], deny: ["WebFetch", "WebSearch", "Task"],
      extraArgs: [["--effort", "high"]], extraFlags: ["--no-session-persistence"],
    });
    expect(ONBOARDING_OPTIONS.deny).toContain("Agent");
    expect(ONBOARDING_OPTIONS.builtInTools).not.toContain("Agent");
    const dirs = { work: tmp("c1486-w-"), tmp: tmp("c1486-t-"), home: tmp("c1486-h-"), config: tmp("c1486-c-"), launch: tmp("c1486-l-") };
    const l = prepareLaunch(dirs, { model: "m", effort: "high", maxBudgetUsd: 1, tools: TOOLS, codexBin: CODEX, bundleSha256: BUNDLE_SHA, codex: CODEX_FP }, { PATH: "/usr/bin" });
    const policy = JSON.parse(readFileSync(l.expected.policyFile, "utf-8")) as { permissions: { allow: string[]; deny: string[] } };
    expect(policy.permissions.allow).toContain("Agent");
    expect(policy.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Task"]));
    expect(policy.permissions.deny).not.toContain("Agent");
    expect(l.args.filter((a) => /^--allowed-?tools$/i.test(a))).toEqual([]);
    expect(l.args[l.args.indexOf("--tools") + 1]!.split(",")).toContain("Agent");
    expect(l.args.filter((a) => a === "--effort" || a === "--no-session-persistence")).toEqual(["--effort", "--no-session-persistence"]);
  });
});

// --- 16: acceptance grep ------------------------------------------------------------------------

describe("ISS-1486 acceptance", () => {
  it("16: no continuity script names the skip-permissions flag", () => {
    const dir = join(PKG, "scripts");
    const files = readdirSync(dir).filter((f) => /^continuity-.*\.ts$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) expect(readFileSync(join(dir, f), "utf-8"), f).not.toContain("dangerously-skip-permissions");
  });
});
