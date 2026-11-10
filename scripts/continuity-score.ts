/**
 * T-525: scoring and results for a recorded continuity experiment.
 *
 * The scorer is Codex through codex-claude-bridge, which is an MCP tool the
 * pen calls from its own session; a script cannot reach it. So this script
 * has three sub-commands, all namespaced by rubric version so a rubric change
 * never mixes grading rules or overwrites earlier scores:
 *   prepare <expDir>             scoring-request.rubric<v>.md beside every valid, unscored, evidence-complete
 *                                attempt; behavioural failures get a mechanical all-fail score instead
 *   record  <attemptDir> <json>  validate one reviewer verdict and store score.rubric<v>.json (never overwrites)
 *   report  <expDir>             aggregate the preregistered cells and write results-<date>-<verified build version>-rubric<v>.md
 *   compare <baseline> <candidate>  refuse a cross-arm comparison whose task material differs (ISS-1273); exit 1 when refused
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { homedir, userInfo, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TASKS, recordEligible, LAUNCH_POLICY, sanitize, publicationCheck, jsonShapePreserved, fixtureCredentialAllowlist, verifyAttemptDir, expectedCellKeys, qualifies, environmentSecrets, readPilot, type VerifiedRecord,
  INPUT_PATHS, TASK_MATERIAL, hashInputs, taskMaterial, driftedPaths } from "./continuity-lib.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SCRIPT_DIR, "..");
const FIXTURE_ROOT = join(PKG_ROOT, "test", "fixtures", "continuity");

export const CRITERIA = ["C1", "C2", "C3", "C4", "C5"] as const;
export type Criterion = (typeof CRITERIA)[number];
/** Frozen: the arm comparison reads C1/C2 at INITIAL, C3/C4/C5 at FINAL. */
export const COMPARISON_CHECKPOINT: Record<Criterion, "initial" | "final"> = { C1: "initial", C2: "initial", C3: "final", C4: "final", C5: "final" };

export interface CriterionScore { readonly pass: boolean; readonly evidence: string }
export interface Score {
  readonly rubricVersion: number;
  readonly task: string;
  readonly initial: Record<Criterion, CriterionScore>;
  readonly final: Record<Criterion, CriterionScore>;
  readonly flags?: readonly string[];
  readonly notes?: string;
  readonly scorer: { readonly provider: string; readonly observedModel: string; readonly sessionId?: string };
}

export type AttemptRecord = VerifiedRecord;

export const scoreFile = (v: string): string => `score.rubric${v}.json`;
export const requestFile = (v: string): string => `scoring-request.rubric${v}.md`;

export function rubricVersionOf(rubric: string): string {
  const v = /rubricVersion:\s*(\d+)/.exec(rubric)?.[1];
  if (!v) throw new Error("rubric.md carries no rubricVersion");
  return v;
}

/** A valid attempt that did not complete its ticket is a behavioural failure: scored mechanically, every criterion fails. */
export function isBehaviouralFailure(r: AttemptRecord): boolean {
  return r.completion !== "completed";
}

/** A record is only ever read through the shared verifier; evidenceComplete here is the re-verified value, never the record's own claim. */
export function readRecord(attemptDir: string): (AttemptRecord & { readonly verifiedEvidenceComplete: boolean; readonly verificationReason: string | null }) | null {
  const v = verifyAttemptDir(attemptDir);
  if (!v.record) return null;
  return { ...v.record, verifiedEvidenceComplete: v.evidenceComplete, verificationReason: v.reason };
}

/** One sanitising, publication-checked writer for every file the scorer puts under the public baseline. */
export function publishText(target: string, text: string, allowlist: readonly string[]): void {
  const s = sanitize(text, { workdir: "\0never", home: homedir(), user: userInfo().username, pkgRoot: PKG_ROOT, allowlist }).text;
  const verdict = publicationCheck(s, allowlist, { secrets: environmentSecrets(process.env) });
  if (!verdict.ok) throw new Error(`${basename(target)} would publish blocked content (${verdict.blocked.map((b) => `${b.label}: ${b.sample}`).join("; ")}); refusing the write`);
  // A document that parsed before must parse after: publicationCheck reads a corrupted artefact as clean.
  if (!jsonShapePreserved(text, s)) throw new Error(`${basename(target)}: sanitisation broke a document that parsed before; refusing the write`);
  writeFileSync(target, s);
}

