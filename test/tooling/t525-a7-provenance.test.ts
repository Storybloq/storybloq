/**
 * T-525 Addendum E, commit B (w14-a7): per-turn provenance, model-free. The readback listings against the pin (B1),
 * the per-turn nonce and pending-only answers (B2, K1), the memory refusal keyed on isolation (B0, B3), the init
 * latch and the cleanup confirmation (B4), and the metadata-only boundary on every one of those paths (B5, K4).
 * The rows drive a fresh Launch carrying a test-only provenance through the real driveClaude with a fake spawn
 * (B3-Q); nothing signed-in spawns. Fake homes only; nothing here starts a client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every content access (open or read) under the fake real home, recorded by the node:fs mocks below. */
const access = vi.hoisted(() => ({ home: null as string | null, seen: [] as string[] }));
const watch = (op: string, p: unknown): void => {
  const s = typeof p === "string" ? p : p instanceof URL ? p.pathname : Buffer.isBuffer(p) ? p.toString() : null;
  if (access.home !== null && s !== null && (s === access.home || s.startsWith(`${access.home}/`))) access.seen.push(`${op} ${s.slice(access.home.length)}`);
};
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const wrap = <F extends (...a: never[]) => unknown>(op: string, f: F): F => ((...a: Parameters<F>) => { watch(op, a[0]); return f(...a); }) as F;
  const over = {
    readFileSync: wrap("readFileSync", real.readFileSync), openSync: wrap("openSync", real.openSync), readFile: wrap("readFile", real.readFile),
    open: wrap("open", real.open), createReadStream: wrap("createReadStream", real.createReadStream),
  };
  return { ...real, ...over, default: { ...real, ...over } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const over = {
    readFile: (...a: Parameters<typeof real.readFile>) => { watch("promises.readFile", a[0]); return real.readFile(...a); },
    open: (...a: Parameters<typeof real.open>) => { watch("promises.open", a[0]); return real.open(...a); },
  };
  return { ...real, ...over, default: { ...real, ...over } };
});

const run = await import("../../scripts/continuity-run.js");
const { prepareLaunch, driveClaude, postRunPolicy, confirmGroupGone, provenanceStops, ProvenanceStopError, PROVENANCE_STOP_FILE, PROVENANCE_INTENT_FILE, readRegularFile, INTENT_MAX_BYTES, rawChainParents } = run;
const { lstatSync: realLstat, readdirSync: realReaddir } = await import("node:fs");
type Launch = import("../../scripts/continuity-run.js").Launch;
type LaunchRun = import("../../scripts/continuity-run.js").LaunchRun;
type RunOptions = import("../../scripts/continuity-run.js").RunOptions;
type SpawnFn = import("../../scripts/continuity-run.js").SpawnFn;
const policy = await import("../../scripts/headless-policy.js");
const { readbackExpected, readbackProblems, claudeTurnArgs, controlRequest, READBACK_REQUESTS } = policy;
type ReadbackStep = import("../../scripts/headless-policy.js").ReadbackStep;
const { memoryProvenance, listingProblems, initProvenanceProblems } = await import("../../scripts/continuity-signed-in.js");
const { processGroupSeams } = await import("../../src/core/process-group.js");

const goodResponses = (createRequire(import.meta.url)("../fixtures/t538-claude-sentinel.cjs") as { goodResponses: (x: Record<string, unknown>) => Record<string, Record<string, unknown>> }).goodResponses;

const P = { model: "m", effort: "high", maxBudgetUsd: 1, tools: ["storybloq_status", "storybloq_ticket_get"], codexBin: "/opt/codex/bin/codex", bundleSha256: "b".repeat(64), codex: { codexSha256: "c".repeat(64), codexVersion: "codex-cli 0.0.0" } };
const PROV = { clientVersion: "9.9.9 (Claude Code)", agents: ["general-purpose"], commands: ["compact"], skills: [] as string[], plugins: [] as string[], outputStyle: "default" };
const SOURCE = { PATH: "/usr/bin:/bin", LANG: "C" };

let root: string;
let dirs: { work: string; tmp: string; home: string; config: string; launch: string };
let fakeHome: string;
const seams = { probe: processGroupSeams.probe, send: processGroupSeams.send };
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "a7b-")));
  dirs = { work: join(root, "work"), tmp: join(root, "tmp"), home: join(root, "home"), config: join(root, "config"), launch: join(root, "launch") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  fakeHome = join(root, "real");
  mkdirSync(join(fakeHome, ".claude", "projects"), { recursive: true });
  for (const [f, t] of [[".claude/settings.json", "{\"hooks\":{}}"], [".claude/CLAUDE.md", "marker"], [".claude.json", "{}"], [".claude/.credentials.json", "{}"]] as const) writeFileSync(join(fakeHome, f), t);
  access.home = fakeHome; access.seen = [];
});
afterEach(() => { access.home = null; processGroupSeams.probe = seams.probe; processGroupSeams.send = seams.send; rmSync(root, { recursive: true, force: true }); });

