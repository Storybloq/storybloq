/**
 * The cross-check: a finished onboarding eval run re-read under another check set, read-only.
 *
 * The regrade answers "is this run what it says it was" and refuses any check set but the record's own. The
 * cross-check answers a different question: what the same stored turns would have failed under another check set's
 * rules, so an attempt graded under one set can serve as the control for the next. It replays the stored raw
 * transcripts through the runner's own flow twice, under the record's check set and under the target, and reports
 * the difference per failure kind (needs-review and judge lines apart). It opens every source file read-only, hashes
 * them before and after, and writes nothing anywhere; its report goes to stdout.
 *
 *   tsx scripts/onboarding-eval-crosscheck.ts --target-check-set 4 <runDir>...
 *
 * where each run directory holds `record/` (record.json, grading-packet.json) and `raw/` (the turn transcripts).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeTurn, codexTurn, KNOWN_CHECK_SETS, stopRuleFor, treeDigest, writeRuleFor, type EvalTurn, type RuntimeExclusion } from "./onboarding-eval-lib.js";
import { parseStream, sha256 } from "./continuity-lib.js";
import { driveFlow, finishDrive, inspectAfter, newDriveState, type DriveState, type StoryReader, type Variant } from "./onboarding-eval-drive.js";
import { regradeInputFrom } from "./onboarding-eval-run.js";
import { turnFile } from "./onboarding-eval-regrade.js";

export interface CrosscheckReport {
  readonly source: string;
  readonly recordSha256: string;
  readonly packetSha256: string;
  readonly sourceCheckSet: number;
  readonly targetCheckSet: number;
  readonly rules: { readonly source: { readonly stop: string; readonly write: string }; readonly target: { readonly stop: string; readonly write: string } };
  /** Failures the target adds or removes, by failure kind; needs-review (the run's unparsed shell) is reported apart. */
  readonly added: Record<string, string[]>;
  readonly removed: Record<string, string[]>;
  readonly needsReview: { readonly added: string[]; readonly removed: string[] };
  /** The judge lines the target adds or removes. */
  readonly judgeLines: { readonly added: string[]; readonly removed: string[] };
  readonly sourceVerdict: "FAIL" | "PENDING_SEMANTIC";
  readonly targetVerdict: "FAIL" | "PENDING_SEMANTIC";
  /** Whether the replay under the record's own check set reproduces the record's failures. */
  readonly sourceMatchesRecord: boolean;
  /** Every source file hashed before and after: true when none changed. */
  readonly sourceUnchanged: boolean;
}

interface Replayed { readonly failures: readonly string[]; readonly kinds: readonly string[]; readonly semanticLines: readonly string[] }

/**
 * Every entry under `dir` by relative path, never following a link (lib `treeDigest`): a file maps to its sha256, a
 * link to its target as written, so a dangling link, a link to an ancestor or a link out of the run is hashed as a
 * link and nothing outside `dir` is read.
 */
export function hashTree(dir: string): Record<string, string> {
  return treeDigest(dir);
}

function parseTurn(client: string, raw: string, checkSet: number): EvalTurn {
  if (client === "claude") return claudeTurn(parseStream(raw).events, checkSet);
  const lines: Record<string, unknown>[] = [];
  for (const l of raw.split("\n")) { try { const v = JSON.parse(l); if (v && typeof v === "object") lines.push(v); } catch { /* non-JSON line */ } }
  return codexTurn(lines, checkSet);
}

/** The stored run replayed through the runner's flow under one check set: its failures, their kinds, its judge lines. */
function replay(recordDir: string, rawDir: string, checkSet: number): Replayed {
  const input = regradeInputFrom(recordDir, rawDir);
  const record = JSON.parse(input.recordBytes.toString("utf-8")) as {
    client: string; variant: Variant; treeExclusion: RuntimeExclusion; failures: string[];
    turns: { label: string; models?: string[]; exitCode: number | null; infraFailure: string | null; treeChanges: string[] }[];
  };
  const state: DriveState = newDriveState(checkSet);
  const flow = driveFlow({ variant: record.variant, firstPrompt: input.fixture.firstPrompt, discoveryPrompt: input.fixture.discoveryPrompt, afterPackage: input.fixture.afterPackage, exclusion: record.treeExclusion }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const rec = record.turns[n];
    if (rec === undefined || rec.label !== step.value.label) throw new Error(`turn ${n}: the flow asks for ${step.value.label}, the record has ${rec?.label ?? "no turn"}`);
    const file = turnFile(n, rec.label);
    const turn = { ...parseTurn(record.client, input.readRaw(`${file}.jsonl`).toString("utf-8"), checkSet), models: rec.models ?? [] };
    // The stderr path as the record wrote it, so an infrastructure failure compares equal across check sets.
    const head = rec.infraFailure === null ? null : `${rec.label}: infrastructure: ${rec.infraFailure} (stderr in `;
    const stored = head === null ? undefined : record.failures.find((f) => f.startsWith(head) && f.endsWith(".stderr.txt)"));
    const stderrPath = stored === undefined || head === null ? "" : stored.slice(head.length, -1);
    const changes = rec.treeChanges;
    step = flow.next({ turn, exitCode: rec.exitCode, infraFailure: rec.infraFailure, stderrPath, treeChanges: () => changes });
    n++;
  }
  const evidence = finishDrive(state, input.reviewLine);
  const semanticLines = input.semanticLines(state.reviewSkipped, state.turns, record.treeExclusion, input.fixture.afterPackage.some((x) => x.label === "adjust"), checkSet, evidence.reviewLines, evidence.judgeLines ?? []);
  const bytes = input.story;
  const story: StoryReader = bytes === null ? { exists: () => false, read: () => "", list: () => [] } : { exists: bytes.exists, read: (rel) => bytes.readBytes(rel).toString("utf-8"), list: bytes.list };
  inspectAfter(state, story, input.fixture.rubric, input.fixture.beforeConfig, record.variant);
  return { failures: [...state.failures], kinds: state.sources.map((x) => x.kind), semanticLines };
}

