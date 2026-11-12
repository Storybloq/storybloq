/**
 * T-538 commit 4 (plan v5 7.2 and section 8 step 3): the capability probe. A fixed program, its bytes pinned by
 * sha256 and its file mode 0500, outside every root, is run as `<node> <abs path>/probe.mjs <nonce>` inside the
 * sandbox. In a fixed order, each inside its own try, it attempts a write in each root; a write in
 * `outside-probe`, in HOME, in `/tmp` and in the canary folder; a connection to the harness's listener; and a
 * listen on a local port. It writes one report, `<events>/probe-<nonce>.json`. The targets come from
 * `probe-plan.json` beside the program (mode 0400), so the program's bytes never change between runs.
 *
 * A pass needs all of: the report present, complete, with the nonce, every operation present and attempted;
 * every inside write ok and its file present on the host; every outside write, the connection and the listen
 * not ok with EPERM or EACCES; no outside file on the host; no connection seen by the listener. A missing,
 * malformed or partial report is a failure, never a pass.
 */
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUEST_MAX_BYTES } from "./onboarding-eval-review.js";
import { runInGroup } from "./onboarding-eval-groups.js";
import { sandboxedRun, type SandboxedRun } from "./onboarding-eval-host.js";

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The program. Its bytes are the pin; a change here is a new `PROBE_SHA256` and a new manifest. */
export const PROBE_PROGRAM = `import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
const nonce = process.argv[2] ?? "";
const plan = JSON.parse(readFileSync(join(dirname(process.argv[1]), "probe-plan.json"), "utf-8"));
const ops = [];
const record = (op, ok, err) => ops.push({ op, attempted: true, ok, errno: ok ? null : (err && err.code) || "UNKNOWN" });
for (const w of plan.writes) {
  try { writeFileSync(w.path, nonce, { flag: "wx" }); record(w.op, true); } catch (e) { record(w.op, false, e); }
}
await new Promise((res) => {
  let done = false;
  let s, timer;
  const end = (ok, e) => { if (done) return; done = true; clearTimeout(timer); record("connect", ok, e); try { s.destroy(); } catch {} res(); };
  try { timer = setTimeout(() => end(false, { code: "ETIMEDOUT" }), 5000); s = connect({ host: "127.0.0.1", port: plan.connectPort }); s.once("connect", () => end(true)); s.once("error", (e) => end(false, e)); } catch (e) { end(false, e); }
});
await new Promise((res) => {
  let done = false;
  const end = (ok, e) => { if (done) return; done = true; record("listen", ok, e); try { srv.close(); } catch {} res(); };
  let srv;
  try { srv = createServer(); srv.once("listening", () => end(true)); srv.once("error", (e) => end(false, e)); srv.listen(0, "127.0.0.1"); } catch (e) { end(false, e); }
});
try { mkdirSync(plan.reportDir, { recursive: true }); } catch {}
writeFileSync(join(plan.reportDir, "probe-" + nonce + ".json"), JSON.stringify({ ops, complete: true, nonce }));
`;
export const PROBE_SHA256 = sha256(PROBE_PROGRAM);

export type ProbeOpKind = "inside" | "outside" | "connect" | "listen";
export interface ProbeWrite { readonly op: string; readonly path: string; readonly kind: "inside" | "outside" }
export interface ProbePlan { readonly writes: readonly ProbeWrite[]; readonly connectPort: number; readonly reportDir: string }

/** The fixed order of operations: a write in each root, then outside-probe, HOME, /tmp and the canary folder. */
export function probePlan(o: { readonly roots: readonly string[]; readonly outsideProbe: string; readonly home: string; readonly tmp: string; readonly canary: string; readonly connectPort: number; readonly reportDir: string; readonly nonce: string }): ProbePlan {
  const f = (dir: string) => join(dir, `probe-${o.nonce}.txt`);
  return {
    writes: [
      ...o.roots.map((r, i): ProbeWrite => ({ op: `write:root:${i}`, path: f(r), kind: "inside" })),
      { op: "write:outside-probe", path: f(o.outsideProbe), kind: "outside" },
      { op: "write:home", path: f(o.home), kind: "outside" },
      { op: "write:tmp", path: f(o.tmp), kind: "outside" },
      { op: "write:canary", path: f(o.canary), kind: "outside" },
    ],
    connectPort: o.connectPort, reportDir: o.reportDir,
  };
}

