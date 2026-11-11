/**
 * T-538 S5a: the evaluation entry. Bundled by scripts/build-eval.mjs into
 * .eval-dist/eval-mcp.js and .eval-dist/eval-cli.js (never into dist/, never
 * in package.json `files`), it installs the write seams in its own bundle's
 * module instance and then starts that bundle's MCP server or CLI.
 *
 *   --entry mcp|cli                 which main to start (removed from argv)
 *   STORYBLOQ_EVAL_EVENTS=<file>    required: the fsynced events log
 *   STORYBLOQ_EVAL_FAULT=<selector> optional: `point` or `point#n`, the nth
 *                                   occurrence within one invocation; a point
 *                                   ending in `:*` matches any point with that
 *                                   prefix (T-538 6.1)
 *   STORYBLOQ_EVAL_FAULT_ID=<id>    optional (6.1): the schedule entry's id; the
 *                                   marker is then `<events>.fired.<id>`, and a
 *                                   fired record and the kill snapshot are written
 *   STORYBLOQ_EVAL_OUTSIDE=<dir>    required for entry mcp (T-538 5.2): a harness folder outside
 *                                   every root; the entry tries to create a file
 *                                   there before it serves, and serves only when
 *                                   that is denied (`sandbox: "held"`)
 *   STORYBLOQ_EVAL_TOOLS=<file>     required for entry mcp (T-538 5.4): the pinned inventory;
 *                                   a tool outside its two lists is never
 *                                   registered and is logged once as withheld
 *
 * Each event is one JSON line, appended and fsynced before the run goes on.
 * At `archive-committed`, inside the archive's lock hold, the ledger is
 * copied to `<events>.setup-snapshot.json` (fsynced) before its event line;
 * `step:archive` repeats that snapshot's digest. At the selected point the
 * wrapper creates `<events>.fired` (O_EXCL) and SIGKILLs itself; a later
 * attempt finds the marker and never fires. With a fault id (6.1) the marker is
 * `<events>.fired.<id>`; before it, the project tree is written to
 * `<events>.kill.<id>.json` (fsynced), and after it a fired record
 * `{type: "fault-fired", id, selector, point, target, invocation, attempt}` is
 * appended, both before the kill.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setAfterWriteFault, type FaultInfo } from "../src/core/setup-apply.js";
import { parseSelector, pointMatches } from "./onboarding-eval-schedule.js";
import { KILL_SNAPSHOT_MAX_BYTES, KILL_SNAPSHOT_MAX_FILES, treeSnapshot } from "./onboarding-eval-preserve.js";

export type EvalEntry = "mcp" | "cli";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Appends one line and fsyncs it, so the order on disk is the order the events fired. */
function appendDurable(file: string, text: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes a new file whole and fsyncs it. */
function writeDurable(file: string, text: string, exclusive = false): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : constants.O_TRUNC), 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The setup's ledger as it is: tickets, issues, roadmap (with its phases) and config, byte for byte. */
export function ledgerSnapshot(root: string): string {
  const wrap = join(root, ".story");
  const files: Record<string, string> = {};
  for (const dir of ["tickets", "issues"]) {
    const abs = join(wrap, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).filter((n) => n.endsWith(".json")).sort()) files[`${dir}/${name}`] = readFileSync(join(abs, name), "utf-8");
  }
  for (const name of ["roadmap.json", "config.json"]) {
    const abs = join(wrap, name);
    if (existsSync(abs)) files[name] = readFileSync(abs, "utf-8");
  }
  return JSON.stringify({ files }, null, 2) + "\n";
}

// 6.1: one selector grammar for the runner and the collector.
export { parseSelector, pointMatches };

// 6.1: the kill snapshot's walk lives with the preservation rules that read it.
export { KILL_SNAPSHOT_MAX_BYTES, KILL_SNAPSHOT_MAX_FILES, treeSnapshot };

