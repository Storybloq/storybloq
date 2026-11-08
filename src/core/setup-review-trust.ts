/**
 * ISS-1457: where a setup reviewer may run. codex reads configuration from the
 * folder it starts in and from every git ancestor of it, so the folder must be
 * one no other user, and no project, could have planted anything in. The
 * isolation flags close those routes on the characterised version; this check
 * is the filesystem half, and it runs before any process starts.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { UnavailableReason } from "./setup-review-backends.js";

const OTHERS_WRITE = 0o022;
const STICKY = 0o1000;
/** Entries that would make a directory a configuration source for codex. */
const CONFIG_ENTRIES = [".codex", ".git"];

/** Test seam, not reachable through any CLI or MCP input: the uid the checks hold paths to. */
export const trustSeams: { uid: () => number; stat: (path: string) => Stats; lstat: (path: string) => Stats; readdir: (path: string) => string[] } = {
  uid: () => (typeof process.getuid === "function" ? process.getuid() : -1),
  stat: (path) => statSync(path),
  lstat: (path) => lstatSync(path),
  readdir: (path) => readdirSync(path),
};

export type TrustVerdict = { readonly ok: true } | { readonly ok: false; readonly detail: string };

const refuse = (detail: string): TrustVerdict => ({ ok: false, detail });
const OK: TrustVerdict = { ok: true };

/** The user's home as the environment names it, falling back to the account's. */
export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
}

