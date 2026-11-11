/**
 * T-538 commit 3 (plan v5 6.1): interrupted setup without a model. The engine, not the model, decides which write
 * is in flight, so each write class is killed at its literal fault point through the eval bundle's own
 * `setup-apply` on a copy of the `empty-idea` project, with a package that has checkpoints and edges. Each row
 * asserts the fired record, the kill-time snapshot against the disk, a resume that finishes, each key once, the
 * archive once, the preservation table, and the oracle: the resumed ledger equals an uninterrupted apply's after
 * normalising dates and generated names.
 *
 * Needs dist/ built first (`npm run build`); the eval bundle is built here.
 */
import { describe, expect, beforeAll, afterAll, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEventsLog, type EventsFired } from "../../scripts/onboarding-eval-checkset7-events.js";
import { parseSchedule, armedIn, firedMarker, killSnapshot, scheduleFact, type ScheduleEntry } from "../../scripts/onboarding-eval-schedule.js";
import { faultSnapshotFindings, firedSessionFrom, NO_FACTS, ownerEdits, scheduleFindings } from "../../scripts/onboarding-eval-sessions.js";

/** These rows run each session as one CLI attempt, so a fired record's session is its attempt's place in the log. */
const byAttempt = (log: { readonly attempts: readonly { readonly attempt: string }[] }) => (r: { readonly attempt: string }): number | null => {
  const at = log.attempts.findIndex((a) => a.attempt === r.attempt);
  return at < 0 ? null : at + 1;
};
import { editedSnapshotFindings, parseTreeSnap, treeSnapshot, type TreeSnap, END_RAW, killedPids, killedTemp, killRaw, keyedItems, lockPaths, preservationFindings, progressNote, protectedPathsOf, WIRE_FIELDS } from "../../scripts/onboarding-eval-preserve.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVAL_CLI = join(PKG, ".eval-dist", "eval-cli.js");
const FIXTURE = join(PKG, "test", "fixtures", "onboarding", "empty-idea", "project");
const SID = "SS-0123abcd";

let scratch: string;
beforeAll(async () => {
  if (!existsSync(join(PKG, "dist", "cli.js"))) throw new Error("dist/ is not built: run npm run build first");
  const { buildEval } = (await import("../../scripts/build-eval.mjs")) as { buildEval: (root: string) => Promise<unknown> };
  await buildEval(PKG);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "t538-faults-")));
  mkdirSync(join(scratch, "home"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A fresh copy of the empty-idea project and its own events log. */
function project(): { root: string; events: string } {
  const d = join(scratch, `p${n++}`);
  cpSync(FIXTURE, join(d, "project"), { recursive: true });
  return { root: join(d, "project"), events: join(d, "events.jsonl") };
}

/**
 * The package: keys the selectors never name (K11 to K17, not the K1 to K6 other suites use), two tickets, one
 * checkpoint gating the second ticket, so both item and wire steps exist.
 */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: "Sam",
    project: { name: "rota", type: "npm", language: "typescript" },
    quality: { level: "full", verifyApplies: false, components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: { command: "npm run build", status: "pending", reason: "no build script yet" }, verify: null }] },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# rota\n" }] },
    git: { init: false, gitignore: ["node_modules/"] },
    phases: [{ key: "K11", id: "build", name: "Build", label: "BUILD", description: "the first version" }],
    tickets: [
      { key: "K17", title: "Watering rota", type: "feature", phase: "K11", description: "d", blockedBy: [] },
      { key: "K13", title: "Rota line", type: "feature", phase: "K11", description: "d", blockedBy: ["K17"] },
    ],
    checkpoints: [{ key: "K15", title: "Accept the rota", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K11", blockedBy: ["K17"], gates: ["K13"] }],
    issues: [],
    coverage: [{ requirement: "R1", text: "a rota", source: "brief", keys: ["K17", "K15"] }],
    ...over,
  };
}
const KEYS = ["K17", "K13", "K15"];

interface Ran { status: number | null; signal: NodeJS.Signals | null; stdout: string; pid: number }

