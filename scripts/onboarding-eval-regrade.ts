/**
 * Regrading a finished onboarding eval run from what it stored, without running it again.
 *
 * The run's own computation is replayed: every recorded turn is re-parsed from its raw transcript and
 * fed through the runner's shared flow (onboarding-eval-drive.ts), and the rebuilt failures, evidence,
 * record fields and grading packet must equal what the run stored. Only then are the failures
 * partitioned, by the producer that emitted each one: a turn whose only reason is shell the parser
 * could not read, the whole run's unparsed shell, and a test command that is a correct subshell become
 * questions for the judge; every other failure stays hard.
 *
 * Two guarantees. A first regrade of a record written before this existed can only check consistency
 * (G1): what the raw transcripts establish must agree with the record and the packet. Completing a
 * regrade with a judge result (G2) rejects any byte change in any file the first regrade read, because
 * that regrade pinned their hashes. Nothing here writes the original record or packet.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  claudeTurn, codexTurn, KNOWN_CHECK_SETS, runVerdict, stopRuleFor, subshellOnly, WRITE_RULE_VERSION,
  type EvalTurn, type JudgeLine, type RunVerdict, type RuntimeExclusion, type StopCheck,
} from "./onboarding-eval-lib.js";
import { parseStream, sha256 } from "./continuity-lib.js";
import {
  driveFlow, finishDrive, inspectAfter, newDriveState, packetText as buildPacketText, setupRecordFrom, writesAfterApprovalOf,
  type DriveTurn, type FailureSource, type PackageTurn, type Rubric, type StoryReader, type TurnResponse, type Variant,
} from "./onboarding-eval-drive.js";

export const UNPARSED_PREFIX = "needs review, shell construct not parsed: ";
export const G1 = "consistency validation against the stored raw, not historical authenticity: no manifest was recorded at run time";
export const G2 = "every byte of every file the pending revision read is unchanged";
export const OPAQUE_LIMIT = "failures present in the supplied record are preserved; for the infrastructure and tree failures, deletion of an opaque failure together with its retained source field before the first regrade is not detectable without a run-time record hash";
const OPAQUE_INFRA = /^(?:timed out after \d+ ms|spawn failed: .+|killed by \S+|exit -?\d+)$/;

/** A question the judge must rule on. */
export type Candidate =
  | { readonly kind: "parser"; readonly scope: "turn"; readonly turnIndex: number; readonly segment: string }
  | { readonly kind: "parser"; readonly scope: "run"; readonly segment: string }
  | { readonly kind: "recipe"; readonly scope: "run"; readonly command: string };

export interface CandidateRuling {
  readonly candidate: Candidate;
  readonly verdict: "pass" | "fail";
  readonly reason: string;
}

/** The judge's answer for a regrade: the packet's semantic lines plus one ruling per candidate, bound to one pending revision. */
export interface RegradeJudge {
  readonly revision: number;
  readonly regradeEvidenceHash: string;
  readonly packetSha256: string;
  readonly judgeSessionId: string;
  readonly observedModel: string;
  readonly lines: readonly JudgeLine[];
  readonly unparsedRulings: readonly CandidateRuling[];
}

export interface ManifestEntry { readonly path: string; readonly sha256: string }

export interface FixtureInputs {
  readonly firstPrompt: string;
  readonly discoveryPrompt: string;
  readonly afterPackage: readonly PackageTurn[];
  readonly rubric: Rubric;
  readonly beforeConfig: () => Record<string, unknown>;
  readonly briefs: Record<string, string>;
  readonly projectFiles: Record<string, string>;
  /** The fixture files the flow and packet read, hashed over their bytes into the manifest. */
  readonly files: readonly ManifestEntry[];
  /** The check set the rubric was projected and the owner script chosen for; it must be the record's. */
  readonly checkSet: number;
}

/** Read access to the raw `.story/` copy as bytes: every file is hashed as stored and decoded from those same bytes. */
export interface StoryBytes {
  exists(rel: string): boolean;
  readBytes(rel: string): Buffer;
  list(rel: string): string[];
}

