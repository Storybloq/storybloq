/**
 * ISS-1022: presence record parsing, transitions and serialization.
 *
 * Pure over its inputs -- no filesystem, no clock -- so every ordering and cap
 * property below is testable without a temp directory.
 *
 * ORDERING MODEL. A counter minted inside the write lock records
 * lock-acquisition order, not causal order, and the record cannot carry a
 * session incarnation that later events prove they belong to (hook payloads
 * carry `session_id` and nothing identifying WHICH start minted the current
 * record, and SessionStart cannot inject anything into the parent process).
 * So ordering has exactly one sound source: Claude Code's own event
 * sequencing. Every presence hook is registered SYNCHRONOUSLY, which is how
 * that sequencing is inherited. `SessionStart` is therefore an ordered
 * generation transition rather than a claim later payloads verify.
 *
 * `closedToolIds` is belt and braces on top of that, and its guarantee is
 * BOUNDED, not absolute: it holds the most recent MAX_CLOSED_TOOL_IDS closures,
 * so a straggler `PreToolUse` whose id was evicted by that many subsequent
 * closures WOULD reopen its tool. Making that impossible needs a no-false-
 * negative structure (a per-generation Bloom filter), and it is not worth the
 * bytes: reaching the eviction window requires an ordering violation of exactly
 * the kind synchronous registration already prevents, and the cost of the
 * residual case is one stale row that the next `Stop` clears. The bound is
 * pinned by test rather than left to be rediscovered.
 */

import {
  MAX_AGENT_IDS,
  MAX_CLOSED_TOOL_IDS,
  MAX_ID_BYTES,
  MAX_OPEN_TOOLS,
  MAX_RECORD_BYTES,
  MAX_TARGET_BYTES,
  MAX_TOOL_NAME_BYTES,
  PRESENCE_SCHEMA_VERSION,
  SESSION_ID_PATTERN,
  type PresenceHookEvent,
  type PresenceOpenTool,
  type SessionPresence,
} from "./types.js";
import { capString } from "./redaction.js";

export interface PresenceEventContext {
  readonly event: PresenceHookEvent;
  readonly sessionId: string;
  readonly nowIso: string;
  /** SessionStart `source` ("startup" | "resume" | "clear" | "compact" | "fork" | ...). */
  readonly source: string | null;
  readonly toolId: string | null;
  readonly toolName: string | null;
  readonly target: string | null;
  readonly agentId: string | null;
  readonly suppressed: boolean;
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/**
 * Lenient parse of an on-disk record. Anything structurally wrong yields null
 * (the caller then starts a fresh record); individual malformed ENTRIES inside
 * an otherwise valid record are dropped rather than failing the whole parse,
 * so one bad tool entry never erases a live session.
 */
export function parsePresenceRecord(text: string, sessionId: string): SessionPresence | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.sessionId !== sessionId) return null; // a record for someone else is not ours to merge

  const startedAt = isoOrNull(r.startedAt);
  if (startedAt === null) return null; // no anchor -- treat as absent

  return {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    sessionId,
    generation: safeCount(r.generation, 0),
    startedAt,
    lastEventAt: isoOrNull(r.lastEventAt) ?? startedAt,
    source: capString(r.source, MAX_TOOL_NAME_BYTES),
    openTools: parseOpenTools(r.openTools),
    closedToolIds: parseIdList(r.closedToolIds, MAX_CLOSED_TOOL_IDS),
    agentIds: parseIdList(r.agentIds, MAX_AGENT_IDS),
    suppressed: r.suppressed === true,
    endedAt: isoOrNull(r.endedAt),
  };
}

/**
 * Applies one hook event. `prev` is null for a record that does not exist yet
 * or could not be parsed.
 */
