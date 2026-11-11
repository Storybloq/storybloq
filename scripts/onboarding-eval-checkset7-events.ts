/**
 * T-538 S5a, check set 7: the setup engine's events log, as the eval bundle
 * (scripts/eval-fault-mcp.ts) writes it, and the rules read from it.
 *
 * Completion: the `archive-committed` event plus its verified snapshot. Rule
 * 7: the ordered events, per setup invocation and the effective plan at its
 * revision. The mapping: each setup-apply call in the transcript to the one
 * invocation it started, by tool, argument digest and position.
 */
import { createHash } from "node:crypto";
import { setupArgSha256, type SetupApplyCliOptions } from "../src/cli/commands/setup-apply.js";
import { heredocStdin } from "./onboarding-eval-checkset6.js";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface SetupEvent {
  /** The line's index in the log, which is the order the events were fsynced in. */
  readonly line: number;
  readonly attempt: string;
  readonly seq: number;
  readonly point: string;
  readonly setupId: string | null;
  readonly invocation: string | null;
  readonly revision: string | null;
  readonly kind?: string;
  readonly argSha256?: string;
  readonly exitCode?: number;
  readonly sha256?: string;
  readonly target?: string;
  readonly snapshotSha256?: string;
}

export interface EventsAttempt {
  readonly line: number;
  readonly attempt: string;
  readonly pid: number;
  readonly entry: string;
  /** T-538 5.2: the entry's own confinement probe, when the harness asked for it. */
  readonly sandbox?: "held" | "absent";
  /** T-538 5.4: the sha256 of the inventory the entry enforced, when it was given one. */
  readonly tools?: string;
}

/** T-538 5.4: a tool the entry did not register because the inventory does not permit it. */
export interface EventsWithheld {
  readonly line: number;
  readonly attempt: string;
  readonly name: string;
}

export interface EventsOverlap {
  readonly line: number;
  readonly attempt: string;
  readonly invocation: string;
  readonly open: readonly string[];
}

export interface EventsLog {
  readonly attempts: readonly EventsAttempt[];
  readonly events: readonly SetupEvent[];
  readonly overlaps: readonly EventsOverlap[];
  readonly withheld?: readonly EventsWithheld[];
  /** T-538 6.1: one record per schedule entry that fired, written by the collector just before its kill. */
  readonly fired?: readonly EventsFired[];
}

/** T-538 6.1: `{type: "fault-fired", id, selector, point, target, invocation}` on its attempt's sequence. */
export interface EventsFired {
  readonly line: number;
  readonly attempt: string;
  readonly id: string;
  readonly selector: string;
  readonly point: string;
  readonly target: string | null;
  readonly invocation: string | null;
}

export class EventsLogError extends Error {}

const str = (v: unknown): v is string => typeof v === "string" && v !== "";
const strOrNull = (v: unknown): v is string | null => v === null || str(v);

