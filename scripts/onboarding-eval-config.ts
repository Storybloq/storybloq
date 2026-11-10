/**
 * T-538 plan 5.6: the client's configuration lives outside every writable root, is pinned by a manifest at
 * provisioning, and is checked before every turn; the project and the attempt tree's ancestors are scanned for
 * the names a client would load from them.
 *
 * Manifest entries come in three kinds. `file`: sha256, owner and mode as written. `credential-link`: the auth
 * link, held by `lstat` and `readlink` only; its target is never opened. `runtime-dir`: a folder the client
 * writes; it may be absent, and its contents are not checked. Anything else in a manifest folder that is not on
 * the list and not the client's own state named below is a problem, so an unknown entry stops the run.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, readSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { walkNoFollow } from "./onboarding-eval-walk.js";

export type ManifestEntry =
  | { readonly kind: "file"; readonly path: string; readonly sha256: string; readonly uid: number; readonly mode: number }
  | { readonly kind: "credential-link"; readonly path: string; readonly target: string }
  | { readonly kind: "runtime-dir"; readonly path: string };

export interface Manifest {
  /** The folders the check lists in full; every entry lies under one of them. */
  readonly folders: readonly string[];
  readonly entries: readonly ManifestEntry[];
}

/** Codex's own state under its home (Addendum B, from a listing of codex 0.163.0 on two turns): folders it writes. */
export const CODEX_STATE_DIRS = ["sessions", "shell_snapshots", "skills", "tmp", ".tmp", "thread-writer-locks"] as const;
/** Codex's own state files: its sqlite stores with their -shm and -wal files, its installation id and its sandbox marker. */
export const CODEX_STATE_FILE = /^(?:[a-z_]+_[0-9]+\.sqlite(?:-shm|-wal)?|installation_id|\.sandbox_migration)$/;
/** Claude's own state under its config folder (plan 5.6). */
export const CLAUDE_STATE_DIRS = ["projects", "sessions", "backups"] as const;

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The attempt tree's parent: the per-user temp folder (short, never under the owner's home), then sbq-eval. */
export function attemptBase(): string {
  const r = spawnSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } });
  const dir = r.status === 0 ? r.stdout.trim() : "";
  return join(dir !== "" ? dir : tmpdir(), "sbq-eval");
}

/** A file entry for what is on disk now; called right after the runner wrote it. */
export function fileEntry(path: string): ManifestEntry {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`onboarding-eval: ${path} is not a regular file`);
  return { kind: "file", path, sha256: sha256(readFileSync(path)), uid: st.uid, mode: st.mode & 0o7777 };
}

/** A credential link: made by the caller with symlink; only lstat and readlink look at it. */
export function credentialLinkEntry(path: string): ManifestEntry {
  const target = readlinkSync(path);
  if (!lstatSync(path).isSymbolicLink()) throw new Error(`onboarding-eval: ${path} is not a link`);
  return { kind: "credential-link", path, target };
}

/** Every file under a provisioned folder (a copied skill), each a file entry. */
export function treeEntries(dir: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const { problems } = walkNoFollow(dir, dir, {
    link: (rel) => { throw new Error(`onboarding-eval: a provisioned tree holds a link: ${join(dir, rel)}`); },
    file: (rel) => { out.push(fileEntry(join(dir, rel))); return null; },
  });
  if (problems.length > 0) throw new Error(`onboarding-eval: ${problems.join("; ")}`);
  return out;
}

/** The client's own state named above, for the folder holding `rel`; true leaves it unchecked. */
function isClientState(folder: string, rel: string, entries: readonly ManifestEntry[]): boolean {
  for (const e of entries) {
    if (e.kind !== "runtime-dir") continue;
    const r = relative(e.path, join(folder, rel));
    if (r === "" || (!r.startsWith("..") && !r.startsWith(sep) && r !== "..")) return true;
  }
  const abs = join(folder, rel);
  const codexHome = entries.find((e) => e.kind === "credential-link" && e.path.endsWith(`${sep}.codex${sep}auth.json`));
  return codexHome !== undefined && dirname(abs) === dirname(codexHome.path) && CODEX_STATE_FILE.test(rel.split(sep).pop() ?? "");
}

/**
 * The check before every turn: each entry matches its kind, and nothing else is in a manifest folder but the
 * folders that lead to an entry and the client's own state. Empty means the configuration holds.
 */