type Kind = "first" | "resume";
/** A fresh Launch with a test-only provenance (B3-Q); `kind` rebuilds the argv for a resumed session. */
/** Each Launch gets its own launch dir: the launch files are written exclusively. */
const launchDirs = (): typeof dirs => ({ ...dirs, launch: mkdtempSync(join(root, "launch-")) });
function provLaunch(kind: Kind, over: { settingSources?: "none" } = {}): Launch {
  const l = (prepareLaunch as (...a: unknown[]) => Launch)(launchDirs(), P, SOURCE);
  const expected = { ...l.expected, provenance: PROV };
  const options = over.settingSources === undefined ? l.options : { ...l.options, settingSources: over.settingSources };
  const session = kind === "first" ? l.session : { kind: "resume" as const, id: l.session.id };
  return { ...l, expected, options, session, args: claudeTurnArgs(expected, session, options) };
}
const plainLaunch = (): Launch => (prepareLaunch as (...a: unknown[]) => Launch)(launchDirs(), P, SOURCE);

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  arm: 1, tasks: ["T-4"], repeats: 1, model: "m", effort: "high", isolation: "fresh", out: join(root, "out"), rawOut: join(root, "raw"), timeoutMs: 5000, sigkillGraceMs: 100, maxBudgetUsd: 1, ...over,
} as RunOptions);

class FakeChild extends EventEmitter {
  pid = 999999;
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
    this.stdin.destroy();
    setTimeout(() => this.emit("close", code, signal), 0);
  }
}

/** One fake client turn. Every hook gets `send` (one stdout line) and the child. */
interface Out { send(v: unknown): void; child: FakeChild }
interface Script {
  readonly ignoreTerm?: boolean;
  readonly initialize?: (init: Record<string, unknown>) => void;
  readonly settings?: (s: Record<string, unknown>) => void;
  /** Runs as each control request arrives; return true when it answered itself. */
  readonly answer?: (id: string, subtype: string, ok: (id: string) => void, out: Out) => boolean;
  readonly atSpawn?: (out: Out) => void;
  readonly onPrompt?: (out: Out, ns: string) => void;
}
const INIT = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "system", subtype: "init", claude_code_version: PROV.clientVersion, agents: ["general-purpose"], slash_commands: ["compact"], skills: [], plugins: [], output_style: "default",
  permissionMode: "dontAsk", apiKeySource: "none", mcp_servers: [{ name: "storybloq", status: "connected" }], ...over,
});
const RESULT = { type: "result", subtype: "success", permission_denials: [] };
const clean = (out: Out): void => { out.send(INIT()); out.send(RESULT); setTimeout(() => out.child.finish(0, null), 5); };

function fakeSpawn(script: Script, seen: { child: FakeChild; requests: string[]; prompts: number }[]): SpawnFn {
  return (_cmd, args) => {
    const child = new FakeChild(script.ignoreTerm === true);
    const rec = { child, requests: [] as string[], prompts: 0 };
    seen.push(rec);
    const opt = (k: string): string => args[args.indexOf(k) + 1] ?? "";
    const pol = JSON.parse(readFileSync(opt("--settings"), "utf-8")) as { sandbox: { filesystem: { allowWrite: string[] } } };
    const server = (JSON.parse(readFileSync(opt("--mcp-config"), "utf-8")) as { mcpServers: { storybloq: { command: string; args: string[]; env: Record<string, string> } } }).mcpServers.storybloq;
    const answers = goodResponses({ project: dirs.work, roots: pol.sandbox.filesystem.allowWrite, policy: pol, mcpTools: P.tools, mcpLaunch: { command: server.command, args: server.args } });
    for (const s of (answers.mcp_status!.mcpServers as { config: Record<string, unknown> }[])) s.config = { ...s.config, env: { ...server.env } };
    Object.assign(answers.initialize!, { claude_code_version: PROV.clientVersion, agents: [{ name: "general-purpose", description: "d" }], commands: [{ name: "compact", description: "c" }] });
    script.initialize?.(answers.initialize!);
    script.settings?.(answers.get_settings!);
    const out: Out = { send: (v) => { if (child.exitCode === null && child.signalCode === null) child.stdout.write(`${JSON.stringify(v)}\n`); }, child };
    const sub = new Map<string, string>();
    const ok = (id: string): void => out.send({ type: "control_response", response: { subtype: "success", request_id: id, response: answers[sub.get(id) ?? READBACK_REQUESTS[Number(id.replace(/^.*r/, "")) - 1]!] } });
    let ns = "";
    let pending = "";
    child.stdin.on("data", (c: Buffer) => {
      pending += c.toString("utf-8");
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const text = pending.slice(0, nl); pending = pending.slice(nl + 1);
        if (text.trim() === "") continue;
        const msg = JSON.parse(text) as { type: string; request_id?: string; request?: { subtype: string } };
        if (msg.type === "control_request") {
          const id = msg.request_id!;
          ns = id.slice(0, id.length - 2);
          sub.set(id, msg.request!.subtype);
          rec.requests.push(id);
          if (!(script.answer?.(id, msg.request!.subtype, ok, out) ?? false)) ok(id);
        } else if (msg.type === "user") {
          rec.prompts++;
          (script.onPrompt ?? clean)(out, ns);
        }
      }
    });
    if (script.atSpawn) setTimeout(() => script.atSpawn!(out), 0);
    return child as unknown as import("node:child_process").ChildProcess;
  };
}

