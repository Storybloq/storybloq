/**
 * T-486 U2-3a: one counting contract (computeTicketCounts) and one identity
 * policy (applyTicketIdentityPolicy) over the records the loader accepts, read
 * by ProjectState and by loadTicketRecords alike (plan V3A 5a, amendment B3).
 *
 * Fixture F1 is written raw and mixes every case the contract has to place:
 * an umbrella, a withdrawn, a delivered and an in-progress leaf, a deleted and
 * an archived record, an unrecognized checkpoint, a canonical id claimed by
 * two files, a legacy record whose displayId only the loader supplies, and
 * files the loader refuses (bad schema, malformed parentTicket and
 * previousDisplayIds, invalid JSON). Its expected values are literals.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../src/core/init.js";
import { loadProject, loadTicketRecords, serializeJSON } from "../../src/core/project-loader.js";
import { applyTicketIdentityPolicy, computeTicketCounts, ticketRefNormalizer } from "../../src/core/ticket-counts.js";
import { validateProject } from "../../src/core/validation.js";
import { formatExport, formatNextTicketOutcome, formatNextTicketsOutcome, formatRecap, formatStatus } from "../../src/core/output-formatter.js";
import { blockedTickets, nextTicket, nextTickets, phasesWithStatus, umbrellaProgress } from "../../src/core/queries.js";
import type { RecapResult } from "../../src/core/snapshot.js";
import type { Ticket } from "../../src/models/ticket.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u23-home-"));
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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DONE = "2026-02-01";
const WITHDRAWAL = { kind: "withdrawn", closedOn: DONE, reason: "Superseded by the redesign." };

type Raw = Record<string, unknown>;

function ticket(id: string, extra: Raw = {}): Raw {
  return {
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p0",
    order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
    ...extra,
  };
}
const delivered = (id: string, extra: Raw = {}) => ticket(id, { status: "complete", completedDate: DONE, ...extra });
const withdrawn = (id: string, extra: Raw = {}) => delivered(id, { resolutionKind: WITHDRAWAL, ...extra });

/** A project with these tickets written raw; `[file, body]` pairs pick the filename (or raw text). */
async function board(entries: Array<Raw | [string, Raw | string]>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u23-"));
  dirs.push(root);
  await initProject(root, { name: "t486-u23" });
  for (const e of entries) {
    const [file, body] = Array.isArray(e) ? e : [`${String(e.id)}.json`, e];
    writeFileSync(join(root, ".story", "tickets", file), typeof body === "string" ? body : serializeJSON(body));
  }
  return root;
}

const stateOf = async (root: string) => (await loadProject(root)).state;

const F = "t-0000000000000f01";

/** Fixture F1. */
const F1: Array<Raw | [string, Raw | string]> = [
  // Legacy record with no displayId: the loader defaults it to "T-001",
  // which collides with F's displayId.
  delivered("T-001"),
  ticket(F, { displayId: "T-001" }),
  delivered("T-010"),
  delivered("T-011", { parentTicket: "T-010" }),
  withdrawn("T-012", { parentTicket: "T-010" }),
  ticket("T-013", { parentTicket: "T-010", status: "inprogress" }),
  ticket("T-020", { blockedBy: ["T-070"] }),
  ticket("T-021", { blockedBy: ["T-001"] }),
  delivered("T-030", { lifecycle: "deleted", deletedAt: "2026-03-01T00:00:00.000Z" }),
  delivered("T-031", { lifecycle: "archived" }),
  delivered("T-040", { ownerCheckpoint: {} }),
  ticket("T-050", { status: "bogus", parentTicket: "T-010" }),
  ["T-070.json", delivered("T-070")],
  ["T-070-copy.json", ticket("T-070")],
  ticket("T-080", { parentTicket: "not-an-id" }),
  ticket("T-081", { previousDisplayIds: "T-5" }),
  ["broken.json", "{ not json"],
];

