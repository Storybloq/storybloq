import type { Config } from "../models/config.js";
import type { NodeHealth } from "../models/federation-config.js";
import type { ResolvedNode } from "./resolver.js";
import { COUNTING_CONTRACT, type NodeScanResult, type NodeScanSummary } from "./scanner.js";

export interface FederationNodeEntry {
  name: string;
  rawPath: string;
  resolvedPath: string | null;
  health: NodeHealth;
  role: string;
  summary: string;
  dependsOn: string[];
  reachable: boolean;
  scanSummary?: NodeScanSummary;
  unreachableReason?: string;
  /** T-486 U2-3b: a cached contract-1 summary whose rescan failed; it has no numbers and no total includes it (B4). */
  legacy?: { reason: string; at: string };
}

export interface FederationState {
  orchestratorProject: string;
  nodeCount: number;
  reachableCount: number;
  unreachableCount: number;
  nodes: FederationNodeEntry[];
  totalTickets: number;
  totalOpenTickets: number;
  totalCompleteTickets: number;
  totalIssues: number;
  totalOpenIssues: number;
  /** T-486 U2-3b: the split of totalCompleteTickets. */
  totalDeliveredTickets: number;
  totalWithdrawnTickets: number;
  /** Nodes left out of every total because their summary is on the old counting contract (B4). */
  legacyExcludedNodes: number;
  /** Nodes whose summary covers only the ticket records the loader accepted (B5). */
  partialNodes: number;
  totalExcludedTickets: number;
  lastScanTimestamp: string;
}

export type FederationTotals = Pick<
  FederationState,
  | "totalTickets" | "totalOpenTickets" | "totalCompleteTickets" | "totalIssues" | "totalOpenIssues"
  | "totalDeliveredTickets" | "totalWithdrawnTickets" | "legacyExcludedNodes" | "partialNodes" | "totalExcludedTickets"
>;

/**
 * T-486 U2-3b: the one aggregation over node entries. Only a reachable entry
 * with a summary on the current counting contract contributes; a legacy entry
 * is counted in `legacyExcludedNodes` and nowhere else, so no total ever adds
 * contract-1 numbers to contract-2 numbers.
 */
export function aggregateTotals(entries: readonly FederationNodeEntry[]): FederationTotals {
  const t: FederationTotals = {
    totalTickets: 0, totalOpenTickets: 0, totalCompleteTickets: 0, totalIssues: 0, totalOpenIssues: 0,
    totalDeliveredTickets: 0, totalWithdrawnTickets: 0, legacyExcludedNodes: 0, partialNodes: 0, totalExcludedTickets: 0,
  };
  for (const e of entries) {
    if (e.legacy) { t.legacyExcludedNodes++; continue; }
    const s = e.scanSummary;
    if (!e.reachable || !s || s.countingContract !== COUNTING_CONTRACT) continue;
    t.totalTickets += s.ticketCount;
    t.totalOpenTickets += s.openTickets;
    t.totalCompleteTickets += s.completeTickets;
    t.totalDeliveredTickets += s.deliveredTickets;
    t.totalWithdrawnTickets += s.withdrawnTickets;
    t.totalIssues += s.issueCount;
    t.totalOpenIssues += s.openIssues;
    if (s.partial) { t.partialNodes++; t.totalExcludedTickets += s.excludedTickets; }
  }
  return t;
}

/** Kahn's topological sort. On cycle, appends cycle nodes alphabetically at the end (no error). */
export function topologicalSortNodes(
  nodes: Record<string, { dependsOn?: string[] }>,
): string[] {
  const keys = Object.keys(nodes);
  if (keys.length === 0) return [];

  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const key of keys) {
    inDegree.set(key, 0);
    adjList.set(key, []);
  }

  for (const [key, node] of Object.entries(nodes)) {
    for (const dep of node.dependsOn ?? []) {
      if (inDegree.has(dep)) {
        adjList.get(dep)!.push(key);
        inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }
  queue.sort();

  const result: string[] = [];
  const emitted = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    emitted.add(node);
    for (const dependent of adjList.get(node) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        const insertIdx = queue.findIndex((q) => q > dependent);
        if (insertIdx === -1) queue.push(dependent);
        else queue.splice(insertIdx, 0, dependent);
      }
    }
  }

  if (result.length < keys.length) {
    const remaining = keys.filter((k) => !emitted.has(k)).sort();
    result.push(...remaining);
  }

  return result;
}

export function buildFederationState(
  config: Config,
  resolvedNodes: Map<string, ResolvedNode>,
  scanResults: Map<string, NodeScanResult>,
): FederationState {
  const nodesConfig = (config.nodes ?? {}) as Record<string, Record<string, unknown>>;

  const sortedNames = topologicalSortNodes(
    Object.fromEntries(
      Object.entries(nodesConfig).map(([k, v]) => [
        k,
        { dependsOn: Array.isArray(v.dependsOn) ? (v.dependsOn as string[]) : [] },
      ]),
    ),
  );

  let reachableCount = 0;
  let unreachableCount = 0;

  const entries: FederationNodeEntry[] = [];

  for (const name of sortedNames) {
    const nodeConf = nodesConfig[name] ?? {};
    const resolved = resolvedNodes.get(name);
    const scan = scanResults.get(name);

    const entry: FederationNodeEntry = {
      name,
      rawPath: typeof nodeConf.path === "string" ? nodeConf.path : "",
      resolvedPath: resolved?.resolved ? resolved.absolutePath : null,
      health: (typeof nodeConf.health === "string" ? nodeConf.health : "grey") as NodeHealth,
      role: typeof nodeConf.role === "string" ? nodeConf.role : "",
      summary: typeof nodeConf.summary === "string" ? nodeConf.summary : "",
      dependsOn: Array.isArray(nodeConf.dependsOn) ? (nodeConf.dependsOn as string[]) : [],
      reachable: false,
    };

    if (scan?.reachable) {
      entry.reachable = true;
      entry.scanSummary = scan.summary;
      reachableCount++;
    } else {
      unreachableCount++;
      entry.unreachableReason = scan && !scan.reachable ? scan.reason : "unknown";
    }

    entries.push(entry);
  }

  return {
    orchestratorProject: config.project,
    nodeCount: sortedNames.length,
    reachableCount,
    unreachableCount,
    nodes: entries,
    ...aggregateTotals(entries),
    lastScanTimestamp: new Date().toISOString(),
  };
}
