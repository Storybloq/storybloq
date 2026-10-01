/**
 * The onboarding eval's turn flow and every check that follows it, shared by the live runner and the
 * regrade. The runner feeds `driveFlow` turns it spawns; `--regrade` feeds the turns a finished run
 * recorded, re-parsed from its raw transcripts. Both produce failures, evidence and the grading packet
 * through the same code, so a regrade is the runner's own computation replayed, not a second opinion.
 */
import {
  analyseCalls, approvedQualityLevel, asksOnlyLast, authoritativeProbe, checkRecipe, checkStop, degradedFindings, discoveryTail, endsWithClosingLines, findingsOf, hasApprovalBlock,
  hasFixedLine, notRerunLines, pendingFindings, pendingInventory, probeAttempts, probeLines, qualityLevel,
  recipeContract, recipeFindings, resolveTestStages, reviewerCapabilityOf, reviewerInvocations, reviewStatus, reviewStatusLineIndex, stopRuleFor,
  stopRoute, summaryCounts, ticketFindings, treeCheckOutcome, writeRuleFor,
  type EvalCall, type EvalTurn, type ExpectedRecipe, type InterpreterScript, type ReviewerCapability, type ReviewerInvocation, type RuntimeExclusion, type StopCheck, type StopKind,
} from "./onboarding-eval-lib.js";
import { sha256 } from "./continuity-lib.js";
import { citingLines, findSkillCitations } from "./onboarding-eval-corpus-5.js";

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
  /** The check set the run is graded under (lib CHECK_SET_VERSION); 1 for a record written before check sets existed. */
  readonly checkSet: number;
  /** Check set 5 (A3): setup skill citations in turns that do not show the package, recorded and never failed. */
  readonly skillCitations: { turn: string; line: string }[];
}

/** Check set 5 (B2): a reviewer path as the harness's fixture contract establishes it, never as the agent's probe reads it. */
export type ReviewerPath = "absent" | "present" | "unknown";
export interface ReviewerInventory { readonly cli: ReviewerPath; readonly reviewPlan: ReviewerPath; readonly agent: ReviewerPath }

/**
 * The fixture contract's reviewer inventory (run.ts). The reviewer-unavailable variant removes codex from PATH and
 * refuses `command -v codex`, gives the client a storybloq-only MCP config and turns agents off, so all three paths are
 * absent. Every other variant leaves codex on PATH and the same storybloq-only MCP config; whether an agent can start is
 * not established, so it is unknown, never absent.
 */
export function inventoryFor(variant: Variant): ReviewerInventory {
  return variant === "reviewer-unavailable" ? { cli: "absent", reviewPlan: "absent", agent: "absent" } : { cli: "present", reviewPlan: "absent", agent: "unknown" };
}

/** Check set 5: the opening failure when every reviewer path is absent and the stop did not come alone first. */
export const OPENING_STOP_FAILURE = "the reviewer-unavailable stop did not open the run";

export interface DriveOptions {
  readonly variant: Variant;
  readonly firstPrompt: string;
  readonly discoveryPrompt: string;
  readonly afterPackage: readonly PackageTurn[];
  readonly exclusion: RuntimeExclusion;
  /** Check set 5: the reviewer paths the fixture contract establishes; `inventoryFor(variant)` when absent. */
  readonly reviewerInventory?: ReviewerInventory;
}

/** The producer of one failure. `turn` is the index of the turn it belongs to. */
export type FailureSource =
  | { readonly kind: "infrastructure" | "stop" | "tree" | "tail" | "closing"; readonly turn: number }
  | { readonly kind: "flow" | "probe" | "no-reviewer" | "executed" | "unparsed" | "inspection" | "recipe" | "review" | "pending" };

function fail(s: DriveState, source: FailureSource, text: string): void {
  s.failures.push(text);
  s.sources.push(source);
}

/** The lines of a stop that cite the setup skill, a sentence broken across lines included; the whole stop if a citation maps to no line. */
export function skillCitationLines(stopText: string): string[] {
  const lines = citingLines(stopText);
  return lines.length > 0 || findSkillCitations(stopText).length === 0 ? lines : [stopText.trim()];
}