describe("T-486 U2-3a fixture F1: literal counts and records, independently for each consumer", () => {
  it("ProjectState counts F1 by the contract: 8 leaves, 3 terminal (2 delivered, 1 withdrawn), 5 active", async () => {
    const state = await stateOf(await board(F1));
    expect({
      leaf: state.leafTicketCount,
      terminal: state.completeLeafTicketCount,
      delivered: state.deliveredLeafTicketCount,
      withdrawn: state.withdrawnLeafTicketCount,
      total: state.totalTicketCount,
      open: state.openTicketCount,
      complete: state.completeTicketCount,
    }).toEqual({ leaf: 8, terminal: 3, delivered: 2, withdrawn: 1, total: 8, open: 5, complete: 3 });
    // Both T-070 records stay loaded (validate names them) but neither is counted.
    expect(state.tickets.filter((t) => t.id === "T-070")).toHaveLength(2);
    expect([...state.ticketIdentity.duplicateIds]).toEqual(["T-070"]);
  });

  it("loadTicketRecords accepts the same records, lists every refused file with its recoverable identity, and names both duplicate files", async () => {
    const root = await board(F1);
    const r = await loadTicketRecords(join(root, ".story"));
    expect(r.records.map((t) => t.id)).toEqual(["T-001", "T-010", "T-011", "T-012", "T-013", "T-020", "T-021", "T-030", "T-031", "T-040", "T-070", "T-070", F]);
    expect(r.files).toEqual([
      "T-001", "T-010", "T-011", "T-012", "T-013", "T-020", "T-021", "T-030", "T-031", "T-040", "T-070-copy", "T-070", F,
    ].map((f) => `.story/tickets/${f}.json`));
    expect(r.omitted).toEqual([
      { file: ".story/tickets/T-050.json", reason: "schema", id: "T-050", parentTicket: "T-010" },
      { file: ".story/tickets/T-080.json", reason: "schema", id: "T-080", parentTicket: "not-an-id" },
      { file: ".story/tickets/T-081.json", reason: "schema", id: "T-081" },
      { file: ".story/tickets/broken.json", reason: "parse" },
    ]);
    expect(r.identity.diagnostics.map(({ code, key, files, ids }) => ({ code, key, files, ids }))).toEqual([
      { code: "duplicate-id", key: "T-070", files: [".story/tickets/T-070-copy.json", ".story/tickets/T-070.json"], ids: ["T-070"] },
      { code: "display-id-collision", key: "T-001", files: [".story/tickets/T-001.json", `.story/tickets/${F}.json`], ids: ["T-001", F] },
    ]);
    expect(computeTicketCounts(r.identity.counted)).toEqual({ leaf: 8, terminal: 3, withdrawn: 1, delivered: 2, active: 5 });
    // The same accepted records as ProjectState, in the same order.
    const state = await stateOf(root);
    expect(state.tickets.map((t) => t.id)).toEqual(r.records.map((t) => t.id));
  });

  it("the legacy displayId is defaulted once, in the loader, and both consumers see it", async () => {
    const root = await board(F1);
    const r = await loadTicketRecords(join(root, ".story"));
    const state = await stateOf(root);
    expect(r.records.find((t) => t.id === "T-001")!.displayId).toBe("T-001");
    expect(state.ticketByID("T-001")!.displayId).toBe("T-001");
    const collision = (d: { code: string }) => d.code === "display-id-collision";
    expect(state.ticketIdentity.diagnostics.filter(collision).map((d) => d.ids)).toEqual([["T-001", F]]);
    expect(r.identity.diagnostics.filter(collision).map((d) => d.ids)).toEqual([["T-001", F]]);
    // The policy itself defaults nothing: on the bytes as written, T-001 has
    // no displayId and there is no collision to report.
    const raw = (id: string) => JSON.parse(readFileSync(join(root, ".story", "tickets", `${id}.json`), "utf-8")) as Ticket;
    expect(raw("T-001").displayId).toBeUndefined();
    expect(applyTicketIdentityPolicy([raw("T-001"), raw(F)]).diagnostics).toEqual([]);
  });

  it("a dependent of the duplicated canonical id stays blocked; a reference by exact legacy id releases (N9, N17)", async () => {
    const state = await stateOf(await board(F1));
    expect(state.isBlocked(state.ticketByID("T-020")!)).toBe(true);
    expect(state.dependencyRelease(state.ticketByID("T-070")!)).toEqual({ releases: false, reason: null, detail: [] });
    // "T-001" is both a legacy id and F's displayId: the exact id wins.
    expect(state.isBlocked(state.ticketByID("T-021")!)).toBe(false);
    expect(state.blockedCount).toBe(1);
  });
});

