/**
 * T-477 section 2.1: the HEAVY-PATH half of role-aware presence.
 *
 * This file is never reachable from `src/hooks/presence-entry.ts` -- it
 * freely imports the arrangement/session-scan stack (Zod included), which is
 * exactly the import the slim binary must never carry. It is imported only
 * by already-heavy CLI/MCP command files (`storybloq status`, `storybloq
 * session milestone`), which do a LOCKED read-modify-write onto a session's
 * own presence record using presence's OWN existing lock/write primitives
 * (`acquireLock`/`releaseLock`/`atomicWriteInDir`, all in `presence/io.ts`,
 * all lightweight and already safe to import from a heavy process). The
 * slim hook changes by exactly one rule: preserve, never compute, the four
 * new fields (see `presence/record.ts`'s `applyPresenceEvent`).
 */

import { join } from "node:path";
import type { OwnerTask, StorybloqClient } from "../autonomous/client-profile.js";
import { loadArrangementsSafe } from "./arrangement-loader.js";
import { scanSessionSummaries } from "./session-scan.js";
import { matchArrangements, type GuardCaller } from "./session-guard.js";
import type { Arrangement } from "../models/arrangement.js";
import {
  acquireLock,
  atomicWriteInDir,
  ensurePresenceDir,
  listPresenceRecordPaths,
  readBoundedNoFollow,
  releaseLock,
  LOCK_ACQUIRE_BUDGET_MS,
} from "../presence/io.js";
import { parsePresenceRecord, serializePresence } from "../presence/record.js";
import { CLOCK_SKEW_TOLERANCE_MS } from "./clock-skew.js";
import {
  MAX_ARRANGEMENT_PRESENCE_ENTRIES,
  MAX_RECORD_BYTES,
  PRESENCE_SCHEMA_VERSION,
  PRESENCE_TTL_MS,
  presenceFileBase,
  type ArrangementPresenceEntry,
  type OwnerIdentity,
  type SessionPresence,
} from "../presence/types.js";

/**
 * `status`'s enrichment write uses the SAME short budget the hook uses:
 * on contention it skips writing the enrichment for this call and returns
 * normal status output unchanged -- an enrichment miss is not a status
 * failure. The milestone command uses a longer, deliberate budget (below).
 */
export const STATUS_ENRICHMENT_LOCK_BUDGET_MS = LOCK_ACQUIRE_BUDGET_MS;
/**
 * A milestone ping is a deliberate, low-frequency act worth a short wait --
 * unlike the hook's per-tool-call fail-soft posture, a milestone write must
 * never report a silent "written" outcome for a ping that was actually
 * dropped, so this budget is generous before the caller sees an explicit,
 * retryable error.
 */
export const MILESTONE_LOCK_BUDGET_MS = LOCK_ACQUIRE_BUDGET_MS * 5;

/**
 * Computes `arrangementPresence` for `ownerTask`'s own identity: every
 * arrangement it participates in (as pen or worker), and -- for a `pen`-role
 * entry -- whether the worker party is currently active, checked against
 * BOTH populations (plan section 0): a scanned autonomous session with
 * `leaseState === "live"`, OR a presence record whose `ownerIdentity`
 * matches the worker's `identityAnchor` with a fresh `lastEventAt`.
 */
export function computeArrangementPresence(
  root: string,
  ownerTask: OwnerTask,
  now: number = Date.now(),
): { entries: readonly ArrangementPresenceEntry[]; truncated: boolean } {
  const { arrangements } = loadArrangementsSafe(root);
  const active = arrangements.filter((a) => a.lifecycle !== "closed");
  if (active.length === 0) return { entries: [], truncated: false };

  const summaries = scanSessionSummaries(root);
  const caller: GuardCaller = { client: ownerTask.client, task: ownerTask };
  const announcements = matchArrangements(caller, summaries, active);
  const byId = new Map<string, Arrangement>(active.map((a) => [a.id, a]));

  const candidates = announcements.map((a): ArrangementPresenceEntry & { createdDate: string } => {
    const arrangement = byId.get(a.arrangementId)!;
    let supervising: { workerActive: boolean } | null = null;
    if (a.role === "pen") {
      const worker = arrangement.parties.find((p) => p.role === "worker");
      const workerActive = worker
        ? summaries.activeSessions.some(
            (s) => s.ownerTask && s.ownerTask.client === worker.client && s.ownerTask.id === worker.identityAnchor,
          ) || hasLivePresenceMatch(root, worker.client, worker.identityAnchor, now)
        : false;
      supervising = { workerActive };
    }
    return {
      arrangementId: a.arrangementId,
      // `a.lifecycle` can only be "active" or "suspended" here -- `active`
      // above already excludes every closed arrangement.
      role: a.role,
      lifecycle: a.lifecycle as "active" | "suspended",
      supervising,
      createdDate: arrangement.createdDate,
    };
  });

  // Cap, deterministic end-to-end (plan section 2.4): truncate to
  // MAX_ARRANGEMENT_PRESENCE_ENTRIES by lifecycle priority (active before
  // suspended), then createdDate descending, then arrangementId ascending.
  const bySelectionOrder = [...candidates].sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) return a.lifecycle === "active" ? -1 : 1;
    if (a.createdDate !== b.createdDate) return a.createdDate > b.createdDate ? -1 : 1;
    return a.arrangementId < b.arrangementId ? -1 : a.arrangementId > b.arrangementId ? 1 : 0;
  });
  const truncated = bySelectionOrder.length > MAX_ARRANGEMENT_PRESENCE_ENTRIES;
  const kept = bySelectionOrder.slice(0, MAX_ARRANGEMENT_PRESENCE_ENTRIES);
  // Output ordering: sorted by arrangementId ascending.
  const entries = [...kept]
    .sort((a, b) => (a.arrangementId < b.arrangementId ? -1 : a.arrangementId > b.arrangementId ? 1 : 0))
    .map(({ arrangementId, role, lifecycle, supervising }) => ({ arrangementId, role, lifecycle, supervising }));

  return { entries, truncated };
}