export function configProblems(m: Manifest): string[] {
  const problems: string[] = [];
  const named = new Set(m.entries.map((e) => e.path));
  const leading = new Set<string>();
  for (const e of m.entries) for (let d = dirname(e.path); !m.folders.includes(d) && d !== dirname(d); d = dirname(d)) leading.add(d);
  for (const e of m.entries) {
    let st;
    try { st = lstatSync(e.path); } catch (err) {
      if (e.kind === "runtime-dir" && (err as NodeJS.ErrnoException).code === "ENOENT") continue;
      problems.push(`config: ${e.path} is missing`);
      continue;
    }
    if (e.kind === "file") {
      if (!st.isFile()) { problems.push(`config: ${e.path} is not a regular file`); continue; }
      if (st.uid !== e.uid) problems.push(`config: ${e.path} changed owner`);
      if ((st.mode & 0o7777) !== e.mode) problems.push(`config: ${e.path} changed mode`);
      if (sha256(readFileSync(e.path)) !== e.sha256) problems.push(`config: ${e.path} changed`);
    } else if (e.kind === "credential-link") {
      if (!st.isSymbolicLink() || readlinkSync(e.path) !== e.target) problems.push(`config: ${e.path} is not the credential link`);
    } else if (!st.isDirectory()) problems.push(`config: ${e.path} is not a folder`);
  }
  for (const folder of m.folders) {
    const extra = (rel: string): void => {
      const abs = join(folder, rel);
      if (rel === "." || named.has(abs) || leading.has(abs) || isClientState(folder, rel, m.entries)) return;
      problems.push(`config: ${abs} is not in the manifest`);
    };
    const { problems: walk } = walkNoFollow(folder, folder, {
      include: (rel, st) => {
        extra(rel);
        // A runtime folder's contents are the client's own; nothing under it is listed.
        return !(st.isDirectory() && m.entries.some((e) => e.kind === "runtime-dir" && e.path === join(folder, rel)));
      },
      link: () => {},
      file: () => null,
    });
    problems.push(...walk.map((w) => `config: ${w}`));
  }
  return problems;
}

/** Names a client loads from a project or an ancestor (plan 5.6). */
export const PROJECT_FORBIDDEN = [".codex", ".agents", ".claude", ".mcp.json", "AGENTS.override.md"] as const;
/** `.git/config` keys that run a program or pull in more configuration. */
const GIT_KEY_SECTIONS = ["filter", "alias", "include", "includeif"] as const;
const GIT_KEYS = ["core.fsmonitor", "core.hookspath", "core.sshcommand", "core.pager", "diff.external"] as const;

/**
 * The keys of `.git/config` read from its bytes, never by running git: `section.key` for a plain section and
 * `section.<subsection>.key` for a quoted one, all lower-cased but the subsection.
 */
export function gitConfigKeys(text: string): string[] {
  const keys: string[] = [];
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/.exec(line);
    if (head) {
      const [name, ...dotted] = head[1]!.split(".");
      section = [name!.toLowerCase(), ...(head[2] !== undefined ? [head[2]] : dotted)].join(".");
      const rest = head[3]!.trim();
      if (rest !== "" && !rest.startsWith("#") && !rest.startsWith(";")) {
        const k = /^([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
        if (k) keys.push(`${section}.${k[1]!.toLowerCase()}`);
      }
      continue;
    }
    const k = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$)/.exec(line);
    if (k && section !== null) keys.push(`${section}.${k[1]!.toLowerCase()}`);
  }
  return keys;
}

/** The git keys of plan 5.6 that `.git/config` sets. */
export function gitKeyProblems(text: string): string[] {
  const out: string[] = [];
  for (const key of gitConfigKeys(text)) {
    const parts = key.split(".");
    const section = parts[0]!;
    const plain = `${section}.${parts[parts.length - 1]!}`;
    if (((GIT_KEY_SECTIONS as readonly string[]).includes(section) || (GIT_KEYS as readonly string[]).includes(plain)) && !out.includes(key)) out.push(key);
  }
  return out;
}

/** F8: the git config the project scan reads, at most. */
export const GIT_CONFIG_MAX_BYTES = 256 * 1024;

/**
 * The project scan (plan 5.6), through the no-follow walk: no name a client loads, no hook but a sample, no
 * git key that runs a program. Each finding is `project: <path>: <what>`.
 */