describe("T-486 U2-3a counts (N2, N5) and surfaces", () => {
  const recapWithoutSnapshot = {
    snapshot: null, changes: null, partial: false,
    suggestedActions: { nextTicket: null, highSeverityIssues: [], recentlyClearedBlockers: [] },
  } as unknown as RecapResult;

  it("N2: an in-progress leaf is neither delivered nor withdrawn", () => {
    const t = (raw: Raw) => raw as unknown as Ticket;
    expect(computeTicketCounts([t(ticket("T-001", { status: "inprogress" })), t(delivered("T-002")), t(withdrawn("T-003"))])).toEqual({
      leaf: 3, terminal: 2, withdrawn: 1, delivered: 1, active: 1,
    });
  });

  it("N5: full status keeps completeTickets terminal and adds deliveredTickets and withdrawnTickets; compact status is unchanged", async () => {
    const state = await stateOf(await board(F1));
    const full = JSON.parse(formatStatus(state, "json")).data;
    expect({
      totalTickets: full.totalTickets, completeTickets: full.completeTickets, deliveredTickets: full.deliveredTickets,
      withdrawnTickets: full.withdrawnTickets, openTickets: full.openTickets,
    }).toEqual({ totalTickets: 8, completeTickets: 3, deliveredTickets: 2, withdrawnTickets: 1, openTickets: 5 });
    const compact = JSON.parse(formatStatus(state, "json", [], [], undefined, [], undefined, [], { items: [], warnings: [] }, true)).data;
    expect(compact).not.toHaveProperty("deliveredTickets");
    expect(compact).not.toHaveProperty("withdrawnTickets");
    expect([compact.totalTickets, compact.completeTickets, compact.openTickets]).toEqual([8, 3, 5]);
  });

  it("status, recap and export md split off withdrawn work when there is some", async () => {
    const state = await stateOf(await board(F1));
    const line = "Tickets: 3/8 complete (2 delivered, 1 withdrawn), 1 blocked";
    expect(formatStatus(state, "md").split("\n")).toContain(line);
    expect(formatRecap(recapWithoutSnapshot, state, "md").split("\n")).toContain(line);
    expect(formatExport(state, "all", null, "md").split("\n")).toContain("Tickets: 3/8 complete (2 delivered, 1 withdrawn)");
  });

  it("with nothing withdrawn the md lines read exactly as before", async () => {
    const state = await stateOf(await board([delivered("T-001"), delivered("T-002"), ticket("T-003")]));
    expect(formatStatus(state, "md").split("\n")).toContain("Tickets: 2/3 complete, 0 blocked");
    expect(formatRecap(recapWithoutSnapshot, state, "md").split("\n")).toContain("Tickets: 2/3 complete, 0 blocked");
    expect(formatExport(state, "all", null, "md").split("\n")).toContain("Tickets: 2/3 complete");
    expect(JSON.parse(formatStatus(state, "json")).data).toMatchObject({ completeTickets: 2, deliveredTickets: 2, withdrawnTickets: 0 });
  });

  it("Parent progress stays terminal and names withdrawn work under the umbrella", async () => {
    const state = await stateOf(await board([
      delivered("T-010"), delivered("T-011", { parentTicket: "T-010" }), withdrawn("T-012", { parentTicket: "T-010" }),
      ticket("T-013", { parentTicket: "T-010" }),
    ]));
    const line = "Parent progress: 2/3 complete, 1 withdrawn (inprogress)";
    expect(formatNextTicketOutcome(nextTicket(state), state, "md").split("\n")).toContain(line);
    expect(formatNextTicketsOutcome(nextTickets(state, 3), state, "md").split("\n")).toContain(line);
  });

  it("Parent progress with nothing withdrawn reads as before", async () => {
    const state = await stateOf(await board([
      delivered("T-010"), delivered("T-011", { parentTicket: "T-010" }), ticket("T-013", { parentTicket: "T-010" }),
    ]));
    const outcome = nextTicket(state);
    expect(formatNextTicketOutcome(outcome, state, "md").split("\n")).toContain("Parent progress: 1/2 complete (inprogress)");
    expect(outcome.kind === "found" && outcome.umbrellaProgress).toEqual({ total: 2, complete: 1, status: "inprogress" });
  });
});