async function turn(l: Launch, script: Script = {}, o: RunOptions = opts()): Promise<{ r: LaunchRun; rec: { child: FakeChild; requests: string[]; prompts: number } }> {
  const seen: { child: FakeChild; requests: string[]; prompts: number }[] = [];
  const r = await driveClaude(o, l, "p", { transcript: join(root, `t-${Math.random()}`), stderr: join(root, "e") }, {
    spawnFn: fakeSpawn(script, seen), readbackTimeoutMs: 1000, cleanupBoundMs: 150, loadSample: () => ({ load1: 1, swapFreeBytes: 8 * 1024 ** 3 }), loadSampleMs: 1000,
  }, () => {});
  return { r, rec: seen[0]! };
}

describe("B0 the split: listings run with provenance, memory runs with isolation signed-in", () => {
  it("a clean synthetic turn on a fresh Launch with a test-only provenance writes the prompt and latches nothing", async () => {
    const { r, rec } = await turn(provLaunch("first"));
    expect(r.readback.problems).toEqual([]);
    expect(r.promptWritten).toBe(true);
    expect(rec.prompts).toBe(1);
    expect(r.provenanceStop).toBeNull();
    expect(r.cleanup).toBe("confirmed");
  });
  it("(ii) never runs on a fresh Launch: its readback has no memory.unproven, even with provenance", async () => {
    const { r } = await turn(provLaunch("first"));
    expect(r.readback.problems.some((p) => p.startsWith("memory.unproven"))).toBe(false);
  });
  it("(ii) runs on a signed-in expected without provenance, through the pure readbackProblems on stored steps", () => {
    const l = plainLaunch();
    const x = readbackExpected(l.expected, l.options, { signedIn: true });
    expect(x.provenance).toBeUndefined();
    const steps = stepsOf(goodResponses(x as unknown as Record<string, unknown>), "");
    expect(readbackProblems(steps, x).filter((p) => p.startsWith("memory."))).toEqual([expect.stringMatching(/^memory\.unproven: /)]);
  });
});

function stepsOf(answers: Record<string, Record<string, unknown>>, ns: string): ReadbackStep[] {
  return READBACK_REQUESTS.map((subtype, i) => ({ requestId: `${ns}r${i + 1}`, subtype, outcome: "success" as const, response: answers[subtype] }));
}

describe.each(["first", "resume"] as const)("B1 readback listings before the prompt (%s)", (kind) => {
  const refused = async (script: Script, code: RegExp): Promise<void> => {
    const { r, rec } = await turn(provLaunch(kind), script);
    expect(r.launchFailure).toMatch(code);
    // B-F1: a provenance problem in the readback latches the non-retryable stop with its own code.
    expect(r.provenanceStop).toMatch(code);
    expect(postRunPolicy([], plainLaunch(), r, null).launchFailure).toMatch(code);
    expect(r.promptWritten).toBe(false);
    expect(rec.prompts).toBe(0);
  };
  it("the agents listing missing is provenance.listing-missing:agents", () => refused({ initialize: (i) => { delete i.agents; } }, /^provenance\.listing-missing:agents$/));
  it("a malformed commands entry is provenance.malformed:commands", () => refused({ initialize: (i) => { i.commands = [{ name: "compact" }, 7]; } }, /^provenance\.malformed:commands$/));
  it("the version missing is provenance.version", () => refused({ initialize: (i) => { delete i.claude_code_version; } }, /^provenance\.version: missing$/));
  it("a version that is not the pin is provenance.version", () => refused({ initialize: (i) => { i.claude_code_version = "9.9.8 (Claude Code)"; } }, /^provenance\.version: not the pinned version$/));
  it("an extra agent is provenance.mismatch:agents", () => refused({ initialize: (i) => { (i.agents as unknown[]).push({ name: "user-agent" }); } }, /^provenance\.mismatch:agents$/));
  it("a missing command is provenance.mismatch:commands", () => refused({ initialize: (i) => { i.commands = []; } }, /^provenance\.mismatch:commands$/));
  it("a clean readback passes and the prompt is written", async () => {
    const { r, rec } = await turn(provLaunch(kind));
    expect(r.launchFailure).toBeNull();
    expect(rec.prompts).toBe(1);
  });
  it("E2: a flagSettings-only readback passes under settingSources none", async () => {
    const { r, rec } = await turn(provLaunch(kind, { settingSources: "none" }), { settings: (s) => { s.sources = (s.sources as { source: string }[]).filter((x) => x.source === "flagSettings"); } });
    expect(r.launchFailure).toBeNull();
    expect(rec.prompts).toBe(1);
  });
  it("E2: userSettings present under settingSources none is refused, and is not a provenance stop", async () => {
    const { r, rec } = await turn(provLaunch(kind, { settingSources: "none" }));
    expect(r.launchFailure).toBe("get_settings.sources");
    expect(r.provenanceStop).toBeNull();
    expect(rec.prompts).toBe(0);
  });
});

