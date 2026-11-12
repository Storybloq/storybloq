/**
 * T-525 Addendum E5: the real-home state accounting for the signed-in Claude arm.
 *
 * Every path is classified before anything reads it, and nothing here opens a file: the inventory is
 * built from lstat and readdir alone, never follows a symlink, and records metadata only (existence,
 * type, size, mode, mtime). Files that hold or may hold credentials (.claude.json, the credentials
 * files, anything unrecognised) are therefore accounted for by metadata, and their preservation is
 * unverified beyond it. The inventory is endpoint change detection, not prevention.
 *
 * T-525 E5 commit C: the journal. The before and after inventories, the client's group and the derived
 * violations are written into the attempt's raw directory with the strict durable writer, and read back
 * only from there (never from the home), through the no-follow bounded reader.
 */
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { readRegularFile, writeDurable } from "./headless-common.js";

/** Bumped when the classification below changes; it joins the signed-in experiment hash. */
export const HOME_CLASSIFIER_VERSION = 1 as const;

export type StateClass = "credential" | "transcript" | "runtime" | "unknown";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CREDENTIAL_NAME = /credential|auth|token|oauth|keychain|secret/i;
const TRANSCRIPT = new RegExp(`^\\.claude/projects/[^/]+/(${UUID})\\.jsonl$`);
const RUNTIME = [
  new RegExp(`^\\.claude/session-env/(${UUID})(?:/.*)?$`),
  new RegExp(`^\\.claude/todos/(${UUID})-[^/]+$`),
  new RegExp(`^\\.claude/projects/[^/]+/(${UUID})(?:/.*)?$`),
];

/**
 * The class of a path relative to the real HOME. A credential match wins over every other class, and a
 * path matching nothing is "unknown", which is handled exactly like a credential: metadata only.
 */
export function classifyStatePath(rel: string): StateClass {
  const base = rel.split("/").pop() ?? rel;
  if (rel === ".claude.json" || rel.startsWith(".claude.json.") || base === ".credentials.json" || CREDENTIAL_NAME.test(base)) return "credential";
  if (TRANSCRIPT.test(rel)) return "transcript";
  if (rel.startsWith(".claude/shell-snapshots/") || RUNTIME.some((r) => r.test(rel))) return "runtime";
  return "unknown";
}

/** The session id a transcript or runtime path is bound to, or null. */
export function sessionOf(rel: string): string | null {
  for (const r of [TRANSCRIPT, ...RUNTIME]) {
    const m = r.exec(rel);
    if (m?.[1]) return m[1];
  }
  return null;
}

export interface InventoryEntry {
  readonly rel: string;
  readonly type: "file" | "dir" | "symlink" | "other";
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly class: StateClass;
}

const typeOf = (st: Stats): InventoryEntry["type"] => (st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other");

/** A path the inventory could not read: anything but "absent" (ENOENT) is a problem, never silence. */
export interface InventoryProblem { readonly rel: string; readonly op: "lstat" | "readdir"; readonly code: string }

export interface Inventory { readonly entries: readonly InventoryEntry[]; readonly problems: readonly InventoryProblem[] }

/** The two calls the inventory makes; a seam so a test can inject a failure. */
export interface InventoryFs {
  readonly lstat: (p: string) => Stats;
  readonly readdir: (p: string) => string[];
}
const NODE_FS: InventoryFs = { lstat: (p) => lstatSync(p), readdir: (p) => readdirSync(p) };

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException | null)?.code ?? "UNKNOWN";

/**
 * The metadata of ~/.claude (recursively) and of every ~/.claude.json* sibling. lstat only: a FIFO, an
 * unreadable file or a symlink out of the home is recorded, never opened or followed. Only ENOENT means
 * absent; any other lstat or readdir error is a problem the caller must treat as a stop.
 */
