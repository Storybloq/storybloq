/**
 * T-538 signed-in note section 12, S1a: the signed-in attempt lifecycle's shared pieces, moved here unchanged from
 * continuity-run.ts, which re-exports every name. The signed-in options and refusals, the provenance record files
 * and their stop scan, recovery, and the transcript listing. SIGNED_IN_MISSING_GATES stays defined in
 * continuity-lib.ts (a helper-bundle input) and is re-exported here.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readRegularFile, writeDurable } from "./headless-common.js";
import { initContradicts, initProvenanceProblems, readbackProblems, type ClaudePolicyOptions, type ReadbackExpected, type ReadbackStep } from "./headless-policy.js";
import { parseStream, sha256, TASKS, type Task, SIGNED_IN_MISSING_GATES, READ_BOUNDARY_UNPROVEN, KEYCHAIN_OPEN } from "./continuity-lib.js";
import { identityOf } from "./onboarding-eval-groups.js";
import { HomeJournalStop, journalAfter, journalBefore, journalGroup, recoverHomeJournal, type RecoveryProbe } from "./continuity-home.js";
import { processGroupSeams } from "../src/core/process-group.js";
import { realHome, signedInEnvProblems, signedInSpawnRefusal } from "./continuity-signed-in.js";
import { continuityOptions, DEFAULT_RAW_OUT, parseArgs, refuseShared, type AttemptDeps, type Launch, type Preflight, type RunOptions } from "./continuity-run.js";

export { SIGNED_IN_MISSING_GATES, READ_BOUNDARY_UNPROVEN, KEYCHAIN_OPEN };

/** T-525 Addendum E2: the signed-in arm's options, the continuity policy with no settings source but the run's --settings file. */
export function signedInOptions(effort: string): ClaudePolicyOptions {
  return { ...continuityOptions(effort), settingSources: "none" };
}

/**
 * T-525 Addendum E1 and the live guard: a signed-in launch refuses on any token or API-key variable (names
 * only), then refuses to spawn claude: without --live-ack it names the ack, with it the missing gates.
 */
export function refuseSignedIn(o: Pick<RunOptions, "liveAck">, env: NodeJS.ProcessEnv): never {
  const names = signedInEnvProblems(env);
  if (names.length > 0) throw new Error(`continuity-run: signed-in isolation refuses these variables (names only): ${names.join(", ")}`);
  throw new Error(signedInSpawnRefusal(o.liveAck));
}

/**
 * T-525: every execution entry point (runPilot, runAttempt, runMatrix) and the driveClaude spawn boundary
 * refuse a signed-in launch, so a supplied Preflight cannot route around preflight's own refusal.
 */
export function refuseSignedInLaunch(o: Pick<RunOptions, "isolation" | "liveAck">, env: NodeJS.ProcessEnv = process.env): void {
  if (o.isolation === "signed-in") refuseSignedIn(o, env);
}

/**
 * T-525 G1: the Launch's own isolation, independent of the options it is driven with. A signed-in Launch is
 * refused (first for a missing pinned provenance, then as signed-in), and a Launch prepared for another isolation
 * than the run's is a mismatch; all before any spawn.
 */
export function refuseLaunchIsolation(o: Pick<RunOptions, "isolation" | "liveAck">, launch: Pick<Launch, "isolation" | "expected">): void {
  if (launch.isolation === "signed-in") {
    if (launch.expected?.provenance === undefined) throw new Error("continuity-run: a signed-in launch with no pinned provenance is refused before any spawn");
    throw new Error(`continuity-run: the launch is signed-in; ${signedInSpawnRefusal(o.liveAck)}`);
  }
  if (launch.isolation !== o.isolation) throw new Error(`continuity-run: launch isolation ${String(launch.isolation)} does not match the run's ${String(o.isolation)}; refusing before any spawn`);
}

/**
 * E3 (B4, K1): a provenance latch. The turn is discarded before any grading, the refusal is persisted beside the
 * attempt, and the matrix never resumes past it: a re-run refuses while that refusal is on disk.
 */
export class ProvenanceStopError extends Error {
  constructor(message: string) { super(message); this.name = "ProvenanceStopError"; }
}

/** E3: the file a provenance stop leaves in the attempt's raw dir. */
export const PROVENANCE_STOP_FILE = "provenance.stop.json";
/** B-F2: written unresolved before a provenance-enabled spawn, resolved only after a clean, confirmed outcome. */
export const PROVENANCE_INTENT_FILE = "provenance.intent.json";
/** C-F3: the readback exchange and its expectation (env values masked), written after the readback and before the prompt. */
export const PROVENANCE_READBACK_FILE = "provenance.readback.json";
/** C-F3: positive evidence of a clean turn, written only after a clean provenance outcome and a clean terminal journal. */
export const PROVENANCE_OUTCOME_FILE = "provenance.outcome.json";
/** C-F3: why a recovery refused (the K2 diagnostic is home.diagnostic.json). */
export const RECOVERY_DIAGNOSTIC_FILE = "provenance.recovery.json";
export const PROVENANCE_RECORD_SCHEMA = 1 as const;
/** C-F5, C-F3: what the intent records before the spawn: the launch's session id and the hash of the readback expectation. */
export interface IntentRecord { readonly schema: typeof PROVENANCE_RECORD_SCHEMA; readonly sessionId: string; readonly expectedSha256: string }
/** Canonical JSON (sorted keys at every level), so a stored expectation hashes as the in-memory one did. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** The expectation's identity without the per-turn nonce (the intent is written before the nonce exists). */
export const expectationSha256 = (x: ReadbackExpected): string => { const { nonce: _n, ...rest } = x; return sha256(canonicalJson(rest)); };
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * C-F5: the transcript's init events checked against the session id the launch chose (recorded in the intent). A
 * duplicate, invalid or mismatched init, or a corrupt line, is a refusal; `complete` (recovery) also requires exactly
 * one init, no truncated tail and a terminal result event.
 */