/** The collector behind both seams, for one attempt (one process). `kill` is the SIGKILL, replaceable in a test. */
export function collector(events: string, selector: string | null, entry: EvalEntry, kill: () => void = () => process.kill(process.pid, "SIGKILL"), launch: Record<string, unknown> = {}, faultId: string | null = null) {
  const attempt = randomUUID();
  // 6.1: with an id, the entry's own marker; with none, the legacy marker, so stored runs and --fault keep their meaning.
  const marker = faultId === null ? `${events}.fired` : `${events}.fired.${faultId}`;
  const target = selector === null ? null : parseSelector(selector);
  const seen = new Map<string, number>();
  const open = new Set<string>();
  const snapshotOf = new Map<string, string>();
  let seq = 0;
  appendDurable(events, JSON.stringify({ attempt, pid: process.pid, entry, ...launch }) + "\n");
  const line = (fields: Record<string, unknown>) => appendDurable(events, JSON.stringify({ seq: seq++, attempt, ...fields }) + "\n");
  const fire = (point: string, info: FaultInfo): void => {
    const extra: Record<string, unknown> = {};
    if (point === "invocation-start" && info.invocation !== null) {
      if (open.size > 0) line({ overlap: true, invocation: info.invocation, open: [...open] });
      open.add(info.invocation);
    }
    if (point === "invocation-end" && info.invocation !== null) open.delete(info.invocation);
    if (point === "archive-committed" && info.root !== null) {
      const snapshot = ledgerSnapshot(info.root);
      writeDurable(`${events}.setup-snapshot.json`, snapshot);
      extra.snapshotSha256 = sha256(snapshot);
      snapshotOf.set(info.setupId ?? "", extra.snapshotSha256 as string);
    }
    if (point === "step:archive" && snapshotOf.has(info.setupId ?? "")) extra.snapshotSha256 = snapshotOf.get(info.setupId ?? "");
    const { root, ...rest } = info;
    if (rest.target !== undefined && root !== null) extra.target = relative(root, rest.target).split(sep).join("/");
    line({ point, ...rest, ...extra });
    if (target === null || !pointMatches(target.point, point)) return;
    // A `:*` selector counts across every point it matches (6.1); a literal one counts its own point.
    const key = `${info.invocation ?? ""}\u0000${target.point}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n !== target.nth) return;
    if (existsSync(marker)) return;
    // P1: the marker is claimed exclusively first, so of two processes reaching the point only the winner goes on;
    // the loser stops at EEXIST before it writes anything. The winner then writes the kill-time state with an
    // exclusive create (never over another file) and fsyncs it before the fired event and the kill. A claim with no
    // snapshot (this process died between the two) is refused by the grade as a missing kill snapshot.
    try {
      closeSync(openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      throw err;
    }
    if (faultId !== null) {
      writeDurable(`${events}.kill.${faultId}.json`, info.root === null ? JSON.stringify({ files: {}, links: [], truncated: false, problems: [], root: null }) + "\n" : treeSnapshot(info.root), true);
    }
    if (faultId !== null) line({ type: "fault-fired", id: faultId, selector, point, target: extra.target ?? null, invocation: info.invocation });
    kill();
  };
  /** One `{type: "tool-withheld", name}` line per name (5.4), on this attempt's sequence. */
  const withheld = (name: string): void => line({ type: "tool-withheld", name });
  return Object.assign(fire, { withheld });
}

export interface EvalArgs {
  readonly entry: EvalEntry;
  readonly events: string;
  readonly selector: string | null;
  /** 6.1: the schedule entry's id, or null for the legacy single fault. */
  readonly faultId: string | null;
  readonly outside: string | null;
  readonly tools: string | null;
}

/** Reads `--entry` (removing it, so the started main sees its own argv) and the variables. */
export function readEvalArgs(argv: string[], env: NodeJS.ProcessEnv): EvalArgs {
  const at = argv.indexOf("--entry");
  const entry = at >= 0 ? argv[at + 1] : undefined;
  if (entry !== "mcp" && entry !== "cli") throw new Error("eval-fault-mcp: --entry mcp|cli is required");
  argv.splice(at, 2);
  const events = env.STORYBLOQ_EVAL_EVENTS;
  if (!events) throw new Error("eval-fault-mcp: STORYBLOQ_EVAL_EVENTS is required");
  const selector = env.STORYBLOQ_EVAL_FAULT;
  // Entry mcp never serves unprobed or unrestricted: both variables are required, like the events log.
  if (entry === "mcp" && !env.STORYBLOQ_EVAL_OUTSIDE) throw new Error("eval-fault-mcp: STORYBLOQ_EVAL_OUTSIDE is required for entry mcp");
  if (entry === "mcp" && !env.STORYBLOQ_EVAL_TOOLS) throw new Error("eval-fault-mcp: STORYBLOQ_EVAL_TOOLS is required for entry mcp");
  const outside = entry === "mcp" ? env.STORYBLOQ_EVAL_OUTSIDE! : null;
  const tools = entry === "mcp" ? env.STORYBLOQ_EVAL_TOOLS! : null;
  const faultId = env.STORYBLOQ_EVAL_FAULT_ID ? env.STORYBLOQ_EVAL_FAULT_ID : null;
  if (faultId !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(faultId)) throw new Error(`eval-fault-mcp: STORYBLOQ_EVAL_FAULT_ID ${faultId} is not an id`);
  if (faultId !== null && !selector) throw new Error("eval-fault-mcp: STORYBLOQ_EVAL_FAULT_ID needs STORYBLOQ_EVAL_FAULT");
  return { entry, events, selector: selector ? selector : null, outside, tools, faultId };
}

/**
 * 5.2: whether this process can write outside every root. A denial (EPERM or EACCES) is `held`; a file it
 * could create is removed and is `absent`; any other error throws, so the entry fails before it serves.
 */
export function outsideProbe(dir: string): "held" | "absent" {
  const file = join(dir, `probe-${process.pid}-${randomUUID()}`);
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return "held";
    throw new Error(`eval-fault-mcp: the outside probe in ${dir} failed: ${code ?? String(err)}`);
  }
  closeSync(fd);
  unlinkSync(file);
  return "absent";
}

/** 5.4: the names the pinned inventory permits (the union of its two lists) and the file's sha256. */
export function allowList(file: string): { readonly names: ReadonlySet<string>; readonly sha256: string } {
  const text = readFileSync(file, "utf-8");
  const v = JSON.parse(text) as { degraded?: unknown; full?: unknown };
  const names = new Set<string>();
  for (const list of [v.degraded, v.full]) {
    if (!Array.isArray(list) || list.length === 0 || list.some((n) => typeof n !== "string")) throw new Error(`eval-fault-mcp: ${file} is not the tool inventory`);
    for (const n of list as string[]) names.add(n);
  }
  return { names, sha256: sha256(text) };
}

/** A registration's handle for a withheld tool: nothing it is asked to do has any effect. */
const INERT = Object.freeze({ enabled: false, enable() {}, disable() {}, remove() {}, update() {} });

/**
 * 5.4: wraps `McpServer.prototype.registerTool` so a name outside `names` is never registered: the caller gets
 * an inert handle and `withheld(name)` is called once per name. Returns the restore, for tests.
 */
export function restrictTools(names: ReadonlySet<string>, withheld: (name: string) => void, proto: { registerTool: (...a: never[]) => unknown } = McpServer.prototype as never): () => void {
  const original = proto.registerTool;
  const logged = new Set<string>();
  proto.registerTool = function (this: unknown, ...args: unknown[]): unknown {
    const name = args[0] as string;
    if (names.has(name)) return (original as (...a: unknown[]) => unknown).apply(this, args);
    if (!logged.has(name)) {
      logged.add(name);
      withheld(name);
    }
    return INERT;
  } as typeof original;
  return () => { proto.registerTool = original; };
}

/** 5.5: the review commands the entry hands to the harness instead of the product CLI. */
export const FORWARDED_VERBS: readonly string[] = ["gate", "run", "status"];
const NO_ANSWER = "setup-review: the harness did not answer\n";
let forwardCounter = 0;

export interface ForwardIo {
  readonly pid: number;
  readonly cwd: string;
  readonly stdin: Buffer;
  readonly waitMs: number;
  readonly pollMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
}

export interface Forwarded { readonly stdout: Buffer; readonly stderr: Buffer; readonly exit: number }

/**
 * 5.5: `setup-review gate|run|status ...` from the cli entry. Publishes `{id, argv, stdinBase64, cwd}` as
 * `<events dir>/review-requests/<id>.json` (written as `.<id>.tmp`, then renamed), then waits for
 * `$STORYBLOQ_EVAL_REVIEW_RESPONSES/<id>.json` and returns its streams and exit code. With no answer in time,
 * or no response folder to wait on, it is the harness's no-answer, exit 70: the product's own setup-review
 * never runs from inside the evaluation.
 */
export function forwardReview(args: readonly string[], events: string, responses: string | undefined, io: ForwardIo): Forwarded {
  const none: Forwarded = { stdout: Buffer.alloc(0), stderr: Buffer.from(NO_ANSWER), exit: 70 };
  if (!responses) return none;
  const id = `${io.pid}-${++forwardCounter}`;
  const dir = join(dirname(events), "review-requests");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ id, argv: [...args], stdinBase64: io.stdin.toString("base64"), cwd: io.cwd }), { flag: "wx", mode: 0o600 });
  renameSync(tmp, join(dir, `${id}.json`));
  const answer = join(responses, `${id}.json`);
  const end = io.now() + io.waitMs;
  for (;;) {
    let text: string | null = null;
    try { text = readFileSync(answer, "utf-8"); } catch { /* not yet */ }
    if (text !== null) {
      const v = JSON.parse(text) as { id?: unknown; exit?: unknown; stdoutBase64?: unknown; stderrBase64?: unknown };
      if (v.id !== id || typeof v.exit !== "number" || typeof v.stdoutBase64 !== "string" || typeof v.stderrBase64 !== "string") return none;
      return { stdout: Buffer.from(v.stdoutBase64, "base64"), stderr: Buffer.from(v.stderrBase64, "base64"), exit: v.exit };
    }
    if (io.now() >= end) return none;
    io.sleep(io.pollMs);
  }
}

/** The forwarding entry's stdin: read whole when it is a pipe or a file, empty for a terminal. */
function entryStdin(): Buffer {
  try { if (fstatSync(0).isCharacterDevice()) return Buffer.alloc(0); } catch { return Buffer.alloc(0); }
  try { return readFileSync(0); } catch { return Buffer.alloc(0); }
}

async function start(): Promise<void> {
  const { entry, events, selector, outside, tools, faultId } = readEvalArgs(process.argv, process.env);
  const args = process.argv.slice(2);
  if (entry === "cli" && args[0] === "setup-review" && FORWARDED_VERBS.includes(args[1] ?? "")) {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    const r = forwardReview(args.slice(1), events, process.env.STORYBLOQ_EVAL_REVIEW_RESPONSES, {
      pid: process.pid, cwd: process.cwd(), stdin: entryStdin(), waitMs: 25 * 60 * 1000, pollMs: 250, now: () => Date.now(), sleep: (ms) => { Atomics.wait(shared, 0, 0, ms); },
    });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.exit;
    return;
  }
  const launch: Record<string, unknown> = {};
  const permitted = tools === null ? null : allowList(tools);
  if (permitted !== null) launch.tools = permitted.sha256;
  if (outside !== null) {
    launch.sandbox = outsideProbe(outside);
    if (launch.sandbox === "absent") {
      collector(events, selector, entry, undefined, launch, faultId);
      process.stderr.write("eval-fault-mcp: the server can write outside every root; it does not serve\n");
      process.exit(1);
    }
  }
  const collect = collector(events, selector, entry, undefined, launch, faultId);
  setAfterWriteFault(collect);
  if (permitted !== null) restrictTools(permitted.names, collect.withheld);
  // Imported after the seams are set: each main runs on import, in this bundle's module instance.
  if (entry === "mcp") await import("../src/mcp/index.js");
  else await import("../src/cli/index.js");
}

// Started only as the entry itself (the bundle), never when a test imports the module.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
