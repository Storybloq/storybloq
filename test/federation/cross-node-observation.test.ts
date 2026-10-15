/**
 * T-486 U2-4 (B2): the live cross-node observation is bounded. It reads
 * nothing without cross-node refs, loads each node once, gives a stalled
 * node `unresolved` at its deadline, and returns at once on cancellation.
 */
import { describe, it, expect } from "vitest";
import { crossNodeObservation, type TicketGraphLoader } from "../../src/federation/cross-node-observation.js";
import type { ResolvedNode } from "../../src/federation/resolver.js";
import type { TicketRecords } from "../../src/core/project-loader.js";
import { applyTicketIdentityPolicy } from "../../src/core/ticket-counts.js";
import type { Ticket } from "../../src/models/ticket.js";

const DONE = "2026-02-01";
function ticket(id: string, extra: Record<string, unknown> = {}): Ticket {
  return {
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p0",
    order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
    ...extra,
  } as unknown as Ticket;
}

function records(tickets: Ticket[]): TicketRecords {
  const files = tickets.map((t) => `.story/tickets/${t.id}.json`);
  return { records: tickets, files, omitted: [], warnings: [], identity: applyTicketIdentityPolicy(tickets, files) };
}

function nodes(...names: string[]): Map<string, ResolvedNode> {
  return new Map(names.map((n) => [n, { name: n, resolved: true, storyDir: `/nowhere/${n}/.story` } as unknown as ResolvedNode]));
}

/** A loader that counts calls per storyDir and answers from `boards`; a missing board never settles unless aborted. */
function loader(boards: Record<string, Ticket[]>, opts: { ignoreAbort?: boolean } = {}) {
  const calls: string[] = [];
  const load: TicketGraphLoader = (storyDir, signal) => {
    calls.push(storyDir);
    const name = storyDir.split("/")[2]!;
    const board = boards[name];
    if (board) return Promise.resolve(records(board));
    return new Promise((_resolve, reject) => {
      if (!opts.ignoreAbort) signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  return { calls, load };
}

const dependent = (...refs: string[]) => ticket("T-7", { crossNodeBlockedBy: refs });

describe("T-486 U2-4: the live cross-node observation is bounded (B2)", () => {
  it("B2-P1: a project with no cross-node edges performs no node read", async () => {
    const { calls, load } = loader({ cpm: [ticket("T-4")] });
    const obs = await crossNodeObservation({ tickets: [ticket("T-1"), ticket("T-2", { blockedBy: ["T-1"] })], resolvedNodes: nodes("cpm"), load });
    expect(calls).toEqual([]);
    expect(obs.statuses.size).toBe(0);
    expect(obs.live).toBe(true);
  });

  it("B2-P2: a stalled node is unresolved within its deadline while another node resolves", async () => {
    const { load } = loader({ fast: [ticket("T-4", { status: "complete", completedDate: DONE })] }, { ignoreAbort: true });
    const started = Date.now();
    const obs = await crossNodeObservation({
      tickets: [dependent("fast:T-4", "slow:T-4")], resolvedNodes: nodes("fast", "slow"), load, nodeTimeoutMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(obs.statuses.get("fast:T-4")).toEqual({ resolved: true, status: "complete" });
    expect(obs.statuses.get("slow:T-4")).toEqual({ resolved: false, reason: "timeout" });
  });

  it("B2-P3: cancelling the caller's signal during loading returns at once, every ref unresolved", async () => {
    const { load } = loader({}, { ignoreAbort: true });
    const controller = new AbortController();
    const pending = crossNodeObservation({
      tickets: [dependent("a:T-1", "b:T-2")], resolvedNodes: nodes("a", "b"), load, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const obs = await pending;
    expect(Date.now() - started).toBeLessThan(500);
    for (const ref of ["a:T-1", "b:T-2"]) {
      expect(obs.statuses.get(ref)).toMatchObject({ resolved: false });
      expect((obs.statuses.get(ref) as { reason: string }).reason).toMatch(/^cancelled/);
    }
  });

  it("B2-P4: twenty refs into one node cause exactly one graph load", async () => {
    const board = Array.from({ length: 20 }, (_, i) => ticket(`T-${i + 1}`, { status: "complete", completedDate: DONE }));
    const { calls, load } = loader({ cpm: board });
    const refs = board.map((t) => `cpm:${t.id}`);
    const obs = await crossNodeObservation({ tickets: [dependent(...refs.slice(0, 10)), ticket("T-8", { crossNodeBlockedBy: refs.slice(10) })], resolvedNodes: nodes("cpm"), load });
    expect(calls).toHaveLength(1);
    expect([...obs.statuses.values()].every((s) => s.resolved && s.status === "complete")).toBe(true);
    expect(obs.statuses.size).toBe(20);
  });

  it("the whole observation stops at its own deadline even when every node stalls", async () => {
    const { load } = loader({}, { ignoreAbort: true });
    const started = Date.now();
    const obs = await crossNodeObservation({ tickets: [dependent("a:T-1")], resolvedNodes: nodes("a"), load, deadlineMs: 50, nodeTimeoutMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect((obs.statuses.get("a:T-1") as { reason: string }).reason).toBe("cancelled: observation deadline");
  });
});