/** Every directory from / down to, but not including, `path`. */
function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let cur = dirname(path);
  for (;;) {
    out.unshift(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

/** Whether `child` is `parent` or below it. A name such as "..credentials" is a descendant, not a way up. */
export const isWithin = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
};

/**
 * The repository a command runs in: the top-most folder at or above `cwd`
 * that holds .git, or `cwd` itself when none does. A CODEX_HOME or a store
 * override inside it is project-controlled.
 */
export function repositoryBoundary(cwd: string): string {
  let cur: string;
  try {
    cur = realpathSync(cwd);
  } catch {
    cur = resolve(cwd);
  }
  let top = cur;
  for (;;) {
    if (existsSync(join(cur, ".git"))) top = cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return top;
}

/**
 * The structural ancestors of an anchor: each owned by root or by this user
 * and not writable by others. A sticky one (as /private/tmp) is accepted only
 * when the entry inside it on the way down is this user's, since a sticky
 * directory lets no one else rename or remove that entry.
 */
function checkAncestors(anchor: string, uid: number, what: string): TrustVerdict {
  for (const dir of ancestorsOf(anchor)) {
    const st = trustSeams.stat(dir);
    if (st.uid !== 0 && st.uid !== uid) return refuse(`${what}: ${dir} is owned by another user`);
    if ((st.mode & OTHERS_WRITE) === 0) continue;
    if ((st.mode & STICKY) === 0) return refuse(`${what}: ${dir} is writable by other users`);
    const rel = relative(dir, anchor).split(sep)[0]!;
    const entry = trustSeams.lstat(join(dir, rel));
    if (entry.uid !== uid) return refuse(`${what}: ${join(dir, rel)} inside the shared ${dir} is not this user's`);
  }
  return OK;
}

/** A directory this user alone controls: owned by the uid, not writable by others, not a link. */
function checkOwned(dir: string, uid: number, what: string): TrustVerdict {
  const st = trustSeams.lstat(dir);
  if (st.isSymbolicLink()) return refuse(`${what}: ${dir} is a link`);
  if (st.uid !== uid) return refuse(`${what}: ${dir} is not owned by this user`);
  if ((st.mode & OTHERS_WRITE) !== 0) return refuse(`${what}: ${dir} is writable by other users`);
  return OK;
}

/** The config entry a directory holds, or null; a directory that cannot be listed is a refusal, never clean. */
function configEntryRefusal(dir: string, what: string): TrustVerdict | null {
  let names: string[];
  try {
    names = trustSeams.readdir(dir);
  } catch (e) {
    return refuse(`${what}: ${dir} cannot be listed (${(e as NodeJS.ErrnoException).code ?? "error"}), so it cannot be shown free of .git and .codex`);
  }
  const entry = CONFIG_ENTRIES.find((n) => names.includes(n));
  return entry ? refuse(`${what}: ${dir} holds ${entry}, so codex could read configuration from it`) : null;
}

/**
 * The home directory as a trust anchor: canonical, owned by this user, not
 * writable by others, under ancestors that pass checkAncestors. The rule that
 * HOME/.codex is not a project configuration source is a configuration rule,
 * kept apart from this check.
 */
export function checkHome(env: NodeJS.ProcessEnv): TrustVerdict & { readonly home?: string } {
  const uid = trustSeams.uid();
  let home: string;
  try {
    home = realpathSync(homeOf(env));
  } catch (e) {
    return refuse(`home ${homeOf(env)} cannot be resolved (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const owned = checkOwned(home, uid, "home");
  if (!owned.ok) return owned;
  const up = checkAncestors(home, uid, "home");
  if (!up.ok) return up;
  return { ok: true, home };
}

/**
 * Whether `path`, an existing directory a reviewer is about to run in, is
 * trusted. Its canonical form must equal it (no link anywhere below the
 * anchor). Under the home directory the anchor is home; elsewhere it is the
 * store root an override named. From the anchor down every directory is this
 * user's and not writable by others, and no directory below home holds a
 * .codex or .git entry, so codex finds no project configuration there.
 */
export function checkExecLocation(path: string, storeRootPath: string, env: NodeJS.ProcessEnv, boundary: string): TrustVerdict {
  const uid = trustSeams.uid();
  const home = checkHome(env);
  if (!home.ok) return home;
  let canonical: string;
  let root: string;
  try {
    canonical = realpathSync(path);
    root = realpathSync(storeRootPath);
  } catch (e) {
    return refuse(`${path} cannot be resolved (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!isWithin(canonical, root)) return refuse(`${path} resolves outside the review store`);
  if (isWithin(canonical, boundary) || isWithin(root, boundary)) return refuse(`review store: ${root} is inside the repository ${boundary}, so the project could have planted configuration in it`);
  const underHome = isWithin(root, home.home!) && root !== home.home;
  const anchor = underHome ? home.home! : root;
  // A link at or below the anchor would let the path move after this check.
  if (!linksOnlyAboveAnchor(path, anchor)) return refuse(`${path} goes through a link at or below ${anchor}`);
  if (!underHome) {
    const up = checkAncestors(anchor, uid, "review store");
    if (!up.ok) return up;
    // codex looks for project configuration in git ancestors too, so above an anchor outside home no folder may hold one.
    for (const dir of ancestorsOf(anchor)) {
      const found = configEntryRefusal(dir, "review store");
      if (found) return found;
    }
  }
  const chain = [anchor, ...relative(anchor, canonical).split(sep).filter(Boolean).map((_, i, parts) => join(anchor, ...parts.slice(0, i + 1)))];
  for (const dir of chain) {
    const owned = checkOwned(dir, uid, "review store");
    if (!owned.ok) return owned;
    if (dir === home.home) continue;
    const found = configEntryRefusal(dir, "review store");
    if (found) return found;
  }
  return OK;
}

/**
 * Links are allowed only above the anchor and only when root's own (as /tmp
 * and /var on macOS); one at or below the anchor, or one another user owns,
 * fails the check.
 */
function linksOnlyAboveAnchor(path: string, anchor: string): boolean {
  let cur: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    const next = join(cur, part);
    const st = trustSeams.lstat(next);
    if (st.isSymbolicLink()) {
      if (st.uid !== 0 || isWithin(cur, anchor)) return false;
      cur = realpathSync(next);
    } else {
      cur = next;
    }
  }
  return true;
}

/**
 * ISS-1457 (plan v3 section 4): codex still reads its credential and its
 * hooks.json from CODEX_HOME under --ignore-user-config. A CODEX_HOME inside
 * the project, inside the temporary folder (TMPDIR when set, otherwise the
 * system's), or under a directory another user controls
 * could be a planted one, so codex is not started.
 */
export type CodexHomeVerdict = { readonly ok: true; readonly codexHome: string } | { readonly ok: false; readonly reason: UnavailableReason };

/**
 * Validated against the path as given, every component of it: a link inside
 * the repository, or one this user or root does not own, or one in a folder
 * others may write, is refused, since it could be re-pointed after the check.
 * The child is given the canonical path that was checked, never the original.
 */
export function checkCodexHome(env: NodeJS.ProcessEnv, projectDir: string): CodexHomeVerdict {
  const r = codexHomeProblem(env, projectDir);
  return "canonical" in r ? { ok: true, codexHome: r.canonical } : { ok: false, reason: r };
}

function codexHomeLinks(named: string, boundary: string, uid: number): string | null {
  let cur: string = sep;
  for (const part of resolve(named).split(sep).filter(Boolean)) {
    const next = join(cur, part);
    let st: Stats;
    try {
      st = trustSeams.lstat(next);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) {
      if (isWithin(next, boundary)) return `${next} is a link inside the repository ${boundary}, so the project could re-point it`;
      if (st.uid !== 0 && st.uid !== uid) return `${next} is a link another user owns`;
      const parent = trustSeams.stat(cur);
      if ((parent.mode & OTHERS_WRITE) !== 0) return `${next} is a link in ${cur}, which other users may write`;
      try {
        cur = realpathSync(next);
      } catch {
        return null;
      }
    } else {
      cur = next;
    }
  }
  return null;
}

function codexHomeProblem(env: NodeJS.ProcessEnv, projectDir: string): UnavailableReason | { readonly canonical: string } {
  const named = env.CODEX_HOME && env.CODEX_HOME !== "" ? env.CODEX_HOME : join(homeOf(env), ".codex");
  const fail = (detail: string): UnavailableReason => ({ backend: "codex", code: "untrusted-codex-home", detail });
  const boundary = repositoryBoundary(projectDir);
  const link = codexHomeLinks(named, boundary, trustSeams.uid());
  if (link) return fail(`CODEX_HOME ${named}: ${link}`);
  let canonical: string;
  try {
    canonical = realpathSync(named);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // No CODEX_HOME yet: codex has nothing there to load; its parent must still be trusted.
    if (code !== "ENOENT") return fail(`CODEX_HOME ${named} cannot be resolved (${code ?? "error"})`);
    try {
      canonical = join(realpathSync(dirname(named)), named.split(sep).pop()!);
    } catch {
      return fail(`CODEX_HOME ${named} has no parent here`);
    }
  }
  if (isWithin(canonical, boundary)) return fail(`CODEX_HOME ${named} is inside the project, so the project could have planted it`);
  const tmpRoot = env.TMPDIR && isAbsolute(env.TMPDIR) ? env.TMPDIR : tmpdir();
  let tmp: string;
  try {
    tmp = realpathSync(tmpRoot);
  } catch {
    tmp = resolve(tmpRoot);
  }
  if (isWithin(canonical, tmp)) return fail(`CODEX_HOME ${named} is inside the temporary folder ${tmpRoot}, so another process could have planted it`);
  const uid = trustSeams.uid();
  const up = checkAncestors(canonical, uid, "CODEX_HOME");
  if (!up.ok) return fail(up.detail);
  try {
    const owned = checkOwned(canonical, uid, "CODEX_HOME");
    if (!owned.ok) return fail(owned.detail);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return { canonical };
}
