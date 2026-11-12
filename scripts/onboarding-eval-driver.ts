/**
 * T-538 commit 4 (plan v5 section 7, Addendum D): the matrix driver. It runs the cells of one manifest for one
 * arm, in order, and keeps a journal that a restart reads to decide what is finished, what may still be running
 * and what must not be repeated.
 *
 *   node --import tsx scripts/onboarding-eval-driver.ts --root <driver dir> --arm codex|claude
 *     [--unlock --reason <text>] [--close <attempt> --ruling <text>] [--replace <cell> --reason <text>]
 *     [--ack <cell> --note <text>] [--results <out.md> --plan <plan.md> --date <YYYY-MM-DD>]
 *
 * The journal: `<root>/attempts/<cell>-<arm>-<n>/`, created by exclusive mkdir, holds `intent.json`, then per
 * phase `<phase>.start.json`, `<phase>.spawn.json` (process phases only) and `<phase>.done.json`, then
 * `outcome.json`; every file goes through a temporary name, an fsync, a rename and a folder fsync. Every start
 * that finds an attempt unfinished writes `recovered-<n>.json` before deciding anything. Budgets are charged
 * from the journal's own times; `<root>/budget.json` is a cache rebuilt at every start and never read back.
 *
 * The core (`runArm` and the helpers it calls) takes its clock, its process runner and its liveness checks as
 * dependencies; the command line wires the real ones.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordedGroupAlive, runInGroup } from "../src/core/process-group.js";
import { GROUPS_FILE_ENV, readGroups, realSweepSignals, sweepGroups, type SweepSignals } from "./onboarding-eval-groups.js";
import { readRevisions } from "./onboarding-eval-regrade.js";
import { leftoverCheck } from "./onboarding-eval-host.js";
import { scanForCredentials } from "./onboarding-eval-review.js";
import { evalInputDigest } from "./build-eval.mjs";
import type { RunnerResult } from "./onboarding-eval-runner-result.js";
import { claudeProbe, codexProbe, PROBE_PROMPT_TEMPLATE, PROBE_SHA256, type ProbeTargets, type ProbeTurnResult } from "./onboarding-eval-probe.js";
import { unconditionalSignedInRefusal } from "./continuity-signed-in.js";

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------------------------
// 7.1 The manifest

export type Arm = "codex" | "claude";
export const ARMS: readonly Arm[] = ["codex", "claude"];
export interface Cell { readonly id: string; readonly case: string; readonly fixture: string; readonly variant: string; readonly checkSet: number; readonly schedule?: string; readonly gateAfter?: boolean }
/** T-538 signed-in note section 2: the codex arm runs fresh; the claude arm is pinned signed-in, and both of its forms are refused for now. */
export type Isolation = "fresh" | "signed-in";
export interface ClientPin { readonly version: string; readonly model: string; readonly judgeModel: string; readonly isolation: Isolation }
export interface Manifest {
  readonly id: string; readonly commit: string; readonly evalBundleDigest: string; readonly toolListSha256: string; readonly probeSha256: string;
  readonly clients: Readonly<Record<Arm, ClientPin>>;
  readonly limits: { readonly turnMs: number; readonly attemptMs: number; readonly armMs: number };
  readonly cells: readonly Cell[];
}

/** The repository path of the manifest; Addendum D: it is read from HEAD's blob, never from the working tree. */
export const MANIFEST_PATH = "scripts/onboarding-eval-matrix.json";

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Parses and checks the manifest's shape; throws naming the first problem. */
export function parseManifest(bytes: Buffer | string, o: { readonly requireIsolation?: boolean } = {}): Manifest {
  let m: Record<string, unknown>;
  try { m = JSON.parse(bytes.toString()) as Record<string, unknown>; } catch (e) { throw new Error(`the manifest is not JSON: ${(e as Error).message}`); }
  const bad = (what: string): never => { throw new Error(`the manifest ${what}`); };
  if (typeof m !== "object" || m === null || Array.isArray(m)) bad("is not an object");
  for (const k of ["id", "evalBundleDigest", "toolListSha256", "probeSha256"] as const) if (!isStr(m[k])) bad(`has no ${k}`);
  if (typeof m.commit !== "string" || !/^[0-9a-f]{40}$/.test(m.commit)) bad("commit is not a full commit id");
  const clients = m.clients as Record<string, Record<string, unknown>> | undefined;
  for (const a of ARMS) {
    const c = clients?.[a];
    if (!c || !isStr(c.version) || !isStr(c.model) || !isStr(c.judgeModel)) bad(`clients.${a} needs version, model and judgeModel`);
  }
  // Section 2: a manifest from before the isolation pin is historical fresh; its bytes and digest are not touched.
  for (const a of ARMS) {
    const iso = clients![a]!.isolation;
    if (iso === undefined && o.requireIsolation === true) bad(`clients.${a}.isolation is missing; a new manifest pins it`);
    if (iso !== undefined && iso !== "fresh" && !(a === "claude" && iso === "signed-in")) bad(`clients.${a}.isolation is ${JSON.stringify(iso)}, not ${a === "codex" ? "fresh" : "fresh or signed-in"}`);
  }
  const l = m.limits as Record<string, unknown> | undefined;
  if (!l || !isPosInt(l.turnMs) || !isPosInt(l.attemptMs) || !isPosInt(l.armMs)) bad("limits need turnMs, attemptMs and armMs");
  if (!Array.isArray(m.cells) || m.cells.length === 0) bad("has no cells");
  const seen = new Set<string>();
  for (const c of m.cells as Record<string, unknown>[]) {
    if (!isStr(c.id) || !/^[a-z0-9]+$/.test(c.id)) bad(`cell id ${JSON.stringify(c.id)} is not lower-case letters and digits`);
    if (seen.has(c.id as string)) bad(`cell ${c.id} appears twice`);
    seen.add(c.id as string);
    if (!isStr(c.case) || !isStr(c.fixture) || !isStr(c.variant) || !isPosInt(c.checkSet)) bad(`cell ${c.id} needs case, fixture, variant and checkSet`);
    if (c.schedule !== undefined && !isStr(c.schedule)) bad(`cell ${c.id} schedule is not text`);
    if (c.gateAfter !== undefined && typeof c.gateAfter !== "boolean") bad(`cell ${c.id} gateAfter is not true or false`);
  }
  const pinned = Object.fromEntries(ARMS.map((a) => [a, { ...clients![a]!, isolation: clients![a]!.isolation ?? "fresh" }]));
  return { ...(m as unknown as Manifest), clients: pinned as unknown as Manifest["clients"] };
}

/** What preflight needs from git, run in the package folder. */
export interface Git { (args: readonly string[]): { readonly ok: boolean; readonly out: string; readonly status?: number | null } }

/** A git answer used as preflight evidence: a failed call refuses, naming the operation, and is never read as an answer. */
function gitOut(git: Git, op: string, args: readonly string[]): string {
  const r = git(args);
  if (!r.ok) throw new Error(`preflight refused: git ${op} failed`);
  return r.out;
}

