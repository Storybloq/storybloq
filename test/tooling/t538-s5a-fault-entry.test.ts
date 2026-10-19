/**
 * T-538 S5a C1: the evaluation fault entry. The eval bundle (.eval-dist/,
 * built by scripts/build-eval.mjs from the shipped tsup config) installs the
 * write seams in its own module instance; dist/ and the packed tarball never
 * read the eval variables. Each guard here runs real processes and real
 * writes; the kill is a real SIGKILL.
 *
 * Needs dist/ built first (`npm run build`); the eval bundle is built here.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initProject } from "../../src/core/init.js";
import { loadProject, serializeJSON, transactionSeams } from "../../src/core/project-loader.js";
import { setAfterWriteFault, setupApplySeams } from "../../src/core/setup-apply.js";
import { evidenceFileSeams } from "../../src/core/checkpoint-evidence-files.js";
import { addCheckpointEvidence, createCheckpoint } from "../../src/core/checkpoint-lifecycle.js";
import { parseOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import { setupPaths } from "../../src/core/setup-review.js";
import { handleSetupApply } from "../../src/cli/commands/setup-apply.js";
import { collector, ledgerSnapshot } from "../../scripts/eval-fault-mcp.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = join(PKG, "dist");
const EVAL_CLI = join(PKG, ".eval-dist", "eval-cli.js");
const EVAL_MCP = join(PKG, ".eval-dist", "eval-mcp.js");
const SID = "SS-0123abcd";
const VARS = ["STORYBLOQ_EVAL_FAULT", "STORYBLOQ_EVAL_EVENTS", "eval-fault"];
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

let scratch: string;
let home: string;
let reviewDir: string;
beforeAll(async () => {
  if (!existsSync(join(DIST, "cli.js")) || !existsSync(join(DIST, "mcp.js"))) throw new Error("dist/ is not built: run npm run build first");
  const { buildEval } = (await import("../../scripts/build-eval.mjs")) as { buildEval: (root: string, o?: { force?: boolean }) => Promise<{ built: boolean }> };
  await buildEval(PKG);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "t538-s5a-")));
  home = join(scratch, "home");
  reviewDir = join(scratch, "review-store");
  mkdirSync(home);
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const restore = { afterTemp: transactionSeams.afterTemp, afterCommitEntry: transactionSeams.afterCommitEntry };
afterEach(() => {
  setupApplySeams.fault = () => {};
  evidenceFileSeams.afterCreate = () => {};
  transactionSeams.afterTemp = restore.afterTemp;
  transactionSeams.afterCommitEntry = restore.afterCommitEntry;
});

let n = 0;
function folder(): string {
  const d = join(scratch, `p${n++}`);
  mkdirSync(d);
  return d;
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: {
      level: "full",
      verifyApplies: false,
      components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: { command: "npm run build", status: "pending", reason: "no build script yet" }, verify: null }],
    },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] },
    git: { init: false, gitignore: ["node_modules/"] },
    phases: [
      { key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" },
      { key: "K6", id: "polish", name: "Polish", label: "POLISH", description: "" },
    ],
    tickets: [
      { key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] },
      { key: "K3", title: "Profile", type: "feature", phase: "K6", description: "d", blockedBy: ["K2"] },
    ],
    checkpoints: [{ key: "K4", title: "Accept sign in", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: ["K3"] }],
    issues: [{ key: "K5", title: "Imported", body: "b", labels: ["bug"], source: 7 }],
    coverage: [{ requirement: "R1", text: "sign in", source: "brief", keys: ["K2", "K4"] }],
    ...over,
  };
}

/** planSteps order for payload(). */
const PLAN = [
  "enable", "phase:K1", "phase:K6", "item:K2", "item:K3", "item:K4", "item:K5", "wire:K3", "wire:K4",
  "config", "governance:CLAUDE.md", "gitignore", "freeze", "setup-note", "handover", "validate", "snapshot", "archive",
];

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", STORYBLOQ_SETUP_REVIEW_DIR: reviewDir };
  return { ...env, ...extra };
}