describe("T-486 U2-3a identity policy (B3: N9, N12 to N16)", () => {
  const A = "t-0000000000000a01";
  const B = "t-0000000000000a02";

  it("N9: two files with one canonical id leave both out of the counts and name both files", async () => {
    const root = await board([delivered("T-001"), ["T-002.json", delivered("T-002")], ["T-002-dup.json", ticket("T-002")]]);
    const state = await stateOf(root);
    expect([state.leafTicketCount, state.completeLeafTicketCount]).toEqual([1, 1]);
    const r = await loadTicketRecords(join(root, ".story"));
    expect(r.identity.diagnostics).toEqual([{
      code: "duplicate-id", key: "T-002", ids: ["T-002"],
      files: [".story/tickets/T-002-dup.json", ".story/tickets/T-002.json"],
      message: "Ticket id T-002 is claimed by 2 records (.story/tickets/T-002-dup.json, .story/tickets/T-002.json); all are left out of counts and dependency release.",
    }]);
    expect(computeTicketCounts(r.identity.counted).leaf).toBe(1);
  });

  it("N9: a duplicated canonical id never releases, even when the record the lookup returns is delivered", async () => {
    // Files load in name order and ticketByID keeps the first, so the delivered record is the one found.
    const root = await board([["T-002-a.json", delivered("T-002")], ["T-002-b.json", ticket("T-002")], ticket("T-030", { blockedBy: ["T-002"] })]);
    const state = await stateOf(root);
    expect(state.ticketByID("T-002")!.status).toBe("complete");
    expect(state.isBlocked(state.ticketByID("T-030")!)).toBe(true);
    expect(state.dependencyRelease(state.ticketByID("T-002")!)).toEqual({ releases: false, reason: null, detail: [] });
  });

  it("N12, N13, N14: two tickets sharing a displayId are both counted and diagnosed; a canonical-id ref to either releases, the shared displayId does not", async () => {
    const root = await board([
      delivered(A, { displayId: "T-050" }), delivered(B, { displayId: "T-050" }),
      ticket("T-061", { blockedBy: [A] }), ticket("T-062", { blockedBy: [B] }), ticket("T-063", { blockedBy: ["T-050"] }),
    ]);
    const state = await stateOf(root);
    expect([state.leafTicketCount, state.completeLeafTicketCount]).toEqual([5, 2]);
    expect(state.ticketIdentity.diagnostics.map(({ code, key, ids }) => ({ code, key, ids }))).toEqual([
      { code: "display-id-collision", key: "T-050", ids: [A, B] },
    ]);
    const blocked = (id: string) => state.isBlocked(state.ticketByID(id)!);
    expect([blocked("T-061"), blocked("T-062"), blocked("T-063")]).toEqual([false, false, true]);
  });

  it("N15: a previousDisplayIds alias shadowed by a current displayId resolves to the current holder", async () => {
    const state = await stateOf(await board([
      delivered(A, { displayId: "T-050" }),
      ticket(B, { displayId: "T-051", previousDisplayIds: ["T-050"] }),
      ticket("T-063", { blockedBy: ["T-050"] }),
    ]));
    expect(state.isBlocked(state.ticketByID("T-063")!)).toBe(false);
    expect(state.ticketIdentity.diagnostics).toEqual([]);
  });

  it("N16: after reconcile renames the loser, the displayId ref resolves to the winner and releases", async () => {
    const before = await board([
      delivered(A, { displayId: "T-050" }), ticket(B, { displayId: "T-050" }), ticket("T-063", { blockedBy: ["T-050"] }),
    ]);
    expect(await stateOf(before).then((s) => s.isBlocked(s.ticketByID("T-063")!))).toBe(true);
    const after = await board([
      delivered(A, { displayId: "T-050" }), ticket(B, { displayId: "T-064", previousDisplayIds: ["T-050"] }), ticket("T-063", { blockedBy: ["T-050"] }),
    ]);
    const state = await stateOf(after);
    expect(state.isBlocked(state.ticketByID("T-063")!)).toBe(false);
  });
});

