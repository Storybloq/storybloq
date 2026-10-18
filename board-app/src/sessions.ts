import {
  parsePresenceRecord,
  isValidSessionId,
} from "../../src/presence/record.js";
import {
  presenceFileBase,
  PRESENCE_SCHEMA_VERSION,
} from "../../src/presence/types.js";
import { CROCKFORD_CLASS } from "../../src/models/types.js";
import { createRootCheck } from "./edit-policy.js";
import type { RootAccess } from "./federation.js";
import { readRuntime, type RuntimeScope } from "./runtime-reader.js";
import { parseStatus } from "./session-status.js";
import {
  presenceActivity,
  supervision,
  milestoneProjection,
  sessionStatus,
} from "./session-projection.js";
import type {
  SessionsPayload,
  PresenceRow,
  SessionRecord,
} from "./sessions-types.js";

const GENERATION_ID = new RegExp(`^${CROCKFORD_CLASS}{16}$`);
/**
 * The directory holding the CURRENT owner's alive and shutdown files, resolved
 * the way the CLI's resolveOwnerTelemetry does: an absent generation is the
 * legacy directory, and anything that cannot be read or validated is no
 * answer at all, since after a takeover the legacy directory belongs to the
 * displaced owner.
 */
async function ownerTelemetry(scope: RuntimeScope, sessionId: string) {
  const session = ["sessions", sessionId];
  const text = await scope.optionalText([...session, "state.json"], 256 * 1024);
  if (text === undefined) return undefined;
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!state || typeof state !== "object" || Array.isArray(state))
    return undefined;
  const generation = state.heartbeatGeneration;
  if (generation === undefined || generation === null)
    return [...session, "telemetry"];
  if (typeof generation !== "string" || !GENERATION_ID.test(generation))
    return undefined;
  return [...session, "telemetry", "generations", generation];
}
async function applyTelemetry(scope: RuntimeScope, record: SessionRecord) {
  const last = await scope.text(
    ["sessions", record.sessionId, "telemetry", "lastMcpCall"],
    128,
  );
  if (!last?.trim()) return;
  // Unresolvable ownership keeps the status payload's own health signals.
  const dir = await ownerTelemetry(scope, record.sessionId);
  if (!dir) return;
  if (await scope.marker([...dir, "shutdown"])) {
    record.alive = false;
    record.lastMcpCall = last.trim();
    record.telemetryAvailable = true;
    return;
  }
  const alive = await scope.text([...dir, "alive"], 128);
  if (!alive || !/^\+?\d+$/.test(alive.trim())) return;
  const ms = BigInt(alive.trim());
  if (ms > 9223372036854775807n) return;
  record.alive = ms > 0n;
  record.lastMcpCall = last.trim();
  record.telemetryAvailable = true;
}
async function readPresence(scope: RuntimeScope, now: number) {
  const { names, unread } = await scope.presenceFiles(),
    items: PresenceRow[] = [];
  let malformed = 0,
    unsupported = 0;
  for (const name of names) {
    const text = await scope.text(["telemetry", "presence", name], 16 * 1024);
    let raw;
    try {
      raw = JSON.parse(text ?? "");
    } catch {
      malformed++;
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      malformed++;
      continue;
    }
    if (
      raw.schemaVersion !== undefined &&
      raw.schemaVersion !== PRESENCE_SCHEMA_VERSION
    ) {
      if (
        typeof raw.schemaVersion === "number" &&
        raw.schemaVersion > PRESENCE_SCHEMA_VERSION
      )
        unsupported++;
      else malformed++;
      continue;
    }
    if (
      !isValidSessionId(raw.sessionId) ||
      name !== presenceFileBase(raw.sessionId) + ".json"
    ) {
      malformed++;
      continue;
    }
    const parsed = parsePresenceRecord(text!, raw.sessionId);
    if (!parsed) {
      malformed++;
      continue;
    }
    // The Mac treats any string endedAt (including empty) as an explicit tombstone.
    const endedAt =
      typeof raw.endedAt === "string" ? raw.endedAt : parsed.endedAt;
    const activity = presenceActivity({ ...parsed, endedAt }, now);
    if (!activity.visible) continue;
    items.push({
      sessionId: parsed.sessionId,
      startedAt: parsed.startedAt,
      lastEventAt: parsed.lastEventAt,
      source: parsed.source,
      agentCount: parsed.agentIds.length,
      activity,
      openTools: parsed.openTools.map((t) => ({
        id: t.id,
        tool: t.tool,
        target: t.target,
        startedAt: t.startedAt,
      })),
      arrangements: parsed.arrangementPresence.map((a) => ({
        arrangementId: a.arrangementId,
        role: a.role,
        lifecycle: a.lifecycle,
        supervising: a.supervising
          ? { workerActive: a.supervising.workerActive }
          : null,
      })),
      supervision: supervision(parsed.arrangementPresence),
      arrangementPresenceTruncated: parsed.arrangementPresenceTruncated,
      milestone: milestoneProjection(parsed.milestone, now),
    });
  }
  return { items, unread, malformed, unsupported };
}
export function createSessions(root: string, access: Promise<RootAccess>) {
  const checkRoot = createRootCheck(
    root,
    access,
    "The local project connection changed. Reconnect before reading sessions.",
  );
  return async (offset = 0): Promise<SessionsPayload> => {
    // Startup aliases are accepted once; each read still proves the declared root identity.
    const fixed = (await access).fixed.canonical,
      now = Date.now();
    return readRuntime(fixed, checkRoot, async (scope) => {
      const status = parseStatus(
        await scope.text(["status.json"], 256 * 1024),
        now,
      );
      if (status.record) {
        await applyTelemetry(scope, status.record);
        status.record.derivedStatus = sessionStatus(status.record, now);
      }
      const roster = await readPresence(scope, now),
        limit = 20,
        total = roster.items.length,
        page = Math.min(
          offset,
          total ? Math.floor((total - 1) / limit) * limit : 0,
        );
      return {
        loadedAt: new Date(now).toISOString(),
        status,
        presence: {
          ...roster,
          items: roster.items.slice(page, page + limit),
          total,
          offset: page,
          limit,
        },
      };
    });
  };
}
