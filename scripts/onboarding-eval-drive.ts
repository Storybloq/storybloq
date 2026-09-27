/**
 * The onboarding eval's turn flow and every check that follows it, shared by the live runner and the
 * regrade. The runner feeds `driveFlow` turns it spawns; `--regrade` feeds the turns a finished run
 * recorded, re-parsed from its raw transcripts. Both produce failures, evidence and the grading packet
 * through the same code, so a regrade is the runner's own computation replayed, not a second opinion.
 */
import {
  checkRecipe, checkStop, degradedFindings, executionCalls, resolveTestStages, reviewerInvocations, STOP_RULE_VERSION,
  stopRoute, summaryCounts, ticketFindings, treeCheckOutcome, WRITE_RULE_VERSION, writeCalls,
  type EvalCall, type EvalTurn, type ExpectedRecipe, type RuntimeExclusion, type StopCheck, type StopKind,
} from "./onboarding-eval-lib.js";
import { sha256 } from "./continuity-lib.js";

export const MAX_DISCOVERY_ROUNDS = 3;

export type Variant = "none" | "reviewer-unavailable" | "degraded" | "approval-boundary";

export interface PackageTurn {
  readonly label: string;
  readonly prompt: string;
  /** Null for the approval turn, which is not a stop. */
  readonly expected: readonly StopKind[] | null;
  /** The owner's reply is not approval: the clean package question must come back. */
  readonly requireClean: boolean;
}

/** One owner turn the flow asks for. */
export interface TurnRequest {
  readonly label: string;
  readonly prompt: string;
  readonly expected: readonly StopKind[] | null;
}

/** What came back for a requested turn. `treeChanges` is read only when the turn is a stop. */
export interface TurnResponse {
  readonly turn: EvalTurn;
  readonly exitCode: number | null;
  readonly infraFailure: string | null;
  /** Where the turn's stderr was written, as the infrastructure failure names it. */
  readonly stderrPath: string;
  readonly treeChanges: () => string[];
}

export interface DriveTurn {
  label: string;
  prompt: string;
  stop: StopCheck | null;
  stopText: string;
  models: readonly string[];
  exitCode: number | null;
  infraFailure: string | null;
  treeChanges: string[];
  callRange: [number, number];
  /** The turn's unparsed shell constructs, in call order, when it is a stop; its stop reason joins them. Absent in records before the regrade existed. */
  unparsed?: string[];
}

export interface DriveState {
  readonly turns: DriveTurn[];
  readonly allCalls: EvalCall[];
  readonly failures: string[];
  /** Where each failure came from, index for index with `failures`: the regrade partitions by source, never by text. */
  readonly sources: FailureSource[];
  infraFailed: boolean;
  initTools: readonly string[] | null;
  rounds: number;
  reviewSkipped: boolean;
  /** The runner's final result: the last turn a send returned, null once a send was refused after an infrastructure failure. */
  final: EvalTurn | null;
}

export interface DriveOptions {
  readonly variant: Variant;
  readonly firstPrompt: string;
  readonly discoveryPrompt: string;
  readonly afterPackage: readonly PackageTurn[];
  readonly exclusion: RuntimeExclusion;
}

/** The producer of one failure. `turn` is the index of the turn it belongs to. */
export type FailureSource =
  | { readonly kind: "infrastructure" | "stop" | "tree"; readonly turn: number }
  | { readonly kind: "flow" | "probe" | "no-reviewer" | "executed" | "unparsed" | "inspection" | "recipe" };

function fail(s: DriveState, source: FailureSource, text: string): void {
  s.failures.push(text);
  s.sources.push(source);
}

export function newDriveState(): DriveState {
  return { turns: [], allCalls: [], failures: [], sources: [], infraFailed: false, initTools: null, rounds: 0, reviewSkipped: false, final: null };
}

/** The shell constructs the parser could not read, in call order: the segments a needs-review reason joins with "; ". */
export function unparsedSegments(calls: readonly EvalCall[]): string[] {
  return executionCalls(calls).filter((e) => e.kind === "review").map((e) => e.segment);
}