describe("T-486 U2-3a fixup: one counted population for every count (R1-1)", () => {
  const ids = (ts: readonly Ticket[]) => ts.map((t) => t.id);
  /** Phase leaf counts plus unphased leaves give the total. */
  const sumsToTotal = (state: Awaited<ReturnType<typeof stateOf>>) =>
    phasesWithStatus(state).reduce((n, p) => n + p.leafCount, 0) + state.countedPhaseTickets(null).length === state.leafTicketCount;

  it("duplicated blocked leaves: totals, blocked, phase leaf count and unphased all agree and all exclude them", async () => {
    const root = await board([
      ticket("T-001"), delivered("T-002"), ticket("T-006", { phase: null }),
      ["T-005-a.json", ticket("T-005", { blockedBy: ["T-099"] })],
      ["T-005-b.json", ticket("T-005", { blockedBy: ["T-099"], phase: null })],
    ]);
    const state = await stateOf(root);
    const full = JSON.parse(formatStatus(state, "json")).data;
    expect([full.totalTickets, full.completeTickets, full.openTickets, full.blockedTickets, full.unphasedOpenTickets]).toEqual([3, 1, 2, 0, 1]);
    expect(full.phases.map((p: { id: string; leafCount: number; status: string }) => [p.id, p.leafCount, p.status])).toEqual([["p0", 2, "inprogress"]]);
    expect(sumsToTotal(state)).toBe(true);
    expect(formatStatus(state, "md")).toContain("Tickets: 1/3 complete, 0 blocked");
    // Listings keep both records.
    expect(ids(state.leafTickets).filter((id) => id === "T-005")).toHaveLength(2);
    expect(ids(blockedTickets(state))).toEqual(["T-005", "T-005"]);
  });

  it("duplicated children under one parent: the parent is a leaf in every surface", async () => {
    const root = await board([
      ticket("T-001"), delivered("T-010"),
      ["T-011-a.json", ticket("T-011", { parentTicket: "T-010" })],
      ["T-011-b.json", ticket("T-011", { parentTicket: "T-010" })],
    ]);
    const state = await stateOf(root);
    expect(state.umbrellaIDs.has("T-010")).toBe(false);
    expect(state.isUmbrella(state.ticketByID("T-010")!)).toBe(false);
    expect(ids(state.countedLeafTickets)).toEqual(["T-001", "T-010"]);
    expect([state.leafTicketCount, state.completeLeafTicketCount, state.blockedCount]).toEqual([2, 1, 0]);
    expect(state.phaseStatus("p0")).toBe("inprogress");
    expect(umbrellaProgress("T-010", state)).toBeNull();
    expect(sumsToTotal(state)).toBe(true);
    const r = await loadTicketRecords(join(root, ".story"));
    expect(computeTicketCounts(r.identity.counted)).toMatchObject({ leaf: 2, terminal: 1 });
  });

  it("a duplicated child beside a counted one: progress and umbrella status count only the counted child", async () => {
    const root = await board([
      delivered("T-010"), delivered("T-012", { parentTicket: "T-010" }),
      ["T-011-a.json", ticket("T-011", { parentTicket: "T-010" })],
      ["T-011-b.json", ticket("T-011", { parentTicket: "T-010" })],
    ]);
    const state = await stateOf(root);
    expect(state.umbrellaIDs.has("T-010")).toBe(true);
    expect(umbrellaProgress("T-010", state)).toEqual({ total: 1, complete: 1, status: "complete" });
    expect(state.umbrellaStatus("T-010")).toBe("complete");
    expect([state.leafTicketCount, state.completeLeafTicketCount]).toEqual([1, 1]);
    expect(state.phaseStatus("p0")).toBe("complete");
  });

  it("a parent whose only children share one canonical id is a leaf, and the release walk still finds the withdrawn record", async () => {
    const root = await board([
      delivered("T-010"),
      ["T-011-a.json", withdrawn("T-011", { parentTicket: "T-010" })],
      ["T-011-b.json", ticket("T-011", { parentTicket: "T-010" })],
      ticket("T-020", { blockedBy: ["T-010"] }),
    ]);
    const state = await stateOf(root);
    expect(state.umbrellaIDs.has("T-010")).toBe(false);
    expect(ids(state.countedLeafTickets)).toEqual(["T-010", "T-020"]);
    expect([state.leafTicketCount, state.completeLeafTicketCount]).toEqual([2, 1]);
    // The walk reads childrenByParent over every record, so it stays conservative.
    expect(state.dependencyRelease(state.ticketByID("T-010")!)).toEqual({ releases: false, reason: "withheld", detail: ["T-011"] });
    expect(state.isBlocked(state.ticketByID("T-020")!)).toBe(true);
    expect(validateProject(state).findings.filter((f) => f.code === "duplicate_ticket_id").map((f) => f.entity)).toEqual(["T-011"]);
  });

  it("with no duplicated id the counted lists equal the listings", async () => {
    const state = await stateOf(await board([
      delivered("T-010"), withdrawn("T-011", { parentTicket: "T-010" }), ticket("T-012", { parentTicket: "T-010", status: "inprogress" }),
      ticket("T-020", { phase: null }), ticket("T-021", { blockedBy: ["T-020"] }),
    ]));
    expect(state.countedLeafTickets).toEqual(state.leafTickets);
    expect(state.countedPhaseTickets("p0")).toEqual(state.phaseTickets("p0"));
    expect(state.countedPhaseTickets(null)).toEqual(state.phaseTickets(null));
    expect(sumsToTotal(state)).toBe(true);
  });
});