describe.each(["first", "resume"] as const)("B2 freshness: per-turn nonce, pending-only answers (%s)", (kind) => {
  it("the ids carry a 12-hex nonce, and two turns never share one", async () => {
    const a = await turn(provLaunch(kind));
    const b = await turn(provLaunch(kind));
    expect(a.rec.requests).toEqual(READBACK_REQUESTS.map((_, i) => `t${a.r.readbackNonce}-r${i + 1}`));
    expect(a.r.readbackNonce).toMatch(/^[0-9a-f]{12}$/);
    expect(b.r.readbackNonce).not.toBe(a.r.readbackNonce);
  });
  it("a replayed valid previous-turn exchange written at spawn is readback.unsolicited, and no prompt is written", async () => {
    const prior = await turn(provLaunch(kind));
    // B-F5: the previous turn's own exchange, each step with its original request id and response.
    const replay = prior.r.readback.steps;
    expect(replay).toHaveLength(6);
    const { r, rec } = await turn(provLaunch(kind), { answer: (id, _s, ok, out) => {
      // The replay is on the stream ahead of this turn's first answer, as a client replaying a stored exchange at start would put it.
      if (id.endsWith("-r1")) { for (const st of replay) out.send({ type: "control_response", response: { subtype: "success", request_id: st.requestId, response: st.response } }); ok(id); return true; }
      return false;
    } });
    expect(r.provenanceStop).toBe(`readback.unsolicited: ${JSON.stringify(replay[0]!.requestId)}`);
    expect(r.promptWritten).toBe(false);
    expect(rec.prompts).toBe(0);
  });
  it("an answer to a future id (r6 before r1 is asked) is readback.unsolicited", async () => {
    const { r, rec } = await turn(provLaunch(kind), { answer: (id, _s, ok) => { if (id.endsWith("-r1")) { ok(id.replace(/r1$/, "r6")); ok(id); return true; } return false; } });
    expect(r.provenanceStop).toMatch(/^readback\.unsolicited: .*-r6"$/);
    expect(rec.prompts).toBe(0);
  });
  it("a duplicate answer to r2 is readback.unsolicited", async () => {
    const { r, rec } = await turn(provLaunch(kind), { answer: (id, _s, ok) => { if (id.endsWith("-r2")) { ok(id); ok(id); return true; } return false; } });
    expect(r.provenanceStop).toMatch(/^readback\.unsolicited: .*-r2"$/);
    expect(rec.prompts).toBe(0);
  });
  it("without provenance the ids stay r1..r6 and the six request lines are 967e4062's bytes", async () => {
    const { r, rec } = await turn(plainLaunch());
    expect(rec.requests).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
    expect(r.readbackNonce).toBeNull();
    expect(READBACK_REQUESTS.map((s, i) => controlRequest(`r${i + 1}`, s)).join("")).toBe(READBACK_REQUESTS.map((s, i) => `{"type":"control_request","request_id":"r${i + 1}","request":{"subtype":"${s}"}}\n`).join(""));
  });
  it("in the regrade, a stored exchange whose ids do not carry the record's nonce is readback.stale", () => {
    const l = provLaunch(kind);
    const x = readbackExpected(l.expected, l.options, { nonce: "0123456789ab" });
    expect(readbackProblems(stepsOf(goodResponses(x as unknown as Record<string, unknown>), "tba9876543210-"), x)[0]).toMatch(/^readback\.stale/);
    expect(readbackProblems(stepsOf(goodResponses(x as unknown as Record<string, unknown>), "t0123456789ab-"), x).some((p) => p.startsWith("readback.stale"))).toBe(false);
  });
});

describe.each(["first", "resume"] as const)("K1 a control response after the final readback answer (%s)", (kind) => {
  it("a duplicate final response after prompt delivery latches readback.unsolicited and the turn is stopped and discarded", async () => {
    // Deferred a tick: the fake hears the prompt inside its write, so a synchronous send would land before the write returns.
    const { r, rec } = await turn(provLaunch(kind), { onPrompt: (out, ns) => {
      setTimeout(() => out.send({ type: "control_response", response: { subtype: "success", request_id: `${ns}r6`, response: {} } }), 0);
      setTimeout(() => { out.send(INIT()); out.send(RESULT); out.child.finish(0, null); }, 20);
    } });
    expect(rec.prompts).toBe(1);
    expect(r.provenanceStop).toMatch(/^readback\.unsolicited: .*r6"$/);
    expect(r.killKind).toBe("policy-stop");
    expect(r.cleanup).toBe("confirmed");
    expect(postRunPolicy([], plainLaunch(), r, null).launchFailure).toBe(r.provenanceStop);
  });
  it("one immediately before the result latches the same stop", async () => {
    const { r, rec } = await turn(provLaunch(kind), { onPrompt: (out, ns) => {
      setTimeout(() => {
        out.send(INIT());
        out.send({ type: "control_response", response: { subtype: "success", request_id: `${ns}r6`, response: {} } });
        out.send(RESULT);
        setTimeout(() => out.child.finish(0, null), 5);
      }, 0);
    } });
    expect(rec.prompts).toBe(1);
    expect(r.provenanceStop).toMatch(/^readback\.unsolicited: /);
    expect(postRunPolicy([], plainLaunch(), r, null).launchFailure).toBe(r.provenanceStop);
  });
});

describe("B3 memory: always unproven on the pinned client; lstat evidence only adds to the text", () => {
  it("the guessed paths absent is still unproven", () => {
    rmSync(join(fakeHome, ".claude", "CLAUDE.md"));
    const m = memoryProvenance(dirs.work, fakeHome);
    expect(m.status).toBe("unproven");
    expect(m.evidence).toContain("user CLAUDE.md absent");
    expect(m.evidence).toContain("guessed memory folder absent");
  });
  it("a differently encoded slug (dots, spaces, unicode) is named as an unreliable guess", () => {
    const odd = join(root, "a.b cé");
    mkdirSync(odd);
    const m = memoryProvenance(odd, fakeHome);
    expect(m.status).toBe("unproven");
    expect(m.evidence).toContain("the guessed slug is unreliable: cwd holds a character whose encoding is not pinned");
  });
  it("a symlinked ancestor is named", () => {
    const link = join(root, "link");
    symlinkSync(dirs.work, link);
    mkdirSync(join(dirs.work, "inner"));
    const m = memoryProvenance(join(link, "inner"), fakeHome);
    expect(m.status).toBe("unproven");
    expect(m.evidence).toContain(`symlinked ancestor ${link}`);
  });
  it("an lstat EACCES is named, never read as absent", () => {
    const fs = { lstatSync: (p: string): { isSymbolicLink(): boolean } => { if (p.endsWith("CLAUDE.md")) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return { isSymbolicLink: () => false }; } };
    const m = memoryProvenance(dirs.work, fakeHome, fs);
    expect(m.status).toBe("unproven");
    expect(m.evidence).toContain("user CLAUDE.md lstat EACCES");
    expect(m.evidence).not.toContain("user CLAUDE.md absent");
  });
});

describe.each(["first", "resume"] as const)("B4 the init latch and the cleanup confirmation (%s)", (kind) => {
  const leak = INIT({ plugins: ["user-plugin"] });
  it("a leak then a timeout keeps the leak's code", async () => {
    // The timeout fires first (SIGTERM ignored), the leak arrives inside the SIGKILL grace: the timeout keeps the kill class, the latch the failure.
    const { r } = await turn(provLaunch(kind), { ignoreTerm: true, onPrompt: (out) => { setTimeout(() => out.send(leak), 120); } }, opts({ timeoutMs: 60, sigkillGraceMs: 300 }));
    expect(r.killKind).toBe("timeout");
    expect(r.provenanceStop).toBe("init.provenance:plugins");
    expect(postRunPolicy([], plainLaunch(), r, null).launchFailure).toBe("init.provenance:plugins");
  });
  it("a leak then a nonzero exit keeps the leak's code", async () => {
    const { r } = await turn(provLaunch(kind), { ignoreTerm: true, onPrompt: (out) => { out.send(leak); out.child.finish(3, null); } });
    expect(r.exit.code).toBe(3);
    expect(r.provenanceStop).toBe("init.provenance:plugins");
    expect(postRunPolicy([], plainLaunch(), r, null).launchFailure).toBe("init.provenance:plugins");
  });
  it("a leak then a signal keeps the leak's code", async () => {
    const { r } = await turn(provLaunch(kind), { ignoreTerm: true, onPrompt: (out) => { out.send(leak); out.child.finish(null, "SIGKILL"); } });
    expect(r.exit.signal).toBe("SIGKILL");
    expect(postRunPolicy([], plainLaunch(), r, null).launchFailure).toBe("init.provenance:plugins");
  });
  it("no init by the exit, with the group gone, is init.missing and nothing is signalled", async () => {
    const sent: number[] = [];
    processGroupSeams.send = (g) => { sent.push(g); };
    const { r, rec } = await turn(provLaunch(kind), { onPrompt: (out) => { out.child.finish(0, null); } });
    expect(r.provenanceStop).toBe("init.missing");
    expect(sent).toEqual([]);
    expect(rec.child.kills).toEqual([]);
  });
  it("a result with no init before it is init.missing", async () => {
    const { r } = await turn(provLaunch(kind), { onPrompt: (out) => { out.send(RESULT); setTimeout(() => out.child.finish(0, null), 5); } });
    expect(r.provenanceStop).toBe("init.missing");
  });
  it("a second init is init.duplicate, latched before the result", async () => {
    const { r } = await turn(provLaunch(kind), { onPrompt: (out) => { out.send(INIT()); out.send(INIT()); setTimeout(() => { out.send(RESULT); out.child.finish(0, null); }, 30); } });
    expect(r.provenanceStop).toBe("init.duplicate");
    expect(r.resultSeen).toBe(false);
  });
  it("an init whose version contradicts the turn's readback is init.contradiction", async () => {
    const { r } = await turn(provLaunch(kind), { onPrompt: (out) => { out.send(INIT({ claude_code_version: "1.0.0" })); out.send(RESULT); out.child.finish(0, null); } });
    expect(r.provenanceStop).toBe("init.contradiction");
  });
  it("a malformed init (skills not a list) is init.provenance:skills", async () => {
    const { r } = await turn(provLaunch(kind), { onPrompt: (out) => { out.send(INIT({ skills: "story" })); out.send(RESULT); out.child.finish(0, null); } });
    expect(r.provenanceStop).toBe("init.provenance:skills");
  });
  it("survivors after the run (the probe answers alive) is cleanup.unconfirmed", async () => {
    processGroupSeams.probe = () => {};
    processGroupSeams.send = () => {};
    const { r } = await turn(provLaunch(kind));
    expect(r.cleanup).toBe("unconfirmed");
    expect(r.provenanceStop).toBe("cleanup.unconfirmed");
  });
});

describe("B4 helpers", () => {
  it("confirmGroupGone probes until gone, and is unconfirmed at the bound", async () => {
    let n = 0;
    expect(await confirmGroupGone({ probe: () => (++n >= 3 ? "gone" : "alive") }, 1000)).toBe("confirmed");
    expect(n).toBe(3);
    expect(await confirmGroupGone({ probe: () => "EPERM" }, 60)).toBe("unconfirmed");
  });
  it("the pure checks name each field", () => {
    expect(listingProblems({ claude_code_version: PROV.clientVersion, agents: [{ name: "general-purpose" }], commands: [{ name: "compact" }] }, PROV)).toEqual([]);
    expect(initProvenanceProblems(INIT({ output_style: "user-style" }), PROV)).toEqual(["init.provenance:output_style"]);
  });
  it("a provenance stop on disk is found, so the matrix never resumes past it", () => {
    const d = join(root, "raw", "exp", "T-4", "repeat-1", "attempt-1");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, PROVENANCE_STOP_FILE), "{}");
    expect(provenanceStops(join(root, "raw", "exp"))).toEqual(["T-4/repeat-1/attempt-1"]);
    expect(new ProvenanceStopError("x")).toBeInstanceOf(Error);
  });
});

describe("B5, K4 the metadata-only boundary on the B paths", () => {
  it("K4 (M-B15's killer): the signed-in memory check through the pure readback path opens nothing under the fake home", () => {
    const l = plainLaunch();
    const x = readbackExpected(l.expected, l.options, { signedIn: true });
    const problems = readbackProblems(stepsOf(goodResponses(x as unknown as Record<string, unknown>), ""), x, () => memoryProvenance(dirs.work, fakeHome).evidence);
    expect(problems.filter((p) => p.startsWith("memory."))).toEqual([expect.stringMatching(/^memory\.unproven: .*user CLAUDE\.md present/)]);
    expect(access.seen).toEqual([]);
  });
  it("a full synthetic turn (readback, init latch, cleanup) plus the memory probe opens nothing under the fake home", async () => {
    const { r } = await turn(provLaunch("first"));
    expect(r.provenanceStop).toBeNull();
    memoryProvenance(dirs.work, fakeHome);
    expect(access.seen).toEqual([]);
  });
});

describe("B-F4 one strict validator for the pin, at preparation and in a stored record", () => {
  const stored = (prov: unknown): string[] => {
    const l = provLaunch("first");
    const x = { ...readbackExpected(l.expected, l.options, { nonce: "0123456789ab" }), provenance: prov } as never;
    return readbackProblems(stepsOf(goodResponses(readbackExpected(l.expected, l.options) as unknown as Record<string, unknown>), "t0123456789ab-"), x);
  };
  it.each([
    ["an empty client version", { ...PROV, clientVersion: "" }],
    ["an empty output style", { ...PROV, outputStyle: "" }],
    ["duplicate listing names", { ...PROV, agents: ["general-purpose", "general-purpose"] }],
    ["an unexpected field", { ...PROV, extra: 1 }],
  ])("the regrade names %s as readback.expected.provenance is malformed", (_n, prov) => {
    expect(stored(prov)).toEqual(["readback.expected.provenance is malformed"]);
    expect(() => (prepareLaunch as (...a: unknown[]) => Launch)(launchDirs(), { ...P, provenance: prov }, SOURCE, { isolation: "signed-in", realHome: fakeHome })).toThrow(/the signed-in provenance is malformed/);
  });
  it("a well-formed stored pin is not malformed, and is the pin the listings are then held to", () => {
    const p = stored(PROV);
    expect(p).not.toContain("readback.expected.provenance is malformed");
    expect(p).toContain("provenance.mismatch:agents");
  });
});

describe("B-F2 / K3 the durable writer propagates every failure", () => {
  const io = (fail: "fsync" | "rename" | "dirsync"): import("../../scripts/headless-common.js").DurableIo => ({
    open: (async (p: string, flags: string) => {
      const h = await (await import("node:fs/promises")).open(p, flags);
      if ((fail === "fsync" && flags === "wx") || (fail === "dirsync" && flags === "r")) return Object.assign(Object.create(h), { sync: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }, close: () => h.close(), writeFile: (d: string) => h.writeFile(d) });
      return h;
    }) as never,
    rename: (async (a: string, b: string) => { if (fail === "rename") throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); return (await import("node:fs/promises")).rename(a, b); }) as never,
  });
  it.each(["fsync", "rename", "dirsync"] as const)("a %s failure is thrown, never swallowed", async (fail) => {
    const { writeDurable } = await import("../../scripts/headless-common.js");
    await expect(writeDurable(join(dirs.tmp, "j.json"), "{}", io(fail))).rejects.toMatchObject({ code: fail === "rename" ? "EXDEV" : "EIO" });
  });
  it.each(["open", "fsync"] as const)("fsyncDir throws a directory %s failure, never swallows it", async (fail) => {
    const { fsyncDir } = await import("../../scripts/headless-common.js");
    const fsp = await import("node:fs/promises");
    const io = { open: (async (p: string, flags: string) => {
      if (fail === "open") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      const h = await fsp.open(p, flags);
      return Object.assign(Object.create(h), { sync: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }, close: () => h.close() });
    }) as never };
    await expect(fsyncDir(dirs.tmp, io)).rejects.toMatchObject({ code: fail === "open" ? "EACCES" : "EIO" });
    await expect(fsyncDir(dirs.tmp)).resolves.toBeUndefined();
  });
  it("with nothing failing the file is in place", async () => {
    const { writeDurable } = await import("../../scripts/headless-common.js");
    await writeDurable(join(dirs.tmp, "j.json"), "{\"a\":1}");
    expect(readFileSync(join(dirs.tmp, "j.json"), "utf-8")).toBe("{\"a\":1}");
  });
});