interface Ran { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Spawned, not spawnSync: a blocked worker misses vitest's RPC deadline across the suite's many children. */
function run(bin: string, cwd: string, args: string[], opts: { events?: string; fault?: string; stdin?: string; entry?: boolean } = {}): Promise<Ran> {
  const extra: Record<string, string> = {};
  if (opts.events !== undefined) extra.STORYBLOQ_EVAL_EVENTS = opts.events;
  if (opts.fault !== undefined) extra.STORYBLOQ_EVAL_FAULT = opts.fault;
  const child = spawn(process.execPath, [bin, ...(opts.entry === false ? [] : ["--entry", "cli"]), ...args], { cwd, env: childEnv(extra), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  child.stdin.on("error", () => {});
  child.stdin.end(opts.stdin ?? "");
  return new Promise((done, fail) => {
    child.on("error", fail);
    child.on("close", (status, signal) => done({ status, signal, stdout, stderr }));
  });
}

const evalApply = (cwd: string, events: string, fault?: string, over: Record<string, unknown> = {}) =>
  run(EVAL_CLI, cwd, ["setup-apply"], { events, ...(fault ? { fault } : {}), stdin: JSON.stringify(payload(over)) });
const evalResume = (cwd: string, events: string, fault?: string) =>
  run(EVAL_CLI, cwd, ["setup-apply", "--resume", "--setup", SID], { events, ...(fault ? { fault } : {}) });

type Event = Record<string, unknown> & { point?: string; attempt: string };

function readEvents(file: string): Event[] {
  return readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event);
}

/** The attempts in order, each its events after the attempt line. */
function attempts(events: Event[]): Event[][] {
  const out: Event[][] = [];
  for (const e of events) {
    if (e.seq === undefined) out.push([]);
    else out.at(-1)!.push(e);
  }
  return out;
}

/** The engine's last line: on an existing project the board-write report (`Git:` lines) follows it. */
const applied = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("Setup applied:")).at(-1);

const points = (es: Event[], prefix: string) => es.filter((e) => typeof e.point === "string" && e.point.startsWith(prefix)).map((e) => (e.point as string).slice(prefix.length));

function writeSkippedReview(root: string): void {
  const paths = setupPaths({ STORYBLOQ_SETUP_REVIEW_DIR: reviewDir }, root, SID);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.setupFile, JSON.stringify({ setupId: SID, projectKey: paths.projectKey, createdAt: "2026-10-18T00:00:00Z", cycle: 2, cycleReasons: {}, probe: null, probedAt: "2026-10-18T00:00:00Z", skipped: { at: "2026-10-18T00:00:00Z" } }));
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? allFiles(join(dir, d.name)) : [join(dir, d.name)]));
}

async function mcpClient(bin: string, cwd: string, extra: Record<string, string>, entry = true): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: "t538-s5a", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, ...(entry ? ["--entry", "mcp"] : [])], cwd, env: childEnv(extra), stderr: "pipe" });
  await client.connect(transport);
  return { client, close: async () => { await client.close(); await transport.close(); } };
}

async function mcpSetup(client: Client, args: Record<string, unknown>): Promise<string> {
  const r = (await client.callTool({ name: "storybloq_setup_apply", arguments: args })) as { content: Array<{ text: string }> };
  return r.content[0]!.text;
}

/** The digest the handler records, computed here from the CLI form's own inputs. */
function cliDigest(f: { stdin: string | null; resume?: boolean; setup?: string; resolve?: string }): string {
  const value = (t: string) => { try { return JSON.parse(t); } catch { return t.trim(); } };
  return sha(serializeJSON({ payload: f.stdin === null ? null : value(f.stdin), resume: f.resume === true, setup: f.setup ?? null, resolutions: f.resolve === undefined ? null : value(f.resolve) }));
}

