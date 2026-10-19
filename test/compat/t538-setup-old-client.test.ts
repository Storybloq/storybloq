/**
 * T-538 S5a C4: a setup interrupted at a seam, met by the newest published
 * CLI (old-dists.json `latestPublished`, 1.15.9). Each state is built by an
 * eval-bundle child that SIGKILLs itself at the seam, at one fixed absolute
 * root (the ledger journal records absolute targets, so a copy elsewhere
 * would recover against the wrong tree). The oracle snapshots the tree, runs
 * the new client's `status`, restores the snapshot exactly, then runs 1.15.9
 * under a bare environment.
 *
 * 1.15.9's loadProject recovers `.story/.txn.json` before its schema fence
 * (dist/cli.js 5366-5382 recover, 5389-5394 fence), so both clients finish
 * the same transaction and 1.15.9 then refuses with version_mismatch.
 *
 * Two differences are expected and asserted on their own, never folded into
 * the tree comparison: the new client's `status` writes the derived,
 * gitignored `.story/cache/`, and 1.15.9 reclaims the stale `.story/.lock`
 * the killed child left (the new client takes the lock only to recover a
 * journal, and its next locked write reclaims it).
 *
 * Both clients' housekeeping writes HOME (session hooks in settings.json, the
 * update check), so each client gets its own scratch HOME, warmed by one
 * throwaway command outside the root, with NO_UPDATE_NOTIFIER=1 and CI=1; the
 * HOME, the review store and the root's parent are then byte-equal across
 * every oracle run. A HOME equal to the real one is refused.
 *
 * Needs dist/ built (`npm run build`) and the dist fetched
 * (`npm run compat:fetch`): skipped without it, a failure in required mode.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PUBLISHED, requireOldDists } from "./old-dists.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const { dists, skip } = requireOldDists([LATEST_PUBLISHED]);
const OLD_BIN = dists[0] ? dirname(dists[0].bin) : "";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NEW_CLI = join(PKG, "dist", "cli.js");
const EVAL_CLI = join(PKG, ".eval-dist", "eval-cli.js");
const SID = "SS-0123abcd";
const BARE_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const FENCE = /exceeds max supported 3/;

function payload(pointer: boolean): Record<string, unknown> {
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
    governance: {
      canonicalFactsPath: "CLAUDE.md",
      files: [{ path: "CLAUDE.md", content: "# demo\n" }],
      ...(pointer ? { pointers: [{ path: "AGENTS.md", block: "See CLAUDE.md for this project.\n" }] } : {}),
    },
    git: { init: false, gitignore: ["node_modules/"] },
    phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" }],
    tickets: [{ key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] }],
    checkpoints: [],
    issues: [],
    coverage: [{ requirement: "R1", text: "sign in", source: "brief", keys: ["K2"] }],
  };
}

// --- Byte maps ----------------------------------------------------------------

interface Entry { readonly kind: "dir" | "file"; readonly mode: number; readonly bytes?: Buffer }
type ByteMap = Map<string, Entry>;

/** Every path under `dir` (relative, `/`-joined) with its kind, mode and bytes; a symlink is refused. */
function mapOf(dir: string, exclude: (rel: string) => boolean = () => false): ByteMap {
  const out: ByteMap = new Map();
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const r = rel === "" ? name : `${rel}/${name}`;
      if (exclude(r)) continue;
      const p = join(abs, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`byte map: ${p} is a symlink`);
      if (st.isDirectory()) {
        out.set(r, { kind: "dir", mode: st.mode & 0o7777 });
        walk(p, r);
      } else out.set(r, { kind: "file", mode: st.mode & 0o7777, bytes: readFileSync(p) });
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}

/** The paths that differ between two maps, sorted. */
function diff(a: ByteMap, b: ByteMap): string[] {
  const out: string[] = [];
  for (const [k, e] of a) {
    const f = b.get(k);
    if (!f || f.kind !== e.kind || f.mode !== e.mode || (e.bytes && !e.bytes.equals(f.bytes!))) out.push(k);
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(k);
  return [...new Set(out)].sort();
}

const withoutDerived = (m: ByteMap, lock: boolean): ByteMap =>
  new Map([...m].filter(([k]) => !(k === ".story/cache" || k.startsWith(".story/cache/") || (lock && k === ".story/.lock"))));

/** Rebuilds `dir` from a map exactly: kinds, modes and bytes. */
function restore(dir: string, map: ByteMap): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const entries = [...map].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [k, e] of entries) {
    const p = join(dir, k);
    if (e.kind === "dir") mkdirSync(p);
    else writeFileSync(p, e.bytes!);
  }
  // Modes last, deepest first, so a read-only directory never blocks its own children.
  for (const [k, e] of entries.reverse()) chmodSync(join(dir, k), e.mode);
}

// --- Processes ----------------------------------------------------------------

let scratch: string;
let base: string;
let root: string;
let store: string;
let homes: { build: string; new: string; old: string };

const REAL_HOMES = [homedir(), userInfo().homedir].filter(Boolean).map((h) => { try { return realpathSync(h); } catch { return resolve(h); } });