export function attemptsOf(expDir: string): string[] {
  const out: string[] = [];
  if (!existsSync(expDir)) return out;
  for (const task of readdirSync(expDir)) {
    const td = join(expDir, task);
    if (!TASKS.includes(task as never)) continue;
    for (const rep of readdirSync(td)) for (const att of readdirSync(join(td, rep))) if (att.startsWith("attempt-")) out.push(join(td, rep, att));
  }
  return out.sort();
}

export function isScorable(attemptDir: string): boolean {
  const r = readRecord(attemptDir);
  return r !== null && r.validity === "valid" && r.verifiedEvidenceComplete;
}

/** A stored score for a behavioural failure must be exactly the mechanical all-fail result. */
export function isMechanicalFailureScore(score: Score): boolean {
  return score.scorer.provider === "mechanical" && CRITERIA.every((c) => score.initial[c].pass === false && score.final[c].pass === false);
}

/** Loads and fully validates a stored score for one attempt; null when absent, and a named reason when present but unacceptable. */
export function loadScore(attemptDir: string, record: AttemptRecord, rubricVersion: string): { readonly score: Score | null; readonly problem: string | null } {
  const sp = join(attemptDir, scoreFile(rubricVersion));
  if (!existsSync(sp)) return { score: null, problem: null };
  let score: Score;
  try { score = validateScore(JSON.parse(readFileSync(sp, "utf-8")), { rubricVersion, task: record.task }); } catch (e) { return { score: null, problem: `stored score rejected: ${(e as Error).message}` }; }
  if (isBehaviouralFailure(record) && !isMechanicalFailureScore(score)) return { score: null, problem: "stored score for a behavioural failure is not the mechanical all-fail result" };
  return { score, problem: null };
}

export function mechanicalFailureScore(r: AttemptRecord, rubricVersion: string): Score {
  const all = (): Record<Criterion, CriterionScore> => Object.fromEntries(CRITERIA.map((c) => [c, { pass: false, evidence: `behavioural failure: ${r.completion} (${r.completionReason})` }])) as Record<Criterion, CriterionScore>;
  return { rubricVersion: Number(rubricVersion), task: r.task, initial: all(), final: all(), flags: ["behavioural-failure"], notes: "scored mechanically under the frozen aggregation rule; no reviewer verdict applies", scorer: { provider: "mechanical", observedModel: "none" } };
}

export function scoringRequest(attemptDir: string, rubric: string, fixtureMap: string): string {
  const read = (f: string): string => (existsSync(join(attemptDir, f)) ? readFileSync(join(attemptDir, f), "utf-8") : `(absent: ${f})`);
  const record = readRecord(attemptDir);
  if (!record) throw new Error(`${attemptDir}: no completed record`);
  const prompt = /```\n(You are scoring[\s\S]*?)\n```/.exec(rubric)?.[1] ?? "";
  return [
    `# Scoring request: arm ${record.arm}, task ${record.task}, repeat ${record.repeat}, ${basename(attemptDir)}`, "",
    `Completion: ${record.completion} (${record.completionReason}). Validity: ${record.validity}.`, "",
    prompt, "",
    "## fixture-map.json (label to id)", fixtureMap,
    "## rubric.md", rubric,
    "## task.json (the ticket as materialised, variant applied)", read("task.json"),
    "## plan.initial.md (INITIAL checkpoint)", read("plan.initial.md"),
    "## plan.md (FINAL checkpoint)", read("plan.md"),
    "## plan-context.md", read("plan-context.md"),
    "## evidence.jsonl (main-session tool calls; beforeFirstPlanWritten marks the INITIAL window)", read("evidence.jsonl"),
    "## source.diff", read("source.diff"),
    "## worktree.status", read("worktree.status"),
    "## ledger.changes.json (before/after; added records carry their content, changed records their fields)", read("ledger.changes.json"),
    "## handover.md", read("handover.md"),
    "## reports.json (guide report payloads)", read("reports.json"),
  ].join("\n");
}

