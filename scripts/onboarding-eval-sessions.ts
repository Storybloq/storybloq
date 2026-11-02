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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

import { readTurnStop, stopRoute, type StopKind } from "./onboarding-eval-lib.js";
import { flagValue, type EventsLog, type InvocationMapping } from "./onboarding-eval-checkset7-events.js";
import { cs7TurnsFrom, findCheckpoint, type CheckpointSpec, type EvidenceObservation } from "./onboarding-eval-checkset7.js";
import type { DriveState, Variant } from "./onboarding-eval-drive.js";
import { parseSetupMeta } from "../src/core/setup-meta.js";

export const SESSION_VARIANTS = ["interrupted", "interrupted-edited", "milestone-demo", "empty-idea-verify", "restart"] as const;
export type SessionVariant = (typeof SESSION_VARIANTS)[number];

export const isSessionVariant = (v: string): v is SessionVariant => (SESSION_VARIANTS as readonly string[]).includes(v);

/** The variants that take `--fault`: the fault is set in session 1 only. */
export const isFaultVariant = (v: string): boolean => v === "interrupted" || v === "interrupted-edited";

/** The variant the setup flow runs as: a session variant's setup is the plain one. */
export const baseVariant = (v: Variant | SessionVariant): Variant => (isSessionVariant(v) ? "none" : v);

/** The fixture a variant runs on, when it fixes one. */
export function variantFixture(v: SessionVariant): string | null {
  return v === "milestone-demo" ? "checkpoint-demo" : v === "empty-idea-verify" ? "empty-idea" : null;
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
  };
}

/**
 * The later sessions of a variant. `invoke` is the client's skill invocation
 * (`/story` or `$story`); `dependent` is the ticket the milestone checkpoint
 * gates, read from the setup snapshot (milestone-demo only).
 */