/** Every stored file arrives as bytes: hashes bind bytes, never a decoding of them (UTF-8 decoding is not injective). */
export interface RegradeInput {
  readonly recordBytes: Buffer;
  readonly packetBytes: Buffer;
  /** Every entry name directly in the run's raw directory. */
  readonly rawNames: readonly string[];
  readonly readRaw: (name: string) => Buffer;
  /** The raw copy of the project's `.story/` after the run, or null when it has none. */
  readonly story: StoryBytes | null;
  readonly fixture: FixtureInputs;
  readonly reviewLine: string;
  /** The runner's `runSemanticLines`, for the fixture's variant. */
  readonly semanticLines: (reviewSkipped: boolean, turns: readonly DriveTurn[], exclusion: RuntimeExclusion, adjusted: boolean, checkSet: number, reviewLines: readonly string[]) => string[];
}

export interface Regraded {
  readonly verdict: RunVerdict["verdict"];
  readonly reasons: readonly string[];
  readonly hard: readonly string[];
  readonly candidates: readonly Candidate[];
  readonly manifest: readonly ManifestEntry[];
  readonly originalRecordSha256: string;
  readonly packetSha256: string;
  readonly regradeEvidenceHash: string;
  readonly semanticLines: readonly string[];
  readonly bound: Record<string, number[]>;
  /** The record's check set, only from 2 on: legacy regrades keep their exact shape and hash. */
  readonly checkSet?: number;
}

export type RegradeOutcome = { readonly ok: true; readonly result: Regraded } | { readonly ok: false; readonly reason: string };

class Refusal extends Error {}
const refuse = (reason: string): never => { throw new Refusal(reason); };

/** JSON with object keys sorted, so equal values have equal text; undefined is dropped from objects and null in arrays, as JSON does. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** The raw transcript file a record turn must have, by its position. */
export const turnFile = (index: number, label: string): string => `turn-${String(index + 1).padStart(2, "0")}-${label}`;

/** The hash every judge answer and completion is bound to. */
export function evidenceHash(e: {
  readonly originalRecordSha256: string; readonly packetSha256: string; readonly manifest: readonly ManifestEntry[];
  readonly candidates: readonly Candidate[]; readonly stopRuleVersion: string; readonly writeRuleVersion: string; readonly guarantee: string;
  readonly status: RevisionFile["status"]; readonly checkSet?: number;
}): string {
  const candidates = [...e.candidates].map(canonical).sort();
  return createHash("sha256").update(canonical({ ...e, candidates })).digest("hex");
}

/** A story reader that records every file and listing it served, for the manifest: each file hashed over its bytes, then decoded. */
function recordingReader(inner: StoryBytes, seen: Map<string, string>): StoryReader {
  return {
    exists: (rel) => { const e = inner.exists(rel); seen.set(`exists:${rel}`, e ? "yes" : "no"); return e; },
    read: (rel) => { const b = inner.readBytes(rel); seen.set(`file:${rel}`, sha256(b)); return b.toString("utf-8"); },
    list: (rel) => { const l = inner.list(rel); seen.set(`list:${rel}`, sha256([...l].sort().join("\n"))); return l; },
  };
}

const EMPTY_STORY: StoryReader = { exists: () => false, read: () => refuse("the run has no .story/ copy"), list: () => [] };

interface RecordTurn {
  label: string; prompt: string; stop: StopCheck | null; stopText: string; models: string[]; exitCode: number | null;
  infraFailure: string | null; treeChanges: string[]; callRange: [number, number]; unparsed?: unknown;
}

/** An infrastructure failure the record states for a turn, checked against the turn's terminal in the runner's precedence. */
function checkInfrastructure(index: number, infra: string | null, turn: EvalTurn): void {
  if (infra === null) {
    if (turn.terminal.status !== "completed") refuse(`turn ${index}: the raw terminal is ${turn.terminal.status}, but the record states no infrastructure failure`);
    return;
  }
  if (infra.startsWith("terminal ")) {
    const derived = `terminal ${turn.terminal.status}: ${turn.terminal.detail}`;
    if (turn.terminal.status === "completed" || infra !== derived) refuse(`turn ${index}: the recorded infrastructure failure "${infra}" is not the raw terminal "${derived}"`);
    return;
  }
  // A spawn, signal, timeout or exit failure outranks the terminal in the runner, and the raw cannot establish it.
  if (!OPAQUE_INFRA.test(infra)) refuse(`turn ${index}: unrecognised infrastructure failure "${infra}"`);
}