/** Full runtime validation of an imported verdict: booleans, evidence strings, all five criteria at both checkpoints, the task, the scorer. */
export function validateScore(raw: unknown, expected: { rubricVersion: string; task: string }): Score {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("score must be a JSON object");
  const s = raw as Record<string, unknown>;
  if (String(s.rubricVersion) !== expected.rubricVersion) throw new Error(`score rubricVersion ${String(s.rubricVersion)} != rubric ${expected.rubricVersion}`);
  if (s.task !== expected.task) throw new Error(`score task ${String(s.task)} != attempt task ${expected.task}`);
  const checkpoint = (name: "initial" | "final"): Record<Criterion, CriterionScore> => {
    const cp = s[name];
    if (!cp || typeof cp !== "object") throw new Error(`score.${name} missing`);
    const out = {} as Record<Criterion, CriterionScore>;
    for (const c of CRITERIA) {
      const v = (cp as Record<string, unknown>)[c];
      if (!v || typeof v !== "object") throw new Error(`score.${name}.${c} missing`);
      const { pass, evidence } = v as Record<string, unknown>;
      if (typeof pass !== "boolean") throw new Error(`score.${name}.${c}.pass must be a boolean, got ${JSON.stringify(pass)}`);
      if (typeof evidence !== "string") throw new Error(`score.${name}.${c}.evidence must be a string`);
      out[c] = { pass, evidence };
    }
    return out;
  };
  const scorer = s.scorer as Record<string, unknown> | undefined;
  if (!scorer || typeof scorer.provider !== "string" || typeof scorer.observedModel !== "string" || !scorer.observedModel) throw new Error("score.scorer.provider and score.scorer.observedModel are required (disclose the model that actually ran)");
  if (s.flags !== undefined && (!Array.isArray(s.flags) || !s.flags.every((f) => typeof f === "string"))) throw new Error("score.flags must be a string array");
  if (s.notes !== undefined && typeof s.notes !== "string") throw new Error("score.notes must be a string");
  return { rubricVersion: Number(expected.rubricVersion), task: expected.task, initial: checkpoint("initial"), final: checkpoint("final"), flags: s.flags as string[] | undefined, notes: s.notes as string | undefined, scorer: { provider: scorer.provider, observedModel: scorer.observedModel, sessionId: typeof scorer.sessionId === "string" ? scorer.sessionId : undefined } };
}

/** Experiment identity as the checksum-verified attempt manifest records it; the report displays these, never experiment.json's claims. */
export interface Provenance { readonly arm: number; readonly model: string; readonly effort: string; readonly storybloqVersion: string; readonly isolation: string; readonly ownerExceptionId: string | null }
export interface Observation { readonly task: string; readonly repeat: number; readonly attemptDir: string; readonly record: AttemptRecord; readonly score: Score | null; readonly problem: string | null; readonly provenance: Provenance }
const provenanceKey = (p: Provenance): string => JSON.stringify([p.arm, p.model, p.effort, p.storybloqVersion, p.isolation, p.ownerExceptionId]);
export interface CriterionCount { initialPass: number; finalPass: number; scored: number; observations: number; comparisonPass: number }
export type Aggregate = Record<string, Record<Criterion, CriterionCount>>;

/** Denominators are counted observations (one per satisfied cell), never the number of scores present. */
export function aggregate(observations: readonly Observation[]): Aggregate {
  const out: Aggregate = {};
  for (const task of TASKS) {
    const rows = observations.filter((s) => s.task === task);
    const row = {} as Record<Criterion, CriterionCount>;
    for (const c of CRITERIA) {
      const scored = rows.filter((r) => r.score);
      const initialPass = scored.filter((r) => r.score!.initial[c].pass).length;
      const finalPass = scored.filter((r) => r.score!.final[c].pass).length;
      row[c] = { initialPass, finalPass, scored: scored.length, observations: rows.length, comparisonPass: COMPARISON_CHECKPOINT[c] === "initial" ? initialPass : finalPass };
    }
    out[task] = row;
  }
  return out;
}

export interface ExperimentFile {
  readonly experimentHash: string; readonly arm: number; readonly model: string; readonly effort: string; readonly isolation: string;
  readonly ownerException: { id: string } | null; readonly build?: { storybloqVersion?: string };
  readonly cells: readonly { task: string; repeat: number; satisfied: boolean; evidenceComplete: boolean; attempt: string | null }[];
  readonly qualification: { qualifying: boolean; reason: string; shortCells: string[]; unpublishedCells?: string[] };
}

/**
 * The observations the report counts: exactly the satisfied attempt experiment.json names per preregistered cell.
 * Each is re-verified (record hash, manifest, required artefacts, experiment identity, cell identity, validity);
 * a cell whose named attempt fails verification is reported as a failure, never silently dropped.
 */