export function laterSessions(v: SessionVariant, invoke: string, script: SessionScript, dependent: string | null): LaterSession[] {
  switch (v) {
    case "interrupted":
      return [{ setup: true, turns: [{ label: "session-2-open", prompt: invoke }] }];
    case "interrupted-edited":
      return [{ setup: true, turns: [{ label: "session-2-open", prompt: invoke }, { label: "edit-ruling", prompt: script.editRuling }] }];
    case "milestone-demo":
      if (script.demoApproval === "" || script.changeRequest === "") throw new Error("milestone-demo needs the fixture's \"Demo approval turn\" and \"Change request turn\" sections");
      // With no gated dependent in the snapshot there is no targeted run; the variant check names the missing block.
      return [
        { setup: false, turns: [{ label: "milestone-run", prompt: `${invoke} ${script.milestoneRun}` }, { label: "demo-approval", prompt: script.demoApproval }, { label: "change-request", prompt: script.changeRequest }] },
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
}

/** The demo run as sessions.json records it, from its spawnSync result. */
export function demoFacts(command: string, expected: string, r: { readonly status: number | null; readonly signal: string | null; readonly stdout?: string | null; readonly error?: Error }): DemoFacts {
  return { command, expected, stdout: r.stdout ?? "", status: r.status, signal: r.signal, error: r.error?.message ?? null };
}

/** What the harness itself did and saw, recorded so the regrade reads the facts the run graded. */
export interface HarnessFacts {
  /** The `--fault` selector set in session 1, or null. */
  readonly fault: string | null;
  /** Whether the fault's `.fired` marker existed after session 1; null when no fault was set. */
  readonly fired: boolean | null;
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
}

export const NO_FACTS: HarnessFacts = { fault: null, fired: null, edits: null, demo: null, dependent: null, report: null, storeRevisions: null, testEnabled: null };

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
  return { sessions: spans, harness: { ...NO_FACTS, ...(v.harness as Partial<HarnessFacts>) } };
}

// --- artifacts -----------------------------------------------------------------------

/** The raw inputs a set-7 record of `variant` requires: `completed` says the archive committed. */
export function requiredArtifacts(variant: string, completed: boolean): string[] {
  return [
    "events.jsonl", "invocations.json",
    ...(completed ? ["setup-snapshot.json"] : []),
    ...(isSessionVariant(variant) ? [SESSIONS_RAW] : []),
    ...(variant === "milestone-demo" ? [OBSERVATIONS_RAW] : []),
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

function interruptedFindings(i: VariantInputs): string[] {
  const v = i.variant;
  const out: string[] = [];
  if (i.harness.fired !== true) out.push(`${v}: the fault ${i.harness.fault ?? "(none set)"} never fired (no .fired marker after session 1)`);
  i.turns.forEach((t, n) => {
    const s = sessionOf(i.sessions, n);
    // The edited variant's session 2 asks the owner about the edited description by design (exit 4), so only a plain resume is held to no question.
    if (v === "interrupted" && s >= 2 && routeOf(t.text, i.checkSet) === "discovery") out.push(`${v}: session ${s} asked a discovery question (turn ${n + 1})`);
  });
  const counts = new Map<string, number>();
  for (const e of i.log?.events ?? []) if (e.point.startsWith("step:item:") || e.point === "step:archive") counts.set(e.point, (counts.get(e.point) ?? 0) + 1);
  for (const [point, n] of counts) if (n > 1) out.push(`${v}: ${point.slice("step:".length)} committed ${n} times`);
  // The resume is the point: a retry inside session 1 proves nothing about a fresh session picking the setup up.
  for (const m of i.mapping) if (sessionOf(i.sessions, m.turn) === 1 && m.exitCode === 0) out.push(`${v}: session 1 finished the setup itself (turn ${m.turn + 1}), so the resume was never exercised`);
  if (!i.mapping.some((m) => sessionOf(i.sessions, m.turn) >= 2 && m.exitCode === 0)) out.push(`${v}: no setup-apply call in session 2 finished the setup`);
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
  const d = i.harness.demo;
  if (d === null) return ["milestone-demo: the harness has no demo run"];
  if (d.status !== 0 || d.signal || d.error) out.push(`milestone-demo: the demo command did not exit 0 (status ${d.status ?? "none"}, signal ${d.signal ?? "none"}, error ${d.error ?? "none"})`);
  if (d.stdout.trim() !== d.expected.trim()) out.push(`milestone-demo: the demo command printed "${d.stdout.trim()}", not the rubric's "${d.expected.trim()}"`);
  // The demo is shown by running it, before the owner's approval: a narrated result is not a demo.
  // Session 2's turns are milestone-run, demo-approval, change-request (laterSessions): the demo is run inside the first.
  const s2 = i.sessions.find((s) => s.session === 2);
  const shown = s2 !== undefined && i.turns.slice(s2.turns[0], s2.turns[0] + 1).some((t) => t.calls.some((c) => c.command !== null && c.command.includes(d.command)));
  if (!shown) out.push(`milestone-demo: the demo was shown by narration only; no call before the approval ran ${d.command}`);
  const last = i.sessions.at(-1);
  const blocked = last !== undefined && last.session >= 3 && i.turns.slice(last.turns[0], last.turns[1]).some((t) => /waits on owner checkpoints? /.test(t.text) || t.calls.some((c) => /waits on owner checkpoints? /.test(c.output)));
  if (!blocked) out.push(`milestone-demo: the targeted run on ${i.harness.dependent ?? "the dependent"} did not come back checkpoint-blocked`);
  return out;
}

function orderFindings(i: VariantInputs): string[] {
  const out: string[] = [];
  if (i.harness.testEnabled !== true) out.push("empty-idea-verify: the final config does not enable the TEST stage");
  const done = new Set<string>();
  let completions = 0;
  for (const t of i.ticketsAtSetup) if ((t as { status?: string }).status === "complete") for (const r of [idOf(t), displayOf(t)]) done.add(r);
  const byRef = (ref: string) => i.tickets.find((t) => idOf(t) === ref || displayOf(t) === ref);
  i.turns.forEach((t, n) => {
    if (sessionOf(i.sessions, n) < 2) return;
    for (const c of t.calls) for (const ref of completionsOf(c)) {
      completions++;
      const ticket = byRef(ref);
      for (const b of ((ticket as { blockedBy?: string[] } | undefined)?.blockedBy ?? [])) {
        const blocker = byRef(b);
        const names = blocker !== undefined ? [idOf(blocker), displayOf(blocker)] : [b];
        if (!names.some((x) => done.has(x))) out.push(`empty-idea-verify: ${ref} completed before its blocker ${blocker !== undefined ? displayOf(blocker) : b}`);
      }
      if (ticket !== undefined) for (const r of [idOf(ticket), displayOf(ticket)]) done.add(r);
      done.add(ref);
    }
  });
  if (completions === 0) out.push("empty-idea-verify: session 2 completed no ticket");
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
    case "interrupted": return interruptedFindings(i);
    case "interrupted-edited": return [...interruptedFindings(i), ...editedFindings(i)];
    case "milestone-demo": return demoFindings(i);
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
}

/** The variant's checks on a driven run: its artifacts, then its own findings, each sourced as the variant's. */
export function applySessionChecks(state: DriveState, i: SessionCheckInputs): void {
  const completed = (i.log?.events ?? []).some((e) => e.point === "archive-committed");
  const findings = [
    ...artifactFindings(i.variant, completed, i.present),
    ...variantFindings({
      variant: i.variant, turns: cs7TurnsFrom(state.turns, state.allCalls), sessions: sessionSpans(state.turns), harness: i.harness,
      log: i.log, mapping: i.mapping, tickets: i.tickets, ticketsAtSetup: i.ticketsAtSetup, checkSet: state.checkSet,
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

/** Every evidence file under the project's docs/checkpoints/, by its project-relative path, digested now. */
export function observeEvidence(projectRoot: string, at: EvidenceObservation["at"]): EvidenceObservation[] {
  const out: EvidenceObservation[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ ref: relative(projectRoot, p).split(sep).join("/"), sha256: createHash("sha256").update(readFileSync(p)).digest("hex"), at });
    }
  };
  walk(join(projectRoot, "docs", "checkpoints"));
  return out;
}