/** Refuses a run whose HOME is the real one: every oracle and probe run uses a scratch HOME. */
function scratchHome(home: string): string {
  const real = realpathSync(home);
  if (REAL_HOMES.includes(real)) throw new Error(`refusing to run with the real HOME (${real})`);
  return home;
}

interface Ran { status: number | null; signal: NodeJS.Signals | null; out: string }

/** Async, so the real-HOME refusal is a rejection like any other failure. */
async function run(command: string, args: string[], cwd: string, env: Record<string, string>, stdin = ""): Promise<Ran> {
  scratchHome(env.HOME!);
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
  return new Promise((done, fail) => {
    child.on("error", fail);
    child.on("close", (status, signal) => done({ status, signal, out }));
  });
}

const quiet = { NO_UPDATE_NOTIFIER: "1", CI: "1" };
const newClient = (args: string[], cwd = root, home = homes.new) =>
  run(process.execPath, [NEW_CLI, ...args], cwd, { HOME: home, PATH: BARE_PATH, STORYBLOQ_SETUP_REVIEW_DIR: store, ...quiet });
const oldClient = (args: string[], cwd = root) =>
  run(join(OLD_BIN, "storybloq"), args, cwd, { HOME: homes.old, PATH: `${OLD_BIN}:${BARE_PATH}`, ...quiet });

/** A setup-apply child of the eval bundle at the fixed root, from an empty root and store. */
async function build(o: { fault?: string; pointer?: boolean; agents?: boolean }): Promise<{ ran: Ran; events: string }> {
  restore(root, new Map());
  rmSync(store, { recursive: true, force: true });
  if (o.agents) writeFileSync(join(root, "AGENTS.md"), "# agents\n");
  const events = join(scratch, `events-${Math.random().toString(36).slice(2)}.jsonl`);
  const env: Record<string, string> = { HOME: homes.build, PATH: process.env.PATH ?? BARE_PATH, STORYBLOQ_SETUP_REVIEW_DIR: store, STORYBLOQ_EVAL_EVENTS: events, ...quiet };
  if (o.fault) env.STORYBLOQ_EVAL_FAULT = o.fault;
  const ran = await run(process.execPath, [EVAL_CLI, "--entry", "cli", "setup-apply"], root, env, JSON.stringify(payload(o.pointer === true)));
  return { ran, events };
}

