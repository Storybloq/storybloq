/**
 * T-486 U2-3b: the federation summary counts tickets the way a node's own
 * status does (counting contract 2), every node scan runs through one bounded
 * scheduler, the cache rescan never mixes contract-1 numbers into a total, a
 * failed cache write on the read path changes nothing printed, and the totals
 * add up per node and in aggregate.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { formatFederatedStatus } from "../../src/core/output-formatter.js";
import { findLatestHandover } from "../../src/federation/handover-utils.js";
import { readFederationCache, writeFederationCache, writeFederationCacheObject, type FederationCache } from "../../src/federation/cache.js";
import { loadFederationState, summariesForTotals } from "../../src/federation/recommend-loader.js";
import { resolveAllNodes, type ResolvedNode } from "../../src/federation/resolver.js";
import {
  NOT_SCANNED_REASON,
  runNodeScans,
  scanAllSummaries,
  scanNodeSummary,
  type NodeScanFn,
  type NodeScanSummary,
} from "../../src/federation/scanner.js";
import { aggregateTotals, buildFederationState, type FederationNodeEntry, type FederationState } from "../../src/federation/state.js";
import type { Config } from "../../src/models/config.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u23b-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) {
    try { chmodSync(join(d, ".story"), 0o755); } catch { /* not every dir has one */ }
    rmSync(d, { recursive: true, force: true });
  }
});

type Raw = Record<string, unknown>;
const DONE = "2026-02-01";
function ticket(id: string, extra: Raw = {}): Raw {
  return {
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p0",
    order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
    ...extra,
  };
}
const delivered = (id: string, extra: Raw = {}) => ticket(id, { status: "complete", completedDate: DONE, ...extra });
const withdrawn = (id: string, extra: Raw = {}) =>
  delivered(id, { resolutionKind: { kind: "withdrawn", closedOn: DONE, reason: "Superseded." }, ...extra });

