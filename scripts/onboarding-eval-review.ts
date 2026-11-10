/**
 * T-538 commit 2b (plan 5.5): served reviews. The evaluation CLI entry forwards `setup-review gate|run|status`
 * as a request file; the harness checks it here, runs this checkout's real CLI on the host for exactly the
 * shapes below, and answers through a folder outside every root. The request folder is model-writable, so
 * nothing in it is trusted: names, fields and bytes are all checked before anything runs.
 *
 * Node built-ins only, plus the product's setup id pattern.
 */
import { createHash } from "node:crypto";
import { closeSync, type Dirent, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInGroup, type GroupControl, type GroupRun } from "../src/core/process-group.js";
import { SETUP_ID_PATTERN } from "../src/core/setup-review.js";

/** A request id: `<pid>-<counter>`. */
export const REQUEST_ID = /^[0-9]{1,10}-[0-9]{1,6}$/;
/** A published request's file name; anything else in the folder is ignored and logged. */
export const REQUEST_NAME = /^[0-9]{1,10}-[0-9]{1,6}\.json$/;

export const REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export const STDIN_MAX_BYTES = 1024 * 1024;
export const STREAM_CAP_BYTES = 1024 * 1024;
export const MAX_ARGV = 8;
export const MAX_ARG_CHARS = 600;
export const MAX_REASON_CHARS = 500;

/** Exit codes a served command answers with when the harness refuses it. */
export const EXIT_REFUSED = 64;
export const EXIT_CREDENTIAL = 65;
export const EXIT_NO_ANSWER = 70;
export const EXIT_BUDGET = 75;
export const NO_ANSWER_TEXT = "setup-review: the harness did not answer";
export const BUDGET_TEXT = "setup-review: the evaluation's review budget is spent";

/** At most this many served commands per attempt, and of them at most this many `run`. */
export const SERVED_BUDGET = 16;
export const RUN_BUDGET = 6;

/** The forwarding entry's wait for its answer. */
export const FORWARD_WAIT_MS = 25 * 60 * 1000;
/** A served command's own cap; the turn's remainder less the grace can shorten it. */
export const SERVED_DEADLINE_MS = 20 * 60 * 1000;

export type ReviewVerb = "gate" | "run" | "status";

export interface ReviewRequest {
  readonly id: string;
  readonly argv: readonly string[];
  readonly stdinBase64: string;
  readonly cwd: string;
}

/**
 * Whether `args` (after `setup-review`) is one of the served shapes: `gate`, `gate --setup <SS>`,
 * `run --setup <SS>` with optionally `--backend codex` and optionally `--new-cycle --reason <text>`,
 * `status --setup <SS>`, `status --setup <SS> --skipped`. Returns the problem, or null.
 */
export function argvProblem(args: readonly string[]): string | null {
  const ss = (x: string | undefined): boolean => x !== undefined && SETUP_ID_PATTERN.test(x);
  const [verb, ...rest] = args;
  if (verb === "gate") {
    if (rest.length === 0) return null;
    if (rest.length === 2 && rest[0] === "--setup" && ss(rest[1])) return null;
    return "gate takes nothing or --setup <setup id>";
  }
  if (verb === "status") {
    if (rest[0] !== "--setup" || !ss(rest[1])) return "status needs --setup <setup id>";
    if (rest.length === 2 || (rest.length === 3 && rest[2] === "--skipped")) return null;
    return "status takes --setup <setup id> and optionally --skipped";
  }
  if (verb === "run") {
    if (rest[0] !== "--setup" || !ss(rest[1])) return "run needs --setup <setup id>";
    let i = 2;
    let backend = false;
    let cycle = false;
    while (i < rest.length) {
      if (rest[i] === "--backend" && !backend && rest[i + 1] === "codex") { backend = true; i += 2; continue; }
      if (rest[i] === "--new-cycle" && !cycle && rest[i + 1] === "--reason" && rest[i + 2] !== undefined) {
        const reason = rest[i + 2]!;
        if (reason.length === 0 || reason.length > MAX_REASON_CHARS || /[\r\n]/.test(reason)) return `the --reason text must be 1 to ${MAX_REASON_CHARS} characters with no newline`;
        cycle = true;
        i += 3;
        continue;
      }
      return `run does not take ${JSON.stringify(rest[i])} there`;
    }
    return null;
  }
  return `setup-review ${JSON.stringify(verb ?? "")} is not served`;
}

