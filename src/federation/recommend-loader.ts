import { join } from "node:path";
import type { Config } from "../models/config.js";
import type { FederationState, FederationNodeEntry } from "./state.js";
import type { NodeHealth } from "../models/federation-config.js";
import type { NodeScanSummary } from "./scanner.js";
import { readFederationCache, writeFederationCache, writeFederationCacheObject, type CachedNodeSummary, type FederationCache } from "./cache.js";
import { resolveAllNodes, type ResolvedNode } from "./resolver.js";
import { COUNTING_CONTRACT, runNodeScans, scanAllSummaries, type NodeScanJob, type NodeScanResult, type NodeScanSchedule } from "./scanner.js";
import { aggregateTotals, buildFederationState } from "./state.js";

const FEDERATION_CACHE_TTL_MS = 300_000;

function extractNodeEntries(
  config: Config,
): Record<string, { path: string }> | null {
  const nodes = config.nodes as Record<string, unknown> | undefined;
  if (!nodes || typeof nodes !== "object" || Object.keys(nodes).length === 0) return null;
  return Object.fromEntries(
    Object.entries(nodes)
      .filter(([, v]) => v != null && typeof v === "object")
      .map(([k, v]) => [k, { path: typeof (v as Record<string, unknown>).path === "string" ? (v as Record<string, unknown>).path as string : "" }]),
  );
}

function reconstructFromCache(
  cache: FederationCache,
  config: Config,
): FederationState | null {
  const nodesConfig = (config.nodes ?? {}) as Record<string, Record<string, unknown>>;
  const entries: FederationNodeEntry[] = [];
  let reachableCount = 0;
  let unreachableCount = 0;

  for (const [name, cached] of Object.entries(cache.nodes)) {
    const nodeConf = nodesConfig[name] ?? {};
    // T-486 U2-3b: only a contract-2 entry carries numbers a total may use;
    // summariesForTotals has already rescanned or marked every other one.
    const legacy = cached.reachable && cached.countingContract !== COUNTING_CONTRACT
      ? { reason: cached.legacyReason ?? "summary on the old counting contract", at: cached.legacyAt ?? cache.lastScanTimestamp }
      : undefined;
    const scanSummary: NodeScanSummary | undefined = cached.reachable && !legacy
      ? {
          project: name,
          type: "unknown",
          ticketCount: cached.ticketCount ?? 0,
          openTickets: cached.openTickets ?? 0,
          completeTickets: cached.completeTickets ?? 0,
          deliveredTickets: cached.deliveredTickets ?? 0,
          withdrawnTickets: cached.withdrawnTickets ?? 0,
          ticketWarnings: cached.ticketWarnings ?? 0,
          excludedTickets: cached.excludedTickets ?? 0,
          partial: cached.partial === true,
          countingContract: COUNTING_CONTRACT,
          issueCount: cached.issueCount ?? 0,
          openIssues: cached.openIssues ?? 0,
          lastHandoverDate: cached.lastHandoverDate ?? null,
          lastHandoverTitle: cached.lastHandoverTitle ?? null,
        }
      : undefined;

    const entry: FederationNodeEntry = {
      name,
      rawPath: typeof nodeConf.path === "string" ? nodeConf.path : "",
      resolvedPath: null,
      health: (typeof nodeConf.health === "string" ? nodeConf.health : "grey") as NodeHealth,
      role: typeof nodeConf.role === "string" ? nodeConf.role : "",
      summary: typeof nodeConf.summary === "string" ? nodeConf.summary : "",
      dependsOn: Array.isArray(nodeConf.dependsOn) ? (nodeConf.dependsOn as string[]) : [],
      reachable: cached.reachable,
      scanSummary,
      unreachableReason: cached.unreachableReason,
      ...(legacy ? { legacy } : {}),
    };
    entries.push(entry);

    if (cached.reachable) {
      reachableCount++;
    } else {
      unreachableCount++;
    }
  }

  if (entries.length === 0) return null;

  return {
    orchestratorProject: config.project,
    nodeCount: entries.length,
    reachableCount,
    unreachableCount,
    nodes: entries,
    ...aggregateTotals(entries),
    lastScanTimestamp: cache.lastScanTimestamp,
  };
}