/** One session: the eval bundle's setup-apply (or its resume), armed with the session's schedule entry if any. */
function session(p: { root: string; events: string }, entry: ScheduleEntry | null, body: Record<string, unknown> | null): Promise<Ran> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: join(scratch, "home"), GIT_CONFIG_NOSYSTEM: "1",
    STORYBLOQ_SETUP_REVIEW_DIR: join(scratch, "review-store"), STORYBLOQ_EVAL_EVENTS: p.events,
    ...(entry === null ? {} : { STORYBLOQ_EVAL_FAULT: entry.selector, STORYBLOQ_EVAL_FAULT_ID: entry.id }),
  };
  const args = body === null ? ["setup-apply", "--resume", "--setup", SID] : ["setup-apply"];
  const child = spawn(process.execPath, [EVAL_CLI, "--entry", "cli", ...args], { cwd: p.root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});
  child.stdin.end(body === null ? "" : JSON.stringify(body));
  return new Promise((done, fail) => { child.on("error", fail); child.on("close", (status, signal) => done({ status, signal, stdout, pid: child.pid ?? -1 })); });
}

const applied = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("Setup applied:")).at(-1);

/** Every regular file under the project, by POSIX path, `.git` and `node_modules` left out (the kill snapshot's walk). */
function tree(root: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (rel === "" && (name === ".git" || name === "node_modules")) continue;
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = lstatSync(join(root, r));
    if (st.isDirectory()) Object.assign(out, tree(root, r));
    else if (st.isFile()) out[r] = readFileSync(join(root, r)).toString("base64");
  }
  return out;
}
const text = (files: Record<string, string>, path: string): string => Buffer.from(files[path]!, "base64").toString("utf-8");
const json = (files: Record<string, string>, path: string): Record<string, unknown> => JSON.parse(text(files, path)) as Record<string, unknown>;

const withoutKilledTemps = (files: Record<string, string>, killed: readonly number[]): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter(([p]) => !killedTemp(p, killed)));

/** The ledger with dates and generated names normalised, for the oracle. */
function normalised(files: Record<string, string>): Record<string, string> {
  const date = /\d{4}-\d{2}-\d{2}(T\d{2}[-:]\d{2}[-:]\d{2}([.-]\d{1,3})?Z?)?/g;
  const digest = /\b[0-9a-f]{64}\b/g;
  const out: Record<string, string> = {};
  for (const [path, b64] of Object.entries(files)) out[path.replace(date, "<date>")] = Buffer.from(b64, "base64").toString("utf-8").replace(date, "<date>").replace(digest, "<sha256>");
  return out;
}

/** The points reached, in order; a fired record repeats its point and is left out. */
function points(events: string): string[] {
  return readFileSync(events, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; point?: string })
    .filter((e) => e.type !== "fault-fired").map((e) => e.point).filter((p): p is string => typeof p === "string");
}

let oracleTree: Record<string, string> | null = null;
/** The ledger of an uninterrupted apply of the same package, taken once. */
async function oracle(): Promise<Record<string, string>> {
  if (oracleTree !== null) return oracleTree;
  const p = project();
  const r = await session(p, null, payload());
  expect([r.status, applied(r.stdout)]).toEqual([0, `Setup applied: ${SID}`]);
  oracleTree = tree(p.root);
  return oracleTree;
}

/**
 * Runs a schedule to the end: session k armed with its entry (each killed), then one unarmed resume. Returns the
 * tree after each kill as the collector recorded it, the disk right after each kill, and the end.
 */
async function interrupted(scheduleText: string, finish = `Setup applied: ${SID}`) {
  const schedule = parseSchedule(scheduleText);
  const p = project();
  const atKill: Record<string, string>[] = [];
  const killed: number[] = [];
  for (let s = 1; s <= schedule.length + 1; s++) {
    const entry = armedIn(schedule, s);
    const r = await session(p, entry, s === 1 ? payload() : null);
    if (entry !== null) {
      expect([r.status, r.signal], `session ${s} is killed by ${entry.selector}`).toEqual([null, "SIGKILL"]);
      atKill.push(tree(p.root));
      killed.push(r.pid);
    } else expect([r.status, applied(r.stdout)], `session ${s} finishes`).toEqual([0, finish]);
  }
  const log = parseEventsLog(readFileSync(p.events, "utf-8"));
  const facts = schedule.map((e) => scheduleFact(e, p.events));
  return { p, schedule, atKill, killed, end: tree(p.root), log, facts };
}