/**
 * `reviewRequestProblems`: the request file's own checks, from its name and its bytes (already read bounded,
 * without following links). Returns the parsed request, or the first problem.
 */
export function reviewRequestProblems(name: string, bytes: Buffer, project: string): { readonly request: ReviewRequest } | { readonly problem: string } {
  if (!REQUEST_NAME.test(name)) return { problem: `request name ${JSON.stringify(name)} is not <pid>-<counter>.json` };
  if (bytes.length > REQUEST_MAX_BYTES) return { problem: `the request is over ${REQUEST_MAX_BYTES} bytes` };
  let v: unknown;
  try { v = JSON.parse(bytes.toString("utf-8")); } catch { return { problem: "the request is not JSON" }; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { problem: "the request is not an object" };
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (keys.join(",") !== "argv,cwd,id,stdinBase64") return { problem: "the request must have exactly id, argv, stdinBase64 and cwd" };
  if (typeof r.id !== "string" || r.id !== name.slice(0, -".json".length)) return { problem: "the request's id is not its file name" };
  if (!Array.isArray(r.argv) || r.argv.length > MAX_ARGV || r.argv.some((a) => typeof a !== "string" || a.length > MAX_ARG_CHARS)) {
    return { problem: `argv must be at most ${MAX_ARGV} strings of at most ${MAX_ARG_CHARS} characters` };
  }
  if (typeof r.stdinBase64 !== "string") return { problem: "stdinBase64 is not a string" };
  if (typeof r.cwd !== "string") return { problem: "cwd is not a string" };
  if (r.cwd !== project) return { problem: "cwd is not the project root" };
  const shape = argvProblem(r.argv as string[]);
  if (shape !== null) return { problem: shape };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(r.stdinBase64) || r.stdinBase64.length % 4 !== 0) return { problem: "stdinBase64 is not base64" };
  if (Buffer.from(r.stdinBase64, "base64").length > STDIN_MAX_BYTES) return { problem: `the decoded stdin is over ${STDIN_MAX_BYTES} bytes` };
  return { request: { id: r.id, argv: r.argv as string[], stdinBase64: r.stdinBase64, cwd: r.cwd } };
}

/** One credential form found in bytes: where, and which pattern, never the value. */
export interface CredentialHit {
  readonly offset: number;
  readonly pattern: string;
}

const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "sk-ant-", re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: "sk-", re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: "rt_", re: /rt_[A-Za-z0-9_-]{16,}/g },
  { name: "token key", re: /"?(?:refresh_token|access_token|id_token)"?\s*[:=]\s*["'][^"'\s]{20,}["']/g },
];

/**
 * 5.9's scan over one buffer (the served stdin in 2b): the forms above, and the exact value of a secret held in
 * memory when one is given. The value is compared, never printed or stored.
 */