/** The log, line by line; anything it cannot read is an error, never skipped. */
export function parseEventsLog(text: string): EventsLog {
  if (text === "") throw new EventsLogError("the events log is empty");
  if (!text.endsWith("\n")) throw new EventsLogError("the events log ends inside a line");
  const attempts: EventsAttempt[] = [];
  const events: SetupEvent[] = [];
  const overlaps: EventsOverlap[] = [];
  const withheld: EventsWithheld[] = [];
  const fired: EventsFired[] = [];
  const known = new Set<string>();
  text.slice(0, -1).split("\n").forEach((raw, line) => {
    let x: Record<string, unknown>;
    try {
      x = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new EventsLogError(`events log line ${line + 1} is not JSON`);
    }
    if (typeof x !== "object" || x === null || Array.isArray(x) || !str(x.attempt)) throw new EventsLogError(`events log line ${line + 1} names no attempt`);
    if (x.seq === undefined) {
      if (!Number.isInteger(x.pid) || !str(x.entry) || known.has(x.attempt)) throw new EventsLogError(`events log line ${line + 1} is not an attempt line`);
      if (x.sandbox !== undefined && x.sandbox !== "held" && x.sandbox !== "absent") throw new EventsLogError(`events log line ${line + 1} is not an attempt line`);
      if (x.tools !== undefined && !(typeof x.tools === "string" && /^[0-9a-f]{64}$/.test(x.tools))) throw new EventsLogError(`events log line ${line + 1} is not an attempt line`);
      known.add(x.attempt);
      attempts.push({
        line, attempt: x.attempt, pid: x.pid as number, entry: x.entry,
        ...(x.sandbox !== undefined ? { sandbox: x.sandbox as "held" | "absent" } : {}),
        ...(x.tools !== undefined ? { tools: x.tools as string } : {}),
      });
      return;
    }
    if (!known.has(x.attempt)) throw new EventsLogError(`events log line ${line + 1} belongs to no attempt line before it`);
    if (!Number.isInteger(x.seq)) throw new EventsLogError(`events log line ${line + 1} has no sequence number`);
    if (x.overlap === true) {
      if (!str(x.invocation) || !Array.isArray(x.open)) throw new EventsLogError(`events log line ${line + 1} is not an overlap record`);
      overlaps.push({ line, attempt: x.attempt, invocation: x.invocation, open: x.open.map(String) });
      return;
    }
    if (x.type === "tool-withheld") {
      if (!str(x.name)) throw new EventsLogError(`events log line ${line + 1} is not a withheld-tool record`);
      withheld.push({ line, attempt: x.attempt, name: x.name });
      return;
    }
    if (x.type === "fault-fired") {
      if (!str(x.id) || !str(x.selector) || !str(x.point) || !strOrNull(x.target) || !strOrNull(x.invocation)) throw new EventsLogError(`events log line ${line + 1} is not a fired record`);
      fired.push({ line, attempt: x.attempt, id: x.id, selector: x.selector, point: x.point, target: x.target, invocation: x.invocation });
      return;
    }
    if (!str(x.point) || !strOrNull(x.setupId) || !strOrNull(x.invocation) || !strOrNull(x.revision)) throw new EventsLogError(`events log line ${line + 1} is not an event`);
    events.push({ ...(x as object), line, attempt: x.attempt, seq: x.seq as number, point: x.point, setupId: x.setupId, invocation: x.invocation, revision: x.revision } as SetupEvent);
  });
  if (attempts.length === 0) throw new EventsLogError("the events log has no attempt line");
  return { attempts, events, overlaps, withheld, ...(fired.length > 0 ? { fired } : {}) };
}

/** Reads the log, or returns its error as a finding for a run's grading. */
export function readEventsLog(text: string | null): { log: EventsLog | null; findings: string[] } {
  if (text === null) return { log: null, findings: ["setup incomplete: the run has no events log"] };
  try {
    return { log: parseEventsLog(text), findings: [] };
  } catch (err) {
    if (err instanceof EventsLogError) return { log: null, findings: [`setup incomplete: ${err.message}`] };
    throw err;
  }
}

const isCommit = (point: string) => point.startsWith("step:") || point.startsWith("skip:") || point === "archive-committed";
const isRead = (point: string) => point === "invocation-start" || point === "invocation-end" || point.startsWith("skip:");
const short = (revision: string | null) => (revision === null ? "none" : revision.slice(0, 12));

export interface Completion {
  /** The setup completed: one `archive-committed` with a snapshot that verifies. */
  readonly complete: boolean;
  readonly archive: SetupEvent | null;
  readonly findings: readonly string[];
}

/**
 * The ledger boundary: one `archive-committed` whose snapshot verifies, a
 * `step:archive` that repeats its digest (absent only when the invocation was
 * killed after the archive committed), and no commit event from an
 * invocation that started after it.
 */