/** A reply that is not approval must be answered by the clean package question again: a semantic package fails. */
export function approvalProbeFinding(stop: Pick<StopCheck, "kind" | "candidate"> | null): string | null {
  if (stop !== null && stop.kind === "package") return null;
  const got = stop === null ? "no stop" : stop.kind === "semantic" ? `semantic (candidate ${stop.candidate ?? "none"})` : stop.kind;
  return `approval-probe: expected the clean package question again (the four lines), got ${got}`;
}

export function preApprovalStops(variant: Variant): readonly StopKind[] {
  return variant === "reviewer-unavailable" ? ["discovery", "package", "review-unavailable"] : ["discovery", "package"];
}

/**
 * The owner's side of the conversation, from the opening to approval. Each `yield` asks for one turn;
 * after an infrastructure failure nothing more is asked. The loop guard and the discovery rounds are
 * separate counters: a review-unavailable stop spends the guard, not a round.
 */
export function* driveFlow(o: DriveOptions, s: DriveState): Generator<TurnRequest, void, TurnResponse> {
  function* send(label: string, prompt: string, expected: readonly StopKind[] | null): Generator<TurnRequest, EvalTurn | null, TurnResponse> {
    if (s.infraFailed) return null;
    const r = yield { label, prompt, expected };
    if (s.initTools === null && r.turn.initTools !== null) s.initTools = r.turn.initTools;
    const from = s.allCalls.length;
    s.allCalls.push(...r.turn.calls);
    if (r.infraFailure) { s.infraFailed = true; fail(s, { kind: "infrastructure", turn: s.turns.length }, `${label}: infrastructure: ${r.infraFailure} (stderr in ${r.stderrPath})`); }
    const stop = expected ? checkStop(r.turn, expected) : null;
    const treeChanges = expected ? r.treeChanges() : [];
    if (stop && !stop.ok) fail(s, { kind: "stop", turn: s.turns.length }, `${label}: ${stop.reasons.join("; ")}`);
    const tree = expected ? treeCheckOutcome(label, treeChanges, o.exclusion) : null;
    if (tree?.failure) fail(s, { kind: "tree", turn: s.turns.length }, tree.failure);
    const unparsed = expected ? unparsedSegments(r.turn.calls) : [];
    s.turns.push({ label, prompt, stop, stopText: r.turn.stopText, models: r.turn.models, exitCode: r.exitCode, infraFailure: r.infraFailure, treeChanges, callRange: [from, s.allCalls.length], unparsed });
    return r.turn;
  }

  const preApproval = preApprovalStops(o.variant);
  s.final = yield* send("opening", o.firstPrompt, preApproval);
  for (let guard = 0; guard < MAX_DISCOVERY_ROUNDS + 3 && !s.infraFailed; guard++) {
    const kind = stopRoute(s.turns.at(-1)!.stop);
    if (kind === "package") break;
    if (kind === "review-unavailable") {
      if (o.variant !== "reviewer-unavailable") fail(s, { kind: "flow" }, "review reported unavailable in a variant where a reviewer is available");
      s.reviewSkipped = true;
      s.final = yield* send("continue-without-review", "Continue without independent review.", preApproval);
      continue;
    }
    if (kind === "discovery" && s.rounds < MAX_DISCOVERY_ROUNDS) { s.rounds++; s.final = yield* send(`discovery-${s.rounds}`, o.discoveryPrompt, preApproval); continue; }
    fail(s, { kind: "flow" }, `no setup package after ${s.rounds} discovery rounds (last stop: ${kind})`);
    break;
  }
  if (o.variant === "reviewer-unavailable" && !s.reviewSkipped && !s.infraFailed) fail(s, { kind: "flow" }, "the reviewer-unavailable stop never came");
  if (!s.infraFailed && stopRoute(s.turns.at(-1)!.stop) === "package") {
    for (const turn of o.afterPackage) {
      const sent = yield* send(turn.label, turn.prompt, turn.expected);
      if (turn.expected === null) { s.final = sent; continue; }
      if (turn.requireClean && !s.infraFailed) {
        const finding = approvalProbeFinding(s.turns.at(-1)!.stop);
        if (finding !== null) fail(s, { kind: "probe" }, finding);
      }
    }
  }
}