export function scanForCredentials(bytes: Buffer, secrets: readonly string[] = []): CredentialHit[] {
  const text = bytes.toString("latin1");
  const hits: CredentialHit[] = [];
  for (const p of CREDENTIAL_PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m !== null; m = p.re.exec(text)) hits.push({ offset: m.index, pattern: p.name });
  }
  for (const s of secrets) {
    if (s.length === 0) continue;
    const at = bytes.indexOf(Buffer.from(s, "utf-8"));
    if (at >= 0) hits.push({ offset: at, pattern: "held secret" });
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

/** F6: the longest unfinished candidate the stream carries; one longer is itself a hit (fail closed). */
export const CANDIDATE_MAX = 64 * 1024;
export const OVERLONG_CANDIDATE = "over-long candidate";
const TOKEN_KEYS = ["refresh_token", "access_token", "id_token"] as const;
const isTok = (c: string): boolean => /[A-Za-z0-9_-]/.test(c);
const isSpace = (c: string): boolean => /\s/.test(c);

/**
 * Where the earliest candidate still open at the end of `t` starts (t.length when none): a form above, or a held
 * secret, that more bytes could still complete or extend. It walks back from the end, so it is linear in the tail.
 */
export function openCandidateStart(t: string, secrets: readonly string[] = []): number {
  const end = t.length;
  let start = end;
  const take = (s: number): void => { if (s < start) start = s; };
  // sk-, sk-ant- and rt_: their whole open candidate lies in the trailing run of token characters.
  let run = end;
  while (run > 0 && isTok(t[run - 1]!)) run--;
  const tail = t.slice(run);
  for (const p of ["sk-", "rt_"]) {
    const at = tail.indexOf(p);
    if (at >= 0) take(run + at);
    for (let k = p.length - 1; k >= 1; k--) if (tail.endsWith(p.slice(0, k))) { take(end - k); break; }
  }
  // jwt: in the trailing run of token characters and dots, the first eyJ with at most two dots after it.
  let jrun = end;
  while (jrun > 0 && (isTok(t[jrun - 1]!) || t[jrun - 1] === ".")) jrun--;
  let dots = 0;
  let firstJ = -1;
  for (let i = end - 1; i >= jrun; i--) {
    if (t[i] === ".") dots++;
    if (dots <= 2 && t.startsWith("eyJ", i)) firstJ = i;
  }
  if (firstJ >= 0) take(firstJ);
  for (const k of [2, 1]) if (t.endsWith("eyJ".slice(0, k))) { take(end - k); break; }
  // token key: key"? \s* [:=] \s* ["'] value, open at any point after its first character.
  const keyBefore = (p: number): number => {
    let q = p;
    if (q > 0 && t[q - 1] === '"') q--;
    for (const kw of TOKEN_KEYS) if (q >= kw.length && t.startsWith(kw, q - kw.length)) return q - kw.length > 0 && t[q - kw.length - 1] === '"' ? q - kw.length - 1 : q - kw.length;
    return -1;
  };
  const skipSpace = (p: number): number => { while (p > 0 && isSpace(t[p - 1]!)) p--; return p; };
  let v = end;
  while (v > 0 && !/["'\s]/.test(t[v - 1]!)) v--;
  if (v > 0 && (t[v - 1] === '"' || t[v - 1] === "'")) {
    const p = skipSpace(v - 1);
    if (p > 0 && (t[p - 1] === ":" || t[p - 1] === "=")) { const s = keyBefore(skipSpace(p - 1)); if (s >= 0) take(s); }
  }
  const sep = skipSpace(end);
  if (sep > 0 && (t[sep - 1] === ":" || t[sep - 1] === "=")) { const s = keyBefore(skipSpace(sep - 1)); if (s >= 0) take(s); }
  { const s = keyBefore(skipSpace(end)); if (s >= 0) take(s); }
  for (const kw of TOKEN_KEYS) for (const full of [`"${kw}`, kw]) {
    for (let k = full.length - 1; k >= 1; k--) if (t.endsWith(full.slice(0, k))) { take(end - k); break; }
  }
  // A held secret: the longest end of t that begins it.
  for (const s of secrets) {
    const v8 = Buffer.from(s, "utf-8").toString("latin1");
    for (let k = Math.min(v8.length - 1, end); k >= 1; k--) if (t.endsWith(v8.slice(0, k))) { take(end - k); break; }
  }
  return start;
}

/**
 * F6 and F10: the scan over bytes that arrive in pieces. Each piece is scanned with the unfinished candidate
 * carried from the last, so a form or a held secret across a boundary is seen whatever its length; a candidate
 * still open past CANDIDATE_MAX bytes is a hit itself. Offsets are from the first byte pushed.
 */
/** H2: a stream keeps at most this many distinct hits; past it, further hits are not kept (the first is what any caller acts on). */
export const STREAM_HITS_MAX = 64;

export class CredentialStream {
  private carry: Buffer = Buffer.alloc(0);
  private base = 0;
  private readonly seen = new Set<string>();
  private readonly found: CredentialHit[] = [];
  constructor(private readonly secrets: readonly string[] = []) {}

  /** Scans one more piece; returns the hits it found first (empty when none). */
  push(piece: Buffer): CredentialHit[] {
    const window = Buffer.concat([this.carry, piece]);
    const fresh: CredentialHit[] = [];
    const add = (offset: number, pattern: string): void => {
      const key = `${offset}:${pattern}`;
      if (this.found.length >= STREAM_HITS_MAX || this.seen.has(key)) return;
      this.seen.add(key); const h = { offset, pattern }; this.found.push(h); fresh.push(h);
    };
    for (const h of scanForCredentials(window, this.secrets)) add(this.base + h.offset, h.pattern);
    const text = window.toString("latin1");
    const open = openCandidateStart(text, this.secrets);
    if (text.length - open > CANDIDATE_MAX) {
      add(this.base + open, OVERLONG_CANDIDATE);
      this.base += window.length;
      this.carry = Buffer.alloc(0);
    } else {
      this.base += open;
      this.carry = Buffer.from(window.subarray(open));
    }
    return fresh;
  }

  hits(): CredentialHit[] {
    return [...this.found].sort((a, b) => a.offset - b.offset);
  }

  /** H2: how much the stream holds: its kept hits and the carried bytes. */
  size(): { readonly hits: number; readonly carry: number } {
    return { hits: this.found.length, carry: this.carry.length };
  }
}

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The answer the harness publishes for a request, each stream capped. */
export interface ReviewResponse {
  readonly id: string;
  readonly exit: number;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly truncated: boolean;
}

export function reviewResponse(id: string, exit: number, stdout: Buffer, stderr: Buffer): ReviewResponse {
  const truncated = stdout.length > STREAM_CAP_BYTES || stderr.length > STREAM_CAP_BYTES;
  return {
    id, exit,
    stdoutBase64: stdout.subarray(0, STREAM_CAP_BYTES).toString("base64"),
    stderrBase64: stderr.subarray(0, STREAM_CAP_BYTES).toString("base64"),
    truncated,
  };
}

/**
 * The served-review budget, charged at the claim before any spawn: the next command past 16 served, or a
 * `run` past 6, is answered `exit 75`.
 */
export class ReviewBudget {
  private served = 0;
  private runs = 0;
  /** Charges one claim; false when the budget is spent (and nothing is charged). */
  charge(verb: string): boolean {
    if (this.served >= SERVED_BUDGET || (verb === "run" && this.runs >= RUN_BUDGET)) return false;
    this.served++;
    if (verb === "run") this.runs++;
    return true;
  }
}

// --- the harness side: claim, check, serve, answer --------------------------------------------------------

/** One record a served command added to the review store. */
export interface PublishedRecord {
  readonly setupId: string;
  readonly cycle: number;
  readonly recordId: string;
  /** The record's revision sha256: the packet the reviewer was given. */
  readonly packetSha256: string;
  readonly files: Readonly<Record<string, string>>;
}

/** One line of `served-reviews.jsonl`, a replay input. */
export interface ServedLine {
  readonly id: string;
  readonly argv: readonly string[] | null;
  readonly stdinSha256: string | null;
  readonly exit: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly start: string;
  readonly end: string;
  readonly refused?: string;
  readonly published: readonly PublishedRecord[];
}

/** What one served command came to, from whatever ran it. */
export interface ServedRun {
  readonly exit: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly timedOut: boolean;
}

/** The served commands of one attempt, one JSON line each: a replay input. */
export const SERVED_RAW = "served-reviews.jsonl";
/** The request folder's turn failures all start with this. */
export const REVIEW_FAILURE_PREFIX = "review requests: ";

export function servedLinesText(lines: readonly ServedLine[]): string {
  return lines.map((l) => `${JSON.stringify(l)}\n`).join("");
}

/** The served lines of a replay input, or the reason they cannot be read. */
export function parseServedLines(text: string): { readonly lines: ServedLine[] } | { readonly problem: string } {
  const out: ServedLine[] = [];
  const hex = (x: unknown): boolean => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
  const strs = (x: unknown): boolean => Array.isArray(x) && x.every((y) => typeof y === "string");
  const rows = text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : null;
  if (rows === null) return { problem: "the last line is not terminated" };
  for (const [i, row] of rows.entries()) {
    let v: Record<string, unknown>;
    try { v = JSON.parse(row) as Record<string, unknown>; } catch { return { problem: `line ${i + 1} is not JSON` }; }
    const published = v?.published;
    const ok = v !== null && typeof v === "object" && typeof v.id === "string" && REQUEST_ID.test(v.id)
      && (v.argv === null || strs(v.argv)) && (v.stdinSha256 === null || hex(v.stdinSha256)) && Number.isInteger(v.exit)
      && hex(v.stdoutSha256) && hex(v.stderrSha256) && typeof v.start === "string" && typeof v.end === "string"
      && (v.refused === undefined || typeof v.refused === "string") && Array.isArray(published)
      && published.every((p: Record<string, unknown>) => p !== null && typeof p === "object" && typeof p.setupId === "string" && typeof p.cycle === "number"
        && typeof p.recordId === "string" && hex(p.packetSha256) && p.files !== null && typeof p.files === "object" && Object.values(p.files as object).every(hex));
    if (!ok) return { problem: `line ${i + 1} is not a served line` };
    out.push(v as unknown as ServedLine);
  }
  return { lines: out };
}

/** Runs the product CLI's `setup-review <args>` with the decoded stdin; `stop` is set while it runs. */
/** F10: `watch` sees every output chunk as it arrives, before any cap, so the credential scan sees what truncation drops. */
export type ServeCommand = (args: readonly string[], stdin: Buffer, timeoutMs: number, setStop: (stop: (() => void) | null) => void, watch: (chunk: Buffer, stream: "stdout" | "stderr") => void) => Promise<ServedRun>;

/** Every file under the store's `<project key>/<setup id>/records/`, by store-relative path, with its sha256. */
export function storeRecordFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const dirs = (p: string): string[] => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name); } catch { return []; } };
  for (const key of dirs(root)) {
    for (const ss of dirs(join(root, key))) {
      const records = join(root, key, ss, "records");
      // The product writes records/<record id>/record.json; a file straight under records/ is listed too, so a
      // record planted beside the product's folders is never missed.
      let entries: Dirent[] = [];
      try { entries = readdirSync(records, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile()) out.set(`${key}/${ss}/records/${e.name}`, sha256(readFileSync(join(records, e.name))));
        else if (e.isDirectory() && !e.isSymbolicLink()) {
          let files: string[] = [];
          try { files = readdirSync(join(records, e.name), { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name); } catch { continue; }
          for (const n of files) out.set(`${key}/${ss}/records/${e.name}/${n}`, sha256(readFileSync(join(records, e.name, n))));
        }
      }
    }
  }
  return out;
}

