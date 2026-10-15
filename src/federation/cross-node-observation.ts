/**
 * T-486 U2-4 (V3A 5c, B2): the live cross-node observation. Every command
 * that judges a cross-node blocker (status, recommend, dispatch, validate,
 * ticket blocked, targeted actionability) computes one, once, from the
 * target nodes' ticket graphs. The federation cache is written from it by
 * status only and never releases anything.
 */
import { CROSS_NODE_REF_CAPTURE_REGEX } from "../models/ticket.js";
import type { Ticket } from "../models/ticket.js";
import { loadTicketRecords, type TicketRecords } from "../core/project-loader.js";
import { ProjectState } from "../core/project-state.js";
import { resolveAllNodes, type ResolvedNode } from "./resolver.js";
import { NODE_SCAN_CONCURRENCY, NODE_SCAN_TIMEOUT_MS, runNodeJobs } from "./scanner.js";
import { isTicketRef, resolveIssueStatus, ticketRefStatus, type CrossNodeRefStatus } from "./cross-node-resolver.js";

/** How a node's ticket graph is read; injected by tests (B2-P1, P4). */
export type TicketGraphLoader = (storyDir: string, signal: AbortSignal) => Promise<TicketRecords>;

export interface CrossNodeObservationOptions {
  tickets: readonly Ticket[];
  resolvedNodes: Map<string, ResolvedNode>;
  /** The caller's stop; aborting it returns the observation at once. */
  signal?: AbortSignal;
  /** The whole observation's deadline. */
  deadlineMs?: number;
  /** Each node's deadline (NODE_SCAN_TIMEOUT_MS). */
  nodeTimeoutMs?: number;
  load?: TicketGraphLoader;
}

export interface CrossNodeObservation {
  readonly live: true;
  readonly observedAt: string;
  readonly statuses: Map<string, CrossNodeRefStatus>;
}

export const OBSERVATION_DEADLINE_MS = 5000;
const DEADLINE_REASON = "observation deadline";

const defaultLoad: TicketGraphLoader = (storyDir, signal) => loadTicketRecords(storyDir, { signal });

export async function crossNodeObservation(options: CrossNodeObservationOptions): Promise<CrossNodeObservation> {
  const observedAt = new Date().toISOString();
  const statuses = new Map<string, CrossNodeRefStatus>();
  const refsByNode = new Map<string, Set<string>>();
  for (const ticket of options.tickets) {
    for (const ref of ticket.crossNodeBlockedBy ?? []) {
      const match = CROSS_NODE_REF_CAPTURE_REGEX.exec(ref);
      if (!match) continue;
      const items = refsByNode.get(match[1]!) ?? new Set<string>();
      items.add(match[2]!);
      refsByNode.set(match[1]!, items);
    }
  }
  // B2-P1: no cross-node edge, no read and no job.
  if (refsByNode.size === 0) return { live: true, observedAt, statuses };

  const jobs: { name: string; storyDir: string }[] = [];
  for (const [nodeName, itemIds] of refsByNode) {
    const node = options.resolvedNodes.get(nodeName);
    if (node && node.resolved) {
      jobs.push({ name: nodeName, storyDir: node.storyDir });
      continue;
    }
    const reason = node && !node.resolved ? node.reason : "node not configured";
    for (const itemId of itemIds) statuses.set(`${nodeName}:${itemId}`, { resolved: false, reason });
  }
  if (jobs.length === 0) return { live: true, observedAt, statuses };

  const load = options.load ?? defaultLoad;
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onCallerAbort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(DEADLINE_REASON), options.deadlineMs ?? OBSERVATION_DEADLINE_MS);
  try {
    const results = await runNodeJobs(jobs, {
      concurrency: NODE_SCAN_CONCURRENCY,
      timeoutMs: options.nodeTimeoutMs ?? NODE_SCAN_TIMEOUT_MS,
      signal: controller.signal,
      run: async (storyDir, signal) => {
        const nodeName = jobs.find((j) => j.storyDir === storyDir)!.name;
        const itemIds = [...refsByNode.get(nodeName)!];
        const out = new Map<string, CrossNodeRefStatus>();
        const ticketIds = itemIds.filter(isTicketRef);
        if (ticketIds.length > 0) {
          // B2-P4: one graph load per node, whatever the number of refs.
          const records = await load(storyDir, signal);
          signal.throwIfAborted();
          const graph = ProjectState.forTicketGraph(records.records, records.omitted);
          for (const itemId of ticketIds) out.set(itemId, ticketRefStatus(graph, itemId));
        }
        for (const itemId of itemIds.filter((id) => !isTicketRef(id))) {
          out.set(itemId, await resolveIssueStatus(storyDir, itemId, signal));
        }
        return out;
      },
    });
    for (const job of jobs) {
      const result = results.get(job.name)!;
      for (const itemId of refsByNode.get(job.name)!) {
        const ref = `${job.name}:${itemId}`;
        statuses.set(ref, result.ok ? result.value.get(itemId)! : { resolved: false, reason: result.reason });
      }
    }
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
  return { live: true, observedAt, statuses };
}

/** The nodes a project's config names, resolved against its root (none for a plain project). */
export function configuredNodes(config: unknown, root: string): Map<string, ResolvedNode> {
  const nodes = (config as { nodes?: unknown }).nodes;
  if (!nodes || typeof nodes !== "object") return new Map();
  const entries = Object.fromEntries(
    Object.entries(nodes as Record<string, unknown>)
      .filter(([, v]) => v != null && typeof v === "object")
      .map(([k, v]) => [k, { path: typeof (v as { path?: unknown }).path === "string" ? (v as { path: string }).path : "" }]),
  );
  return resolveAllNodes(entries, root);
}

/** One live observation over a loaded project's own tickets and its configured nodes. */
export function observeProject(state: { tickets: readonly Ticket[]; config: unknown }, root: string, signal?: AbortSignal): Promise<CrossNodeObservation> {
  return crossNodeObservation({ tickets: state.tickets, resolvedNodes: configuredNodes(state.config, root), signal });
}

/**
 * The string map the blocking checks read (queries.isCrossNodeBlocked):
 * resolved refs only, so an unresolved ref stays blocked.
 */
export function crossNodeStatusRecord(observation: CrossNodeObservation): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [ref, status] of observation.statuses) if (status.resolved) record[ref] = status.status;
  return record;
}

/** A withdrawn or withheld ref's action text, shared by validate, recommend and ticket blocked (V3A 5c). */
export function withdrawnRefPhrase(ref: string, status: CrossNodeRefStatus): string | null {
  if (!status.resolved) return null;
  if (status.status === "withdrawn") return `${ref} was withdrawn`;
  if (status.status === "withheld") return `${ref} has withdrawn work under it (${status.detail.join(", ")})`;
  return null;
}