/** The preservation rules and the oracle, the same for every class. */
async function preserved(r: Awaited<ReturnType<typeof interrupted>>, selector: string): Promise<void> {
  const kill = r.atKill[0]!;
  const end = r.end;
  // The kill snapshot is the disk at the kill: nothing after the kill changed what it says.
  const snap = parseTreeSnap(readFileSync(killSnapshot(r.p.events, r.schedule[0]!.id), "utf-8"));
  expect(snap.truncated).toBe(false);
  expect(snap.problems).toEqual([]);
  expect(snap.links).toEqual([]);
  expect(snap.files).toEqual(kill);
  // Protected content: every file setup did not create (the fixture's) is byte-identical.
  for (const path of Object.keys(tree(FIXTURE))) expect(end[path], path).toBe(kill[path]);
  // Setup-owned state, by the table.
  expect(end[".story/.setup-bootstrap.json"]).toBeUndefined();
  expect(lockPaths(end).filter((l) => !killedTemp(l, r.killed))).toEqual([]);
  const before = progressNote(kill);
  const after = progressNote(end);
  expect(after).not.toBeNull();
  expect(after!.note.status).toBe("archived");
  if (before !== null) {
    expect(after!.path).toBe(before.path);
    expect([after!.note.id, after!.note.createdDate]).toEqual([before.note.id, before.note.createdDate]);
    // The archive: absent at the kill unless the fault is the archive's own commit.
    expect(before.note.status).toBe(selector === "archive-committed" ? "archived" : "active");
  }
  for (const [key, paths] of keyedItems(kill)) {
    expect(keyedItems(end).get(key), key).toEqual(paths);
    const was = json(kill, paths[0]!);
    const now = json(end, paths[0]!);
    const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((f) => JSON.stringify(was[f]) !== JSON.stringify(now[f]));
    expect(changed.filter((f) => !WIRE_FIELDS.includes(f)), `${key} gained more than the wire fields`).toEqual([]);
    if (changed.includes("displayId")) expect([was.displayId, now.displayId], `${key} displayId`).toEqual([undefined, now.id]);
  }
  // config.json: once step:config committed before the kill, nothing but that step may change it.
  const committed = points(r.p.events);
  if (kill[".story/config.json"] !== undefined && committed.indexOf("step:config") >= 0 && committed.indexOf("step:config") < committed.indexOf(r.log.fired![0]!.point)) {
    expect(end[".story/config.json"]).toBe(kill[".story/config.json"]);
  }
  // Each key once, the archive once.
  expect([...keyedItems(end).entries()].map(([k, ps]) => [k, ps.length]).sort()).toEqual(KEYS.map((k) => [k, 1]).sort());
  // The archive's write commits once over every session (setup-apply.ts:1999). `step:archive` fires only after the
  // step returns (setup-apply.ts:2027), so a kill at archive-committed never reaches it and the resume writes nothing.
  expect(committed.filter((p) => p === "archive-committed").length).toBe(1);
  expect(committed.filter((p) => p === "step:archive").length).toBe(selector === "archive-committed" ? 0 : 1);
  // The oracle: equal to an uninterrupted apply of the same package.
  expect(normalised(withoutKilledTemps(end, r.killed))).toEqual(normalised(await oracle()));
  // The shared rules the live attempts and the regrade apply, on the same bytes: the pids the log says were killed
  // are the ones this row killed, and the rules find nothing.
  expect(killedPids(r.log).sort()).toEqual([...r.killed].sort());
  const protectedPaths = protectedPathsOf(Object.keys(tree(FIXTURE)).map((p) => ({ path: `project/${p}` })));
  expect(preservationFindings("interrupted", { baseline: snap, end: { files: end, links: [], truncated: false, problems: [] }, protectedPaths, selector, firedLine: Math.min(...(r.log.fired ?? []).map((f) => f.line)), log: r.log })).toEqual([]);
  // And through the session checks, as a live attempt's recorded snapshots.
  const named = new Map([[killRaw(r.schedule[0]!.id), readFileSync(killSnapshot(r.p.events, r.schedule[0]!.id), "utf-8")], [END_RAW, JSON.stringify({ files: end, links: [], truncated: false, problems: [] })]]);
  expect(faultSnapshotFindings("interrupted", { ...NO_FACTS, schedule: r.facts }, r.log, { read: (n) => named.get(n) ?? null, protectedPaths })).toEqual([]);
}

const firedOf = (log: { fired?: readonly EventsFired[] }) => log.fired ?? [];