/** The records a command published: record files new or changed between the two listings, read as records. */
export function publishedRecords(root: string, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): PublishedRecord[] {
  const out: PublishedRecord[] = [];
  for (const [path, sha] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    if (before.get(path) === sha || !path.endsWith(".json")) continue;
    let v: Record<string, unknown>;
    try { v = JSON.parse(readFileSync(join(root, path), "utf-8")) as Record<string, unknown>; } catch { continue; }
    if (typeof v.setupId !== "string" || typeof v.cycle !== "number" || typeof v.recordId !== "string" || typeof v.revisionSha256 !== "string") continue;
    out.push({ setupId: v.setupId, cycle: v.cycle, recordId: v.recordId, packetSha256: v.revisionSha256, files: { [path]: sha } });
  }
  return out;
}

/** The verb a request asks for, read only to charge the budget; anything unreadable is not a `run`. */
export function requestVerb(bytes: Buffer): string {
  try {
    const v = JSON.parse(bytes.toString("utf-8")) as { argv?: unknown } | null;
    return Array.isArray(v?.argv) && typeof v.argv[0] === "string" ? v.argv[0] : "";
  } catch {
    return "";
  }
}

export interface ReviewServerOptions {
  readonly requests: string;
  readonly responses: string;
  readonly project: string;
  readonly store: string;
  readonly budget: ReviewBudget;
  /** Values compared in memory by the scan, never stored. */
  readonly secrets: readonly string[];
  /** The served command's deadline right now: the smallest of 20 minutes and the turn's remainder less the grace. */
  readonly deadlineMs: () => number;
  readonly serve: ServeCommand;
  readonly log: (line: ServedLine) => void;
  readonly now?: () => Date;
  /** Test seam (H2): the two output streams of each served command, as they are made. */
  readonly onStreams?: (streams: { readonly stdout: CredentialStream; readonly stderr: CredentialStream }) => void;
}