/** The occurrence of `txn:after-commit-entry` that renamed item:K2's ticket into place, from a whole run's events. */
function ticketCommitEntry(events: string): number {
  let n = 0;
  let afterPhase = false;
  for (const line of readFileSync(events, "utf-8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as { point?: string; target?: string };
    if (e.point === "step:phase:K1") afterPhase = true;
    if (e.point === "step:item:K2") break;
    if (e.point !== "txn:after-commit-entry") continue;
    n++;
    if (afterPhase && e.target?.startsWith(".story/tickets/")) return n;
  }
  throw new Error("no ticket commit entry inside item:K2");
}

/** Everything outside the root a run could reach: the root's parent (minus the root), the store, and that client's HOME. */
const outside = (home: string) => ({
  parent: mapOf(base, (rel) => rel === "root" || rel.startsWith("root/")),
  store: mapOf(store),
  home: mapOf(home),
});

function expectOutsideUnchanged(before: ReturnType<typeof outside>, after: ReturnType<typeof outside>): void {
  expect({ parent: diff(before.parent, after.parent), store: diff(before.store, after.store), home: diff(before.home, after.home) })
    .toEqual({ parent: [], store: [], home: [] });
}

interface Oracle { snap: ByteMap; afterNew: ByteMap; afterOld: ByteMap; old: Ran[] }

/** Snapshot, the new client's status, an exact restore, then 1.15.9's commands; nothing written outside the root by either. */
async function oracle(oldCommands: string[][], newHome = homes.new): Promise<Oracle> {
  const snap = mapOf(root);
  const beforeNew = outside(newHome);
  const n = await newClient(["status"], root, newHome);
  expect(n.status, n.out).toBe(0);
  const afterNew = mapOf(root);
  expectOutsideUnchanged(beforeNew, outside(newHome));

  restore(root, snap);
  expect(diff(mapOf(root), snap)).toEqual([]);

  const beforeOld = outside(homes.old);
  const old: Ran[] = [];
  for (const args of oldCommands) old.push(await oldClient(args));
  const afterOld = mapOf(root);
  expectOutsideUnchanged(beforeOld, outside(homes.old));
  return { snap, afterNew, afterOld, old };
}

const read = (m: ByteMap, rel: string) => m.get(rel)?.bytes?.toString("utf-8");

describe.skipIf(skip !== null)(`a setup interrupted at a seam, met by ${LATEST_PUBLISHED}${skip ? ` (${skip})` : ""}`, () => {
  beforeAll(async () => {
    if (!existsSync(NEW_CLI)) throw new Error("dist/ is not built: run npm run build first");
    const { buildEval } = (await import("../../scripts/build-eval.mjs")) as { buildEval: (root: string) => Promise<{ built: boolean }> };
    await buildEval(PKG);
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "t538-oldcli-")));
    base = join(scratch, "base");
    root = join(base, "root");
    store = join(scratch, "store");
    homes = { build: join(scratch, "home-build"), new: join(scratch, "home-new"), old: join(scratch, "home-old") };
    for (const d of [base, root, homes.build, homes.new, homes.old]) mkdirSync(d);
    // One throwaway command each, outside the root: the idempotent housekeeping (session hooks) lands here, not in an oracle run.
    const warm = join(scratch, "warm");
    mkdirSync(warm);
    await newClient(["status"], warm);
    await oldClient(["status"], warm);
  });
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  const oldCommands = [["status"], ["ticket", "update", "T-001", "--status", "inprogress"]];

  it("is the pinned version, and the driver refuses the real HOME", async () => {
    const v = await oldClient(["--version"]);
    expect(v.out.trim()).toBe(LATEST_PUBLISHED);
    expect(() => scratchHome(homedir())).toThrow(/refusing to run with the real HOME/);
    await expect(run(process.execPath, [NEW_CLI, "--version"], scratch, { HOME: userInfo().homedir, PATH: BARE_PATH })).rejects.toThrow(/real HOME/);
  });

  it("(1) inside a ledger transaction at item:K2 (post-rename): both clients recover to the same bytes; 1.15.9 then refuses", async () => {
    const dry = await build({});
    expect(dry.ran.status, dry.ran.out).toBe(0);
    const nth = ticketCommitEntry(dry.events);
    const { ran } = await build({ fault: `txn:after-commit-entry#${nth}` });
    expect([ran.status, ran.signal]).toEqual([null, "SIGKILL"]);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(true);

    const o = await oracle(oldCommands);
    for (const r of o.old) expect([r.status, FENCE.test(r.out)], r.out).toEqual([1, true]);
    // The recovery happened (journal gone, the setup note rolled forward) and is the same in both.
    expect(o.afterOld.has(".story/.txn.json")).toBe(false);
    expect(read(o.afterOld, ".story/notes/N-001.json")).not.toBe(read(o.snap, ".story/notes/N-001.json"));
    expect(diff(withoutDerived(o.afterNew, false), o.afterOld)).toEqual([]);
  });

  it.each([
    ["(2) governance-created:CLAUDE.md (post-create, pre-receipt)", "governance-created:CLAUDE.md", false, ["CLAUDE.md"]],
    ["(3) pointer-proposed:AGENTS.md (the proposal beside a pending pointer edit)", "pointer-proposed:AGENTS.md", true, ["CLAUDE.md", "AGENTS.md", `AGENTS.md.storybloq-${SID}.proposed`]],
  ])("%s: targets and journal unchanged by both; 1.15.9 refuses and reclaims only the stale lock", async (_label, fault, pointer, targets) => {
    const { ran } = await build({ fault, pointer, agents: pointer });
    expect([ran.status, ran.signal]).toEqual([null, "SIGKILL"]);
    const o = await oracle(oldCommands);
    expect(o.snap.has(".story/.txn.json")).toBe(false);
    expect(o.snap.has(".story/.lock")).toBe(true);
    for (const t of [...targets, ".story/notes/N-001.json"]) {
      expect(o.snap.has(t), t).toBe(true);
      expect(read(o.afterNew, t), t).toBe(read(o.snap, t));
      expect(read(o.afterOld, t), t).toBe(read(o.snap, t));
    }
    for (const r of o.old) expect([r.status, FENCE.test(r.out)], r.out).toEqual([1, true]);
    expect(diff(o.snap, o.afterOld)).toEqual([".story/.lock"]);
    expect(diff(o.snap, withoutDerived(o.afterNew, false))).toEqual([]);
    expect(diff(withoutDerived(o.afterNew, true), withoutDerived(o.afterOld, true))).toEqual([]);

    // The stale lock the new client leaves is no wedge: its next locked write reclaims it.
    restore(root, o.snap);
    const w = await newClient(["ticket", "update", "T-001", "--title", "Log in"]);
    expect(w.status, w.out).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8")).title).toBe("Log in");
    expect(existsSync(join(root, ".story", ".lock"))).toBe(false);
  });

  it("the fence row: on a finished setup, 1.15.9 refuses resolve and ticket update, and the files stay byte-equal", async () => {
    const { ran } = await build({});
    expect(ran.status, ran.out).toBe(0);
    const o = await oracle([...oldCommands, ["resolve", "T-001", "--use", "ours"]]);
    for (const r of o.old) expect([r.status, FENCE.test(r.out)], r.out).toEqual([1, true]);
    expect(diff(o.snap, o.afterOld)).toEqual([]);
    expect(diff(o.snap, withoutDerived(o.afterNew, false))).toEqual([]);
  });

  it("the outside-root check is live: an unwarmed HOME, where housekeeping installs hooks, fails the oracle", async () => {
    const { ran } = await build({});
    expect(ran.status, ran.out).toBe(0);
    const cold = join(scratch, `home-cold-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cold);
    await expect(oracle(oldCommands, cold)).rejects.toThrow(/settings\.json/);
  });
});
