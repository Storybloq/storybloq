/**
 * T-538 commit 3 (plan v5 6.2): checkpoint states across the milestone-states sessions. At each boundary the
 * harness copies, through the collector, the ledger that work selection reads into `raw/states/<n>/.story/`, and
 * computes a record from that copy alone with the product's own loader and queries: `checkpointState`
 * (owner-checkpoint.ts:235) for the checkpoint, `nextTickets(state, 50)` and `blockedTickets(state)`
 * (queries.ts:245, 336) for ready and blocked. No CLI text is read. The copies are replay inputs, and the regrade
 * recomputes every record from them.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadProjectNoRecover } from "../src/core/project-loader.js";
import { checkpointReleases, checkpointState, parseOwnerCheckpoint } from "../src/core/owner-checkpoint.js";
import { blockedTickets, nextTickets } from "../src/core/queries.js";
import { findCheckpoint, type CheckpointSpec } from "./onboarding-eval-checkset7.js";

/** One boundary's record (plan v5 6.2). `dependent.blocked` is whether the checkpoint holds the dependent. */
export interface StateRecord {
  readonly at: string;
  readonly checkpoint: { readonly id: string; readonly state: string | null; readonly historyEvents: readonly string[] } | null;
  readonly dependent: { readonly id: string; readonly blocked: boolean } | null;
  readonly ready: readonly string[];
  readonly blocked: readonly string[];
  readonly tickets: readonly { readonly id: string; readonly title: string; readonly status: string }[];
  /** Set when the copy could not be loaded; the record then holds no checkpoint. */
  readonly error?: string;
}

/** The records file, beside the copies: `{records: StateRecord[]}`. */
export const STATES_RAW = "states.json";
/** What work selection reads, and so what each capture copies. */
export const STATE_PARTS: readonly string[] = ["tickets", "issues", "config.json", "roadmap.json"];
/** Capture n's folder in the raw directory, and one of its files by `.story/`-relative path. */
export const stateDir = (n: number): string => `states/${n}`;
export const stateFile = (n: number, rel: string): string => `${stateDir(n)}/.story/${rel}`;
/** A pinned capture file's name, as the record's replay inputs list it. */
export const STATE_FILE = /^states\/(\d+)\/\.story\/(tickets\/[^/]+|issues\/[^/]+|config\.json|roadmap\.json)$/;

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * Copies the work-selection parts of a collector copy of `.story/` into `<rawDir>/states/<n>/.story/` and returns
 * each copied file as a replay input. Only regular files are copied; the collector copy keeps links as links, and
 * a link is never followed.
 */
export function copyStateParts(storyCopy: string, rawDir: string, n: number): { path: string; sha256: string }[] {
  const out: { path: string; sha256: string }[] = [];
  const copy = (rel: string): void => {
    const from = join(storyCopy, rel);
    const st = lstatSync(from, { throwIfNoEntry: false });
    if (st === undefined) return;
    if (st.isDirectory()) { for (const name of readdirSync(from).sort()) copy(`${rel}/${name}`); return; }
    if (!st.isFile()) return;
    const name = stateFile(n, rel);
    const to = join(rawDir, name);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    out.push({ path: name, sha256: sha256(readFileSync(to)) });
  };
  if (existsSync(storyCopy)) for (const part of STATE_PARTS) copy(part);
  return out;
}

/**
 * The record of one capture, from `<root>/.story/` alone, with the product's loader and queries. The loader is the
 * read-only one (no lock, no transaction recovery): a copy is evidence and is never written. A copy the loader
 * refuses gives a record with the refusal and no checkpoint, so the boundary fails rather than the run.
 */