/**
 * The harness's side of 5.5 for one attempt. `offer` takes a poll's entries (in claim order); each id is
 * claimed once (exclusive create of `<id>.claimed` in the response folder), charged to the budget at the claim,
 * and served one at a time in claim order. A request with a problem is answered exit 64, a spent budget exit 75,
 * a credential form in the stdin exit 65 (and the attempt is invalid). The answer is published by rename and the
 * request file is then deleted.
 */
/** F4: the payload bytes the queue of charged requests may hold at once; past it a request is answered refused, not kept. */
export const QUEUE_BYTES = 4 * 1024 * 1024;
export const QUEUE_FULL_TEXT = "setup-review: refused: too many review requests are waiting; try again after the running one answers";

export class ReviewServer {
  private readonly claimed = new Set<string>();
  private retained = 0;
  private queue: Promise<void> = Promise.resolve();
  private stopRunning: (() => void) | null = null;
  private stopping = false;
  /** Set when a served stdin carried a credential form: where and which pattern, never the value. */
  credential: { readonly id: string; readonly hit: CredentialHit } | null = null;
  private cleanup: "confirmed" | "unconfirmed" = "confirmed";

  constructor(private readonly o: ReviewServerOptions) {}

  claimedIds(): string[] { return [...this.claimed]; }