/** `after` minus `before` as multisets, in `after`'s order. */
function minus(after: readonly string[], before: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of before) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of after) {
    const k = left.get(x) ?? 0;
    if (k > 0) left.set(x, k - 1);
    else out.push(x);
  }
  return out;
}

/** Failures by kind, needs-review (`unparsed`) left out. */
function byKind(r: Replayed): Map<string, string[]> {
  const out = new Map<string, string[]>();
  r.failures.forEach((f, i) => {
    const kind = r.kinds[i]!;
    if (kind === "unparsed") return;
    out.set(kind, [...(out.get(kind) ?? []), f]);
  });
  return out;
}

/** One stored run (record and raw directories) re-read under `target`. Reads only; the source hashes are checked after. */
export function crosscheckPaths(recordDir: string, rawDir: string, target: number): CrosscheckReport {
  const before = { record: hashTree(recordDir), raw: hashTree(rawDir) };
  const recordBytes = readFileSync(join(recordDir, "record.json"));
  const packetBytes = readFileSync(join(recordDir, "grading-packet.json"));
  const record = JSON.parse(recordBytes.toString("utf-8")) as { checkSetVersion?: unknown; failures?: unknown };
  const source = record.checkSetVersion === undefined ? 1 : Number(record.checkSetVersion);
  for (const cs of [source, target]) if (!KNOWN_CHECK_SETS.includes(cs)) throw new Error(`check set ${cs} is not one this build knows`);
  // The fixture inputs (rubric projection, owner script) are the source's; they are the same only on the same side of check set 2.
  if ((source >= 2) !== (target >= 2)) throw new Error(`check sets ${source} and ${target} read different fixture inputs, so the stored turns cannot be replayed under both`);

  const src = replay(recordDir, rawDir, source);
  const tgt = replay(recordDir, rawDir, target);
  const srcKinds = byKind(src);
  const tgtKinds = byKind(tgt);
  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  for (const kind of [...new Set([...srcKinds.keys(), ...tgtKinds.keys()])].sort()) {
    const a = minus(tgtKinds.get(kind) ?? [], srcKinds.get(kind) ?? []);
    const r = minus(srcKinds.get(kind) ?? [], tgtKinds.get(kind) ?? []);
    if (a.length > 0) added[kind] = a;
    if (r.length > 0) removed[kind] = r;
  }
  const unparsed = (x: Replayed): string[] => x.failures.filter((_, i) => x.kinds[i] === "unparsed");
  const after = { record: hashTree(recordDir), raw: hashTree(rawDir) };
  return {
    source: resolve(recordDir, ".."),
    recordSha256: sha256(recordBytes),
    packetSha256: sha256(packetBytes),
    sourceCheckSet: source,
    targetCheckSet: target,
    rules: { source: { stop: stopRuleFor(source), write: writeRuleFor(source) }, target: { stop: stopRuleFor(target), write: writeRuleFor(target) } },
    added,
    removed,
    needsReview: { added: minus(unparsed(tgt), unparsed(src)), removed: minus(unparsed(src), unparsed(tgt)) },
    judgeLines: { added: minus(tgt.semanticLines, src.semanticLines), removed: minus(src.semanticLines, tgt.semanticLines) },
    sourceVerdict: src.failures.length > 0 ? "FAIL" : "PENDING_SEMANTIC",
    targetVerdict: tgt.failures.length > 0 ? "FAIL" : "PENDING_SEMANTIC",
    sourceMatchesRecord: JSON.stringify(src.failures) === JSON.stringify(record.failures),
    sourceUnchanged: JSON.stringify(before) === JSON.stringify(after),
  };
}

/** One run directory holding `record/` and `raw/`. */
export function crosscheck(runDir: string, target: number): CrosscheckReport {
  return crosscheckPaths(join(runDir, "record"), join(runDir, "raw"), target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const at = argv.indexOf("--target-check-set");
    const target = at >= 0 ? Number(argv[at + 1]) : NaN;
    const dirs = argv.filter((_, i) => i !== at && i !== at + 1);
    if (!Number.isInteger(target) || dirs.length === 0) throw new Error("--target-check-set <n> <runDir>...");
    process.stdout.write(`${JSON.stringify(dirs.map((d) => crosscheck(resolve(d), target)), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
