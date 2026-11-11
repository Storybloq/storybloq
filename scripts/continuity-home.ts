/**
 * T-525 Addendum E5: the real-home state accounting for the signed-in Claude arm.
 *
 * Every path is classified before anything reads it, and nothing here opens a file: the inventory is
 * built from lstat and readdir alone, never follows a symlink, and records metadata only (existence,
 * type, size, mode, mtime). Files that hold or may hold credentials (.claude.json, the credentials
 * files, anything unrecognised) are therefore accounted for by metadata, and their preservation is
 * unverified beyond it. The inventory is endpoint change detection, not prevention.
 */
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";

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
