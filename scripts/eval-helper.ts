// T-538 S5b-0 commit 6a: helper.js, the one program the host runs inside an attempt to read it (plan v10
// section 8). Bundled from the same functions the host used, so a regrade keeps its meaning. Every
// operation prints exactly one JSON document on stdout; a failure prints {"error": ...} and exits 1.
// It runs as eval inside the running attempt, so it reads only what that uid can read.
import { spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { runtimeExclusion, treeDigest } from "./onboarding-eval-lib.js";
import { ledgerState, observeEvidence } from "./onboarding-eval-sessions.js";
import { readBounded, walkNoFollow, type WalkHook } from "./onboarding-eval-walk.js";

export const HELPER_OPS = ["tree-digest", "runtime-exclusion", "ledger-digest", "observe-evidence", "rollout-lines", "process-count", "read-bytes", "capture-live"] as const;
export type HelperOp = (typeof HELPER_OPS)[number];

/** The read-bytes answer: absent, not a regular file, over the limit, or the bytes. */
export type ReadAnswer = { readonly absent: true } | { readonly refused: string } | { readonly base64: string };

/** One file, opened without following a link, regular only, at most `limit` bytes. */
export function readBytesAt(path: string, limit: number): ReadAnswer {
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { absent: true };
    return { refused: code === "ELOOP" ? "a symlink" : `could not be opened (${code ?? "error"})` };
  }
  try {
    if (!fstatSync(fd).isFile()) return { refused: "not a regular file" };
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    for (let r = 1; r > 0 && n <= limit; n += r) r = readSync(fd, buf, n, limit + 1 - n, null);
    if (n > limit) return { refused: `over the limit of ${limit} bytes` };
    return { base64: buf.subarray(0, n).toString("base64") };
  } finally {
    closeSync(fd);
  }
}

/** One rollout file's limit; a file past it is a problem, never read on. */
export const ROLLOUT_FILE_LIMIT = 64 * 1048576;

/**
 * Every parsed line of a thread's rollout files under a CODEX_HOME's sessions folder. It walks from the
 * CODEX_HOME one component at a time with commit 4's no-follow walk: a linked sessions folder or rollout
 * is never followed, and each file is read through the descriptor the walk opened and proved regular, up
 * to its limit, so a file swapped for a link or a fifo after it was found is a problem, not foreign bytes
 * or a hang. Partial lines are skipped; a link where the sessions folder or a rollout belongs is a problem.
 */
export function rolloutLinesUnder(codexHome: string, threadId: string, hook?: WalkHook): { readonly lines: Record<string, unknown>[]; readonly problems: readonly string[] } {
  const lines: Record<string, unknown>[] = [];
  const over: string[] = [];
  const rollout = (rel: string): boolean => rel.endsWith(".jsonl") && (rel.split("/").pop() ?? "").includes(threadId);
  const { problems } = walkNoFollow(codexHome, "CODEX_HOME", {
    // The sessions folder and this thread's rollouts, as links too, so a link where one belongs is named.
    include: (rel, st) => (rel === "sessions" ? st.isDirectory() || st.isSymbolicLink() : rel.startsWith("sessions/") && (st.isDirectory() || ((st.isFile() || st.isSymbolicLink()) && rollout(rel)))),
    link: (rel) => { over.push(`CODEX_HOME/${rel} is a link, not followed`); },
    file: (rel, fd) => {
      const r = readBounded(fd, ROLLOUT_FILE_LIMIT);
      if ("code" in r) return r.code;
      if ("over" in r) { over.push(`CODEX_HOME/${rel} is over the limit of ${ROLLOUT_FILE_LIMIT} bytes`); return null; }
      for (const l of r.bytes.toString("utf-8").split("\n")) { try { const v = JSON.parse(l); if (v && typeof v === "object") lines.push(v); } catch { /* partial line */ } }
      return null;
    },
  }, { hook, missingIsEmpty: true });
  return { lines, problems: [...problems, ...over] };
}

/** Processes whose command line contains `needle`, from /proc; `outsideGroup` counts those not in this group. */
export function processCount(needle: string, proc = "/proc", self = process.pid): { readonly matching: number; readonly outsideGroup: number } {
  let matching = 0;
  let outsideGroup = 0;
  const ownGroup = groupOf(join(proc, String(self)));
  for (const name of existsSync(proc) ? readdirSync(proc) : []) {
    if (!/^\d+$/.test(name) || Number(name) === self) continue;
    let cmd: string;
    try { cmd = readFileSync(join(proc, name, "cmdline"), "utf8").split("\0").join(" "); } catch { continue; }
    if (needle !== "" && cmd.includes(needle)) matching += 1;
    const g = groupOf(join(proc, name));
    if (g !== null && g !== ownGroup) outsideGroup += 1;
  }
  return { matching, outsideGroup };
}