export function selectObservations(expDir: string, exp: ExperimentFile, rubricVersion: string): { readonly observations: Observation[]; readonly failures: string[] } {
  const observations: Observation[] = [];
  const failures: string[] = [];
  // experiment.json is data written by an earlier run: its cell list must be exactly the preregistered matrix.
  const keys = (Array.isArray(exp.cells) ? exp.cells : []).map((c) => `${c.task}#${c.repeat}`);
  const expected = expectedCellKeys();
  const seen = new Set<string>();
  for (const k of keys) { if (seen.has(k)) failures.push(`${k}: listed twice in experiment.json`); seen.add(k); if (!expected.includes(k)) failures.push(`${k}: not a preregistered cell`); }
  for (const k of expected) if (!seen.has(k)) failures.push(`${k}: absent from experiment.json`);
  if (!Array.isArray(exp.cells)) return { observations, failures };
  for (const cell of exp.cells) {
    if (!cell.satisfied || !cell.attempt) continue;
    const key = `${cell.task}#${cell.repeat}`;
    const dir = join(expDir, cell.task, `repeat-${cell.repeat}`, cell.attempt);
    const record = readRecord(dir);
    if (!record) { failures.push(`${key}: ${verifyAttemptDir(dir).reason ?? "unverifiable"}`); continue; }
    if (record.validity !== "valid") { failures.push(`${key}: named attempt is ${record.validity}`); continue; }
    if (record.experimentHash !== exp.experimentHash) { failures.push(`${key}: attempt belongs to experiment ${record.experimentHash.slice(0, 12)}`); continue; }
    if (!recordEligible(record)) { failures.push(`${key}: attempt was not captured under launch policy ${LAUNCH_POLICY}`); continue; }
    if (record.task !== cell.task || record.repeat !== cell.repeat) { failures.push(`${key}: attempt records ${record.task}#${record.repeat}`); continue; }
    if (!record.verifiedEvidenceComplete) { failures.push(`${key}: ${record.verificationReason ?? "evidence incomplete"}`); continue; }
    // Isolation and owner-exception provenance come from the checksum-verified manifest, never from experiment.json.
    let manifest: { arm?: unknown; model?: unknown; effort?: unknown; isolation?: unknown; ownerException?: { id?: unknown } | null; build?: { storybloqVersion?: unknown } } = {};
    try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as typeof manifest; } catch { failures.push(`${key}: manifest.json unreadable`); continue; }
    const ownerExceptionId = manifest.ownerException && typeof manifest.ownerException.id === "string" ? manifest.ownerException.id : null;
    const complete = record.requiredArtefacts.includes("manifest.json") && (manifest.isolation === "fresh" || manifest.isolation === "shared")
      && typeof manifest.arm === "number" && typeof manifest.model === "string" && typeof manifest.effort === "string" && typeof manifest.build?.storybloqVersion === "string";
    if (!complete) { failures.push(`${key}: manifest carries no verified experiment identity (arm, model, effort, build version, isolation)`); continue; }
    const provenance: Provenance = { arm: manifest.arm as number, model: manifest.model as string, effort: manifest.effort as string, storybloqVersion: manifest.build!.storybloqVersion as string, isolation: manifest.isolation as string, ownerExceptionId };
    const claimed: Provenance = { arm: exp.arm, model: exp.model, effort: exp.effort, storybloqVersion: exp.build?.storybloqVersion ?? "", isolation: exp.isolation, ownerExceptionId: exp.ownerException?.id ?? null };
    const disagreements = (Object.keys(provenance) as (keyof Provenance)[]).filter((k) => provenance[k] !== claimed[k]).map((k) => `${k}: manifest ${String(provenance[k] ?? "none")}, experiment.json ${String(claimed[k] ?? "none")}`);
    if (disagreements.length) { failures.push(`${key}: experiment identity disagrees (${disagreements.join("; ")})`); continue; }
    const { score, problem } = loadScore(dir, record, rubricVersion);
    observations.push({ task: cell.task, repeat: cell.repeat, attemptDir: dir, record, score, problem, provenance });
  }
  return { observations, failures };
}

/** The experiment folder an observation sits in: <exp>/<task>/repeat-<n>/<attempt>. */
const experimentDirOf = (o: Observation): string => dirname(dirname(dirname(o.attemptDir)));

/**
 * Qualification recomputed from the verified observations, never read back from the saved flag. ISS-1486 D9: the
 * arm's published pilot is read with the runner's own reader and is a required input; without an experiment
 * folder (given, or the one the observations sit in) there is no pilot, so nothing qualifies.
 */