export function completion(log: EventsLog, snapshotText: string | null): Completion {
  const findings: string[] = [];
  const archives = log.events.filter((e) => e.point === "archive-committed");
  if (archives.length === 0) return { complete: false, archive: null, findings: ["setup incomplete: no archive-committed event"] };
  const bySetup = new Map<string, number>();
  for (const a of archives) bySetup.set(a.setupId ?? "", (bySetup.get(a.setupId ?? "") ?? 0) + 1);
  for (const [setupId, n] of bySetup) if (n > 1) findings.push(`completion: archive-committed appears ${n} times for setup ${setupId}`);
  const archive = archives[0]!;
  if (snapshotText === null) return { complete: false, archive, findings: [...findings, "setup incomplete: the archive-committed snapshot is missing"] };
  if (archive.snapshotSha256 === undefined || sha256(snapshotText) !== archive.snapshotSha256) {
    return { complete: false, archive, findings: [...findings, "setup incomplete: the setup snapshot does not match archive-committed's digest"] };
  }
  const stepArchive = log.events.find((e) => e.point === "step:archive" && e.setupId === archive.setupId);
  if (stepArchive === undefined) {
    const ended = log.events.some((e) => e.point === "invocation-end" && e.attempt === archive.attempt && e.invocation === archive.invocation);
    if (ended) findings.push(`completion: invocation ${archive.invocation} ended after archive-committed with no step:archive`);
  } else if (stepArchive.snapshotSha256 !== archive.snapshotSha256) {
    findings.push("completion: step:archive's snapshot digest differs from archive-committed's");
  }
  const later = new Set(log.events.filter((e) => e.point === "invocation-start" && e.line > archive.line).map((e) => `${e.attempt}\u0000${e.invocation}`));
  for (const e of log.events) {
    if (e.line > archive.line && isCommit(e.point) && later.has(`${e.attempt}\u0000${e.invocation}`)) {
      findings.push(`completion: ${e.point} in invocation ${e.invocation}, which started after archive-committed`);
    }
  }
  return { complete: true, archive, findings };
}

/**
 * Rule 7: within each invocation and revision, `step:` follows the plan's
 * order at that revision; a step commits once per (setup, revision);
 * `step:archive` happens once per setup and only reads follow it.
 * `plans(revision)` is the effective plan's step ids, or null for a revision
 * no amendment prefix of the archived payload has.
 */
export function rule7(log: EventsLog, plans: (revision: string) => readonly string[] | null): string[] {
  const findings: string[] = [];
  const last = new Map<string, number>();
  const committed = new Map<string, number>();
  const archivedAt = new Map<string, number>();
  for (const e of log.events) {
    if (e.setupId !== null && archivedAt.has(e.setupId) && !isRead(e.point)) {
      findings.push(`rule 7: ${e.point} follows step:archive for setup ${e.setupId}`);
    }
    if (!e.point.startsWith("step:")) continue;
    const id = e.point.slice("step:".length);
    const plan = e.revision === null ? null : plans(e.revision);
    if (plan === null) {
      findings.push(`rule 7: ${e.point} is at revision ${short(e.revision)}, which no amendment of the archived payload produces`);
      continue;
    }
    const at = plan.indexOf(id);
    if (at < 0) {
      findings.push(`rule 7: ${e.point} is not a step of the plan at revision ${short(e.revision)}`);
      continue;
    }
    const scope = `${e.attempt}\u0000${e.invocation}\u0000${e.revision}`;
    if (at <= (last.get(scope) ?? -1)) findings.push(`rule 7: ${e.point} is out of the plan's order in invocation ${e.invocation}`);
    last.set(scope, at);
    const key = `${e.setupId}\u0000${e.revision}\u0000${id}`;
    const n = (committed.get(key) ?? 0) + 1;
    committed.set(key, n);
    if (n === 2) findings.push(`rule 7: ${e.point} committed again at the same revision ${short(e.revision)}`);
    if (id === "archive") {
      if (e.setupId !== null && archivedAt.has(e.setupId)) findings.push(`rule 7: step:archive happens more than once for setup ${e.setupId}`);
      if (e.setupId !== null) archivedAt.set(e.setupId, e.line);
    }
  }
  return findings;
}