export function transcriptBinding(text: string, sessionId: string, complete: boolean): string | null {
  const parsed = parseStream(text);
  if (parsed.corruptLines > 0) return `the transcript has ${parsed.corruptLines} corrupt line(s)`;
  if (complete && parsed.truncatedTail !== null) return "the transcript ends in a truncated line";
  const inits = parsed.events.filter((ev) => (ev as { type?: unknown }).type === "system" && (ev as { subtype?: unknown }).subtype === "init") as { session_id?: unknown }[];
  if (inits.length > 1) return `${inits.length} init events (one turn has one)`;
  for (const i of inits) {
    if (typeof i.session_id !== "string" || !SESSION_ID.test(i.session_id)) return "an init event carries no valid session id";
    if (i.session_id !== sessionId) return "an init event names a session the launch did not choose";
  }
  if (complete && inits.length !== 1) return "no init event";
  if (complete && !parsed.events.some((ev) => (ev as { type?: unknown }).type === "result")) return "no terminal result event";
  return null;
}

/** B-F6: the largest intent file the scan reads. */
export const INTENT_MAX_BYTES = 4096;

/**
 * T-538 S1b: the attempt layout beneath an experiment's raw folder. `levels` are the folder levels, outermost first;
 * the last level is the attempt folder that holds the provenance records. Each level names its folders by `pattern`
 * (the lister and recovery use it; the stop scan treats every entry as part of the tree and refuses anything that is
 * not a real directory). `skipTop` names top-level folders that belong to something else (continuity's pilot).
 * `accepts` is a further check on a recovery path's parts. Continuity's layout is the default everywhere.
 */
export interface AttemptLayout {
  readonly levels: readonly { readonly name: string; readonly pattern: RegExp }[];
  readonly skipTop: readonly string[];
  readonly accepts: (parts: readonly string[]) => boolean;
  /** How a recovery path is written, for the refusal. */
  readonly describe: string;
}
export const CONTINUITY_LAYOUT: AttemptLayout = {
  levels: [{ name: "task", pattern: /^T-\d+$/ }, { name: "repeat", pattern: /^repeat-\d+$/ }, { name: "attempt", pattern: /^attempt-\d{3}$/ }],
  skipTop: ["pilot"],
  accepts: (parts) => TASKS.includes(parts[0] as Task),
  describe: "<task>/repeat-<n>/attempt-<nnn>",
};

/**
 * S1b fix (P2): a layout is usable only with at least one level and stateless patterns. A g or y flag makes test()
 * depend on lastIndex, so an answer would depend on earlier calls. Null when usable.
 */
export function layoutProblem(layout: AttemptLayout): string | null {
  if (!Array.isArray(layout.levels) || layout.levels.length === 0) return "it has no levels";
  for (const l of layout.levels) {
    if (!(l.pattern instanceof RegExp)) return `level ${JSON.stringify(l.name)} has no pattern`;
    if (l.pattern.global || l.pattern.sticky) return `level ${JSON.stringify(l.name)}'s pattern carries the g or y flag, which makes matching stateful`;
  }
  return null;
}
function checkLayout(layout: AttemptLayout): void {
  const p = layoutProblem(layout);
  if (p !== null) throw new Error(`continuity-run: the attempt layout is refused: ${p}`);
}
/** S1b fix (P1): a path segment that is empty, "." or "..", or that holds a separator or NUL, whatever the layout says. */
export const unsafeSegment = (seg: string): boolean => seg === "" || seg === "." || seg === ".." || /[/\\\0]/.test(seg);

/** B-F3, B-F6: the reads the provenance-stop scan makes. lstat never follows a link; the intent is read by readIntent. */
export interface StopScanFs {
  lstatSync(p: string): { isDirectory(): boolean; isFile(): boolean };
  readdirSync(p: string): string[];
  readIntent(p: string): string;
}
const STOP_SCAN_FS: StopScanFs = { lstatSync, readdirSync: (p) => readdirSync(p), readIntent: (p) => readRegularFile(p, INTENT_MAX_BYTES) };

