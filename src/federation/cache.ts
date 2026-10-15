import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FederationState } from "./state.js";
import type { CrossNodeRefStatus } from "./cross-node-resolver.js";
import { COUNTING_CONTRACT } from "./scanner.js";

export interface CachedNodeSummary {
  /** Absent on a legacy entry (B4: its old numbers are never rewritten or relabelled). */
  ticketCount?: number;
  openTickets?: number;
  completeTickets?: number;
  issueCount?: number;
  openIssues?: number;
  lastHandoverDate?: string | null;
  lastHandoverTitle?: string | null;
  reachable: boolean;
  unreachableReason?: string;
  /** T-486 U2-3b: absent means 1 (raw records, umbrellas included). Only a summary computed in this process is stamped 2. */
  countingContract?: number;
  deliveredTickets?: number;
  withdrawnTickets?: number;
  ticketWarnings?: number;
  excludedTickets?: number;
  partial?: boolean;
  /** A contract-1 entry whose rescan failed: excluded from totals until a rescan succeeds. */
  legacy?: boolean;
  legacyReason?: string;
  legacyAt?: string;
}

export interface FederationCache {
  lastScanTimestamp: string;
  nodes: Record<string, CachedNodeSummary>;
  crossNodeRefStatuses?: Record<string, string>;
}

const CACHE_FILENAME = "federation-cache.json";

export function readFederationCache(storyDir: string): FederationCache | null {
  const cachePath = join(storyDir, CACHE_FILENAME);
  try {
    const raw = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as FederationCache;
    if (!parsed.lastScanTimestamp || !parsed.nodes) return null;
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      try { unlinkSync(cachePath); } catch { /* ENOENT or permission -- ignore */ }
    }
    return null;
  }
}

export function writeFederationCache(
  storyDir: string,
  state: FederationState,
  refStatuses?: ReadonlyMap<string, CrossNodeRefStatus>,
): void {
  const cache: FederationCache = {
    lastScanTimestamp: state.lastScanTimestamp,
    nodes: {},
  };

  for (const entry of state.nodes) {
    if (entry.legacy) {
      cache.nodes[entry.name] = {
        reachable: entry.reachable, countingContract: 1, legacy: true, legacyReason: entry.legacy.reason, legacyAt: entry.legacy.at,
      };
      continue;
    }
    const s = entry.scanSummary;
    const summary: CachedNodeSummary = {
      ticketCount: entry.scanSummary?.ticketCount ?? 0,
      openTickets: entry.scanSummary?.openTickets ?? 0,
      completeTickets: entry.scanSummary?.completeTickets ?? 0,
      issueCount: entry.scanSummary?.issueCount ?? 0,
      openIssues: entry.scanSummary?.openIssues ?? 0,
      lastHandoverDate: entry.scanSummary?.lastHandoverDate ?? null,
      lastHandoverTitle: entry.scanSummary?.lastHandoverTitle ?? null,
      reachable: entry.reachable,
    };
    if (s?.countingContract === COUNTING_CONTRACT) {
      summary.countingContract = s.countingContract;
      summary.deliveredTickets = s.deliveredTickets;
      summary.withdrawnTickets = s.withdrawnTickets;
      summary.ticketWarnings = s.ticketWarnings;
      summary.excludedTickets = s.excludedTickets;
      summary.partial = s.partial;
    }
    if (!entry.reachable && entry.unreachableReason) {
      summary.unreachableReason = entry.unreachableReason;
    }
    cache.nodes[entry.name] = summary;
  }

  if (refStatuses && refStatuses.size > 0) {
    const statuses: Record<string, string> = {};
    for (const [ref, s] of refStatuses) {
      statuses[ref] = s.resolved ? s.status : "unresolved";
    }
    cache.crossNodeRefStatuses = statuses;
  }

  writeFederationCacheObject(storyDir, cache);
}

/** The one atomic cache write (temp file then rename); callers treat it as best-effort. */
export function writeFederationCacheObject(storyDir: string, cache: FederationCache): void {
  const cachePath = join(storyDir, CACHE_FILENAME);
  const tmpPath = `${cachePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(cache, null, 2) + "\n");
    renameSync(tmpPath, cachePath);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ENOENT expected on happy path */ }
  }
}