// --- the invocation mapping ---------------------------------------------------------------------

/** A setup-apply call as the transcript shows it. */
export interface SetupCallInput {
  readonly name: string;
  readonly command: string | null;
  readonly input: unknown;
  readonly output: string;
  readonly isError?: boolean;
}

export interface SetupCallRef {
  readonly turn: number;
  readonly call: number;
  readonly via: "mcp" | "cli";
  /** The argument digest the engine would compute for this call, or null when the transcript cannot establish it. */
  readonly digest: string | null;
  /** Its result is an error or missing: the call a killed invocation maps to. */
  readonly failed: boolean;
}

const isMcp = (name: string, tool: string) => name === tool || name.endsWith(`__${tool}`);
const CLI_SETUP_APPLY = /^storybloq setup-apply\b/;

/** The single-quoted, double-quoted or bare value after a flag on the command's first line, or undefined. */
export function flagValue(head: string, flag: string): string | undefined {
  const m = new RegExp(`\\s${flag}\\s+(?:'([^']*)'|"((?:[^"\\\\]|\\\\.)*)"|([^\\s'"]+))`).exec(head);
  if (!m) return undefined;
  return m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]);
}

/** The digest of one CLI call: its flags from the first line, its stdin from a quoted here-document. */
function cliDigest(command: string): string | null {
  const head = command.split("\n")[0]!;
  const opts: SetupApplyCliOptions = {
    ...(/\s--resume\b/.test(head) ? { resume: true } : {}),
    ...(/\s--setup\b/.test(head) ? { setup: flagValue(head, "--setup") ?? "" } : {}),
    ...(/\s--resolve\b/.test(head) ? { resolve: flagValue(head, "--resolve") ?? "" } : {}),
  };
  const takesPayload = opts.resume !== true && opts.resolve === undefined && opts.setup === undefined;
  if (!takesPayload) return setupArgSha256(opts, null);
  const here = heredocStdin(command);
  if (here !== null) return setupArgSha256(opts, here);
  // No here-document: stdin the transcript does not hold (a pipe or a redirect) cannot be digested; none at all is empty.
  return /<|\|/.test(head) ? null : setupArgSha256(opts, "");
}

/** The digest of one MCP call, built as storybloq_setup_apply builds its CLI options. */
function mcpDigest(input: unknown): string {
  const a = (input ?? {}) as { payload?: unknown; resume?: unknown; setup?: unknown; resolutions?: unknown };
  const opts: SetupApplyCliOptions = {
    resume: a.resume === true,
    ...(typeof a.setup === "string" ? { setup: a.setup } : {}),
    ...(a.resolutions !== undefined ? { resolve: JSON.stringify(a.resolutions) } : {}),
  };
  const takesPayload = opts.resume !== true && opts.resolve === undefined && opts.setup === undefined;
  return setupArgSha256(opts, takesPayload ? (a.payload === undefined ? "" : JSON.stringify(a.payload)) : null);
}

/** Every setup-apply call in transcript order, with its digest. */
export function setupCalls(turns: readonly { readonly calls: readonly SetupCallInput[] }[]): SetupCallRef[] {
  const out: SetupCallRef[] = [];
  turns.forEach((turn, t) => turn.calls.forEach((c, i) => {
    const failed = c.isError === true || c.output === "";
    if (c.command !== null && CLI_SETUP_APPLY.test(c.command)) out.push({ turn: t, call: i, via: "cli", digest: cliDigest(c.command), failed });
    else if (isMcp(c.name, "storybloq_setup_apply")) out.push({ turn: t, call: i, via: "mcp", digest: mcpDigest(c.input), failed });
  }));
  return out;
}