/**
 * E3, B-F3: every attempt of this experiment that left a provenance stop or an unresolved intent, as
 * task/repeat/attempt paths. The scan is bounded to the experiment's own tree (rawOut/<experiment>/<task>/
 * <repeat>/<attempt>, three fixed levels, no link followed; the pilot's own subtree is skipped), so another
 * experiment never blocks this one. Only an absent experiment root means "no stops"; any other read error, a
 * non-directory where a directory belongs, or an unreadable intent is thrown, never taken as empty.
 * B-F6: an intent that is a link or a special file is a stop and is never opened; a regular one is read through
 * readRegularFile. The stop file is found by name only and never read.
 */
export function provenanceStops(root: string, fs: StopScanFs = STOP_SCAN_FS, layout: AttemptLayout = CONTINUITY_LAYOUT): string[] {
  checkLayout(layout);
  try { if (!fs.lstatSync(root).isDirectory()) throw new Error(`continuity-run: the experiment's raw root is not a directory: ${root}`); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: string[] = [];
  // S1b: one level per layout level, depth first in listing order; lstat never follows a link, so a linked folder is
  // an unexpected entry and is never entered.
  const walk = (dir: string, depth: number, rel: readonly string[]): void => {
    for (const n of fs.readdirSync(dir).filter((x) => depth > 0 || !layout.skipTop.includes(x))) {
      if (!fs.lstatSync(join(dir, n)).isDirectory()) throw new Error(`continuity-run: an unexpected entry in the experiment's raw tree: ${join(dir, n)}`);
      if (depth + 1 < layout.levels.length) walk(join(dir, n), depth + 1, [...rel, n]);
      else visit(join(dir, n), [...rel, n].join("/"));
    }
  };
  const visit = (d: string, label: string): void => {
        const names = fs.readdirSync(d);
        let intentOpen = false;
        if (names.includes(PROVENANCE_INTENT_FILE)) {
          // B-F6: a link or a special file in the intent's place is a stop, never followed or opened.
          if (!fs.lstatSync(join(d, PROVENANCE_INTENT_FILE)).isFile()) intentOpen = true;
          else {
            const state = (JSON.parse(fs.readIntent(join(d, PROVENANCE_INTENT_FILE))) as { state?: unknown }).state;
            intentOpen = state !== "resolved";
          }
        }
        if (names.includes(PROVENANCE_STOP_FILE) || intentOpen) out.push(label);
  };
  walk(root, 0, []);
  return out.sort();
}

/** W3 (K2): the real recovery probe: the group probe only (kill(-pgid, 0) through the seam; this module imports no signalling call), and the leader's identity for the diagnostic. */
const REAL_RECOVERY_PROBE: RecoveryProbe = {
  group: (pgid) => { try { processGroupSeams.probe(pgid); return "present"; } catch (e) { const c = (e as NodeJS.ErrnoException).code; return c === "ESRCH" ? "gone" : c ?? String(e); } },
  identity: identityOf,
};

/** C-F4, test seam: the two calls recovery's evidence is read with. Only ENOENT is absence. */
export interface RecoveryFs { readonly lstat: (p: string) => ReturnType<typeof lstatSync>; readonly read: (p: string, max: number) => string }
const RECOVERY_FS: RecoveryFs = { lstat: (p) => lstatSync(p), read: readRegularFile };
const TRANSCRIPT_MAX_BYTES = 256 * 1024 * 1024;
const RECORD_MAX_BYTES = 64 * 1024 * 1024;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * W3: the operator's way out of a crashed guarded attempt; never a spawn, never the matrix. The attempt is named
 * task/repeat/attempt inside --raw-out/<experiment>, every level a real directory (no link, no traversal). It must
 * hold an unresolved intent and no recorded stop (a stop is a result, not a crash, and is never cleared).
 * C-F3: the intent is resolved only on positive, persisted evidence of a clean turn, revalidated against what the
 * intent recorded before the spawn: the clean outcome record (written only after a clean provenance outcome and a
 * clean terminal journal), the transcript it names (hash, complete, one init bound to the launch's session id, a
 * terminal result), the persisted readback recomputed against the recorded expectation, the init checks the live
 * run latches on, and the home journal (K2 when the terminal inventory is missing), bound to that session id alone
 * (C-F5). C-F4: only ENOENT is absence. Every refusal leaves the intent unresolved; past the intent checks it also
 * writes a diagnostic.
 */
export async function recoverAttempt(o: RunOptions, pf: Pick<Preflight, "experiment">, attemptPath: string, deps: Pick<AttemptDeps, "homeRoot" | "writeDurable"> & { readonly recoveryProbe?: RecoveryProbe; readonly recoveryFs?: RecoveryFs; readonly layout?: AttemptLayout } = {}): Promise<void> {
  refuseShared(o);
  const refuse = (why: string): never => { throw new ProvenanceStopError(`continuity-run: --recover ${attemptPath} refused: ${why}`); };
  if (!/^[0-9a-f]{12,64}$/.test(pf.experiment)) refuse("the experiment must be its hex id (the 12-hex short id is enough)");
  const experiment = pf.experiment.slice(0, 12);
  const layout = deps.layout ?? CONTINUITY_LAYOUT;
  const lp = layoutProblem(layout);
  if (lp !== null) refuse(`the attempt layout is refused: ${lp}`);
  // P1: the segments are checked before any layout pattern and before any file is touched, so a permissive pattern
  // can never walk recovery out of the experiment folder.
  const parts = attemptPath.split("/");
  if (parts.some(unsafeSegment)) refuse("the attempt path has an empty, \".\" or \"..\" segment, or a separator or NUL inside one");
  if (parts.length !== layout.levels.length || !parts.every((p, i) => layout.levels[i]!.pattern.test(p)) || !layout.accepts(parts)) refuse(`the attempt must be ${layout.describe}`);
  const base = resolve(o.rawOut, experiment);
  if (!resolve(base, ...parts).startsWith(`${base}${sep}`)) refuse("the attempt path does not stay beneath the experiment folder");
  const fsx = deps.recoveryFs ?? RECOVERY_FS;
  const stat = (p: string, what: string): ReturnType<typeof lstatSync> | null => {
    try { return fsx.lstat(p); } catch (e) {
      const c = (e as NodeJS.ErrnoException).code;
      if (c === "ENOENT") return null;
      return refuse(`${what} cannot be checked (${c ?? (e as Error).message})`);
    }
  };
  const readJson = (p: string, max: number, what: string): unknown => {
    const st = stat(p, what);
    if (st === null) return refuse(`no ${what}`);
    if (!st.isFile()) return refuse(`${what} is not a regular file`);
    let t: string;
    try { t = fsx.read(p, max); } catch (e) { return refuse(`${what} is unreadable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
    try { return JSON.parse(t); } catch { return refuse(`${what} is not JSON`); }
  };
  const realDir = (p: string): boolean => { const st = stat(p, p); return st !== null && st.isDirectory(); };
  if (!realDir(o.rawOut)) refuse("--raw-out is not a real directory");
  let dir = join(o.rawOut, experiment);
  for (const part of ["", ...parts]) { dir = part === "" ? dir : join(dir, part); if (!realDir(dir)) refuse(`${dir} is not a real directory`); }
  const intentPath = join(dir, PROVENANCE_INTENT_FILE);
  if (stat(intentPath, "the intent") === null) refuse("no unresolved intent: nothing to recover");
  const intent = readJson(intentPath, INTENT_MAX_BYTES, "the intent");
  if (!isRecord(intent)) return refuse("the intent is malformed");
  if (intent.state === "resolved") refuse("the intent is already resolved; recovery is not repeated");
  if (intent.state !== "unresolved") refuse("the intent is malformed");
  if (intent.schema !== PROVENANCE_RECORD_SCHEMA || typeof intent.sessionId !== "string" || !SESSION_ID.test(intent.sessionId) || typeof intent.expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(intent.expectedSha256)) refuse("the intent records no launch session or expectation");
  const fields: IntentRecord = { schema: PROVENANCE_RECORD_SCHEMA, sessionId: intent.sessionId as string, expectedSha256: intent.expectedSha256 as string };
  if (stat(join(dir, PROVENANCE_STOP_FILE), "the provenance stop") !== null) refuse("a provenance stop is recorded; recovery does not clear a stop");
  const home = deps.homeRoot ?? (o.isolation === "signed-in" ? realHome() : undefined);
  if (home === undefined) refuse("no journalled home for this run");
  const durable = deps.writeDurable ?? writeDurable;
  try {
    // C-F3: the clean outcome record: positive evidence, bound to the intent's session.
    const outcome = readJson(join(dir, PROVENANCE_OUTCOME_FILE), RECORD_MAX_BYTES, "clean provenance outcome (the turn ended without one: a latch, or a crash before or during the terminal journal)");
    if (!isRecord(outcome) || outcome.schema !== PROVENANCE_RECORD_SCHEMA || outcome.sessionId !== fields.sessionId || outcome.cleanup !== "confirmed"
      || typeof outcome.transcriptSha256 !== "string" || !(outcome.nonce === null || (typeof outcome.nonce === "string" && /^[0-9a-f]{12}$/.test(outcome.nonce)))) refuse("the outcome record does not match the intent");
    // The transcript it names: the same bytes, complete, one init bound to the launch's session.
    const tPath = join(dir, "transcript.jsonl");
    const tst = stat(tPath, "the transcript");
    if (tst === null || !tst.isFile()) refuse("no transcript");
    let text = "";
    try { text = fsx.read(tPath, TRANSCRIPT_MAX_BYTES); } catch (e) { refuse(`the transcript is unreadable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
    if (sha256(text) !== (outcome as Record<string, unknown>).transcriptSha256) refuse("the transcript is not the one the outcome recorded");
    const binding = transcriptBinding(text, fields.sessionId, true);
    if (binding !== null) refuse(`the transcript is incomplete or unbound: ${binding}`);
    // The persisted readback, recomputed against the expectation the intent recorded.
    const rbr = readJson(join(dir, PROVENANCE_READBACK_FILE), RECORD_MAX_BYTES, "readback record");
    if (!isRecord(rbr) || rbr.schema !== PROVENANCE_RECORD_SCHEMA || !isRecord(rbr.expected) || !Array.isArray(rbr.steps)) return refuse("the readback record is malformed");
    const x = rbr.expected as unknown as ReadbackExpected;
    let xHash = "";
    try { xHash = expectationSha256(x); } catch { refuse("the readback record's expectation is malformed"); }
    if (xHash !== fields.expectedSha256) refuse("the readback record's expectation is not the one the intent recorded");
    if ((x.nonce ?? null) !== (outcome as Record<string, unknown>).nonce) refuse("the readback record's nonce is not the outcome's");
    const steps = rbr.steps as unknown as ReadbackStep[];
    const rp = readbackProblems(steps, x);
    if (rp.length > 0) refuse(`readback: ${rp[0]}`);
    const init = parseStream(text).events.find((ev) => (ev as { type?: unknown }).type === "system" && (ev as { subtype?: unknown }).subtype === "init") as unknown as Record<string, unknown>;
    const first = steps[0];
    const readbackInit = first?.subtype === "initialize" && first.outcome === "success" && isRecord(first.response) ? first.response : null;
    if (initContradicts(init, readbackInit)) refuse("init.contradiction");
    if (x.provenance !== undefined) { const bad = initProvenanceProblems(init, x.provenance); if (bad.length > 0) refuse(bad[0]!); }
    // The home journal, bound to the launch's session alone (K2 when the terminal inventory is missing).
    let v: readonly unknown[] = [];
    try { v = await recoverHomeJournal(dir, home!, [fields.sessionId], deps.recoveryProbe ?? REAL_RECOVERY_PROBE, { write: durable }); } catch (e) { if (e instanceof HomeJournalStop) refuse(e.code + (e.message.includes(": ") ? ` (${e.message.slice(e.message.indexOf(": ") + 2)})` : "")); throw e; }
    if (v.length > 0) refuse(`home.violation: ${v.length} change(s) recorded in home.violations.json`);
  } catch (e) {
    if (!(e instanceof ProvenanceStopError)) throw e;
    try { await durable(join(dir, RECOVERY_DIAGNOSTIC_FILE), `${JSON.stringify({ schema: PROVENANCE_RECORD_SCHEMA, reason: e.message }, null, 2)}\n`); } catch (w) { throw new ProvenanceStopError(`${e.message}; the diagnostic was not written (${(w as Error).message})`); }
    throw e;
  }
  await durable(intentPath, `${JSON.stringify({ state: "resolved", ...fields })}\n`);
}

/** W3: `--recover <task/repeat/attempt> --experiment <12-hex>` alone; never with a run, never a spawn. */
export async function cliRecover(argv: readonly string[], deps: Parameters<typeof recoverAttempt>[3] = {}): Promise<boolean> {
  const i = argv.indexOf("--recover");
  if (i < 0) return false;
  if (argv.includes("--pilot") || argv.includes("--tasks") || argv.includes("--repeats")) throw new Error("continuity-run: --recover is not combined with a run");
  const e = argv.indexOf("--experiment");
  await recoverAttempt(parseArgs(argv.filter((_, k) => k !== i && k !== i + 1 && k !== e && k !== e + 1)), { experiment: e >= 0 ? argv[e + 1] ?? "" : "" }, argv[i + 1] ?? "", deps);
  return true;
}

/** Addendum E5: one attempt's row in the transcript listing. Metadata only: existence and size by lstat, nothing opened. */
export interface TranscriptListing {
  readonly attempt: string;
  readonly intent: "unresolved" | "resolved" | "missing" | "unreadable" | "malformed";
  readonly sessionId: string | null;
  readonly transcripts: readonly { readonly path: string; readonly size: number }[];
  /** <project>/<session id> folders (a client's runtime directory): listed by path only, never opened or read. */
  readonly runtimeDirectories: readonly string[];
  readonly problems: readonly string[];
}
export interface ListingFs {
  readonly lstat: (p: string) => { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; readonly size: number };
  readonly readdir: (p: string) => string[];
  readonly realpath: (p: string) => string;
  readonly readIntent: (p: string, max: number) => string;
}
const LISTING_FS: ListingFs = { lstat: lstatSync, readdir: (p) => readdirSync(p), realpath: (p) => realpathSync(p), readIntent: readRegularFile };

/**
 * Addendum E5: after the matrix, the run's transcripts are listed for the owner; removal is the owner's, never this
 * code's. Walks <rawOut>/<experiment>/<task>/<repeat>/<attempt>, reads each attempt's intent (a raw-dir record, bounded,
 * no follow) for the session id the launch chose, and looks for <home>/.claude/projects/<any>/<id>.jsonl and the
 * <id> folder beside it by lstat alone: a transcript is never opened, a folder is never entered, a link is never
 * followed (it is named as a problem), nothing is deleted. The home is an argument, so a test lists a fake one. Only
 * ENOENT is absence; any other error is named as a problem.
 *
 * Links on the way. The roots (the home, the raw folder, the experiment folder) must be real directories whose real
 * path is the path given, so no component of them is a link; otherwise the whole listing is refused before anything
 * beneath them is touched. <home>/.claude and its projects folder as a link are named and never entered. Every folder
 * that is listed is checked, used, then checked again: lstat, readdir, then its real path must still be the expected
 * one, or that level's entries are discarded and the change is named. The intent is opened no-follow and its
 * descriptor checked as a regular file, and the attempt folder's real path is checked after the read; each project
 * folder's real path is checked after its lookups. Node has no openat, so this narrows the window in which a folder
 * can be swapped for a link but cannot close it; the tool is an operator step run after the matrix, with nothing live.
 */
export function listRunTranscripts(rawOut: string, experiment: string, home: string, fs: ListingFs = LISTING_FS, layout: AttemptLayout = CONTINUITY_LAYOUT): TranscriptListing[] {
  checkLayout(layout);
  if (!/^[0-9a-f]{12,64}$/.test(experiment)) throw new Error("continuity-run: --list-transcripts needs the experiment's hex id (12 hex is enough)");
  const kind = (p: string): "dir" | "file" | "link" | "other" | "absent" | `error ${string}` => {
    try { const st = fs.lstat(p); return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other"; } catch (e) {
      const c = (e as NodeJS.ErrnoException).code; return c === "ENOENT" ? "absent" : `error ${c ?? (e as Error).message}`;
    }
  };
  const said = (k: string): string => (k === "link" ? "a link, not followed" : k);
  // null when the folder's real path is still `p`; otherwise what it is now.
  const moved = (p: string): string | null => {
    try { const r = fs.realpath(p); return r === p ? null : `its real path is now ${r}`; } catch (e) { return `its real path cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`; }
  };
  const root = (label: string, p: string): string => {
    const r = resolve(p);
    const k = kind(r);
    if (k !== "dir") throw new Error(`continuity-run: the ${label} ${r} is not a real directory (${said(k)}); nothing listed`);
    const m = moved(r);
    if (m !== null) throw new Error(`continuity-run: the ${label} ${r} is not its own real path (${m}; a component is a link); pass the real path; nothing listed`);
    return r;
  };
  const homeDir = root("home", home);
  const rawDir = root("raw folder", rawOut);
  const expDir = root("experiment folder", join(rawDir, experiment.slice(0, 12)));
  const names = (p: string, re: RegExp): string[] => fs.readdir(p).filter((n) => re.test(n)).sort();
  // The projects folders, each by lstat: a link is never entered.
  const claudeDir = join(homeDir, ".claude");
  const projects = join(claudeDir, "projects");
  const homeProblems: string[] = [];
  let projectDirs: string[] = [];
  const ck = kind(claudeDir);
  const pk = ck === "dir" ? kind(projects) : "absent";
  if (ck !== "dir" && ck !== "absent") homeProblems.push(`${claudeDir} is ${said(ck)}`);
  else if (pk === "dir") {
    for (const n of fs.readdir(projects).sort()) {
      const d = join(projects, n); const k = kind(d);
      if (k === "dir") projectDirs.push(d); else if (k === "link") homeProblems.push(`${d} is a link, not followed`); else if (k.startsWith("error")) homeProblems.push(`${d} cannot be checked (${k.slice(6)})`);
    }
    const m = moved(projects);
    if (m !== null) { projectDirs = []; homeProblems.push(`${projects} changed while it was listed (${m}); its entries are discarded`); }
  } else if (pk !== "absent") homeProblems.push(`${projects} is ${said(pk)}`);
  const out: TranscriptListing[] = [];
  const stray = (attempt: string, problem: string): void => { out.push({ attempt, intent: "missing", sessionId: null, transcripts: [], runtimeDirectories: [], problems: [...homeProblems, problem] }); };
  // Each level: the parent is listed, then its real path is checked again; each child is checked by lstat before it is
  // used. A linked task, repeat or attempt folder is named, never entered; a parent that changed loses its entries.
  const level = (parent: string, re: RegExp, label: string): string[] => {
    const listed = names(parent, re);
    const m = moved(parent);
    if (m !== null) {
      if (label === "") throw new Error(`continuity-run: the experiment folder ${parent} changed while it was listed (${m}); nothing listed`);
      stray(label, `${parent} changed while it was listed (${m}); its entries are discarded`);
      return [];
    }
    const ok: string[] = [];
    for (const n of listed) {
      const k = kind(join(parent, n));
      if (k === "dir") ok.push(n); else stray(label === "" ? n : `${label}/${n}`, `${join(parent, n)} is not a real directory (${said(k)})`);
    }
    return ok;
  };
  // S1b: one level per layout level, each listed through `level`; the last level's folders are the attempts.
  const walk = (parent: string, depth: number, label: string): void => {
    for (const n of level(parent, layout.levels[depth]!.pattern, label).filter((x) => depth > 0 || !layout.skipTop.includes(x))) {
      const next = label === "" ? n : `${label}/${n}`;
      if (depth + 1 < layout.levels.length) walk(join(parent, n), depth + 1, next);
      else visit(join(parent, n), next);
    }
  };
  const visit = (dir: string, label: string): void => {
        const problems: string[] = [...homeProblems];
        const ip = join(dir, PROVENANCE_INTENT_FILE);
        const ik = kind(ip);
        let intent: TranscriptListing["intent"] = "missing"; let sessionId: string | null = null;
        if (ik === "file") {
          try {
            const text = fs.readIntent(ip, INTENT_MAX_BYTES);
            const m = moved(dir);
            if (m !== null) { intent = "unreadable"; problems.push(`${dir} changed while the intent was read (${m}); the content is discarded`); } else {
              const v = JSON.parse(text) as Record<string, unknown>;
              if ((v.state === "unresolved" || v.state === "resolved") && typeof v.sessionId === "string" && SESSION_ID.test(v.sessionId)) { intent = v.state; sessionId = v.sessionId; } else intent = "malformed";
            }
          } catch (e) { intent = "unreadable"; problems.push(`the intent is unreadable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
        } else if (ik !== "absent") { intent = "unreadable"; problems.push(`the intent is ${said(ik)}`); }
        const transcripts: { path: string; size: number }[] = [];
        const runtimeDirectories: string[] = [];
        if (sessionId !== null) {
          for (const d of projectDirs) {
            const found: { path: string; size: number }[] = []; const dirs: string[] = []; const named: string[] = [];
            const t = join(d, `${sessionId}.jsonl`);
            try {
              const st = fs.lstat(t);
              if (st.isSymbolicLink()) named.push(`${t} is a link, not followed`);
              else if (st.isFile()) found.push({ path: t, size: st.size });
              else named.push(`${t} is not a regular file`);
            } catch (e) { const c = (e as NodeJS.ErrnoException).code; if (c !== "ENOENT") named.push(`${t} cannot be checked (${c ?? (e as Error).message})`); }
            const rd = join(d, sessionId);
            const rk = kind(rd);
            if (rk === "dir") dirs.push(rd); else if (rk !== "absent") named.push(`${rd} is ${rk === "link" ? "a link, not followed" : rk.startsWith("error") ? `not checkable (${rk.slice(6)})` : "not a directory"}`);
            const m = moved(d);
            if (m !== null) problems.push(`${d} changed while it was checked (${m}); its results are discarded`);
            else { transcripts.push(...found); runtimeDirectories.push(...dirs); problems.push(...named); }
          }
        }
        out.push({ attempt: label, intent, sessionId, transcripts, runtimeDirectories, problems });
  };
  walk(expDir, 0, "");
  return out;
}

/** Addendum E5: `--list-transcripts --experiment <hex> --home <dir> [--raw-out <dir>]` alone; never with a run or a recovery. */
export function cliListTranscripts(argv: readonly string[], write: (s: string) => void = (s) => { process.stdout.write(s); }, fs: ListingFs = LISTING_FS): boolean {
  if (!argv.includes("--list-transcripts")) return false;
  if (["--pilot", "--tasks", "--repeats", "--recover"].some((f) => argv.includes(f))) throw new Error("continuity-run: --list-transcripts is not combined with a run or a recovery");
  const val = (f: string): string | undefined => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const home = val("--home");
  if (home === undefined || home === "" || home.startsWith("--")) throw new Error("continuity-run: --list-transcripts needs --home <dir>, named explicitly");
  for (const r of listRunTranscripts(val("--raw-out") ?? DEFAULT_RAW_OUT, val("--experiment") ?? "", home, fs)) write(`${JSON.stringify(r)}\n`);
  return true;
}

/** S1c: the hooks guardedSpawn hands the spawn; a key is present only when that record is kept. */
export interface GuardedSpawnHooks {
  readonly onGroup?: (pgid: number) => Promise<void>;
  readonly onReadback?: (r: { readonly expected: ReadbackExpected; readonly steps: readonly ReadbackStep[] }) => Promise<void>;
}
/** S1c: what guardedSpawn needs from the spawn's result. */
export interface GuardedRun {
  readonly provenanceStop: string | null;
  readonly cleanup: "confirmed" | "unconfirmed" | null;
  readonly readbackNonce: string | null;
}
/** S1c: one attempt's place and records. Every writer and clock is the caller's, so a test can inject a fault at each. */
export interface GuardedSpawnCtx {
  readonly rawOut: string;
  readonly rawDir: string;
  /** Whether --raw-out was a real directory (not a link) when the run began. */
  readonly rawOutReal: boolean;
  /** A provenance-enabled or signed-in launch: the intent, readback, outcome and resolution are kept. */
  readonly guarded: boolean;
  readonly intentFields: IntentRecord;
  /** The home the journal inventories; undefined keeps no journal. */
  readonly journalHome: string | undefined;
  readonly transcriptPath: string;
  /** The attempt's name in a stop message, `<task>#<repeat>` for continuity. */
  readonly label: string;
  readonly durable: (path: string, text: string) => Promise<void>;
  readonly fsyncDir: (dir: string) => Promise<void>;
  /** B-F7: the raw chain's parent directories, outermost first; asked only for a guarded run. */
  readonly chainParents: () => readonly string[];
  readonly startOf: (pid: number) => string | null;
  /** The persisted readback record's JSON text (the caller masks the env). */
  readonly readbackRecord: (r: { readonly expected: ReadbackExpected; readonly steps: readonly ReadbackStep[] }) => string;
}

/**
 * S1c: the schema-1 guarded lifecycle around one spawn, moved unchanged from continuity's runAttempt. In order:
 * the raw chain and the unresolved intent (guarded), the journal baseline, the spawn with its group and readback
 * hooks, the terminal journal, the outcome then the resolution (guarded, confirmed cleanup, no stop), and a durable
 * stop on any provenance latch. A stop throws ProvenanceStopError; the run is returned only when it may be graded.
 */
export async function guardedSpawn<R extends GuardedRun>(ctx: GuardedSpawnCtx, spawn: (hooks: GuardedSpawnHooks) => Promise<R>): Promise<R> {
  const { rawDir, durable, intentFields, journalHome, transcriptPath, guarded } = ctx;
  if (guarded && !ctx.rawOutReal) throw new Error(`continuity-run: a guarded run needs --raw-out to exist as a real directory (not a link) before the run; ${ctx.rawOut} was not one. Refusing before the spawn.`);
  if (guarded) {
    // B-F7: every entry of the raw chain (experiment, task, repeat, attempt) is recorded in its parent before the
    // intent, so a crash cannot leave a durable intent inside a directory recovery never finds.
    for (const d of ctx.chainParents()) await ctx.fsyncDir(d);
    await durable(join(rawDir, PROVENANCE_INTENT_FILE), `${JSON.stringify({ state: "unresolved", ...intentFields })}\n`);
  }
  const homeStop = async (code: string): Promise<never> => {
    await durable(join(rawDir, PROVENANCE_STOP_FILE), `${JSON.stringify({ code, cleanup: null, retryable: false }, null, 2)}\n`);
    throw new ProvenanceStopError(`continuity-run: ${ctx.label} stopped on the home journal: ${code}. The turn is discarded, not graded and not retried.`);
  };
  if (journalHome !== undefined) {
    try { await journalBefore(rawDir, journalHome, { write: durable }); } catch (e) { if (e instanceof HomeJournalStop) await homeStop(e.code); throw e; }
  }
  const hooks: GuardedSpawnHooks = {
    ...(journalHome === undefined ? {} : { onGroup: async (pgid: number) => journalGroup(rawDir, pgid, ctx.startOf(pgid), { write: durable }) }),
    ...(guarded ? { onReadback: async (r: { readonly expected: ReadbackExpected; readonly steps: readonly ReadbackStep[] }) => durable(join(rawDir, PROVENANCE_READBACK_FILE), `${ctx.readbackRecord(r)}\n`) } : {}),
  };
  const run = await spawn(hooks);
  // C1 to C3: the terminal inventory after the cleanup check, on success and failure, validated before any grading.
  let journalStop: string | null = null;
  if (journalHome !== undefined) {
    // C-F5: the exception allowlist is the launch's session id alone; the transcript's init events are checked against it.
    const binding = transcriptBinding(readFileSync(transcriptPath, "utf-8"), intentFields.sessionId, false);
    try {
      const v = await journalAfter(rawDir, journalHome, run.cleanup === "confirmed" ? "confirmed" : "unconfirmed", [intentFields.sessionId], { write: durable });
      if (v.length > 0) journalStop = `home.violation: ${v.map((c) => `${c.kind} ${c.rel}`).join(", ")}`;
    } catch (e) { if (e instanceof HomeJournalStop) journalStop = e.code; else throw e; }
    if (binding !== null) journalStop ??= `home.session-binding: ${binding}`;
  }
  if (journalStop !== null && run.provenanceStop === null) await homeStop(journalStop);
  if (guarded && run.provenanceStop === null && run.cleanup === "confirmed") {
    // C-F3: the positive evidence first (after the terminal journal), then the resolution; a crash between them is recoverable.
    await durable(join(rawDir, PROVENANCE_OUTCOME_FILE), `${JSON.stringify({ schema: PROVENANCE_RECORD_SCHEMA, sessionId: intentFields.sessionId, nonce: run.readbackNonce, cleanup: "confirmed", transcriptSha256: sha256(readFileSync(transcriptPath)) })}\n`);
    await durable(join(rawDir, PROVENANCE_INTENT_FILE), `${JSON.stringify({ state: "resolved", ...intentFields })}\n`);
  }
  if (run.provenanceStop !== null) {
    // B4, K1: discarded before any grading, and persisted durably so no re-run resumes past it.
    await durable(join(rawDir, PROVENANCE_STOP_FILE), `${JSON.stringify({ code: run.provenanceStop, cleanup: run.cleanup, retryable: false }, null, 2)}\n`);
    throw new ProvenanceStopError(`continuity-run: ${ctx.label} stopped on provenance: ${run.provenanceStop}. The turn is discarded, not graded and not retried.`);
  }
  return run;
}