export function recomputeQualification(exp: ExperimentFile, observations: readonly Observation[], expDir?: string): ReturnType<typeof qualifies> {
  const dir = expDir ?? (observations[0] ? experimentDirOf(observations[0]) : null);
  const pilot = dir === null ? { ok: false as const, reason: "no experiment folder to read the pilot from" } : readPilot(dir, { experiment: exp.experimentHash, arm: exp.arm });
  const have = new Set(observations.map((o) => `${o.task}#${o.repeat}`));
  const cells = expectedCellKeys().map((k) => { const [task, rep] = k.split("#"); return { task: task ?? "", repeat: Number(rep), satisfied: have.has(k), evidenceComplete: have.has(k) }; });
  // Provenance is read from the verified observations (all agree with each other and with experiment.json by construction, see selectObservations).
  const p = verifiedProvenance(observations);
  if (!p) return { qualifying: false, shortCells: expectedCellKeys().filter((k) => !have.has(k)), unpublishedCells: [], reason: observations.length === 0 ? "no verified observations" : "observations disagree on experiment identity" };
  return qualifies({ cells, isolation: p.isolation === "fresh" ? "fresh" : "shared", pilot });
}

/** The one experiment identity every verified observation carries, or null when there are none or they disagree. */
export function verifiedProvenance(observations: readonly Observation[]): Provenance | null {
  if (observations.length === 0) return null;
  const keys = new Set(observations.map((o) => provenanceKey(o.provenance)));
  return keys.size === 1 ? observations[0]!.provenance : null;
}

// --- ISS-1273: task material across arms --------------------------------------

/** An experiment's task material, or why it cannot be stated. `source` says where the value came from. */
export type TaskMaterialResult =
  | { readonly ok: true; readonly sha256: string; readonly paths: Record<string, string>; readonly source: string }
  | { readonly ok: false; readonly problem: string };

const TASK_MATERIAL_LABELS: readonly string[] = TASK_MATERIAL.map((m) => `test/fixtures/continuity/${m}`);

/** A recorded hash is usable only as a full lowercase SHA-256; checksums prove the file, not that its fields are hashes. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
const isSha256 = (v: unknown): v is string => typeof v === "string" && SHA256_HEX.test(v);

interface MaterialManifest { taskMaterialHash?: unknown; taskMaterialHashes?: unknown; inputTreeHash?: unknown; build?: { workspaceHead?: unknown } }

function completePathMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v).sort();
  const want = [...TASK_MATERIAL_LABELS].sort();
  return keys.length === want.length && keys.every((k, i) => k === want[i] && isSha256((v as Record<string, unknown>)[k]));
}

/**
 * Legacy captures (arm 1) recorded no task material. Their preflight refused a dirty input tree, so HEAD is what preflight
 * hashed: re-derive the whole input tree at the verified head and accept it only when it reproduces the recorded
 * inputTreeHash, then take the task material from that same tree. That is preflight provenance, not proof that nothing
 * drifted during the capture (ISS-1274 is what makes that visible for new captures).
 */
