import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ResolvedNode } from "./resolver.js";
import { loadProject, loadTicketRecords, type LoadResult } from "../core/project-loader.js";
import { computeTicketCounts } from "../core/ticket-counts.js";
import { findLatestHandover } from "./handover-utils.js";

/** T-486 U2-3b: the counting contract a summary was computed under (contract 1: raw records, umbrellas included). */
export const COUNTING_CONTRACT = 2;

/** The per-node scan deadline, shared by the scan and the cache rescan (B2). */
export const NODE_SCAN_TIMEOUT_MS = 2000;

/** How many node rescans run at once (B2). */
export const NODE_SCAN_CONCURRENCY = 4;

export interface NodeScanSummary {
  project: string;
  type: string;
  /** Leaf tickets (computeTicketCounts), the same population as the node's own status. */
  ticketCount: number;
  /** Leaves that are not terminal, in-progress and blocked work included. */
  openTickets: number;
  /** Terminal leaves; `deliveredTickets + withdrawnTickets`. */
  completeTickets: number;
  deliveredTickets: number;
  withdrawnTickets: number;
  /** Loader warnings plus identity diagnostics for the tickets directory. */
  ticketWarnings: number;
  /** Ticket files the loader refused plus records left out for a duplicated canonical id. */
  excludedTickets: number;
  /** True when any ticket record was excluded: the counts cover the accepted records only. */
  partial: boolean;
  countingContract: typeof COUNTING_CONTRACT;
  issueCount: number;
  openIssues: number;
  lastHandoverDate: string | null;
  lastHandoverTitle: string | null;
}

export type NodeScanResult =
  | { reachable: true; summary: NodeScanSummary }
  | { reachable: false; reason: string };

