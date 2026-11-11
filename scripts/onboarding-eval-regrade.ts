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
  claudeTurn, codexTurn, KNOWN_CHECK_SETS, recipeContract, runVerdict, stopRuleFor, subshellOnly, treeDigest, writeRuleFor,
  type EvalTurn, type JudgeLine, type RunVerdict, type RuntimeExclusion, type StopCheck,
} from "./onboarding-eval-lib.js";
import { parseStream, sha256 } from "./continuity-lib.js";
import { applySetupReviewChecks, STORE_COPY, STORE_COPY_MISSING } from "./onboarding-eval-checkset6.js";
import { applySetupRunChecks, cs7FinalLedger, cs7SnapshotLedger, type EvidenceObservation, type FollowUp } from "./onboarding-eval-checkset7.js";
import {
  applySessionChecks, baseVariant, gatedTicket, isDemoVariant, isSessionVariant, laterSessions, NO_FACTS, OBSERVATIONS_RAW, parseSessionsFile, sessionSpans, SESSIONS_RAW, SessionsError,
  type HarnessFacts, type SessionScript, type SessionsFile,
} from "./onboarding-eval-sessions.js";
import { EventsLogError, parseEventsLog } from "./onboarding-eval-checkset7-events.js";
import { parseServedLines, REVIEW_FAILURE_PREFIX, SERVED_RAW, type ServedLine } from "./onboarding-eval-review.js";
import { FAULT_RAW, protectedPathsOf, provisionedLockfiles } from "./onboarding-eval-preserve.js";
import { parseStateRecords, STATE_FILE, STATES_RAW, type StateRecord } from "./onboarding-eval-states.js";
import { HOST_CHECKS_RAW, launchHeld, serverLaunchFailure, type ServerLaunchLine, type TurnHostChecks } from "./onboarding-eval-host.js";
import { initEventConsulted, initEventProblems, readbackProblems, type ReadbackExpected, type ReadbackStep } from "./headless-policy.js";
import {
  inventoryFor,
  driveFlow, finishDrive, inspectAfter, newDriveState, packetText as buildPacketText, setupRecordFrom, writesAfterApprovalOf,
  type DriveTurn, type FailureSource, type PackageTurn, type Rubric, type StoryReader, type TurnResponse, type Variant,
} from "./onboarding-eval-drive.js";

export const UNPARSED_PREFIX = "needs review, shell construct not parsed: ";
export const G1 = "consistency validation against the stored raw, not historical authenticity: no manifest was recorded at run time";
export const G2 = "every byte of every file the pending revision read is unchanged";
export const OPAQUE_LIMIT = "failures present in the supplied record are preserved; for the infrastructure and tree failures, deletion of an opaque failure together with its retained source field before the first regrade is not detectable without a run-time record hash";
const OPAQUE_INFRA = /^(?:timed out after \d+ ms|spawn failed: .+|killed by \S+|exit -?\d+)$/;
const HOST_V2_OPAQUE = /^(?:input|cleanup): .+$/;

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
  /** Check set 7: the fixture's own ledger before the run, read from pinned files. */
  readonly baseline?: { readonly baselineIds: readonly string[]; readonly baselinePhases: readonly string[] };
  /** Check set 7: the owner's approval, as the variant's script sends it. */
  readonly approval?: string;
  /** T-538 S5a: a session variant's later owner turns, from the same owner script. */
  readonly sessionScript?: SessionScript;
}

/** Check set 7's raw inputs, by their names in the raw directory (run.ts writes them). */
export const EVENTS_RAW = "events.jsonl";
export const SNAPSHOT_RAW = "setup-snapshot.json";
export const INVOCATIONS_RAW = "invocations.json";

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
  /** T-538 6.2: every entry under the raw directory's `states/` folder, by raw-relative name. */
  readonly stateNames?: readonly string[];
  /** T-538 6.2: milestone-states' records recomputed from their copies (withRecomputedStates); absent when not recomputed. */
  readonly recomputedStates?: readonly StateRecord[];
  /** The raw copy of the project's `.story/` after the run, or null when it has none. */
  readonly story: StoryBytes | null;
  /** Check set 6: the run's copy of its setup review store, or null when the raw directory has none. */
  readonly setupReviewStore?: string | null;
  readonly fixture: FixtureInputs;
  readonly reviewLine: string;
  /** The runner's `runSemanticLines`, for the fixture's variant. */
  readonly semanticLines: (reviewSkipped: boolean, turns: readonly DriveTurn[], exclusion: RuntimeExclusion, adjusted: boolean, checkSet: number, reviewLines: readonly string[], judgeLines: readonly string[]) => string[];
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
/** Check set 5 (B3): an instruction context is `{status: "observed", sha256, cliVersion}` or `{status: "unknown"}`, nothing else. */
function validInstructionContext(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (o.status === "unknown") return keys === "status";
  return o.status === "observed" && keys === "cliVersion,sha256,status" && typeof o.sha256 === "string" && /^[0-9a-f]{64}$/.test(o.sha256) && (o.cliVersion === null || typeof o.cliVersion === "string");
}

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

