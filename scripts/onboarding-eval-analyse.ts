/**
 * The check set 5 analysis: a finished run read by check set 5's new detectors, observationally.
 *
 * It first validates the run under its own check set (the regrade, which refuses any mismatch between the record,
 * the packet and the raw transcripts), then replays the stored turns under that same check set and reads every
 * captured turn and call with the detectors check set 5 adds: the setup skill citations in turns that show the
 * package (A1) and in every other turn (A3), and the mixed-quote wrapper reading (C1), each call in its recorded
 * approval context (the turn labels and call ranges). Where check set 5's flow would have driven the captured run
 * differently, it lists that apart as `flowIncompatibility`. It computes no check set 5 verdict, failure list or
 * count, supplies no owner reply, and writes one artifact, `analysis-cs5.json`, to the `--out` directory; the record
 * and raw directories are never written.
 *
 *   tsx scripts/onboarding-eval-analyse.ts --record <recordDir> --raw <rawDir> --out <dir>
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyseCalls, asksOnlyLast, claudeTurn, codexTurn, hasApprovalBlock, stopRoute, type EvalCall, type EvalTurn, type RuntimeExclusion } from "./onboarding-eval-lib.js";
import { parseStream, sha256 } from "./continuity-lib.js";
import { driveFlow, inventoryFor, newDriveState, skillCitationLines, type Variant } from "./onboarding-eval-drive.js";
import { regradeInputFrom } from "./onboarding-eval-run.js";
import { regrade, turnFile } from "./onboarding-eval-regrade.js";

export const TARGET_CHECK_SET = 5;
export const ANALYSIS_FILE = "analysis-cs5.json";

interface WrapperSide {
  readonly unparsed: readonly string[];
  readonly scripts: readonly { readonly turn: string; readonly callIndex: number; readonly bodySha256: string }[];
}

export interface AnalysisReport {
  readonly recordSha256: string;
  readonly packetSha256: string;
  readonly sourceCheckSet: number;
  readonly targetCheckSet: number;
  /** A1: setup skill citations in turns that show the package. */
  readonly packageCitations: readonly { readonly turn: string; readonly line: string }[];
  /** A3: setup skill citations in every other turn. */
  readonly skillCitations: readonly { readonly turn: string; readonly line: string }[];
  /** C1: the call analysis under the source check set and under check set 5's wrapper reading. */
  readonly wrapper: { readonly source: WrapperSide; readonly target: WrapperSide };
  /** Where check set 5's flow would have driven the captured run differently; informational, never a failure. */
  readonly flowIncompatibility: readonly { readonly turn: string; readonly targetFlow: string; readonly captured: string }[];
}

function parseTurn(client: string, raw: string, checkSet: number): EvalTurn {
  if (client === "claude") return claudeTurn(parseStream(raw).events, checkSet);
  const lines: Record<string, unknown>[] = [];
  for (const l of raw.split("\n")) { try { const v = JSON.parse(l); if (v && typeof v === "object") lines.push(v); } catch { /* non-JSON line */ } }
  return codexTurn(lines, checkSet);
}

const captured = (route: string | null | undefined): string =>
  route === "discovery" ? "discovery questions" : route === "package" ? "the package" : route === "review-unavailable" ? "the reviewer-unavailable stop after a question" : `a ${route ?? "missing"} stop`;

/** One stored run (record and raw directories) read by check set 5's detectors, after it validates under its own check set. */
export function analysePaths(recordDir: string, rawDir: string): AnalysisReport {
  const input = regradeInputFrom(recordDir, rawDir);
  const validated = regrade(input);
  if (!validated.ok) throw new Error(`the record does not validate under its own check set: ${validated.reason}`);
  const record = JSON.parse(input.recordBytes.toString("utf-8")) as {
    client: string; variant: Variant; checkSetVersion?: number; treeExclusion: RuntimeExclusion;
    turns: { label: string; models?: string[]; exitCode: number | null; infraFailure: string | null; treeChanges: string[] }[];
  };
  const source = record.checkSetVersion ?? 1;

  // The captured turns in the order the source flow asked for them; the flow only routes, it never invents a reply.
  const state = newDriveState(source);
  const flow = driveFlow({ variant: record.variant, firstPrompt: input.fixture.firstPrompt, discoveryPrompt: input.fixture.discoveryPrompt, afterPackage: input.fixture.afterPackage, exclusion: record.treeExclusion }, state);
  const evalTurns: EvalTurn[] = [];
  const expected: boolean[] = [];
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const rec = record.turns[n];
    if (rec === undefined || rec.label !== step.value.label) throw new Error(`turn ${n}: the flow asks for ${step.value.label}, the record has ${rec?.label ?? "no turn"}`);
    const turn = { ...parseTurn(record.client, input.readRaw(`${turnFile(n, rec.label)}.jsonl`).toString("utf-8"), source), models: rec.models ?? [] };
    evalTurns.push(turn);
    expected.push(step.value.expected !== null);
    const changes = rec.treeChanges;
    step = flow.next({ turn, exitCode: rec.exitCode, infraFailure: rec.infraFailure, stderrPath: "", treeChanges: () => changes });
    n++;
  }

  const packageCitations: { turn: string; line: string }[] = [];
  const skillCitations: { turn: string; line: string }[] = [];
  state.turns.forEach((t, i) => {
    const shows = expected[i]! && evalTurns[i]!.pendingQuestion === undefined && (stopRoute(t.stop) === "package" || hasApprovalBlock(t.stopText));
    for (const line of skillCitationLines(t.stopText)) (shows ? packageCitations : skillCitations).push({ turn: t.label, line });
  });

  const side = (checkSet: number): WrapperSide => {
    const a = analyseCalls(state.allCalls as readonly EvalCall[], state.turns, checkSet);
    return { unparsed: [...a.unresolved], scripts: a.interpreterScripts.map((x) => ({ turn: x.turn, callIndex: x.callIndex, bodySha256: sha256(x.body) })) };
  };

  const flowIncompatibility: { turn: string; targetFlow: string; captured: string }[] = [];
  const inventory = inventoryFor(record.variant);
  const opening = state.turns[0];
  if (opening !== undefined && inventory.cli === "absent" && inventory.reviewPlan === "absent" && inventory.agent === "absent") {
    const route = stopRoute(opening.stop);
    if (!(route === "review-unavailable" && asksOnlyLast(opening.stopText))) flowIncompatibility.push({ turn: opening.label, targetFlow: "the reviewer-unavailable stop alone", captured: captured(route) });
  }

  return {
    recordSha256: sha256(input.recordBytes),
    packetSha256: sha256(input.packetBytes),
    sourceCheckSet: source,
    targetCheckSet: TARGET_CHECK_SET,
    packageCitations,
    skillCitations,
    wrapper: { source: side(source), target: side(TARGET_CHECK_SET) },
    flowIncompatibility,
  };
}

/** The command: `--record`, `--raw` and `--out` are all required; the artifact is created exclusively, never overwritten. */
export function main(argv: readonly string[]): string {
  const arg = (name: string): string => {
    const at = argv.indexOf(name);
    const value = at >= 0 ? argv[at + 1] : undefined;
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} <dir> is required: --record <recordDir> --raw <rawDir> --out <dir>`);
    return value;
  };
  const recordDir = resolve(arg("--record"));
  const rawDir = resolve(arg("--raw"));
  const out = join(resolve(arg("--out")), ANALYSIS_FILE);
  const report = analysePaths(recordDir, rawDir);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${main(process.argv.slice(2))}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
