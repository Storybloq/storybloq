/**
 * T-507: the seat roster, roster v1 (ISS-1205 items 1, 3, 4).
 *
 * One JSON file per seat under `.story/telemetry/roster/`. A seat is a live
 * Claude Code session, one of its subagents, or (merged at read time, never
 * written here) a Codex task known only through its Bus endpoint. Records are
 * written by the storybloq CLI (`storybloq roster start|heartbeat|end`), which
 * a Claude Code function-hooks Mod (removed by owner ruling on 2026-09-15;
 * the core stays for the CLI, the MCP reader and the status views)
 * runs; nothing writes this JSON by hand.
 *
 * Identity. The presence ownerIdentity anchors a seat: `client:clientTaskId`,
 * plus `/agentId` for a subagent. `CLIENT_TASK_ID_PATTERN` forbids `/`, so the
 * derived seatId is unambiguous without an escape. The FILE name is a SHA-256
 * of the canonical tuple `[client, clientTaskId, agentId | null]`: fixed
 * length (an encoded tuple of two 128-byte ids would pass the 255-byte
 * basename limit), injective, and case-fold safe; the record carries the
 * tuple and the reader recomputes the hash, so a record cannot be planted
 * under another seat's name.
 *
 * Lifecycle. `running` is the only live state; `completed`, `failed`,
 * `killed` and `detached` are terminal. Transitions are monotonic within a
 * generation: a heartbeat or an end on a terminal seat is refused (a delayed
 * heartbeat cannot resurrect a finished child), and only a new `start` (a
 * restart under a new session id, the same identity) advances the generation
 * and resets to running, in place, never as a second row (ISS-1205
 * acceptance 1).
 *
 * Concurrency. Every read-modify-write and every reaper deletion runs under
 * the per-record lock the presence hooks already use (`<file>.lock`,
 * mkdir-based, 150 ms budget). Atomic rename alone prevents torn files, not
 * lost updates: a writer's heartbeat, its poll, a `turn.complete` and a manual
 * CLI call can all target one record inside a second. On contention a write
 * reports `skipped-contention`; it never claims a write it did not make.
 *
 * Reading is bounded twice: at most `ROSTER_SCAN_CAP` directory entries are
 * inspected (sorted by name, so the population is deterministic), and of the
 * records that parse the newest `ROSTER_RESULT_CAP` by `lastSeenAt` are
 * returned. Both cuts are reported (`scanTruncated`, `resultTruncated`) so a
 * count is never presented as complete when it is not.
 *
 * The `/telemetry/` location matters: the Mac app's watcher drops every
 * `/telemetry/` path except two named files, so roster writes never trigger a
 * project reload (see `presence/types.ts`).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";

// ISS-1240: from the zod-free copy, NOT `models/types.js`, whose first line is
// `import { z } from "zod"`. `storybloq-presence` imports this module, and that
// binary exists because pulling the shared bundle costs ~310ms per invocation;
// reaching into the models module would drag zod and the whole of it back in.
// `models/types.ts` carries the same warning about its own closure.
import { CLIENT_TASK_ID_PATTERN } from "../autonomous/client-profile.js";
import {
  acquireLock,
  atomicWriteInDir,
  directoryIdentity,
  ensureTelemetrySubdir,
  readBoundedNoFollow,
  releaseLock,
  removeRegularFile,
  telemetrySubdirIfPresent,
} from "../presence/io.js";

export const ROSTER_SCHEMA = "storybloq-roster/v1" as const;
export const ROSTER_SUBDIR = "roster";

/** A running seat unheard for this long renders as stale (ISS-1205 acceptance 3). */
export const ROSTER_STALE_MS = 10 * 60 * 1000;
/** A terminal seat is kept this long for audit (`roster list --all`), then reaped. */
export const ROSTER_TERMINAL_TTL_MS = 60 * 60 * 1000;
/** A running seat unheard for this long is reaped, matching the presence TTL. */
export const ROSTER_TTL_MS = 12 * 60 * 60 * 1000;
/** Directory entries inspected per read, sorted by name. */
export const ROSTER_SCAN_CAP = 256;
/** Seats returned per read, the newest by lastSeenAt. */
export const ROSTER_RESULT_CAP = 64;
/** Bus endpoint ids kept per merged identity. */
export const MAX_BUS_ENDPOINT_REFS = 4;