function groupOf(dir: string): number | null {
  try {
    // The comm field may hold spaces or parentheses: fields are counted after its last ")".
    const stat = readFileSync(join(dir, "stat"), "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(rest[2]);
    return Number.isInteger(pgrp) ? pgrp : null;
  } catch {
    return null;
  }
}

export interface LiveTry {
  readonly d1: string;
  readonly d2: string;
  readonly problems: readonly string[];
  readonly packExit: number | null;
  readonly tarBase64: string;
  readonly recordsBase64: string;
  readonly readiness: readonly { readonly argv: readonly string[]; readonly status: number | null; readonly stdout: string }[];
  readonly outsideGroup: number;
}

export interface LiveIo {
  readonly pack: () => { readonly status: number | null; readonly stdout: Buffer; readonly stderr: Buffer };
  readonly cli: (argv: readonly string[]) => { readonly status: number | null; readonly stdout: string };
  readonly outside: () => number;
}

/** One try of section 9's boundary: digest, the live pack, the readiness outputs, digest again. */
export function liveTry(story: string, readiness: readonly (readonly string[])[], io: LiveIo): LiveTry {
  const first = ledgerState(story);
  const p = io.pack();
  const outputs = readiness.map((argv) => ({ argv, ...io.cli(argv) }));
  const second = ledgerState(story);
  return {
    d1: first.digest, d2: second.digest, problems: [...first.problems, ...second.problems], packExit: p.status,
    tarBase64: p.stdout.toString("base64"), recordsBase64: p.stderr.toString("base64"), readiness: outputs, outsideGroup: io.outside(),
  };
}

const PACK_TIMEOUT_MS = 120_000;
const LIVE_LIMIT = 48 * 1048576;
const realLive: LiveIo = {
  pack: () => {
    const r = spawnSync("bash", ["/opt/eval/pack.sh", "live"], { cwd: "/vol/att/project", maxBuffer: LIVE_LIMIT, timeout: PACK_TIMEOUT_MS });
    return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
  },
  cli: (argv) => {
    const r = spawnSync("/opt/eval/bin/storybloq", argv, { cwd: "/vol/att/project", encoding: "utf8", maxBuffer: 4 * 1048576, timeout: PACK_TIMEOUT_MS });
    return { status: r.status, stdout: r.stdout ?? "" };
  },
  outside: () => processCount("").outsideGroup,
};

/** The dispatch, separate from the process so a test can call it. */
export function runOp(op: string, args: readonly string[], live: LiveIo = realLive): unknown {
  const need = (n: number): void => { if (args.length !== n) throw new Error(`${op} takes ${n} arguments`); };
  switch (op) {
    case "tree-digest": need(1); return treeDigest(args[0]!);
    case "runtime-exclusion": need(1); return runtimeExclusion(args[0]!);
    case "ledger-digest": need(1); return ledgerState(args[0]!);
    case "observe-evidence": {
      need(3);
      const index = Number(args[2]);
      if ((args[1] !== "turn" && args[1] !== "event") || !Number.isSafeInteger(index) || index < 0) throw new Error("observe-evidence takes a project, turn or event, and an index");
      return observeEvidence(args[0]!, { kind: args[1], index });
    }
    case "rollout-lines": need(2); return rolloutLinesUnder(args[0]!, args[1]!);
    case "process-count": need(1); return processCount(args[0]!);
    case "read-bytes": {
      need(2);
      const limit = Number(args[1]);
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("read-bytes takes a byte limit");
      return readBytesAt(args[0]!, limit);
    }
    case "capture-live": {
      if (args.length < 1) throw new Error("capture-live takes the ledger folder and readiness commands");
      const readiness = args.slice(1).map((a) => JSON.parse(a) as unknown);
      if (!readiness.every((r) => Array.isArray(r) && r.every((x) => typeof x === "string"))) throw new Error("a readiness command is a JSON string array");
      return liveTry(args[0]!, readiness as string[][], live);
    }
    default: throw new Error(`unknown helper operation ${op}`);
  }
}

// Run as the bundle's entry: one document out, never a partial one.
if (process.argv[1] !== undefined && /eval-helper\.js$|helper\.js$/.test(process.argv[1])) {
  let out: string;
  let code = 0;
  try { out = JSON.stringify({ ok: runOp(process.argv[2] ?? "", process.argv.slice(3)) }); } catch (e) { out = JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); code = 1; }
  process.stdout.write(`${out}\n`, () => process.exit(code));
}