export interface ScanOptions {
  timeoutMs?: number;
  /** Tests only: the scan and the concurrency the scheduler uses. */
  scan?: NodeScanFn;
  concurrency?: number;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

/**
 * T-486 U2-3b: settles only once every branch has settled, then rejects with
 * the first failure in array order. Promise.all rejects on the first failure
 * while its siblings still run, so a scan would report done, free its slot and
 * let the scheduler start another node beside reads it never drained.
 */
async function settleAll<T>(branches: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(branches);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}

export async function scanNodeSummary(
  storyDir: string,
  signal?: AbortSignal,
): Promise<NodeScanSummary> {
  checkAborted(signal);

  let configRaw: string;
  try {
    configRaw = await readFile(join(storyDir, "config.json"), "utf-8");
  } catch {
    throw new Error("Cannot read node config.json");
  }
  checkAborted(signal);
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configRaw) as Record<string, unknown>;
  } catch {
    throw new Error("Corrupt config.json: invalid JSON");
  }

  async function countDir(
    dir: string,
    statusBuckets: readonly string[],
  ): Promise<{ total: number; counts: Map<string, number> }> {
    const counts = new Map<string, number>(statusBuckets.map((s) => [s, 0]));
    let total = 0;
    try {
      const files = await readdir(dir);
      checkAborted(signal);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      const results = await settleAll(
        jsonFiles.map(async (f): Promise<string | null> => {
          try {
            checkAborted(signal);
            const raw = await readFile(join(dir, f), "utf-8");
            checkAborted(signal);
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            return typeof parsed.status === "string" ? parsed.status : null;
          } catch (err) {
            if (signal?.aborted) throw err;
            return null;
          }
        }),
      );
      for (const status of results) {
        if (status === null) continue;
        total++;
        if (counts.has(status)) counts.set(status, (counts.get(status) ?? 0) + 1);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    return { total, counts };
  }

  const ticketsRead = loadTicketRecords(storyDir, { signal });
  const issuesRead = countDir(join(storyDir, "issues"), ["open"]);
  const handoverRead = findLatestHandover(join(storyDir, "handovers"), signal).catch(() => null);
  await settleAll<unknown>([ticketsRead, issuesRead, handoverRead]);
  const [ticketRecords, issueResult, handoverInfo] = await Promise.all([ticketsRead, issuesRead, handoverRead]);
  checkAborted(signal);

  return {
    project: typeof config.project === "string" ? config.project : "unknown",
    type: typeof config.type === "string" ? config.type : "unknown",
    ...ticketSummary(ticketRecords),
    issueCount: issueResult.total,
    openIssues: issueResult.counts.get("open") ?? 0,
    lastHandoverDate: handoverInfo?.date ?? null,
    lastHandoverTitle: handoverInfo?.heading ?? null,
  };
}

/** T-486 U2-3b: the ticket half of a node summary, by the one counting contract (V3A 5a/5b, B1, B5). */
function ticketSummary(records: Awaited<ReturnType<typeof loadTicketRecords>>): Pick<
  NodeScanSummary,
  "ticketCount" | "openTickets" | "completeTickets" | "deliveredTickets" | "withdrawnTickets" | "ticketWarnings" | "excludedTickets" | "partial" | "countingContract"
> {
  const counts = computeTicketCounts(records.identity.counted);
  const excluded = records.omitted.length + (records.records.length - records.identity.counted.length);
  return {
    ticketCount: counts.leaf,
    openTickets: counts.active,
    completeTickets: counts.terminal,
    deliveredTickets: counts.delivered,
    withdrawnTickets: counts.withdrawn,
    ticketWarnings: records.warnings.length + records.identity.diagnostics.length,
    excludedTickets: excluded,
    partial: excluded > 0,
    countingContract: COUNTING_CONTRACT,
  };
}

/** How a node scan is run: the scheduler owns the signal and aborts it at the deadline. */
export type NodeScanFn = (storyDir: string, signal: AbortSignal) => Promise<NodeScanSummary>;

export interface NodeScanJob {
  name: string;
  storyDir: string;
}

export interface NodeScanSchedule {
  scan?: NodeScanFn;
  concurrency?: number;
  timeoutMs?: number;
  /** How long a timed-out scan has to settle after its abort; defaults to the timeout. */
  settleGraceMs?: number;
}

/** The failure every queued node gets once a timed-out scan did not stop. */
export const NOT_SCANNED_REASON = "not scanned: an earlier scan did not stop";

/** How a node job ends: its value, or why it has none. */
export type NodeJobResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface NodeJobSchedule<T> {
  run: (storyDir: string, signal: AbortSignal) => Promise<T>;
  concurrency?: number;
  timeoutMs?: number;
  /** How long a timed-out job has to settle after its abort; defaults to the timeout. */
  settleGraceMs?: number;
  /**
   * T-486 U2-4: the caller's stop. When it aborts, every running job is
   * aborted, every node without a result gets "cancelled: <reason>", nothing
   * more starts, and the call returns at once.
   */
  signal?: AbortSignal;
}

/**
 * T-486 U2-3b (B2): the one way a node job starts: the fresh scan, the cache
 * rescan and the cross-node observation (U2-4) alike. At most `concurrency`
 * jobs run at once. Each job gets its own AbortController, owned here: the
 * signal goes into the job and is aborted at the deadline, when the node's
 * result is fixed as "timeout" so no caller waits past the bound to report it.
 * The slot is freed only when the job itself settles, so a job that ignores
 * its deadline keeps holding it. If a timed-out job has not settled within
 * `settleGraceMs` of its abort, its cancellation is unconfirmed: nothing more
 * is started, and every node still queued fails with NOT_SCANNED_REASON.
 * Every slot therefore frees or stops the queue within timeoutMs +
 * settleGraceMs, and the call settles within ceil(jobs / concurrency) of
 * those, whatever the jobs do.
 */
export function runNodeJobs<T>(jobs: readonly NodeScanJob[], options: NodeJobSchedule<T>): Promise<Map<string, NodeJobResult<T>>> {
  const concurrency = Math.max(1, options.concurrency ?? NODE_SCAN_CONCURRENCY);
  const timeoutMs = options.timeoutMs ?? NODE_SCAN_TIMEOUT_MS;
  const settleGraceMs = options.settleGraceMs ?? timeoutMs;
  const results = new Map<string, NodeJobResult<T>>();
  const queue = [...jobs];
  const controllers = new Set<AbortController>();
  let running = 0;
  let stopped = false;

  return new Promise((resolveAll) => {
    const finishIfDone = (): void => {
      if (results.size !== jobs.length) return;
      options.signal?.removeEventListener("abort", cancel);
      resolveAll(results);
    };
    const stopQueue = (): void => {
      stopped = true;
      for (const job of queue.splice(0)) results.set(job.name, { ok: false, reason: NOT_SCANNED_REASON });
      finishIfDone();
    };
    const cancel = (): void => {
      stopped = true;
      const raw = options.signal?.reason;
      const reason = `cancelled: ${typeof raw === "string" ? raw : raw instanceof Error ? raw.message : "aborted"}`;
      for (const job of jobs) if (!results.has(job.name)) results.set(job.name, { ok: false, reason });
      queue.length = 0;
      for (const controller of controllers) controller.abort();
      resolveAll(results);
    };
    const pump = (): void => {
      while (!stopped && running < concurrency && queue.length > 0) start(queue.shift()!);
      finishIfDone();
    };
    const start = (job: NodeScanJob): void => {
      running++;
      const controller = new AbortController();
      controllers.add(controller);
      const record = (result: NodeJobResult<T>): void => {
        if (!results.has(job.name)) results.set(job.name, result);
      };
      let settled = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const deadline = setTimeout(() => {
        record({ ok: false, reason: "timeout" });
        controller.abort();
        grace = setTimeout(() => {
          if (!settled) stopQueue();
        }, settleGraceMs);
        finishIfDone();
      }, timeoutMs);
      let work: Promise<T>;
      try {
        work = options.run(job.storyDir, controller.signal);
      } catch (err) {
        work = Promise.reject(err);
      }
      void work
        .then(
          (value) => record({ ok: true, value }),
          () => record({ ok: false, reason: "scan error" }),
        )
        .finally(() => {
          settled = true;
          controllers.delete(controller);
          clearTimeout(deadline);
          clearTimeout(grace);
          running--;
          pump();
        });
    };
    if (options.signal?.aborted) return cancel();
    options.signal?.addEventListener("abort", cancel, { once: true });
    pump();
  });
}

/** The node scan through `runNodeJobs`, with the scan's own result shape (U2-3b). */
export async function runNodeScans(jobs: readonly NodeScanJob[], options: NodeScanSchedule = {}): Promise<Map<string, NodeScanResult>> {
  const ran = await runNodeJobs(jobs, {
    run: options.scan ?? scanNodeSummary,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    settleGraceMs: options.settleGraceMs,
  });
  const results = new Map<string, NodeScanResult>();
  for (const [name, r] of ran) results.set(name, r.ok ? { reachable: true, summary: r.value } : { reachable: false, reason: r.reason });
  return results;
}

export async function scanAllSummaries(
  nodes: Map<string, ResolvedNode>,
  options?: ScanOptions,
): Promise<Map<string, NodeScanResult>> {
  const results = new Map<string, NodeScanResult>();
  const jobs: NodeScanJob[] = [];
  for (const [name, node] of nodes) {
    if (node.resolved) jobs.push({ name, storyDir: node.storyDir });
    else results.set(name, { reachable: false, reason: node.reason });
  }
  const scanned = await runNodeScans(jobs, {
    scan: options?.scan,
    concurrency: options?.concurrency,
    timeoutMs: options?.timeoutMs,
  });
  // Unresolved nodes first, then the scanned ones in job order, as before.
  for (const job of jobs) results.set(job.name, scanned.get(job.name)!);
  return results;
}

export async function loadNodeFullState(storyDir: string): Promise<LoadResult> {
  const root = dirname(storyDir);
  return loadProject(root);
}
