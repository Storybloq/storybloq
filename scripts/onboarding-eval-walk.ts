// T-538 S5b-0 commit 4: one walk for any harness read of a tree a turn could shape. The pen's
// note of 2026-11-07 on the ticket: the no-follow, descriptor-relative traversal and path-specific
// error handling that the ledger digest got at commit 1 apply to every such read. The ledger digest
// keeps its own copy until commit 8 moves the capture reads here.
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, writeSync, type Stats } from "node:fs";

/** The points where the tree can change under the walk; a test acts at one to prove the walk holds. */
export type WalkStep = "check" | "readlink" | "enter" | "verify" | "verify-back" | "list" | "open";
export type WalkHook = (step: WalkStep, rel: string) => void;

export interface WalkVisitor {
  /** False leaves the entry out: not entered, not opened, not reported. */
  readonly include?: (rel: string, st: Stats) => boolean;
  readonly link: (rel: string, target: string) => void;
  /** An open descriptor on what was opened, already proven a regular file; the walk closes it. A returned code is a read failure. */
  readonly file: (rel: string, fd: number, st: Stats) => string | null;
  /** Called before the walk enters a folder. */
  readonly folder?: (rel: string, st: Stats) => void;
  /** Each problem as it is found, by its path and kind, besides the named finding the walk returns (commit 6a, ISS-1467). */
  readonly problem?: (rel: string, kind: WalkProblem) => void;
}

/** unreadable: a call on it failed; changed: it was swapped while being read; other: not a file, a folder or a link. */
export type WalkProblem = "unreadable" | "changed" | "other";

class WalkStopped extends Error {}

const CHUNK = 1 << 20;
const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? "unknown";

/**
 * A descriptor's bytes, at most `limit` of them, for a caller that needs a Buffer. The limit holds while
 * reading, so a sparse or growing file stops at it instead of filling memory: one byte past it is "over".
 */
export function readBounded(fd: number, limit: number): { readonly bytes: Buffer } | { readonly code: string } | { readonly over: number } {
  const parts: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(CHUNK);
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, null);
      if (n === 0) break;
      total += n;
      if (total > limit) return { over: limit };
      parts.push(Buffer.from(chunk.subarray(0, n)));
    }
  } catch (e) {
    return { code: codeOf(e) };
  }
  return { bytes: Buffer.concat(parts) };
}

/** A byte budget shared across one copy: every file's bytes count against it as they are read. */
export interface ByteBudget { left: number; readonly limit: number }
export const byteBudget = (limit: number): ByteBudget => ({ left: limit, limit });

/**
 * Copies `from` to `to` one chunk at a time, charging `budget` as it reads, so memory stays one chunk and a
 * file that grows or claims a huge sparse size stops at the budget. Returns null, a read error code, or
 * { over } when the budget ran out; either failure refunds what the file was charged, since the caller
 * removes it. A write failure is the caller's and throws.
 */
export function copyBounded(from: number, to: number, budget: ByteBudget): null | { readonly code: string } | { readonly over: number } {
  const chunk = Buffer.allocUnsafe(CHUNK);
  // A file that is not copied gives its bytes back: the caller removes what was written of it.
  let charged = 0;
  const refund = (): void => { budget.left += charged; };
  for (;;) {
    let n: number;
    try { n = readSync(from, chunk, 0, CHUNK, null); } catch (e) { refund(); return { code: codeOf(e) }; }
    if (n === 0) return null;
    if (n > budget.left) { refund(); return { over: budget.limit }; }
    budget.left -= n;
    charged += n;
    for (let off = 0; off < n;) off += writeSync(to, chunk, off, n - off);
  }
}

/**
 * Walks `root` without following anything. Node has no openat, and the working directory does
 * the same job: once entered and checked it stays that folder whatever is renamed, so children
 * are named by one component. Entering a swapped link, or a way back that lands anywhere but the
 * parent, stops the walk with a finding. Everything else that fails names its path and the walk
 * goes on. `label` names the root in findings. A missing root is reported unless `missingIsEmpty`.
 */
export function walkNoFollow(root: string, label: string, v: WalkVisitor, opts: { readonly hook?: WalkHook; readonly missingIsEmpty?: boolean } = {}): { readonly problems: readonly string[] } {
  const problems: string[] = [];
  const step: WalkHook = opts.hook ?? (() => {});
  const name = (rel: string): string => (rel === "." ? label : `${label}/${rel}`);
  const report = (rel: string, kind: WalkProblem, text: string): void => { problems.push(text); v.problem?.(rel, kind); };
  const failed = (rel: string, e: unknown): void => report(rel, "unreadable", `${name(rel)} could not be read (${(e as NodeJS.ErrnoException).code ?? "unknown"})`);
  const changed = (rel: string): void => report(rel, "changed", `${name(rel)} changed while it was being read`);
  const stopped = (rel: string): never => { changed(rel); throw new WalkStopped(); };
  const identity = (rel: string): Stats => {
    try { return lstatSync("."); } catch (e) { failed(rel, e); throw new WalkStopped(); }
  };
  const isSame = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
  const folder = (rel: string, self: Stats): void => {
    step("list", rel);
    let names: string[];
    try { names = readdirSync(".").sort(); } catch (e) { failed(rel, e); return; }
    for (const n of names) entry(n, rel === "." ? n : `${rel}/${n}`, self);
  };
  const enter = (n: string, rel: string, seen: Stats): boolean => {
    v.folder?.(rel, seen);
    step("enter", rel);
    try { process.chdir(n); } catch (e) { failed(rel, e); return false; }
    step("verify", rel);
    const here = identity(rel);
    if (!isSame(here, seen)) stopped(rel);
    folder(rel, here);
    return true;
  };
  const entry = (n: string, rel: string, parent: Stats): void => {
    step("check", rel);
    let st: Stats;
    try { st = lstatSync(n); } catch (e) { failed(rel, e); return; }
    if (v.include && !v.include(rel, st)) return;
    if (st.isSymbolicLink()) {
      step("readlink", rel);
      let target: string;
      try { target = readlinkSync(n); } catch (e) { failed(rel, e); return; }
      v.link(rel, target);
    } else if (st.isDirectory()) {
      if (enter(n, rel, st)) {
        try { process.chdir(".."); } catch { stopped(rel); }
        step("verify-back", rel);
        if (!isSame(identity(rel), parent)) stopped(rel);
      }
    } else if (st.isFile()) {
      step("open", rel);
      let fd: number;
      try { fd = openSync(n, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); } catch (e) { failed(rel, e); return; }
      try {
        let opened: Stats;
        try { opened = fstatSync(fd); } catch (e) { failed(rel, e); return; }
        if (!opened.isFile() || !isSame(opened, st)) { changed(rel); return; }
        // A read failure is the visitor's to name (readBounded, copyBounded above); a write failure is the harness's and throws.
        const code = v.file(rel, fd, opened);
        if (code !== null) report(rel, "unreadable", `${name(rel)} could not be read (${code})`);
      } finally {
        closeSync(fd);
      }
    } else report(rel, "other", `${name(rel)} is not a regular file, a folder or a link`);
  };
  const start = process.cwd();
  try {
    let st: Stats | null = null;
    try { st = lstatSync(root); } catch (e) { if (!(opts.missingIsEmpty && (e as NodeJS.ErrnoException).code === "ENOENT")) failed(".", e); }
    if (st !== null) {
      if (!st.isDirectory()) report(".", "other", `${label} is not a folder`);
      else enter(root, ".", st);
    }
  } catch (e) {
    if (!(e instanceof WalkStopped)) throw e;
  } finally {
    process.chdir(start);
  }
  return { problems };
}