interface Set7Inputs {
  /** T-538 S5a: a session variant's sessions file and (milestone-demo) evidence observations, as read; null otherwise. */
  readonly sessions: string | null;
  readonly observations: readonly EvidenceObservation[] | null;
  readonly events: string;
  readonly snapshot: string | null;
  readonly projectRoot: string;
  readonly mapping: unknown;
  readonly entries: readonly ManifestEntry[];
  /** T-538 commit 1: a host-v2 Claude record's readback per turn file stem, and what its launch expected. */
  readonly readbacks: ReadonlyMap<string, { readonly steps: readonly ReadbackStep[]; readonly permissionDenials: unknown; readonly expected: ReadbackExpected }>;
  /** T-538 5.1 and 5.2: a host-v2 record's host checks per turn file stem; every server launch named is a held launch line in the events log. */
  readonly hostChecks: ReadonlyMap<string, TurnHostChecks>;
  /** P1: each turn's replayed server launch failure (serverLaunchFailure over the launches it names), by file stem. */
  readonly serverFailures: ReadonlyMap<string, string | null>;
  /** 5.5: the served commands of a host-v2 record; null for any other. */
  readonly served: readonly ServedLine[] | null;
  /** T-538 6.1: a fault run's tree snapshots by raw name, each pinned; the session checks find a missing one. */
  readonly faults: ReadonlyMap<string, string>;
  /** T-538 6.2: milestone-states' recorded boundary records, equal to their recompute; null for any other variant. */
  readonly states: readonly StateRecord[] | null;
}

/** A host-v2 record's claudeLaunch, refused unless every field has its shape. */
function claudeLaunchOf(record: Record<string, unknown>): { project: string; roots: string[]; policy: Record<string, unknown>; mcpLaunch: { command: string; args: string[] }; toolSets: Record<string, string[]> } {
  const l = record.claudeLaunch as Record<string, unknown> | undefined;
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
  const launch = l?.mcpLaunch as Record<string, unknown> | undefined;
  const sets = l?.toolSets as Record<string, unknown> | undefined;
  if (l === undefined || l === null || typeof l !== "object" || typeof l.project !== "string" || !strings(l.roots) || l.policy === null || typeof l.policy !== "object"
    || launch === undefined || launch === null || typeof launch.command !== "string" || !strings(launch.args)
    || sets === undefined || sets === null || typeof sets !== "object" || !Object.values(sets).every(strings)) {
    return refuse("the host-v2 Claude record has no valid claudeLaunch");
  }
  return l as unknown as ReturnType<typeof claudeLaunchOf>;
}

/**
 * Check set 7's raw inputs, refused by name when one the record requires is
 * missing, malformed, not the bytes its recorded hash names, or incomplete. A
 * file's absence never skips a rule: the run is not regraded at all.
 */