export interface InvocationMapping {
  readonly turn: number;
  readonly call: number;
  readonly attempt: string;
  readonly invocation: string;
  readonly kind: string;
  /** null for an invocation that never ended (killed). */
  readonly exitCode: number | null;
}

/** Every event inside its invocation: after its start, in its attempt, before its end, with one start. */
function lifecycleFindings(log: EventsLog): string[] {
  const out: string[] = [];
  const state = new Map<string, "open" | "ended">();
  for (const e of log.events) {
    const owned = e.point === "invocation-start" || e.point === "invocation-end" || e.point === "archive-committed" || e.point.startsWith("step:") || e.point.startsWith("skip:");
    if (e.invocation === null) {
      if (owned) out.push(`mapping: ${e.point} names no invocation`);
      continue;
    }
    const key = `${e.attempt}\u0000${e.invocation}`;
    const was = state.get(key);
    if (e.point === "invocation-start") {
      if (was !== undefined) out.push(`mapping: invocation ${e.invocation} started twice in attempt ${e.attempt}`);
      state.set(key, "open");
    } else if (was === undefined) out.push(`mapping: ${e.point} in invocation ${e.invocation} has no invocation-start in attempt ${e.attempt}`);
    else if (was === "ended") out.push(`mapping: ${e.point} in invocation ${e.invocation} comes after its invocation-end`);
    else if (e.point === "invocation-end") state.set(key, "ended");
  }
  return out;
}

/**
 * One call to one invocation, by position (the calls in transcript order
 * against the `invocation-start` events in log order), with the digest
 * matching. A killed invocation maps to a call whose result is an error or
 * missing. An unmapped call or invocation, and every overlap record, fail,
 * and so does an event outside its invocation's lifecycle and a call whose
 * client is not the process the invocation ran in.
 */
export function mapInvocations(calls: readonly SetupCallRef[], log: EventsLog): { mapping: InvocationMapping[]; findings: string[] } {
  const findings: string[] = [];
  const mapping: InvocationMapping[] = [];
  const starts = log.events.filter((e) => e.point === "invocation-start");
  for (const o of log.overlaps) findings.push(`mapping: invocation ${o.invocation} started while ${o.open.join(", ")} was still open`);
  findings.push(...lifecycleFindings(log));
  const n = Math.min(calls.length, starts.length);
  for (let i = 0; i < n; i++) {
    const c = calls[i]!;
    const s = starts[i]!;
    const end = log.events.find((e) => e.point === "invocation-end" && e.attempt === s.attempt && e.invocation === s.invocation);
    const where = `turn ${c.turn + 1} call ${c.call + 1}`;
    if (c.digest === null) findings.push(`mapping: ${where} has arguments the transcript cannot digest`);
    else if (c.digest !== s.argSha256) findings.push(`mapping: ${where}'s argument digest differs from invocation ${s.invocation}'s`);
    if (end === undefined && !c.failed) findings.push(`mapping: invocation ${s.invocation} never ended, but ${where} has a result`);
    const attempt = log.attempts.find((a) => a.attempt === s.attempt);
    if (attempt === undefined) findings.push(`mapping: invocation ${s.invocation} ran in attempt ${s.attempt}, which has no attempt line`);
    else if (attempt.entry !== c.via) findings.push(`mapping: ${where} went through the ${c.via}, but invocation ${s.invocation} ran in a ${attempt.entry} process`);
    mapping.push({ turn: c.turn, call: c.call, attempt: s.attempt, invocation: s.invocation!, kind: s.kind ?? "", exitCode: end?.exitCode ?? null });
  }
  for (const c of calls.slice(n)) findings.push(`mapping: turn ${c.turn + 1} call ${c.call + 1} maps to no invocation`);
  for (const s of starts.slice(n)) findings.push(`mapping: invocation ${s.invocation} maps to no call`);
  return { mapping, findings };
}