export function realGit(cwd: string): Git {
  return (args) => {
    const r = spawnSync("git", [...args], { cwd, encoding: "utf-8", env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" } });
    return { ok: r.status === 0, out: r.stdout ?? "", status: r.status };
  };
}

/**
 * Addendum D: the manifest from HEAD's blob, and the checkout's problems. HEAD is the manifest's `commit`, or a
 * descendant of it whose difference under the package folder is exactly the manifest file; nothing under the
 * package folder is uncommitted.
 */
export function readCheckout(git: Git): { readonly manifest: Manifest; readonly bytes: Buffer; readonly sha256: string; readonly problems: readonly string[] } {
  const prefix = git(["rev-parse", "--show-prefix"]);
  if (!prefix.ok) throw new Error("not inside a git checkout");
  const here = prefix.out.trim();
  const blob = git(["cat-file", "blob", `HEAD:${here}${MANIFEST_PATH}`]);
  if (!blob.ok) throw new Error(`HEAD has no ${here}${MANIFEST_PATH}`);
  const exact = Buffer.from(blob.out, "utf-8");
  const manifest = parseManifest(exact);
  const problems: string[] = [];
  const head = gitOut(git, "rev-parse HEAD", ["rev-parse", "HEAD"]).trim();
  if (head !== manifest.commit) {
    // --is-ancestor answers 1 for "not an ancestor"; any other failure is git failing, not an answer.
    const ancestor = git(["merge-base", "--is-ancestor", manifest.commit, "HEAD"]);
    if (!ancestor.ok && ancestor.status !== 1) throw new Error("preflight refused: git merge-base failed");
    if (!ancestor.ok) problems.push(`the manifest's commit ${manifest.commit} is not an ancestor of HEAD ${head}`);
    else {
      const changed = gitOut(git, "diff", ["diff", "--name-only", manifest.commit, "HEAD", "--", "."]).split("\n").filter(Boolean);
      const want = `${here}${MANIFEST_PATH}`;
      const other = changed.filter((p) => p !== want);
      if (other.length > 0) problems.push(`HEAD differs from the manifest's commit under ${here || "./"} in more than the manifest: ${other.slice(0, 5).join(", ")}`);
    }
  }
  const dirty = gitOut(git, "status", ["status", "--porcelain", "--untracked-files=all", "--", "."]).trim();
  if (dirty !== "") problems.push(`uncommitted changes under ${here || "./"}: ${dirty.split("\n").slice(0, 5).join("; ")}`);
  return { manifest, bytes: exact, sha256: sha256(exact), problems };
}

/**
 * Section 8's cells, in its order, for one manifest. Cell 11 (the older client) runs no model and is the
 * compatibility suite's row, so it is not a driver cell. Each interrupted cell arms session 1 with one fault.
 */
export const MATRIX_CELLS: readonly Cell[] = [
  { id: "1a", case: "empty directory, short idea", fixture: "empty-idea", variant: "none", checkSet: 7, gateAfter: true },
  { id: "6c", case: "interrupted setup", fixture: "empty-idea", variant: "interrupted", checkSet: 7, schedule: "1=f1:step:handover", gateAfter: true },
  { id: "1b", case: "short idea, verification", fixture: "empty-idea", variant: "empty-idea-verify", checkSet: 7 },
  { id: "2", case: "detailed brief", fixture: "brief-only", variant: "none", checkSet: 7 },
  { id: "3", case: "conflicting briefs, domain rules", fixture: "conflicting-briefs", variant: "none", checkSet: 7 },
  { id: "4", case: "existing partial app", fixture: "existing-partial", variant: "none", checkSet: 7 },
  { id: "5", case: "mixed stack", fixture: "mixed-stack", variant: "none", checkSet: 7 },
  { id: "7", case: "unavailable reviewer, explicit skip", fixture: "brief-only", variant: "reviewer-unavailable", checkSet: 7 },
  { id: "10", case: "restart", fixture: "empty-idea", variant: "restart", checkSet: 7 },
  { id: "89", case: "checkpoint states; targeting and status bypass", fixture: "checkpoint-states", variant: "milestone-states", checkSet: 7 },
  { id: "6a", case: "interrupted setup", fixture: "empty-idea", variant: "interrupted", checkSet: 7, schedule: "1=f1:bootstrap:manifest" },
  { id: "6b", case: "interrupted setup", fixture: "empty-idea", variant: "interrupted", checkSet: 7, schedule: "1=f1:step:item:*" },
  { id: "6d", case: "interrupted and edited", fixture: "empty-idea", variant: "interrupted-edited", checkSet: 7, schedule: "1=f1:step:handover" },
];

/** The manifest for HEAD: its commit, the bundle digest and tool list sha256 of this package, the given pins. */
export function generateManifest(o: { readonly id: string; readonly commit: string; readonly evalBundleDigest: string; readonly toolListSha256: string; readonly probeSha256: string; readonly codexVersion: string; readonly claudeVersion: string }): Manifest {
  return parseManifest(JSON.stringify({
    id: o.id, commit: o.commit, evalBundleDigest: o.evalBundleDigest, toolListSha256: o.toolListSha256, probeSha256: o.probeSha256,
    clients: { codex: { version: o.codexVersion, model: "gpt-6-astra", judgeModel: "gpt-6-astra", isolation: "fresh" }, claude: { version: o.claudeVersion, model: "opus", judgeModel: "gpt-6-astra", isolation: "signed-in" } },
    limits: { turnMs: 40 * 60_000, attemptMs: 210 * 60_000, armMs: 10 * 3_600_000 },
    cells: MATRIX_CELLS,
  }), { requireIsolation: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Durable writes

/** The folder fsync every journal write and folder creation ends with; a test seam, not reachable from any input. */
export const journalFs: { fsyncDir: (dir: string) => void } = {
  fsyncDir: (dir) => { const d = openSync(dir, "r"); try { fsyncSync(d); } finally { closeSync(d); } },
};

/**
 * Creates `path` (and any missing parents). Each folder created is followed by an fsync of its parent, so the
 * new entry survives a crash before anything is written into it. `exclusive` refuses an existing `path` (EEXIST).
 */
export function mkdirDurable(path: string, exclusive = false): void {
  const missing: string[] = [];
  for (let p = path; !existsSync(p); p = dirname(p)) { missing.unshift(p); if (dirname(p) === p) break; }
  if (exclusive && missing.at(-1) !== path) throw Object.assign(new Error(`${path} already exists`), { code: "EEXIST" });
  for (const p of missing) {
    mkdirSync(p);
    journalFs.fsyncDir(dirname(p));
  }
}

/** Writes JSON to `dir/name` through `.name.tmp-<pid>` (exclusive), an fsync, a rename and a folder fsync. */
export function writeJournal(dir: string, name: string, value: unknown, exclusive = false): void {
  const path = join(dir, name);
  if (exclusive && existsSync(path)) throw Object.assign(new Error(`${path} already exists`), { code: "EEXIST" });
  const tmp = join(dir, `.${name}.tmp-${process.pid}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
    for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* the write failure is what is reported */ }
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
  journalFs.fsyncDir(dir);
}

const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
};

// ---------------------------------------------------------------------------------------------------------------
// 7.2 The lock

export interface LockFile { readonly pid: number; readonly start: string }

/** Takes `<root>/lock` by exclusive create; refuses when it exists, naming its holder. */
export function acquireLock(root: string, pid: number, now: number): void {
  const path = join(root, "lock");
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const held = readJson<LockFile>(path);
    throw new Error(`the driver is locked by pid ${held?.pid ?? "?"} since ${held?.start ?? "?"}; a stale lock is cleared only by --unlock --reason <text>`);
  }
  try { writeSync(fd, `${JSON.stringify({ pid, start: new Date(now).toISOString() })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

export function releaseLock(root: string, pid: number): void {
  const path = join(root, "lock");
  if (readJson<LockFile>(path)?.pid === pid) unlinkSync(path);
}

/** `--unlock --reason`: only when the holder is gone; the clearing is recorded under `<root>/unlocks/`. */
export function unlock(root: string, reason: string, alive: (pid: number) => boolean, now: number): void {
  const path = join(root, "lock");
  if (!existsSync(path)) throw new Error("there is no lock to clear");
  const held = readJson<LockFile>(path);
  if (held !== null && alive(held.pid)) throw new Error(`the lock's pid ${held.pid} is still running; the lock is not cleared`);
  mkdirDurable(join(root, "unlocks"));
  writeJournal(join(root, "unlocks"), `${now}.json`, { at: new Date(now).toISOString(), reason, lock: held }, true);
  unlinkSync(path);
}

// ---------------------------------------------------------------------------------------------------------------
// 7.3 The journal

export const PHASES = ["run", "scan", "judge", "scan-judge", "finalize", "regrade"] as const;
export type Phase = (typeof PHASES)[number];
/** The phases that are a process of their own; `scan` and `scan-judge` are deterministic checks in the driver. */
export const PROCESS_PHASES: ReadonlySet<Phase> = new Set(["run", "judge", "finalize", "regrade"]);

export type Disposition = "quarantined" | "invalid" | "harness-defect" | "infrastructure" | "scored";
/** 7.3: first match wins. */
export const DISPOSITION_ORDER: readonly Disposition[] = ["quarantined", "invalid", "harness-defect", "infrastructure", "scored"];
export interface Flag { readonly kind: Exclude<Disposition, "scored">; readonly cause: string }

export function dispositionOf(flags: readonly Flag[]): { readonly disposition: Disposition; readonly cause: string | null } {
  for (const d of DISPOSITION_ORDER) {
    if (d === "scored") break;
    const f = flags.find((x) => x.kind === d);
    if (f) return { disposition: d, cause: f.cause };
  }
  return { disposition: "scored", cause: null };
}

export interface Intent { readonly cell: string; readonly arm: Arm; readonly n: number; readonly manifestSha256: string; readonly runId: string; readonly at: number; readonly attemptLeftMs: number; readonly armLeftMs: number }
export interface StartFile { readonly at: number; readonly deadlineMs: number; readonly artifacts: readonly string[]; readonly manifestSha256: string; readonly reservation?: unknown }
export interface SpawnFile { readonly pid: number; readonly pgid: number; readonly manifestSha256: string }
export interface DoneFile { readonly at: number; readonly flags: readonly Flag[]; readonly artifacts: Readonly<Record<string, string>>; readonly verdict: string | null; readonly observedModels: readonly string[]; readonly manifestSha256: string; readonly adopted?: boolean }
export interface OutcomeFile { readonly at: number; readonly disposition: Disposition; readonly cause: string | null; readonly verdict: string | null; readonly observedModels: readonly string[]; readonly manifestSha256: string; readonly cutoff?: string }
export interface Recovery { readonly at: number; readonly n: number }

export interface Attempt {
  readonly id: string; readonly dir: string; readonly cell: string; readonly arm: Arm; readonly n: number;
  readonly intent: Intent | null;
  readonly phases: Readonly<Record<Phase, { start: StartFile | null; spawn: SpawnFile | null; done: DoneFile | null }>>;
  readonly outcome: OutcomeFile | null;
  readonly recoveries: readonly Recovery[];
  readonly closed: { readonly ruling: string; readonly at: number } | null;
  readonly replaced: { readonly reason: string; readonly at: number } | null;
}

export const attemptId = (cell: string, arm: Arm, n: number): string => `${cell}-${arm}-${n}`;

export function readAttempt(dir: string): Attempt {
  const id = basename(dir);
  const m = /^([a-z0-9]+)-(codex|claude)-([1-9][0-9]*)$/.exec(id);
  if (!m) throw new Error(`${id} is not an attempt id`);
  const phases = Object.fromEntries(PHASES.map((p) => [p, {
    start: readJson<StartFile>(join(dir, `${p}.start.json`)),
    spawn: readJson<SpawnFile>(join(dir, `${p}.spawn.json`)),
    done: readJson<DoneFile>(join(dir, `${p}.done.json`)),
  }])) as Attempt["phases"];
  const recoveries = readdirSync(dir).filter((f) => /^recovered-[1-9][0-9]*\.json$/.test(f)).map((f) => readJson<Recovery>(join(dir, f))).filter((r): r is Recovery => r !== null).sort((a, b) => a.n - b.n);
  return {
    id, dir, cell: m[1]!, arm: m[2] as Arm, n: Number(m[3]),
    intent: readJson<Intent>(join(dir, "intent.json")),
    phases, outcome: readJson<OutcomeFile>(join(dir, "outcome.json")), recoveries,
    closed: readJson(join(dir, "closed.json")), replaced: readJson(join(dir, "replaced.json")),
  };
}

export function listAttempts(root: string, arm?: Arm): Attempt[] {
  const base = join(root, "attempts");
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((f) => !f.startsWith(".")).map((f) => readAttempt(join(base, f))).filter((a) => arm === undefined || a.arm === arm).sort((a, b) => (a.cell === b.cell ? a.n - b.n : a.cell < b.cell ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------
// 7.4 Budgets and deadlines

export const ATTEMPT_BUDGET_MS = 210 * 60_000;
export const ARM_BUDGET_MS = 10 * 3_600_000;
export const CLEANUP_RESERVE_MS = 60_000;

/** Local caps and floors, in minutes, for every operation the plan names. */
export const OPERATIONS = {
  turn: { cap: 40, floor: 5 },
  "served-review": { cap: 20, floor: 2 },
  judge: { cap: 30, floor: 10 },
  collector: { cap: 5, floor: 1 },
  scan: { cap: 10, floor: 1 },
  finalize: { cap: 5, floor: 1 },
  regrade: { cap: 5, floor: 1 },
  lsof: { cap: 1, floor: 1 },
} as const;
export type Operation = keyof typeof OPERATIONS;

/**
 * The operation each phase is charged as. `run` spans every turn of the conversation, so it has no local cap of
 * its own (each turn inside it is capped by the runner); it is floored as a turn, since no turn starts with less.
 */
export const PHASE_OPERATION: Readonly<Record<Phase, { readonly op: Operation; readonly capped: boolean }>> = {
  run: { op: "turn", capped: false }, scan: { op: "scan", capped: true }, judge: { op: "judge", capped: true },
  "scan-judge": { op: "scan", capped: true }, finalize: { op: "finalize", capped: true }, regrade: { op: "regrade", capped: true },
};

/** 7.4: the smallest of the local cap, the attempt's remainder less the cleanup reserve, and the arm's remainder. */
export function operationDeadline(op: Operation, attemptLeftMs: number, armLeftMs: number, capped = true): { readonly ok: true; readonly ms: number; readonly clampedBy: "cap" | "attempt" | "arm" } | { readonly ok: false; readonly cause: string } {
  const cap = capped ? OPERATIONS[op].cap * 60_000 : Number.POSITIVE_INFINITY;
  const attempt = attemptLeftMs - CLEANUP_RESERVE_MS;
  const ms = Math.min(cap, attempt, armLeftMs);
  if (ms < OPERATIONS[op].floor * 60_000) return { ok: false, cause: `budget: ${op}` };
  return { ok: true, ms, clampedBy: ms === cap ? "cap" : ms === attempt ? "attempt" : "arm" };
}

/** An attempt's charge: one interval from its intent to its terminal time, or to the later of its latest recovery and now. */
export function chargeOf(a: Attempt, now: number): number {
  if (a.intent === null) return 0;
  const end = a.outcome !== null ? a.outcome.at : Math.max(now, ...a.recoveries.map((r) => r.at));
  return Math.max(0, end - a.intent.at);
}

export interface Budget { readonly arm: Arm; readonly usedMs: number; readonly leftMs: number; readonly attempts: Readonly<Record<string, number>> }

/** The arm's budget rebuilt from the journal alone. */
export function budgetOf(attempts: readonly Attempt[], arm: Arm, now: number, armBudgetMs = ARM_BUDGET_MS): Budget {
  const mine = attempts.filter((a) => a.arm === arm);
  const per = Object.fromEntries(mine.map((a) => [a.id, chargeOf(a, now)]));
  const usedMs = Object.values(per).reduce((s, v) => s + v, 0);
  return { arm, usedMs, leftMs: armBudgetMs - usedMs, attempts: per };
}

// ---------------------------------------------------------------------------------------------------------------
// The core

export interface PhaseResult {
  readonly cleanup: "confirmed" | "unconfirmed";
  /** What was not confirmed gone, when the cleanup is unconfirmed. */
  readonly cleanupDetail?: string | null;
  readonly flags: readonly Flag[];
  /** Absolute path to sha256 of each artifact the phase wrote. */
  readonly artifacts: Readonly<Record<string, string>>;
  readonly verdict?: string | null;
  readonly observedModels?: readonly string[];
  /** A usage-limit message: the arm stops. */
  readonly usageLimit?: boolean;
}

export interface PhaseContext {
  readonly attempt: Attempt; readonly cell: Cell; readonly arm: Arm; readonly manifest: Manifest; readonly phase: Phase;
  readonly deadlineMs: number;
  /** Called by the executor straight after its process is spawned. */
  readonly onSpawn: (pid: number, pgid: number) => void;
}

export interface Executor {
  /** The artifact paths a phase will write, recorded in its start file. */
  artifactsOf(ctx: Omit<PhaseContext, "onSpawn" | "deadlineMs">): readonly string[];
  run(ctx: PhaseContext): Promise<PhaseResult>;
  /** The judge's result when it exists and is valid for the packet's sha256, else null. */
  adoptJudge(ctx: Omit<PhaseContext, "onSpawn" | "deadlineMs">): PhaseResult | null;
  /** The regrade inputs' hashes, reserved in `regrade.start.json`. */
  regradeReservation(ctx: Omit<PhaseContext, "onSpawn" | "deadlineMs">): unknown;
  /** A published revision whose evidence matches the reservation, else null; "mismatch" when one exists but differs. */
  adoptRegrade(ctx: Omit<PhaseContext, "onSpawn" | "deadlineMs">, reservation: unknown): PhaseResult | null | "mismatch";
}

export interface DriverDeps {
  readonly now: () => number;
  /** `kill(-pgid, 0)` answers alive. */
  readonly groupAlive: (pgid: number) => boolean;
  /** 5.1's leftover test for an attempt: true when nothing is left. */
  readonly leftoverClean: (attempt: Attempt) => boolean;
  readonly executor: Executor;
  /** Test seam: called after every journal write with the boundary's name; a throw is a crash at that point. */
  readonly crashAt?: (boundary: string) => void;
  /** The attempt and arm budgets; the plan's numbers unless a test narrows them. */
  readonly attemptBudgetMs?: number;
  readonly armBudgetMs?: number;
}

export type ArmStop =
  | { readonly kind: "done" }
  | { readonly kind: "stopped"; readonly attempt: string; readonly disposition: Disposition; readonly cause: string | null; readonly lift: "--close" | "--replace or --close" | "usage limit: the arm stops" }
  | { readonly kind: "gate"; readonly cell: string; readonly ack: string };

export const gatePath = (root: string, cell: string, arm: Arm): string => join(root, "gates", `${cell}-${arm}.ack`);

/** The next attempt folder for a cell, created by exclusive mkdir. */
function newAttempt(root: string, cell: string, arm: Arm, n: number): string {
  const dir = join(root, "attempts", attemptId(cell, arm, n));
  // The attempt folder and attempts/ itself are fsynced into their parents before anything starts.
  mkdirDurable(join(root, "attempts"));
  mkdirDurable(dir, true);
  return dir;
}

const hashFile = (p: string): string | null => existsSync(p) ? sha256(readFileSync(p)) : null;

/** Runs the arm's cells in order until one stops it or all are done. */
export async function runArm(root: string, manifest: Manifest, manifestSha: string, arm: Arm, deps: DriverDeps): Promise<ArmStop> {
  const crash = (b: string): void => deps.crashAt?.(b);
  const attemptBudget = deps.attemptBudgetMs ?? ATTEMPT_BUDGET_MS;
  const armBudget = deps.armBudgetMs ?? ARM_BUDGET_MS;
  const all = (): Attempt[] => listAttempts(root);
  for (const a of all()) {
    if (a.intent !== null && a.intent.manifestSha256 !== manifestSha) throw new Error(`the manifest differs from the journal's (attempt ${a.id} ran under ${a.intent.manifestSha256}); a changed manifest is a new matrix id and a new driver folder`);
  }
  // Every start that finds an attempt unfinished records the time first.
  for (const a of all().filter((x) => x.arm === arm && x.outcome === null && x.intent !== null)) {
    const n = a.recoveries.length + 1;
    writeJournal(a.dir, `recovered-${n}.json`, { at: deps.now(), n }, true);
    crash(`${a.id}:recovered-${n}`);
  }
  writeJournal(root, "budget.json", budgetOf(all(), arm, deps.now(), armBudget));

  for (const cell of manifest.cells) {
    const mine = all().filter((a) => a.arm === arm && a.cell === cell.id);
    let last = mine[mine.length - 1];
    if (last !== undefined && last.outcome !== null) {
      if (last.outcome.disposition === "scored" || last.closed !== null) {
        if (cell.gateAfter && last.outcome.disposition === "scored" && !existsSync(gatePath(root, cell.id, arm))) return { kind: "gate", cell: cell.id, ack: gatePath(root, cell.id, arm) };
        continue;
      }
      if (last.replaced === null) return stopFor(last);
      last = undefined; // replaced: a new attempt follows
    }
    let attempt: Attempt;
    if (last === undefined) {
      const n = (mine[mine.length - 1]?.n ?? 0) + 1;
      const dir = newAttempt(root, cell.id, arm, n);
      const now = deps.now();
      const budget = budgetOf(all(), arm, now, armBudget);
      writeJournal(dir, "intent.json", { cell: cell.id, arm, n, manifestSha256: manifestSha, runId: `${cell.id}-${arm}-${n}-${now}`, at: now, attemptLeftMs: attemptBudget, armLeftMs: budget.leftMs } satisfies Intent, true);
      crash(`${attemptId(cell.id, arm, n)}:intent`);
      attempt = readAttempt(dir);
    } else {
      attempt = last;
      if (attempt.intent === null) {
        // The folder exists and its intent never landed: nothing started, so nothing can be running.
        const now = deps.now();
        writeJournal(attempt.dir, "intent.json", { cell: cell.id, arm, n: attempt.n, manifestSha256: manifestSha, runId: `${cell.id}-${arm}-${attempt.n}-${now}`, at: now, attemptLeftMs: attemptBudget, armLeftMs: budgetOf(all(), arm, now, armBudget).leftMs } satisfies Intent, true);
        crash(`${attempt.id}:intent`);
        attempt = readAttempt(attempt.dir);
      }
    }
    const outcome = await driveAttempt(attempt, cell, manifest, manifestSha, arm, deps, attemptBudget, armBudget, all);
    writeJournal(root, "budget.json", budgetOf(all(), arm, deps.now(), armBudget));
    if (outcome.disposition !== "scored") return stopFor(readAttempt(attempt.dir));
    if (cell.gateAfter && !existsSync(gatePath(root, cell.id, arm))) return { kind: "gate", cell: cell.id, ack: gatePath(root, cell.id, arm) };
  }
  return { kind: "done" };
}

function stopFor(a: Attempt): ArmStop {
  const o = a.outcome!;
  const lift = o.disposition === "infrastructure" ? (o.cause === "usage limit" ? "usage limit: the arm stops" : "--replace or --close") : "--close";
  return { kind: "stopped", attempt: a.id, disposition: o.disposition, cause: o.cause, lift };
}

async function driveAttempt(start: Attempt, cell: Cell, manifest: Manifest, manifestSha: string, arm: Arm, deps: DriverDeps, attemptBudget: number, armBudget: number, all: () => Attempt[]): Promise<OutcomeFile> {
  const crash = (b: string): void => deps.crashAt?.(b);
  let a = start;
  const flags: Flag[] = [];
  let verdict: string | null = null;
  const models = new Set<string>();
  const finish = (extra?: Flag, cutoff?: string): OutcomeFile => {
    if (extra) flags.push(extra);
    const d = dispositionOf(flags);
    const at = cutoff !== undefined && a.recoveries.length > 0 ? a.recoveries[a.recoveries.length - 1]!.at : deps.now();
    const o: OutcomeFile = { at, disposition: d.disposition, cause: d.cause, verdict, observedModels: [...models].sort(), manifestSha256: manifestSha, ...(cutoff !== undefined ? { cutoff } : {}) };
    writeJournal(a.dir, "outcome.json", o, true);
    crash(`${a.id}:outcome`);
    return o;
  };
  const base = (phase: Phase) => ({ attempt: a, cell, arm, manifest, phase });
  for (const phase of PHASES) {
    a = readAttempt(a.dir);
    const p = a.phases[phase];
    if (p.done !== null) {
      // Not repeated when its artifacts hash as recorded; anything else is inconsistent. No phase rewrites another
      // phase's recorded artifact: the scan records its own pinned copy of record.json, which finalize rewrites.
      for (const [path, h] of Object.entries(p.done.artifacts)) {
        if (hashFile(path) !== h) return finish({ kind: "quarantined", cause: `${phase}: the artifact ${path} no longer hashes as recorded` }, `recovered-${a.recoveries.length}.json`);
      }
      flags.push(...p.done.flags);
      if (p.done.verdict !== null) verdict = p.done.verdict;
      for (const m of p.done.observedModels) models.add(m);
      if (p.done.flags.length > 0) return finish();
      continue;
    }
    let reservation: unknown;
    if (p.start !== null) {
      const cutoff = `recovered-${a.recoveries.length}.json`;
      if (PROCESS_PHASES.has(phase)) {
        if (p.spawn === null) return finish({ kind: "quarantined", cause: `${phase}: started with no spawn record, so its process cannot be named` }, cutoff);
        if (deps.groupAlive(p.spawn.pgid)) return finish({ kind: "quarantined", cause: `${phase}: the recorded process group ${p.spawn.pgid} still exists` }, cutoff);
        // 7.4: the groups the runner or judge recorded under it, too.
        const nested = readGroups(join(a.dir, `${phase}.groups.jsonl`));
        if (nested.problems.length > 0) return finish({ kind: "quarantined", cause: `${phase}: ${nested.problems[0]}` }, cutoff);
        if (nested.unresolved.length > 0) return finish({ kind: "quarantined", cause: `${phase}: the launch ${nested.unresolved[0]} recorded no process group` }, cutoff);
        const live = nested.groups.find((g) => deps.groupAlive(g.pgid));
        if (live !== undefined) return finish({ kind: "quarantined", cause: `${phase}: the recorded child group ${live.pgid} still exists` }, cutoff);
        if (!deps.leftoverClean(a)) return finish({ kind: "quarantined", cause: `${phase}: the leftover test is not clean` }, cutoff);
        if (phase === "run") return finish({ kind: "quarantined", cause: "run: a half-run conversation is not evidence and is never run again" }, cutoff);
        if (phase === "judge") {
          const adopted = deps.executor.adoptJudge(base(phase));
          if (adopted === null) return finish({ kind: "quarantined", cause: "judge: no valid result to adopt; the judge is not asked a second time" }, cutoff);
          writeDone(a, phase, adopted, manifestSha, deps, true);
          crash(`${a.id}:${phase}.done`);
          flags.push(...adopted.flags);
          if (adopted.verdict != null) verdict = adopted.verdict;
          for (const m of adopted.observedModels ?? []) models.add(m);
          if (adopted.flags.length > 0) return finish();
          continue;
        }
        if (phase === "regrade") {
          const got = deps.executor.adoptRegrade(base(phase), p.start.reservation);
          if (got === "mismatch") return finish({ kind: "quarantined", cause: "regrade: a published revision does not match its reservation" }, cutoff);
          if (got !== null) {
            writeDone(a, phase, got, manifestSha, deps, true);
            crash(`${a.id}:${phase}.done`);
            flags.push(...got.flags);
            if (got.flags.length > 0) return finish();
            continue;
          }
          reservation = p.start.reservation;
        }
        // finalize, and a regrade with no published revision: deterministic, run again below.
      }
      // scan and scan-judge: deterministic, run again below.
    }
    // A fresh start of the phase (or a deterministic rerun).
    const now = deps.now();
    const attemptLeft = attemptBudget - (now - a.intent!.at);
    const armLeft = budgetOf(all(), arm, now, armBudget).leftMs;
    const op = PHASE_OPERATION[phase];
    const dl = operationDeadline(op.op, attemptLeft, armLeft, op.capped);
    if (!dl.ok) return finish({ kind: "infrastructure", cause: dl.cause });
    if (p.start === null) {
      reservation = phase === "regrade" ? deps.executor.regradeReservation(base(phase)) : undefined;
      writeJournal(a.dir, `${phase}.start.json`, { at: now, deadlineMs: dl.ms, artifacts: deps.executor.artifactsOf(base(phase)), manifestSha256: manifestSha, ...(reservation !== undefined ? { reservation } : {}) } satisfies StartFile, true);
      crash(`${a.id}:${phase}.start`);
    }
    const spawnName = `${phase}.spawn.json`;
    const result = await deps.executor.run({
      ...base(phase), deadlineMs: dl.ms,
      onSpawn: (pid, pgid) => {
        if (!PROCESS_PHASES.has(phase)) return;
        // A rerun after a confirmed-gone group replaces the old spawn record through the same atomic write.
        if (existsSync(join(a.dir, spawnName))) unlinkSync(join(a.dir, spawnName));
        writeJournal(a.dir, spawnName, { pid, pgid, manifestSha256: manifestSha } satisfies SpawnFile, true);
        crash(`${a.id}:${phase}.spawn`);
      },
    });
    const ended = deps.now();
    crash(`${a.id}:${phase}.ended`);
    const extra: Flag[] = [];
    if (result.cleanup !== "confirmed") extra.push({ kind: "quarantined", cause: `${phase}: the process group was not confirmed gone${result.cleanupDetail ? ` (${result.cleanupDetail})` : ""}` });
    if (ended - now > dl.ms) extra.push({ kind: "infrastructure", cause: `deadline: ${phase}` });
    if (result.usageLimit) extra.push({ kind: "infrastructure", cause: "usage limit" });
    const done: PhaseResult = { ...result, flags: [...result.flags, ...extra] };
    // A done file is written only once the phase's cleanup is confirmed.
    if (result.cleanup !== "confirmed") { flags.push(...done.flags.filter((f) => f.kind !== "quarantined")); return finish(extra[0]); }
    writeDone(a, phase, done, manifestSha, deps, false);
    crash(`${a.id}:${phase}.done`);
    flags.push(...done.flags);
    if (done.verdict != null) verdict = done.verdict;
    for (const m of done.observedModels ?? []) models.add(m);
    if (done.flags.length > 0) return finish();
  }
  return finish();
}

function writeDone(a: Attempt, phase: Phase, r: PhaseResult, manifestSha: string, deps: DriverDeps, adopted: boolean): void {
  writeJournal(a.dir, `${phase}.done.json`, { at: deps.now(), flags: r.flags, artifacts: r.artifacts, verdict: r.verdict ?? null, observedModels: r.observedModels ?? [], manifestSha256: manifestSha, ...(adopted ? { adopted } : {}) } satisfies DoneFile, true);
}

// ---------------------------------------------------------------------------------------------------------------
// Closing, replacing, acknowledging

export function closeAttempt(root: string, id: string, ruling: string, now: number): void {
  const dir = join(root, "attempts", id);
  if (!existsSync(join(dir, "outcome.json"))) throw new Error(`attempt ${id} has no outcome to close`);
  writeJournal(dir, "closed.json", { ruling, at: now }, true);
}

export const REPLACEMENTS_PER_CELL = 1;
export const REPLACEMENTS_PER_ARM = 3;

export function replaceCell(root: string, cell: string, arm: Arm, reason: string, now: number): string {
  const mine = listAttempts(root, arm);
  const ofCell = mine.filter((a) => a.cell === cell);
  const last = ofCell[ofCell.length - 1];
  if (last === undefined || last.outcome === null) throw new Error(`cell ${cell} has no finished attempt on the ${arm} arm to replace`);
  if (last.outcome.disposition === "scored") throw new Error(`attempt ${last.id} is scored; a scored attempt is never replaced`);
  if (last.closed !== null) throw new Error(`attempt ${last.id} is closed`);
  if (ofCell.filter((a) => a.replaced !== null).length >= REPLACEMENTS_PER_CELL) throw new Error(`cell ${cell} has had its ${REPLACEMENTS_PER_CELL} replacement on the ${arm} arm`);
  if (mine.filter((a) => a.replaced !== null).length >= REPLACEMENTS_PER_ARM) throw new Error(`the ${arm} arm has had its ${REPLACEMENTS_PER_ARM} replacements`);
  writeJournal(last.dir, "replaced.json", { reason, at: now }, true);
  return attemptId(cell, arm, last.n + 1);
}

export function ackGate(root: string, cell: string, arm: Arm, note: string, now: number): void {
  mkdirDurable(join(root, "gates"));
  writeJournal(join(root, "gates"), basename(gatePath(root, cell, arm)), { note, at: now }, true);
}

/** 7.2: an open quarantine is one with no closure. */
export const openQuarantines = (root: string): string[] => listAttempts(root).filter((a) => a.outcome?.disposition === "quarantined" && a.closed === null).map((a) => a.id);

// ---------------------------------------------------------------------------------------------------------------
// 7.5 Results

/** The plan sections the results carry in full: 3, 9 and 10, cut from the plan text by their headings. */
export function planSection(plan: string, n: number): string {
  const start = plan.search(new RegExp(`^## ${n}\\. `, "m"));
  if (start < 0) throw new Error(`the plan has no section ${n}`);
  const rest = plan.slice(start + 1);
  const end = rest.search(/^## /m);
  return (end < 0 ? plan.slice(start) : plan.slice(start, start + 1 + end)).trimEnd();
}

export function renderResults(root: string, manifest: Manifest, manifestSha: string, plan: string, date: string, now: number): string {
  const attempts = listAttempts(root);
  const lines: string[] = [];
  lines.push(`# T-538 host run results, ${date}`, "", `Matrix ${manifest.id}, manifest sha256 ${manifestSha}, code commit ${manifest.commit}.`, "");
  lines.push("## Attempts", "", "| Attempt | Disposition | Cause | Verdict | Observed models | Charged minutes | Closed | Replaced |", "|---|---|---|---|---|---|---|---|");
  for (const a of attempts) {
    const o = a.outcome;
    lines.push(`| ${a.id} | ${o?.disposition ?? "unfinished"} | ${o?.cause ?? ""} | ${o?.verdict ?? ""} | ${o?.observedModels.join(", ") ?? ""} | ${Math.round(chargeOf(a, now) / 60_000)} | ${a.closed?.ruling ?? ""} | ${a.replaced?.reason ?? ""} |`);
  }
  for (const arm of ARMS) {
    const b = budgetOf(attempts, arm, now);
    lines.push("", `${arm} arm: ${Math.round(b.usedMs / 60_000)} minutes charged.`);
  }
  lines.push("", "## Content hashes", "");
  for (const a of attempts) {
    for (const ph of PHASES) {
      const d = a.phases[ph].done;
      if (!d) continue;
      for (const [path, h] of Object.entries(d.artifacts).sort()) lines.push(`- ${a.id} ${ph}: ${basename(path)} ${h}`);
    }
  }
  lines.push("", "## Evidence paths", "", ...attempts.map((a) => `- ${a.id}: attempts/${a.id}/`));
  for (const n of [3, 9, 10]) lines.push("", planSection(plan, n).replace(/^## /, "## Plan "));
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// The command line

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function freeBytes(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

export const FREE_SPACE_MIN = 20 * 1024 ** 3;

function flagValue(argv: readonly string[], k: string): string | undefined {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function cli(argv: readonly string[], deps: { pkg: string; now: () => number; alive: (pid: number) => boolean; out: (s: string) => void; preflight: (m: Manifest, root: string, arm: Arm) => Promise<string[]>; arm: (root: string, m: Manifest, sha: string, arm: Arm) => Promise<ArmStop>; git: Git }): Promise<number> {
  const need = (k: string): string => { const v = flagValue(argv, k); if (!v || v.startsWith("--")) throw new Error(`--${k} <text> is required`); return v; };
  if (argv.includes("--write-manifest")) {
    const head = deps.git(["rev-parse", "HEAD"]);
    const here = deps.git(["rev-parse", "--show-prefix"]);
    if (!head.ok || !here.ok) throw new Error("not inside a git checkout");
    const dirty = gitOut(deps.git, "status", ["status", "--porcelain", "--untracked-files=all", "--", "."]).trim();
    if (dirty !== "") throw new Error(`uncommitted changes under the package; the manifest names a clean HEAD: ${dirty.split("\n")[0]}`);
    const commit = head.out.trim();
    const m = generateManifest({ id: need("id"), commit, evalBundleDigest: evalInputDigest(deps.pkg), toolListSha256: sha256(readFileSync(join(deps.pkg, "scripts", "onboarding-eval-tools.json"))), probeSha256: PROBE_SHA256, codexVersion: need("codex-version"), claudeVersion: need("claude-version") });
    writeJournalText(join(deps.pkg, MANIFEST_PATH), `${JSON.stringify(m, null, 2)}\n`);
    deps.out(`wrote ${MANIFEST_PATH} for ${commit}\n`);
    return 0;
  }
  const root = flagValue(argv, "root");
  const arm = flagValue(argv, "arm") as Arm | undefined;
  if (!root) throw new Error("--root <driver dir> is required");
  // T-538 signed-in note section 2: a claude arm run is refused before the root is created, git, preflight or any
  // spawn. Its pinned isolation is signed-in, refused on the shared gates, and a fresh claude arm is not admitted.
  const bookkeeping = ["--unlock", "--close", "--results", "--replace", "--ack"].some((f) => argv.includes(f));
  if (!bookkeeping && arm === "claude") throw new Error(`preflight refused: ${CLAUDE_ARM_REFUSAL}`);
  mkdirDurable(root);
  if (argv.includes("--unlock")) { unlock(root, need("reason"), deps.alive, deps.now()); deps.out("unlocked\n"); return 0; }
  if (argv.includes("--close")) { closeAttempt(root, need("close"), need("ruling"), deps.now()); deps.out("closed\n"); return 0; }
  const checkout = readCheckout(deps.git);
  if (argv.includes("--results")) {
    const text = renderResults(root, checkout.manifest, checkout.sha256, readFileSync(need("plan"), "utf-8"), need("date"), deps.now());
    writeJournalText(need("results"), text);
    return 0;
  }
  if (arm !== "codex" && arm !== "claude") throw new Error("--arm must be codex or claude");
  if (argv.includes("--replace")) { deps.out(`next attempt ${replaceCell(root, need("replace"), arm, need("reason"), deps.now())}\n`); return 0; }
  if (argv.includes("--ack")) { ackGate(root, need("ack"), arm, need("note"), deps.now()); deps.out("acknowledged\n"); return 0; }
  acquireLock(root, process.pid, deps.now());
  try {
    const problems = [...checkout.problems, ...(await deps.preflight(checkout.manifest, root, arm))];
    if (problems.length > 0) { deps.out(`preflight refused:\n${problems.map((p) => `- ${p}`).join("\n")}\n`); return 2; }
    const stop = await deps.arm(root, checkout.manifest, checkout.sha256, arm);
    deps.out(`${JSON.stringify(stop)}\n`);
    return stop.kind === "done" ? 0 : 3;
  } finally {
    releaseLock(root, process.pid);
  }
}

function writeJournalText(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  const fd = openSync(tmp, "wx", 0o644);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  journalFs.fsyncDir(dirname(path));
}

export { PKG };

// ---------------------------------------------------------------------------------------------------------------
// The real executor: each process phase through runInGroup, with the runner's structured result

export const RUNNER = (pkg: string): string => join(pkg, "scripts", "onboarding-eval-run.ts");
export const JUDGE = (pkg: string): string => join(pkg, "scripts", "onboarding-eval-judge.ts");
export const KILL_GRACE_MS = 10_000;

/** The runner-result file of a phase. */
export const resultFile = (a: Attempt, phase: Phase): string => join(a.dir, `${phase}.result.json`);

/** The record folder the run reported, from its result file. */
export function recordDirOf(a: Attempt): string | null {
  const r = readJson<RunnerResult>(resultFile(a, "run"));
  return r !== null && r.ok ? r.recordDir : null;
}

/**
 * The raw folder the run reported (`<attempt>/raw/<runId>`), from its result file. It must lie inside the
 * attempt's own raw folder; anything else is a problem, never a folder the regrade is pointed at.
 */
export function rawDirOf(a: Attempt): { readonly dir: string } | { readonly problem: string } {
  const r = readJson<RunnerResult>(resultFile(a, "run"));
  const raw = r !== null && r.ok ? r.rawDir ?? null : null;
  if (raw === null) return { problem: "the run reported no raw folder" };
  const rel = relative(join(a.dir, "raw"), resolve(raw));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { problem: `the run's raw folder ${raw} is not inside ${join(a.dir, "raw")}` };
  return { dir: resolve(raw) };
}

/** Test seam, not reachable from any input: runs after the pin is written in full, before it is published. */
export const pinSeams: { beforePublish: (tmp: string) => void } = { beforePublish: () => {} };

/** The scan's immutable copy of record.json, written once; finalize rewrites record.json itself. */
export const SCAN_PIN = "record.scan.json";

/**
 * Writes `record.scan.json` once (exclusive, fsynced, folder fsynced). A rerun scan finds it and requires
 * record.json to be unchanged since; a difference is the problem returned. Null when the pin holds.
 */
export function pinRecord(rec: string): string | null {
  const bytes = readFileSync(join(rec, "record.json"));
  const pin = join(rec, SCAN_PIN);
  if (existsSync(pin)) return sha256(readFileSync(pin)) === sha256(bytes) ? null : "record.json changed since the scan pinned it";
  // Written and fsynced in full under a temporary name, then published with link(), which never overwrites: a
  // death before the link leaves only the temporary file, which the next scan replaces.
  const tmp = join(rec, `.${SCAN_PIN}.tmp-${process.pid}`);
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o400);
  try { for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off); fsyncSync(fd); } finally { closeSync(fd); }
  pinSeams.beforePublish(tmp);
  try { linkSync(tmp, pin); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    rmSync(tmp, { force: true });
    return sha256(readFileSync(pin)) === sha256(bytes) ? null : "record.json changed since the scan pinned it";
  }
  rmSync(tmp, { force: true });
  journalFs.fsyncDir(rec);
  return null;
}

const USAGE_LIMIT = /usage limit|rate limit|quota/i;
const INFRASTRUCTURE = /timed out|deadline|timeout|could not be launched|spawn|ENOENT|ENOSPC|limit/i;

/**
 * 7.3: the runner's result as flags. A thrown error or a refusal is a harness defect, unless its stage is the scan
 * and the record holds invalid.json (invalid), or its message names a usage limit, a deadline or a launch
 * failure (infrastructure).
 */
export function runnerFlags(phase: Phase, r: RunnerResult | null, recordDir: string | null): { flags: Flag[]; usageLimit: boolean } {
  if (r === null) return { flags: [{ kind: "harness-defect", cause: `${phase}: no runner result was written` }], usageLimit: false };
  // Every turn's own findings first, whatever the run reported after them: an unconfirmed cleanup quarantines and
  // an infrastructure failure is infrastructure, both ranked ahead of any grading verdict (dispositionOf).
  const turnFlags: Flag[] = [];
  let turnUsage = false;
  for (const t of r.turns ?? []) {
    if (t.cleanup !== "confirmed") turnFlags.push({ kind: "quarantined", cause: `${phase}: turn ${t.turn}: its process group was not confirmed gone${t.cleanupDetail !== null ? `: ${t.cleanupDetail}` : ""}` });
    if (t.infraFailure !== null) {
      if (USAGE_LIMIT.test(t.infraFailure)) turnUsage = true;
      turnFlags.push({ kind: "infrastructure", cause: USAGE_LIMIT.test(t.infraFailure) ? "usage limit" : `${phase}: turn ${t.turn}: ${t.infraFailure}` });
    }
  }
  if (r.ok) return { flags: turnFlags, usageLimit: turnUsage };
  const rest = runnerFailureFlags(phase, r, recordDir);
  return { flags: [...turnFlags, ...rest.flags], usageLimit: turnUsage || rest.usageLimit };
}

function runnerFailureFlags(phase: Phase, r: Extract<RunnerResult, { ok: false }>, recordDir: string | null): { flags: Flag[]; usageLimit: boolean } {
  if (recordDir !== null && existsSync(join(recordDir, "invalid.json"))) return { flags: [{ kind: "invalid", cause: `${phase}: ${r.message}` }], usageLimit: false };
  if (r.stage === "scan" && /invalid/.test(r.message)) return { flags: [{ kind: "invalid", cause: `${phase}: ${r.message}` }], usageLimit: false };
  if (USAGE_LIMIT.test(r.message)) return { flags: [{ kind: "infrastructure", cause: "usage limit" }], usageLimit: true };
  if (INFRASTRUCTURE.test(r.message)) return { flags: [{ kind: "infrastructure", cause: `${phase}: ${r.message}` }], usageLimit: false };
  return { flags: [{ kind: "harness-defect", cause: `${phase} at ${r.stage}: ${r.message}` }], usageLimit: false };
}

/** The judge's meta as flags: published passes; the cleanup, the limits and the launch are infrastructure or quarantine. */
export function judgeFlags(meta: { outcome?: string; reason?: string; firstStderrLine?: string } | null): { flags: Flag[]; usageLimit: boolean } {
  if (meta === null) return { flags: [{ kind: "harness-defect", cause: "judge: no meta.json" }], usageLimit: false };
  const o = meta.outcome ?? "";
  if (o === "published") return { flags: [], usageLimit: false };
  if (o === "cleanup-unconfirmed") return { flags: [{ kind: "quarantined", cause: "judge: its process group was not confirmed gone" }], usageLimit: false };
  if (o === "credential-in-output") return { flags: [{ kind: "invalid", cause: "judge: a credential form in its output" }], usageLimit: false };
  if (USAGE_LIMIT.test(`${meta.reason ?? ""} ${meta.firstStderrLine ?? ""}`)) return { flags: [{ kind: "infrastructure", cause: "usage limit" }], usageLimit: true };
  if (["timed-out", "spawn-failed", "output-limit", "signal"].includes(o)) return { flags: [{ kind: "infrastructure", cause: `judge: ${o}` }], usageLimit: false };
  return { flags: [{ kind: "harness-defect", cause: `judge: ${o || "no outcome"}` }], usageLimit: false };
}

/** A cell's runner arguments. The probe turn is never a cell: any argument naming it is refused. */
export function cellRunArgs(cell: Cell, arm: Arm, model: string, dir: string, timeoutMs: number, result: string): string[] {
  const args = ["--client", arm, "--fixture", cell.fixture, "--variant", cell.variant, ...(cell.schedule !== undefined ? ["--fault-schedule", cell.schedule] : []), "--model", model, "--out", join(dir, "out"), "--raw-out", join(dir, "raw"), "--timeout-ms", String(timeoutMs), "--result", result];
  if (args.some((x) => x.includes("--probe-turn"))) throw new Error(`cell ${cell.id}: the probe turn is not a cell; its arguments may not name --probe-turn`);
  return args;
}

export interface RealExecutorOptions {
  readonly pkg: string; readonly node: string; readonly env: NodeJS.ProcessEnv;
  /** Test seams for the nested-group sweep; the real signals and the kill grace otherwise. */
  readonly sweep?: SweepSignals; readonly sweepGraceMs?: number;
}

/** Where a phase's runner or judge records each process group it launches (7.4). */
export const groupsFile = (a: Attempt, phase: Phase): string => join(a.dir, `${phase}.groups.jsonl`);

export function realExecutor(o: RealExecutorOptions): Executor {
  const tsx = (script: string, args: readonly string[]) => ({ command: o.node, args: ["--import", "tsx", script, ...args] });
  const hashes = (paths: readonly string[]): Record<string, string> => Object.fromEntries(paths.map((p) => [p, hashFile(p)]).filter((e): e is [string, string] => e[1] !== null));
  // The wrapper's own stop (TERM at the deadline, the grace, KILL, confirmed) comes first; then every group it
  // recorded is stopped here and confirmed gone, since a nested group is beyond the wrapper's own group. One not
  // confirmed gone makes the phase's cleanup unconfirmed, which quarantines the attempt.
  const group = async (ctx: PhaseContext, cmd: { command: string; args: string[] }) => {
    const file = groupsFile(ctx.attempt, ctx.phase);
    const g = await runInGroup({
      command: cmd.command, args: cmd.args, cwd: o.pkg, env: { ...o.env, [GROUPS_FILE_ENV]: file }, timeoutMs: ctx.deadlineMs, killGraceMs: KILL_GRACE_MS,
      onSpawn: (pgid) => ctx.onSpawn(pgid, pgid),
    });
    const left = await sweepGroups(file, o.sweepGraceMs ?? KILL_GRACE_MS, o.sweep ?? realSweepSignals);
    return left.length === 0 ? g : { ...g, cleanup: "unconfirmed" as const, cleanupDetail: left.join("; ") };
  };
  const ex: Executor = {
    artifactsOf: (ctx) => {
      const rec = recordDirOf(ctx.attempt);
      if (ctx.phase === "run") return [resultFile(ctx.attempt, "run"), join(ctx.attempt.dir, "out"), join(ctx.attempt.dir, "raw")];
      if (ctx.phase === "judge") return rec === null ? [] : [join(rec, "judge.json"), join(rec, "judge-attempt")];
      if (ctx.phase === "finalize" || ctx.phase === "regrade") return [resultFile(ctx.attempt, ctx.phase)];
      return [];
    },
    run: async (ctx) => {
      const a = ctx.attempt;
      const rec = recordDirOf(a);
      const pin = ctx.manifest.clients[ctx.arm];
      if (ctx.phase === "run") {
        const args = cellRunArgs(ctx.cell, ctx.arm, pin.model, a.dir, Math.min(ctx.manifest.limits.turnMs, ctx.deadlineMs), resultFile(a, "run"));
        const g = await group(ctx, tsx(RUNNER(o.pkg), args));
        const r = readJson<RunnerResult>(resultFile(a, "run"));
        const f = runnerFlags("run", r, r?.ok ? r.recordDir : null);
        return { cleanup: g.cleanup, cleanupDetail: g.cleanupDetail, flags: f.flags, usageLimit: f.usageLimit, artifacts: hashes([resultFile(a, "run")]), verdict: r?.ok ? r.verdict : null };
      }
      if (rec === null) return { cleanup: "confirmed", flags: [{ kind: "harness-defect", cause: `${ctx.phase}: the run reported no record folder` }], artifacts: {} };
      if (ctx.phase === "scan") {
        if (existsSync(join(rec, "invalid.json"))) return { cleanup: "confirmed", flags: [{ kind: "invalid", cause: "scan: the record holds invalid.json" }], artifacts: hashes([join(rec, "invalid.json")]) };
        if (existsSync(join(rec, "scan-pending.json"))) return { cleanup: "confirmed", flags: [{ kind: "harness-defect", cause: "scan: the record was never cleared by the 5.9 scan" }], artifacts: {} };
        // finalize rewrites record.json, so the scan pins its own immutable copy and the journal hashes that.
        const pinned = pinRecord(rec);
        if (pinned !== null) return { cleanup: "confirmed", flags: [{ kind: "harness-defect", cause: `scan: ${pinned}` }], artifacts: {} };
        return { cleanup: "confirmed", flags: [], artifacts: hashes([join(rec, SCAN_PIN), join(rec, "grading-packet.json")]) };
      }
      if (ctx.phase === "judge") {
        const g = await group(ctx, tsx(JUDGE(o.pkg), ["--record", rec]));
        const meta = readJson<{ outcome?: string; reason?: string; firstStderrLine?: string; observedModels?: string[] }>(join(rec, "judge-attempt", "meta.json"));
        const f = judgeFlags(meta);
        return { cleanup: g.cleanup, cleanupDetail: g.cleanupDetail, flags: f.flags, usageLimit: f.usageLimit, artifacts: hashes([join(rec, "judge.json"), join(rec, "judge-attempt", "meta.json")]), observedModels: meta?.observedModels ?? [] };
      }
      if (ctx.phase === "scan-judge") {
        const p = join(rec, "judge.json");
        if (!existsSync(p)) return { cleanup: "confirmed", flags: [{ kind: "harness-defect", cause: "scan-judge: no judge.json" }], artifacts: {} };
        const hits = scanForCredentials(readFileSync(p));
        return { cleanup: "confirmed", flags: hits.length > 0 ? [{ kind: "invalid", cause: `scan-judge: ${hits.length} credential form(s) in judge.json` }] : [], artifacts: hashes([p]) };
      }
      let raw: string | null = null;
      if (ctx.phase === "regrade") {
        const r = rawDirOf(a);
        if ("problem" in r) return { cleanup: "confirmed", flags: [{ kind: "harness-defect", cause: `regrade: ${r.problem}` }], artifacts: {} };
        raw = r.dir;
      }
      const args = ctx.phase === "finalize"
        ? ["--finalize", rec, "--judge", join(rec, "judge.json"), "--result", resultFile(a, "finalize")]
        : ["--regrade", rec, "--raw", raw!, "--result", resultFile(a, "regrade")];
      const g = await group(ctx, tsx(RUNNER(o.pkg), args));
      const r = readJson<RunnerResult>(resultFile(a, ctx.phase));
      const f = runnerFlags(ctx.phase, r, rec);
      return { cleanup: g.cleanup, cleanupDetail: g.cleanupDetail, flags: f.flags, usageLimit: f.usageLimit, artifacts: hashes([resultFile(a, ctx.phase)]), verdict: ctx.phase === "finalize" && r?.ok ? r.verdict : null };
    },
    adoptJudge: (ctx) => {
      const rec = recordDirOf(ctx.attempt);
      if (rec === null) return null;
      const j = readJson<{ packetSha256?: string }>(join(rec, "judge.json"));
      const packet = hashFile(join(rec, "grading-packet.json"));
      if (j === null || packet === null || j.packetSha256 !== packet) return null;
      const meta = readJson<{ observedModels?: string[] }>(join(rec, "judge-attempt", "meta.json"));
      return { cleanup: "confirmed", flags: [], artifacts: hashes([join(rec, "judge.json")]), observedModels: meta?.observedModels ?? [] };
    },
    regradeReservation: (ctx) => {
      const rec = recordDirOf(ctx.attempt);
      return { revision: 1, originalRecordSha256: rec === null ? null : hashFile(join(rec, "record.json")), packetSha256: rec === null ? null : hashFile(join(rec, "grading-packet.json")) };
    },
    adoptRegrade: (ctx, reservation) => {
      const rec = recordDirOf(ctx.attempt);
      if (rec === null) return null;
      let revs: ReturnType<typeof readRevisions>;
      try { revs = readRevisions(rec); } catch { return "mismatch"; }
      const first = revs.find((r) => r.revision.revision === 1);
      if (first === undefined) return null;
      const want = reservation as { originalRecordSha256?: string; packetSha256?: string } | undefined;
      if (want?.originalRecordSha256 !== first.revision.originalRecordSha256 || want?.packetSha256 !== first.revision.packetSha256) return "mismatch";
      return { cleanup: "confirmed", flags: [], artifacts: hashes([join(first.dir, "regrade.json")]) };
    },
  };
  return ex;
}

// ---------------------------------------------------------------------------------------------------------------
// 7.2 Preflight (no model)

export interface PreflightProbe {
  readonly version: (arm: Arm) => string | null;
  readonly managedSettings: () => readonly string[];
  readonly freeBytes: () => number;
  readonly counts: () => { readonly vitest: number; readonly jest: number };
  readonly codexCredential: () => boolean;
  readonly claudeTokenLength: () => number;
  readonly evalInputDigest: () => string;
  readonly toolListSha256: () => string;
  readonly distProblems: (commit: string) => readonly string[];
  /** Section 8's capability probe. The real entry always wires the real one; only test code supplies another. */
  readonly capabilityProbe?: (arm: Arm) => Promise<readonly string[]>;
}

/** T-538 signed-in note section 2: why every claude arm run is refused, whichever isolation its manifest pins. */
export const CLAUDE_ARM_REFUSAL = `the claude arm is refused: ${unconditionalSignedInRefusal("its pinned signed-in isolation")}; a fresh claude arm is not admitted without a separate owner ruling and a reviewed manifest change`;

/** The manifest's isolation for one arm, checked before anything is probed or spawned. */
export function armIsolationProblems(m: Manifest, arm: Arm): string[] {
  const iso = m.clients[arm].isolation;
  if (arm === "codex") return iso === "fresh" ? [] : [`the codex arm runs fresh only; the manifest pins ${JSON.stringify(iso)}`];
  if (iso === "signed-in") return [unconditionalSignedInRefusal("the claude arm's pinned signed-in isolation")];
  return ["the claude arm's fresh isolation is not admitted: it needs a separate owner ruling and a reviewed manifest change"];
}

/** Every 7.2 check after the checkout's; returns the problems, and records the counts in `<root>/preflight.json`. */
export async function preflightProblems(m: Manifest, root: string, arm: Arm, p: PreflightProbe, now: number): Promise<string[]> {
  // Section 2: the isolation refusal comes first, and returns before any probe can spawn a process.
  const refused = armIsolationProblems(m, arm);
  if (refused.length > 0) {
    writeJournal(root, "preflight.json", { at: now, arm, counts: null, problems: refused });
    return refused;
  }
  const out: string[] = [];
  for (const a of ARMS) {
    const v = p.version(a);
    if (v === null || !v.includes(m.clients[a].version)) out.push(`${a} --version is ${JSON.stringify(v)}, not the pinned ${m.clients[a].version}`);
  }
  for (const s of p.managedSettings()) out.push(`a managed settings location exists: ${s}`);
  const free = p.freeBytes();
  if (free < FREE_SPACE_MIN) out.push(`${Math.floor(free / 1024 ** 3)} GiB free, under the 20 GiB floor`);
  const q = openQuarantines(root);
  if (q.length > 0) out.push(`open quarantine: ${q.join(", ")}; --close <attempt> --ruling <text> is the only way on`);
  if (!p.codexCredential()) out.push("no Codex credential (checked by lstat only)");
  if (arm === "claude" && p.claudeTokenLength() === 0) out.push("no Claude token (checked by length only)");
  if (p.evalInputDigest() !== m.evalBundleDigest) out.push(`the eval bundle's input digest is ${p.evalInputDigest()}, not the manifest's ${m.evalBundleDigest}`);
  if (p.toolListSha256() !== m.toolListSha256) out.push(`the tool list's sha256 is ${p.toolListSha256()}, not the manifest's ${m.toolListSha256}`);
  out.push(...p.distProblems(m.commit));
  if (m.probeSha256 !== PROBE_SHA256) out.push(`the probe program's sha256 is ${PROBE_SHA256}, not the manifest's ${m.probeSha256}`);
  if (p.capabilityProbe === undefined) out.push("no capability probe is wired; the driver does not start without one");
  else if (out.length === 0) out.push(...(await p.capabilityProbe(arm)));
  const counts = p.counts();
  writeJournal(root, "preflight.json", { at: now, arm, counts, problems: out });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The real probes and the entry

/** Locations whose presence means a managed policy could override the clients' settings. */
export const MANAGED_SETTINGS = ["/Library/Application Support/ClaudeCode", "/etc/claude-code", "/etc/codex"] as const;

const count = (pattern: string): number => {
  const r = spawnSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf-8" });
  return (r.stdout ?? "").split("\n").filter(Boolean).length;
};

/** Every file under `dir` with its sha256, by relative path. */
export function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r); else if (e.isFile()) out[r] = sha256(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}

/** 7.2: dist rebuilt in a scratch clone of `commit`; its file digests must equal the checkout's. */
export function distRebuildProblems(pkg: string, commit: string, git: Git, scratch: string): string[] {
  const topR = git(["rev-parse", "--show-toplevel"]);
  const hereR = git(["rev-parse", "--show-prefix"]);
  if (!topR.ok || !hereR.ok) return ["dist: git rev-parse failed"];
  const top = topR.out.trim();
  const here = hereR.out.trim();
  const clone = join(scratch, `dist-check-${commit.slice(0, 12)}-${process.pid}`);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch };
  const step = (cmd: string, args: string[], cwd: string): string | null => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? null : `${cmd} ${args.join(" ")} failed (${r.status ?? r.signal}): ${(r.stderr ?? "").split("\n")[0]}`;
  };
  try {
    const failed = step("git", ["clone", "-q", "--no-hardlinks", "--no-checkout", top, clone], scratch)
      ?? step("git", ["-c", "advice.detachedHead=false", "checkout", "-q", commit], clone)
      ?? step("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], join(clone, here))
      ?? step("npm", ["run", "build"], join(clone, here));
    if (failed !== null) return [`dist rebuild: ${failed}`];
    const want = treeHashes(join(clone, here, "dist"));
    const have = treeHashes(join(pkg, "dist"));
    const diff = [...new Set([...Object.keys(want), ...Object.keys(have)])].filter((k) => want[k] !== have[k]).sort();
    return diff.length === 0 ? [] : [`dist differs from a rebuild of ${commit}: ${diff.slice(0, 5).join(", ")}${diff.length > 5 ? ", ..." : ""}`];
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

/** The owner's ack for the Claude probe turn: `--arm claude --ack probe --note <text>` writes it. */
export const PROBE_ACK_CELL = "probe";

/** Section 8 step 3: a probe's own work area, fresh per preflight; the program lies outside both roots. */
export function probeTargets(dir: string): ProbeTargets {
  const t: ProbeTargets = { roots: [join(dir, "project"), join(dir, "events")], outsideProbe: join(dir, "outside-probe"), home: join(dir, "home"), tmp: "/tmp", canary: join(dir, "canary"), reportDir: join(dir, "events"), probeDir: join(dir, "work", "probe"), insideDir: join(dir, "project") };
  for (const d of [...t.roots, t.outsideProbe, t.home, t.canary]) mkdirSync(d, { recursive: true });
  return t;
}

const onPath = (bin: string): string | null => {
  for (const d of (process.env.PATH ?? "").split(":")) if (d.startsWith("/") && existsSync(join(d, bin))) return join(d, bin);
  return null;
};

/** The Claude probe turn through the runner's `--probe-turn` mode, in its own process group. */
async function runnerProbeTurn(pkg: string, root: string, dir: string, env: NodeJS.ProcessEnv): Promise<ProbeTurnResult | null> {
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, "probe-prompt.txt");
  writeFileSync(promptFile, PROBE_PROMPT_TEMPLATE, { flag: "wx", mode: 0o400 });
  const result = join(dir, "probe-turn.result.json");
  const g = await runInGroup({
    command: process.execPath, cwd: pkg, env, timeoutMs: 40 * 60_000, killGraceMs: KILL_GRACE_MS,
    args: ["--import", "tsx", RUNNER(pkg), "--client", "claude", "--fixture", "empty-idea", "--out", join(dir, "out"), "--raw-out", join(dir, "raw"), "--probe-turn", "--ack", gatePath(root, PROBE_ACK_CELL, "claude"), "--prompt-file", promptFile, "--result", result],
  });
  if (g.cleanup !== "confirmed") return { ok: false, message: "the probe turn's process group was not confirmed gone" };
  return readJson<ProbeTurnResult>(result);
}

/** Section 8 step 3 for one arm: the Codex wrapper probe (no model) for both arms, then, for Claude, the acked turn. */
export function realCapabilityProbe(pkg: string, root: string, env: NodeJS.ProcessEnv): (arm: Arm) => Promise<readonly string[]> {
  return async (arm) => {
    const dir = join(root, "probe", `${arm}-${Date.now()}`);
    const codexBin = onPath("codex");
    if (codexBin === null) return ["probe: no codex executable on PATH for the wrapper probe"];
    const wrapper = probeTargets(join(dir, "wrapper"));
    const codexHome = join(dir, "wrapper", "codex-home");
    mkdirSync(codexHome);
    const out = await codexProbe({ codexBin, node: process.execPath, targets: wrapper, env: { PATH: "/usr/bin:/bin", HOME: wrapper.home, CODEX_HOME: codexHome, TMPDIR: wrapper.home }, deadlineMs: 60_000 });
    if (arm === "claude" && out.length === 0) out.push(...await claudeProbe({ ackPath: gatePath(root, PROBE_ACK_CELL, "claude"), runTurn: () => runnerProbeTurn(pkg, root, join(dir, "turn"), env) }));
    return out;
  };
}

/**
 * The real 7.2 probes, the capability probe among them. Nothing on the command line or in the environment can
 * supply or skip it; only test code builds a PreflightProbe of its own.
 */
export function realPreflightProbe(pkg: string, git: Git, root: string, env: NodeJS.ProcessEnv): PreflightProbe {
  const version = (a: Arm): string | null => {
    const r = spawnSync(a, ["--version"], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent" }, timeout: 30_000 });
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  };
  return {
    version,
    managedSettings: () => MANAGED_SETTINGS.filter((p) => existsSync(p)),
    freeBytes: () => freeBytes(root),
    counts: () => ({ vitest: count("vitest"), jest: count("jest") }),
    // lstat only: the credential is never opened or read.
    codexCredential: () => { try { lstatSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")); return true; } catch { return false; } },
    claudeTokenLength: () => (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").length,
    evalInputDigest: () => evalInputDigest(pkg),
    toolListSha256: () => sha256(readFileSync(join(pkg, "scripts", "onboarding-eval-tools.json"))),
    distProblems: (commit) => distRebuildProblems(pkg, commit, git, mkdtempSync(join(tmpdir(), "t538-dist-"))),
    capabilityProbe: realCapabilityProbe(pkg, root, env),
  };
}

/** The environment the runner and judge children get: the path, the home, the Codex home and the token, passed through unread. */
const childEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent", ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}), ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } : {}) });

/** The entry's own wiring: the real git, the real probes, the real executor. */
export async function entry(argv: readonly string[]): Promise<number> {
  const git = realGit(PKG);
  return cli(argv, {
    pkg: PKG,
    now: () => Date.now(),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
    out: (s) => { process.stdout.write(s); },
    git,
    preflight: (m, root, arm) => preflightProblems(m, root, arm, realPreflightProbe(PKG, git, root, childEnv()), Date.now()),
    arm: (root, m, sha, arm) => runArm(root, m, sha, arm, {
      now: () => Date.now(),
      groupAlive: recordedGroupAlive,
      leftoverClean: (a) => leftoverClean(a),
      executor: realExecutor({ pkg: PKG, node: process.execPath, env: childEnv() }),
    }),
  });
}

/** 5.1's leftover test for an attempt: no process holds a file under the attempt's tree; a failed check is not clean. */
export const leftoverClean = (a: Attempt): boolean => leftoverCheck(a.dir).status === "clean";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  entry(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err: unknown) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 2; });
}