export function inventory(realHome: string, fs: InventoryFs = NODE_FS): Inventory {
  const entries: InventoryEntry[] = [];
  const problems: InventoryProblem[] = [];
  const add = (rel: string): Stats | null => {
    let st: Stats;
    try { st = fs.lstat(join(realHome, rel)); } catch (e) {
      if (errCode(e) !== "ENOENT") problems.push({ rel, op: "lstat", code: errCode(e) });
      return null;
    }
    entries.push({ rel, type: typeOf(st), size: st.size, mode: st.mode, mtimeMs: st.mtimeMs, class: classifyStatePath(rel) });
    return st;
  };
  const list = (rel: string): string[] => {
    try { return fs.readdir(rel === "" ? realHome : join(realHome, rel)); } catch (e) {
      if (errCode(e) !== "ENOENT") problems.push({ rel: rel === "" ? "." : rel, op: "readdir", code: errCode(e) });
      return [];
    }
  };
  for (const name of list("").filter((n) => n === ".claude.json" || n.startsWith(".claude.json.")).sort()) add(name);
  const walk = (rel: string): void => {
    const st = add(rel);
    if (st === null || !st.isDirectory()) return;
    for (const n of list(rel).sort()) walk(`${rel}/${n}`);
  };
  walk(".claude");
  return { entries, problems };
}

export interface InventoryChange { readonly rel: string; readonly kind: "added" | "removed" | "changed" | "unreadable"; readonly class: StateClass }

/**
 * The changes between two inventories that the arm does not allow. Allowed, and nothing else:
 * - a transcript or runtime path bound to one of this run's session ids, added or changed, never retyped;
 * - an existing directory that holds such a change, changing only size and mtime (type and mode unchanged);
 * - a new holding directory (projects/<slug>, session-env, todos) created for such a change;
 * - .claude.json staying a regular file with its mode, changing only size and mtime.
 * A problem in either inventory is a stop naming the path. Anything else stops the arm, named by path.
 */
export function inventoryViolations(before: Inventory, after: Inventory, sessionIds: readonly string[]): InventoryChange[] {
  const b = new Map(before.entries.map((e) => [e.rel, e]));
  const a = new Map(after.entries.map((e) => [e.rel, e]));
  const changes: InventoryChange[] = [];
  for (const [rel, e] of a) {
    const old = b.get(rel);
    if (old === undefined) changes.push({ rel, kind: "added", class: e.class });
    else if (old.type !== e.type || old.size !== e.size || old.mode !== e.mode || old.mtimeMs !== e.mtimeMs) changes.push({ rel, kind: "changed", class: e.class });
  }
  for (const [rel, e] of b) if (!a.has(rel)) changes.push({ rel, kind: "removed", class: e.class });
  const ours = (rel: string): boolean => {
    const id = sessionOf(rel);
    return id !== null && sessionIds.includes(id);
  };
  const holdsAllowedChild = (rel: string): boolean => changes.some((c) => c.rel.startsWith(`${rel}/`) && ours(c.rel) && c.kind !== "removed");
  const sameType = (rel: string): boolean => b.get(rel)?.type === a.get(rel)?.type;
  const sameMode = (rel: string): boolean => b.get(rel)?.mode === a.get(rel)?.mode;
  const allowed = (c: InventoryChange): boolean => {
    if (c.kind === "removed") return false;
    if (c.kind === "changed" && !sameType(c.rel)) return false;
    if ((c.class === "transcript" || c.class === "runtime") && ours(c.rel)) return true;
    if (c.rel === ".claude.json") return c.kind === "changed" && a.get(c.rel)?.type === "file" && sameMode(c.rel);
    if (c.kind === "changed") return a.get(c.rel)?.type === "dir" && sameMode(c.rel) && holdsAllowedChild(c.rel);
    return a.get(c.rel)?.type === "dir" && sessionOf(c.rel) === null && holdsAllowedChild(c.rel) && /^\.claude\/(projects\/[^/]+|session-env|todos|projects|shell-snapshots)$/.test(c.rel);
  };
  const unreadable: InventoryChange[] = [...before.problems, ...after.problems].map((p) => ({ rel: p.rel, kind: "unreadable", class: classifyStatePath(p.rel) }));
  return [...unreadable, ...changes.filter((c) => !allowed(c))];
}

// ---------------------------------------------------------------------------------------------------------------
// E5 commit C: the home journal (C1 to C3, K2, K3).