/**
 * Scans every OTHER session's presence record (never the caller's own) for
 * one whose `ownerIdentity` matches `(client, identityAnchor)` with a
 * `lastEventAt` inside `PRESENCE_TTL_MS` -- the presence-record half of the
 * dual-population worker-liveness check. Best-effort and read-only: a
 * record it cannot parse is simply skipped, matching this whole feature's
 * visibility-only posture.
 */
function hasLivePresenceMatch(root: string, client: StorybloqClient, identityAnchor: string, now: number): boolean {
  for (const path of listPresenceRecordPaths(root)) {
    const text = readBoundedNoFollow(path, MAX_RECORD_BYTES);
    if (text === null) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const claimedSessionId = (raw as Record<string, unknown>).sessionId;
    if (typeof claimedSessionId !== "string") continue;
    const record = parsePresenceRecord(text, claimedSessionId);
    if (!record || !record.ownerIdentity) continue;
    if (record.ownerIdentity.client !== client || record.ownerIdentity.clientTaskId !== identityAnchor) continue;
    // A tombstoned session (explicit SessionEnd) is not live even when its
    // final lastEventAt is still fresh -- endedAt is exactly the signal that
    // this liveness check exists to honor, not to ignore.
    if (record.endedAt !== null) continue;
    const lastEventMs = Date.parse(record.lastEventAt);
    if (!Number.isFinite(lastEventMs)) continue;
    const age = now - lastEventMs;
    // Same tolerance as the milestone clock-skew rule: a `lastEventAt` more
    // than CLOCK_SKEW_TOLERANCE_MS in the future is a corrupt or skewed
    // record, not proof of life, and must not read as live indefinitely.
    if (age >= -CLOCK_SKEW_TOLERANCE_MS && age <= PRESENCE_TTL_MS) return true;
  }
  return false;
}

export type EnrichmentOutcome =
  | { readonly status: "written" }
  | { readonly status: "skipped-no-directory" }
  | { readonly status: "skipped-lock-busy" }
  | { readonly status: "skipped-too-large" }
  | { readonly status: "skipped-write-failed" };

function freshRecord(sessionId: string, nowIso: string, source: string): SessionPresence {
  return {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    sessionId,
    generation: 0,
    startedAt: nowIso,
    lastEventAt: nowIso,
    source,
    openTools: [],
    closedToolIds: [],
    agentIds: [],
    suppressed: false,
    endedAt: null,
    arrangementPresence: [],
    arrangementPresenceTruncated: false,
    milestone: null,
    ownerIdentity: null,
  };
}

/**
 * The ONE locked read-modify-write path both `storybloq status`'s
 * enrichment and `storybloq session milestone`'s write use -- same lock
 * file, same primitives the slim hook already uses, only the budget and the
 * mutation differ per caller. `freshRecordSource` names how a brand-new
 * record (no prior presence write for this session at all) came to exist,
 * so a reader can distinguish a hook-created record from one this heavy
 * path minted first.
 */
export function applyPresenceEnrichment(
  root: string,
  sessionId: string,
  budgetMs: number,
  freshRecordSource: string,
  mutate: (base: SessionPresence, nowIso: string) => SessionPresence,
  now: () => Date = () => new Date(),
): EnrichmentOutcome {
  const dir = ensurePresenceDir(root);
  if (!dir) return { status: "skipped-no-directory" };

  const base = presenceFileBase(sessionId);
  const recordPath = join(dir, `${base}.json`);
  const lockPath = join(dir, `${base}.lock`);

  if (!acquireLock(lockPath, budgetMs)) return { status: "skipped-lock-busy" };
  try {
    const nowIso = now().toISOString();
    const existingText = readBoundedNoFollow(recordPath, MAX_RECORD_BYTES);
    const previous = existingText === null ? null : parsePresenceRecord(existingText, sessionId);
    const baseRecord = previous ?? freshRecord(sessionId, nowIso, freshRecordSource);
    const next = mutate(baseRecord, nowIso);
    const serialized = serializePresence(next);
    if (serialized === null) return { status: "skipped-too-large" };
    return atomicWriteInDir(dir, recordPath, serialized) ? { status: "written" } : { status: "skipped-write-failed" };
  } finally {
    releaseLock(lockPath);
  }
}

export function ownerIdentityOf(ownerTask: OwnerTask): OwnerIdentity {
  return { client: ownerTask.client, clientTaskId: ownerTask.id };
}