export const MAX_CLIENT_TASK_ID_BYTES = 128;
export const MAX_AGENT_ID_BYTES = 128;
export const MAX_SESSION_ID_BYTES = 128;
export const MAX_DESCRIPTION_BYTES = 200;
/** `codex:` + task id + `/` + agent id, the longest seatId the grammar allows. */
export const MAX_SEAT_ID_BYTES = 6 + 1 + MAX_CLIENT_TASK_ID_BYTES + 1 + MAX_AGENT_ID_BYTES;
/** Hard ceiling on a serialized record; the reader refuses anything larger. */
export const MAX_ROSTER_RECORD_BYTES = 4 * 1024;
/** A `.tmp-` file older than this whose writer is gone was never renamed; the presence sweep uses the same window. */
const TEMP_STALE_MS = 30_000;
/** `atomicWriteInDir` names its temp file `.tmp-<pid>-<ms>-<rand>`; the pid says who may still rename it. */
const TEMP_NAME = /^\.tmp-(\d+)-/;

/** True while the process that created a temp file could still rename it; unknown owners count as alive. */
function tempOwnerAlive(name: string): boolean {
  const m = TEMP_NAME.exec(name);
  if (m === null) return true;
  const pid = Number(m[1]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. Anything else (EPERM: alive, another user) is alive.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export type RosterClient = "claude" | "codex";
export type RosterState = "running" | "completed" | "failed" | "killed" | "detached";
export type RosterTerminalState = Exclude<RosterState, "running">;
export type RosterProvenance = "mod" | "bus";

export const ROSTER_STATES: readonly RosterState[] = ["running", "completed", "failed", "killed", "detached"];
export const ROSTER_TERMINAL_STATES: readonly RosterTerminalState[] = ["completed", "failed", "killed", "detached"];

export interface RosterSeat {
  readonly schema: typeof ROSTER_SCHEMA;
  readonly seatId: string;
  readonly client: RosterClient;
  readonly clientTaskId: string;
  readonly agentId: string | null;
  /** The client's session id, required on every persisted (mod) seat; null only for a seat synthesized from the Bus at read time. */
  readonly sessionId: string | null;
  readonly description: string | null;
  readonly state: RosterState;
  readonly provenance: RosterProvenance;
  /** Counts `start` events for this identity; 0 only for a seat synthesized from the Bus at read time. */
  readonly generation: number;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly sourceRefs: { readonly busEndpointIds: readonly string[] };
}

/** A seat as the reader presents it: the record plus what is derived at read time. */
export interface RosterSeatView extends RosterSeat {
  readonly stale: boolean;
}

/** What a writer asks for; identity fields name the seat, the rest is per kind. */
export type RosterSeatEvent =
  | {
      readonly kind: "start";
      readonly client: RosterClient;
      readonly clientTaskId: string;
      readonly agentId: string | null;
      /** Required: it is what tells a duplicate start (same session) from a restart (a new one). */
      readonly sessionId: string;
      readonly description: string | null;
    }
  | {
      readonly kind: "heartbeat";
      readonly client?: RosterClient;
      readonly clientTaskId?: string;
      readonly agentId?: string | null;
      /** The generation the writer is beating, from its own start result; a mismatch is refused (a late beat from a dead generation). */
      readonly generation: number;
    }
  | {
      readonly kind: "end";
      readonly state: RosterTerminalState;
      readonly client?: RosterClient;
      readonly clientTaskId?: string;
      readonly agentId?: string | null;
      /** The generation the writer is ending, from its own start result; a mismatch is refused (a late end from a dead generation). */
      readonly generation: number;
    };

/** `nowIso` must be a finite, canonical ISO timestamp; a record's clock is never a caller's guess. */
export function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export interface RosterView {
  readonly seats: readonly RosterSeatView[];
  readonly live: number;
  readonly stale: number;
  readonly terminal: number;
  readonly scanTruncated: boolean;
  readonly resultTruncated: boolean;
  readonly diagnostics: readonly string[];
  /**
   * ISS-1290: what the read could not establish, structured so a caller can
   * tell "nothing there" from "could not look". Present only when non-empty,
   * so a clean view keeps its exact historical shape. No printer reads it.
   */
  readonly readUncertainty?: readonly RosterReadUncertainty[];
}

/** ISS-1290: one thing a roster read could not establish. */
export interface RosterReadUncertainty {
  readonly source: "roster-directory" | "roster-entry" | "bus-endpoints" | "bus-endpoint" | "bus-probe";
  readonly cause: string;
  /** Set for `bus-probe` only: whose liveness is unknown. */
  readonly identity?: { readonly client: RosterClient; readonly clientTaskId: string };
  readonly endpointId?: string;
}

export type UpsertResult =
  | { readonly ok: true; readonly seatId: string; readonly seat: RosterSeat; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: "no-roster-dir" | "skipped-contention" | "refused-transition" | "write-failed" | "invalid-input";
      readonly message: string;
    };

/** `client:clientTaskId[/agentId]`; the task id grammar has no `/`, so this is unambiguous. */
export function seatIdOf(client: RosterClient, clientTaskId: string, agentId: string | null): string {
  return agentId === null ? `${client}:${clientTaskId}` : `${client}:${clientTaskId}/${agentId}`;
}

/** SHA-256 hex of the canonical tuple; the file's basename without extension. */
export function rosterFileBase(client: RosterClient, clientTaskId: string, agentId: string | null): string {
  return createHash("sha256").update(JSON.stringify([client, clientTaskId, agentId])).digest("hex");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function isClient(value: unknown): value is RosterClient {
  return value === "claude" || value === "codex";
}

function isState(value: unknown): value is RosterState {
  return typeof value === "string" && (ROSTER_STATES as readonly string[]).includes(value);
}

function isTerminal(state: RosterState): state is RosterTerminalState {
  return state !== "running";
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/;

/**
 * Validates a `start`'s identity and content by BYTES (the caps bound the
 * serialized record). Throws naming the field; the CLI turns that into an
 * `invalid_input` and a caller into one log line.
 */
export function validateStart(event: Extract<RosterSeatEvent, { kind: "start" }>): void {
  if (!isClient(event.client)) throw new Error("client must be claude or codex");
  if (
    typeof event.clientTaskId !== "string" ||
    !CLIENT_TASK_ID_PATTERN.test(event.clientTaskId) ||
    byteLength(event.clientTaskId) > MAX_CLIENT_TASK_ID_BYTES
  ) {
    throw new Error("clientTaskId must match the client task id grammar (no '/', at most 128 bytes)");
  }
  if (event.agentId !== null) {
    // Any non-empty id up to the byte cap: the client's agent id shape is not
    // a documented guarantee, and the hashed file name needs no restricted set.
    if (
      typeof event.agentId !== "string" ||
      event.agentId.length === 0 ||
      byteLength(event.agentId) > MAX_AGENT_ID_BYTES ||
      CONTROL_CHARS.test(event.agentId)
    ) {
      throw new Error("agentId must be a non-empty string of at most 128 bytes without control characters");
    }
  }
  if (
    typeof event.sessionId !== "string" ||
    event.sessionId.length === 0 ||
    byteLength(event.sessionId) > MAX_SESSION_ID_BYTES ||
    CONTROL_CHARS.test(event.sessionId)
  ) {
    throw new Error("sessionId is required: a non-empty string of at most 128 bytes without control characters");
  }
  if (event.description !== null && (typeof event.description !== "string" || byteLength(event.description) > MAX_DESCRIPTION_BYTES)) {
    throw new Error(`description must be null or at most ${MAX_DESCRIPTION_BYTES} bytes`);
  }
}

function laterIso(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * The lifecycle, pure: the next record for `event` over `current`, or null
 * when the transition is refused: a heartbeat or an end on a missing or
 * terminal seat, or one whose generation is not the record's (a late event
 * from a generation that has since been replaced; the generation is
 * required, every writer has it from its own start result). A `start` that
 * repeats the current running session (same sessionId) is idempotent and
 * only advances lastSeenAt; any other `start` is a restart: generation + 1,
 * running, `startedAt` reset. A restart dated before the record's
 * `lastSeenAt` is refused too: a delayed start must not replace a newer
 * session, and a duplicate start for a session that has already ENDED is
 * refused as well: only a different session may restart the seat.
 * `lastSeenAt` never moves backward. `nowIso` must be canonical.
 */
export function applySeatEvent(current: RosterSeat | null, event: RosterSeatEvent, nowIso: string): RosterSeat | null {
  if (!isCanonicalIso(nowIso)) throw new Error("nowIso must be a canonical ISO-8601 timestamp");
  if (event.kind === "start") {
    validateStart(event);
    // Every persisted seat carries a sessionId (validateStart and parseSeat
    // both require it), so this comparison decides every duplicate.
    if (current !== null && current.sessionId === event.sessionId) {
      // The same session again: a refresh while it runs, a refusal once it has ended.
      if (isTerminal(current.state)) return null;
      return { ...current, description: event.description ?? current.description, lastSeenAt: laterIso(current.lastSeenAt, nowIso) };
    }
    if (current !== null && Date.parse(nowIso) < Date.parse(current.lastSeenAt)) return null;
    const base = {
      schema: ROSTER_SCHEMA,
      seatId: seatIdOf(event.client, event.clientTaskId, event.agentId),
      client: event.client,
      clientTaskId: event.clientTaskId,
      agentId: event.agentId,
      sessionId: event.sessionId,
      description: event.description,
      state: "running" as const,
      provenance: "mod" as const,
      startedAt: nowIso,
      lastSeenAt: nowIso,
      sourceRefs: { busEndpointIds: [] as readonly string[] },
    };
    if (current === null) return { ...base, generation: 1 };
    return { ...base, generation: current.generation + 1, sourceRefs: current.sourceRefs };
  }
  if (!Number.isInteger(event.generation) || event.generation < 1) throw new Error("generation must be a positive integer");
  if (current === null || isTerminal(current.state)) return null;
  if (event.generation !== current.generation) return null;
  const lastSeenAt = laterIso(current.lastSeenAt, nowIso);
  if (event.kind === "heartbeat") return { ...current, lastSeenAt };
  return { ...current, state: event.state, lastSeenAt };
}

/**
 * Lenient parse of an on-disk record: null for anything structurally wrong,
 * for a state outside the table, for a record over the byte cap, and for a
 * tuple whose hash is not the file's own name.
 */
export function parseSeat(text: string, expectedFileBase: string): RosterSeat | null {
  if (byteLength(text) > MAX_ROSTER_RECORD_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r["schema"] !== ROSTER_SCHEMA) return null;
  const client = r["client"];
  const clientTaskId = r["clientTaskId"];
  if (!isClient(client)) return null;
  if (typeof clientTaskId !== "string" || !CLIENT_TASK_ID_PATTERN.test(clientTaskId) || byteLength(clientTaskId) > MAX_CLIENT_TASK_ID_BYTES) return null;
  const agentIdRaw = r["agentId"];
  if (
    agentIdRaw !== null &&
    (typeof agentIdRaw !== "string" || agentIdRaw.length === 0 || byteLength(agentIdRaw) > MAX_AGENT_ID_BYTES || CONTROL_CHARS.test(agentIdRaw))
  ) {
    return null;
  }
  const agentId = agentIdRaw as string | null;
  if (rosterFileBase(client, clientTaskId, agentId) !== expectedFileBase) return null;
  if (r["seatId"] !== seatIdOf(client, clientTaskId, agentId)) return null;
  const sessionId = r["sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0 || byteLength(sessionId) > MAX_SESSION_ID_BYTES || CONTROL_CHARS.test(sessionId)) return null;
  const description = r["description"];
  if (description !== null && (typeof description !== "string" || byteLength(description) > MAX_DESCRIPTION_BYTES)) return null;
  const state = r["state"];
  if (!isState(state)) return null;
  // Only the CLI persists records, and it persists `mod` seats with at least
  // one start behind them; a `bus` seat exists in a read-time view only.
  const provenance = r["provenance"];
  if (provenance !== "mod") return null;
  const generation = r["generation"];
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) return null;
  const startedAt = r["startedAt"];
  const lastSeenAt = r["lastSeenAt"];
  if (!isIso(startedAt) || !isIso(lastSeenAt) || Date.parse(lastSeenAt) < Date.parse(startedAt)) return null;
  const refs = r["sourceRefs"];
  const busEndpointIds: string[] = [];
  if (refs && typeof refs === "object" && Array.isArray((refs as Record<string, unknown>)["busEndpointIds"])) {
    for (const id of (refs as { busEndpointIds: unknown[] }).busEndpointIds) {
      if (typeof id === "string" && id.length > 0 && id.length <= 128 && busEndpointIds.length < MAX_BUS_ENDPOINT_REFS) busEndpointIds.push(id);
    }
  }
  return {
    schema: ROSTER_SCHEMA,
    seatId: r["seatId"] as string,
    client,
    clientTaskId,
    agentId,
    sessionId,
    description: description as string | null,
    state,
    provenance,
    generation,
    startedAt,
    lastSeenAt,
    sourceRefs: { busEndpointIds },
  };
}

/** `.story/telemetry/roster` validated at every level, or null; creates nothing. */
export function rosterDirIfPresent(root: string): string | null {
  return telemetrySubdirIfPresent(root, ROSTER_SUBDIR);
}

function identityOf(event: RosterSeatEvent): { client: RosterClient; clientTaskId: string; agentId: string | null } | null {
  if (!isClient(event.client) || typeof event.clientTaskId !== "string") return null;
  const agentId = event.agentId === undefined ? null : event.agentId;
  if (agentId !== null && typeof agentId !== "string") return null;
  return { client: event.client, clientTaskId: event.clientTaskId, agentId };
}

/**
 * The write path: lock, read, apply, atomic write, unlock. Best-effort
 * reaping of the directory afterwards, outside the record's lock, so an
 * active project keeps its roster short without a separate sweeper.
 */
export function upsertSeat(root: string, event: RosterSeatEvent, nowIso: string, now = Date.parse(nowIso)): UpsertResult {
  const id = identityOf(event);
  if (id === null) return { ok: false, reason: "invalid-input", message: "client and clientTaskId are required" };
  if (!CLIENT_TASK_ID_PATTERN.test(id.clientTaskId)) {
    return { ok: false, reason: "invalid-input", message: "clientTaskId must match the client task id grammar" };
  }
  if (!isCanonicalIso(nowIso)) return { ok: false, reason: "invalid-input", message: "nowIso must be a canonical ISO-8601 timestamp" };
  if (event.kind !== "start" && (!Number.isInteger(event.generation) || event.generation < 1)) {
    return { ok: false, reason: "invalid-input", message: "generation must be a positive integer" };
  }
  const seatId = seatIdOf(id.client, id.clientTaskId, id.agentId);
  const dir = event.kind === "start" ? ensureTelemetrySubdir(root, ROSTER_SUBDIR) : rosterDirIfPresent(root);
  if (dir === null) {
    // Only a start creates the directory; without one, every seat is absent.
    if (event.kind !== "start") return { ok: false, reason: "refused-transition", message: `${event.kind} refused: seat ${seatId} is absent` };
    return { ok: false, reason: "no-roster-dir", message: ".story/telemetry/roster is not a real directory" };
  }
  const base = rosterFileBase(id.client, id.clientTaskId, id.agentId);
  const path = join(dir, `${base}.json`);
  const lock = join(dir, `${base}.lock`);
  if (!acquireLock(lock)) return { ok: false, reason: "skipped-contention", message: `the record for ${seatId} is locked` };
  try {
    const text = readBoundedNoFollow(path, MAX_ROSTER_RECORD_BYTES);
    const current = text === null ? null : parseSeat(text, base);
    let next: RosterSeat | null;
    try {
      next = applySeatEvent(current, event, nowIso);
    } catch (err) {
      return { ok: false, reason: "invalid-input", message: err instanceof Error ? err.message : String(err) };
    }
    if (next === null) {
      const state = current === null ? "absent" : current.state;
      return { ok: false, reason: "refused-transition", message: `${event.kind} refused: seat ${seatId} is ${state}` };
    }
    if (!atomicWriteInDir(dir, path, JSON.stringify(next))) return { ok: false, reason: "write-failed", message: `could not write ${path}` };
    return { ok: true, seatId: next.seatId, seat: next, path };
  } finally {
    releaseLock(lock);
    sweepRoster(dir, now);
  }
}

interface ScannedRoster {
  readonly seats: RosterSeat[];
  readonly scanTruncated: boolean;
  readonly diagnostics: string[];
  readonly uncertainty: RosterReadUncertainty[];
}

/** The bounded, name-sorted scan. */
function scanRoster(dir: string): ScannedRoster {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return { seats: [], scanTruncated: false, diagnostics: ["roster directory unreadable"], uncertainty: [{ source: "roster-directory", cause: "unreadable" }] };
  }
  const scanTruncated = names.length > ROSTER_SCAN_CAP;
  const diagnostics: string[] = [];
  if (scanTruncated) diagnostics.push(`roster scan capped at ${ROSTER_SCAN_CAP} of ${names.length} entries`);
  const seats: RosterSeat[] = [];
  let unreadable = 0;
  for (const name of names.slice(0, ROSTER_SCAN_CAP)) {
    const base = name.slice(0, -".json".length);
    const text = readBoundedNoFollow(join(dir, name), MAX_ROSTER_RECORD_BYTES);
    const seat = text === null ? null : parseSeat(text, base);
    if (seat === null) {
      unreadable++;
      continue;
    }
    seats.push(seat);
  }
  const uncertainty: RosterReadUncertainty[] = [];
  if (unreadable > 0) {
    diagnostics.push(`${unreadable} roster ${unreadable === 1 ? "entry" : "entries"} unreadable or invalid`);
    uncertainty.push({ source: "roster-entry", cause: `${unreadable} unreadable or invalid` });
  }
  return { seats, scanTruncated, diagnostics, uncertainty };
}

export function isStaleSeat(seat: RosterSeat, now: number): boolean {
  return seat.state === "running" && now - Date.parse(seat.lastSeenAt) > ROSTER_STALE_MS;
}

function toView(seat: RosterSeat, now: number): RosterSeatView {
  return { ...seat, stale: isStaleSeat(seat, now) };
}

export function summarizeRoster(
  seats: readonly RosterSeatView[],
  scan: { scanTruncated: boolean; resultTruncated: boolean; diagnostics: readonly string[]; uncertainty?: readonly RosterReadUncertainty[] },
): RosterView {
  let live = 0;
  let stale = 0;
  let terminal = 0;
  for (const s of seats) {
    if (s.state !== "running") terminal++;
    else if (s.stale) stale++;
    else live++;
  }
  return {
    seats, live, stale, terminal, scanTruncated: scan.scanTruncated, resultTruncated: scan.resultTruncated, diagnostics: scan.diagnostics,
    ...(scan.uncertainty !== undefined && scan.uncertainty.length > 0 && { readUncertainty: scan.uncertainty }),
  };
}

/**
 * ISS-1290: the roster directory chain, classified rather than collapsed.
 * `rosterDirIfPresent` answers null for a missing level, an unreadable one
 * and a symlink alike; a caller deciding whether a seat is ABSENT needs to
 * know which. ENOENT anywhere is genuinely absent; any other failure, or a
 * level that is a symlink or not a directory, is a read that failed.
 */
function inspectRosterDir(root: string): { dir: string } | { absent: true } | { failed: string } {
  const levels = [".story", join(".story", "telemetry"), join(".story", "telemetry", ROSTER_SUBDIR)];
  for (const level of levels) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(join(root, level));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { absent: true };
      return { failed: `${level}: ${code ?? "lstat failed"}` };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { failed: `${level}: not a real directory` };
  }
  return { dir: join(root, levels[2]!) };
}

/** Reads the roster: creates nothing, reaps best-effort, bounds twice. */
export function readRoster(root: string, now = Date.now()): RosterView {
  const inspected = inspectRosterDir(root);
  if ("failed" in inspected) {
    return summarizeRoster([], { scanTruncated: false, resultTruncated: false, diagnostics: [], uncertainty: [{ source: "roster-directory", cause: inspected.failed }] });
  }
  if ("absent" in inspected) return summarizeRoster([], { scanTruncated: false, resultTruncated: false, diagnostics: [] });
  const dir = inspected.dir;
  sweepRoster(dir, now);
  const scan = scanRoster(dir);
  const bounded = boundViews(scan.seats.map((s) => toView(s, now)));
  return summarizeRoster(bounded.seats, { scanTruncated: scan.scanTruncated, resultTruncated: bounded.resultTruncated, diagnostics: scan.diagnostics, uncertainty: scan.uncertainty });
}

/** What the merge needs from a Bus endpoint; the caller resolves liveness (async) and projects. */
export interface BusSeatSource {
  readonly endpointId: string;
  readonly clientTaskId: string;
  readonly client: RosterClient;
  readonly joinedAt: string;
  readonly lastSeenAt: string;
  readonly lastWakeAt?: string | null;
  readonly retiredAt: string | null;
  readonly liveness: "attached" | "offline" | "unknown";
}

function observedAt(ep: BusSeatSource): number {
  const candidates = [ep.lastSeenAt, ep.lastWakeAt ?? null, ep.joinedAt]
    .map((v) => (v === null ? Number.NaN : Date.parse(v)))
    .filter((n) => !Number.isNaN(n));
  return candidates.length === 0 ? Number.NaN : Math.max(...candidates);
}

/**
 * Merges Bus endpoints into the seat list by identity (`client:clientTaskId`).
 * Only an endpoint the Bus liveness rule calls `attached` (and not retired)
 * is evidence of a live seat. Precedence is by freshness, not by source: a
 * fresh running mod seat wins; otherwise a newer attached endpoint supplies
 * liveness (state running, provenance bus, lastSeenAt = its observation) and
 * every attached endpoint id is kept, bounded, so succession duplicates stay
 * visible. An identity with no mod seat is synthesized with sessionId null
 * and generation 0; nothing is invented.
 */
export interface MergedRoster {
  readonly seats: readonly RosterSeatView[];
  /** The endpoint input exceeded ROSTER_SCAN_CAP; the population was cut, sorted by endpointId, and reported. */
  readonly scanTruncated: boolean;
  readonly resultTruncated: boolean;
}

export function mergeBusSeats(seats: readonly RosterSeat[], endpoints: readonly BusSeatSource[], now: number): MergedRoster {
  const attached = new Map<string, BusSeatSource[]>();
  // Bounded input: the endpoint source is a directory listing too. Sorted
  // by a stable key first, so the caller's ordering cannot decide which
  // seats exist, and the cut is reported rather than silent.
  const scanTruncated = endpoints.length > ROSTER_SCAN_CAP;
  const ordered = [...endpoints].sort((a, b) => a.endpointId.localeCompare(b.endpointId)).slice(0, ROSTER_SCAN_CAP);
  for (const ep of ordered) {
    if (ep.retiredAt !== null || ep.liveness !== "attached") continue;
    const key = seatIdOf(ep.client, ep.clientTaskId, null);
    const list = attached.get(key) ?? [];
    list.push(ep);
    attached.set(key, list);
  }
  const out: RosterSeatView[] = [];
  const merged = new Set<string>();
  for (const seat of seats) {
    const key = seatIdOf(seat.client, seat.clientTaskId, null);
    const eps = seat.agentId === null ? attached.get(key) : undefined;
    if (!eps || eps.length === 0) {
      out.push(toView(seat, now));
      continue;
    }
    merged.add(key);
    const ids = [...new Set([...seat.sourceRefs.busEndpointIds, ...eps.map((e) => e.endpointId)])].slice(0, MAX_BUS_ENDPOINT_REFS);
    const observations = eps.map(observedAt).filter((n) => !Number.isNaN(n));
    const newest = observations.length === 0 ? Number.NaN : Math.max(...observations);
    const seatSeen = Date.parse(seat.lastSeenAt);
    const modFresh = seat.state === "running" && !isStaleSeat(seat, now);
    if (modFresh || !(newest > seatSeen)) {
      out.push(toView({ ...seat, sourceRefs: { busEndpointIds: ids } }, now));
      continue;
    }
    const lifted: RosterSeat = {
      ...seat,
      state: "running",
      provenance: "bus",
      lastSeenAt: new Date(newest).toISOString(),
      sourceRefs: { busEndpointIds: ids },
    };
    out.push(toView(lifted, now));
  }
  for (const [key, eps] of attached) {
    if (merged.has(key)) continue;
    const first = eps[0]!;
    const observations = eps.map(observedAt).filter((n) => !Number.isNaN(n));
    const seenIso = observations.length === 0 ? first.joinedAt : new Date(Math.max(...observations)).toISOString();
    const synthesized: RosterSeat = {
      schema: ROSTER_SCHEMA,
      seatId: key,
      client: first.client,
      clientTaskId: first.clientTaskId,
      agentId: null,
      sessionId: null,
      description: null,
      state: "running",
      provenance: "bus",
      generation: 0,
      startedAt: eps.map((e) => e.joinedAt).sort()[0]!,
      lastSeenAt: seenIso,
      sourceRefs: { busEndpointIds: eps.map((e) => e.endpointId).slice(0, MAX_BUS_ENDPOINT_REFS) },
    };
    out.push(toView(synthesized, now));
  }
  return { ...boundViews(out), scanTruncated };
}

/** The newest `ROSTER_RESULT_CAP` by lastSeenAt, seatId as the tiebreak, and whether the cut removed anything. */
function boundViews(views: readonly RosterSeatView[]): { seats: readonly RosterSeatView[]; resultTruncated: boolean } {
  const sorted = [...views].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.seatId.localeCompare(b.seatId));
  return { seats: sorted.slice(0, ROSTER_RESULT_CAP), resultTruncated: sorted.length > ROSTER_RESULT_CAP };
}

/**
 * Expiry by the record's own clock. A file this reader cannot parse is NOT
 * expired on that account: a newer schema's record must survive an older
 * reader, so an unreadable file is judged by its mtime against the long TTL
 * only, the way the presence sweep judges every file.
 */
function isExpired(path: string, text: string | null, base: string, now: number): boolean {
  const seat = text === null ? null : parseSeat(text, base);
  if (seat === null) {
    try {
      return now - fs.lstatSync(path).mtimeMs > ROSTER_TTL_MS;
    } catch {
      return false;
    }
  }
  const age = now - Date.parse(seat.lastSeenAt);
  return seat.state === "running" ? age > ROSTER_TTL_MS : age > ROSTER_TERMINAL_TTL_MS;
}

/**
 * The reaper: terminal seats older than `ROSTER_TERMINAL_TTL_MS` and running
 * seats unheard past `ROSTER_TTL_MS`, judged by the record's own
 * `lastSeenAt`, each re-read under its lock immediately before the unlink so
 * a record another process just refreshed survives. A held lock skips the
 * record (it is someone's live write). A temp file is cleared only when it
 * is old AND the process named in its own file name no longer exists (a
 * paused writer still owns its temp file); lock directories never are.
 * Bounded by the scan cap.
 */
export function sweepRoster(dir: string, now = Date.now()): number {
  const identity = directoryIdentity(dir);
  if (identity === null) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, ROSTER_SCAN_CAP);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Lock directories are never reaped here: a paused writer may still hold
    // one, and removing it would let a second writer in under the first. The
    // lock primitive's own stale handling (`acquireLock`) is the only reaper
    // of an abandoned lock.
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".tmp-")) {
      try {
        const st = fs.lstatSync(path);
        if (now - st.mtimeMs > TEMP_STALE_MS && !tempOwnerAlive(entry.name) && removeRegularFile(dir, path, identity)) removed++;
      } catch {
        /* vanished */
      }
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    const base = entry.name.slice(0, -".json".length);
    if (!isExpired(path, readBoundedNoFollow(path, MAX_ROSTER_RECORD_BYTES), base, now)) continue;
    const lock = join(dir, `${base}.lock`);
    if (!acquireLock(lock, 0)) continue; // someone's live write; leave it
    try {
      // Re-check under the lock: a refresh between the first read and here keeps it.
      if (!isExpired(path, readBoundedNoFollow(path, MAX_ROSTER_RECORD_BYTES), base, now)) continue;
      if (removeRegularFile(dir, path, identity)) removed++;
    } finally {
      releaseLock(lock);
    }
  }
  return removed;
}
