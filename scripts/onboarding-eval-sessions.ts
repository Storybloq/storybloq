/**
 * T-538 S5a C3: the multi-session variants. Session 1 is the ordinary setup
 * flow (the `none` owner script); each later session is a fresh client
 * process, with no resume, opened with the skill. Between sessions the
 * harness acts on the project itself (a ledger edit, a demo run, a report
 * read, evidence observations) and records what it saw in `sessions.json`,
 * so a regrade reads the same facts the run graded.
 *
 * Every check here is a pure function of the run's turns, its events log,
 * its invocation mapping, its final ledger and those harness facts.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { readTurnStop, stopRoute, type StopKind } from "./onboarding-eval-lib.js";
import { flagValue, type EventsLog, type InvocationMapping } from "./onboarding-eval-checkset7-events.js";
import { cs7TurnsFrom, findCheckpoint, type CheckpointSpec, type EvidenceObservation } from "./onboarding-eval-checkset7.js";
import type { DriveState, Variant } from "./onboarding-eval-drive.js";
import { parseSetupMeta } from "../src/core/setup-meta.js";
import { readBounded, walkNoFollow, type WalkHook } from "./onboarding-eval-walk.js";
import { checkSchedule, parseSelector, pointMatches, type ScheduleFact } from "./onboarding-eval-schedule.js";
import { STATES_RAW, statesFindings, type StateRecord } from "./onboarding-eval-states.js";
import { EDITED_RAW, editedSnapshotFindings, END_RAW, killRaw, parseTreeSnap, preservationFindings, type TreeSnap } from "./onboarding-eval-preserve.js";

export const SESSION_VARIANTS = ["interrupted", "interrupted-edited", "milestone-demo", "milestone-states", "empty-idea-verify", "restart"] as const;
export type SessionVariant = (typeof SESSION_VARIANTS)[number];

export const isSessionVariant = (v: string): v is SessionVariant => (SESSION_VARIANTS as readonly string[]).includes(v);

/** The variants that take `--fault`: the fault is set in session 1 only. */
export const isFaultVariant = (v: string): boolean => v === "interrupted" || v === "interrupted-edited";

/** T-538 6.2: the variants that run a milestone, show its demo and try the checkpoint's gate afterwards. */
export const isDemoVariant = (v: string | null): boolean => v === "milestone-demo" || v === "milestone-states";

/** The variant the setup flow runs as: a session variant's setup is the plain one. */
export const baseVariant = (v: Variant | SessionVariant): Variant => (isSessionVariant(v) ? "none" : v);

/** The fixture a variant runs on, when it fixes one. */
export function variantFixture(v: SessionVariant): string | null {
  return v === "milestone-demo" ? "checkpoint-demo" : v === "milestone-states" ? "checkpoint-states" : v === "empty-idea-verify" ? "empty-idea" : null;
}

export const SESSIONS_RAW = "sessions.json";
export const OBSERVATIONS_RAW = "evidence-observations.json";

/** One owner turn of a later session. */
export interface LaterTurn {
  readonly label: string;
  readonly prompt: string;
}

/** A later session: a fresh client process, its turns in order. `setup` says it still runs the setup (a resumed one). */
export interface LaterSession {
  readonly setup: boolean;
  readonly turns: readonly LaterTurn[];
}

/** The owner's words a later session needs, from the fixture's owner-answers sections; each has a default. */
export interface SessionScript {
  /** interrupted-edited: the owner's ruling on the edited description. */
  readonly editRuling: string;
  /** milestone-demo: what the owner says to run milestone 1, after the skill invocation. */
  readonly milestoneRun: string;
  /** milestone-demo: the owner's approval of the demo. */
  readonly demoApproval: string;
  /** milestone-demo: the change the owner asks for after approval. */
  readonly changeRequest: string;
  /** milestone-states (T-538 6.2): the owner withdrawing the approval, then approving again. */
  readonly reopen: string;
  readonly reapproval: string;
}

export function sessionScript(text: string): SessionScript {
  const section = (title: RegExp): string => {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^## /.test(l) && title.test(l));
    if (start < 0) return "";
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  };
  return {
    editRuling: section(/Edit ruling turn/i) || "Keep my edited description; that is the description I want.",
    milestoneRun: section(/Milestone run turn/i) || "auto milestone 1",
    demoApproval: section(/Demo approval turn/i),
    changeRequest: section(/Change request turn/i),
    reopen: section(/Reopen turn/i),
    reapproval: section(/Reapproval turn/i),
  };
}

/**
 * The later sessions of a variant. `invoke` is the client's skill invocation
 * (`/story` or `$story`); `dependent` is the ticket the milestone checkpoint
 * gates, read from the setup snapshot (milestone-demo only).
 */
/**
 * The sessions after the first. `armed` (T-538 6.1) is how many sessions a fault schedule arms: the interrupted
 * variants then have that many later sessions, each opening the setup again, so the attempt has armed + 1 in all.
 */
export function laterSessions(v: SessionVariant, invoke: string, script: SessionScript, dependent: string | null, armed = 1): LaterSession[] {
  const reopen = (from: number): LaterSession[] => Array.from({ length: Math.max(armed - 1, 0) }, (_, i) => ({ setup: true, turns: [{ label: `session-${from + i}-open`, prompt: invoke }] }));
  switch (v) {
    case "interrupted":
      return [{ setup: true, turns: [{ label: "session-2-open", prompt: invoke }] }, ...reopen(3)];
    case "interrupted-edited":
      return [{ setup: true, turns: [{ label: "session-2-open", prompt: invoke }, { label: "edit-ruling", prompt: script.editRuling }] }, ...reopen(3)];
    case "milestone-demo":
      if (script.demoApproval === "" || script.changeRequest === "") throw new Error("milestone-demo needs the fixture's \"Demo approval turn\" and \"Change request turn\" sections");
      // With no gated dependent in the snapshot there is no targeted run; the variant check names the missing block.
      return [
        { setup: false, turns: [{ label: "milestone-run", prompt: `${invoke} ${script.milestoneRun}` }, { label: "demo-approval", prompt: script.demoApproval }, { label: "change-request", prompt: script.changeRequest }] },
        ...(dependent === null ? [] : [{ setup: false, turns: [{ label: "dependent-run", prompt: `${invoke} auto ${dependent}` }] }]),
      ];
    case "milestone-states":
      // T-538 6.2: session 2 approves, withdraws, approves again and changes the checkpoint; session 3 is the targeted run.
      if (script.demoApproval === "" || script.reopen === "" || script.reapproval === "" || script.changeRequest === "") throw new Error("milestone-states needs the fixture's \"Demo approval turn\", \"Reopen turn\", \"Reapproval turn\" and \"Change request turn\" sections");
      return [
        { setup: false, turns: [{ label: "milestone-run", prompt: `${invoke} ${script.milestoneRun}` }, { label: "demo-approval", prompt: script.demoApproval }, { label: "reopen", prompt: script.reopen }, { label: "reapproval", prompt: script.reapproval }, { label: "change-request", prompt: script.changeRequest }] },
        ...(dependent === null ? [] : [{ setup: false, turns: [{ label: "dependent-run", prompt: `${invoke} auto ${dependent}` }] }]),
      ];
    case "empty-idea-verify":
      return [{ setup: false, turns: [{ label: "build-run", prompt: `${invoke} auto` }] }];
    case "restart":
      return [{ setup: false, turns: [{ label: "restart-open", prompt: invoke }] }];
  }
}