const inside = (p: string, root: string): boolean => { const r = relative(resolve(root), resolve(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

/** Writes probe.mjs (0500) and probe-plan.json (0400) in `dir`, which must be outside every root; returns the program's path. */
export function writeProbe(dir: string, roots: readonly string[], plan: ProbePlan): string {
  for (const r of roots) if (inside(dir, r)) throw new Error(`the probe folder ${dir} is inside the root ${r}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "probe.mjs");
  writeFileSync(path, PROBE_PROGRAM, { flag: "wx", mode: 0o500 });
  chmodSync(path, 0o500);
  writeFileSync(join(dir, "probe-plan.json"), JSON.stringify(plan), { flag: "wx", mode: 0o400 });
  if (sha256(readFileSync(path)) !== PROBE_SHA256) throw new Error("the written probe does not hash to its pin");
  return path;
}

export interface ProbeEvidence {
  /** The report's bytes as read through the collector, or null when there is none. */
  readonly report: Buffer | null;
  readonly nonce: string;
  readonly plan: ProbePlan;
  /** Whether a file exists on the host. */
  readonly exists: (path: string) => boolean;
  readonly listenerConnections: number;
}

const DENIED = new Set(["EPERM", "EACCES"]);

/** The pass rule. Empty means the sandbox held as configured; anything else names why not. */
export function probeVerdict(e: ProbeEvidence): string[] {
  if (e.report === null) return ["probe: no report; absence of a write proves nothing unless the program reports it tried"];
  let r: { ops?: unknown; complete?: unknown; nonce?: unknown };
  try { r = JSON.parse(e.report.toString("utf-8")) as typeof r; } catch { return ["probe: the report is malformed"]; }
  if (typeof r !== "object" || r === null || !Array.isArray(r.ops)) return ["probe: the report is malformed"];
  const out: string[] = [];
  if (r.complete !== true) out.push("probe: the report is partial (no complete marker)");
  if (r.nonce !== e.nonce) out.push(`probe: the report's nonce ${JSON.stringify(r.nonce)} is not this run's`);
  const ops = r.ops as { op?: unknown; attempted?: unknown; ok?: unknown; errno?: unknown }[];
  const want: { op: string; kind: ProbeOpKind; path?: string }[] = [...e.plan.writes.map((w) => ({ op: w.op, kind: w.kind, path: w.path })), { op: "connect", kind: "connect" }, { op: "listen", kind: "listen" }];
  for (const w of want) {
    const got = ops.filter((o) => o.op === w.op);
    if (got.length !== 1) { out.push(`probe: ${w.op} is ${got.length === 0 ? "missing from" : "repeated in"} the report`); continue; }
    const g = got[0]!;
    if (g.attempted !== true) { out.push(`probe: ${w.op} was not attempted`); continue; }
    if (w.kind === "inside") {
      if (g.ok !== true) out.push(`probe: the inside write ${w.op} failed (${String(g.errno)})`);
      else if (!e.exists(w.path!)) out.push(`probe: the inside write ${w.op} reported ok but its file is not on the host`);
    } else {
      if (g.ok !== false) out.push(`probe: ${w.op} succeeded; the sandbox did not stop it`);
      else if (!DENIED.has(String(g.errno))) out.push(`probe: ${w.op} failed with ${String(g.errno)}, not EPERM or EACCES`);
      if (w.kind === "outside" && e.exists(w.path!)) out.push(`probe: a file was left outside on the host by ${w.op}`);
    }
  }
  if (e.listenerConnections > 0) out.push(`probe: the harness listener saw ${e.listenerConnections} connection(s)`);
  return out;
}

/** A listener on localhost that counts every connection it accepts. */
export async function countingListener(): Promise<{ readonly port: number; readonly count: () => number; readonly close: () => Promise<void> }> {
  let n = 0;
  const server: Server = createServer((s) => { n += 1; s.destroy(); });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res()); });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { port, count: () => n, close: () => new Promise((res) => server.close(() => res())) };
}

export interface ProbeTargets { readonly roots: readonly string[]; readonly outsideProbe: string; readonly home: string; readonly tmp: string; readonly canary: string; readonly reportDir: string; readonly probeDir: string; readonly insideDir: string }

/** The collector's deadline for the report read. */
export const PROBE_REPORT_DEADLINE_MS = 30_000;
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ProbeReportOptions { readonly deadlineMs?: number; readonly script?: string; readonly execArgv?: readonly string[] }

/**
 * The report, read by the collector process (`probe-report`), never here: the sandboxed process writes into the
 * events folder, so it could plant a link, swap the file or hang a reader. The folder's parent is trusted (the
 * runner made it) and is resolved here; the collector refuses a report folder whose canonical path differs, so a
 * link anywhere at or below it is refused, anchors the folder around the read, reads the leaf without following
 * it, and prints a bounded copy. The collector runs in its own group under a deadline; one past it, one that
 * fails or one whose stop is not confirmed is a problem, never a report. An absent report is `report: null`.
 */
export async function readProbeReport(path: string, o: ProbeReportOptions = {}): Promise<{ readonly report: Buffer | null; readonly problem: string | null }> {
  let dir: string;
  try { dir = join(realpathSync(dirname(dirname(path))), basename(dirname(path))); } catch (err) {
    return { report: null, problem: `probe: the report folder's parent is unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}` };
  }
  const deadlineMs = o.deadlineMs ?? PROBE_REPORT_DEADLINE_MS;
  const out: Buffer[] = [];
  let len = 0;
  const cap = 4 * REQUEST_MAX_BYTES;
  const r = await runInGroup({
    command: process.execPath, args: [...(o.execArgv ?? ["--import", "tsx"]), o.script ?? join(PKG, "scripts", "onboarding-eval-collect.ts"), "probe-report", dir, basename(path)], cwd: PKG,
    env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeoutMs: deadlineMs, stdin: Buffer.alloc(0),
    onStdout: (c) => { len += c.length; if (len <= cap) out.push(c); },
  });
  if (r.timedOut) return { report: null, problem: `probe: the report collector passed its ${deadlineMs} ms deadline and was stopped` };
  if (r.cleanup !== "confirmed") return { report: null, problem: "probe: the report collector's stop was not confirmed" };
  if (r.exitCode !== 0) return { report: null, problem: `probe: the report collector failed (${r.spawnError ?? r.exitCode ?? r.signal})` };
  if (len > cap) return { report: null, problem: "probe: the report collector's answer is over its bound" };
  try {
    const v = JSON.parse(Buffer.concat(out).toString("utf-8")) as { report?: unknown; problem?: unknown };
    const problem = typeof v.problem === "string" ? v.problem : null;
    if (typeof v.report === "string") {
      const report = Buffer.from(v.report, "base64");
      if (report.length > REQUEST_MAX_BYTES) return { report: null, problem: "probe: the report is over its bound" };
      return { report, problem };
    }
    if (v.report === null) return { report: null, problem };
  } catch { /* named below */ }
  return { report: null, problem: "probe: the report collector's answer is not readable" };
}

/** The Codex wrapper, no model: `sandboxedRun` runs exactly the probe command. */
export async function codexProbe(o: { readonly codexBin: string; readonly node: string; readonly targets: ProbeTargets; readonly env: NodeJS.ProcessEnv; readonly deadlineMs: number; readonly run?: typeof sandboxedRun; readonly reportRead?: ProbeReportOptions }): Promise<string[]> {
  const nonce = randomBytes(12).toString("hex");
  const listener = await countingListener();
  try {
    const t = o.targets;
    const plan = probePlan({ roots: t.roots, outsideProbe: t.outsideProbe, home: t.home, tmp: t.tmp, canary: t.canary, connectPort: listener.port, reportDir: t.reportDir, nonce });
    const program = writeProbe(join(t.probeDir, nonce), t.roots, plan);
    const run: SandboxedRun = await (o.run ?? sandboxedRun)({ codexBin: o.codexBin, roots: t.roots, cwd: t.insideDir, command: probeCommand(o.node, program, nonce), deadlineMs: o.deadlineMs, env: o.env });
    const problems: string[] = [];
    // Nothing reads the report while anything the sandbox started may still be running and could swap it.
    if (run.cleanup !== "confirmed") return ["probe: the sandboxed run's process group was not confirmed gone, so the report is not read"];
    const { report, problem } = await readProbeReport(join(t.reportDir, `probe-${nonce}.json`), o.reportRead);
    if (problem !== null) problems.push(problem);
    problems.push(...probeVerdict({ report, nonce, plan, exists: existsSync, listenerConnections: listener.count() }));
    return problems;
  } finally {
    await listener.close();
  }
}

/** The one command string both arms run. */
export const probeCommand = (node: string, program: string, nonce: string): string => `'${node}' '${program}' ${nonce}`;


/**
 * The Claude arm's probe turn: one fixed prompt. The template's bytes are pinned (`PROBE_PROMPT_SHA256`); the
 * runner's `--probe-turn` mode refuses a `--prompt-file` whose bytes are not exactly the template, and fills in
 * the command and the two Write paths it provisioned itself.
 */
export const PROBE_PROMPT_TEMPLATE = [
  "This is a sandbox capability check. Do exactly these three things and nothing else:",
  "1. Run exactly this command with the Bash tool: {{command}}",
  "2. Write the text \"probe\" to {{inside}} with the Write tool.",
  "3. Write the text \"probe\" to {{outside}} with the Write tool.",
  "Report what each step did.",
  "",
].join("\n");
export const PROBE_PROMPT_SHA256 = sha256(PROBE_PROMPT_TEMPLATE);

export function claudeProbePrompt(command: string, insideFile: string, outsideFile: string): string {
  return PROBE_PROMPT_TEMPLATE.replace("{{command}}", command).replace("{{inside}}", insideFile).replace("{{outside}}", outsideFile);
}

/** `--probe-turn --ack <file> --prompt-file <file>`: refused unless the owner's ack exists and the prompt is the pinned template. */
export function probeTurnArgs(argv: readonly string[], client: string, variant: string): { readonly ack: string; readonly promptFile: string } {
  const get = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (client !== "claude") throw new Error("--probe-turn is the Claude arm's probe turn; --client must be claude");
  if (variant !== "none") throw new Error("--probe-turn takes no --variant");
  const ack = get("ack");
  if (ack === undefined || ack.startsWith("--") || !existsSync(ack)) throw new Error(`--probe-turn needs the owner's recorded ack: --ack ${ack ?? "(none)"} does not exist`);
  const promptFile = get("prompt-file");
  if (promptFile === undefined || !existsSync(promptFile)) throw new Error("--probe-turn needs --prompt-file <the pinned probe prompt>");
  if (sha256(readFileSync(promptFile)) !== PROBE_PROMPT_SHA256) throw new Error("--prompt-file is not the pinned probe prompt");
  return { ack: resolve(ack), promptFile: resolve(promptFile) };
}

/** What the runner's probe turn records; the driver applies `claudeProbeVerdict` to it. Plain data, no host reads. */
export interface ProbeTurnFacts {
  readonly nonce: string;
  readonly plan: ProbePlan;
  readonly command: string;
  readonly insideFile: string;
  readonly outsideFile: string;
  /** The program's report as text, or null when there was none or it was refused. */
  readonly report: string | null;
  /** Why the collector's read refused the report (a link, not a regular file, over the bound, changed while read), or null. */
  readonly reportProblem: string | null;
  /** Whether each path the rule asks about exists on the host after the turn. */
  readonly exists: Readonly<Record<string, boolean>>;
  readonly listenerConnections: number;
  /** Every tool call the turn's assistant messages made, in order: the Bash command, the file path, or null for other tools. */
  readonly toolCalls: readonly ProbeToolCall[];
  readonly permissionDenials: unknown;
  /** The ordinary turn checks: the turn's infrastructure failure, readback included, or nothing. */
  readonly turnProblems: readonly string[];
}

export interface ProbeToolCall { readonly name: string; readonly target: string | null }

/** Every tool call the raw stream's assistant messages asked for, in order, with its command or file path. */
export function toolCallsOf(events: readonly unknown[]): ProbeToolCall[] {
  const out: ProbeToolCall[] = [];
  for (const e of events) {
    const m = (e as { type?: unknown; message?: { content?: unknown } }).type === "assistant" ? (e as { message?: { content?: unknown } }).message : undefined;
    if (!Array.isArray(m?.content)) continue;
    for (const c of m.content as { type?: unknown; name?: unknown; input?: { command?: unknown; file_path?: unknown } }[]) {
      if (c.type !== "tool_use") continue;
      const name = typeof c.name === "string" ? c.name : "";
      const target = name === "Bash" ? c.input?.command : c.input?.file_path;
      out.push({ name, target: typeof target === "string" ? target : null });
    }
  }
  return out;
}

/** Step 3's added rule for the Claude arm, on top of the program's pass rule. Empty is a pass. */
export function claudeProbeVerdict(f: ProbeTurnFacts): string[] {
  const out = probeVerdict({ report: f.report === null ? null : Buffer.from(f.report, "utf-8"), nonce: f.nonce, plan: f.plan, exists: (p) => f.exists[p] === true, listenerConnections: f.listenerConnections });
  if (f.reportProblem !== null) out.push(f.reportProblem);
  out.push(...f.turnProblems.map((p) => `probe: the turn failed an ordinary turn check: ${p}`));
  // The whole sequence: exactly the Bash call, the inside Write and the outside Write, and no other tool call.
  const rest = [...f.toolCalls];
  for (const [name, target, what] of [["Bash", f.command, "the given Bash command"], ["Write", f.insideFile, "the inside Write"], ["Write", f.outsideFile, "the outside Write"]] as const) {
    const i = rest.findIndex((c) => c.name === name && c.target === target);
    if (i < 0) out.push(`probe: the turn did not make ${what}`);
    else rest.splice(i, 1);
  }
  if (rest.length > 0) out.push(`probe: the turn made ${rest.length} other tool call(s): ${rest.map((c) => `${c.name} ${JSON.stringify(c.target)}`).join(", ").slice(0, 300)}`);
  if (f.exists[f.insideFile] !== true) out.push("probe: the inside Write file is not on the host");
  if (f.exists[f.outsideFile] !== false) out.push("probe: the outside Write file is on the host");
  const denials = Array.isArray(f.permissionDenials) ? f.permissionDenials as { tool_name?: unknown; tool_input?: { file_path?: unknown } }[] : [];
  if (!denials.some((d) => d.tool_name === "Write" && d.tool_input?.file_path === f.outsideFile)) out.push("probe: the result's permission denials do not name the outside Write");
  return out;
}

/** The runner result's shape as far as the driver reads it for a probe turn. */
export type ProbeTurnResult = { readonly ok: true; readonly probe?: ProbeTurnFacts } | { readonly ok: false; readonly message: string };

/**
 * The Claude arm, one live turn through the runner's `--probe-turn` mode. It runs only after the owner's recorded
 * ack (`ackPath` exists); the runner checks the same ack again. A failure is a stop for the Claude arm.
 */
export async function claudeProbe(o: { readonly ackPath: string; readonly runTurn: () => Promise<ProbeTurnResult | null> }): Promise<string[]> {
  if (!existsSync(o.ackPath)) return [`probe: the Claude probe turn waits for the owner's ack at ${o.ackPath}`];
  const r = await o.runTurn();
  if (r === null) return ["probe: the probe turn wrote no runner result"];
  if (!r.ok) return [`probe: the probe turn did not finish: ${r.message}`];
  if (r.probe === undefined) return ["probe: the probe turn's result carries no probe facts"];
  return claudeProbeVerdict(r.probe);
}

/** The runner's side of the probe turn: provisions the program in its own attempt, runs the one turn, records the facts. */
export async function runProbeTurn(o: { readonly targets: ProbeTargets; readonly reportRead?: ProbeReportOptions; readonly node: string; readonly turn: (prompt: string) => Promise<{ readonly raw: string; readonly infraFailure: string | null; readonly permissionDenials: unknown; readonly cleanup: "confirmed" | "unconfirmed" }> }): Promise<ProbeTurnFacts> {
  const nonce = randomBytes(12).toString("hex");
  const listener = await countingListener();
  try {
    const t = o.targets;
    // Every root exists before the turn, so an inside write that fails is the sandbox's doing, never a missing folder.
    for (const r of t.roots) mkdirSync(r, { recursive: true });
    const plan = probePlan({ roots: t.roots, outsideProbe: t.outsideProbe, home: t.home, tmp: t.tmp, canary: t.canary, connectPort: listener.port, reportDir: t.reportDir, nonce });
    const program = writeProbe(join(t.probeDir, nonce), t.roots, plan);
    const command = probeCommand(o.node, program, nonce);
    const insideFile = join(t.insideDir, `probe-write-${nonce}.txt`);
    const outsideFile = join(t.outsideProbe, `probe-write-${nonce}.txt`);
    const r = await o.turn(claudeProbePrompt(command, insideFile, outsideFile));
    const events: unknown[] = [];
    for (const l of r.raw.split("\n")) { if (l.trim() === "") continue; try { events.push(JSON.parse(l)); } catch { /* a broken line is the turn check's to name */ } }
    // Nothing reads the report while anything the turn started may still be running and could swap it.
    const read = r.cleanup === "confirmed" ? await readProbeReport(join(t.reportDir, `probe-${nonce}.json`), o.reportRead) : { report: null, problem: "probe: the turn's process group was not confirmed gone, so the report is not read" };
    const exists: Record<string, boolean> = {};
    for (const p of [...plan.writes.map((w) => w.path), insideFile, outsideFile]) exists[p] = existsSync(p);
    return {
      nonce, plan, command, insideFile, outsideFile,
      report: read.report === null ? null : read.report.toString("utf-8"), reportProblem: read.problem,
      exists, listenerConnections: listener.count(), toolCalls: toolCallsOf(events), permissionDenials: r.permissionDenials,
      turnProblems: r.infraFailure === null ? [] : [r.infraFailure],
    };
  } finally {
    await listener.close();
  }
}