export async function stateRecord(root: string, at: string, spec: CheckpointSpec | null, dependent: string | null): Promise<StateRecord> {
  try {
    return await loadedRecord(root, at, spec, dependent);
  } catch (err) {
    return { at, checkpoint: null, dependent: dependent === null ? null : { id: dependent, blocked: false }, ready: [], blocked: [], tickets: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function loadedRecord(root: string, at: string, spec: CheckpointSpec | null, dependent: string | null): Promise<StateRecord> {
  const { state } = await loadProjectNoRecover(root);
  const found = spec === null ? null : findCheckpoint(state.tickets, spec);
  const cp = found !== null && "ticket" in found ? found.ticket as typeof state.tickets[number] : null;
  const parsed = cp === null ? null : parseOwnerCheckpoint(cp);
  const next = nextTickets(state, 50);
  const ready = next.kind === "found" ? next.candidates.map((c) => c.ticket.id) : [];
  const blocked = blockedTickets(state).map((t) => t.id);
  const dep = dependent === null ? null : state.ticketByID(dependent) ?? null;
  return {
    at,
    checkpoint: cp === null ? null : { id: cp.id, state: checkpointState(cp), historyEvents: parsed?.kind === "ok" ? parsed.checkpoint.history.map((h) => h.event) : [] },
    // P7: each blockedBy entry resolved as the product resolves it, so an edge stored under the checkpoint's display
    // id holds the dependent the same as one stored under its id.
    dependent: dependent === null ? null : { id: dependent, blocked: dep !== null && cp !== null && dep.blockedBy.some((ref) => { const r = state.resolveTicketRef(ref); return r.kind === "found" && r.item.id === cp.id; }) && !checkpointReleases(cp) },
    ready,
    blocked,
    tickets: state.tickets.map((t) => ({ id: t.id, title: t.title, status: t.status })),
  };
}

/** The labels of the boundaries, in order: before each turn of sessions 2 and 3, then after the last turn. */
export const STATE_BOUNDARIES: readonly string[] = ["milestone-run", "demo-approval", "reopen", "reapproval", "change-request", "dependent-run", "after-last"];

/** Every entry under `<rawDir>/states/`, as raw-relative names, links and other non-files included (never followed). */
export function stateNames(rawDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const st = lstatSync(join(rawDir, rel), { throwIfNoEntry: false });
    if (st === undefined) return;
    if (st.isDirectory()) { for (const name of readdirSync(join(rawDir, rel)).sort()) walk(`${rel}/${name}`); return; }
    out.push(rel);
  };
  walk("states");
  return out;
}

/** The records file's text for a list of records. */
export const statesText = (records: readonly StateRecord[]): string => `${JSON.stringify({ records }, null, 2)}\n`;

/**
 * The regrade's recompute: each record again from its copy under `<rawDir>/states/<n>/`, at the recorded boundary
 * label and dependent. The labels and the dependent are checked against the replay by the regrade; every other
 * field must come out equal to the recorded one.
 */
export async function recomputeStates(rawDir: string, recorded: readonly StateRecord[], spec: CheckpointSpec | null): Promise<StateRecord[]> {
  const out: StateRecord[] = [];
  for (const [n, r] of recorded.entries()) out.push(await stateRecord(join(rawDir, stateDir(n)), r.at, spec, r.dependent?.id ?? null));
  return out;
}

/** Parses the records file; throws on any other shape. */
export function parseStateRecords(text: string): StateRecord[] {
  const v = JSON.parse(text) as { records?: unknown };
  if (v === null || typeof v !== "object" || !Array.isArray(v.records)) throw new Error("not {records: [...]}");
  for (const r of v.records as Record<string, unknown>[]) {
    if (r === null || typeof r !== "object" || typeof r.at !== "string" || !Array.isArray(r.ready) || !Array.isArray(r.blocked) || !Array.isArray(r.tickets)) throw new Error("a record is not a state record");
  }
  return v.records as StateRecord[];
}

/**
 * The boundary assertions (plan v5 6.2), n counting from 0. Boundary 6's own rules (the targeted run came back
 * checkpoint-blocked; the status update refused for the checkpoint reason, the ledger unchanged) are demoFindings',
 * which this variant also runs. A missing capture fails its boundary.
 */
export function statesFindings(records: readonly StateRecord[] | null, followUpTitle: string | null): string[] {
  const v = "milestone-states";
  const out: string[] = [];
  const at = (n: number): StateRecord | null => {
    const r = records?.[n];
    if (r === undefined || r.at !== STATE_BOUNDARIES[n]) { out.push(`${v}: no state capture at boundary ${n} (${STATE_BOUNDARIES[n]})`); return null; }
    if (r.error !== undefined) { out.push(`${v}: boundary ${n} (${r.at}): the captured ledger could not be loaded (${r.error})`); return null; }
    if (r.checkpoint === null) { out.push(`${v}: boundary ${n} (${r.at}) holds no checkpoint`); return null; }
    if (r.dependent === null) { out.push(`${v}: boundary ${n} (${r.at}) holds no dependent`); return null; }
    return r;
  };
  const is = (n: number, r: StateRecord, state: string): void => { if (r.checkpoint!.state !== state) out.push(`${v}: boundary ${n} (${r.at}): the checkpoint is ${String(r.checkpoint!.state)}, not ${state}`); };
  const last = (n: number, r: StateRecord, event: string): void => { if (r.checkpoint!.historyEvents.at(-1) !== event) out.push(`${v}: boundary ${n} (${r.at}): the checkpoint's history ends ${r.checkpoint!.historyEvents.at(-1) ?? "empty"}, not ${event}`); };
  const held = (n: number, r: StateRecord, want: boolean): void => { if (r.dependent!.blocked !== want) out.push(`${v}: boundary ${n} (${r.at}): the dependent ${r.dependent!.id} is ${r.dependent!.blocked ? "" : "not "}blocked by the checkpoint`); };
  const r0 = at(0);
  if (r0 !== null) {
    is(0, r0, "pending");
    if (!r0.blocked.includes(r0.dependent!.id) || r0.ready.includes(r0.dependent!.id)) out.push(`${v}: boundary 0 (${r0.at}): the dependent ${r0.dependent!.id} is not blocked and out of the ready list`);
    if (!r0.ready.some((id) => id !== r0.checkpoint!.id && id !== r0.dependent!.id)) out.push(`${v}: boundary 0 (${r0.at}): no other ticket is ready`);
  }
  at(1);
  const r2 = at(2);
  if (r2 !== null) { is(2, r2, "approved"); held(2, r2, false); }
  const r3 = at(3);
  if (r3 !== null) { is(3, r3, "pending"); last(3, r3, "reopened"); held(3, r3, true); }
  const r4 = at(4);
  if (r4 !== null) is(4, r4, "approved");
  const r5 = at(5);
  if (r5 !== null) {
    is(5, r5, "pending"); last(5, r5, "changed"); held(5, r5, true);
    const title = followUpTitle === null ? null : new RegExp(followUpTitle);
    if (title === null || !r5.tickets.some((t) => title.test(t.title))) out.push(`${v}: boundary 5 (${r5.at}): no ticket's title matches the follow-up ${followUpTitle ?? "(none set)"}`);
  }
  at(6);
  if (records !== null && records.length > STATE_BOUNDARIES.length) out.push(`${v}: ${records.length} state captures, more than the ${STATE_BOUNDARIES.length} boundaries`);
  return out;
}