// --- sessions.json -------------------------------------------------------------------

/** One session's turns and calls: `turns` and `calls` are half-open index ranges over the run's turns and calls. */
export interface SessionSpan {
  readonly session: number;
  readonly turns: readonly [number, number];
  readonly calls: readonly [number, number];
}

export interface DemoFacts {
  readonly command: string;
  readonly expected: string;
  readonly stdout: string;
  readonly status: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  /** 5.7: the wrapped exit form when the demo ran under the sandbox wrapper and ended by a signal inside it. */
  readonly killedBy?: string;
  readonly exitForm?: string;
}

/** The demo run as sessions.json records it, from its spawnSync result. */
export function demoFacts(command: string, expected: string, r: { readonly status: number | null; readonly signal: string | null; readonly stdout?: string | null; readonly error?: Error; readonly killedBy?: string; readonly exitForm?: string }): DemoFacts {
  return { command, expected, stdout: r.stdout ?? "", status: r.status, signal: r.signal, error: r.error?.message ?? null, ...(r.killedBy !== undefined ? { killedBy: r.killedBy, exitForm: r.exitForm } : {}) };
}

/** What the harness itself did and saw, recorded so the regrade reads the facts the run graded. */
export interface HarnessFacts {
  /** The `--fault` selector set in session 1, or null. */
  readonly fault: string | null;
  /** Whether the fault's marker existed after session 1; null when no fault was set. */
  readonly fired: boolean | null;
  /**
   * T-538 6.1: the fault schedule, one entry per armed session, each with whether its own `.fired.<id>` marker
   * existed after its session; null for a run without one (every stored run before 6.1).
   */
  readonly schedule: readonly ScheduleFact[] | null;
  /** interrupted-edited: the owner edits the harness made between the sessions. */
  readonly edits: { readonly edgeTicket: string; readonly blocker: string; readonly describedTicket: string; readonly description: string } | null;
  /** milestone-demo: the demo command, the rubric's stdout, and what the harness's own run printed and how it ended. */
  readonly demo: DemoFacts | null;
  /** milestone-demo: the ticket the milestone checkpoint gates. */
  readonly dependent: string | null;
  /** restart: the live `setup-report` lines read before the fresh session. */
  readonly report: readonly string[] | null;
  /** The setup review store's revision count for the setup, after the last session (interrupted-edited). */
  readonly storeRevisions: number | null;
  /** Whether the final config enables the TEST stage (empty-idea-verify). */
  readonly testEnabled: boolean | null;
  /** milestone-demo (T-538 S5b): the harness's own status update completing the gated dependent, after the last session. */
  readonly bypass: BypassAttempt | null;
}

/** An ordinary `ticket update --status complete` on a checkpoint-gated ticket: its exit, its output lines, and whether the ledger moved. */
export interface BypassAttempt {
  readonly ticket: string;
  readonly exitCode: number | null;
  /** Every non-empty output line, stderr's before stdout's: the CLI may print advisories ahead of its answer. */
  readonly output: readonly string[];
  readonly ledgerChanged: boolean;
  /** How a process with no exit status ended (spawnSync gives null on a signal or a timeout). */
  readonly signal?: string;
  readonly error?: string;
  /** 5.7: under the sandbox wrapper, the signal behind an exit of 128 + n, and the recorded form (Addendum B). */
  readonly killedBy?: string;
  readonly exitForm?: string;
  /** Entries of the ledger that could not be read as evidence, before or after the attempt. Absent when there are none. */
  readonly ledgerProblems?: readonly string[];
}

export const NO_FACTS: HarnessFacts = { fault: null, fired: null, schedule: null, edits: null, demo: null, dependent: null, report: null, storeRevisions: null, testEnabled: null, bypass: null };

export interface SessionsFile {
  readonly sessions: readonly SessionSpan[];
  readonly harness: HarnessFacts;
}