describe("G1 to G3: dist never reads the eval variables", () => {
  it("G1: no dist/ file names them", () => {
    for (const file of allFiles(DIST)) {
      const text = readFileSync(file, "utf-8");
      for (const v of VARS) expect(text.includes(v), `${file} names ${v}`).toBe(false);
    }
  });

  it("G2: the packed file list has no scripts/ entry, and the tarball's text has none of them", () => {
    const dry = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: PKG, encoding: "utf-8" });
    expect(dry.status).toBe(0);
    const files = (JSON.parse(dry.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
    expect(files.filter((f) => f.startsWith("scripts/") || f.startsWith(".eval-dist/"))).toEqual([]);
    const out = join(scratch, "pack");
    mkdirSync(out);
    const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out], { cwd: PKG, encoding: "utf-8" });
    expect(packed.status).toBe(0);
    const tgz = join(out, (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename);
    const unpacked = join(out, "x");
    mkdirSync(unpacked);
    expect(spawnSync("tar", ["-xzf", tgz, "-C", unpacked]).status).toBe(0);
    for (const file of allFiles(unpacked)) {
      const text = readFileSync(file, "latin1");
      for (const v of VARS) expect(text.includes(v), `${file} names ${v}`).toBe(false);
    }
  });

  it("G3: dist/cli.js setup-apply with both set archives the setup and writes no events, snapshot or marker", async () => {
    const root = folder();
    const events = join(scratch, "g3-cli.jsonl");
    const r = await run(join(DIST, "cli.js"), root, ["setup-apply"], { events, fault: "step:item:K2", stdin: JSON.stringify(payload()), entry: false });
    expect([r.status, applied(r.stdout)]).toEqual([0, `Setup applied: ${SID}`]);
    for (const f of [events, `${events}.setup-snapshot.json`, `${events}.fired`]) expect(existsSync(f)).toBe(false);
  });

  it("G3: one storybloq_setup_apply call to dist/mcp.js with both set archives the setup and writes nothing of the eval", async () => {
    const root = folder();
    const events = join(scratch, "g3-mcp.jsonl");
    const { client, close } = await mcpClient(join(DIST, "mcp.js"), root, { STORYBLOQ_EVAL_EVENTS: events, STORYBLOQ_EVAL_FAULT: "step:item:K2" }, false);
    try {
      const text = await mcpSetup(client, { payload: payload() });
      expect(text.split("\n")[0]).toBe("[exit 0]");
      expect(text).toContain(`Setup applied: ${SID}`);
    } finally {
      await close();
    }
    for (const f of [events, `${events}.setup-snapshot.json`, `${events}.fired`]) expect(existsSync(f)).toBe(false);
  });
});