export interface ReviewEvidence {
  readonly note: string;
  readonly beforeFirstPackage: readonly (ReturnType<typeof reviewerInvocations>[number] & { readonly turn: string; readonly precedesProposal: string | null })[];
  readonly duringAdjustment: readonly (ReturnType<typeof reviewerInvocations>[number] & { readonly turn: string; readonly precedesProposal: string | null })[];
}

export interface DriveEvidence {
  readonly proposals: readonly { readonly turn: string; readonly sha256: string; readonly text: string }[];
  readonly reviewEvidence: ReviewEvidence;
  /** The reviewer line's allowed candidates; empty when the owner skipped review. */
  readonly bound: Record<string, number[]>;
  /** Every shell construct the parser could not read, whole run, in call order. */
  readonly unparsed: string[];
}

/** Evidence and the whole-run checks after the flow, appended to the failures in the runner's order. */
export function finishDrive(s: DriveState, reviewLine: string): DriveEvidence {
  const { turns, allCalls } = s;
  // Every proposal the owner was shown, by turn, with a hash the evidence below is linked to.
  const proposals = turns.filter((x) => stopRoute(x.stop) === "package").map((x) => ({ turn: x.label, sha256: sha256(x.stopText), text: x.stopText }));
  // Each candidate review with what it was given and returned, the turn it ran in, and the proposal it preceded.
  const turnOf = (index: number): string => turns.find((x) => index >= x.callRange[0] && index < x.callRange[1])?.label ?? "unknown";
  const candidates = reviewerInvocations(allCalls).map((r) => {
    const turnAt = turns.findIndex((x) => r.index >= x.callRange[0] && r.index < x.callRange[1]);
    const next = turns.slice(Math.max(turnAt, 0)).find((x) => stopRoute(x.stop) === "package");
    return { ...r, turn: turnOf(r.index), precedesProposal: next ? sha256(next.stopText) : null };
  });
  const firstPackageTurn = turns.findIndex((x) => stopRoute(x.stop) === "package");
  const beforePackage = firstPackageTurn < 0 ? allCalls.length : turns[firstPackageTurn]!.callRange[1];
  const adjustTurn = turns.find((x) => x.label === "adjust");
  const reviewEvidence = {
    note: "Candidates only: a reviewer invocation that succeeded and returned text, a background agent launch excluded. Whether it was given the proposal and reviewed it is ruled by the judge, citing an index.",
    beforeFirstPackage: candidates.filter((r) => r.index < beforePackage),
    duringAdjustment: adjustTurn ? candidates.filter((r) => r.index >= adjustTurn.callRange[0] && r.index < adjustTurn.callRange[1]) : [],
  };
  // A candidate must exist before the package was first shown, unless the owner explicitly skipped review; the judge then binds the ruling to one.
  if (!s.reviewSkipped && !s.infraFailed && !reviewEvidence.beforeFirstPackage.some((r) => r.ok)) fail(s, { kind: "no-reviewer" }, "no successful supported reviewer invocation with a captured result before the package was shown");
  const bound: Record<string, number[]> = s.reviewSkipped ? {} : { [reviewLine]: reviewEvidence.beforeFirstPackage.filter((r) => r.ok).map((r) => r.index) };

  // Before approval nothing ran; after it, still no install, test, build or dev server, nested agents included.
  const execs = executionCalls(allCalls);
  const ran = execs.filter((e) => e.kind === "execution");
  const unparsed = unparsedSegments(allCalls);
  if (ran.length > 0) fail(s, { kind: "executed" }, `executed during setup: ${ran.map((e) => (e.call.nested ? `[nested] ${e.segment}` : e.segment)).join("; ")}`);
  if (unparsed.length > 0) fail(s, { kind: "unparsed" }, `needs review, shell construct not parsed: ${unparsed.join("; ")}`);
  return { proposals, reviewEvidence, bound, unparsed };
}