/**
 * T-486 U2-3b (V3A 5d, B2, B4): before any total is built from the cache,
 * every reachable entry not on the current counting contract is rescanned
 * through runNodeScans, the same bounded scheduler the fresh scan uses (at
 * most NODE_SCAN_CONCURRENCY at once, each under NODE_SCAN_TIMEOUT_MS). A
 * successful rescan replaces the entry with a contract-2 summary; a failed,
 * timed-out or unstarted one (or a node that no longer resolves, which is not
 * scanned at all) becomes a legacy entry with no numbers. Returns the cache to
 * aggregate and whether it changed.
 */
export async function summariesForTotals(
  cache: FederationCache,
  nodes: ReadonlyMap<string, ResolvedNode>,
  options: { now?: () => Date } & Pick<NodeScanSchedule, "scan" | "timeoutMs" | "settleGraceMs"> = {},
): Promise<{ cache: FederationCache; changed: boolean }> {
  const stale = Object.entries(cache.nodes).filter(([, c]) => c.reachable && c.countingContract !== COUNTING_CONTRACT);
  if (stale.length === 0) return { cache, changed: false };
  const failures = new Map<string, string>();
  const jobs: NodeScanJob[] = [];
  for (const [name] of stale) {
    const node = nodes.get(name);
    if (node?.resolved) jobs.push({ name, storyDir: node.storyDir });
    else failures.set(name, node && !node.resolved ? node.reason : "node not in config");
  }
  const scanned = await runNodeScans(jobs, { scan: options.scan, timeoutMs: options.timeoutMs, settleGraceMs: options.settleGraceMs });
  const at = (options.now?.() ?? new Date()).toISOString();
  const next: Record<string, CachedNodeSummary> = { ...cache.nodes };
  for (const [name] of stale) {
    const result: NodeScanResult = scanned.get(name) ?? { reachable: false, reason: failures.get(name) ?? "not scanned" };
    if (result.reachable) {
      const s = result.summary;
      next[name] = {
        ticketCount: s.ticketCount, openTickets: s.openTickets, completeTickets: s.completeTickets,
        issueCount: s.issueCount, openIssues: s.openIssues,
        lastHandoverDate: s.lastHandoverDate, lastHandoverTitle: s.lastHandoverTitle,
        reachable: true, countingContract: s.countingContract,
        deliveredTickets: s.deliveredTickets, withdrawnTickets: s.withdrawnTickets,
        ticketWarnings: s.ticketWarnings, excludedTickets: s.excludedTickets, partial: s.partial,
      };
    } else {
      next[name] = { reachable: true, countingContract: 1, legacy: true, legacyReason: `rescan failed: ${result.reason}`, legacyAt: at };
    }
  }
  return { cache: { ...cache, nodes: next }, changed: true };
}

export async function loadFederationState(
  root: string,
  config: Config,
): Promise<FederationState | undefined> {
  try {
    if (config.type !== "orchestrator") return undefined;
    const nodeEntries = extractNodeEntries(config);
    if (!nodeEntries) return undefined;

    const storyDir = join(root, ".story");
    const cache = readFederationCache(storyDir);

    if (cache) {
      const age = Date.now() - new Date(cache.lastScanTimestamp).getTime();
      if (age < FEDERATION_CACHE_TTL_MS && !Number.isNaN(age)) {
        const fresh = await summariesForTotals(cache, resolveAllNodes(nodeEntries, root));
        if (fresh.changed) {
          // Best-effort, like the scan write below: a failed write changes nothing printed.
          try { writeFederationCacheObject(storyDir, fresh.cache); } catch { /* best-effort */ }
        }
        const reconstructed = reconstructFromCache(fresh.cache, config);
        if (reconstructed) return reconstructed;
      }
    }

    let fedState: FederationState | undefined;
    try {
      const resolvedNodes = resolveAllNodes(nodeEntries, root);
      const scanResults = await scanAllSummaries(resolvedNodes);
      fedState = buildFederationState(config, resolvedNodes, scanResults);
      try { writeFederationCache(storyDir, fedState); } catch { /* best-effort */ }
    } catch {
      if (cache) {
        const stale = reconstructFromCache(cache, config);
        if (stale) return stale;
      }
    }

    return fedState;
  } catch {
    return undefined;
  }
}
