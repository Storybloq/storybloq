/**
 * T-486 U2-4 fixup: a cancelled observation starts no further issue read.
 * The first direct issue read succeeds while the caller cancels; the job
 * must not go on to read the remaining issue refs.
 */
import { describe, it, expect, vi } from "vitest";

const reads: string[] = [];
let onRead: (() => void) | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(async (path: unknown) => {
      reads.push(String(path));
      onRead?.();
      return JSON.stringify({ status: "open" });
    }),
  };
});

const { crossNodeObservation } = await import("../../src/federation/cross-node-observation.js");
import type { ResolvedNode } from "../../src/federation/resolver.js";
import type { Ticket } from "../../src/models/ticket.js";

describe("T-486 U2-4 fixup: issue refs stop on cancel", () => {
  it("a cancel during the first successful direct issue read starts no later issue read", async () => {
    const stop = new AbortController();
    onRead = () => { if (reads.length === 1) stop.abort("stop"); };
    const dependent = {
      id: "T-7", title: "T-7", description: "", type: "task", status: "open", phase: "p0", order: 10,
      createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
      crossNodeBlockedBy: ["cpm:ISS-001", "cpm:ISS-002", "cpm:ISS-003"],
    } as unknown as Ticket;
    const nodes = new Map<string, ResolvedNode>([["cpm", { name: "cpm", resolved: true, storyDir: "/nowhere/cpm/.story" } as unknown as ResolvedNode]]);
    const obs = await crossNodeObservation({ tickets: [dependent], resolvedNodes: nodes, signal: stop.signal });
    for (const ref of ["cpm:ISS-001", "cpm:ISS-002", "cpm:ISS-003"]) {
      expect((obs.statuses.get(ref) as { reason: string }).reason).toBe("cancelled: stop");
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toHaveLength(1);
  });
});