export function sessionsText(file: SessionsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export class SessionsError extends Error {}

/** The spans of a run whose turns carry their session numbers (1 when absent). */
export function sessionSpans(turns: readonly { readonly session?: number; readonly callRange: readonly [number, number] }[]): SessionSpan[] {
  const spans: SessionSpan[] = [];
  turns.forEach((t, i) => {
    const n = t.session ?? 1;
    const last = spans.at(-1);
    if (last !== undefined && last.session === n) spans[spans.length - 1] = { session: n, turns: [last.turns[0], i + 1], calls: [last.calls[0], t.callRange[1]] };
    else spans.push({ session: n, turns: [i, i + 1], calls: [t.callRange[0], t.callRange[1]] });
  });
  return spans;
}

/**
 * sessions.json, read back: refused by name when it is malformed or when its
 * spans do not cover every turn and call, in order, with sessions numbered
 * from 1.
 */
export function parseSessionsFile(text: string, turnCount: number, callCount: number): SessionsFile {
  let v: { sessions?: unknown; harness?: unknown };
  try { v = JSON.parse(text) as typeof v; } catch { throw new SessionsError("is not JSON"); }
  if (!Array.isArray(v.sessions) || v.harness === null || typeof v.harness !== "object") throw new SessionsError("has no sessions list or harness facts");
  const spans = v.sessions as SessionSpan[];
  let turn = 0;
  let call = 0;
  spans.forEach((s, i) => {
    const pair = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2 && x.every((n) => Number.isInteger(n));
    if (s === null || typeof s !== "object" || s.session !== i + 1 || !pair(s.turns) || !pair(s.calls)) throw new SessionsError(`session ${i + 1} is malformed`);
    if (s.turns[0] !== turn || s.turns[1] <= s.turns[0] || s.calls[0] !== call || s.calls[1] < s.calls[0]) throw new SessionsError(`session ${i + 1} does not follow the one before it`);
    turn = s.turns[1];
    call = s.calls[1];
  });
  if (turn !== turnCount || call !== callCount) throw new SessionsError(`the sessions cover ${turn} of ${turnCount} turns and ${call} of ${callCount} calls`);
  const harness = { ...NO_FACTS, ...(v.harness as Partial<HarnessFacts>) };
  if (harness.schedule !== null) scheduleFactsOrThrow(harness.schedule);
  return { sessions: spans, harness };
}

/** 6.1: a recorded schedule is a list of entries the parser would accept, each with a boolean `fired`. */
function scheduleFactsOrThrow(schedule: unknown): void {
  const entry = (e: unknown): e is ScheduleFact => e !== null && typeof e === "object" && Number.isInteger((e as ScheduleFact).session) && typeof (e as ScheduleFact).id === "string" && typeof (e as ScheduleFact).selector === "string" && typeof (e as ScheduleFact).fired === "boolean";
  if (!Array.isArray(schedule) || schedule.length === 0 || !schedule.every(entry)) throw new SessionsError("has a malformed fault schedule");
  try { checkSchedule(schedule); } catch (err) { throw new SessionsError(`has a fault schedule the runner refuses (${err instanceof Error ? err.message : String(err)})`); }
}

// --- artifacts -----------------------------------------------------------------------

/** The raw inputs a set-7 record of `variant` requires: `completed` says the archive committed. */
export function requiredArtifacts(variant: string, completed: boolean): string[] {
  return [
    "events.jsonl", "invocations.json",
    ...(completed ? ["setup-snapshot.json"] : []),
    ...(isSessionVariant(variant) ? [SESSIONS_RAW] : []),
    ...(isDemoVariant(variant) ? [OBSERVATIONS_RAW] : []),
    ...(variant === "milestone-states" ? [STATES_RAW] : []),
  ];
}

/** A failure per artifact the variant requires and the run did not leave. */
export function artifactFindings(variant: string, completed: boolean, present: (name: string) => boolean): string[] {
  return requiredArtifacts(variant, completed).filter((n) => !present(n)).map((n) => `artifact: the ${variant} run left no ${n}`);
}

// --- the checks ----------------------------------------------------------------------

/** One turn as the variant checks read it. */
export interface VariantTurn {
  readonly owner: string;
  readonly text: string;
  readonly calls: readonly { readonly name: string; readonly command: string | null; readonly input: unknown; readonly output: string; readonly isError?: boolean }[];
}

export interface VariantInputs {
  readonly variant: SessionVariant;
  readonly turns: readonly VariantTurn[];
  readonly sessions: readonly SessionSpan[];
  readonly harness: HarnessFacts;
  readonly log: EventsLog | null;
  readonly mapping: readonly InvocationMapping[];
  /** The final ledger's tickets. */
  readonly tickets: readonly object[];
  /** The tickets as the setup's archive left them (the snapshot), for the completions that came before the boundary. */
  readonly ticketsAtSetup: readonly object[];
  readonly checkSet: number;
  /** T-538 6.1: the recorded tree snapshots, when the run kept them. */
  readonly faults?: FaultSnapshots;
  /** T-538 6.2 (milestone-states): the boundary records, recomputed from their copies; null when the run kept none. */
  readonly states?: readonly StateRecord[] | null;
  /** The rubric's follow-up title pattern. */
  readonly followUpTitle?: string | null;
}

/** T-538 6.1: the tree snapshots a fault run records as replay inputs, and the fixture's protected paths. */
export interface FaultSnapshots {
  /** A snapshot's recorded text by raw name (fault-kill.<id>.json, fault-edited.json, fault-end.json), or null when absent. */
  readonly read: (name: string) => string | null;
  /** The fixture's own files outside `.story/`, by project-relative path. */
  readonly protectedPaths: readonly string[];
}

/**
 * The preservation rules on a live attempt (plan v5 6.1), applied only to a run whose log holds fired records
 * (the per-id collector): a stored run with the legacy marker records no snapshot and is regraded as before. A
 * missing or malformed snapshot is a finding, never a skipped rule.
 */
export function faultSnapshotFindings(v: string, harness: HarnessFacts, log: EventsLog | null, faults: FaultSnapshots | undefined): string[] {
  const fired = log?.fired ?? [];
  if (log === null || fired.length === 0) return [];
  if (faults === undefined) return [`${v}: the run kept no fault snapshots`];
  const out: string[] = [];
  const snap = (name: string, what: string): TreeSnap | null => {
    const text = faults.read(name);
    if (text === null) { out.push(`${v}: the ${what} (${name}) is missing`); return null; }
    try { return parseTreeSnap(text); } catch (err) { out.push(`${v}: the ${what} (${name}) is malformed: ${(err as Error).message}`); return null; }
  };
  const kills = fired.map((f) => snap(killRaw(f.id), `kill snapshot of ${f.id}`));
  const end = snap(END_RAW, "end snapshot");
  const first = kills[0] ?? null;
  let baseline = first;
  if (v === "interrupted-edited") {
    const edited = snap(EDITED_RAW, "snapshot after the owner's edits");
    if (edited !== null && first !== null && harness.edits !== null) out.push(...editedSnapshotFindings(first, edited, harness.edits));
    baseline = edited;
  }
  if (baseline !== null && end !== null) out.push(...preservationFindings(v, { baseline, end, protectedPaths: faults.protectedPaths, selector: fired[0]!.selector, firedLine: fired[0]!.line, log }));
  // Codex round 1 P6: every later kill snapshot is held too. Each must be complete, and the end must preserve what
  // it shows, so an item created between two faults and changed after the second kill is caught. The owner's edits
  // land before session 2, so a later kill already holds them and is compared with the end as it stands. A rule
  // that reads the whole log (the archive count) gives the same line for every kill; it is kept once. The
  // config.json rule is held from each kill's own fired line (Codex round 2 Q2).
  const completeness = (k: TreeSnap, id: string): string[] => [
    ...(k.truncated ? [`${v}: the kill snapshot of ${id} is truncated`] : []),
    ...k.problems.map((p) => `${v}: the kill snapshot of ${id}: ${p}`),
  ];
  if (v === "interrupted-edited" && first !== null) out.push(...completeness(first, fired[0]!.id));
  kills.forEach((k, n) => {
    if (n === 0 || k === null) return;
    out.push(...completeness(k, fired[n]!.id));
    if (end !== null) out.push(...preservationFindings(v, { baseline: { ...k, truncated: false, problems: [] }, end, protectedPaths: faults.protectedPaths, selector: fired[n]!.selector, firedLine: fired[n]!.line, log }));
  });
  return [...new Set(out)];
}

const sessionOf = (sessions: readonly SessionSpan[], turn: number): number => sessions.find((s) => turn >= s.turns[0] && turn < s.turns[1])?.session ?? 1;

const ASKS: readonly StopKind[] = ["discovery", "package", "review-unavailable"];
const routeOf = (text: string, cs: number): StopKind | undefined => stopRoute(readTurnStop({ stopText: text }, cs));

/** A line as the owner reads it: list markers, emphasis and code ticks dropped. */
const plain = (l: string): string => l.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").trim();

const idOf = (t: object): string => (t as { id: string }).id;
const displayOf = (t: object): string => (t as { displayId?: string }).displayId ?? idOf(t);

/** The resolutions a setup-apply call carries (MCP `resolutions`, CLI `--resolve`), or null when it carries none. */
export function resolutionsOf(call: VariantTurn["calls"][number]): { target?: string; resolution?: string; ownerWords?: string }[] | null {
  let raw: unknown;
  if (call.command !== null) {
    if (!/^storybloq setup-apply\b/.test(call.command)) return null;
    const v = flagValue(call.command.split("\n")[0]!, "--resolve");
    if (v === undefined) return null;
    try { raw = JSON.parse(v); } catch { return []; }
  } else if (call.name === "storybloq_setup_apply" || call.name.endsWith("__storybloq_setup_apply")) {
    raw = (call.input as { resolutions?: unknown } | null)?.resolutions;
    if (raw === undefined) return null;
  } else return null;
  return Array.isArray(raw) ? (raw as { target?: string; resolution?: string; ownerWords?: string }[]) : [];
}

/** The tickets a call completes, in the order it reports them: a status update to complete, or the guide's completion line. */
export function completionsOf(call: VariantTurn["calls"][number]): string[] {
  // A failed or unanswered call completed nothing, whatever it asked for.
  if (call.isError === true || call.output === "") return [];
  if (call.command !== null) {
    const m = /^storybloq ticket update\s+(\S+)[^\n]*\s--status\s+['"]?complete\b/.exec(call.command);
    return m ? [m[1]!.replace(/^['"]|['"]$/g, "")] : [];
  }
  const tool = call.name.replace(/^.*__/, "");
  if (tool === "storybloq_ticket_update") {
    const a = (call.input ?? {}) as { id?: unknown; status?: unknown };
    return a.status === "complete" && typeof a.id === "string" ? [a.id] : [];
  }
  // The guide's COMPLETE stage (src/autonomous/stages/complete.ts) reports `Ticket **<id>** completed.`
  if (tool === "storybloq_autonomous_guide") return [...call.output.matchAll(/Ticket \*\*([^*]+)\*\* completed\./g)].map((m) => m[1]!);
  return [];
}

/**
 * T-538 6.1: each schedule entry fired in its own session, and its fired record (exactly one, by id) names that
 * entry's selector and a point the selector matches; a `:*` selector's record names the point it resolved to.
 */
/**
 * P5: a fired record's session, from its attempt and invocation through the run's invocation mapping to the turn,
 * then to the session holding that turn; null when no invocation of the run matches it.
 */
export type FiredSession = (r: { readonly attempt: string; readonly invocation: string | null }) => number | null;
export function firedSessionFrom(mapping: readonly InvocationMapping[], sessions: readonly SessionSpan[]): FiredSession {
  return (r) => {
    if (r.invocation === null) return null;
    const m = mapping.filter((x) => x.attempt === r.attempt && x.invocation === r.invocation);
    return m.length === 1 ? sessionOf(sessions, m[0]!.turn) : null;
  };
}

export function scheduleFindings(v: string, schedule: readonly ScheduleFact[], log: EventsLog | null, sessionOfFired: FiredSession): string[] {
  const out: string[] = [];
  for (const e of schedule) {
    if (!e.fired) out.push(`${v}: the fault ${e.id} (${e.selector}) never fired (no .fired.${e.id} marker after session ${e.session})`);
    const records = (log?.fired ?? []).filter((r) => r.id === e.id);
    if (records.length !== 1) { out.push(`${v}: the fault ${e.id} has ${records.length} fired records, not one`); continue; }
    const r = records[0]!;
    if (r.selector !== e.selector) out.push(`${v}: the fault ${e.id}'s fired record names the selector ${r.selector}, not ${e.selector}`);
    if (!pointMatches(parseSelector(e.selector).point, r.point)) out.push(`${v}: the fault ${e.id} fired at ${r.point}, which ${e.selector} does not select`);
    const s = sessionOfFired(r);
    if (s === null) out.push(`${v}: the fault ${e.id}'s fired record matches no invocation of the run (attempt ${r.attempt}, invocation ${r.invocation ?? "none"})`);
    else if (s !== e.session) out.push(`${v}: the fault ${e.id} fired in session ${s}, not session ${e.session}`);
  }
  for (const r of log?.fired ?? []) if (!schedule.some((e) => e.id === r.id)) out.push(`${v}: a fired record for ${r.id}, which the schedule does not hold`);
  return out;
}

function interruptedFindings(i: VariantInputs): string[] {
  const v = i.variant;
  const out: string[] = [];
  const schedule = i.harness.schedule;
  // The last armed session; the resume is the session after it.
  const armed = schedule === null ? 1 : schedule.length;
  if (schedule === null) {
    if (i.harness.fired !== true) out.push(`${v}: the fault ${i.harness.fault ?? "(none set)"} never fired (no .fired marker after session 1)`);
  } else out.push(...scheduleFindings(v, schedule, i.log, firedSessionFrom(i.mapping, i.sessions)));
  i.turns.forEach((t, n) => {
    const s = sessionOf(i.sessions, n);
    // The edited variant's session 2 asks the owner about the edited description by design (exit 4), so only a plain resume is held to no question.
    if (v === "interrupted" && s >= 2 && routeOf(t.text, i.checkSet) === "discovery") out.push(`${v}: session ${s} asked a discovery question (turn ${n + 1})`);
  });
  const counts = new Map<string, number>();
  for (const e of i.log?.events ?? []) if (e.point.startsWith("step:item:") || e.point === "step:archive") counts.set(e.point, (counts.get(e.point) ?? 0) + 1);
  for (const [point, n] of counts) if (n > 1) out.push(`${v}: ${point.slice("step:".length)} committed ${n} times`);
  // The resume is the point: a retry inside an armed session proves nothing about a fresh session picking the setup up.
  for (const m of i.mapping) {
    const s = sessionOf(i.sessions, m.turn);
    if (s <= armed && m.exitCode === 0) out.push(`${v}: session ${s} finished the setup itself (turn ${m.turn + 1}), so the resume was never exercised`);
  }
  if (!i.mapping.some((m) => sessionOf(i.sessions, m.turn) > armed && m.exitCode === 0)) out.push(`${v}: no setup-apply call in session ${armed + 1} finished the setup`);
  return out;
}

function editedFindings(i: VariantInputs): string[] {
  const out: string[] = [];
  const e = i.harness.edits;
  if (e === null) return ["interrupted-edited: the harness made no edit between the sessions"];
  const byRef = (ref: string) => i.tickets.find((t) => displayOf(t) === ref || idOf(t) === ref);
  if ((byRef(e.describedTicket) as { description?: string } | undefined)?.description !== e.description) out.push(`interrupted-edited: ${e.describedTicket}'s final description is not the owner's edit`);
  const edged = byRef(e.edgeTicket) as { blockedBy?: string[] } | undefined;
  const blocker = i.tickets.find((t) => displayOf(t) === e.blocker || idOf(t) === e.blocker);
  const refs = new Set([e.blocker, ...(blocker !== undefined ? [idOf(blocker), displayOf(blocker)] : [])]);
  if (!(edged?.blockedBy ?? []).some((b) => refs.has(b))) out.push(`interrupted-edited: ${e.edgeTicket} lost the owner's blockedBy edge on ${e.blocker}`);
  if (!i.mapping.some((m) => sessionOf(i.sessions, m.turn) >= 2 && m.exitCode === 4)) out.push("interrupted-edited: no setup-apply call in session 2 stopped at exit 4 on the edited description");
  // The engine's target reads `<key> (<display id>)`; a bare reference is accepted too.
  const names = (target: string, ref: string): boolean => {
    const t = byRef(ref);
    const refs = [ref, ...(t !== undefined ? [idOf(t), displayOf(t)] : [])];
    return refs.includes(target) || refs.includes(/\(([^()]+)\)$/.exec(target)?.[1] ?? "");
  };
  const accepts: { turn: number; words: string; target: string }[] = [];
  i.turns.forEach((t, n) => {
    if (sessionOf(i.sessions, n) < 2) return;
    for (const c of t.calls) for (const r of resolutionsOf(c) ?? []) if (r.resolution === "accept-current") accepts.push({ turn: n, words: r.ownerWords ?? "", target: r.target ?? "" });
  });
  if (!accepts.some((a) => names(a.target, e.describedTicket))) out.push("interrupted-edited: session 2 never resolved the edited description with accept-current");
  for (const a of accepts) if (!names(a.target, e.describedTicket) && !names(a.target, e.edgeTicket)) out.push(`interrupted-edited: the accept-current resolution at turn ${a.turn + 1} targets ${a.target}, which the harness did not edit`);
  for (const a of accepts) {
    const owners = i.turns.slice(i.sessions.find((s) => s.session === 2)?.turns[0] ?? 0, a.turn + 1).map((t) => t.owner);
    if (a.words.trim() === "" || !owners.some((o) => o.includes(a.words.trim()))) out.push(`interrupted-edited: the accept-current resolution at turn ${a.turn + 1} carries words no owner turn of session 2 said ("${a.words}")`);
  }
  if ((i.harness.storeRevisions ?? 0) < 2) out.push("interrupted-edited: the setup review store holds no review of the amendment");
  return out;
}

function demoFindings(i: VariantInputs): string[] {
  const out: string[] = [];
  const v = i.variant;
  const d = i.harness.demo;
  if (d === null) return [`${v}: the harness has no demo run`];
  if (d.status !== 0 || d.signal || d.error) out.push(`${v}: the demo command did not exit 0 (status ${d.exitForm ?? d.status ?? "none"}, signal ${d.signal ?? "none"}, error ${d.error ?? "none"})`);
  if (d.stdout.trim() !== d.expected.trim()) out.push(`${v}: the demo command printed "${d.stdout.trim()}", not the rubric's "${d.expected.trim()}"`);
  // The demo is shown by running it, before the owner's approval: a narrated result is not a demo.
  // Session 2's turns are milestone-run, demo-approval, change-request (laterSessions): the demo is run inside the first.
  const s2 = i.sessions.find((s) => s.session === 2);
  const shown = s2 !== undefined && i.turns.slice(s2.turns[0], s2.turns[0] + 1).some((t) => t.calls.some((c) => c.command !== null && c.command.includes(d.command)));
  if (!shown) out.push(`${v}: the demo was shown by narration only; no call before the approval ran ${d.command}`);
  const last = i.sessions.at(-1);
  const blocked = last !== undefined && last.session >= 3 && i.turns.slice(last.turns[0], last.turns[1]).some((t) => /waits on owner checkpoints? /.test(t.text) || t.calls.some((c) => /waits on owner checkpoints? /.test(c.output)));
  if (!blocked) out.push(`${v}: the targeted run on ${i.harness.dependent ?? "the dependent"} did not come back checkpoint-blocked`);
  // T-538 S5b: an ordinary status update is the other way around the checkpoint; it must be refused by the checkpoint, writing nothing.
  const b = i.harness.bypass;
  if (b === null) out.push(`${v}: the harness made no status-update attempt on ${i.harness.dependent ?? "the dependent"}`);
  else {
    if (b.exitCode === 0) out.push(`${v}: the status update completing ${b.ticket} went through`);
    // No exit status is no refusal, whatever the process printed before it died.
    // Under the wrapper a signal inside the sandbox comes back as exit 128 + n: that is no exit status either (Addendum B).
    else if (b.killedBy !== undefined) out.push(`${v}: the status update on ${b.ticket} did not exit (${b.exitForm ?? `killed by ${b.killedBy}`})`);
    else if (b.exitCode === null) out.push(`${v}: the status update on ${b.ticket} did not exit (signal ${b.signal ?? "none"}, error ${b.error ?? "none"})`);
    else if (!b.output.some((l) => /waits on owner checkpoints? /.test(l))) out.push(`${v}: the status update on ${b.ticket} was refused for another reason ("${b.output.join(" | ")}")`);
    if (b.ledgerChanged) out.push(`${v}: the status update on ${b.ticket} changed the ledger`);
    for (const p of b.ledgerProblems ?? []) out.push(`${v}: the ledger could not be read as evidence: ${p}`);
  }
  return out;
}

/**
 * A regular file's bytes as a digest, or null if the path is anything else. It
 * opens without following a link and without waiting on a FIFO, then trusts only
 * the type of what it opened, since the name can change after any earlier look.
 */
export function regularFileDigest(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); } catch { return null; }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const h = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) h.update(chunk.subarray(0, n));
    return h.digest("hex");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The points in a ledger walk where the tree can change under it; a test acts at one to prove the walk holds. */
export type LedgerStep = "check" | "readlink" | "enter" | "verify" | "verify-back" | "list" | "open";
type LedgerHook = (step: LedgerStep, rel: string) => void;

class LedgerWalkStopped extends Error {}

/**
 * The ledger as one digest: every entry under `.story/` but the derived cache and
 * the lock. The tree is the turn's to shape and a process the turn left behind can
 * still be changing it, so nothing is followed and no path crosses a folder. Node
 * has no openat, and the working directory does the same job: once entered and
 * checked it stays that folder whatever is renamed, so children are named by one
 * component. Entering a swapped link, or a way back that lands anywhere but the
 * parent, stops the walk with a finding. A link counts by its target's text. Every
 * failure names its path; only a missing `.story` is simply an empty ledger.
 */
export function ledgerState(story: string, hook?: LedgerHook): { readonly digest: string; readonly problems: readonly string[] } {
  const h = createHash("sha256");
  const problems: string[] = [];
  const step: LedgerHook = hook ?? (() => {});
  const label = (rel: string): string => (rel === "." ? ".story" : rel);
  const failed = (rel: string, e: unknown): void => { problems.push(`${label(rel)} could not be read (${(e as NodeJS.ErrnoException).code ?? "unknown"})`); };
  const stopped = (rel: string): never => { problems.push(`${label(rel)} changed while it was being read`); throw new LedgerWalkStopped(); };
  /** Where the walk stands now. A failure here leaves the folder unverified, so nothing more is read from it. */
  const identity = (rel: string): Stats => {
    try { return lstatSync("."); } catch (e) { failed(rel, e); throw new LedgerWalkStopped(); }
  };
  const isSame = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
  const folder = (rel: string, self: Stats): void => {
    step("list", rel);
    let names: string[];
    try { names = readdirSync(".").sort(); } catch (e) { failed(rel, e); return; }
    for (const name of names) {
      const child = rel === "." ? name : `${rel}/${name}`;
      if (child !== "cache" && child !== ".lock") entry(name, child, self);
    }
  };
  /** True if the walk went in, and so has to come back. */
  const enter = (name: string, rel: string, seen: Stats): boolean => {
    step("enter", rel);
    try { process.chdir(name); } catch (e) { failed(rel, e); return false; }
    step("verify", rel);
    const here = identity(rel);
    if (!isSame(here, seen)) stopped(rel);
    folder(rel, here);
    return true;
  };
  const entry = (name: string, rel: string, parent: Stats): void => {
    step("check", rel);
    let st: Stats;
    try { st = lstatSync(name); } catch (e) { failed(rel, e); return; }
    if (st.isSymbolicLink()) {
      step("readlink", rel);
      try { h.update(`${rel}\u0000link\u0000${readlinkSync(name)}\n`); } catch (e) { failed(rel, e); }
    } else if (st.isDirectory()) {
      if (enter(name, rel, st)) {
        try { process.chdir(".."); } catch { stopped(rel); }
        step("verify-back", rel);
        if (!isSame(identity(rel), parent)) stopped(rel);
      }
    } else if (st.isFile()) {
      step("open", rel);
      const digest = regularFileDigest(name);
      if (digest === null) problems.push(`${rel} could not be read`);
      else h.update(`${rel}\u0000${digest}\n`);
    } else problems.push(`${rel} is not a regular file, a folder or a link`);
  };
  const start = process.cwd();
  try {
    let root: Stats | null = null;
    try { root = lstatSync(story); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") failed(".", e); }
    if (root?.isSymbolicLink()) {
      try { h.update(`.\u0000link\u0000${readlinkSync(story)}\n`); } catch (e) { failed(".", e); }
    } else if (root !== null) {
      if (!root.isDirectory()) problems.push(".story is not a folder");
      else enter(story, ".", root);
    }
  } catch (e) {
    if (!(e instanceof LedgerWalkStopped)) throw e;
  } finally {
    process.chdir(start);
  }
  return { digest: h.digest("hex"), problems };
}

export const ledgerDigest = (story: string): string => ledgerState(story).digest;

/** Runs the bypass through `run` (the harness's CLI launcher) and reports what it did, stderr's lines first. */
export function attemptBypass(story: string, ticket: string, run: (args: readonly string[]) => { status: number | null; signal?: string | null; error?: Error; stdout: string; stderr: string }, hook?: LedgerHook): BypassAttempt {
  const before = ledgerState(story, hook);
  const r = run(["ticket", "update", ticket, "--status", "complete"]);
  return bypassResult(ticket, before, r, ledgerState(story, hook));
}

function bypassResult(ticket: string, before: ReturnType<typeof ledgerState>, r: { status: number | null; signal?: string | null; error?: Error; stdout: string; stderr: string; killedBy?: string; exitForm?: string }, after: ReturnType<typeof ledgerState>): BypassAttempt {
  const output = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const ledgerProblems = [...new Set([...before.problems, ...after.problems])];
  return { ticket, exitCode: r.status, output, ledgerChanged: after.digest !== before.digest, ...(ledgerProblems.length > 0 ? { ledgerProblems } : {}), ...(r.signal ? { signal: r.signal } : {}), ...(r.error ? { error: r.error.message } : {}), ...(r.killedBy !== undefined ? { killedBy: r.killedBy, exitForm: r.exitForm } : {}) };
}

/** The same attempt with a run that answers later (5.7: the harness's command runs under the sandbox wrapper) and the ledger read by the collector (5.8). */
export async function attemptBypassAsync(stateOf: () => Promise<ReturnType<typeof ledgerState>>, ticket: string, run: (args: readonly string[]) => Promise<{ status: number | null; signal?: string | null; error?: Error; stdout: string; stderr: string; killedBy?: string; exitForm?: string }>, hook?: LedgerHook): Promise<BypassAttempt> {
  const before = await stateOf();
  const r = await run(["ticket", "update", ticket, "--status", "complete"]);
  return bypassResult(ticket, before, r, await stateOf());
}

function orderFindings(i: VariantInputs): string[] {
  const out: string[] = [];
  if (i.harness.testEnabled !== true) out.push("empty-idea-verify: the final config does not enable the TEST stage");
  const done = new Set<string>();
  const completed = new Set<string>();
  for (const t of i.ticketsAtSetup) if ((t as { status?: string }).status === "complete") for (const r of [idOf(t), displayOf(t)]) done.add(r);
  const finalOf = (ref: string) => i.tickets.find((t) => idOf(t) === ref || displayOf(t) === ref);
  // The order the setup promised holds even if the final ledger lost the edge.
  const atSetup = (ref: string) => i.ticketsAtSetup.find((t) => idOf(t) === ref || displayOf(t) === ref);
  const byRef = (ref: string) => atSetup(ref) ?? finalOf(ref);
  const blockersOf = (t: object | undefined): string[] => (t as { blockedBy?: string[] } | undefined)?.blockedBy ?? [];
  i.turns.forEach((t, n) => {
    if (sessionOf(i.sessions, n) < 2) return;
    for (const c of t.calls) for (const ref of completionsOf(c)) {
      const ticket = byRef(ref);
      for (const b of new Set([...blockersOf(ticket), ...blockersOf(finalOf(ref))])) {
        const blocker = byRef(b);
        const names = blocker !== undefined ? [idOf(blocker), displayOf(blocker)] : [b];
        if (!names.some((x) => done.has(x))) out.push(`empty-idea-verify: ${ref} completed before its blocker ${blocker !== undefined ? displayOf(blocker) : b}`);
      }
      for (const r of ticket !== undefined ? [idOf(ticket), displayOf(ticket), ref] : [ref]) { done.add(r); completed.add(r); }
    }
  });
  const establishment = i.ticketsAtSetup.filter((t) => (t as { setup?: { establishes?: unknown } }).setup?.establishes !== undefined);
  if (establishment.length === 0) return [...out, "empty-idea-verify: the setup snapshot holds no establishment ticket"];
  const finished = (t: object, missing: string): void => {
    if (!completed.has(idOf(t)) && !completed.has(displayOf(t))) { out.push(missing); return; }
    const status = (finalOf(idOf(t)) as { status?: string } | undefined)?.status ?? "missing";
    if (status !== "complete") out.push(`empty-idea-verify: ${displayOf(t)} completed in session 2, but its final status is ${status}`);
  };
  for (const e of establishment) {
    const names = [idOf(e), displayOf(e)];
    const waiting = i.ticketsAtSetup.filter((t) => blockersOf(t).some((b) => names.includes(b)));
    if (waiting.length === 0) { out.push(`empty-idea-verify: nothing in the setup snapshot waits on establishment ticket ${displayOf(e)}`); continue; }
    finished(e, `empty-idea-verify: establishment ticket ${displayOf(e)} never completed successfully in session 2`);
    for (const t of waiting) finished(t, `empty-idea-verify: ${displayOf(t)}, which waits on establishment ticket ${displayOf(e)}, never completed successfully in session 2`);
  }
  return out;
}

function restartFindings(i: VariantInputs): string[] {
  const out: string[] = [];
  const report = i.harness.report;
  if (report === null) return ["restart: the harness read no live setup report"];
  const wanted = report.filter((l) => /^Checkpoint: /.test(l) || /^First story: /.test(l) || /^Verification: .*\(pending/.test(l));
  const span = i.sessions.at(-1);
  const turns = span !== undefined && span.session >= 2 ? i.turns.slice(span.turns[0], span.turns[1]) : [];
  const shown = new Set(turns.flatMap((t) => t.text.split("\n").map(plain)));
  for (const l of wanted) if (!shown.has(l)) out.push(`restart: the fresh session does not name the live report line "${l}"`);
  turns.forEach((t, n) => {
    const route = routeOf(t.text, i.checkSet);
    if (route !== undefined && ASKS.includes(route)) out.push(`restart: the fresh session asked the owner something (${route}, turn ${(span?.turns[0] ?? 0) + n + 1})`);
  });
  return out;
}

/** The variant's own checks; check set 7's rules run beside them over the whole run. */
export function variantFindings(i: VariantInputs): string[] {
  switch (i.variant) {
    case "interrupted": return [...interruptedFindings(i), ...faultSnapshotFindings(i.variant, i.harness, i.log, i.faults)];
    case "interrupted-edited": return [...interruptedFindings(i), ...editedFindings(i), ...faultSnapshotFindings(i.variant, i.harness, i.log, i.faults)];
    case "milestone-demo": return demoFindings(i);
    case "milestone-states": return [...demoFindings(i), ...statesFindings(i.states ?? null, i.followUpTitle ?? null)];
    case "empty-idea-verify": return orderFindings(i);
    case "restart": return restartFindings(i);
  }
}

const keyOf = (t: object): string | null => {
  const meta = parseSetupMeta("ticket", t);
  return meta.kind === "item" && meta.meta.supersededBy === undefined ? meta.meta.key : null;
};

/** The ticket the fixture's checkpoint gates, resolved by structure in the setup snapshot's tickets; null when it matches no one checkpoint or gates nothing. */
export function gatedTicket(tickets: readonly object[], spec: CheckpointSpec): string | null {
  const found = findCheckpoint(tickets, spec);
  if ("failure" in found) return null;
  const cp = found.ticket;
  const refs = new Set([idOf(cp), displayOf(cp)]);
  const gated = tickets.filter((t) => t !== cp && ((t as { blockedBy?: string[] }).blockedBy ?? []).some((b) => refs.has(b))).map(displayOf).sort();
  return gated[0] ?? null;
}

/**
 * interrupted-edited: the owner's edits between the sessions, chosen from the
 * keyed tickets session 1 left, in display-id order: the last one gains a
 * blockedBy edge on the first (unless it already has it), and the first one
 * other than the edged ticket gets a new description. Null when fewer than two
 * keyed tickets exist, which the runner refuses by name.
 */
export function ownerEdits(tickets: readonly object[]): { edgeTicket: string; blocker: string; describedTicket: string; description: string } | null {
  const keyed = tickets.filter((t) => keyOf(t) !== null && (t as { ownerCheckpoint?: unknown }).ownerCheckpoint === undefined)
    .sort((a, b) => displayOf(a).localeCompare(displayOf(b), "en", { numeric: true }));
  if (keyed.length < 2) return null;
  const edged = keyed.at(-1)!;
  const blocker = keyed[0]!;
  const described = keyed.find((t) => t !== edged)!;
  const before = (described as { description?: string }).description ?? "";
  return { edgeTicket: displayOf(edged), blocker: displayOf(blocker), describedTicket: displayOf(described), description: `${before}\n\nOwner edit: keep the first version to the smallest working slice.`.trim() };
}

/** The run's evidence observations file text. */
export function observationsText(observations: readonly EvidenceObservation[]): string {
  return `${JSON.stringify(observations, null, 2)}\n`;
}

/** What the runner and the regrade both hand the variant checks, beside the driven run. */
export interface SessionCheckInputs {
  readonly variant: SessionVariant;
  readonly harness: HarnessFacts;
  readonly log: EventsLog | null;
  readonly mapping: readonly InvocationMapping[];
  /** The final ledger's tickets, and the tickets in the setup snapshot (empty when the archive never committed). */
  readonly tickets: readonly object[];
  readonly ticketsAtSetup: readonly object[];
  /** Whether the run left a raw input by name. */
  readonly present: (name: string) => boolean;
  /** T-538 6.1: the fault run's recorded tree snapshots. */
  readonly faults?: FaultSnapshots;
  /** T-538 6.2: milestone-states' boundary records and the rubric's follow-up title pattern. */
  readonly states?: readonly StateRecord[] | null;
  readonly followUpTitle?: string | null;
}

/** The variant's checks on a driven run: its artifacts, then its own findings, each sourced as the variant's. */
export function applySessionChecks(state: DriveState, i: SessionCheckInputs): void {
  const completed = (i.log?.events ?? []).some((e) => e.point === "archive-committed");
  const findings = [
    ...artifactFindings(i.variant, completed, i.present),
    ...variantFindings({
      variant: i.variant, turns: cs7TurnsFrom(state.turns, state.allCalls), sessions: sessionSpans(state.turns), harness: i.harness,
      log: i.log, mapping: i.mapping, tickets: i.tickets, ticketsAtSetup: i.ticketsAtSetup, checkSet: state.checkSet,
      ...(i.faults !== undefined ? { faults: i.faults } : {}),
      ...(i.states !== undefined ? { states: i.states } : {}),
      ...(i.followUpTitle !== undefined ? { followUpTitle: i.followUpTitle } : {}),
    }),
  ];
  for (const f of findings) {
    state.failures.push(f);
    state.sources.push({ kind: "variant" });
  }
}

/** The setup id the events log names (its first event that carries one), or null. */
export function setupIdOf(log: EventsLog | null): string | null {
  return (log?.events ?? []).find((e) => typeof e.setupId === "string" && e.setupId !== "")?.setupId ?? null;
}

/** The setup review store's revision files for one setup, under any project key. */
export function storeRevisionCount(storeRoot: string, setupId: string): number {
  if (!existsSync(storeRoot)) return 0;
  let n = 0;
  for (const key of readdirSync(storeRoot)) {
    const dir = join(storeRoot, key, setupId, "revisions");
    if (existsSync(dir)) n += readdirSync(dir).filter((x) => x.endsWith(".md")).length;
  }
  return n;
}

/**
 * What an evidence observation records in place of a digest when the entry is not a regular file it read
 * whole. None is a hex digest, so rule 8 reports each as a change ("observed as symlink"), never a match.
 */
export const EVIDENCE_NOT_READ = { link: "symlink", other: "not-a-file", failed: "unreadable", changed: "changed", over: "over-limit" } as const;
/** An evidence file is a short document; one past this is recorded as over the limit, never read on. */
export const EVIDENCE_LIMIT = 16 * 1048576;
/** The evidence folder, project-relative: where a failure of the project root itself is recorded. */
export const EVIDENCE_ROOT = "docs/checkpoints";

/**
 * Every evidence file under the project's docs/checkpoints/, by its project-relative path, digested now.
 * It walks from the project root one component at a time with commit 4's no-follow walk (ISS-1467): a
 * linked docs or checkpoints folder is recorded, never entered, and every file is read through the
 * descriptor the walk opened and proved regular. A link, a fifo, an entry swapped while being read, one
 * that cannot be read or one over the limit is a failed observation under its own path, so the walk
 * neither leaves the project nor blocks.
 */
export function observeEvidence(projectRoot: string, at: EvidenceObservation["at"], hook?: WalkHook): EvidenceObservation[] {
  const out: EvidenceObservation[] = [];
  const inScope = (rel: string): boolean => rel === "docs" || rel === "docs/checkpoints" || rel.startsWith("docs/checkpoints/");
  // A root the walk refuses (a link, not a folder, unreadable, or swapped while entered) is one failed
  // observation of the whole evidence folder, never an empty list that reads as a project with no evidence.
  const fail = (rel: string, sha256: string): void => {
    if (rel === ".") out.push({ ref: EVIDENCE_ROOT, sha256, at });
    else if (inScope(rel)) out.push({ ref: rel, sha256, at });
  };
  walkNoFollow(projectRoot, "project", {
    // Above the checkpoints folder only the folders on the way are walked; any other entry there is not evidence.
    include: (rel, st) => (rel === "docs" ? st.isDirectory() || st.isSymbolicLink() : inScope(rel)),
    link: (rel) => fail(rel, EVIDENCE_NOT_READ.link),
    file: (rel, fd) => {
      const r = readBounded(fd, EVIDENCE_LIMIT);
      if ("code" in r) return r.code;
      out.push({ ref: rel, sha256: "over" in r ? EVIDENCE_NOT_READ.over : createHash("sha256").update(r.bytes).digest("hex"), at });
      return null;
    },
    problem: (rel, kind) => fail(rel, kind === "changed" ? EVIDENCE_NOT_READ.changed : kind === "other" ? EVIDENCE_NOT_READ.other : EVIDENCE_NOT_READ.failed),
  }, { hook, missingIsEmpty: true });
  return out;
}