export const HOME_BEFORE = "home.before.json";
export const HOME_AFTER = "home.after.json";
export const HOME_VIOLATIONS = "home.violations.json";
export const HOME_DIAGNOSTIC = "home.diagnostic.json";
export const CLIENT_GROUP = "client.group.json";
export const JOURNAL_SCHEMA = 1 as const;
/** The largest journal file read back: an inventory of a large ~/.claude stays well under it. */
export const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;

/** A journal refusal: the arm stops with this code, and the attempt is never graded. */
export class HomeJournalStop extends Error {
  constructor(readonly code: string, detail: string) { super(`continuity-home: ${code}: ${detail}`); }
}

export interface JournalIo {
  /** The strict durable writer (writeDurable): file fsync, rename and directory fsync, every failure thrown. */
  readonly write: (path: string, text: string) => Promise<void>;
  readonly inventoryFs?: InventoryFs;
  /** C-F2, test seam: the lstat a journal's presence is decided by (only ENOENT is absence). */
  readonly lstat?: (p: string) => Stats;
}
const JOURNAL_IO: JournalIo = { write: writeDurable };
const text = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** C1: the baseline, before the client starts. Any inventory problem refuses before anything is written or started. */
export async function journalBefore(rawDir: string, home: string, io: JournalIo = JOURNAL_IO): Promise<Inventory> {
  const inv = inventory(home, io.inventoryFs);
  if (inv.problems.length > 0) throw new HomeJournalStop("home.baseline", inv.problems.map((p) => `${p.rel} ${p.op} ${p.code}`).join(", "));
  await io.write(join(rawDir, HOME_BEFORE), text({ schema: JOURNAL_SCHEMA, classifier: HOME_CLASSIFIER_VERSION, inventory: inv }));
  return inv;
}

/** C1, K3: the client's group, recorded at spawn and awaited before the prompt; a failure is thrown to the caller. */
export async function journalGroup(rawDir: string, pgid: number, start: string | null, io: JournalIo = JOURNAL_IO): Promise<void> {
  await io.write(join(rawDir, CLIENT_GROUP), text({ schema: JOURNAL_SCHEMA, pgid, start }));
}

/**
 * C1, C2: the terminal inventory after the cleanup check, on success and failure alike, then the derived violations.
 * An unconfirmed cleanup stops whatever the inventory says (H4).
 */