/** Where the run wrote a turn's stderr, as its recorded infrastructure failure names it; a placeholder when the record has none. */
function stderrPathOf(failures: readonly string[], runId: string, label: string, infra: string | null, file: string): string {
  const suffix = `/${runId}/${file}.stderr.txt`;
  if (infra !== null) {
    const head = `${label}: infrastructure: ${infra} (stderr in `;
    for (const f of failures) {
      if (f.startsWith(head) && f.endsWith(`${suffix})`)) return f.slice(head.length, -1);
    }
  }
  return `<absent>${suffix}`;
}

function parseTurn(client: string, raw: string, checkSet: number): EvalTurn {
  if (client === "claude") return claudeTurn(parseStream(raw).events, checkSet);
  const lines: Record<string, unknown>[] = [];
  for (const l of raw.split("\n")) { try { const v = JSON.parse(l); if (v && typeof v === "object") lines.push(v); } catch { /* non-JSON line */ } }
  return codexTurn(lines, checkSet);
}

function stringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) refuse(`${what} is present but is not an array of strings`);
  return v as string[];
}

/** Replays the run, checks it against the record and packet, and partitions the failures. Throws nothing: a refusal is a value. */
export function regrade(input: RegradeInput): RegradeOutcome {
  try {
    return { ok: true, result: regradeOrThrow(input) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    throw err;
  }
}

function regradeOrThrow(input: RegradeInput): Regraded {
  const recordText = input.recordBytes.toString("utf-8");
  const packetText = input.packetBytes.toString("utf-8");
  let record: Record<string, unknown>;
  try { record = JSON.parse(recordText) as Record<string, unknown>; } catch { return refuse("record.json is not JSON"); }
  const runId = String(record.runId);
  const variant = record.variant as Variant;
  const client = String(record.client);
  const turns = record.turns as RecordTurn[] | undefined;
  if (!Array.isArray(turns) || turns.length === 0) refuse("the record has no turns");
  const failures = record.failures as string[] | undefined;
  if (!Array.isArray(failures)) refuse("the record has no failures list");
  const recTurns = turns!;
  let packet: { harnessNormalisation?: { stop?: unknown; write?: unknown; checkSet?: unknown } };
  try { packet = JSON.parse(packetText) as typeof packet; } catch { return refuse("grading-packet.json is not JSON"); }
  const versions = packet.harnessNormalisation;
  // The check set: the record's own, never this code's current one. A record before check sets carries none and is 1.
  const recordSet = record.checkSetVersion;
  const checkSet = recordSet === undefined ? 1 : recordSet;
  // The stop rule is the one the record's check set was graded under, never this code's newest one.
  if (typeof checkSet !== "number" || !KNOWN_CHECK_SETS.includes(checkSet)) refuse(`the run was graded under check set ${String(checkSet)}, which this regrade does not support`);
  if (versions?.stop !== stopRuleFor(checkSet as number) || versions.write !== WRITE_RULE_VERSION) refuse("the run was graded under a stop or write rule version this regrade does not support");
  if ((recordSet === undefined) !== (versions?.checkSet === undefined) || (recordSet !== undefined && versions?.checkSet !== recordSet)) refuse("the record and packet name different check sets");
  if (input.fixture.checkSet !== checkSet) refuse(`the fixture inputs were read for check set ${input.fixture.checkSet}, the record names ${String(checkSet)}`);
  const cs = checkSet as number;
  const recFailures = failures!;

  // Turn identity: position is identity, the file name is fixed by it, and nothing else may sit beside them.
  const manifest: ManifestEntry[] = [];
  const expected = new Set<string>(["project.after"]);
  recTurns.forEach((t, i) => {
    if (typeof t.label !== "string" || !/^[a-z0-9-]+$/.test(t.label)) refuse(`turn ${i} has no valid label`);
    const f = turnFile(i, t.label);
    for (const ext of [".jsonl", ".stderr.txt"]) {
      if (!input.rawNames.includes(f + ext)) refuse(`raw file ${f}${ext} for turn ${i} is missing`);
      expected.add(f + ext);
    }
  });
  for (const name of input.rawNames) if (!expected.has(name)) refuse(`raw entry ${name} does not belong to any recorded turn`);

  // Replay through the runner's own flow.
  const exclusion = record.treeExclusion as RuntimeExclusion;
  const state = newDriveState(cs);
  const flow = driveFlow({ variant, firstPrompt: input.fixture.firstPrompt, discoveryPrompt: input.fixture.discoveryPrompt, afterPackage: input.fixture.afterPackage, exclusion }, state);
  let consumed = 0;
  for (let step = flow.next(); !step.done;) {
    const request = step.value;
    const rec = recTurns[consumed];
    if (rec === undefined) refuse(`the flow asks for turn ${consumed} (${request.label}), which the record does not have`);
    if (rec!.label !== request.label) refuse(`turn ${consumed} is recorded as ${rec!.label}, but the flow asks for ${request.label}`);
    if (rec!.prompt !== request.prompt) refuse(`turn ${consumed} (${rec!.label}) was recorded with a prompt the flow does not send`);
    const file = turnFile(consumed, rec!.label);
    const rawBytes = input.readRaw(`${file}.jsonl`);
    manifest.push({ path: `${file}.jsonl`, sha256: sha256(rawBytes) }, { path: `${file}.stderr.txt`, sha256: sha256(input.readRaw(`${file}.stderr.txt`)) });
    const raw = rawBytes.toString("utf-8");
    const turn = { ...parseTurn(client, raw, cs), models: Array.isArray(rec!.models) ? rec!.models : [] };
    checkInfrastructure(consumed, rec!.infraFailure, turn);
    const response: TurnResponse = {
      turn, exitCode: rec!.exitCode, infraFailure: rec!.infraFailure,
      stderrPath: stderrPathOf(recFailures, runId, rec!.label, rec!.infraFailure, file),
      treeChanges: () => rec!.treeChanges,
    };
    consumed++;
    step = flow.next(response);
  }
  if (consumed !== recTurns.length) refuse(`the record has ${recTurns.length} turns, the flow ends after ${consumed}`);

  const evidence = finishDrive(state, input.reviewLine);
  const semanticLines = input.semanticLines(state.reviewSkipped, state.turns, exclusion, input.fixture.afterPackage.some((x) => x.label === "adjust"), cs, evidence.reviewLines);
  const seen = new Map<string, string>();
  const story = input.story === null ? EMPTY_STORY : recordingReader(input.story, seen);
  const { inspection, ledgerRecords } = inspectAfter(state, story, input.fixture.rubric, input.fixture.beforeConfig, variant);
  const setupRecord = input.story === null ? "" : setupRecordFrom(story);
  for (const [k, v] of [...seen].sort(([a], [b]) => a.localeCompare(b))) manifest.push({ path: `project.after/.story#${k}`, sha256: v });
  manifest.push(...input.fixture.files);

  // The packet the run would have written must be the packet it did write.
  const rebuilt = buildPacketText({
    runId, semanticLines, reviewSkipped: state.reviewSkipped, exclusion, rubric: input.fixture.rubric, briefs: input.fixture.briefs,
    projectFiles: input.fixture.projectFiles, turns: state.turns, evidence, ledgerRecords, setupRecord, final: state.final, checkSet: cs,
  });
  if (!Buffer.from(rebuilt, "utf-8").equals(input.packetBytes)) refuse("the grading packet differs from the one the replayed run produces");
  const packetSha256 = sha256(input.packetBytes);
  if (record.packetSha256 !== packetSha256) refuse("the record's packet hash is not the packet's");
  if (record.runId !== runId || JSON.parse(packetText).runId !== runId) refuse("the packet is for another run");

  // Every record field the replay establishes must be what the record says.
  if (!same(state.failures, recFailures)) refuse("the record's failures differ from the replayed run's (a failure was added, removed, reordered or changed)");
  state.turns.forEach((t, i) => {
    const r = recTurns[i]!;
    for (const k of ["label", "prompt", "stop", "stopText", "exitCode", "infraFailure", "treeChanges", "callRange"] as const) {
      if (!same(t[k], r[k])) refuse(`turn ${i} (${t.label}): the recorded ${k} differs from the replayed one`);
    }
    if ("unparsed" in r) {
      const arr = stringArray(r.unparsed, `turn ${i} unparsed`);
      if (!same(arr, t.unparsed)) refuse(`turn ${i} (${t.label}): the recorded unparsed segments differ from the raw`);
      const reason = r.stop?.reasons.find((x) => x.startsWith(UNPARSED_PREFIX));
      if ((reason ?? null) !== (arr.length > 0 ? UNPARSED_PREFIX + arr.join("; ") : null)) refuse(`turn ${i} (${t.label}): the stop reason does not join the recorded segments`);
    }
  });
  if ("unparsed" in record) {
    const arr = stringArray(record.unparsed, "the record's unparsed");
    if (!same(arr, evidence.unparsed)) refuse("the record's unparsed segments differ from the raw");
    const entry = recFailures.find((f) => f.startsWith(UNPARSED_PREFIX));
    if ((entry ?? null) !== (arr.length > 0 ? UNPARSED_PREFIX + arr.join("; ") : null)) refuse("the whole-run needs-review failure does not join the recorded segments");
  }
  const fields: [string, unknown][] = [
    ["reviewEvidence", evidence.reviewEvidence], ["bound", evidence.bound], ["semanticLines", semanticLines], ["writesAfterApproval", writesAfterApprovalOf(state)],
    ["inspection", inspection], ["infraFailed", state.infraFailed], ["discoveryRounds", state.rounds], ["reviewSkipped", state.reviewSkipped],
  ];
  for (const [k, v] of fields) if (!same(record[k], v)) refuse(`the record's ${k} differs from the replayed run's`);

  // Partition by producer.
  const hard: string[] = [];
  const candidates: Candidate[] = [];
  const add = (c: Candidate): void => { if (!candidates.some((x) => same(x, c))) candidates.push(c); };
  state.failures.forEach((text, i) => {
    const source: FailureSource = state.sources[i]!;
    if (source.kind === "stop") {
      const t = state.turns[source.turn]!;
      const only = t.stop?.reasons.length === 1 && (t.unparsed ?? []).length > 0 && t.stop.reasons[0] === UNPARSED_PREFIX + t.unparsed!.join("; ");
      if (only) { for (const segment of t.unparsed!) add({ kind: "parser", scope: "turn", turnIndex: source.turn, segment }); return; }
    } else if (source.kind === "unparsed") {
      for (const segment of evidence.unparsed) add({ kind: "parser", scope: "run", segment });
      return;
    } else if (source.kind === "recipe") {
      const command = recipeSubshell(text, inspection, input.fixture.rubric);
      if (command !== null) { add({ kind: "recipe", scope: "run", command }); return; }
    }
    hard.push(text);
  });

  const originalRecordSha256 = sha256(input.recordBytes);
  const verdict: RunVerdict["verdict"] = hard.length > 0 ? "FAIL" : "PENDING_SEMANTIC";
  const setField = cs >= 2 ? { checkSet: cs } : {};
  const regradeEvidenceHash = evidenceHash({ originalRecordSha256, packetSha256, manifest, candidates, stopRuleVersion: stopRuleFor(cs), writeRuleVersion: WRITE_RULE_VERSION, guarantee: G1, status: verdict === "FAIL" ? "fail" : "pending", ...setField });
  const reasons = hard.length > 0 ? hard : candidates.length > 0 ? [`${candidates.length} question(s) for the judge`] : ["mechanical checks passed; no judge result yet"];
  return { verdict, reasons, hard, candidates, manifest, originalRecordSha256, packetSha256, regradeEvidenceHash, semanticLines, bound: evidence.bound, ...setField };
}

/** The command of a recipe failure that is only a subshell the harness cannot place, or null when the failure is hard. */
export function recipeSubshell(text: string, inspection: Record<string, unknown>, rubric: Rubric): string | null {
  const stages = inspection.testStages as { kind?: string; command?: unknown } | undefined;
  if (rubric.expectedRecipe.testStages !== "disabled-or-components" || stages?.kind !== "enabled" || typeof stages.command !== "string") return null;
  const command = stages.command;
  if (text !== `recipe: component test command: cannot tell where \`${command}\` runs (it uses ( )): use a plain sequence of cd and test commands joined by && or ;`) return null;
  return subshellOnly(command) ? command : null;
}

/** Applies a judge's answer to a pending regrade. The caller has already checked the revision chain. */
export function judgeVerdict(r: Regraded, packetText: string, judge: RegradeJudge): { readonly verdict: RunVerdict["verdict"]; readonly reasons: readonly string[] } {
  if (judge.regradeEvidenceHash !== r.regradeEvidenceHash) refuseValue("the judge answered a different regrade");
  if (judge.packetSha256 !== r.packetSha256) refuseValue("the judge read a different packet");
  if (typeof judge.judgeSessionId !== "string" || judge.judgeSessionId.trim() === "") refuseValue("the judge result names no session");
  if (!Array.isArray(judge.unparsedRulings)) refuseValue("the judge result has no unparsedRulings");
  // Hard failures stand whatever the judge says: rulings answer only the questions this regrade asked.
  const reasons: string[] = [...r.hard];
  const keys = new Set(r.candidates.map(canonical));
  const ruled = new Map<string, CandidateRuling>();
  for (const x of judge.unparsedRulings) {
    if (x === null || typeof x !== "object" || (x.verdict !== "pass" && x.verdict !== "fail") || typeof x.reason !== "string" || x.reason.trim() === "") refuseValue("a candidate ruling is malformed");
    const key = canonical(x.candidate);
    if (!keys.has(key)) refuseValue(`a ruling names a question this regrade did not ask: ${key}`);
    if (ruled.has(key)) refuseValue(`two rulings for one question: ${key}`);
    ruled.set(key, x);
  }
  for (const c of r.candidates) {
    const x = ruled.get(canonical(c));
    if (!x) reasons.push(`the judge did not rule on: ${canonical(c)}`);
    else if (x.verdict !== "pass") reasons.push(`judged: ${canonical(c)}: ${x.reason}`);
  }
  const semantic = runVerdict([], packetText, { packetSha256: judge.packetSha256, observedModel: judge.observedModel, lines: judge.lines }, r.semanticLines, r.bound);
  reasons.push(...semantic.reasons);
  return reasons.length > 0 ? { verdict: "FAIL", reasons } : { verdict: "PASS", reasons: [] };
}

class JudgeRefusal extends Error {}
const refuseValue = (reason: string): never => { throw new JudgeRefusal(reason); };

// --- revisions on disk ------------------------------------------------------------------

export interface RevisionFile {
  readonly revision: number;
  readonly status: "pending" | "judged" | "fail";
  readonly verdict: RunVerdict["verdict"];
  readonly reasons: readonly string[];
  readonly candidates: readonly Candidate[];
  readonly regradeEvidenceHash: string;
  readonly originalRecordSha256: string;
  readonly packetSha256: string;
  readonly manifest: readonly ManifestEntry[];
  readonly stopRuleVersion: string;
  readonly writeRuleVersion: string;
  readonly guarantee: string;
  readonly limitation: string;
  readonly parent: { readonly revision: number; readonly regradeJsonSha256: string } | null;
  readonly rulings: readonly CandidateRuling[];
  readonly judgeSessionId: string | null;
  readonly judgeObservedModel: string | null;
  readonly regradedAt: string;
  /** The record's check set, only from 2 on; part of the evidence hash. */
  readonly checkSet?: number;
}

const REVISION_DIR = /^\d{3}$/;

/** Every revision under `regrade/`, validated: a pair of files agreeing with each other and with its own hash. */
export function readRevisions(recordDir: string): { readonly dir: string; readonly revision: RevisionFile; readonly regradeJsonSha256: string }[] {
  const root = join(recordDir, "regrade");
  if (!existsSync(root)) return [];
  const out: { dir: string; revision: RevisionFile; regradeJsonSha256: string }[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!REVISION_DIR.test(name) || !statSync(dir).isDirectory()) refuseValue(`regrade/${name} is not a revision; remove it by hand after checking what wrote it`);
    const a = join(dir, "regrade.json"); const b = join(dir, "record.regraded.json");
    if (!existsSync(a) || !existsSync(b)) refuseValue(`regrade/${name} is a partial revision`);
    const text = readFileSync(a, "utf-8");
    let rev: RevisionFile; let pair: Record<string, unknown>;
    try { rev = JSON.parse(text) as RevisionFile; pair = JSON.parse(readFileSync(b, "utf-8")) as Record<string, unknown>; } catch { return refuseValue(`regrade/${name} is not JSON`); }
    if (rev.revision !== Number(name) || !["pending", "judged", "fail"].includes(rev.status) || !Array.isArray(rev.candidates) || !Array.isArray(rev.manifest) || !Array.isArray(rev.reasons) || typeof rev.regradeEvidenceHash !== "string") refuseValue(`regrade/${name} does not have the revision schema`);
    const consistent = rev.status === "pending" ? rev.verdict === "PENDING_SEMANTIC" : rev.status === "fail" ? rev.verdict === "FAIL" : rev.verdict === "PASS" || rev.verdict === "FAIL";
    if (!consistent) refuseValue(`regrade/${name}: status ${rev.status} does not fit verdict ${String(rev.verdict)}`);
    const regrade = pair.regrade as Record<string, unknown> | undefined;
    if (!regrade || regrade.revision !== rev.revision || regrade.status !== rev.status || regrade.verdict !== rev.verdict || !same(regrade.reasons, rev.reasons) || !same(regrade.candidates, rev.candidates) || regrade.regradeEvidenceHash !== rev.regradeEvidenceHash) refuseValue(`regrade/${name}: its two files disagree`);
    const recomputed = evidenceHash({ originalRecordSha256: rev.originalRecordSha256, packetSha256: rev.packetSha256, manifest: rev.manifest, candidates: rev.candidates, stopRuleVersion: rev.stopRuleVersion, writeRuleVersion: rev.writeRuleVersion, guarantee: rev.guarantee, status: rev.status, checkSet: rev.checkSet });
    if (recomputed !== rev.regradeEvidenceHash) refuseValue(`regrade/${name}: its evidence hash does not match its own inputs`);
    out.push({ dir, revision: rev, regradeJsonSha256: sha256(text) });
  }
  out.forEach((x, i) => {
    if (x.revision.revision !== i + 1) refuseValue("regrade/ revisions are not consecutive from 001");
    const parent = x.revision.parent;
    const prev = out[i - 1];
    if (prev === undefined ? parent !== null : parent?.revision !== prev.revision.revision || parent.regradeJsonSha256 !== prev.regradeJsonSha256) refuseValue(`regrade/${String(i + 1).padStart(3, "0")}: its parent is not the revision before it`);
    if (prev !== undefined && prev.revision.status !== "pending") refuseValue(`regrade/${String(i + 1).padStart(3, "0")} follows revision ${prev.revision.revision}, which is ${prev.revision.status}`);
  });
  return out;
}