  /** F4: the payload bytes held by requests queued and not yet answered. */
  retainedBytes(): number { return this.retained; }

  offer(entries: readonly ({ readonly id: string; readonly bytes: string } | { readonly id: string; readonly problem: string })[]): void {
    for (const e of entries) {
      if (this.stopping || this.claimed.has(e.id) || !REQUEST_ID.test(e.id)) continue;
      try { closeSync(openSync(join(this.o.responses, `${e.id}.claimed`), "wx")); } catch { this.claimed.add(e.id); continue; }
      this.claimed.add(e.id);
      // Charged at the claim, before any spawn: a `run` counts against both limits, anything else against one.
      const charged = this.o.budget.charge("bytes" in e ? requestVerb(Buffer.from(e.bytes, "base64")) : "");
      // F4: an over-budget request is answered now and its payload dropped; it never waits behind a running command.
      if (!charged) { this.refuseNow(e.id, EXIT_BUDGET, BUDGET_TEXT); continue; }
      // F4: the charged queue holds at most QUEUE_BYTES of payload; past that a request is answered refused, not kept.
      const size = "bytes" in e ? e.bytes.length : 0;
      if (this.retained + size > QUEUE_BYTES) { this.refuseNow(e.id, EXIT_REFUSED, QUEUE_FULL_TEXT); continue; }
      this.retained += size;
      this.queue = this.queue.then(() => this.serveOne(e)).finally(() => { this.retained -= size; }).catch(() => {});
    }
  }

  /** Answers a request at once, before any queueing, with a refusal and no argv (its payload is never parsed). */
  private refuseNow(id: string, exit: number, reason: string): void {
    const at = (this.o.now ?? (() => new Date()))().toISOString();
    const err = Buffer.from(`${reason}\n`);
    this.answer(id, reviewResponse(id, exit, Buffer.alloc(0), err));
    this.o.log({ id, argv: null, stdinSha256: null, exit, stdoutSha256: sha256(""), stderrSha256: sha256(err), start: at, end: at, refused: reason, published: [] });
  }