/** A node project with these tickets; `[file, body]` pairs pick the filename (a string body is written raw). */
async function node(entries: Array<Raw | [string, Raw | string]>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u23b-"));
  dirs.push(root);
  await initProject(root, { name: "t486-u23b" });
  for (const e of entries) {
    const [file, body] = Array.isArray(e) ? e : [`${String(e.id)}.json`, e];
    writeFileSync(join(root, ".story", "tickets", file), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

function summary(over: Partial<NodeScanSummary> = {}): NodeScanSummary {
  return {
    project: "x", type: "npm", ticketCount: 1, openTickets: 1, completeTickets: 0, deliveredTickets: 0,
    withdrawnTickets: 0, ticketWarnings: 0, excludedTickets: 0, partial: false, countingContract: 2,
    issueCount: 0, openIssues: 0, lastHandoverDate: null, lastHandoverTitle: null, ...over,
  };
}

const jobs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}`, storyDir: `/nowhere/n${i}` }));

/** A scan that counts how many are running and records the peak. */
function counting(behave: (signal: AbortSignal, done: () => void) => Promise<NodeScanSummary>) {
  const c = { started: 0, settled: 0, running: 0, peak: 0 };
  const scan: NodeScanFn = (_dir, signal) => {
    c.started++;
    c.running++;
    c.peak = Math.max(c.peak, c.running);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      c.running--;
      c.settled++;
    };
    return behave(signal, done);
  };
  return { c, scan };
}

describe("T-486 U2-3b: one bounded scheduler for every node scan", () => {
  it("six scans that never settle: four start, four time out, two are not scanned, and the call settles within two deadlines", async () => {
    vi.useFakeTimers();
    const { c, scan } = counting(() => new Promise<NodeScanSummary>(() => {}));
    let out: Map<string, { reachable: boolean; reason?: string }> | undefined;
    void runNodeScans(jobs(6), { scan, concurrency: 4, timeoutMs: 100, settleGraceMs: 100 }).then((r) => { out = r as never; });
    await vi.advanceTimersByTimeAsync(100);
    expect(out).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(out).toBeDefined();
    const reasons = [...out!.values()].map((r) => r.reason);
    expect(reasons.filter((r) => r === "timeout")).toHaveLength(4);
    expect(reasons.filter((r) => r === NOT_SCANNED_REASON)).toHaveLength(2);
    expect([c.started, c.peak]).toEqual([4, 4]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.started).toBe(4);
  });

  it("six scans that stop on abort: all six start, never more than four at once, and all six time out", async () => {
    vi.useFakeTimers();
    const { c, scan } = counting((signal, done) => new Promise<NodeScanSummary>((_, reject) => {
      signal.addEventListener("abort", () => { done(); reject(new Error("aborted")); });
    }));
    let out: Map<string, { reachable: boolean; reason?: string }> | undefined;
    void runNodeScans(jobs(6), { scan, concurrency: 4, timeoutMs: 100, settleGraceMs: 100 }).then((r) => { out = r as never; });
    await vi.advanceTimersByTimeAsync(100);
    expect(c.started).toBe(6);
    await vi.advanceTimersByTimeAsync(100);
    expect(out).toBeDefined();
    expect([...out!.values()].map((r) => r.reason)).toEqual(Array(6).fill("timeout"));
    expect([c.started, c.settled, c.peak]).toEqual([6, 6, 4]);
  });

  it("a scan that throws before returning a promise is a scan error, and the rest still run", async () => {
    const out = await runNodeScans(jobs(2), {
      scan: (dir) => { if (dir.endsWith("n0")) throw new Error("boom"); return Promise.resolve(summary()); },
    });
    expect(out.get("n0")).toEqual({ reachable: false, reason: "scan error" });
    expect(out.get("n1")).toMatchObject({ reachable: true });
  });

  it("the fresh scan goes through the scheduler: six resolvable nodes never run more than four at once", async () => {
    const { c, scan } = counting((_signal, done) => new Promise<NodeScanSummary>((resolve) => {
      setTimeout(() => { done(); resolve(summary()); }, 20);
    }));
    const nodes = new Map<string, ResolvedNode>(
      jobs(6).map((j) => [j.name, { resolved: true, absolutePath: j.storyDir, storyDir: j.storyDir, rawPath: j.storyDir }]),
    );
    nodes.set("gone", { resolved: false, reason: "path not found", rawPath: "/gone" });
    const out = await scanAllSummaries(nodes, { scan });
    expect([...out.keys()]).toEqual(["gone", "n0", "n1", "n2", "n3", "n4", "n5"]);
    expect([...out.values()].filter((r) => r.reachable)).toHaveLength(6);
    expect(out.get("gone")).toEqual({ reachable: false, reason: "path not found" });
    expect([c.started, c.peak]).toEqual([6, 4]);
  });

  it("the cache rescan: a scan that never settles, one that rejects and a node that no longer resolves all become legacy, and only resolvable nodes are scanned", async () => {
    vi.useFakeTimers();
    const scanned: string[] = [];
    const scan: NodeScanFn = (dir) => {
      scanned.push(dir);
      return dir.endsWith("hang") ? new Promise(() => {}) : Promise.reject(new Error("bad"));
    };
    const legacyEntry = { ticketCount: 9, openTickets: 9, completeTickets: 0, issueCount: 0, openIssues: 0, lastHandoverDate: null, lastHandoverTitle: null, reachable: true };
    const cache: FederationCache = {
      lastScanTimestamp: new Date().toISOString(),
      nodes: { hang: legacyEntry, bad: legacyEntry, gone: legacyEntry },
    };
    const nodes = new Map<string, ResolvedNode>([
      ["hang", { resolved: true, absolutePath: "/x/hang", storyDir: "/x/hang", rawPath: "/x/hang" }],
      ["bad", { resolved: true, absolutePath: "/x/bad", storyDir: "/x/bad", rawPath: "/x/bad" }],
    ]);
    let out: Awaited<ReturnType<typeof summariesForTotals>> | undefined;
    void summariesForTotals(cache, nodes, { scan, timeoutMs: 50, settleGraceMs: 50, now: () => new Date("2026-10-14T00:00:00Z") })
      .then((r) => { out = r; });
    await vi.advanceTimersByTimeAsync(50);
    expect(out).toBeDefined();
    expect(scanned.sort()).toEqual(["/x/bad", "/x/hang"]);
    expect(out!.changed).toBe(true);
    const at = "2026-10-14T00:00:00.000Z";
    expect(out!.cache.nodes).toEqual({
      hang: { reachable: true, countingContract: 1, legacy: true, legacyReason: "rescan failed: timeout", legacyAt: at },
      bad: { reachable: true, countingContract: 1, legacy: true, legacyReason: "rescan failed: scan error", legacyAt: at },
      gone: { reachable: true, countingContract: 1, legacy: true, legacyReason: "rescan failed: node not in config", legacyAt: at },
    });
  });

  it("the handover read stops once its signal is aborted", async () => {
    const root = await node([]);
    const handovers = join(root, ".story", "handovers");
    writeFileSync(join(handovers, "2026-10-14-x.md"), "# A handover\n");
    expect((await findLatestHandover(handovers))?.heading).toBe("A handover");
    const aborted = new AbortController();
    aborted.abort();
    await expect(findLatestHandover(handovers, aborted.signal)).rejects.toThrow();
    await expect(scanNodeSummary(join(root, ".story"), aborted.signal)).rejects.toThrow();
  });

  it("a node whose tickets cannot be listed is a scan error, not zero tickets", async () => {
    const root = await node([]);
    rmSync(join(root, ".story", "tickets"), { recursive: true });
    writeFileSync(join(root, ".story", "tickets"), "not a directory");
    const nodes = resolveAllNodes({ n: { path: root } }, orchestrator({ n: root }).root);
    const out = await scanAllSummaries(nodes);
    expect(out.get("n")).toEqual({ reachable: false, reason: "scan error" });
  });
});

/** delivered + withdrawn = complete and complete + open = total. */
function holds(s: { ticketCount: number; openTickets: number; completeTickets: number; deliveredTickets: number; withdrawnTickets: number }): boolean {
  return s.deliveredTickets + s.withdrawnTickets === s.completeTickets && s.completeTickets + s.openTickets === s.ticketCount;
}
function aggregateHolds(f: FederationState): boolean {
  return holds({
    ticketCount: f.totalTickets, openTickets: f.totalOpenTickets, completeTickets: f.totalCompleteTickets,
    deliveredTickets: f.totalDeliveredTickets, withdrawnTickets: f.totalWithdrawnTickets,
  });
}

function orchestrator(nodes: Record<string, string>): { root: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "t486-u23b-orch-"));
  dirs.push(root);
  mkdirSync(join(root, ".story"), { recursive: true });
  const config = {
    version: 2, schemaVersion: 1, project: "orch", type: "orchestrator", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    nodes: Object.fromEntries(Object.entries(nodes).map(([k, path]) => [k, { path }])),
  } as unknown as Config;
  return { root, config };
}

describe("T-486 U2-3b: the totals add up, and a legacy summary is in none of them", () => {
  async function threeNodes() {
    const work = await node([
      delivered("T-001"), withdrawn("T-002"), ticket("T-003"), ticket("T-004", { status: "inprogress" }),
    ]);
    const partial = await node([delivered("T-001"), ticket("T-002"), ["T-BAD.json", "{ not json"]]);
    return { work, partial };
  }

  it("on the fresh scan, per node and in aggregate", async () => {
    const { work, partial } = await threeNodes();
    const { root, config } = orchestrator({ work, partial });
    const resolved = resolveAllNodes({ work: { path: work }, partial: { path: partial } }, root);
    const fed = buildFederationState(config, resolved, await scanAllSummaries(resolved));
    for (const n of fed.nodes) expect(holds(n.scanSummary!)).toBe(true);
    expect(aggregateHolds(fed)).toBe(true);
    expect([fed.totalTickets, fed.totalOpenTickets, fed.totalCompleteTickets, fed.totalDeliveredTickets, fed.totalWithdrawnTickets])
      .toEqual([6, 3, 3, 2, 1]);
    expect([fed.partialNodes, fed.totalExcludedTickets, fed.legacyExcludedNodes]).toEqual([1, 1, 0]);
  });

  it("on the cache path, with a legacy node beside them, and the labels say so", async () => {
    const { work, partial } = await threeNodes();
    const { root, config } = orchestrator({ work, partial, old: "/no/such/node" });
    const resolved = resolveAllNodes({ work: { path: work }, partial: { path: partial } }, root);
    const fresh = buildFederationState(config, resolved, await scanAllSummaries(resolved));
    writeFederationCache(join(root, ".story"), fresh);
    const cache = readFederationCache(join(root, ".story"))!;
    cache.nodes.old = { ticketCount: 40, openTickets: 30, completeTickets: 10, issueCount: 0, openIssues: 0, lastHandoverDate: null, lastHandoverTitle: null, reachable: true };
    writeFileSync(join(root, ".story", "federation-cache.json"), JSON.stringify(cache));
    const fed = (await loadFederationState(root, config))!;
    expect(fed.nodes.find((n) => n.name === "old")?.legacy?.reason).toMatch(/^rescan failed: /);
    for (const n of fed.nodes) if (!n.legacy) expect(holds(n.scanSummary!)).toBe(true);
    expect(aggregateHolds(fed)).toBe(true);
    expect([fed.totalTickets, fed.totalCompleteTickets, fed.totalWithdrawnTickets]).toEqual([6, 3, 1]);
    expect(fed.legacyExcludedNodes).toBe(1);
    const md = formatFederatedStatus(fed, config, "md", [], []);
    expect(md).toContain("Tickets: 3/6 across all nodes, 1 withdrawn (partial: 1 ticket(s) excluded) (1 node(s) on the old counting contract excluded)");
    expect(md).toMatch(/\| work \| [^|]* \| 2\/4, 1 withdrawn \|/);
    expect(md).toMatch(/\| partial \| [^|]* \| 1\/2 \(partial\) \|/);
    expect(md).toMatch(/\| old \| [^|]* \| legacy \| -- \| -- \| [^|]* \|/);
    // The failed rescan's time is not a handover date, so the activity cell never shows it.
    expect(md).not.toContain(fed.nodes.find((n) => n.name === "old")!.legacy!.at);
  });

  it("aggregateTotals never adds a legacy entry's numbers, even when it carries some", () => {
    const entry = (name: string, over: Partial<FederationNodeEntry>): FederationNodeEntry =>
      ({ name, path: name, role: "", description: "", health: "active", dependsOn: [], reachable: true, ...over }) as FederationNodeEntry;
    const t = aggregateTotals([
      entry("a", { scanSummary: summary({ ticketCount: 3, openTickets: 2, completeTickets: 1, deliveredTickets: 1 }) }),
      entry("b", { legacy: { reason: "rescan failed: timeout", at: DONE }, scanSummary: summary({ ticketCount: 50, openTickets: 50 }) }),
    ]);
    expect([t.totalTickets, t.totalOpenTickets, t.totalCompleteTickets, t.legacyExcludedNodes]).toEqual([3, 2, 1, 1]);
  });
});

describe("T-486 U2-3b: a failed cache write on the read path changes nothing", () => {
  it("returns the same state whether or not the rescanned cache can be written, and leaves no temp file", async () => {
    const work = await node([delivered("T-001"), ticket("T-002")]);
    const { root, config } = orchestrator({ work });
    const storyDir = join(root, ".story");
    const stale: FederationCache = {
      lastScanTimestamp: new Date().toISOString(),
      nodes: { work: { ticketCount: 7, openTickets: 7, completeTickets: 0, issueCount: 0, openIssues: 0, lastHandoverDate: null, lastHandoverTitle: null, reachable: true } },
    };
    const staleText = JSON.stringify(stale);
    writeFileSync(join(storyDir, "federation-cache.json"), staleText);
    const writable = await loadFederationState(root, config);
    expect(readFederationCache(storyDir)?.nodes.work?.countingContract).toBe(2);

    writeFileSync(join(storyDir, "federation-cache.json"), staleText);
    chmodSync(storyDir, 0o555);
    let readOnly: FederationState | undefined;
    try {
      readOnly = await loadFederationState(root, config);
    } finally {
      chmodSync(storyDir, 0o755);
    }
    expect(readOnly).toBeDefined();
    expect(JSON.stringify(readOnly)).toBe(JSON.stringify(writable));
    expect([readOnly!.totalTickets, readOnly!.totalCompleteTickets]).toEqual([2, 1]);
    expect(readFileSync(join(storyDir, "federation-cache.json"), "utf8")).toBe(staleText);
    expect(readdirSync(storyDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a rename that fails after the temp file is written removes the temp file and leaves the cache path as it was", () => {
    const storyDir = mkdtempSync(join(tmpdir(), "t486-u23b-rename-"));
    dirs.push(storyDir);
    // A non-empty directory where the cache goes: the temp file can be created beside it, but the rename onto it fails.
    const cachePath = join(storyDir, "federation-cache.json");
    mkdirSync(cachePath);
    writeFileSync(join(cachePath, "keep"), "unchanged");
    const cache: FederationCache = { lastScanTimestamp: new Date().toISOString(), nodes: {} };
    expect(() => writeFederationCacheObject(storyDir, cache)).toThrow();
    expect(readdirSync(storyDir)).toEqual(["federation-cache.json"]);
    expect(readdirSync(cachePath)).toEqual(["keep"]);
    expect(readFileSync(join(cachePath, "keep"), "utf8")).toBe("unchanged");
  });
});

describe("T-486 U2-3b: a node summary equals the node's own status (N1 parity)", () => {
  const A = "t-0000000000000e01";
  const B = "t-0000000000000e02";
  const C = "t-0000000000000e03";
  const boards: Record<string, Array<Raw | [string, Raw]>> = {
    "a duplicated canonical id": [
      [`${A}-a.json`, ticket(A, { displayId: "T-050" })],
      [`${A}-b.json`, ticket(A, { displayId: "T-050" })],
      delivered(B, { displayId: "T-050" }),
      delivered(C, { displayId: "T-051", parentTicket: "T-050" }),
      ticket("T-070", { blockedBy: [B] }),
    ],
    "an ambiguous current displayId": [
      ticket(A, { displayId: "T-050" }), ticket(B, { displayId: "T-050" }),
      delivered(C, { displayId: "T-090", previousDisplayIds: ["T-050"] }),
      ticket("T-060", { parentTicket: "T-050" }),
    ],
  };
  for (const [label, entries] of Object.entries(boards)) {
    it(`on ${label}`, async () => {
      const root = await node(entries);
      const { state } = await loadProject(root);
      const s = await scanNodeSummary(join(root, ".story"));
      expect([s.ticketCount, s.completeTickets, s.openTickets])
        .toEqual([state.leafTicketCount, state.completeLeafTicketCount, state.leafTicketCount - state.completeLeafTicketCount]);
      expect(s.ticketCount).toBeGreaterThan(0);
    });
  }
});
