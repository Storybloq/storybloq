/**
 * T-538 plan 5.8, the collector: the only process that reads a model-writable tree. Commit 2b adds its
 * `requests` mode (plan 5.5); 2c adds `collect` and `digest`.
 *
 * `collect <purpose> <source folder> <destination>`: walks the source with walkNoFollow and copies each regular
 * file with copyBounded into the destination (outside every root), under the purpose's byte limit, 20000
 * entries and depth 32, then prints one line: `{"missing": bool, "entries": [{path, size, sha256, problem}]}`.
 * A link, a special file, a file past the limit, an entry past the entry or depth limit, and an entry that
 * changed or could not be read are each a problem on their entry and are not copied.
 *
 * `digest <folder>`: the tree digest (lib's treeDigest form) read without following anything, as one line.
 *
 * `archive <project> <destination>`, `observe <project> <at as JSON>` and `ledger-state <.story>`: the runner's
 * own no-follow readers (archiveProject, observeEvidence, ledgerState) run here instead, each printing its result.
 *
 * `requests`: one worker lives for the turn. Each line on stdin is a poll, `{"claimed": [<id>...]}`; each answer
 * is one line on stdout: `{"entries": [{id, bytes} | {id, problem}], "ignored": [<name>...]}` or
 * `{"failure": "review requests: <cause>"}`. It lists names only, keeps final names, drops claimed ids, and
 * opens each remaining file without following links and without blocking.
 *
 *   node onboarding-eval-collect.js requests <request folder>
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { CredentialStream, REQUEST_MAX_BYTES, REQUEST_NAME, type CredentialHit } from "./onboarding-eval-review.js";
import { byteBudget, copyBounded, walkNoFollow } from "./onboarding-eval-walk.js";

/** The listing stops at this many directory entries of any name. */
export const LISTING_LIMIT = 4096;
/** At most this many unclaimed final names may be present at once. */
export const UNCLAIMED_LIMIT = 64;

export type RequestEntry = { readonly id: string; readonly bytes: string } | { readonly id: string; readonly problem: string };
export type RequestPoll = { readonly entries: readonly RequestEntry[]; readonly ignored: readonly string[] } | { readonly failure: string };