describe("T-486 U2-3a fixup: an ambiguous current displayId never falls through to a historical alias (R1-2)", () => {
  const A = "t-0000000000000b01";
  const B = "t-0000000000000b02";
  const C = "t-0000000000000b03";

  it("two current holders and one historical holder: the child's parent stays unresolved and the historical holder stays a counted leaf", async () => {
    const root = await board([
      ticket(A, { displayId: "T-050" }), ticket(B, { displayId: "T-050" }),
      delivered(C, { displayId: "T-090", previousDisplayIds: ["T-050"] }),
      ticket("T-060", { parentTicket: "T-050" }),
    ]);
    const state = await stateOf(root);
    expect(state.umbrellaIDs.has(C)).toBe(false);
    expect(state.umbrellaChildren(C)).toEqual([]);
    expect(state.countedLeafTickets.map((t) => t.id)).toContain(C);
    expect([state.leafTicketCount, state.completeLeafTicketCount]).toEqual([4, 1]);
    expect(umbrellaProgress(C, state)).toBeNull();
    const r = await loadTicketRecords(join(root, ".story"));
    expect(ticketRefNormalizer(r.records)("T-050")).toBe("T-050");
    expect(computeTicketCounts(r.identity.counted)).toMatchObject({ leaf: 4, terminal: 1 });
  });

  it("with no current holder the unique historical holder still resolves", async () => {
    const root = await board([delivered(C, { displayId: "T-090", previousDisplayIds: ["T-050"] }), ticket("T-060", { parentTicket: "T-050" })]);
    const state = await stateOf(root);
    expect(state.umbrellaIDs.has(C)).toBe(true);
    expect(state.umbrellaChildren(C).map((t) => t.id)).toEqual(["T-060"]);
  });
});