  private async serveOne(e: { readonly id: string; readonly bytes: string } | { readonly id: string; readonly problem: string }): Promise<void> {
    const now = this.o.now ?? (() => new Date());
    const start = now().toISOString();
    const refuse = (exit: number, reason: string, argv: readonly string[] | null, stdinSha: string | null): void => {
      const err = Buffer.from(`${reason}\n`);
      this.answer(e.id, reviewResponse(e.id, exit, Buffer.alloc(0), err));
      this.o.log({ id: e.id, argv, stdinSha256: stdinSha, exit, stdoutSha256: sha256(""), stderrSha256: sha256(err), start, end: now().toISOString(), refused: reason, published: [] });
    };
    if ("problem" in e) return refuse(EXIT_REFUSED, `setup-review: refused: ${e.problem}`, null, null);
    const checked = reviewRequestProblems(`${e.id}.json`, Buffer.from(e.bytes, "base64"), this.o.project);
    if ("problem" in checked) return refuse(EXIT_REFUSED, `setup-review: refused: ${checked.problem}`, null, null);
    const req = checked.request;
    const stdin = Buffer.from(req.stdinBase64, "base64");
    // P2: the argv is model text too (`run --new-cycle --reason <text>` reaches the CLI and the record). A hit there
    // is logged without the argv, so the form never lands in the served log either.
    for (const [n, word] of req.argv.entries()) {
      const at = scanForCredentials(Buffer.from(word, "utf-8"), this.o.secrets);
      if (at.length === 0) continue;
      this.credential ??= { id: e.id, hit: at[0]! };
      return refuse(EXIT_CREDENTIAL, `setup-review: refused: the arguments carry a credential form (${at[0]!.pattern} in argument ${n + 1} at byte ${at[0]!.offset})`, null, sha256(stdin));
    }
    const hits = scanForCredentials(stdin, this.o.secrets);
    if (hits.length > 0) {
      this.credential ??= { id: e.id, hit: hits[0]! };
      return refuse(EXIT_CREDENTIAL, `setup-review: refused: the packet carries a credential form (${hits[0]!.pattern} at byte ${hits[0]!.offset})`, req.argv, sha256(stdin));
    }
    if (this.stopping) return refuse(EXIT_NO_ANSWER, NO_ANSWER_TEXT, req.argv, sha256(stdin));
    const before = storeRecordFiles(this.o.store);
    // F10: the reviewer's output is scanned as it arrives, with the unfinished candidate carried, before any cap.
    const streams = { stdout: new CredentialStream(this.o.secrets), stderr: new CredentialStream(this.o.secrets) };
    const live: { hit: CredentialHit | null } = { hit: null };
    // H2: after the first hit nothing more is scanned or kept, and the command is stopped; the serve call
    // returns once its cleanup is awaited, and the refusal below answers exit 65.
    const watch = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      if (live.hit !== null) return;
      const h = streams[stream].push(chunk)[0];
      if (h === undefined) return;
      live.hit = h;
      this.stopRunning?.();
    };
    this.o.onStreams?.(streams);
    const r = await this.o.serve(req.argv, stdin, this.o.deadlineMs(), (s) => { this.stopRunning = s; }, watch);
    this.stopRunning = null;
    if (r.cleanup === "unconfirmed") this.cleanup = "unconfirmed";
    const published = publishedRecords(this.o.store, before, storeRecordFiles(this.o.store));
    // 5.9: the reviewer's output is scanned before anything is published back to the model.
    const outHit = live.hit ?? [...scanForCredentials(r.stdout, this.o.secrets), ...scanForCredentials(r.stderr, this.o.secrets)][0];
    if (outHit !== undefined) {
      this.credential ??= { id: e.id, hit: outHit };
      const reason = `setup-review: refused: the reviewer's output carries a credential form (${outHit.pattern})`;
      const err = Buffer.from(`${reason}\n`);
      this.answer(e.id, reviewResponse(e.id, EXIT_CREDENTIAL, Buffer.alloc(0), err));
      this.o.log({ id: e.id, argv: req.argv, stdinSha256: sha256(stdin), exit: EXIT_CREDENTIAL, stdoutSha256: sha256(""), stderrSha256: sha256(err), start, end: now().toISOString(), refused: reason, published });
      return;
    }
    const exit = r.exit ?? EXIT_NO_ANSWER;
    this.answer(e.id, reviewResponse(e.id, exit, r.stdout, r.stderr));
    this.o.log({ id: e.id, argv: req.argv, stdinSha256: sha256(stdin), exit, stdoutSha256: sha256(r.stdout), stderrSha256: sha256(r.stderr), start, end: now().toISOString(), published });
  }

  /** Publishes the answer (temporary name, then rename) and deletes the request file. */
  private answer(id: string, response: ReviewResponse): void {
    const tmp = join(this.o.responses, `.${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(response), { mode: 0o600 });
    renameSync(tmp, join(this.o.responses, `${id}.json`));
    try { unlinkSync(join(this.o.requests, `${id}.json`)); } catch { /* already gone */ }
  }

  /** Resolves once every claimed request so far has been answered. */
  async idle(): Promise<void> {
    await this.queue;
  }

  /**
   * At the turn's end: no new serving (a claimed request still queued is answered exit 70), a running command
   * stopped and awaited. Claims, the budget and a credential mark outlive the turn; the next turn serves again.
   */
  async stop(): Promise<"confirmed" | "unconfirmed"> {
    this.stopping = true;
    this.stopRunning?.();
    await this.queue;
    this.stopping = false;
    return this.cleanup;
  }
}

// --- one turn: the collector worker polled, its entries offered to the server -----------------------------

/** The request folder is polled this often while a turn runs. */
export const POLL_MS = 250;
/** A poll the worker has not answered in this long ends the turn. */
export const POLL_ANSWER_MS = 10_000;
export const POLL_UNANSWERED = `${REVIEW_FAILURE_PREFIX}poll unanswered`;
export const WORKER_EXITED = `${REVIEW_FAILURE_PREFIX}the collector worker exited`;

export interface ReviewTurnOptions {
  readonly server: ReviewServer;
  /** The collector's `requests` worker, started in its own process group. */
  readonly worker: { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: NodeJS.ProcessEnv };
  /** The worker's deadline: the turn's. */
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly answerMs?: number;
  /** Called once with the turn's request folder failure; the caller stops the client turn. */
  readonly onFailure: (failure: string) => void;
}

/** What a turn's review side came to once ended. */
export interface ReviewTurnEnd {
  /** The request folder failure that ended the turn, or null. */
  readonly failure: string | null;
  /** Both the worker's group and any served command confirmed gone. */
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly cleanupDetail: string | null;
}

/** 5.5 and 5.8 for one turn: the worker lives for the turn, each poll answered within `answerMs` or the turn ends. */
export class ReviewTurn {
  private control: GroupControl | null = null;
  private readonly run: Promise<GroupRun>;
  private readonly loop: Promise<void>;
  private failure: string | null = null;
  private ending = false;
  private settled = false;
  private pending = "";
  private readonly lines: string[] = [];
  private wake: (() => void) | null = null;

  constructor(private readonly o: ReviewTurnOptions) {
    this.run = runInGroup({
      command: o.worker.command, args: o.worker.args, cwd: o.worker.cwd, env: o.worker.env, timeoutMs: o.timeoutMs,
      onStdout: (c) => {
        this.pending += c.toString("utf-8");
        let nl = this.pending.indexOf("\n");
        while (nl !== -1) { this.lines.push(this.pending.slice(0, nl)); this.pending = this.pending.slice(nl + 1); nl = this.pending.indexOf("\n"); }
        this.poke();
      },
      onStderr: () => {},
      control: (c: GroupControl) => { this.control = c; },
    }).finally(() => { this.settled = true; this.poke(); });
    this.loop = this.polls();
  }

  private poke(): void { const w = this.wake; this.wake = null; w?.(); }

  /** Waits up to `ms`, or less when a line arrives, the worker settles or the turn ends. */
  private pause(ms: number): Promise<void> {
    return new Promise((done) => {
      const t = setTimeout(() => { this.wake = null; done(); }, ms);
      this.wake = () => { clearTimeout(t); done(); };
    });
  }

  private fail(failure: string): void {
    if (this.failure !== null || this.ending) return;
    this.failure = failure;
    this.control?.stop();
    this.o.onFailure(failure);
  }

  private async polls(): Promise<void> {
    const answerMs = this.o.answerMs ?? POLL_ANSWER_MS;
    while (!this.ending && this.failure === null) {
      if (this.settled) { this.fail(WORKER_EXITED); return; }
      this.lines.length = 0;
      this.control?.write(Buffer.from(`${JSON.stringify({ claimed: this.o.server.claimedIds() })}\n`));
      // The answer limit is a timer, not a clock reading: a clock change never fails a poll.
      let late = false;
      const limit = setTimeout(() => { late = true; this.poke(); }, answerMs);
      while (this.lines.length === 0 && !this.ending && !this.settled && !late) await this.pause(answerMs);
      clearTimeout(limit);
      if (this.ending) return;
      const line = this.lines.shift();
      if (line === undefined) { this.fail(this.settled ? WORKER_EXITED : POLL_UNANSWERED); return; }
      let v: { entries?: unknown; failure?: unknown };
      try { v = JSON.parse(line) as typeof v; } catch { this.fail(`${REVIEW_FAILURE_PREFIX}the worker's answer is not JSON`); return; }
      if (typeof v.failure === "string") { this.fail(v.failure.startsWith(REVIEW_FAILURE_PREFIX) ? v.failure : `${REVIEW_FAILURE_PREFIX}${v.failure}`); return; }
      if (!Array.isArray(v.entries)) { this.fail(`${REVIEW_FAILURE_PREFIX}the worker's answer has no entries`); return; }
      const entries = (v.entries as Record<string, unknown>[]).filter((e) => e !== null && typeof e === "object" && typeof e.id === "string" && (typeof e.bytes === "string" || typeof e.problem === "string"));
      this.o.server.offer(entries as unknown as ({ id: string; bytes: string } | { id: string; problem: string })[]);
      await this.pause(this.o.pollMs ?? POLL_MS);
    }
  }

  /** At the turn's end, whatever ended it: polling stops, the worker is stopped and awaited, then the server. */
  async end(): Promise<ReviewTurnEnd> {
    this.ending = true;
    this.poke();
    await this.loop;
    this.control?.stop();
    const r = await this.run;
    const served = await this.o.server.stop();
    const workerOk = r.cleanup === "confirmed";
    return {
      failure: this.failure,
      cleanup: workerOk && served === "confirmed" ? "confirmed" : "unconfirmed",
      cleanupDetail: !workerOk ? `the review worker: ${r.cleanupDetail ?? "not confirmed gone"}` : served !== "confirmed" ? "a served review command was not confirmed gone" : null,
    };
  }
}
