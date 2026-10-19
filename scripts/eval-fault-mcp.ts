/**
 * T-538 S5a: the evaluation entry. Bundled by scripts/build-eval.mjs into
 * .eval-dist/eval-mcp.js and .eval-dist/eval-cli.js (never into dist/, never
 * in package.json `files`), it installs the write seams in its own bundle's
 * module instance and then starts that bundle's MCP server or CLI.
 *
 *   --entry mcp|cli                 which main to start (removed from argv)
 *   STORYBLOQ_EVAL_EVENTS=<file>    required: the fsynced events log
 *   STORYBLOQ_EVAL_FAULT=<selector> optional: `point` or `point#n`, the nth
 *                                   occurrence within one invocation
 *
 * Each event is one JSON line, appended and fsynced before the run goes on.
 * At `archive-committed`, inside the archive's lock hold, the ledger is
 * copied to `<events>.setup-snapshot.json` (fsynced) before its event line;
 * `step:archive` repeats that snapshot's digest. At the selected point the
 * wrapper creates `<events>.fired` (O_EXCL) and SIGKILLs itself; a later
 * attempt finds the marker and never fires.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setAfterWriteFault, type FaultInfo } from "../src/core/setup-apply.js";

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
function writeDurable(file: string, text: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o644);
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

export function parseSelector(selector: string): { readonly point: string; readonly nth: number } {
  const m = /^(.*)#([1-9][0-9]*)$/.exec(selector);
  return m ? { point: m[1]!, nth: Number(m[2]) } : { point: selector, nth: 1 };
}

/** The collector behind both seams, for one attempt (one process). `kill` is the SIGKILL, replaceable in a test. */
export function collector(events: string, selector: string | null, entry: EvalEntry, kill: () => void = () => process.kill(process.pid, "SIGKILL")) {
  const attempt = randomUUID();
  const target = selector === null ? null : parseSelector(selector);
  const seen = new Map<string, number>();
  const open = new Set<string>();
  const snapshotOf = new Map<string, string>();
  let seq = 0;
  appendDurable(events, JSON.stringify({ attempt, pid: process.pid, entry }) + "\n");
  const line = (fields: Record<string, unknown>) => appendDurable(events, JSON.stringify({ seq: seq++, attempt, ...fields }) + "\n");
  return (point: string, info: FaultInfo): void => {
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
    if (target === null || point !== target.point) return;
    const key = `${info.invocation ?? ""}\u0000${point}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n !== target.nth) return;
    try {
      closeSync(openSync(`${events}.fired`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      throw err;
    }
    kill();
  };
}

/** Reads `--entry` (removing it, so the started main sees its own argv) and the two variables. */
export function readEvalArgs(argv: string[], env: NodeJS.ProcessEnv): { entry: EvalEntry; events: string; selector: string | null } {
  const at = argv.indexOf("--entry");
  const entry = at >= 0 ? argv[at + 1] : undefined;
  if (entry !== "mcp" && entry !== "cli") throw new Error("eval-fault-mcp: --entry mcp|cli is required");
  argv.splice(at, 2);
  const events = env.STORYBLOQ_EVAL_EVENTS;
  if (!events) throw new Error("eval-fault-mcp: STORYBLOQ_EVAL_EVENTS is required");
  const selector = env.STORYBLOQ_EVAL_FAULT;
  return { entry, events, selector: selector ? selector : null };
}

async function start(): Promise<void> {
  const { entry, events, selector } = readEvalArgs(process.argv, process.env);
  setAfterWriteFault(collector(events, selector, entry));
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