describe("B-F3 the stop scan refuses on anything it cannot read", () => {
  const plant = (exp: string, file: string, text = "{}"): string => {
    const d = join(root, "raw", exp, "T-4", "repeat-1", "attempt-001");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, file), text);
    return d;
  };
  const failing = (at: string, code: string) => ({
    lstatSync: (p: string) => (realLstat(p)),
    readdirSync: (p: string): string[] => { if (p === at) throw Object.assign(new Error(code), { code }); return realReaddir(p); },
    readIntent: (p: string): string => readFileSync(p, "utf-8"),
  });
  it("an absent experiment root is no stops", () => {
    expect(provenanceStops(join(root, "raw", "none"))).toEqual([]);
  });
  it.each([["EACCES", "root"], ["EIO", "root"], ["EACCES", "attempt"], ["EIO", "attempt"]])("%s at the %s level is thrown, never read as empty", (code, level) => {
    const d = plant("exp", "other.json");
    const at = level === "root" ? join(root, "raw", "exp") : d;
    expect(() => provenanceStops(join(root, "raw", "exp"), failing(at, code))).toThrow(code);
  });
  it("an unresolved intent counts as a stop; a resolved one does not; another experiment's stop is out of scope", () => {
    plant("exp", PROVENANCE_INTENT_FILE, JSON.stringify({ state: "unresolved" }));
    expect(provenanceStops(join(root, "raw", "exp"))).toEqual(["T-4/repeat-1/attempt-001"]);
    writeFileSync(join(root, "raw", "exp", "T-4", "repeat-1", "attempt-001", PROVENANCE_INTENT_FILE), JSON.stringify({ state: "resolved" }));
    expect(provenanceStops(join(root, "raw", "exp"))).toEqual([]);
    plant("other", PROVENANCE_STOP_FILE);
    expect(provenanceStops(join(root, "raw", "exp"))).toEqual([]);
  });
  it.each(["EACCES", "EIO"])("%s from the root's own lstat is thrown, never read as an absent root", (code) => {
    plant("exp", "other.json");
    const at = join(root, "raw", "exp");
    const fsx = { ...failing("", code), lstatSync: (p: string) => { if (p === at) throw Object.assign(new Error(code), { code }); return realLstat(p); } };
    expect(() => provenanceStops(at, fsx)).toThrow(code);
  });
  it("a file where a directory belongs is refused", () => {
    mkdirSync(join(root, "raw", "exp", "T-4"), { recursive: true });
    writeFileSync(join(root, "raw", "exp", "T-4", "stray"), "");
    expect(() => provenanceStops(join(root, "raw", "exp"))).toThrow(/an unexpected entry/);
  });
});