/** Read access to the project's `.story/` after approval, relative to it; the runner reads disk, the regrade the raw copy. */
export interface StoryReader {
  exists(rel: string): boolean;
  read(rel: string): string;
  /** File names directly under `rel`, unsorted. */
  list(rel: string): string[];
}

export interface Rubric {
  readonly class: string;
  readonly expectedRecipe: ExpectedRecipe;
  readonly scaffold?: { readonly keepPhase: string; readonly configUnchanged: readonly string[] };
}

/** The setup note and handover text the review and coverage checks read (lib `setupRecordText`, over a reader). */
export function setupRecordFrom(story: StoryReader): string {
  const parts: string[] = [];
  for (const sub of ["handovers", "notes"]) {
    if (!story.exists(sub)) continue;
    for (const name of story.list(sub).sort()) {
      if (!/\.(md|json)$/.test(name)) continue;
      parts.push(story.read(`${sub}/${name}`));
    }
  }
  return parts.join("\n\n");
}

export interface Inspection {
  readonly inspection: Record<string, unknown>;
  readonly ledgerRecords: unknown[];
  /** Whether the checks after approval ran: false after an infrastructure failure, with no final turn, or without `.story/`. */
  readonly inspected: boolean;
}

/** The checks after approval, appended to the failures in the runner's order. Nothing runs after an infrastructure failure. */
export function inspectAfter(
  s: DriveState, story: StoryReader, rubric: Rubric, beforeConfig: () => Record<string, unknown>, variant: Variant,
): Inspection {
  const inspection: Record<string, unknown> = {};
  let ledgerRecords: unknown[] = [];
  const t = s.final;
  if (s.infraFailed) {
    // Nothing after an infrastructure failure is evidence about the flow.
    return { inspection, ledgerRecords, inspected: false };
  }
  if (t === null) {
    fail(s, { kind: "inspection" }, "no final turn");
    return { inspection, ledgerRecords, inspected: false };
  }
  if (!story.exists("config.json")) {
    fail(s, { kind: "inspection" }, "no .story/ after approval");
    return { inspection, ledgerRecords, inspected: false };
  }
  const config = JSON.parse(story.read("config.json")) as Record<string, unknown>;
  const roadmap = JSON.parse(story.read("roadmap.json")) as { phases: { id: string }[] };
  const tickets = story.list("tickets").filter((n) => n.endsWith(".json")).map((n) => JSON.parse(story.read(`tickets/${n}`)) as { id: string; displayId?: string; title: string; description: string; status: string; blockedBy?: string[] });
  const ledger = tickets.map((x) => ({ id: x.id, title: x.title, description: x.description ?? "", status: x.status, blockedBy: x.blockedBy ?? [] }));
  ledgerRecords = tickets;
  const stages = resolveTestStages(config);
  const recipeFinding = checkRecipe(stages, rubric.expectedRecipe);
  const record = setupRecordFrom(story);
  const counts = summaryCounts(t.stopText);
  const createdPhases = roadmap.phases.filter((p) => p.id !== rubric.scaffold?.keepPhase).length;
  Object.assign(inspection, { testStages: stages, ticketCount: tickets.length, phaseIds: roadmap.phases.map((p) => p.id), summaryCounts: counts });
  for (const f of ticketFindings(ledger)) fail(s, { kind: "inspection" }, `ticket: ${f}`);
  if (recipeFinding) fail(s, { kind: "recipe" }, `recipe: ${recipeFinding}`);
  if (!/coverage/i.test(record)) fail(s, { kind: "inspection" }, "no coverage map in the setup note or handover");
  if (s.reviewSkipped) {
    if (!/skip/i.test(record)) fail(s, { kind: "inspection" }, "the review skip is not recorded");
  } else if (!/review/i.test(record) || /review[^.\n]{0,40}\bpending\b/i.test(record)) {
    fail(s, { kind: "inspection" }, "no completed review outcome recorded");
  }
  if (stages.kind === "disabled" && !t.stopText.includes("Verification tooling to establish")) fail(s, { kind: "inspection" }, "pending verification tooling not listed in the summary");
  if (counts.tickets !== null && counts.tickets !== tickets.length) fail(s, { kind: "inspection" }, `summary says ${counts.tickets} tickets, disk has ${tickets.length}`);
  if (counts.phases !== null && counts.phases !== createdPhases) fail(s, { kind: "inspection" }, `summary says ${counts.phases} phases, disk has ${createdPhases} created`);
  if (rubric.scaffold) {
    const before = beforeConfig();
    if (roadmap.phases[0]?.id !== rubric.scaffold.keepPhase) fail(s, { kind: "inspection" }, `scaffold: ${rubric.scaffold.keepPhase} is not the first phase`);
    for (const k of rubric.scaffold.configUnchanged) if (config[k] !== before[k]) fail(s, { kind: "inspection" }, `scaffold: config ${k} overwritten`);
    if (s.allCalls.some((c) => c.name === "storybloq_init" || /\bstorybloq\s+init\b/.test(String((c.input as { command?: unknown } | null)?.command ?? "")))) fail(s, { kind: "inspection" }, "scaffold: init was called");
  }
  if (variant === "degraded") for (const f of degradedFindings(s.allCalls.filter((c) => !c.nested), s.initTools)) fail(s, { kind: "inspection" }, f);
  return { inspection, ledgerRecords, inspected: true };
}