/** Writes one revision atomically: both files into a temporary directory, then one rename. */
export function writeRevision(recordDir: string, revision: RevisionFile, record: Record<string, unknown>): string {
  const root = join(recordDir, "regrade");
  mkdirSync(root, { recursive: true });
  const name = String(revision.revision).padStart(3, "0");
  const target = join(root, name);
  if (existsSync(target)) refuseValue(`regrade/${name} already exists`);
  const tmp = mkdtempSync(join(recordDir, ".regrade-tmp-"));
  writeFileSync(join(tmp, "regrade.json"), `${JSON.stringify(revision, null, 2)}\n`);
  writeFileSync(join(tmp, "record.regraded.json"), `${JSON.stringify({
    ...record,
    regrade: { revision: revision.revision, status: revision.status, verdict: revision.verdict, reasons: revision.reasons, candidates: revision.candidates, regradeEvidenceHash: revision.regradeEvidenceHash, originalVerdict: record.verdict },
  }, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}

/**
 * Only a replay with no hard failure reaches the judge, whatever a stored status says. Behind the status-bearing
 * evidence hash this is defence in depth: a relabelled revision is refused before it gets here.
 */
export function judgeable(g: Pick<Regraded, "verdict" | "hard">): string | null {
  if (g.verdict !== "PENDING_SEMANTIC" || g.hard.length > 0) return `the replayed run has hard failures (${g.hard.length}); it cannot be completed by a judge`;
  return null;
}

export interface RegradeRun {
  readonly written: string;
  readonly revision: RevisionFile;
}

/**
 * `--regrade`: the first regrade writes revision 001, pending or failed; with a judge result it completes the
 * latest pending revision, which must name the exact same evidence, and writes the next one. The original
 * record and packet are never written.
 */
export function runRegrade(recordDir: string, input: RegradeInput, judge: RegradeJudge | null, now: () => string): { readonly ok: true; readonly run: RegradeRun } | { readonly ok: false; readonly reason: string } {
  try {
    const revisions = readRevisions(recordDir);
    const r = regrade(input);
    if (!r.ok) return r;
    const g = r.result;
    const record = JSON.parse(input.recordBytes.toString("utf-8")) as Record<string, unknown>;
    const base = {
      candidates: g.candidates, regradeEvidenceHash: g.regradeEvidenceHash, originalRecordSha256: g.originalRecordSha256, packetSha256: g.packetSha256,
      manifest: g.manifest, stopRuleVersion: stopRuleFor(g.checkSet ?? 1), writeRuleVersion: WRITE_RULE_VERSION, guarantee: G1, limitation: OPAQUE_LIMIT, regradedAt: now(),
      ...(g.checkSet !== undefined ? { checkSet: g.checkSet } : {}),
    };
    if (judge === null) {
      if (revisions.length > 0) return { ok: false, reason: `already regraded (revision ${revisions.length}); complete a pending revision with --judge` };
      const revision: RevisionFile = { ...base, revision: 1, status: g.verdict === "FAIL" ? "fail" : "pending", verdict: g.verdict, reasons: g.reasons, parent: null, rulings: [], judgeSessionId: null, judgeObservedModel: null };
      return { ok: true, run: { written: writeRevision(recordDir, revision, record), revision } };
    }
    const latest = revisions.at(-1);
    if (!latest) return { ok: false, reason: "no pending revision to complete; run --regrade without --judge first" };
    if (judge.revision !== latest.revision.revision) return { ok: false, reason: `the judge result names revision ${judge.revision}, the latest is ${latest.revision.revision}` };
    if (latest.revision.status !== "pending") return { ok: false, reason: `revision ${latest.revision.revision} is ${latest.revision.status}, not pending` };
    // G2: the pending revision pinned every file it read; the evidence must be identical byte for byte.
    if (!same(latest.revision.manifest, g.manifest)) return { ok: false, reason: "a file the pending revision read has changed since" };
    if (latest.revision.regradeEvidenceHash !== g.regradeEvidenceHash) return { ok: false, reason: "the evidence differs from the pending revision's" };
    const blocked = judgeable(g);
    if (blocked !== null) return { ok: false, reason: blocked };
    const v = judgeVerdict(g, input.packetBytes.toString("utf-8"), judge);
    const judgedHash = evidenceHash({ originalRecordSha256: g.originalRecordSha256, packetSha256: g.packetSha256, manifest: g.manifest, candidates: g.candidates, stopRuleVersion: stopRuleFor(g.checkSet ?? 1), writeRuleVersion: WRITE_RULE_VERSION, guarantee: G2, status: "judged", checkSet: g.checkSet });
    const revision: RevisionFile = {
      ...base, guarantee: G2, regradeEvidenceHash: judgedHash, revision: latest.revision.revision + 1, status: "judged", verdict: v.verdict, reasons: v.reasons,
      parent: { revision: latest.revision.revision, regradeJsonSha256: latest.regradeJsonSha256 }, rulings: judge.unparsedRulings,
      judgeSessionId: judge.judgeSessionId, judgeObservedModel: judge.observedModel,
    };
    return { ok: true, run: { written: writeRevision(recordDir, revision, record), revision } };
  } catch (err) {
    if (err instanceof JudgeRefusal || err instanceof Refusal) return { ok: false, reason: err.message };
    throw err;
  }
}