/** One request file, opened without following links and without blocking, read bounded. */
export function readRequest(path: string): { readonly bytes: Buffer } | { readonly problem: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { problem: code === "ELOOP" ? "the request is a link" : `the request is unreadable: ${code ?? String(err)}` };
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return { problem: "the request is not a regular file" };
    if (before.size > REQUEST_MAX_BYTES) return { problem: `the request is over ${REQUEST_MAX_BYTES} bytes` };
    const buf = Buffer.alloc(before.size + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > before.size) return { problem: "the request changed while read" };
    }
    const after = fstatSync(fd);
    if (n !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { problem: "the request changed while read" };
    return { bytes: buf.subarray(0, n) };
  } catch (err) {
    return { problem: `the request is unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  } finally {
    closeSync(fd);
  }
}

/** Test seams, not reachable from any input: beforeChdir runs between the anchoring lstat and the chdir; afterListing between the listing and the reads. */
export const pollSeams: { beforeChdir: () => void; afterListing: () => void } = { beforeChdir: () => {}, afterListing: () => {} };

export const FOLDER_CHANGED = "review requests: the folder changed while read";

/**
 * One poll of the request folder. A missing folder has no requests yet.
 * F3: Node has no openat, so the poll anchors on the folder itself: it records the folder's device and inode
 * (no link followed), makes the folder this process's working directory and checks that "." is that same
 * device and inode, then lists "." and opens each file by its bare name (no link followed). Every lookup
 * therefore starts from the folder's inode, whatever its path names later. After the reads the path is
 * checked again: a folder renamed, removed or replaced by a link during the poll fails the whole listing.
 * Only the worker process calls this; the working directory is restored before it returns.
 */
export function pollRequests(dir: string, claimed: ReadonlySet<string>): RequestPoll {
  let anchor: ReturnType<typeof lstatSync>;
  try {
    anchor = lstatSync(dir);
    if (anchor.isSymbolicLink() || !anchor.isDirectory()) return { failure: "review requests: the folder is not a directory" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], ignored: [] };
    return { failure: `review requests: the folder is unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  const home = process.cwd();
  pollSeams.beforeChdir();
  try {
    process.chdir(dir);
  } catch (err) {
    return { failure: `review requests: the folder is unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  try {
    const here = statSync(".");
    if (here.dev !== anchor.dev || here.ino !== anchor.ino) return { failure: FOLDER_CHANGED };
    const r = pollAnchored(claimed);
    if ("failure" in r) return r;
    let now: ReturnType<typeof lstatSync> | null = null;
    try { now = lstatSync(dir); } catch { /* gone: changed */ }
    if (now === null || !now.isDirectory() || now.dev !== anchor.dev || now.ino !== anchor.ino) return { failure: FOLDER_CHANGED };
    return r;
  } finally {
    process.chdir(home);
  }
}

/** The listing and reads of pollRequests, relative to the working directory it anchored. */
function pollAnchored(claimed: ReadonlySet<string>): RequestPoll {
  const names: string[] = [];
  const ignored: string[] = [];
  const d = opendirSync(".");
  try {
    let count = 0;
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (++count > LISTING_LIMIT) return { failure: `review requests: the listing passes ${LISTING_LIMIT} entries` };
      if (!REQUEST_NAME.test(e.name)) { if (!e.name.startsWith(".")) ignored.push(e.name); continue; }
      if (!claimed.has(e.name.slice(0, -".json".length))) names.push(e.name);
    }
  } finally {
    d.closeSync();
  }
  if (names.length > UNCLAIMED_LIMIT) return { failure: `review requests: more than ${UNCLAIMED_LIMIT} unclaimed requests are present` };
  names.sort(byRequestOrder);
  pollSeams.afterListing();
  const entries = names.map((name): RequestEntry => {
    const id = name.slice(0, -".json".length);
    const r = readRequest(name);
    return "problem" in r ? { id, problem: r.problem } : { id, bytes: r.bytes.toString("base64") };
  });
  return { entries, ignored: ignored.sort() };
}

/** Claim order within one poll: by pid, then by counter. */
function byRequestOrder(a: string, b: string): number {
  const [pa, ca] = a.slice(0, -5).split("-").map(Number) as [number, number];
  const [pb, cb] = b.slice(0, -5).split("-").map(Number) as [number, number];
  return pa - pb || ca - cb;
}

/** The worker: answers each poll line with one result line. */
export async function requestsWorker(dir: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  const rl = createInterface({ input });
  for await (const line of rl) {
    let claimed: string[] = [];
    try {
      const v = JSON.parse(line) as { claimed?: unknown };
      if (Array.isArray(v.claimed)) claimed = v.claimed.filter((x): x is string => typeof x === "string");
    } catch { /* an unreadable poll is an empty claim set */ }
    output.write(`${JSON.stringify(pollRequests(dir, new Set(claimed)))}\n`);
  }
}

// --- collect and digest (5.8) --------------------------------------------------------------------------

export type Purpose = "rollouts" | "project" | "store" | "ledger" | "events";
const MIB = 1024 * 1024;
export const PURPOSE_BYTES: Readonly<Record<Purpose, number>> = { rollouts: 256 * MIB, project: 64 * MIB, store: 64 * MIB, ledger: 16 * MIB, events: 64 * MIB };
export const ENTRY_LIMIT = 20000;
export const DEPTH_LIMIT = 32;
export const PURPOSES = Object.keys(PURPOSE_BYTES) as Purpose[];

export interface CollectedEntry {
  /** Relative to the source. */
  readonly path: string;
  readonly size: number | null;
  readonly sha256: string | null;
  readonly problem: string | null;
}
export interface Collected { readonly missing: boolean; readonly entries: readonly CollectedEntry[] }

const special = (st: { isFIFO(): boolean; isSocket(): boolean; isBlockDevice(): boolean; isCharacterDevice(): boolean }): string =>
  st.isFIFO() ? "fifo" : st.isSocket() ? "socket" : st.isBlockDevice() ? "block-device" : st.isCharacterDevice() ? "char-device" : "other";

/** One purpose's copy of `src` into `dest`; see the header. Limits are overridable for the tests' sake only. */
export function collectTree(purpose: Purpose, src: string, dest: string, limits: { bytes?: number; entries?: number; depth?: number } = {}): Collected {
  try { lstatSync(src); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { missing: true, entries: [] };
    return { missing: false, entries: [{ path: ".", size: null, sha256: null, problem: `could not be read (${(e as NodeJS.ErrnoException).code ?? "unknown"})` }] };
  }
  const budget = byteBudget(limits.bytes ?? PURPOSE_BYTES[purpose]);
  const maxEntries = limits.entries ?? ENTRY_LIMIT;
  const maxDepth = limits.depth ?? DEPTH_LIMIT;
  const entries: CollectedEntry[] = [];
  const problem = (path: string, text: string): void => { entries.push({ path, size: null, sha256: null, problem: text }); };
  let count = 0;
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const walked = walkNoFollow(src, purpose, {
    include: (rel, st) => {
      if (rel === ".") return true;
      if (++count > maxEntries) { if (count === maxEntries + 1) problem(rel, `past the ${maxEntries} entry limit; nothing from here on is collected`); return false; }
      if (rel.split(sep).length > maxDepth) { problem(rel, `past the depth limit of ${maxDepth}`); return false; }
      if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) { problem(rel, `a special file (${special(st)})`); return false; }
      return true;
    },
    folder: (rel) => { if (rel !== ".") mkdirSync(join(dest, rel), { mode: 0o700 }); },
    link: (rel) => { problem(rel, "a link"); },
    file: (rel, fd) => {
      const to = openSync(join(dest, rel), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let r: ReturnType<typeof copyBounded>;
      try { r = copyBounded(fd, to, budget); } finally { closeSync(to); }
      if (r !== null) {
        rmSync(join(dest, rel), { force: true });
        if ("code" in r) return r.code;
        problem(rel, `past the ${purpose} limit of ${r.over} bytes`);
        return null;
      }
      const h = createHash("sha256");
      const copy = openSync(join(dest, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
      let size = 0;
      try { const b = Buffer.allocUnsafe(MIB); for (let n = readSync(copy, b, 0, MIB, null); n > 0; n = readSync(copy, b, 0, MIB, null)) { h.update(b.subarray(0, n)); size += n; } } finally { closeSync(copy); }
      entries.push({ path: rel, size, sha256: h.digest("hex"), problem: null });
      return null;
    },
    problem: (rel, kind) => {
      rmSync(join(dest, rel), { recursive: true, force: true });
      problem(rel, kind === "changed" ? "changed while it was read" : kind === "unreadable" ? "could not be read" : "not a file, a folder or a link");
    },
  });
  // A finding the walk names without an entry (the root itself) is kept under ".".
  for (const w of walked.problems) if (!entries.some((e) => e.problem !== null && w.includes(`${purpose}/${e.path}`))) problem(".", w);
  return { missing: false, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** lib's treeDigest form (`link:<target>`, `dir`, the file's sha256, or the special kind) read without following. */
export function digestTree(root: string): { readonly digest: Record<string, string>; readonly problems: readonly string[] } {
  const out: Record<string, string> = {};
  try { lstatSync(root); } catch { return { digest: out, problems: [] }; }
  const { problems } = walkNoFollow(root, "project", {
    include: (rel, st) => {
      if (rel === ".") return true;
      if (st.isDirectory()) out[`${rel}/`] = "dir";
      else if (!st.isFile() && !st.isSymbolicLink()) { out[rel] = special(st); return false; }
      return true;
    },
    link: (rel, target) => { out[rel] = `link:${target}`; },
    file: (rel, fd) => {
      const h = createHash("sha256");
      const b = Buffer.allocUnsafe(MIB);
      for (let n = readSync(fd, b, 0, MIB, null); n > 0; n = readSync(fd, b, 0, MIB, null)) h.update(b.subarray(0, n));
      out[rel] = h.digest("hex");
      return null;
    },
  });
  return { digest: out, problems };
}

// --- the credential scan over files (5.9) ---------------------------------------------------------------

export const SCAN_CHUNK = 1024 * 1024;

export interface FileHit extends CredentialHit { readonly file: string }
export interface ScanResult {
  readonly hits: readonly FileHit[];
  /** A file that could not be read whole, a link (never followed) or a special file: each makes the attempt invalid too. */
  readonly unreadable: readonly string[];
  readonly files: number;
}

/**
 * Every file under each path, read whole without following links, in 1 MiB chunks through the credential
 * stream (F6), which carries an unfinished candidate across each boundary. A hit is the file, the byte offset and the pattern, never the
 * value. A clean result is never proof of absence.
 */
export function scanFiles(paths: readonly string[], secrets: readonly string[] = []): ScanResult {
  const hits: FileHit[] = [];
  const unreadable: string[] = [];
  let files = 0;
  for (const root of paths) {
    let rootIsFile = false;
    try { rootIsFile = lstatSync(root).isFile(); } catch { unreadable.push(`${root}: missing`); continue; }
    const scanFd = (file: string, fd: number): void => {
      files += 1;
      const stream = new CredentialStream(secrets);
      const buf = Buffer.allocUnsafe(SCAN_CHUNK);
      for (let n = readSync(fd, buf, 0, SCAN_CHUNK, null); n > 0; n = readSync(fd, buf, 0, SCAN_CHUNK, null)) stream.push(buf.subarray(0, n));
      for (const h of stream.hits()) hits.push({ file, offset: h.offset, pattern: h.pattern });
    };
    if (rootIsFile) {
      const fd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { scanFd(root, fd); } finally { closeSync(fd); }
      continue;
    }
    const { problems } = walkNoFollow(root, root, {
      include: (_rel, st) => { if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) unreadable.push(`${join(root, _rel)}: a special file`); return st.isFile() || st.isDirectory() || st.isSymbolicLink(); },
      // A link is never followed and holds no bytes of its own to scan (the archive keeps the project's links as links).
      link: () => {},
      file: (rel, fd) => { scanFd(join(root, rel), fd); return null; },
    });
    unreadable.push(...problems);
  }
  return { hits: hits.sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset), unreadable, files };
}

/** One hit as a line: never the value. */
export const hitText = (h: FileHit): string => `${h.file} at byte ${h.offset} (${h.pattern})`;

const main = process.argv[1] !== undefined && /onboarding-eval-collect\.[jt]s$/.test(process.argv[1]);
if (main) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "requests" && rest.length === 1) void requestsWorker(rest[0]!, process.stdin, process.stdout);
  else if (mode === "collect" && rest.length === 3 && (PURPOSES as string[]).includes(rest[0]!)) process.stdout.write(`${JSON.stringify(collectTree(rest[0] as Purpose, rest[1]!, rest[2]!))}\n`);
  else if (mode === "project-scan" && rest.length === 1) void import("./onboarding-eval-config.js").then((m) => process.stdout.write(`${JSON.stringify(m.projectScanProblems(rest[0]!))}\n`));
  else if (mode === "digest" && rest.length === 1) process.stdout.write(`${JSON.stringify(digestTree(rest[0]!))}\n`);
  else if (mode === "archive" && rest.length === 2) void import("./onboarding-eval-run.js").then((m) => process.stdout.write(`${JSON.stringify(m.archiveProject(rest[0]!, rest[1]!))}\n`));
  else if (mode === "observe" && rest.length === 2) void import("./onboarding-eval-sessions.js").then((m) => process.stdout.write(`${JSON.stringify(m.observeEvidence(rest[0]!, JSON.parse(rest[1]!)))}\n`));
  else if (mode === "scan" && rest.length >= 1) {
    // The held secrets come on stdin, one per line, never on the command line.
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => process.stdout.write(`${JSON.stringify(scanFiles(rest, Buffer.concat(chunks).toString("utf-8").split("\n").filter((x) => x !== "")))}\n`));
  } else if (mode === "snapshot" && rest.length === 1) void import("./onboarding-eval-preserve.js").then((m) => process.stdout.write(`${JSON.stringify({ text: m.treeSnapshot(rest[0]!) })}\n`));
  else if (mode === "ledger-state" && rest.length === 1) void import("./onboarding-eval-sessions.js").then((m) => process.stdout.write(`${JSON.stringify(m.ledgerState(rest[0]!))}\n`));
  else {
    process.stderr.write("usage: onboarding-eval-collect requests <folder> | collect <purpose> <source> <destination> | digest <folder>\n");
    process.exit(2);
  }
}