describe("6.1: one row per write class", () => {
  const classes: [string, string, (pts: string[]) => string][] = [
    ["bootstrap", "bootstrap:manifest", () => "bootstrap:manifest"],
    ["ticket create", "step:item:*", () => "step:item:K17"],
    ["wiring", "step:wire:*", () => "step:wire:K13"],
    ["config", "step:config", () => "step:config"],
    ["setup note", "step:setup-note", () => "step:setup-note"],
    ["handover", "step:handover", () => "step:handover"],
    ["archive", "archive-committed", () => "archive-committed"],
  ];
  for (const [cls, selector, want] of classes) {
    it(`${cls} (${selector}): the fired record, the kill snapshot, a resume that finishes, and the preservation rules`, async () => {
      // A resume after the archive's own commit finds setup complete and writes nothing (setup-apply.ts:2060).
      const r = await interrupted(`1=f1:${selector}`, selector === "archive-committed" ? `Setup applied: ${SID} (already complete; nothing written)` : `Setup applied: ${SID}`);
      const fired = firedOf(r.log);
      expect(fired.length).toBe(1);
      const f = fired[0]!;
      const pts = points(r.p.events);
      expect(f).toMatchObject({ id: "f1", selector, point: want(pts), attempt: r.log.attempts[0]!.attempt });
      // The record names the invocation it fired in.
      const start = r.log.events.find((e) => e.attempt === f.attempt && e.point === "invocation-start");
      expect(f.invocation).toBe((start as { invocation?: string } | undefined)?.invocation ?? null);
      expect(scheduleFindings("interrupted", r.facts, r.log, byAttempt(r.log))).toEqual([]);
      if (selector === "step:item:*") {
        // The package's first item, resolved from the package (the selector names no key), with no wire point before it.
        expect(f.point).toBe(`step:item:${(payload().tickets as { key: string }[])[0]!.key}`);
        expect(pts.slice(0, pts.indexOf(f.point)).some((p) => p.startsWith("step:wire:"))).toBe(false);
      }
      if (selector === "step:wire:*") {
        // Every item step committed before the first wire step.
        const before = pts.slice(0, pts.indexOf(f.point));
        for (const k of KEYS) expect(before, k).toContain(`step:item:${k}`);
      }
      await preserved(r, selector);
    });
  }

  it("bootstrap recovery: a two-entry schedule fires both, each once, in its own session, and session 3 finishes", async () => {
    const r = await interrupted("1=a:bootstrap:publish,2=b:recovery:bootstrap:manifest-removed");
    const fired = firedOf(r.log);
    expect(fired.map((f) => [f.id, f.point])).toEqual([["a", "bootstrap:publish"], ["b", "recovery:bootstrap:manifest-removed"]]);
    expect(fired.map((f) => f.attempt)).toEqual([r.log.attempts[0]!.attempt, r.log.attempts[1]!.attempt]);
    expect(r.log.attempts.length).toBe(3);
    expect(scheduleFindings("interrupted", r.facts, r.log, byAttempt(r.log))).toEqual([]);
    for (const id of ["a", "b"]) expect(existsSync(firedMarker(r.p.events, id)), id).toBe(true);
    expect(lockPaths(r.end).filter((l) => !killedTemp(l, r.killed))).toEqual([]);
    expect(r.end[".story/.setup-bootstrap.json"]).toBeUndefined();
    expect(normalised(withoutKilledTemps(r.end, r.killed))).toEqual(normalised(await oracle()));
  });

  it("the ISS-1184 allowance is only a killed pid's lock temp: a temp of any other pid, or any other lock path, still fails the preservation rules", async () => {
    const r = await interrupted("1=f1:bootstrap:manifest");
    expect(r.killed.length).toBe(1);
    const left = lockPaths(r.end);
    // The killed session's own temp is the one leftover, and it is allowed.
    expect(left.every((l) => killedTemp(l, r.killed))).toBe(true);
    await preserved(r, "bootstrap:manifest");
    const other = r.killed[0]! + 1;
    const uuid = "0123abcd-0123-4abc-8abc-0123456789ab";
    for (const extra of [`.story/.lock.tmp.${other}.${uuid}`, `.story/.lock.tmp.${process.pid}.${uuid}`, ".story/.lock", `.story/.lock.tmp.${r.killed[0]}.not-a-uuid`]) {
      expect(killedTemp(extra, r.killed), extra).toBe(false);
      await expect(preserved({ ...r, end: { ...r.end, [extra]: "" } }, "bootstrap:manifest"), extra).rejects.toThrow();
      // The shared rule names it, so a live attempt and the regrade fail the same way.
      const baseline = parseTreeSnap(readFileSync(killSnapshot(r.p.events, "f1"), "utf-8"));
      expect(preservationFindings("interrupted", { baseline, end: { files: { ...r.end, [extra]: "" }, links: [], truncated: false, problems: [] }, protectedPaths: [], selector: "bootstrap:manifest", firedLine: Math.min(...(r.log.fired ?? []).map((f) => f.line)), log: r.log }), extra)
        .toEqual([`interrupted: ${extra} is still there after the resume`]);
    }
  });

  it("interrupted-edited: the snapshot after the owner's edits differs from the kill snapshot in exactly those edits", async () => {
    const p = project();
    expect((await session(p, { session: 1, id: "f1", selector: "step:handover" }, payload())).signal).toBe("SIGKILL");
    const kill = JSON.parse(readFileSync(killSnapshot(p.events, "f1"), "utf-8")) as TreeSnap;
    // The runner's own edit choice and commands (run.ts, between sessions), through this checkout's CLI.
    const tickets = Object.keys(kill.files).filter((f) => f.startsWith(".story/tickets/")).map((f) => json(kill.files as Record<string, string>, f));
    const edits = ownerEdits(tickets);
    expect(edits).not.toBeNull();
    const cli = (args: string[]) => spawnSync(process.execPath, [join(PKG, "dist", "cli.js"), ...args], { cwd: p.root, env: { PATH: process.env.PATH ?? "", HOME: join(scratch, "home"), GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf-8" });
    expect(cli(["ticket", "update", edits!.edgeTicket, "--add-blocked-by", edits!.blocker]).status).toBe(0);
    expect(cli(["ticket", "update", edits!.describedTicket, "--description", edits!.description]).status).toBe(0);
    const edited = parseTreeSnap(treeSnapshot(p.root));
    expect(edited).not.toEqual(kill);
    expect(editedSnapshotFindings(kill, edited, edits!)).toEqual([]);
    // On this package setup already wired the edge the runner's edit names (K13 behind K17), so the edge edit adds
    // nothing; the rule takes an edge already there as kept.
    expect((json(edited.files as Record<string, string>, ".story/tickets/T-002.json").blockedBy as string[])).toContain("T-001");
    // A change the harness did not record is found: a file no edit names, and a field no edit names.
    const rogue = Object.keys(edited.files).find((f) => f.startsWith(".story/tickets/") && edited.files[f] === kill.files[f] && f !== ".story/tickets/T-002.json")!;
    const t = json(edited.files as Record<string, string>, rogue);
    const tampered = { ...edited, files: { ...edited.files, [rogue]: Buffer.from(JSON.stringify({ ...t, title: "renamed" })).toString("base64") } };
    expect(editedSnapshotFindings(kill, tampered, edits!)).toEqual([`interrupted-edited: ${rogue} differs between the kill snapshot and the edited snapshot, and no owner edit names it`]);
    const t1 = json(edited.files as Record<string, string>, ".story/tickets/T-001.json");
    const renamed = { ...edited, files: { ...edited.files, ".story/tickets/T-001.json": Buffer.from(JSON.stringify({ ...t1, title: "renamed" })).toString("base64") } };
    expect(editedSnapshotFindings(kill, renamed, edits!)).toEqual(["interrupted-edited: .story/tickets/T-001.json changed title, which the owner edits do not name"]);
  });

  it("markers are per id: with only the first marker, the second entry fires only under its own id, never under the first's", async () => {
    // Session 2 armed with the first entry's id (a swapped id): its marker exists, so nothing fires and session 2 finishes.
    const p = project();
    expect((await session(p, { session: 1, id: "a", selector: "bootstrap:publish" }, payload())).signal).toBe("SIGKILL");
    const second = await session(p, { session: 2, id: "a", selector: "recovery:bootstrap:manifest-removed" }, null);
    expect([second.status, applied(second.stdout)]).toEqual([0, `Setup applied: ${SID}`]);
    const log = parseEventsLog(readFileSync(p.events, "utf-8"));
    expect(firedOf(log).map((f) => [f.id, f.point])).toEqual([["a", "bootstrap:publish"]]);
    // The second entry did reach its point: under its own id it would have fired.
    expect(points(p.events)).toContain("recovery:bootstrap:manifest-removed");
    expect(existsSync(firedMarker(p.events, "b"))).toBe(false);
    expect(scheduleFindings("interrupted", [{ session: 1, id: "a", selector: "bootstrap:publish", fired: true }, { session: 2, id: "b", selector: "recovery:bootstrap:manifest-removed", fired: false }], log, byAttempt(log)))
      .toEqual(["interrupted: the fault b (recovery:bootstrap:manifest-removed) never fired (no .fired.b marker after session 2)", "interrupted: the fault b has 0 fired records, not one"]);
  });

  it("a fired record is matched to its entry by id, never by selector: a record under another id with the entry's selector does not count", () => {
    const rec = (id: string, selector: string): EventsFired => ({ line: 1, attempt: "x", id, selector, point: selector, target: null, invocation: null } as unknown as EventsFired);
    const log = { fired: [rec("z", "bootstrap:publish")] } as unknown as Parameters<typeof scheduleFindings>[2];
    expect(scheduleFindings("interrupted", [{ session: 1, id: "a", selector: "bootstrap:publish", fired: true }], log, () => 1))
      .toEqual(["interrupted: the fault a has 0 fired records, not one", "interrupted: a fired record for z, which the schedule does not hold"]);
  });

  it("P5: a fired record is attributed to its session through its attempt and invocation; a swapped session or no matching invocation is refused", () => {
    const fired = { line: 1, attempt: "att-1", id: "a", selector: "bootstrap:publish", point: "bootstrap:publish", target: null, invocation: "inv-1" } as EventsFired;
    const log = { fired: [fired] } as unknown as Parameters<typeof scheduleFindings>[2];
    const entry = [{ session: 1, id: "a", selector: "bootstrap:publish", fired: true }];
    const mapping = (turn: number) => [{ turn, call: 0, attempt: "att-1", invocation: "inv-1", kind: "cli", exitCode: null }];
    const spans = [{ session: 1, turns: [0, 1] as const, calls: [0, 1] as const }, { session: 2, turns: [1, 2] as const, calls: [1, 2] as const }] as unknown as Parameters<typeof firedSessionFrom>[1];
    expect(scheduleFindings("interrupted", entry, log, firedSessionFrom(mapping(0), spans))).toEqual([]);
    expect(scheduleFindings("interrupted", entry, log, firedSessionFrom(mapping(1), spans))).toEqual(["interrupted: the fault a fired in session 2, not session 1"]);
    expect(scheduleFindings("interrupted", entry, log, firedSessionFrom([], spans))).toEqual(["interrupted: the fault a's fired record matches no invocation of the run (attempt att-1, invocation inv-1)"]);
    const noInvocation = { fired: [{ ...fired, invocation: null }] } as unknown as Parameters<typeof scheduleFindings>[2];
    expect(scheduleFindings("interrupted", entry, noInvocation, firedSessionFrom(mapping(0), spans))).toEqual(["interrupted: the fault a's fired record matches no invocation of the run (attempt att-1, invocation none)"]);
  });

  it("create and wiring cannot stand in for each other: the wiring selector on a package with no edges never fires and reports the class unreachable", async () => {
    const p = project();
    const flat = payload({ tickets: [{ key: "K17", title: "Watering rota", type: "feature", phase: "K11", description: "d", blockedBy: [] }], checkpoints: [], coverage: [{ requirement: "R1", text: "a rota", source: "brief", keys: ["K17"] }] });
    const r = await session(p, { session: 1, id: "f1", selector: "step:wire:*" }, flat);
    expect([r.status, applied(r.stdout)]).toEqual([0, `Setup applied: ${SID}`]);
    const log = parseEventsLog(readFileSync(p.events, "utf-8"));
    expect(firedOf(log)).toEqual([]);
    expect(points(p.events)).toContain("step:item:K17");
    expect(points(p.events).some((pt) => pt.startsWith("step:wire:"))).toBe(false);
    expect(scheduleFindings("interrupted", [scheduleFact({ session: 1, id: "f1", selector: "step:wire:*" }, p.events)], log, byAttempt(log)))
      .toContain("interrupted: the fault f1 (step:wire:*) never fired (no .fired.f1 marker after session 1)");
  });
});
