/**
 * T-525 Addendum E, commit A (w14-a7): the signed-in launch boundary, model-free. prepareLaunch's signed-in
 * branch (E1 env, E2 sources, E4 launcher, the pinned provenance input), the Launch-carried isolation refused
 * at the spawn boundary independently of the run's options (G1), the metadata-only real-home boundary (G5) and
 * the fresh launch's bytes pinned against 967e4062. Fake homes only; nothing here starts a client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const { prepareLaunch, driveClaude, PKG_ROOT } = run;
type Launch = import("../../scripts/continuity-run.js").Launch;
type RunOptions = import("../../scripts/continuity-run.js").RunOptions;
type SpawnFn = import("../../scripts/continuity-run.js").SpawnFn;
const { SIGNED_IN_MISSING_GATES, signedInEnvProblems } = await import("../../scripts/continuity-signed-in.js");

const P = { model: "m", effort: "high", maxBudgetUsd: 1, tools: ["storybloq_status", "storybloq_ticket_get"], codexBin: "/opt/codex/bin/codex", bundleSha256: "b".repeat(64), codex: { codexSha256: "c".repeat(64), codexVersion: "codex-cli 0.0.0" } };
const PROV = { clientVersion: "9.9.9 (Claude Code)", agents: ["general-purpose"], commands: ["compact"], skills: [], plugins: [], outputStyle: "default" };
const SOURCE = { PATH: "/usr/bin:/bin", LANG: "C" };

let root: string;
let dirs: { work: string; tmp: string; home: string; config: string; launch: string };
let fakeHome: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "a7-")));
  dirs = { work: join(root, "work"), tmp: join(root, "tmp"), home: join(root, "home"), config: join(root, "config"), launch: join(root, "launch") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  // The fake "real HOME": every kind of file the signed-in path must never open.
  fakeHome = join(root, "real");
  for (const d of [".claude/plugins", ".claude/skills/x", ".claude/agents", ".claude/output-styles", ".claude/hooks"]) mkdirSync(join(fakeHome, d), { recursive: true });
  for (const [f, t] of [[".claude/settings.json", "{\"hooks\":{}}"], [".claude/CLAUDE.md", "marker"], [".claude.json", "{}"], [".claude/.credentials.json", "{}"],
    [".claude/plugins/installed_plugins.json", "{}"], [".claude/skills/x/SKILL.md", "s"], [".claude/agents/a.md", "a"], [".claude/output-styles/o.md", "o"], [".claude/hooks/h.sh", "h"]] as const) {
    writeFileSync(join(fakeHome, f), t);
  }
  access.home = fakeHome; access.seen = [];
});
afterEach(() => { access.home = null; rmSync(root, { recursive: true, force: true }); });

const signedIn = (over: Record<string, unknown> = {}, source: NodeJS.ProcessEnv = SOURCE): Launch =>
  (prepareLaunch as (...a: unknown[]) => Launch)(dirs, { ...P, provenance: PROV, ...over }, source, { isolation: "signed-in", realHome: fakeHome });
const fresh = (over: Record<string, unknown> = {}): Launch => (prepareLaunch as (...a: unknown[]) => Launch)(dirs, { ...P, ...over }, SOURCE);

const opts = (over: Partial<RunOptions>): RunOptions => ({
  arm: 1, tasks: ["T-4"], repeats: 1, model: "m", effort: "high", isolation: "fresh", out: join(root, "out"), rawOut: join(root, "raw"), timeoutMs: 5000, sigkillGraceMs: 100, maxBudgetUsd: 1, ...over,
} as RunOptions);
const drive = async (o: RunOptions, l: Launch): Promise<{ error: string; spawned: number }> => {
  let spawned = 0;
  const spawnFn: SpawnFn = () => { spawned++; throw new Error("spawned"); };
  try {
    await driveClaude(o, l, "p", { transcript: join(root, "t"), stderr: join(root, "e") }, { spawnFn }, () => {});
    return { error: "resolved", spawned };
  } catch (e) { return { error: (e as Error).message, spawned }; }
};

describe("A1 prepareLaunch's signed-in branch (E1, E2, E4)", () => {
  it("M1 gap (b), E1: the pilot's outside probe gets the scratch HOME (the server column), never the client's real HOME", () => {
    const l = signedIn();
    expect(l.env.HOME).toBe(fakeHome);
    expect(l.probeEnv.HOME).toBe(dirs.home);
    expect(l.probeEnv).toEqual(l.expected.mcpLaunch.env);
    expect(Object.values(l.probeEnv).some((v) => v !== undefined && v.includes(fakeHome))).toBe(false);
  });
  it("the pilot hands the outside probe launch.probeEnv, never launch.env (the pilot refuses signed-in today, so this is pinned in source)", () => {
    const src = readFileSync(join(PKG_ROOT, "scripts", "continuity-run.ts"), "utf-8");
    const calls = [...src.matchAll(/await outsideProbe\(([^;]*)\);/g)].map((m) => m[1]!);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/, launch\.probeEnv, received$/);
  });
  it("a fresh launch's probe keeps the client's own environment (unchanged)", () => {
    const l = fresh();
    expect(l.probeEnv).toEqual(l.env);
  });
  it.each(["fresh", "signed-in"] as const)("single turn: a %s launch is a first turn", (kind) => {
    const l = kind === "fresh" ? fresh() : signedIn();
    expect(l.session.kind).toBe("first");
    expect(l.args).toContain("--session-id");
    expect(l.args).not.toContain("--resume");
  });
  it("single turn: nothing in continuity-run's production code builds a resume launch or drives a second turn", () => {
    // The home journal brackets exactly one turn per attempt; a resume built anywhere in the runner would change that.
    const src = readFileSync(join(PKG_ROOT, "scripts", "continuity-run.ts"), "utf-8");
    expect(src.match(/kind:\s*"resume"/g)).toBeNull();
    // The definition, the attempt's one turn and the pilot's one turn: no loop or second call drives a further turn.
    expect(src.match(/driveClaude\(/g)?.length).toBe(3);
  });
  it("the client gets the real HOME and no config dir or token, --setting-sources \"\" plus --settings, the launcher first on PATH", () => {
    const l = signedIn();
    expect(l.isolation).toBe("signed-in");
    const i = l.args.indexOf("--setting-sources");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(l.args[i + 1]).toBe("");
    expect(l.args[l.args.indexOf("--settings") + 1]).toBe(l.expected.policyFile);
    expect(Object.keys(l.env).sort()).toEqual(["HOME", "LANG", "NO_UPDATE_NOTIFIER", "PATH", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_PROJECT_ROOT", "TMPDIR"]);
    expect(l.env.HOME).toBe(fakeHome);
    expect(l.env.PATH!.split(":")[0]).toBe(join(dirs.launch, "bin"));
    expect(l.expected.provenance).toEqual(PROV);
  });
  it("E4: bin/storybloq is 0500 and runs the eval CLI bundle under the scratch HOME, never the real one", () => {
    const l = signedIn();
    const bin = join(dirs.launch, "bin", "storybloq");
    expect(statSync(bin).mode & 0o777).toBe(0o500);
    const text = readFileSync(bin, "utf-8");
    expect(text).toContain(`HOME='${dirs.home}'`);
    expect(text).toContain(join(PKG_ROOT, ".eval-dist", "eval-cli.js"));
    expect(text).not.toContain(fakeHome);
    expect(l.storybloqLauncher?.path).toBe(bin);
  });
  it("E1: the tool server keeps the scratch HOME and its own CODEX_HOME; the real HOME appears nowhere in the MCP file", () => {
    const l = signedIn();
    expect(l.isolation).toBe("signed-in");
    const text = readFileSync(l.expected.mcpFile, "utf-8");
    const env = (JSON.parse(text) as { mcpServers: { storybloq: { env: Record<string, string> } } }).mcpServers.storybloq.env;
    expect(env.HOME).toBe(dirs.home);
    expect(env.CODEX_HOME).toBe(join(dirs.launch, "runner-home"));
    expect(text).not.toContain(fakeHome);
  });
  it("the fresh launch carries isolation fresh, no provenance and no CLI launcher", () => {
    const l = fresh();
    expect(l.isolation).toBe("fresh");
    expect(l.expected.provenance).toBeUndefined();
    expect(l.storybloqLauncher).toBeUndefined();
    expect(existsSync(join(dirs.launch, "bin"))).toBe(false);
  });
  it("a provenance given to a fresh launch is refused: it is a signed-in input only", () => {
    expect(() => fresh({ provenance: PROV })).toThrow(/provenance is a signed-in launch input only/);
  });
  it("a signed-in launch with no provenance is refused before anything is written", () => {
    expect(() => signedIn({ provenance: undefined })).toThrow(/needs its pinned provenance/);
    expect(existsSync(join(dirs.launch, "policy.json"))).toBe(false);
  });
  it.each([
    ["clientVersion", { clientVersion: "" }],
    ["clientVersion", { clientVersion: 9 }],
    ["agents", { agents: "general-purpose" }],
    ["commands", { commands: ["compact", "compact"] }],
    ["skills", { skills: [7] }],
    ["plugins", { plugins: [""] }],
    ["outputStyle", { outputStyle: undefined }],
    ["unexpected", { extra: [] }],
  ] as const)("a malformed provenance (%s) is refused, naming the field", (field, over) => {
    expect(() => signedIn({ provenance: { ...PROV, ...over } })).toThrow(new RegExp(`provenance is malformed: .*${field}`));
  });
});

describe("A-F1: a sparse listing is not an array of names", () => {
  it.each([["agents"], ["commands"], ["skills"], ["plugins"]] as const)("%s with a hole beside a distinct name is refused before any launch file is written", (field) => {
    const sparse: string[] = new Array(2);
    sparse[0] = "x";
    expect(() => signedIn({ provenance: { ...PROV, [field]: sparse } })).toThrow(new RegExp(`provenance is malformed: .*${field}`));
    expect(existsSync(join(dirs.launch, "policy.json"))).toBe(false);
  });
});

describe("A4 E1: the source environment, names only", () => {
  it.each([["CLAUDE_CODE_OAUTH_TOKEN"], ["ANTHROPIC_API_KEY"], ["SOME_OAUTH_THING"], ["CLAUDE_CONFIG_DIR"]])("%s in the source refuses the signed-in launch by name, never by value", (k) => {
    const value = "a-value-that-must-never-print-0123456789";
    let msg = "";
    try { signedIn({}, { ...SOURCE, [k]: value }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(k);
    expect(msg).toMatch(/names only/);
    expect(msg).not.toContain(value);
  });
  it("the built client env holds no token-shaped name and no config dir", () => {
    expect(signedInEnvProblems(signedIn().env)).toEqual([]);
  });
});

describe("A2 G1: the Launch's own isolation, refused at the spawn boundary", () => {
  it("a signed-in Launch driven with fresh options and an ack is refused as signed-in, with zero spawns", async () => {
    const r = await drive(opts({ isolation: "fresh", liveAck: "r-hs5j319qkr3gjvtz" }), signedIn());
    expect(r.error).toMatch(/the launch is signed-in/);
    expect(r.error).toContain(SIGNED_IN_MISSING_GATES[0]);
    expect(r.spawned).toBe(0);
  });
  it("a signed-in Launch carrying no provenance is refused for that, with zero spawns", async () => {
    const l = signedIn();
    const bare = { ...l, expected: { ...l.expected, provenance: undefined } } as Launch;
    const r = await drive(opts({ isolation: "fresh", liveAck: "r-hs5j319qkr3gjvtz" }), bare);
    expect(r.error).toMatch(/signed-in launch with no pinned provenance/);
    expect(r.spawned).toBe(0);
  });
  it("a Launch whose isolation does not match the run's is refused as a mismatch, with zero spawns", async () => {
    const r = await drive(opts({ isolation: "shared" as RunOptions["isolation"] }), fresh());
    expect(r.error).toMatch(/launch isolation fresh does not match the run's shared/);
    expect(r.spawned).toBe(0);
  });
  it("regression: the RunOptions refusal still stands for signed-in options with a fresh Launch", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of signedInEnvProblems(process.env)) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      const r = await drive(opts({ isolation: "signed-in", liveAck: "r-hs5j319qkr3gjvtz" }), fresh());
      expect(r.error).toContain(SIGNED_IN_MISSING_GATES[0]);
      expect(r.error).not.toMatch(/the launch is signed-in|does not match/);
      expect(r.spawned).toBe(0);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
  it("a fresh Launch with fresh options reaches the spawn", async () => {
    const r = await drive(opts({ isolation: "fresh" }), fresh());
    expect(r.spawned).toBe(1);
  });
});

describe("A3 G5: the real home is metadata-only for every path", () => {
  it("the signed-in prepareLaunch opens, reads or hashes nothing under the real HOME", () => {
    const l = signedIn();
    expect(l.env.HOME).toBe(fakeHome);
    expect(access.seen).toEqual([]);
  });
  it("the harness sees a read under the home (control: the recorder is live)", () => {
    readFileSync(join(fakeHome, ".claude", "settings.json"));
    expect(access.seen).toEqual(["readFileSync /.claude/settings.json"]);
  });
});

describe("A5 regression: the fresh launch's bytes are those of 967e4062", () => {
  it("argv, env, policy, MCP file, tools file and server launcher hash as on the base", () => {
    const l = fresh();
    const norm = (s: string): string => s.split(root).join("<ROOT>").split(PKG_ROOT).join("<PKG>").split(process.execPath).join("<NODE>").split(l.session.id).join("<SID>");
    const sha = (s: string): string => createHash("sha256").update(norm(s)).digest("hex");
    const env = Object.fromEntries(Object.entries(l.env).sort(([a], [b]) => a.localeCompare(b)));
    // Taken on 967e4062 with the same inputs, before any edit, by a one-off script (quoted in the commit word).
    expect({
      argv: sha(JSON.stringify(l.args)), env: sha(JSON.stringify(env)),
      policy: sha(readFileSync(l.expected.policyFile, "utf-8")), mcp: sha(readFileSync(l.expected.mcpFile, "utf-8")),
      tools: sha(readFileSync(l.server.toolsFile, "utf-8")), launcher: sha(readFileSync(l.server.launcher, "utf-8")),
    }).toEqual({
      argv: "f116535c9f85d033f55ee9251086cde7ed916a7e0cd42b85ad470f018e8d7b8e",
      env: "8fa5f30be87993479726dce315ca2ad25c228a8504c40946cd54c5ac9ebf2bb3",
      policy: "b52571fe29ae2507d43d5f758e11b477c1cf7586d77ab8576808c4530ea1a3f5",
      mcp: "6c0335cf4a255331e4735d377f822859df512a873ca5efa0bdc734c603bc33b1",
      tools: "e55877fa5a1cec2998d7c5e6d0e54d8b09f64d528134282aeab9e16d6b3d7be4",
      launcher: "5b137bb28849bcaf40bc96cd25d443d5216476fc0025e8ad43ad1439717f81a2",
    });
  });
});