function taskMaterialFromGit(head: string, recordedInputTreeHash: string, pkgRoot: string): TaskMaterialResult {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  const git = (args: string[], cwd: string): Buffer => execFileSync("git", args, { cwd, env, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
  const out = mkdtempSync(join(tmpdir(), "continuity-taskmaterial-"));
  try {
    const top = git(["rev-parse", "--show-toplevel"], pkgRoot).toString().trim();
    const prefix = git(["rev-parse", "--show-prefix"], pkgRoot).toString().trim();
    git(["cat-file", "-e", `${head}^{commit}`], top);
    const present = INPUT_PATHS.map((p) => `${prefix}${p}`).filter((p) => { try { git(["cat-file", "-e", `${head}:${p}`], top); return true; } catch { return false; } });
    if (present.length) execFileSync("tar", ["-x", "-C", out], { input: git(["archive", "--format=tar", head, "--", ...present], top), maxBuffer: 1 << 30 });
    const root = join(out, prefix);
    const ith = hashInputs(INPUT_PATHS.map((p) => ({ label: p, path: join(root, p) })));
    if (ith !== recordedInputTreeHash) return { ok: false, problem: `git at ${head.slice(0, 12)} does not reproduce the recorded inputTreeHash (${ith.slice(0, 12)} vs ${recordedInputTreeHash.slice(0, 12)})` };
    const tm = taskMaterial(root);
    return { ok: true, sha256: tm.sha256, paths: tm.paths, source: `git ${head.slice(0, 12)}, matches recorded inputTreeHash; preflight provenance` };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    return { ok: false, problem: `task material not recorded and not derivable from git at ${head.slice(0, 12)}: ${msg}` };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The task material every verified observation's checksum-verified manifest agrees on; experiment.json is never read. */
export function taskMaterialOf(observations: readonly Observation[], opts: { readonly pkgRoot?: string } = {}): TaskMaterialResult {
  if (observations.length === 0) return { ok: false, problem: "no verified observations" };
  const manifests: MaterialManifest[] = [];
  for (const o of observations) {
    try { manifests.push(JSON.parse(readFileSync(join(o.attemptDir, "manifest.json"), "utf-8")) as MaterialManifest); } catch { return { ok: false, problem: `${o.task}#${o.repeat}: manifest.json unreadable` }; }
  }
  const carrying = manifests.filter((m) => m.taskMaterialHash !== undefined || m.taskMaterialHashes !== undefined).length;
  if (carrying > 0 && carrying < manifests.length) return { ok: false, problem: "some observations record task material and some do not" };
  if (carrying === manifests.length) {
    for (const [i, m] of manifests.entries()) {
      if (!isSha256(m.taskMaterialHash) || !completePathMap(m.taskMaterialHashes)) return { ok: false, problem: `${observations[i]!.task}#${observations[i]!.repeat}: per-path task material is incomplete or not SHA-256` };
    }
    const first = manifests[0]!;
    const key = (m: MaterialManifest): string => JSON.stringify([m.taskMaterialHash, TASK_MATERIAL_LABELS.map((l) => (m.taskMaterialHashes as Record<string, string>)[l])]);
    if (manifests.some((m) => key(m) !== key(first))) return { ok: false, problem: "observations disagree on task material" };
    return { ok: true, sha256: first.taskMaterialHash as string, paths: { ...(first.taskMaterialHashes as Record<string, string>) }, source: "manifest" };
  }
  const heads = new Set(manifests.map((m) => JSON.stringify([m.build?.workspaceHead, m.inputTreeHash])));
  const m0 = manifests[0]!;
  if (heads.size !== 1 || typeof m0.build?.workspaceHead !== "string" || !isSha256(m0.inputTreeHash)) return { ok: false, problem: "observations disagree on workspaceHead or inputTreeHash, or do not record them" };
  return taskMaterialFromGit(m0.build.workspaceHead, m0.inputTreeHash, opts.pkgRoot ?? PKG_ROOT);
}

/** An unverifiable cell can hide differing material, so any verification failure makes the whole side UNVERIFIED. */
export function taskMaterialFor(observations: readonly Observation[], failures: readonly string[], opts: { readonly pkgRoot?: string } = {}): TaskMaterialResult {
  if (failures.length) return { ok: false, problem: `${failures.length} verification failure(s): ${failures.join("; ")}` };
  return taskMaterialOf(observations, opts);
}

export function experimentTaskMaterial(expDir: string, rubricVersion: string, opts: { readonly pkgRoot?: string } = {}): TaskMaterialResult {
  let exp: ExperimentFile;
  try { exp = JSON.parse(readFileSync(join(expDir, "experiment.json"), "utf-8")) as ExperimentFile; } catch { return { ok: false, problem: `${expDir}: experiment.json unreadable` }; }
  const { observations, failures } = selectObservations(expDir, exp, rubricVersion);
  return taskMaterialFor(observations, failures, opts);
}

/** The cross-arm precondition: the same rolled value and the same value at every path, else refused with each differing path named. */
export function compareTaskMaterial(baseline: TaskMaterialResult, candidate: TaskMaterialResult): { readonly ok: boolean; readonly differing: { label: string; baseline: string; candidate: string }[]; readonly problem: string | null } {
  if (!baseline.ok) return { ok: false, differing: [], problem: `baseline: ${baseline.problem}` };
  if (!candidate.ok) return { ok: false, differing: [], problem: `candidate: ${candidate.problem}` };
  const differing = driftedPaths(baseline.paths, candidate.paths).map((label) => ({ label, baseline: baseline.paths[label] ?? "<absent>", candidate: candidate.paths[label] ?? "<absent>" }));
  return { ok: baseline.sha256 === candidate.sha256 && differing.length === 0, differing, problem: null };
}

export function renderReport(exp: ExperimentFile, agg: Aggregate, observations: readonly Observation[], failures: readonly string[], rubricVersion: string, material?: TaskMaterialResult, expDir?: string): string {
  const p = verifiedProvenance(observations);
  const q = recomputeQualification(exp, observations, expDir);
  const saved = exp.qualification;
  const pending = observations.filter((o) => !o.score);
  const scoringComplete = pending.length === 0 && observations.length === expectedCellKeys().length && failures.length === 0;
  const citable = scoringComplete && q.qualifying;
  const lines = [
    `# Continuity results: ${p ? `arm ${p.arm}, storybloq ${p.storybloqVersion}` : "experiment identity UNVERIFIED"}, rubric v${rubricVersion}`, "",
    `Experiment ${exp.experimentHash}. Capture (recomputed from verified observations): **${q.qualifying ? "QUALIFYING" : "INCOMPLETE"}** (${q.reason})${saved && saved.qualifying !== q.qualifying ? ` [saved flag said ${saved.qualifying ? "QUALIFYING" : "INCOMPLETE"}: ${saved.reason}]` : ""}.${material ? ` Task material: ${material.ok ? `${material.sha256} (${material.source})` : `UNVERIFIED (${material.problem})`}.` : ""} Evidence verification: **${failures.length === 0 ? "OK" : `FAILED (${failures.length})`}**. Scoring: **${scoringComplete ? "COMPLETE" : `INCOMPLETE (${pending.length} observation(s) unscored${failures.length ? `, ${failures.length} cell(s) unverifiable` : ""})`}**. ${p ? `Isolation: ${p.isolation}${p.ownerExceptionId ? ` (owner exception ${p.ownerExceptionId})` : ""}. Model ${p.model}, effort ${p.effort} (all from verified attempt manifests).` : "Isolation, model and effort not shown: no verified observations agree on them."}`, "",
    citable ? "This file is citable as the release baseline." : "This file is NOT citable as a baseline until capture qualifies, every counted observation re-verifies, and every one is scored.", "",
    ...(failures.length ? ["## Verification failures", "", ...failures.map((f) => `- ${f}`), ""] : []),
    ...(pending.some((p) => p.problem) ? ["## Rejected stored scores", "", ...pending.filter((p) => p.problem).map((p) => `- ${p.task}#${p.repeat}: ${p.problem}`), ""] : []),
    "## Pass counts per task (initial/final passes over counted observations; a task passes a criterion at 2 of 3)", "",
    "| Task | C1 | C2 | C3 | C4 | C5 | scored/observations |", "|---|---|---|---|---|---|---|",
  ];
  for (const task of TASKS) {
    const a = agg[task];
    if (!a) continue;
    lines.push(`| ${task} | ${CRITERIA.map((c) => `${a[c].initialPass}/${a[c].finalPass}`).join(" | ")} | ${a.C1.scored}/${a.C1.observations} |`);
  }
  lines.push("", "Comparison checkpoint per criterion: C1, C2 at INITIAL; C3, C4, C5 at FINAL. Unscored observations count in the denominator and never as a pass.", "", "## Counted observations", "", "| Cell | Attempt | Completion | PLAN entry ctx | Before plan ctx | Cost USD | Wall s | Main models | Score |", "|---|---|---|---|---|---|---|---|---|");
  let cost = 0;
  for (const o of observations) {
    const u = existsSync(join(o.attemptDir, "usage.json")) ? (JSON.parse(readFileSync(join(o.attemptDir, "usage.json"), "utf-8")) as Record<string, unknown>) : {};
    const c = typeof u.totalCostUsd === "number" ? u.totalCostUsd : 0; cost += c;
    const models = existsSync(join(o.attemptDir, "manifest.json")) ? (((JSON.parse(readFileSync(join(o.attemptDir, "manifest.json"), "utf-8")) as { post?: { mainModels?: string[] } }).post?.mainModels) ?? []).join(" ") : "";
    lines.push(`| ${o.task}#${o.repeat} | ${basename(o.attemptDir)} | ${o.record.completion} | ${u.planEntryContext ?? ""} | ${u.beforePlanWrittenContext ?? ""} | ${c.toFixed(2)} | ${Math.round(o.record.wallMs / 1000)} | ${models} | ${o.score ? `${o.score.scorer.provider}: ${o.score.scorer.observedModel}` : "pending"} |`);
  }
  const shorts = [...q.shortCells, ...q.unpublishedCells];
  lines.push("", `Recorded spend over counted observations: $${cost.toFixed(2)}. Cells without a counted observation: ${shorts.length ? shorts.join(", ") : "none"}.`, "", "Method: scripted headless claude -p (rubric.md); scorer Codex via codex-claude-bridge, observed model per observation above; behavioural failures scored mechanically.");
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const [cmd, a1 = "", a2 = ""] = process.argv.slice(2);
  const rubric = readFileSync(join(FIXTURE_ROOT, "rubric.md"), "utf-8");
  const rubricVersion = rubricVersionOf(rubric);
  const allowlist = fixtureCredentialAllowlist(join(FIXTURE_ROOT, "core"));
  if (cmd === "prepare") {
    let requests = 0; let mechanical = 0;
    for (const d of attemptsOf(a1)) {
      const r = readRecord(d);
      if (!r || r.validity !== "valid" || !r.verifiedEvidenceComplete || existsSync(join(d, scoreFile(rubricVersion)))) continue;
      if (isBehaviouralFailure(r)) { publishText(join(d, scoreFile(rubricVersion)), `${JSON.stringify(mechanicalFailureScore(r, rubricVersion), null, 2)}\n`, allowlist); mechanical++; continue; }
      publishText(join(d, requestFile(rubricVersion)), scoringRequest(d, rubric, readFileSync(join(FIXTURE_ROOT, "fixture-map.json"), "utf-8")), allowlist);
      requests++;
    }
    process.stdout.write(`${requests} scoring request(s) written, ${mechanical} behavioural failure(s) scored mechanically (rubric v${rubricVersion})\n`);
  } else if (cmd === "record") {
    const r = readRecord(a1);
    if (!r) throw new Error(`${a1}: no completed record`);
    if (!isScorable(a1)) throw new Error(`${a1}: not scorable (validity ${r.validity}, evidence ${r.verificationReason ?? "complete"})`);
    if (isBehaviouralFailure(r)) throw new Error(`${a1}: behavioural failure (${r.completion}); it is scored mechanically by prepare, a reviewer verdict is refused`);
    const target = join(a1, scoreFile(rubricVersion));
    if (existsSync(target)) throw new Error(`${target} exists; scores are immutable, bump the rubric version to rescore`);
    const score = validateScore(JSON.parse(a2), { rubricVersion, task: r.task });
    publishText(target, `${JSON.stringify(score, null, 2)}\n`, allowlist);
    process.stdout.write(`recorded ${target}\n`);
  } else if (cmd === "report") {
    const exp = JSON.parse(readFileSync(join(a1, "experiment.json"), "utf-8")) as ExperimentFile;
    const { observations, failures } = selectObservations(a1, exp, rubricVersion);
    const agg = aggregate(observations);
    // The file name carries the build version only when the verified manifests agree on it; experiment.json's claim never names a report.
    const ver = verifiedProvenance(observations)?.storybloqVersion.replace(/[^0-9.]/g, "") ?? "unverified";
    const out = join(a1, `results-${new Date().toISOString().slice(0, 10)}-${ver}-rubric${rubricVersion}.md`);
    publishText(out, renderReport(exp, agg, observations, failures, rubricVersion, taskMaterialFor(observations, failures), a1), allowlist);
    process.stdout.write(`${out}\n`);
  } else if (cmd === "compare") {
    const base = experimentTaskMaterial(a1, rubricVersion);
    const cand = experimentTaskMaterial(a2, rubricVersion);
    const r = compareTaskMaterial(base, cand);
    if (r.ok && base.ok && cand.ok) {
      process.stdout.write(`task material identical: ${base.sha256} (${base.source}; ${cand.source})\n`);
    } else {
      process.stdout.write(`REFUSED: ${r.problem ?? "task material differs:"}\n${r.differing.map((d) => `  ${d.label}: baseline ${d.baseline}, candidate ${d.candidate}`).join("\n")}${r.differing.length ? "\n" : ""}`);
      process.exitCode = 1;
    }
  } else {
    throw new Error("usage: continuity-score.ts prepare <expDir> | record <attemptDir> <json> | report <expDir> | compare <baselineExpDir> <candidateExpDir>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { process.stderr.write(`${(err as Error).stack ?? String(err)}\n`); process.exit(1); });
}