export function projectScanProblems(project: string): string[] {
  const problems: string[] = [];
  const at = (rel: string): string => join(project, rel);
  // F7: the walk never follows a link, so a .git, .git/config or .git/hooks that is a link (or a .git file naming
  // another git folder) would hide the config and hooks git reads; each is refused here.
  let git: ReturnType<typeof lstatSync> | null = null;
  try { git = lstatSync(at(".git")); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`project: ${at(".git")}: unreadable (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
  }
  if (git !== null) {
    if (git.isSymbolicLink()) problems.push(`project: ${at(".git")}: a link`);
    else if (git.isFile()) problems.push(`project: ${at(".git")}: a git indirection file`);
    else if (git.isDirectory()) {
      for (const rel of [join(".git", "config"), join(".git", "hooks")]) {
        try { if (lstatSync(at(rel)).isSymbolicLink()) problems.push(`project: ${at(rel)}: a link`); } catch { /* absent: nothing for git to read */ }
      }
    }
  }
  const { problems: walk } = walkNoFollow(project, project, {
    include: (rel, st) => {
      const base = rel.split(sep).pop()!;
      if ((PROJECT_FORBIDDEN as readonly string[]).includes(base)) problems.push(`project: ${at(rel)}: a client loads this name`);
      const parts = rel.split(sep);
      if (parts.length === 3 && parts[0] === ".git" && parts[1] === "hooks" && !base.endsWith(".sample")) problems.push(`project: ${at(rel)}: a git hook`);
      return !(st.isDirectory() && parts.length >= 2 && parts[0] === ".git" && parts[1] === "objects");
    },
    link: () => {},
    file: (rel, fd) => {
      if (rel !== join(".git", "config")) return null;
      // F8: read at most GIT_CONFIG_MAX_BYTES; a longer config is not scanned and is a scan failure.
      const buf = Buffer.allocUnsafe(GIT_CONFIG_MAX_BYTES + 1);
      let len = 0;
      for (let n = -1; n !== 0 && len < buf.length; len += n) n = readSync(fd, buf, len, buf.length - len, null);
      if (len > GIT_CONFIG_MAX_BYTES) { problems.push(`project: ${at(rel)}: over ${GIT_CONFIG_MAX_BYTES} bytes, not scanned (a scan failure)`); return null; }
      const text = buf.subarray(0, len).toString("utf-8");
      for (const k of gitKeyProblems(text)) problems.push(`project: ${at(rel)}: sets ${k}`);
      return null;
    },
  });
  return [...problems, ...walk.map((w) => `project: ${w}`)];
}

/** Every ancestor of the attempt tree up to `/`, checked once for the same names. */
export function ancestorProblems(tree: string): string[] {
  const problems: string[] = [];
  for (let d = dirname(resolve(tree)); ; d = dirname(d)) {
    for (const name of PROJECT_FORBIDDEN) if (existsSync(join(d, name)) || isLink(join(d, name))) problems.push(`ancestor: ${join(d, name)}: a client loads this name`);
    if (d === dirname(d)) break;
  }
  return problems;
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// --- the canary (5.9) ----------------------------------------------------------------------------------

/** What the canary held when it was made: its folder's entry list and its one file's bytes, mode and mtime. */
export interface Canary {
  readonly dir: string;
  readonly names: readonly string[];
  readonly sha256: string;
  readonly mode: number;
  readonly mtimeMs: number;
}

export const CANARY_FILE = "canary.txt";

/**
 * `canary/` (0700, the runner's, never a root) with one file. Monitoring only: a change means something wrote
 * where nothing may, and the matrix stops. It is never proof of the sandbox; the capability probe (8) is.
 */
export function makeCanary(dir: string): Canary {
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, CANARY_FILE);
  writeFileSync(file, `storybloq evaluation canary ${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
  const st = lstatSync(file);
  return { dir, names: readdirSync(dir).sort(), sha256: sha256(readFileSync(file)), mode: st.mode & 0o7777, mtimeMs: st.mtimeMs };
}

/** Empty while the canary holds; otherwise each change, `canary: <what>`. */
export function canaryProblems(c: Canary): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(c.dir).sort(); } catch (e) { return [`canary: the folder could not be read (${(e as NodeJS.ErrnoException).code ?? "unknown"})`]; }
  if (names.join("\n") !== c.names.join("\n")) out.push(`canary: the folder's entries changed (${names.join(", ") || "none"})`);
  const file = join(c.dir, CANARY_FILE);
  let st;
  try { st = lstatSync(file); } catch { out.push("canary: the file is gone"); return out; }
  if (!st.isFile()) { out.push("canary: the file is not a regular file"); return out; }
  if ((st.mode & 0o7777) !== c.mode) out.push("canary: the file's mode changed");
  if (st.mtimeMs !== c.mtimeMs) out.push("canary: the file's mtime changed");
  if (sha256(readFileSync(file)) !== c.sha256) out.push("canary: the file's bytes changed");
  return out;
}