describe("T-486 U2-3a fixup 2: umbrella counts walk the counted children (R2-1)", () => {
  const A = "t-0000000000000c01";
  const B = "t-0000000000000c02";
  const C = "t-0000000000000c03";

  it("a parent displayId made unique by dropping a duplicated record: the umbrella counts its counted child, and the release walk finds it in the counted list", async () => {
    const root = await board([
      [`${A}-a.json`, ticket(A, { displayId: "T-050" })],
      [`${A}-b.json`, ticket(A, { displayId: "T-050" })],
      delivered(B, { displayId: "T-050" }),
      delivered(C, { displayId: "T-051", parentTicket: "T-050" }),
      ticket("T-070", { blockedBy: [B] }),
    ]);
    const state = await stateOf(root);
    // Counted population: A is dropped, so T-050 names B alone.
    expect(state.umbrellaIDs.has(B)).toBe(true);
    expect(state.umbrellaStatus(B)).toBe("complete");
    expect(umbrellaProgress(B, state)).toEqual({ total: 1, complete: 1, status: "complete" });
    expect(state.countedUmbrellaLeaves(B).map((t) => t.id)).toEqual([C]);
    expect([state.leafTicketCount, state.completeLeafTicketCount]).toEqual([2, 1]);
    // Every record: T-050 is ambiguous, so the listing finds no child under B.
    // The release walk also reads the counted list (U2-3b), finds the
    // delivered C there, and B releases as before.
    expect(state.umbrellaChildren(B)).toEqual([]);
    expect(state.dependencyRelease(state.ticketByID(B)!)).toEqual({ releases: true, reason: null, detail: [] });
    expect(state.isBlocked(state.ticketByID("T-070")!)).toBe(false);
  });
});

describe("T-486 U2-3b: the release walk reads both child lists, each on its own", () => {
  const A = "t-0000000000000d01";
  const B = "t-0000000000000d02";
  const C = "t-0000000000000d03";
  const X = "t-0000000000000d04";
  const Y = "t-0000000000000d05";

  it("an umbrella whose only counted child is withdrawn does not release, though its displayId is ambiguous over every record", async () => {
    const root = await board([
      [`${A}-a.json`, ticket(A, { displayId: "T-050" })],
      [`${A}-b.json`, ticket(A, { displayId: "T-050" })],
      delivered(B, { displayId: "T-050" }),
      withdrawn(C, { displayId: "T-051", parentTicket: "T-050" }),
      ticket("T-070", { blockedBy: [B] }),
    ]);
    const state = await stateOf(root);
    // The counts make B an umbrella over the withdrawn C alone.
    expect(state.umbrellaIDs.has(B)).toBe(true);
    expect(state.countedUmbrellaLeaves(B).map((t) => t.id)).toEqual([C]);
    // Over every record T-050 is ambiguous, so only the counted walk finds C.
    expect(state.umbrellaChildren(B)).toEqual([]);
    expect(state.dependencyRelease(state.ticketByID(B)!)).toEqual({ releases: false, reason: "withheld", detail: [C] });
    expect(state.isBlocked(state.ticketByID("T-070")!)).toBe(true);
  });

  it("a withdrawn leaf in the all-records list still withholds when the counted list gives it a delivered child", async () => {
    // X is B's child by id in both lists. Over every record T-060 is carried
    // by X and by both records of the duplicated A, so Y's parent stays
    // unresolved and X is a withdrawn leaf. In the counted population A is
    // dropped, T-060 names X alone, and Y is X's child, so X is an
    // intermediate there. A single walk over the two lists merged would
    // descend through X, find only the delivered Y and release B.
    const root = await board([
      [`${A}-a.json`, ticket(A, { displayId: "T-060" })],
      [`${A}-b.json`, ticket(A, { displayId: "T-060" })],
      delivered(B, { displayId: "T-061" }),
      withdrawn(X, { displayId: "T-060", parentTicket: B }),
      delivered(Y, { displayId: "T-062", parentTicket: "T-060" }),
      ticket("T-080", { blockedBy: [B] }),
    ]);
    const state = await stateOf(root);
    expect(state.umbrellaChildren(B).map((t) => t.id)).toEqual([X]);
    expect(state.umbrellaChildren(X)).toEqual([]);
    expect(state.countedUmbrellaLeaves(B).map((t) => t.id)).toEqual([Y]);
    expect(state.dependencyRelease(state.ticketByID(B)!)).toEqual({ releases: false, reason: "withheld", detail: [X] });
    expect(state.isBlocked(state.ticketByID("T-080")!)).toBe(true);
  });
});