describe("G4: a fault kills the process at a point of each class", () => {
  it.each([
    ["bootstrap:manifest", "post-create"],
    ["bootstrap:owned:roadmap.json", "post-rename, not durable"],
    ["txn:after-temp", "pre-commit"],
    ["txn:after-commit-entry", "post-rename in a transaction"],
    ["step:item:K2", "post-transaction"],
    ["governance-created:CLAUDE.md", "post-create, pre-receipt"],
    ["archive-gated", "pre-write"],
    ["bootstrap:manifest-removed", "cleanup"],
    ["archive-committed", "post-transaction, lock held"],
  ])("%s (%s): SIGKILL, ordered steps, every event attributed", async (point) => {
    const root = folder();
    const events = join(scratch, `g4-${n}.jsonl`);
    const r = await evalApply(root, events, point);
    expect([r.status, r.signal]).toEqual([null, "SIGKILL"]);
    const [first] = attempts(readEvents(events));
    expect(first!.at(-1)!.point).toBe(point);
    const steps = points(first!, "step:");
    expect(steps).toEqual(PLAN.slice(0, steps.length));
    const start = first!.find((e) => e.point === "invocation-start")!;
    expect(start.kind).toBe("apply");
    expect(first!.some((e) => e.point === "invocation-end")).toBe(false);
    for (const e of first!) {
      expect(e.invocation).toBe(start.invocation);
      if (String(e.point).startsWith("step:")) {
        expect(e.setupId).toBe(SID);
        expect(e.revision).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    // The setup it left resumes to completion; past the archive's commit there is nothing left to write.
    const resumed = await evalResume(root, events);
    const done = point === "archive-committed" ? `Setup applied: ${SID} (already complete; nothing written)` : `Setup applied: ${SID}`;
    expect([resumed.status, applied(resumed.stdout)]).toEqual([0, done]);
  });

  it("a point#n selector kills at the nth occurrence in the invocation, not the first", async () => {
    const root = folder();
    const events = join(scratch, `g4-nth-${n}.jsonl`);
    const r = await evalApply(root, events, "txn:after-commit-entry#2");
    expect([r.status, r.signal]).toEqual([null, "SIGKILL"]);
    const [first] = attempts(readEvents(events));
    expect(first!.filter((e) => e.point === "txn:after-commit-entry").length).toBe(2);
    expect(first!.at(-1)!.point).toBe("txn:after-commit-entry");
  });
});

describe("G5: a resumed trace", () => {
  it("skips what attempt 1 committed, commits the rest in order with archive last, and the marker stops a second fire", async () => {
    const root = folder();
    const events = join(scratch, "g5.jsonl");
    expect((await evalApply(root, events, "step:item:K2")).signal).toBe("SIGKILL");
    const again = await evalResume(root, events, "step:item:K2");
    expect(again.status).toBe(0);
    const [a1, a2] = attempts(readEvents(events));
    const committed = points(a1!, "step:");
    expect(committed).toEqual(PLAN.slice(0, PLAN.indexOf("item:K2") + 1));
    expect(points(a2!, "skip:")).toEqual(committed);
    expect(points(a2!, "step:")).toEqual(PLAN.slice(committed.length));
    const seq = a2!.filter((e) => /^(step|skip):/.test(String(e.point))).map((e) => e.point);
    expect(seq.slice(0, committed.length).every((p) => String(p).startsWith("skip:"))).toBe(true);
    expect(seq.at(-1)).toBe("step:archive");
    expect(new Set([...committed, ...points(a2!, "step:")]).size).toBe(PLAN.length);
  });
});

describe("G6: a revision change", () => {
  it("after a kill at step:handover and an accepted amendment, freeze and the finalization steps commit again at the new revision", async () => {
    const root = folder();
    const events = join(scratch, "g6.jsonl");
    expect((await evalApply(root, events, "step:handover")).signal).toBe("SIGKILL");
    expect((await run(EVAL_CLI, root, ["ticket", "update", "T-001", "--title", "Log in"], { events })).status).toBe(0);
    writeSkippedReview(root);
    const resolved = await run(EVAL_CLI, root, ["setup-apply", "--resolve", JSON.stringify([{ target: "K2 (T-001)", resolution: "accept-current", ownerWords: "the owner said so" }]), "--setup", SID], { events });
    expect([resolved.status, applied(resolved.stdout)]).toEqual([0, `Setup applied: ${SID}`]);
    const all = attempts(readEvents(events));
    const first = all[0]!;
    const last = all.at(-1)!;
    const oldRev = first.find((e) => e.point === "step:freeze")!.revision;
    const recommitted = last.filter((e) => ["step:freeze", "step:setup-note", "step:handover", "step:validate", "step:snapshot", "step:archive"].includes(String(e.point)));
    expect(recommitted.map((e) => e.point)).toEqual(["step:freeze", "step:setup-note", "step:handover", "step:validate", "step:snapshot", "step:archive"]);
    for (const e of recommitted) expect([e.revision === oldRev, e.revision]).toEqual([false, expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(last.find((e) => e.point === "resolved")!.revision).toBe(recommitted[0]!.revision);
  });
});

describe("G7: the collector", () => {
  it("the snapshot is the ledger at archive-committed, step:archive carries its digest, and a later write leaves it alone", async () => {
    const root = folder();
    const events = join(scratch, "g7.jsonl");
    expect((await evalApply(root, events)).status).toBe(0);
    const snapshotFile = `${events}.setup-snapshot.json`;
    const snapshot = readFileSync(snapshotFile, "utf-8");
    expect(snapshot).toBe(ledgerSnapshot(root));
    const [a1] = attempts(readEvents(events));
    const committed = a1!.find((e) => e.point === "archive-committed")!;
    expect(committed.snapshotSha256).toBe(sha(snapshot));
    expect(a1!.find((e) => e.point === "step:archive")!.snapshotSha256).toBe(sha(snapshot));
    expect((await run(EVAL_CLI, root, ["ticket", "update", "T-001", "--title", "Later"], { events })).status).toBe(0);
    expect(readFileSync(snapshotFile, "utf-8")).toBe(snapshot);
    expect(ledgerSnapshot(root)).not.toBe(snapshot);
  });

  it("an evidence create emits evidence-created with the file's digest", async () => {
    const root = folder();
    await initProject(root, { name: "ev" });
    const configPath = join(root, ".story", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, schemaVersion: 5 }, null, 2) + "\n");
    const cp = await createCheckpoint(root, { title: "Accept", description: "", phase: "p0", owner: "owner", content: { kind: "acceptance", criteria: "works", evidenceRefs: [] }, actor: "owner@example.test", evidenceMode: "immutable" });
    const parsed = parseOwnerCheckpoint(cp);
    if (parsed.kind !== "ok") throw new Error("not a checkpoint");
    const src = join(root, "demo.txt");
    writeFileSync(src, "hello\n");
    const events = join(scratch, "g7-evidence.jsonl");
    setAfterWriteFault(collector(events, null, "cli", () => { throw new Error("no kill expected"); }));
    const out = await addCheckpointEvidence(root, cp.id, { generation: parsed.checkpoint.generation, revision: parsed.checkpoint.revision, digest: parsed.checkpoint.digest }, { file: src, actor: "owner@example.test" });
    const created = readEvents(events).find((e) => e.point === `evidence-created:${out.ref}`)!;
    expect(created.sha256).toBe(sha("hello\n"));
    expect(sha(readFileSync(join(root, out.ref)))).toBe(created.sha256);
  });
});

describe("G8: the eval bundle is the shipped version", () => {
  it("--version and the MCP server version equal dist's and package.json's", async () => {
    const pkg = (JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as { version: string }).version;
    const root = folder();
    const evalV = (await run(EVAL_CLI, root, ["--version"], { events: join(scratch, "g8.jsonl") })).stdout.trim();
    const distV = (await run(join(DIST, "cli.js"), root, ["--version"], { entry: false })).stdout.trim();
    expect([evalV, distV]).toEqual([pkg, pkg]);
    const e = await mcpClient(EVAL_MCP, root, { STORYBLOQ_EVAL_EVENTS: join(scratch, "g8-mcp.jsonl") });
    const d = await mcpClient(join(DIST, "mcp.js"), root, {}, false);
    try {
      expect(e.client.getServerVersion()?.version).toBe(d.client.getServerVersion()?.version);
      expect(e.client.getServerVersion()?.version).toBe(pkg);
    } finally {
      await e.close();
      await d.close();
    }
  });
});

describe("G9: a competing writer", () => {
  it("a lock-respecting writer waiting at archive-committed is absent from the snapshot and present in the final ledger", async () => {
    const root = folder();
    const events = join(scratch, "g9.jsonl");
    const collect = collector(events, null, "cli", () => { throw new Error("no kill expected"); });
    let writer: Promise<number | null> | null = null;
    let writerOutput = "";
    setAfterWriteFault(async (point, info) => {
      if (point === "archive-committed") {
        // The writer shares this process's locale and zone: a contender under a different LANG/LC_*/TZ reads the
        // holder's `ps` signature differently and steals a live lock (ISS-1421, its own item). This row tests the
        // snapshot under the lock, not that.
        const localeEnv = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => (e[0] === "LANG" || e[0] === "TZ" || e[0].startsWith("LC_")) && e[1] !== undefined));
        const child = spawn(process.execPath, [join(DIST, "cli.js"), "ticket", "update", "T-001", "--title", "Competing"], { cwd: root, env: childEnv(localeEnv), stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (d) => { writerOutput += String(d); });
        child.stderr.on("data", (d) => { writerOutput += String(d); });
        writer = new Promise((done) => child.on("exit", (code) => done(code)));
        const exited = await Promise.race([writer.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
        expect(exited).toBe(false);
      }
      collect(point, info);
    });
    const result = await handleSetupApply({ cwd: root, env: childEnv(), stdin: () => Buffer.from(JSON.stringify(payload())) }, {});
    expect(result.exitCode, `${result.stdout}\n--- writer: ${writerOutput}`).toBe(0);
    expect(await writer, writerOutput).toBe(0);
    expect(readFileSync(`${events}.setup-snapshot.json`, "utf-8")).not.toContain("Competing");
    expect((await loadProject(root)).state.tickets.find((t) => t.id === "T-001")!.title).toBe("Competing");
  });
});

describe("G10: the invocation events", () => {
  it("one MCP process takes an apply, a resolve and a resume, each its own start and end with the inputs' digests", async () => {
    const root = folder();
    writeFileSync(join(root, "CLAUDE.md"), "# mine\n");
    const events = join(scratch, "g10.jsonl");
    const resolutions = [{ target: "CLAUDE.md", resolution: "keep-current", ownerWords: "keep mine" }];
    const { client, close } = await mcpClient(EVAL_MCP, root, { STORYBLOQ_EVAL_EVENTS: events });
    try {
      expect((await mcpSetup(client, { payload: payload() })).split("\n")[0]).toBe("[exit 4]");
      writeSkippedReview(root);
      expect((await mcpSetup(client, { setup: SID, resolutions })).split("\n")[0]).toBe("[exit 0]");
      expect((await mcpSetup(client, { resume: true, setup: SID })).split("\n")[0]).toBe("[exit 0]");
    } finally {
      await close();
    }
    const [a1] = attempts(readEvents(events));
    const inv = a1!.filter((e) => String(e.point).startsWith("invocation-"));
    expect(inv.map((e) => [e.point, e.kind, e.exitCode ?? null])).toEqual([
      ["invocation-start", "apply", null], ["invocation-end", "apply", 4],
      ["invocation-start", "resolve", null], ["invocation-end", "resolve", 0],
      ["invocation-start", "resume", null], ["invocation-end", "resume", 0],
    ]);
    expect(new Set(inv.map((e) => e.invocation)).size).toBe(3);
    expect(inv.filter((e) => e.point === "invocation-start").map((e) => e.argSha256)).toEqual([
      cliDigest({ stdin: JSON.stringify(payload()) }),
      cliDigest({ stdin: null, setup: SID, resolve: JSON.stringify(resolutions) }),
      cliDigest({ stdin: null, resume: true, setup: SID }),
    ]);
  });

  it("an invocation killed at step:archive has a start and no end", async () => {
    const root = folder();
    const events = join(scratch, "g10-kill.jsonl");
    expect((await evalApply(root, events, "step:archive")).signal).toBe("SIGKILL");
    const [a1] = attempts(readEvents(events));
    expect(points(a1!, "invocation-")).toEqual(["start"]);
  });

  it.each([
    ["--resume with --resolve", ["--resume", "--resolve", "[]", "--setup", SID], ""],
    ["--resume without --setup", ["--resume"], ""],
    ["--setup on a new apply", ["--setup", SID], ""],
    ["empty standard input", [], ""],
    ["a payload that is not JSON", [], "not json\n"],
  ])("a pre-engine refusal (%s) is one invocation, kind refused, exit 2", async (_label, args, stdin) => {
    const root = folder();
    const events = join(scratch, `g10-refused-${n}.jsonl`);
    const r = await run(EVAL_CLI, root, ["setup-apply", ...args], { events, stdin });
    expect(r.status).toBe(2);
    const inv = attempts(readEvents(events))[0]!.filter((e) => String(e.point).startsWith("invocation-"));
    expect(inv.map((e) => [e.point, e.kind, e.exitCode ?? null])).toEqual([["invocation-start", "refused", null], ["invocation-end", "refused", 2]]);
    expect(existsSync(join(root, ".story"))).toBe(false);
  });

  it("an MCP call and its CLI here-document form give the same digest: a JSON payload, a payload that is not JSON, and a resolution", async () => {
    const pairs: Array<{ mcp: Record<string, unknown>; cli: { args: string[]; stdin: string } }> = [
      { mcp: { payload: payload() }, cli: { args: [], stdin: `${JSON.stringify(payload(), null, 2)}\n` } },
      { mcp: { payload: "not json" }, cli: { args: [], stdin: "not json\n" } },
      { mcp: { setup: SID, resolutions: [{ target: "CLAUDE.md", resolution: "stop", ownerWords: "stop" }] }, cli: { args: ["--resolve", '[{"target":"CLAUDE.md","resolution":"stop","ownerWords":"stop"}]', "--setup", SID], stdin: "" } },
    ];
    for (const pair of pairs) {
      const m = folder();
      const c = folder();
      const mEvents = join(scratch, `g10-eq-m-${n}.jsonl`);
      const cEvents = join(scratch, `g10-eq-c-${n}.jsonl`);
      const { client, close } = await mcpClient(EVAL_MCP, m, { STORYBLOQ_EVAL_EVENTS: mEvents });
      try {
        await mcpSetup(client, pair.mcp);
      } finally {
        await close();
      }
      await run(EVAL_CLI, c, ["setup-apply", ...pair.cli.args], { events: cEvents, stdin: pair.cli.stdin });
      const startOf = (f: string) => readEvents(f).find((e) => e.point === "invocation-start")!.argSha256;
      expect(startOf(mEvents)).toBe(startOf(cEvents));
      const resolve = pair.cli.args.includes("--resolve") ? pair.cli.args[pair.cli.args.indexOf("--resolve") + 1] : undefined;
      expect(startOf(cEvents)).toBe(cliDigest({ stdin: resolve === undefined ? pair.cli.stdin : null, ...(resolve !== undefined ? { setup: SID, resolve } : {}) }));
    }
  });

  it("a direct engine call carries invocation null", async () => {
    const root = folder();
    const seen: Array<string | null> = [];
    setupApplySeams.fault = (_p, info) => { seen.push(info.invocation); };
    const { setupApply } = await import("../../src/core/setup-apply.js");
    expect((await setupApply(root, payload())).exitCode).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([null]));
  });

  it("two overlapping invocations in one process produce the overlap record", async () => {
    const events = join(scratch, "g10-overlap.jsonl");
    setAfterWriteFault(collector(events, null, "mcp", () => { throw new Error("no kill expected"); }));
    const io = (root: string) => ({ cwd: root, env: childEnv(), stdin: () => Buffer.from(JSON.stringify(payload())) });
    const [a, b] = await Promise.all([handleSetupApply(io(folder()), {}), handleSetupApply(io(folder()), {})]);
    expect([a.exitCode, b.exitCode]).toEqual([0, 0]);
    const overlaps = readEvents(events).filter((e) => e.overlap === true);
    expect(overlaps).toHaveLength(1);
  });
});

describe("G11: a kill at archive-committed", () => {
  it("leaves the verified snapshot and no step:archive; the resume takes the already-complete branch and commits nothing", async () => {
    const root = folder();
    const events = join(scratch, "g11.jsonl");
    expect((await evalApply(root, events, "archive-committed")).signal).toBe("SIGKILL");
    const resumed = await evalResume(root, events, "archive-committed");
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain('First story: T-001 "Sign in"');
    expect(applied(resumed.stdout)).toBe(`Setup applied: ${SID} (already complete; nothing written)`);
    const [a1, a2] = attempts(readEvents(events));
    const committed = a1!.find((e) => e.point === "archive-committed")!;
    expect(committed.snapshotSha256).toBe(sha(readFileSync(`${events}.setup-snapshot.json`)));
    expect(a1!.some((e) => e.point === "step:archive")).toBe(false);
    expect(points(a1!, "invocation-")).toEqual(["start"]);
    expect(a2!.map((e) => e.point)).toEqual(["invocation-start", "invocation-end"]);
  });
});

describe("G12: the eval bundle is rebuilt by content", () => {
  it("an uncommitted src change rebuilds and changes the bundle; nothing changed builds nothing; the build inputs are in the digest", async () => {
    const { buildEval, evalInputDigest, EVAL_INPUTS } = await import("../../scripts/build-eval.mjs");
    const copy = join(scratch, "g12");
    mkdirSync(copy);
    for (const input of EVAL_INPUTS) cpSync(join(PKG, input), join(copy, input), { recursive: true });
    symlinkSync(join(PKG, "node_modules"), join(copy, "node_modules"));
    const first = await buildEval(copy);
    expect(first.built).toBe(true);
    const bundle = () => sha(readFileSync(join(copy, ".eval-dist", "eval-cli.js")));
    const before = bundle();
    expect((await buildEval(copy)).built).toBe(false);
    const file = join(copy, "src", "core", "setup-apply.ts");
    writeFileSync(file, readFileSync(file, "utf-8").replace("(already complete; nothing written)", "(already complete; nothing written, G12)"));
    expect(evalInputDigest(copy)).not.toBe(first.digest);
    const second = await buildEval(copy);
    expect(second.built).toBe(true);
    expect(bundle()).not.toBe(before);
    for (const input of ["scripts/build-eval.mjs", "tsup.config.ts", "package-lock.json"]) {
      const was = evalInputDigest(copy);
      writeFileSync(join(copy, input), readFileSync(join(copy, input), "utf-8") + "\n");
      expect(evalInputDigest(copy), input).not.toBe(was);
    }
  });
});