export function applyPresenceEvent(
  prev: SessionPresence | null,
  ctx: PresenceEventContext,
): SessionPresence {
  const base: SessionPresence = prev ?? {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    sessionId: ctx.sessionId,
    generation: 0,
    startedAt: ctx.nowIso,
    lastEventAt: ctx.nowIso,
    source: null,
    openTools: [],
    closedToolIds: [],
    agentIds: [],
    suppressed: false,
    endedAt: null,
  };

  switch (ctx.event) {
    case "SessionStart":
      return {
        ...base,
        // `startedAt` survives resume/clear/compact: they continue the same
        // session, and the panel shows how long that session has been going.
        startedAt: base.startedAt,
        generation: base.generation + 1,
        source: ctx.source,
        lastEventAt: ctx.nowIso,
        openTools: [],
        closedToolIds: [],
        agentIds: [],
        suppressed: ctx.suppressed,
        // A start on a tombstoned record revives it. `/exit` then reopening the
        // same session id must not leave the row permanently hidden.
        endedAt: null,
      };

    case "PreToolUse": {
      const id = ctx.toolId;
      const tool = ctx.toolName;
      let openTools = base.openTools;
      if (tool && id !== null && !base.closedToolIds.includes(id) && !base.openTools.some((t) => t.id === id)) {
        const entry: PresenceOpenTool = {
          id,
          tool,
          target: ctx.target,
          startedAt: ctx.nowIso,
          agentId: ctx.agentId,
        };
        openTools = capTail([...base.openTools, entry], MAX_OPEN_TOOLS);
      }
      return {
        ...base,
        lastEventAt: ctx.nowIso,
        openTools,
        agentIds: ctx.agentId ? capTail(withUnique(base.agentIds, ctx.agentId), MAX_AGENT_IDS) : base.agentIds,
        suppressed: ctx.suppressed,
      };
    }

    case "PostToolUse": {
      const id = ctx.toolId;
      const closing = id !== null
        ? base.openTools.find((t) => t.id === id)
        // No `tool_use_id` from this client: close the OLDEST open call with the
        // same name. Correlation degrades under parallel same-tool calls; it
        // never closes a DIFFERENT tool.
        : base.openTools.find((t) => t.tool === ctx.toolName);
      const closedId = id ?? closing?.id ?? null;
      return {
        ...base,
        lastEventAt: ctx.nowIso,
        openTools: closing ? base.openTools.filter((t) => t !== closing) : base.openTools,
        // Recorded even when nothing was open, so a PreToolUse that arrives
        // after its PostToolUse cannot open a tool that already finished --
        // within the eviction window documented at the top of this file.
        closedToolIds: closedId
          ? capTail(withUnique(base.closedToolIds, closedId), MAX_CLOSED_TOOL_IDS)
          : base.closedToolIds,
        suppressed: ctx.suppressed,
      };
    }

    case "Stop":
      return {
        ...base,
        lastEventAt: ctx.nowIso,
        openTools: [],
        agentIds: [],
        suppressed: ctx.suppressed,
      };

    case "SessionEnd":
      return {
        ...base,
        lastEventAt: ctx.nowIso,
        openTools: [],
        agentIds: [],
        suppressed: ctx.suppressed,
        endedAt: ctx.nowIso,
      };
  }
}

/**
 * Serializes within MAX_RECORD_BYTES, shedding the least load-bearing state
 * first. Null means the record could not be made to fit and must not be
 * written -- the reader is bounded by the same number, so an oversized write
 * would produce a file nothing can read.
 *
 * The shedding ladder is LAST-RESORT defence, not a working path: the per-field
 * caps hold the worst case `applyPresenceEvent` can produce well under the
 * bound, and `parsePresenceRecord` re-applies those caps on read, so a corrupt
 * or hand-written file cannot reach it either. Both properties are pinned in
 * test/presence/presence-record.test.ts, because the ladder would otherwise rot
 * unnoticed behind the fact that nothing calls it.
 */
export function serializePresence(record: SessionPresence): string | null {
  let current = record;
  for (let step = 0; ; step++) {
    const text = JSON.stringify(current) + "\n";
    if (Buffer.byteLength(text, "utf-8") <= MAX_RECORD_BYTES) return text;
    const next = PRESENCE_SHED_STEPS[step];
    if (!next) return null;
    current = next(current);
  }
}

/**
 * The shedding ladder, in order, exported so the ORDER itself can be pinned.
 *
 * Ordered by how load-bearing each field is to a reader: closed ids are pure
 * ordering defence and nobody renders them; agent ids are a detail; targets are
 * nice to have; the open tools themselves are the only thing the panel actually
 * shows, so they go last and never entirely.
 */
export const PRESENCE_SHED_STEPS: ReadonlyArray<(r: SessionPresence) => SessionPresence> = [
  (r) => ({ ...r, closedToolIds: r.closedToolIds.slice(-8) }),
  (r) => ({ ...r, agentIds: r.agentIds.slice(-4) }),
  (r) => ({ ...r, openTools: r.openTools.slice(-2).map((t) => ({ ...t, target: null })) }),
  (r) => ({ ...r, closedToolIds: [], agentIds: [], openTools: r.openTools.slice(-1) }),
];

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? value : null;
}

function safeCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1e9
    ? value
    : fallback;
}

function parseOpenTools(value: unknown): readonly PresenceOpenTool[] {
  if (!Array.isArray(value)) return [];
  const out: PresenceOpenTool[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = capString(e.id, MAX_ID_BYTES);
    const tool = capString(e.tool, MAX_TOOL_NAME_BYTES);
    const startedAt = isoOrNull(e.startedAt);
    if (!id || !tool || !startedAt) continue;
    if (out.some((t) => t.id === id)) continue;
    out.push({
      id,
      tool,
      target: capString(e.target, MAX_TARGET_BYTES),
      startedAt,
      agentId: capString(e.agentId, MAX_ID_BYTES),
    });
    if (out.length >= MAX_OPEN_TOOLS) break;
  }
  return out;
}

function parseIdList(value: unknown, cap: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const id = capString(entry, MAX_ID_BYTES);
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** Keeps the most recent `max` entries; the oldest are the ones we can afford to forget. */
function capTail<T>(list: readonly T[], max: number): readonly T[] {
  return list.length <= max ? list : list.slice(list.length - max);
}

function withUnique(list: readonly string[], value: string): readonly string[] {
  return list.includes(value) ? list : [...list, value];
}