export async function journalAfter(rawDir: string, home: string, cleanup: "confirmed" | "unconfirmed", sessionIds: readonly string[], io: JournalIo = JOURNAL_IO): Promise<InventoryChange[]> {
  await io.write(join(rawDir, HOME_AFTER), text({ schema: JOURNAL_SCHEMA, cleanup, sessionIds: [...sessionIds], inventory: inventory(home, io.inventoryFs) }));
  if (cleanup !== "confirmed") throw new HomeJournalStop("home.cleanup.unconfirmed", "the client's group was not confirmed gone; the terminal inventory is not trusted");
  return validateHomeJournal(rawDir, { sessionIds }, io);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const ENTRY_TYPES: readonly string[] = ["file", "dir", "symlink", "other"];
const PROBLEM_OPS: readonly string[] = ["lstat", "readdir"];
/** A relative path the inventory itself could produce: .claude.json and its siblings, or .claude and below, every segment a plain name. */
const isInventoryRel = (rel: string): boolean => /^\.claude\.json(\.[^/]+)?$/.test(rel)
  || (/^\.claude(\/[^/]+)*$/.test(rel) && rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."));
const finite = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n);
/**
 * C-F1: a stored inventory is trusted only in the shape the inventory writes. Paths are unique and normalised, types
 * and ops are the supported ones, metadata is finite, and each entry's class is recomputed and must equal the stored
 * one, so a snapshot can neither hide an entry behind a duplicate nor relabel a credential-bearing path.
 */
const isInventory = (v: unknown): v is Inventory => {
  if (!isObj(v) || !Array.isArray(v.entries) || !Array.isArray(v.problems)) return false;
  const seen = new Set<string>();
  for (const e of v.entries as unknown[]) {
    if (!isObj(e) || typeof e.rel !== "string" || !isInventoryRel(e.rel) || seen.has(e.rel)) return false;
    seen.add(e.rel);
    if (typeof e.type !== "string" || !ENTRY_TYPES.includes(e.type)) return false;
    if (!finite(e.size) || (e.size as number) < 0 || !finite(e.mode) || !finite(e.mtimeMs)) return false;
    if (e.class !== classifyStatePath(e.rel)) return false;
  }
  return (v.problems as unknown[]).every((p) => isObj(p) && typeof p.rel === "string" && (p.rel === "." || isInventoryRel(p.rel))
    && typeof p.op === "string" && PROBLEM_OPS.includes(p.op) && typeof p.code === "string" && p.code !== "");
};

/** One journal file, read without following a link and bounded, parsed; anything else is the given refusal. */
function readJournal(rawDir: string, name: string, code: string): Record<string, unknown> {
  let v: unknown;
  try { v = JSON.parse(readRegularFile(join(rawDir, name), JOURNAL_MAX_BYTES)); } catch (e) { throw new HomeJournalStop(code, `${name} is unreadable or not JSON (${(e as Error).message})`); }
  if (!isObj(v) || v.schema !== JOURNAL_SCHEMA) throw new HomeJournalStop(code, `${name} has the wrong schema`);
  return v;
}

const sameIds = (a: readonly unknown[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => typeof x === "string") && [...(a as string[])].sort().join("\n") === [...b].sort().join("\n");

/**
 * C3 (H5): the journal checked before any grading. The baseline must carry this classifier and no problem; the
 * terminal inventory must follow a confirmed cleanup and be bound to the record's session ids; the violations are
 * recomputed from the two validated snapshots, never trusted from a file. A missing violations file is completed
 * from the recomputation; a present one must equal it. Returns the recomputed violations.
 */
export async function validateHomeJournal(rawDir: string, record: { readonly sessionIds: readonly string[] }, io: JournalIo = JOURNAL_IO): Promise<InventoryChange[]> {
  if (present(rawDir, HOME_BEFORE, "home.baseline", io) === null) throw new HomeJournalStop("home.unjournalled", "no baseline was journalled before the client started");
  const before = readJournal(rawDir, HOME_BEFORE, "home.baseline");
  if (before.classifier !== HOME_CLASSIFIER_VERSION) throw new HomeJournalStop("home.baseline", `classifier ${String(before.classifier)} is not ${HOME_CLASSIFIER_VERSION}`);
  if (!isInventory(before.inventory) || before.inventory.problems.length > 0) throw new HomeJournalStop("home.baseline", "the baseline inventory is malformed or carries a problem");
  present(rawDir, HOME_AFTER, "home.terminal", io);
  const after = readJournal(rawDir, HOME_AFTER, "home.terminal");
  if (after.cleanup !== "confirmed") throw new HomeJournalStop("home.cleanup.unconfirmed", "the terminal inventory does not follow a confirmed cleanup");
  if (!isInventory(after.inventory)) throw new HomeJournalStop("home.terminal", "the terminal inventory is malformed");
  if (!Array.isArray(after.sessionIds) || !sameIds(after.sessionIds, record.sessionIds)) throw new HomeJournalStop("home.session-binding", "the terminal inventory's session ids are not the record's");
  const violations = inventoryViolations(before.inventory, after.inventory, record.sessionIds);
  const vPath = join(rawDir, HOME_VIOLATIONS);
  if (present(rawDir, HOME_VIOLATIONS, "home.violations", io) === null) await io.write(vPath, text({ schema: JOURNAL_SCHEMA, violations }));
  else {
    const stored = readJournal(rawDir, HOME_VIOLATIONS, "home.violations");
    if (JSON.stringify(stored.violations) !== JSON.stringify(violations)) throw new HomeJournalStop("home.violations", "the stored violations are not the recomputation");
  }
  return violations;
}
/**
 * C-F2: a journal file's presence. Only ENOENT is absence; any other lstat error (EACCES, EIO, ...) is the given
 * refusal, so an unreadable journal is never mistaken for a missing one and rebuilt over.
 */
function present(rawDir: string, name: string, code: string, io: JournalIo): Stats | null {
  try { return (io.lstat ?? lstatSync)(join(rawDir, name)); } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw new HomeJournalStop(code, `${name} cannot be checked (${errCode(e)})`);
  }
}

/** K2: what recovery may ask about a recorded group. There is no signal here: recovery never signals anything. */
export interface RecoveryProbe {
  /** The group probe (kill(-pgid, 0)): "gone" only on ESRCH; "present" on success; any other code as given. */
  readonly group: (pgid: number) => "gone" | "present" | string;
  /** The leader's identity, for the diagnostic only: identity never authorises a terminal inventory. */
  readonly identity: (pid: number) => { readonly kind: "start"; readonly value: string } | { readonly kind: "absent" } | { readonly kind: "failed"; readonly reason: string };
}

/**
 * K2 (C2): the cleanup answer for a journal with a baseline and no terminal inventory. Only a valid recorded group
 * (an integer id above 1 and a known start) with a definitive absence answer (ESRCH) is "gone". A missing, corrupt
 * or invalid record, an unknown start, a present or inaccessible group (EPERM), whatever the leader's identity,
 * is "unconfirmed" with the reason. The group probe outranks the leader's identity.
 */
export function recoveryCleanup(rawDir: string, probe: RecoveryProbe, io: JournalIo = JOURNAL_IO): { readonly status: "gone" } | { readonly status: "unconfirmed"; readonly reason: string } {
  let st: Stats | null;
  try { st = present(rawDir, CLIENT_GROUP, "home.group-record", io); } catch (e) { return { status: "unconfirmed", reason: `the group record cannot be checked: ${(e as Error).message}` }; }
  if (st === null) return { status: "unconfirmed", reason: "no group record (a crash between the spawn and the record)" };
  let g: Record<string, unknown>;
  try { g = readJournal(rawDir, CLIENT_GROUP, "home.group-record"); } catch (e) { return { status: "unconfirmed", reason: `the group record is corrupt: ${(e as Error).message}` }; }
  const pgid = g.pgid;
  if (typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 1) return { status: "unconfirmed", reason: `the group record names no valid group (${JSON.stringify(pgid)})` };
  if (typeof g.start !== "string" || g.start === "") return { status: "unconfirmed", reason: `the group ${pgid} has no recorded start identity` };
  const answer = probe.group(pgid);
  if (answer === "gone") return { status: "gone" };
  const id = probe.identity(pgid);
  const leader = id.kind === "failed" ? `the leader's identity lookup failed (${id.reason})` : id.kind === "absent" ? "the leader is absent" : id.value === g.start ? "the leader is the recorded one" : "the leader's identity changed";
  return { status: "unconfirmed", reason: `the group ${pgid} is ${answer === "present" ? "present" : `inaccessible (${answer})`}; ${leader}` };
}

/**
 * C2, C3: recovery for one attempt's journal. No baseline: unjournalled, refused. A baseline with no terminal
 * inventory: the cleanup is established first (K2); only "gone" takes the terminal inventory, otherwise a diagnostic
 * snapshot (never terminal) is written and the arm stops. A terminal inventory present: validated as for grading.
 */
export async function recoverHomeJournal(rawDir: string, home: string, sessionIds: readonly string[], probe: RecoveryProbe, io: JournalIo = JOURNAL_IO): Promise<InventoryChange[]> {
  if (present(rawDir, HOME_BEFORE, "home.baseline", io) === null) throw new HomeJournalStop("home.unjournalled", "no baseline was journalled; recovery does not assume no spawn happened");
  if (present(rawDir, HOME_AFTER, "home.terminal", io) === null) {
    const c = recoveryCleanup(rawDir, probe, io);
    if (c.status !== "gone") {
      await io.write(join(rawDir, HOME_DIAGNOSTIC), text({ schema: JOURNAL_SCHEMA, reason: c.reason, inventory: inventory(home, io.inventoryFs) }));
      throw new HomeJournalStop("home.cleanup.unconfirmed", c.reason);
    }
    return journalAfter(rawDir, home, "confirmed", sessionIds, io);
  }
  return validateHomeJournal(rawDir, { sessionIds }, io);
}