export function newDriveState(checkSet = 1): DriveState {
  return { turns: [], allCalls: [], failures: [], sources: [], infraFailed: false, initTools: null, rounds: 0, reviewSkipped: false, final: null, checkSet, skillCitations: [] };
}

/** The shell constructs the parser could not read, in call order: the segments a needs-review reason joins with "; ". A stop's calls are before approval. */
export function unparsedSegments(calls: readonly EvalCall[], checkSet = 1): string[] {
  return [...analyseCalls(calls, [], checkSet).unresolved];
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
    const stop = expected ? checkStop(r.turn, expected, s.checkSet) : null;
    const treeChanges = expected ? r.treeChanges() : [];
    if (stop && !stop.ok) fail(s, { kind: "stop", turn: s.turns.length }, `${label}: ${stop.reasons.join("; ")}`);
    const tree = expected ? treeCheckOutcome(label, treeChanges, o.exclusion) : null;
    if (tree?.failure) fail(s, { kind: "tree", turn: s.turns.length }, tree.failure);
    const unparsed = expected ? unparsedSegments(r.turn.calls, s.checkSet) : [];
    // Check set 2: a plain-text discovery question is the last thing in its turn.
    if (s.checkSet >= 2 && stop?.kind === "semantic" && stop.candidate === "discovery" && r.turn.pendingQuestion === undefined) {
      const tail = discoveryTail(r.turn.stopText);
      if (tail !== "") fail(s, { kind: "tail", turn: s.turns.length }, `the discovery question is followed by more text (${label}): ${tail}`);
    }
    // Check set 3: a turn that shows the package, by its route or by the three option labels as lines, ends at `Inspect details`.
    const shows = s.checkSet >= 3 && expected !== null && r.turn.pendingQuestion === undefined && (stopRoute(stop) === "package" || hasApprovalBlock(r.turn.stopText));
    if (shows && !endsWithClosingLines(r.turn.stopText, s.checkSet)) {
      fail(s, { kind: "closing", turn: s.turns.length }, `the package does not end with the four closing lines (${label})`);
    }
    // Check set 4: the fixed line ends the paragraph above the question, one blank line between.
    if (shows && s.checkSet >= 4 && !hasFixedLine(r.turn.stopText, s.checkSet)) {
      fail(s, { kind: "closing", turn: s.turns.length }, `the package does not carry the fixed line above the question (${label})`);
    }
    // Check set 5: a package never cites the setup skill; a citation anywhere else is recorded, never failed.
    if (s.checkSet >= 5) {
      if (shows) {
        if (findSkillCitations(r.turn.stopText).length > 0) fail(s, { kind: "closing", turn: s.turns.length }, `the package cites the setup skill (${label})`);
      } else for (const line of skillCitationLines(r.turn.stopText)) s.skillCitations.push({ turn: label, line });
    }
    s.turns.push({ label, prompt, stop, stopText: r.turn.stopText, models: r.turn.models, exitCode: r.exitCode, infraFailure: r.infraFailure, treeChanges, callRange: [from, s.allCalls.length], unparsed });
    return r.turn;
  }

  const preApproval = preApprovalStops(o.variant);
  s.final = yield* send("opening", o.firstPrompt, preApproval);
  // Check set 5: when the fixture contract makes every reviewer path absent, the opening is the unavailable stop alone.
  const inventory = o.reviewerInventory ?? inventoryFor(o.variant);
  if (s.checkSet >= 5 && !s.infraFailed && inventory.cli === "absent" && inventory.reviewPlan === "absent" && inventory.agent === "absent") {
    const opening = s.turns[0]!;
    if (!(stopRoute(opening.stop) === "review-unavailable" && asksOnlyLast(opening.stopText))) fail(s, { kind: "flow" }, OPENING_STOP_FAILURE);
  }
  for (let guard = 0; guard < MAX_DISCOVERY_ROUNDS + 3 && !s.infraFailed; guard++) {
    const kind = stopRoute(s.turns.at(-1)!.stop);
    if (kind === "package") break;
    if (kind === "review-unavailable") {
      if (o.variant !== "reviewer-unavailable") fail(s, { kind: "flow" }, "review reported unavailable in a variant where a reviewer is available");
      if (s.checkSet >= 2 && s.reviewSkipped) fail(s, { kind: "review" }, "the skip decision was asked again");
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
  /** Check set 2: the judge lines the review checks add, one per distinct review binding (bound) and one per non-material declaration. */
  readonly reviewLines: string[];
  /** Check set 4: the judge lines for each qualifying post-approval python script and each package citing a review that did not approve. */
  readonly judgeLines?: string[];
  /** Check set 4: every qualifying post-approval python script, verbatim, for the judge. */
  readonly interpreterScripts?: readonly InterpreterScript[];
  /** Check set 4 (G2): what the run shows about an agent reviewer; it fails nothing. */
  readonly reviewerCapability?: ReviewerCapability;
  /** Check set 5 (A3): setup skill citations outside the package, by turn and line; they fail nothing. */
  readonly skillCitations?: readonly { readonly turn: string; readonly line: string }[];
}

/** Evidence and the whole-run checks after the flow, appended to the failures in the runner's order. */
export function finishDrive(s: DriveState, reviewLine: string): DriveEvidence {
  const cs = s.checkSet;
  const { turns, allCalls } = s;
  // Every proposal the owner was shown, by turn, with a hash the evidence below is linked to.
  const proposals = turns.filter((x) => stopRoute(x.stop) === "package").map((x) => ({ turn: x.label, sha256: sha256(x.stopText), text: x.stopText }));
  // Each candidate review with what it was given and returned, the turn it ran in, and the proposal it preceded.
  const turnOf = (index: number): string => turns.find((x) => index >= x.callRange[0] && index < x.callRange[1])?.label ?? "unknown";
  const invocations = reviewerInvocations(allCalls, cs);
  const candidates = invocations.map((r) => {
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
  const reviewLines: string[] = [];
  if (cs >= 2 && !s.infraFailed) {
    const lines = reviewStatusChecks(s, invocations);
    for (const b of lines.bindings) { reviewLines.push(b.line); bound[b.line] = b.allowed; }
    reviewLines.push(...lines.declarations);
    if (cs >= 3) probeChecks(s, invocations);
  }

  // Before approval nothing ran; after it, still no install, test, build or dev server, nested agents included.
  const analysis = analyseCalls(allCalls, turns, cs);
  const ran = analysis.executions.filter((e) => e.kind === "execution");
  const unparsed = [...analysis.unresolved];
  if (ran.length > 0) fail(s, { kind: "executed" }, `executed during setup: ${ran.map((e) => (e.call.nested ? `[nested] ${e.segment}` : e.segment)).join("; ")}`);
  if (unparsed.length > 0) fail(s, { kind: "unparsed" }, `needs review, shell construct not parsed: ${unparsed.join("; ")}`);
  if (cs < 4) return { proposals, reviewEvidence, bound, unparsed, reviewLines };
  const judgeLines = [...analysis.semanticLines, ...(s.infraFailed ? [] : findingLines(s, invocations))];
  const evidence = { proposals, reviewEvidence, bound, unparsed, reviewLines, judgeLines, interpreterScripts: analysis.interpreterScripts, reviewerCapability: reviewerCapabilityOf(allCalls, s.initTools, turnOf) };
  return cs < 5 ? evidence : { ...evidence, skillCitations: [...s.skillCitations] };
}

/** Check set 4: the judge line for a package citing a review that did not approve, its findings verbatim. */
export function findingLine(label: string, ref: string, verdict: string, findings: readonly string[]): string {
  return `the package at turn ${label} states each finding of ${ref} (${verdict}) as unresolved or incorporated: ${findings.join(" | ")}`;
}

/** Check set 4: one finding line per package whose result status line binds a review whose verdict is not approve; the skip line asks nothing. */
/** Check set 4: the judge line when a cited non-approve review's findings could not be read from its captured response. */
export function findingsUnextractedLine(label: string, ref: string, verdict: string): string {
  return `the package at turn ${label} cites ${ref} (${verdict}), whose findings could not be extracted from the captured response: the package states each finding that response gives as unresolved or incorporated`;
}

function findingLines(s: DriveState, invocations: readonly ReviewerInvocation[]): string[] {
  const out: string[] = [];
  for (const t of s.turns) {
    if (stopRoute(t.stop) !== "package") continue;
    const status = reviewStatus(t.stopText);
    if (status.kind !== "result" || status.verdict.trim() === "approve") continue;
    const r = boundInvocation(invocations, status.ref, status.verdict);
    if (r === null) continue;
    const findings = findingsOf(r.result);
    // Findings the harness cannot read are still findings the package owes: the judge reads the response instead.
    if (findings === null) { out.push(findingsUnextractedLine(t.label, status.ref, status.verdict.trim())); continue; }
    if (findings.length === 0) continue;
    out.push(findingLine(t.label, status.ref, status.verdict.trim(), findings));
  }
  return out;
}

/** The judge line for one review binding: whether the cited invocation reviewed the plan the package it binds showed. */
export function bindingLine(ref: string, calls: readonly number[], label: string): string {
  return `Invocation ${ref} (call ${calls.join(" and ")}): its input contains the plan shown in the ${label} package, and its response reviews that plan, not another one`;
}

/** The judge line for one `Review not rerun:` declaration: whether that change alone is not material. */
export function materialityLine(label: string, declaration: string): string {
  return `the change declared in the ${label} package ("${declaration}") alters no ticket's scope (what it includes or excludes), no dependency, and no placement of a persistence, reliability, security or privacy responsibility`;
}

/** The judge line for one restated package: whether it kept the plan of the package before it. */
export function restatementLine(label: string, ref: string, previous: string): string {
  return `the ${label} package, which cites ${ref}, presents the plan of the ${previous} package or that plan with detail added: it changes no ticket's scope (what it includes or excludes), no dependency, and no placement of a persistence, reliability, security or privacy responsibility`;
}

/**
 * Check set 2's review status checks over every package and the setup summary: each carries one status line in its
 * exact form, a result line binds to exactly one captured invocation with that review id and the verdict it quotes,
 * and an adjusted package is either the owner's skip (A), a fresh review started and completed inside the adjustment
 * (B), or a declared non-material change that keeps the previous package's reference (C). Returns the judge lines:
 * one binding line per distinct (reference, originally reviewed package), one materiality line per declaration, and one restatement line per inspect or probe package.
 */
function reviewStatusChecks(s: DriveState, invocations: readonly ReviewerInvocation[]): { bindings: { line: string; allowed: number[] }[]; declarations: string[] } {
  const bad = (text: string): void => fail(s, { kind: "review" }, text);
  const bindings: { line: string; allowed: number[] }[] = [];
  const declarations: string[] = [];
  const skipped = s.reviewSkipped;
  const skipUnauthorised = (label: string): void => bad(`review skip stated without the owner's skip decision (${label})`);
  const bind = (ref: string, verdict: string, label: string): ReviewerInvocation | null => {
    const matches = invocations.filter((r) => r.reviewId === ref);
    if (matches.length === 0) { bad(`review reference ${ref} matches no captured invocation (${label})`); return null; }
    if (matches.length > 1) { bad(`review reference ${ref} matches several invocations (${label})`); return null; }
    const r = matches[0]!;
    if (!r.ok || r.verdict === null || r.verdict === undefined) { bad(`review reference ${ref} has no captured verdict (${label})`); return null; }
    if (r.verdict.trim() !== verdict.trim()) { bad(`review status quotes ${verdict}, the captured verdict of ${ref} is ${r.verdict} (${label})`); return null; }
    return r;
  };
  const origin = new Map<string, string>();
  const addBinding = (ref: string, r: ReviewerInvocation, label: string): void => {
    origin.set(ref, label);
    const calls = [...new Set([r.startIndex ?? r.index, r.completionIndex ?? r.index])];
    const line = bindingLine(ref, calls, label);
    if (!bindings.some((b) => b.line === line)) bindings.push({ line, allowed: calls });
  };
  let prior: string | null = null;
  const boundRefs = new Set<string>();
  const packages = s.turns.filter((t) => stopRoute(t.stop) === "package");
  packages.forEach((t, k) => {
    const label = t.label;
    const status = reviewStatus(t.stopText);
    // Every package the owner is shown carries exactly one status line, a restated one included.
    if (status.kind === "none") { bad(`review status line missing (${label})`); return; }
    if (status.kind === "several") { bad(`more than one review status line (${label})`); return; }
    if (k === 0) {
      if (skipped) { if (status.kind !== "skip") bad(`after the owner's skip the package must carry the skip status line (${label})`); return; }
      if (status.kind === "skip") { skipUnauthorised(label); return; }
      if (status.kind !== "result") return;
      const r = bind(status.ref, status.verdict, label);
      if (r === null) return;
      if ((r.completionIndex ?? r.index) >= t.callRange[1]) { bad(`the package cites ${status.ref}, which completed after it was shown (${label})`); return; }
      prior = status.ref; boundRefs.add(status.ref); addBinding(status.ref, r, label);
      return;
    }
    if (label.startsWith("adjust")) {
      const declared = notRerunLines(t.stopText);
      // Branch A: once the owner skipped review, the skip line and nothing else, whatever else binds.
      if (skipped) {
        if (status.kind !== "skip" || declared.length > 0) bad(`after the owner's skip the adjusted package must carry the skip status line (${label})`);
        return;
      }
      if (status.kind === "skip") { skipUnauthorised(label); return; }
      if (status.kind !== "result") return;
      if (declared.length > 1) { bad(`the adjusted package declares no re-review more than once (${label})`); return; }
      const r = bind(status.ref, status.verdict, label);
      if (r === null) return;
      const [from, to] = t.callRange;
      const completion = r.completionIndex ?? r.index;
      const start = r.startIndex ?? r.index;
      const fresh = !boundRefs.has(status.ref);
      const completesIn = completion >= from && completion < to;
      if (declared.length === 0) {
        if (!fresh) { bad(`the adjusted package was neither reviewed again nor declared not material (${label})`); return; }
        if (completion >= to) { bad(`the adjusted package cites ${status.ref}, which completed after it was shown (${label})`); return; }
        if (!completesIn) { bad(`the adjusted package cites ${status.ref}, which completed before the adjustment (${label})`); return; }
        if (start < from) { bad(`the adjusted package cites ${status.ref}, whose reviewer started before the adjustment (${label})`); return; }
        // Branch B: a new review of the adjusted plan.
        prior = status.ref; boundRefs.add(status.ref); addBinding(status.ref, r, label);
        return;
      }
      if (fresh && completesIn) { bad(`the adjusted package both cites a new review and declares it not rerun (${label})`); return; }
      if (status.ref !== prior) { bad(`the adjusted package declares no re-review but cites ${status.ref}, not the previously bound ${prior ?? "(none)"} (${label})`); return; }
      // Branch C: the reference keeps binding the plan it reviewed; the change itself goes to the judge.
      declarations.push(materialityLine(label, declared[0]!));
      return;
    }
    // Inspect and approval-probe packages restate the package: they cite the bound reference, and the judge rules that
    // the restatement kept the previous package's plan (detail may be added, scope may not change).
    if (skipped) { if (status.kind !== "skip") bad(`after the owner's skip the package must carry the skip status line (${label})`); return; }
    if (status.kind === "skip") { skipUnauthorised(label); return; }
    if (bind(status.ref, status.verdict, label) === null) return;
    if (status.ref !== prior) { bad(`the package cites ${status.ref}, not the previously bound ${prior ?? "(none)"} (${label})`); return; }
    declarations.push(restatementLine(label, status.ref, packages[k - 1]!.label));
  });
  // The setup summary: the approved package's status line.
  const last = s.turns.at(-1);
  if (last !== undefined && last.stop === null && packages.length > 0) {
    const status = reviewStatus(last.stopText);
    const label = "summary";
    if (status.kind === "none") bad(`review status line missing (${label})`);
    else if (status.kind === "several") bad(`more than one review status line (${label})`);
    else if (skipped) { if (status.kind !== "skip") bad(`after the owner's skip the summary must carry the skip status line`); }
    else if (status.kind === "skip") skipUnauthorised(label);
    else if (bind(status.ref, status.verdict, label) !== null && status.ref !== prior) bad(`the summary cites ${status.ref}, the approved package cites ${prior ?? "(none)"}`);
  }
  return { bindings, declarations };
}

/** The one invocation a result status line binds to (one match, ok, its captured verdict the quoted one), or null. */
function boundInvocation(invocations: readonly ReviewerInvocation[], ref: string, verdict: string): ReviewerInvocation | null {
  const matches = invocations.filter((r) => r.reviewId === ref);
  if (matches.length !== 1) return null;
  const r = matches[0]!;
  return r.ok && typeof r.verdict === "string" && r.verdict.trim() === verdict.trim() ? r : null;
}

/** A main-agent agent start: a Codex spawn or a Claude Agent/Task call. */
const isAgentStart = (c: EvalCall): boolean => (c.name === "collab:spawn_agent" && !c.isError) || ((c.name === "Agent" || c.name === "Task") && !c.nested);

/**
 * Check set 3's probe checks over every package and the setup summary that carries a review status line: the probe line
 * sits directly above it and says what the latest `command -v codex` attempt before the presentation printed; a result
 * after a probe that printed nothing binds to a review_plan or agent review started after that probe; and a result whose
 * id binds nothing, shown after a wait on no agent with no agent started, is named as resting on that wait.
 */
function probeChecks(s: DriveState, invocations: readonly ReviewerInvocation[]): void {
  const bad = (text: string): void => fail(s, { kind: "review" }, text);
  const attempts = probeAttempts(s.allCalls);
  const issued = (i: number): number => i + (s.allCalls[i]?.issueShift ?? 0);
  const packages = s.turns.filter((t) => stopRoute(t.stop) === "package");
  const shown = packages.map((t) => ({ label: t.label, text: t.stopText, end: t.callRange[1] }));
  const last = s.turns.at(-1);
  if (last !== undefined && last.stop === null && packages.length > 0) shown.push({ label: "summary", text: last.stopText, end: last.callRange[1] });
  for (const { label, text, end } of shown) {
    const status = reviewStatus(text);
    if (status.kind !== "result" && status.kind !== "skip") continue;
    const lines = probeLines(text);
    if (lines.length === 0) bad(`review status without a probe line (${label})`);
    else if (lines.length > 1) bad(`more than one probe line (${label})`);
    else if (lines[0]!.index !== reviewStatusLineIndex(text) - 1) bad(`the probe line is not directly above the review status line (${label})`);
    const probe = authoritativeProbe(attempts, end);
    if (probe === null) { if (lines.length === 1) bad(`the probe line has no captured probe (${label})`); }
    else if (probe.value.kind === "unknown") bad(`the latest probe is unknown: ${probe.value.reason} (${label})`);
    else if (lines.length === 1) {
      const printed = probe.value.kind === "path" ? probe.value.path : "nothing";
      if (lines[0]!.printed !== printed) bad(`the probe line says ${lines[0]!.printed}, the captured probe printed ${printed} (${label})`);
    }
    if (status.kind !== "result") continue;
    const r = boundInvocation(invocations, status.ref, status.verdict);
    if (probe !== null && probe.value.kind === "nothing") {
      // Started after the probe means issued after it: a reviewer issued earlier never saw the outcome, whenever it completed.
      const after = r !== null && (r.via === "review_plan" || r.via === "agent") && issued(r.startIndex ?? r.index) > probe.issued;
      if (!after) bad(`review claimed after a probe that found no reviewer (${label})`);
    }
    const emptyWait = invocations.some((i) => !i.ok && i.reason === "a wait on no agent" && i.index < end);
    if (r === null && emptyWait && !s.allCalls.slice(0, end).some(isAgentStart)) bad(`review claimed on a wait with no agent (${label})`);
  }
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
  const contract = s.checkSet >= 2 ? recipeContract(rubric.expectedRecipe) : null;
  // Check set 2: the approved package (the last one shown) names the quality level the stages are checked against.
  const approved = [...s.turns].reverse().find((x) => stopRoute(x.stop) === "package");
  // Check set 3: a restatement of the approved package inherits the level its reviewed package named.
  const approvedLevel = s.checkSet >= 3 ? approvedQualityLevel(s.turns.filter((x) => stopRoute(x.stop) === "package").map((x) => ({ label: x.label, text: x.stopText }))) : null;
  const level = contract === null ? null : approvedLevel !== null ? approvedLevel.level : qualityLevel(approved?.stopText ?? "");
  const recipeFinding = contract === null ? checkRecipe(stages, rubric.expectedRecipe) : null;
  const record = setupRecordFrom(story);
  const counts = summaryCounts(t.stopText);
  const createdPhases = roadmap.phases.filter((p) => p.id !== rubric.scaffold?.keepPhase).length;
  Object.assign(inspection, { testStages: stages, ticketCount: tickets.length, phaseIds: roadmap.phases.map((p) => p.id), summaryCounts: counts });
  if (contract !== null) inspection.qualityLevel = level;
  for (const f of ticketFindings(ledger)) fail(s, { kind: "inspection" }, `ticket: ${f}`);
  if (recipeFinding) fail(s, { kind: "recipe" }, `recipe: ${recipeFinding}`);
  if (contract !== null && approvedLevel !== null) for (const f of approvedLevel.findings) fail(s, { kind: "recipe" }, `recipe: ${f}`);
  // A level the check set 3 rules could not establish is already named; the generic finding would repeat it.
  const named = approvedLevel !== null && approvedLevel.explained;
  if (contract !== null && !named) for (const f of recipeFindings(stages, contract, level)) fail(s, { kind: "recipe" }, `recipe: ${f}`);
  if (!/coverage/i.test(record)) fail(s, { kind: "inspection" }, "no coverage map in the setup note or handover");
  if (s.reviewSkipped) {
    if (!/skip/i.test(record)) fail(s, { kind: "inspection" }, "the review skip is not recorded");
  } else if (!/review/i.test(record) || /review[^.\n]{0,40}\bpending\b/i.test(record)) {
    fail(s, { kind: "inspection" }, "no completed review outcome recorded");
  }
  if (contract !== null) {
    if (level !== null) for (const f of pendingFindings(t.stopText, pendingInventory(contract, level))) fail(s, { kind: "pending" }, f);
  } else if (stages.kind === "disabled" && !t.stopText.includes("Verification tooling to establish")) fail(s, { kind: "inspection" }, "pending verification tooling not listed in the summary");
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
  readonly setupRecord: string; readonly final: EvalTurn | null; readonly checkSet?: number;
}): string {
  const packet = {
    note: PACKET_NOTE,
    runId: p.runId,
    semanticLines: p.semanticLines,
    reviewSkipped: p.reviewSkipped,
    harnessNormalisation: {
      stop: stopRuleFor(p.checkSet ?? 1),
      write: writeRuleFor(p.checkSet ?? 1),
      treeExclusion: p.exclusion,
      ...((p.checkSet ?? 1) >= 2 ? { checkSet: p.checkSet } : {}),
    },
    rubric: p.rubric,
    briefs: p.briefs,
    projectFiles: p.projectFiles,
    turns: p.turns.map((x) => ({ label: x.label, prompt: x.prompt, stop: x.stop?.kind ?? null, candidate: x.stop?.candidate ?? null, assistant: x.stopText, treeChanges: x.treeChanges })),
    proposals: p.evidence.proposals,
    reviewEvidence: p.evidence.reviewEvidence,
    ...((p.checkSet ?? 1) >= 4 ? { interpreterScripts: p.evidence.interpreterScripts ?? [] } : {}),
    tickets: p.ledgerRecords,
    setupRecord: p.setupRecord,
    finalSummary: p.final?.stopText ?? "",
  };
  return JSON.stringify(packet, null, 2);
}

/** The whole-run count of write calls, as the record states it. */
export const writesAfterApprovalOf = (s: DriveState): number => analyseCalls(s.allCalls, s.turns, s.checkSet).writes.length;