function set7Inputs(input: RegradeInput, record: Record<string, unknown>): Set7Inputs {
  const pinned = record.replayInputs;
  if (!Array.isArray(pinned) || pinned.some((e) => e === null || typeof e !== "object" || typeof (e as ManifestEntry).path !== "string" || typeof (e as ManifestEntry).sha256 !== "string")) {
    return refuse("the check set 7 record names no replay inputs");
  }
  const hashOf = new Map((pinned as ManifestEntry[]).map((e) => [e.path, e.sha256]));
  const read = (name: string, required: boolean): Buffer | null => {
    const recorded = hashOf.get(name);
    const present = input.rawNames.includes(name);
    if (!present) return required || recorded !== undefined ? refuse(`replay input ${name} is missing`) : null;
    if (recorded === undefined) return refuse(`replay input ${name} is not named in the record's replay inputs`);
    const bytes = input.readRaw(name);
    if (sha256(bytes) !== recorded) refuse(`replay input ${name} does not match its recorded sha256`);
    return bytes;
  };
  const eventsBytes = read(EVENTS_RAW, true)!;
  const events = eventsBytes.toString("utf-8");
  let log: ReturnType<typeof parseEventsLog>;
  try {
    log = parseEventsLog(events);
  } catch (err) {
    if (err instanceof EventsLogError) return refuse(`replay input ${EVENTS_RAW} is malformed or incomplete: ${err.message}`);
    throw err;
  }
  const archive = log.events.find((e) => e.point === "archive-committed");
  const stepArchive = log.events.find((e) => e.point === "step:archive");
  if (stepArchive !== undefined && archive === undefined) refuse(`replay input ${EVENTS_RAW} is incomplete: step:archive with no archive-committed`);
  if (stepArchive !== undefined && archive !== undefined && stepArchive.snapshotSha256 !== archive.snapshotSha256) refuse(`replay input ${EVENTS_RAW} is incomplete: step:archive and archive-committed name different snapshots`);
  // A pinned snapshot is completion evidence; a log that lost the commit naming it is incomplete, not a run that never finished.
  if (archive === undefined && hashOf.has(SNAPSHOT_RAW)) refuse(`replay input ${EVENTS_RAW} is incomplete: the record pins ${SNAPSHOT_RAW} but the log has no archive-committed`);
  const snapshotBytes = read(SNAPSHOT_RAW, archive !== undefined);
  if (snapshotBytes !== null && archive !== undefined && sha256(snapshotBytes) !== archive.snapshotSha256) refuse(`replay input ${SNAPSHOT_RAW} is not the snapshot archive-committed names`);
  const invocationsBytes = read(INVOCATIONS_RAW, true)!;
  let invocations: { projectRoot?: unknown; mapping?: unknown };
  try { invocations = JSON.parse(invocationsBytes.toString("utf-8")) as typeof invocations; } catch { return refuse(`replay input ${INVOCATIONS_RAW} is malformed`); }
  if (invocations === null || typeof invocations.projectRoot !== "string" || !Array.isArray(invocations.mapping)) refuse(`replay input ${INVOCATIONS_RAW} is malformed`);
  const entries: ManifestEntry[] = [
    { path: EVENTS_RAW, sha256: sha256(eventsBytes) },
    { path: INVOCATIONS_RAW, sha256: sha256(invocationsBytes) },
    ...(snapshotBytes !== null ? [{ path: SNAPSHOT_RAW, sha256: sha256(snapshotBytes) }] : []),
  ];
  // T-538 S5a: the session variants' own inputs, required by the variant.
  const variant = String(record.variant);
  const sessionsBytes = isSessionVariant(variant) ? read(SESSIONS_RAW, true) : null;
  const observationsBytes = isDemoVariant(variant) ? read(OBSERVATIONS_RAW, true) : null;
  let observations: EvidenceObservation[] | null = null;
  if (observationsBytes !== null) {
    try { observations = JSON.parse(observationsBytes.toString("utf-8")) as EvidenceObservation[]; } catch { return refuse(`replay input ${OBSERVATIONS_RAW} is malformed`); }
    if (!Array.isArray(observations) || observations.some((x) => x === null || typeof x !== "object" || typeof x.ref !== "string" || typeof x.sha256 !== "string" || x.at === null || typeof x.at !== "object" || !Number.isInteger(x.at.index))) refuse(`replay input ${OBSERVATIONS_RAW} is malformed`);
    entries.push({ path: OBSERVATIONS_RAW, sha256: sha256(observationsBytes) });
  }
  if (sessionsBytes !== null) entries.push({ path: SESSIONS_RAW, sha256: sha256(sessionsBytes) });
  // T-538 commit 1 (plan 6.4): a host-v2 Claude turn's readback is a replay input, one per turn, required.
  const readbacks = new Map<string, { steps: ReadbackStep[]; permissionDenials: unknown; expected: ReadbackExpected }>();
  if (record.route === "host-v2" && record.client === "claude") {
    const launch = claudeLaunchOf(record);
    const turns = Array.isArray(record.turns) ? record.turns as { label?: unknown }[] : [];
    turns.forEach((t, i) => {
      const stem = turnFile(i, String(t.label));
      const name = `${stem}.readback.json`;
      const bytes = read(name, true)!;
      let v: { steps?: unknown; permissionDenials?: unknown };
      try { v = JSON.parse(bytes.toString("utf-8")) as typeof v; } catch { return refuse(`replay input ${name} is malformed`); }
      if (v === null || typeof v !== "object" || !Array.isArray(v.steps)) refuse(`replay input ${name} is malformed`);
      const tools = Object.hasOwn(launch.toolSets, name) ? launch.toolSets[name] : undefined;
      if (tools === undefined) refuse(`the record's claudeLaunch names no tool set for ${name}`);
      readbacks.set(stem, {
        steps: v.steps as ReadbackStep[], permissionDenials: v.permissionDenials ?? null,
        expected: { project: launch.project, roots: launch.roots, policy: launch.policy, mcpTools: tools!, mcpLaunch: launch.mcpLaunch },
      });
      entries.push({ path: name, sha256: sha256(bytes) });
    });
  }
  const hostChecks = new Map<string, TurnHostChecks>();
  const serverFailures = new Map<string, string | null>();
  if (record.route === "host-v2") {
    const bytes = read(HOST_CHECKS_RAW, true)!;
    let v: { toolsSha256?: unknown; turns?: unknown };
    try { v = JSON.parse(bytes.toString("utf-8")) as typeof v; } catch { return refuse(`replay input ${HOST_CHECKS_RAW} is malformed`); }
    if (v === null || typeof v !== "object" || typeof v.toolsSha256 !== "string" || !Array.isArray(v.turns)) refuse(`replay input ${HOST_CHECKS_RAW} is malformed`);
    const sha = v.toolsSha256 as string;
    // Every tool server launch in the events log, in log order; each turn names the ones it added.
    const mcpLaunches = log.attempts.filter((a) => a.entry === "mcp");
    const byId = new Map<string, ServerLaunchLine>(mcpLaunches.map((a) => [a.attempt, a]));
    const named: string[] = [];
    // F1: one host-check entry per recorded turn, named as that turn's file, in turn order: an entry no turn has
    // would never reach the replay's per-turn check, so a launch it carries would go unchecked.
    const turnFiles = (Array.isArray(record.turns) ? record.turns as { label?: unknown }[] : []).map((t, i) => turnFile(i, String(t.label)));
    const entryFiles = (v.turns as unknown[]).map((t) => (t !== null && typeof t === "object" ? (t as Record<string, unknown>).file : undefined));
    if (!same(entryFiles, turnFiles)) refuse(`replay input ${HOST_CHECKS_RAW}: the host checks do not name the record's turns, each once and in turn order`);
    for (const t of v.turns as Record<string, unknown>[]) {
      const lo = t?.leftover as Record<string, unknown> | undefined;
      const strings = (x: unknown): boolean => Array.isArray(x) && x.every((y) => typeof y === "string");
      const ok = t !== null && typeof t === "object" && typeof t.file === "string" && strings(t.servers) && strings(t.launches)
        && lo !== null && typeof lo === "object" && (lo.status === "clean" ? lo.reason === null : (lo.status === "holders" || lo.status === "failed") && typeof lo.reason === "string" && lo.reason !== "")
        && (t.limit === null || (typeof t.limit === "string" && t.limit.startsWith("limit: ")))
        && (t.review === null || (typeof t.review === "string" && t.review.startsWith(REVIEW_FAILURE_PREFIX)));
      if (!ok || hostChecks.has(t.file as string)) refuse(`replay input ${HOST_CHECKS_RAW} is malformed`);
      const launches = (t.launches as string[]).map((id) => byId.get(id) ?? refuse(`replay input ${HOST_CHECKS_RAW}: turn ${String(t.file)} names server launch ${id}, which the events log does not hold`));
      for (const id of t.servers as string[]) if (!launches.some((l) => l.attempt === id && launchHeld(l, sha))) refuse(`replay input ${HOST_CHECKS_RAW}: turn ${String(t.file)} names server launch ${id}, which the events log does not hold as a sandboxed launch with the pinned inventory`);
      const held = launches.filter((l) => launchHeld(l, sha)).map((l) => l.attempt);
      if (!same(held, t.servers)) refuse(`replay input ${HOST_CHECKS_RAW}: turn ${String(t.file)} leaves out held server launches it names as launched`);
      named.push(...(t.launches as string[]));
      hostChecks.set(t.file as string, t as unknown as TurnHostChecks);
      serverFailures.set(t.file as string, serverLaunchFailure(launches, sha));
    }
    // The turns, in order, name every server launch in the events log exactly once and in log order, so no launch is left out of the turn that added it.
    if (!same(named, mcpLaunches.map((a) => a.attempt))) refuse(`replay input ${HOST_CHECKS_RAW}: the turns do not name the events log's server launches, each once and in log order`);
    entries.push({ path: HOST_CHECKS_RAW, sha256: sha256(bytes) });
  }
  // 5.5: a host-v2 record carries its served commands, empty when none ran.
  let served: ServedLine[] | null = null;
  if (record.route === "host-v2") {
    const bytes = read(SERVED_RAW, true)!;
    const parsed = parseServedLines(bytes.toString("utf-8"));
    if ("problem" in parsed) refuse(`replay input ${SERVED_RAW} is malformed: ${parsed.problem}`);
    served = (parsed as { lines: ServedLine[] }).lines;
    entries.push({ path: SERVED_RAW, sha256: sha256(bytes) });
  }
  // T-538 6.1: every fault snapshot the record pins or the raw directory holds is read against its pin (a pinned
  // one missing, an unpinned one present, or edited bytes each refuse); which ones the run needs is the session checks'.
  const faults = new Map<string, string>();
  for (const name of [...new Set([...hashOf.keys(), ...input.rawNames])].filter((n) => FAULT_RAW.test(n)).sort()) {
    const bytes = read(name, false)!;
    faults.set(name, bytes.toString("utf-8"));
    entries.push({ path: name, sha256: sha256(bytes) });
  }
  // T-538 6.2: milestone-states' records file and every capture copy, each read against its pin (nested names are
  // read directly; a present one the record does not pin refuses), then the records against their recompute.
  let states: StateRecord[] | null = null;
  const statesBytes = read(STATES_RAW, variant === "milestone-states");
  if (statesBytes !== null) {
    try { states = parseStateRecords(statesBytes.toString("utf-8")); } catch (err) { return refuse(`replay input ${STATES_RAW} is malformed: ${err instanceof Error ? err.message : String(err)}`); }
    entries.push({ path: STATES_RAW, sha256: sha256(statesBytes) });
  }
  for (const name of input.stateNames ?? []) if (!hashOf.has(name)) refuse(`replay input ${name} is not named in the record's replay inputs`);
  for (const [name, recorded] of [...hashOf].filter(([n]) => STATE_FILE.test(n)).sort(([a], [b]) => a.localeCompare(b))) {
    if (input.stateNames !== undefined && !input.stateNames.includes(name)) refuse(`replay input ${name} is missing`);
    let bytes: Buffer;
    try { bytes = input.readRaw(name); } catch { return refuse(`replay input ${name} is missing`); }
    if (sha256(bytes) !== recorded) refuse(`replay input ${name} does not match its recorded sha256`);
    entries.push({ path: name, sha256: recorded });
  }
  if (states !== null) {
    if (input.recomputedStates === undefined) refuse(`the ${STATES_RAW} records were not recomputed from their copies`);
    if (!same(states, input.recomputedStates)) refuse(`${STATES_RAW} differs from the records its copies give`);
  }
  for (const name of hashOf.keys()) if (!entries.some((e) => e.path === name)) refuse(`the record names replay input ${name}, which check set 7 does not read`);
  return {
    faults, states,
    events, snapshot: snapshotBytes === null ? null : snapshotBytes.toString("utf-8"), projectRoot: invocations.projectRoot as string, mapping: invocations.mapping, entries,
    sessions: sessionsBytes === null ? null : sessionsBytes.toString("utf-8"), observations, readbacks, hostChecks, serverFailures, served,
  };
}