describe("B-F6 the intent is read only as a regular file, never through a link, never blocking", () => {
  const attempt = (exp: string): string => { const d = join(root, "raw", exp, "T-4", "repeat-1", "attempt-001"); mkdirSync(d, { recursive: true }); return d; };
  const recording = () => {
    const reads: string[] = [];
    return { reads, fs: { lstatSync: (p: string) => realLstat(p), readdirSync: (p: string): string[] => realReaddir(p), readIntent: (p: string): string => { reads.push(p); return readRegularFile(p, INTENT_MAX_BYTES); } } };
  };
  it("a link to another experiment's resolved intent is a stop, and the link is never read", () => {
    writeFileSync(join(attempt("other"), PROVENANCE_INTENT_FILE), JSON.stringify({ state: "resolved" }));
    symlinkSync(join(root, "raw", "other", "T-4", "repeat-1", "attempt-001", PROVENANCE_INTENT_FILE), join(attempt("exp"), PROVENANCE_INTENT_FILE));
    const r = recording();
    expect(provenanceStops(join(root, "raw", "exp"), r.fs)).toEqual(["T-4/repeat-1/attempt-001"]);
    expect(r.reads).toEqual([]);
    expect(provenanceStops(join(root, "raw", "exp"))).toEqual(["T-4/repeat-1/attempt-001"]);
  });
  it("a link to a credential file in the home is a stop with zero content reads", () => {
    const cred = join(fakeHome, ".claude", ".credentials.json");
    writeFileSync(cred, JSON.stringify({ state: "resolved" }));
    symlinkSync(cred, join(attempt("exp"), PROVENANCE_INTENT_FILE));
    const r = recording();
    expect(provenanceStops(join(root, "raw", "exp"), r.fs)).toEqual(["T-4/repeat-1/attempt-001"]);
    expect(r.reads).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("a FIFO in the intent's place is a stop, opened by nothing, with no hang", () => {
    execFileSync("mkfifo", [join(attempt("exp"), PROVENANCE_INTENT_FILE)]);
    const r = recording();
    expect(provenanceStops(join(root, "raw", "exp"), r.fs)).toEqual(["T-4/repeat-1/attempt-001"]);
    expect(r.reads).toEqual([]);
    expect(provenanceStops(join(root, "raw", "exp"))).toEqual(["T-4/repeat-1/attempt-001"]);
  }, 3000);
  it("readRegularFile refuses a link (no follow) and a FIFO (no block), and bounds the size", () => {
    const d = attempt("exp");
    writeFileSync(join(d, "real.json"), "{}");
    symlinkSync(join(d, "real.json"), join(d, "link.json"));
    expect(() => readRegularFile(join(d, "link.json"), INTENT_MAX_BYTES)).toThrow(expect.objectContaining({ code: "ELOOP" }));
    execFileSync("mkfifo", [join(d, "fifo")]);
    expect(() => readRegularFile(join(d, "fifo"), INTENT_MAX_BYTES)).toThrow(/not a regular file/);
    writeFileSync(join(d, "big.json"), "x".repeat(INTENT_MAX_BYTES + 1));
    expect(() => readRegularFile(join(d, "big.json"), INTENT_MAX_BYTES)).toThrow(/larger than 4096 bytes/);
    expect(readRegularFile(join(d, "real.json"), INTENT_MAX_BYTES)).toBe("{}");
  }, 3000);
  it("an oversized regular intent is thrown by the scan, not read as resolved", () => {
    writeFileSync(join(attempt("exp"), PROVENANCE_INTENT_FILE), `{"state":"resolved"}${" ".repeat(INTENT_MAX_BYTES)}`);
    expect(() => provenanceStops(join(root, "raw", "exp"))).toThrow(/larger than 4096 bytes/);
  });
});

describe("B-F7 the raw chain the intent sits in", () => {
  it("rawChainParents names rawOut, experiment, task and repeat in order, and refuses any other shape", () => {
    expect(rawChainParents("/r", "/r/e/T-4/repeat-1/attempt-001")).toEqual(["/r", "/r/e", "/r/e/T-4", "/r/e/T-4/repeat-1"]);
    expect(() => rawChainParents("/r", "/r/e/T-4/attempt-001")).toThrow(/is not rawOut/);
    expect(() => rawChainParents("/r", "/rx/e/T-4/repeat-1/attempt-001")).toThrow(/is not rawOut/);
  });
});