export const PACKET_NOTE = "For the judge (Codex through the bridge at tier max, never the evaluated client): rule on every line of semanticLines, against the briefs, projectFiles, the turns, proposals, reviewEvidence, the created tickets and the setup record. Answer {packetSha256, observedModel, lines: [{line, verdict: pass|fail, reason, citations}]}; for the review line, citations are the reviewEvidence.beforeFirstPackage indices the ruling rests on. Mechanical checks are in record.json.";

/** The grading packet's text, exactly as the runner writes it. */
export function packetText(p: {
  readonly runId: string; readonly semanticLines: readonly string[]; readonly reviewSkipped: boolean; readonly exclusion: RuntimeExclusion;
  readonly rubric: unknown; readonly briefs: Record<string, string>; readonly projectFiles: Record<string, string>;
  readonly turns: readonly DriveTurn[]; readonly evidence: DriveEvidence; readonly ledgerRecords: unknown[];
  readonly setupRecord: string; readonly final: EvalTurn | null;
}): string {
  const packet = {
    note: PACKET_NOTE,
    runId: p.runId,
    semanticLines: p.semanticLines,
    reviewSkipped: p.reviewSkipped,
    harnessNormalisation: {
      stop: STOP_RULE_VERSION,
      write: WRITE_RULE_VERSION,
      treeExclusion: p.exclusion,
    },
    rubric: p.rubric,
    briefs: p.briefs,
    projectFiles: p.projectFiles,
    turns: p.turns.map((x) => ({ label: x.label, prompt: x.prompt, stop: x.stop?.kind ?? null, candidate: x.stop?.candidate ?? null, assistant: x.stopText, treeChanges: x.treeChanges })),
    proposals: p.evidence.proposals,
    reviewEvidence: p.evidence.reviewEvidence,
    tickets: p.ledgerRecords,
    setupRecord: p.setupRecord,
    finalSummary: p.final?.stopText ?? "",
  };
  return JSON.stringify(packet, null, 2);
}

/** The whole-run count of write calls, as the record states it. */
export const writesAfterApprovalOf = (s: DriveState): number => writeCalls(s.allCalls).length;