interface RecordTurn {
  label: string; prompt: string; stop: StopCheck | null; stopText: string; models: string[]; exitCode: number | null;
  infraFailure: string | null; treeChanges: string[]; callRange: [number, number]; unparsed?: unknown; session?: unknown; afterSetup?: unknown;
}

/** An infrastructure failure the record states for a turn, checked against the turn's terminal in the runner's precedence. */
function checkInfrastructure(index: number, infra: string | null, turn: EvalTurn, hostV2 = false): void {
  // T-538 commit 1: a launch failure is checked against the replayed readback (checkLaunch), and only a host-v2 record has one.
  if (hostV2 && infra !== null && infra.startsWith("launch: ")) return;
  // An input or cleanup failure is the group's own report; the raw cannot establish it, and only the host-v2 runner records one.
  if (hostV2 && infra !== null && HOST_V2_OPAQUE.test(infra)) return;
  // 5.1: a limit is replayed against the turn's host checks (checkHost).
  if (hostV2 && infra !== null && infra.startsWith("limit: ")) return;
  // 5.5: so is the request folder's failure.
  if (hostV2 && infra !== null && infra.startsWith(REVIEW_FAILURE_PREFIX)) return;
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

/**
 * T-538 commit 1: re-runs 4.4's comparison on the stored readback against the record's expected values. A
 * recorded launch failure must be the first problem the replay finds (the readback's, else the init event's
 * once the turn ended on its own); a turn recorded with no failure, or a later one, must find none. The
 * recorded permission denials must be the raw result's.
 */
function checkLaunch(index: number, rec: { infraFailure: string | null; exitCode: number | null }, rb: NonNullable<ReturnType<Set7Inputs["readbacks"]["get"]>>, raw: string, serverFailure: string | null): void {
  const infra = rec.infraFailure;
  const events = parseStream(raw).events as unknown as Record<string, unknown>[];
  const result = events.find((e) => e.type === "result");
  if (!same(rb.permissionDenials, result?.permission_denials ?? null)) refuse(`turn ${index}: the readback's permission denials are not the raw result's`);
  if (infra !== null && infra.startsWith("spawn failed: ")) return;
  const readback = readbackProblems(rb.steps, rb.expected);
  // The runner's own predicate (initEventConsulted): exit 0 with no failure, launch, terminal or cleanup, each of
  // which implies no timeout and no signal by the failure order. Never for input: the prompt was not delivered.
  // T-538 5.2: after the readback, the turn's server launches (serverLaunchFailure), then the init event.
  const first = readback[0] ?? serverFailure ?? (initEventConsulted(infra, rec.exitCode) ? initEventProblems(events, rb.expected.mcpTools)[0] : undefined) ?? null;
  const replayed = first === null ? null : `launch: ${first}`;
  if (infra !== null && infra.startsWith("launch: ")) {
    if (infra !== replayed) refuse(`turn ${index}: the recorded launch failure "${infra}" is not the replayed readback's ${replayed === null ? "clean result" : `"${replayed}"`}`);
    return;
  }
  if (replayed !== null) refuse(`turn ${index}: the replayed readback finds "${replayed}", but the record states ${infra === null ? "no infrastructure failure" : `"${infra}"`}`);
}

/**
 * T-538 5.1: a turn's recorded failure against its host checks, by the runner's failure order (spawn, launch,
 * input, limit, timed out, exit, terminal, group cleanup, leftover). A limit the turn passed is the failure
 * unless spawn, launch or input outranks it; a leftover or a failed leftover check means the turn cannot be
 * clean, and a recorded leftover must be the one the checks name.
 */
function checkHost(index: number, infra: string | null, hc: TurnHostChecks): void {
  const outranks = (x: string): boolean => x.startsWith("spawn failed: ") || x.startsWith("launch: ") || x.startsWith("input: ");
  if (infra !== null && infra.startsWith("limit: ") && infra !== hc.limit) refuse(`turn ${index}: the recorded limit "${infra}" is not the host checks' ${hc.limit === null ? "no limit" : `"${hc.limit}"`}`);
  if (hc.limit !== null && infra !== hc.limit && (infra === null || !outranks(infra))) refuse(`turn ${index}: the host checks name "${hc.limit}", but the record states ${infra === null ? "no infrastructure failure" : `"${infra}"`}`);
  // 5.5: the request folder's failure ranks right after the limit.
  if (infra !== null && infra.startsWith(REVIEW_FAILURE_PREFIX) && infra !== hc.review) refuse(`turn ${index}: the recorded "${infra}" is not the host checks' ${hc.review === null ? "no request folder failure" : `"${hc.review}"`}`);
  if (hc.review !== null && hc.limit === null && infra !== hc.review && (infra === null || !outranks(infra))) refuse(`turn ${index}: the host checks name "${hc.review}", but the record states ${infra === null ? "no infrastructure failure" : `"${infra}"`}`);
  const leftover = hc.leftover.status === "clean" ? null : `cleanup: ${hc.leftover.reason}`;
  if (leftover !== null && infra === null) refuse(`turn ${index}: the host checks find "${leftover}", but the record states no infrastructure failure`);
  if (infra !== null && infra.startsWith("cleanup: ") && !infra.startsWith("cleanup: unconfirmed") && infra !== leftover) refuse(`turn ${index}: the recorded "${infra}" is not the host checks' ${leftover === null ? "clean leftover check" : `"${leftover}"`}`);
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
  const recordVariant = String(record.variant);
  const session = isSessionVariant(recordVariant) ? recordVariant : null;
  const variant = baseVariant(recordVariant as Variant);
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
  if (versions?.stop !== stopRuleFor(checkSet as number) || versions.write !== writeRuleFor(checkSet as number)) refuse("the run was graded under a stop or write rule version this regrade does not support");
  if ((recordSet === undefined) !== (versions?.checkSet === undefined) || (recordSet !== undefined && versions?.checkSet !== recordSet)) refuse("the record and packet name different check sets");
  if (input.fixture.checkSet !== checkSet) refuse(`the fixture inputs were read for check set ${input.fixture.checkSet}, the record names ${String(checkSet)}`);
  const cs = checkSet as number;
  const recFailures = failures!;
  // Check set 6: rule 2 reads the store the run's turns wrote, so the run's copy of it is an input.
  if (cs >= 6 && (input.setupReviewStore ?? null) === null) refuse(STORE_COPY_MISSING);
  // Check set 7: the events log, the invocation mapping and (once the archive committed) its snapshot, checked before any replay.
  if (record.route !== undefined && (record.route !== "host-v2" || cs < 7)) refuse(`the record's route ${String(record.route)} is not one this regrade supports`);
  const set7 = cs >= 7 ? set7Inputs(input, record) : null;

  // Turn identity: position is identity, the file name is fixed by it, and nothing else may sit beside them.
  const manifest: ManifestEntry[] = [];
  const expected = new Set<string>(cs >= 6 ? ["project.after", STORE_COPY] : ["project.after"]);
  if (set7 !== null) for (const e of set7.entries) expected.add(e.path);
  if (set7 !== null && set7.entries.some((e) => e.path.startsWith("states/"))) expected.add("states");
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
  // T-538 S5a: the later sessions, from the recorded harness facts; their spans are checked against the replay below.
  const readSessions = (): SessionsFile => {
    try {
      const v = JSON.parse(set7!.sessions!) as { harness?: Partial<HarnessFacts> };
      if (v === null || typeof v !== "object" || v.harness === null || typeof v.harness !== "object") throw new SessionsError("has no harness facts");
      return { sessions: [], harness: { ...NO_FACTS, ...v.harness } };
    } catch (err) {
      return refuse(`replay input ${SESSIONS_RAW} is malformed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const later = session === null ? undefined : () => {
    if (input.fixture.sessionScript === undefined) refuse("a session variant needs the fixture's owner script for its later sessions");
    const harness = readSessions().harness;
    // 6.1: a scheduled run has one later session per armed one; a run before 6.1 has no schedule and one.
    const armed = Array.isArray(harness.schedule) && harness.schedule.length > 0 ? harness.schedule.length : 1;
    return laterSessions(session, client === "claude" ? "/story" : "$story", input.fixture.sessionScript!, harness.dependent, armed);
  };
  const flow = driveFlow({ variant, firstPrompt: input.fixture.firstPrompt, discoveryPrompt: input.fixture.discoveryPrompt, afterPackage: input.fixture.afterPackage, exclusion, ...(later !== undefined ? { later } : {}) }, state);
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
    const hostV2 = record.route === "host-v2";
    checkInfrastructure(consumed, rec!.infraFailure, turn, hostV2);
    const rb = set7?.readbacks.get(file);
    const hc = set7?.hostChecks.get(file);
    if (hostV2) {
      if (hc === undefined) refuse(`turn ${consumed}: the host-v2 record has no host checks for ${file}`);
      checkHost(consumed, rec!.infraFailure, hc!);
    }
    if (hostV2 && client === "claude") {
      if (rb === undefined) refuse(`turn ${consumed}: the host-v2 record has no readback for ${file}`);
      checkLaunch(consumed, rec!, rb!, raw, set7!.serverFailures.get(file) ?? null);
    } else if (hostV2) {
      // A Codex turn's only launch check is the server launch (5.2); only a spawn failure outranks it.
      const infra = rec!.infraFailure;
      const failure = set7!.serverFailures.get(file) ?? null;
      const replayed = failure === null ? null : `launch: ${failure}`;
      if (infra === null || !infra.startsWith("spawn failed: ")) {
        if (infra !== null && infra.startsWith("launch: ") && infra !== replayed) refuse(`turn ${consumed}: the recorded launch failure "${infra}" is not the replayed host checks' ${replayed === null ? "clean result" : `"${replayed}"`}`);
        if (replayed !== null && infra !== replayed) refuse(`turn ${consumed}: the host checks find "${replayed}", but the record states ${infra === null ? "no infrastructure failure" : `"${infra}"`}`);
      }
    } else if (rec!.infraFailure !== null && rec!.infraFailure.startsWith("launch: ")) {
      refuse(`turn ${consumed}: unrecognised infrastructure failure "${rec!.infraFailure}"`);
    }
    const response: TurnResponse = {
      turn, exitCode: rec!.exitCode, infraFailure: rec!.infraFailure,
      stderrPath: stderrPathOf(recFailures, runId, rec!.label, rec!.infraFailure, file),
      treeChanges: () => rec!.treeChanges,
    };
    consumed++;
    step = flow.next(response);
  }
  if (consumed !== recTurns.length) refuse(`the record has ${recTurns.length} turns, the flow ends after ${consumed}`);
  if (cs >= 6) {
    const store = input.setupReviewStore!;
    applySetupReviewChecks(state, store, variant, set7?.served ?? null);
    for (const [k, v] of Object.entries(treeDigest(store)).sort(([a], [b]) => a.localeCompare(b))) manifest.push({ path: `${STORE_COPY}/${k}`, sha256: v });
  }
  if (set7 !== null) {
    const fixture = input.fixture;
    if (fixture.baseline === undefined || fixture.approval === undefined) refuse("check set 7 needs the fixture's baseline ledger and approval");
    const seen7 = new Map<string, string>();
    const r = applySetupRunChecks(state, {
      eventsText: set7.events, snapshotText: set7.snapshot,
      final: cs7FinalLedger(input.story === null ? EMPTY_STORY : recordingReader(input.story, seen7)),
      baselineIds: fixture.baseline!.baselineIds, baselinePhases: fixture.baseline!.baselinePhases, approval: fixture.approval!,
      projectRoot: set7.projectRoot, contract: recipeContract(fixture.rubric.expectedRecipe), observations: set7.observations,
      followUp: (fixture.rubric as { followUp?: FollowUp }).followUp ?? null,
    });
    if (!same(r.invocations, set7.mapping)) refuse(`${INVOCATIONS_RAW} differs from the mapping the replayed run produces`);
    if (session !== null) {
      // A run whose setup never reached approval asked for no later session; its sessions file is still read whole.
      let parsed: SessionsFile;
      try { parsed = parseSessionsFile(set7.sessions!, state.turns.length, state.allCalls.length); } catch (err) {
        if (err instanceof SessionsError) return refuse(`replay input ${SESSIONS_RAW} is malformed: ${err.message}`);
        throw err;
      }
      if (!same(parsed.sessions, sessionSpans(state.turns))) refuse(`${SESSIONS_RAW} differs from the sessions the replayed run produces`);
      const atSetup = set7.snapshot === null ? [] : cs7SnapshotLedger(set7.snapshot).tickets;
      const followUp = (fixture.rubric as { followUp?: FollowUp }).followUp;
      if (isDemoVariant(session) && parsed.harness.dependent !== (followUp === undefined ? null : gatedTicket(atSetup, followUp.checkpoint))) refuse(`${SESSIONS_RAW} names a dependent the setup snapshot does not gate`);
      applySessionChecks(state, {
        variant: session, harness: parsed.harness, log: parseEventsLog(set7.events), mapping: r.invocations,
        tickets: input.story === null ? [] : cs7FinalLedger(recordingReader(input.story, seen7)).tickets, ticketsAtSetup: atSetup,
        present: (name) => input.rawNames.includes(name),
        faults: { read: (name) => set7.faults.get(name) ?? null, protectedPaths: [...protectedPathsOf(input.fixture.files), ...provisionedLockfiles(record.dependencyInstalls)].sort() },
        ...(session === "milestone-states" ? { states: set7.states, followUpTitle: followUp?.titlePattern ?? null } : {}),
      });
      if (set7.states !== null) {
        // 6.2: the records' boundaries and dependent are the replay's: one before each later-session turn, then after the last.
        const at = [...state.turns.filter((t) => (t.session ?? 1) >= 2).map((t) => t.label), "after-last"];
        if (!same(set7.states.map((x) => x.at), at)) refuse(`${STATES_RAW} names boundaries the replayed run does not have`);
        if (set7.states.some((x) => (x.dependent?.id ?? null) !== parsed.harness.dependent)) refuse(`${STATES_RAW} names a dependent other than the sessions file's`);
      }
    }
    manifest.push(...set7.entries);
    for (const [k, v] of [...seen7].sort(([a], [b]) => a.localeCompare(b))) manifest.push({ path: `project.after/.story#cs7:${k}`, sha256: v });
  }

  const evidence = finishDrive(state, input.reviewLine);
  const semanticLines = input.semanticLines(state.reviewSkipped, state.turns, exclusion, input.fixture.afterPackage.some((x) => x.label === "adjust"), cs, evidence.reviewLines, evidence.judgeLines ?? []);
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
    for (const k of ["label", "prompt", "stop", "stopText", "exitCode", "infraFailure", "treeChanges", "callRange", "session", "afterSetup"] as const) {
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
    // Check set 4 (G2): the reviewer capability the run shows.
    ...(cs >= 4 ? [["reviewerCapability", evidence.reviewerCapability] as [string, unknown]] : []),
    // Check set 5: the fixture contract's reviewer inventory and the citations outside the package.
    ...(cs >= 5 ? [["reviewerInventory", inventoryFor(variant)], ["skillCitations", evidence.skillCitations ?? []]] as [string, unknown][] : []),
  ];
  // Check set 5 (B3): the instruction context is the client's rollout, which the raw does not carry: only its shape is checked.
  if (cs >= 5 && !validInstructionContext(record.instructionContext)) refuse("the record's instructionContext is not an observed sha256 or unknown");
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
  const regradeEvidenceHash = evidenceHash({ originalRecordSha256, packetSha256, manifest, candidates, stopRuleVersion: stopRuleFor(cs), writeRuleVersion: writeRuleFor(cs), guarantee: G1, status: verdict === "FAIL" ? "fail" : "pending", ...setField });
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
      manifest: g.manifest, stopRuleVersion: stopRuleFor(g.checkSet ?? 1), writeRuleVersion: writeRuleFor(g.checkSet ?? 1), guarantee: G1, limitation: OPAQUE_LIMIT, regradedAt: now(),
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
    const judgedHash = evidenceHash({ originalRecordSha256: g.originalRecordSha256, packetSha256: g.packetSha256, manifest: g.manifest, candidates: g.candidates, stopRuleVersion: stopRuleFor(g.checkSet ?? 1), writeRuleVersion: writeRuleFor(g.checkSet ?? 1), guarantee: G2, status: "judged", checkSet: g.checkSet });
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
