/**
 * T-486 U2-4: a cross-node blocker is judged from the target node's whole
 * ticket graph by the node's own release rule (V3A 5c, B1, D1). Each case
 * builds a real node ledger and reads the ref's status from the resolver.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { CrossNodeBlockingResolver } from "../../src/federation/cross-node-resolver.js";
import { resolveAllNodes } from "../../src/federation/resolver.js";
import type { Ticket } from "../../src/models/ticket.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u24-home-"));
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
const locked: string[] = [];
afterEach(() => {
  for (const f of locked.splice(0)) chmodSync(f, 0o644);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
/** A record the ticket schema refuses (status is not a ticket status), keeping its id and parent. */
const invalid = (id: string, extra: Raw = {}) => ticket(id, { status: "bogus", ...extra });

/** A node ledger; `[file, body]` pairs pick the filename (a string body is written raw). */
async function nodeWith(entries: Array<Raw | [string, Raw | string]>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u24-node-"));
  dirs.push(root);
  await initProject(root, { name: "cpm" });
  for (const e of entries) {
    const [file, body] = Array.isArray(e) ? e : [`${String(e.id)}.json`, e];
    writeFileSync(join(root, ".story", "tickets", file), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}

/** The dependent T-7 in the orchestrator, blocked by `cpm:<ref>`. */
async function observe(nodeRoot: string, ref: string) {
  const orch = mkdtempSync(join(tmpdir(), "t486-u24-orch-"));
  dirs.push(orch);
  const dependent = ticket("T-7", { crossNodeBlockedBy: [`cpm:${ref}`] }) as unknown as Ticket;
  const resolver = await CrossNodeBlockingResolver.build([dependent], resolveAllNodes({ cpm: { path: nodeRoot } }, orch));
  return { status: resolver.getCrossNodeStatus(`cpm:${ref}`), blocked: resolver.isCrossNodeBlocked(dependent) };
}

describe("T-486 U2-4: the target node's graph decides a cross-node release", () => {
  it("X1: a cross-node dependent of a withdrawn target stays blocked", async () => {
    const root = await nodeWith([withdrawn("T-4")]);
    const r = await observe(root, "T-4");
    expect(r.status).toMatchObject({ resolved: true, status: "withdrawn", detail: ["T-4"] });
    expect(r.blocked).toBe(true);
  });

  it("X1b: a remote umbrella with a withdrawn descendant reports withheld, detail names it", async () => {
    const root = await nodeWith([delivered("T-2"), delivered("T-3", { parentTicket: "T-2" }), withdrawn("T-4", { parentTicket: "T-2" })]);
    const r = await observe(root, "T-2");
    expect(r.status).toMatchObject({ resolved: true, status: "withheld", detail: ["T-4"] });
    expect(r.blocked).toBe(true);
  });

  it("B1-G1: a complete remote umbrella with one schema-invalid withdrawn child is unresolved, the dependent stays blocked", async () => {
    const root = await nodeWith([delivered("T-2"), delivered("T-3", { parentTicket: "T-2" }), invalid("T-4", { parentTicket: "T-2", resolutionKind: { kind: "withdrawn" } })]);
    const r = await observe(root, "T-2");
    expect(r.status).toMatchObject({ resolved: false });
    expect((r.status as { reason: string }).reason).toContain("T-4.json");
    expect(r.blocked).toBe("unresolved");
  });

  it.skipIf(process.getuid?.() === 0)("B1-G2: the same with an unreadable child file is unresolved", async () => {
    const root = await nodeWith([delivered("T-2"), delivered("T-3", { parentTicket: "T-2" }), withdrawn("T-4", { parentTicket: "T-2" })]);
    const file = join(root, ".story", "tickets", "T-4.json");
    chmodSync(file, 0o000);
    locked.push(file);
    const r = await observe(root, "T-2");
    expect(r.status).toMatchObject({ resolved: false });
    expect((r.status as { reason: string }).reason).toContain("T-4.json");
  });

  it("B1-G3: an invalid record provably under a different umbrella does not block the release", async () => {
    const root = await nodeWith([
      delivered("T-2"), delivered("T-3", { parentTicket: "T-2" }),
      delivered("T-5"), delivered("T-6", { parentTicket: "T-5" }), invalid("T-8", { parentTicket: "T-5" }),
    ]);
    const r = await observe(root, "T-2");
    expect(r.status).toEqual({ resolved: true, status: "complete" });
    expect(r.blocked).toBe(false);
  });

  it("B1-G5: an omitted record with a malformed parentTicket makes the target unresolved", async () => {
    const root = await nodeWith([delivered("T-2"), invalid("T-8", { parentTicket: 42 })]);
    expect((await observe(root, "T-2")).status).toMatchObject({ resolved: false });
  });

  it("B1-G6: an omitted record whose parent alias is ambiguous makes the target unresolved", async () => {
    const root = await nodeWith([
      delivered("T-2"),
      ["t-000000000000a001.json", delivered("t-000000000000a001", { displayId: "T-9" })],
      ["t-000000000000a002.json", delivered("t-000000000000a002", { displayId: "T-9" })],
      invalid("T-8", { parentTicket: "T-9" }),
    ]);
    expect((await observe(root, "T-2")).status).toMatchObject({ resolved: false });
  });

  it("B1-G7: an omitted record whose parent is itself omitted makes the target unresolved", async () => {
    const root = await nodeWith([delivered("T-2"), invalid("T-8", { parentTicket: "T-9" }), invalid("T-9")]);
    expect((await observe(root, "T-2")).status).toMatchObject({ resolved: false });
  });

  it("B1-G8: an omitted record whose accepted ancestors form a cycle makes the target unresolved", async () => {
    const root = await nodeWith([
      delivered("T-2"), delivered("T-5", { parentTicket: "T-6" }), delivered("T-6", { parentTicket: "T-5" }),
      invalid("T-8", { parentTicket: "T-5" }),
    ]);
    expect((await observe(root, "T-2")).status).toMatchObject({ resolved: false });
  });

  it("N14b: a cross-node ref by a displayId shared by two tickets in the target node is unresolved", async () => {
    const root = await nodeWith([
      ["t-000000000000b001.json", delivered("t-000000000000b001", { displayId: "T-9" })],
      ["t-000000000000b002.json", delivered("t-000000000000b002", { displayId: "T-9" })],
    ]);
    const r = await observe(root, "T-9");
    expect(r.status).toMatchObject({ resolved: false });
    expect(r.blocked).toBe("unresolved");
  });

  it("N17: a legacy record whose id equals the ref stays authoritative over another ticket's displayId", async () => {
    const root = await nodeWith([ticket("T-5"), ["t-000000000000c001.json", delivered("t-000000000000c001", { displayId: "T-5" })]]);
    const r = await observe(root, "T-5");
    expect(r.status).toEqual({ resolved: true, status: "open" });
    expect(r.blocked).toBe(true);
  });

  it("D-dup: a remote target whose canonical id two complete records share is unresolved, duplicate id", async () => {
    const root = await nodeWith([delivered("T-6"), ["t-000000000000d001.json", delivered("T-6")]]);
    const r = await observe(root, "T-6");
    expect(r.status).toMatchObject({ resolved: false });
    expect((r.status as { reason: string }).reason).toContain("duplicate");
    expect(r.blocked).toBe("unresolved");
  });

  it("D-cyc: a complete remote umbrella whose children form a cycle is unresolved, parent cycle", async () => {
    const root = await nodeWith([delivered("T-2", { parentTicket: "T-3" }), delivered("T-3", { parentTicket: "T-2" })]);
    const r = await observe(root, "T-2");
    expect(r.status).toMatchObject({ resolved: false });
    expect((r.status as { reason: string }).reason).toContain("cycle");
  });

  it("D-chk: a complete owner checkpoint that is not approved reports checkpoint and keeps the dependent blocked", async () => {
    const root = await nodeWith([delivered("T-4", { ownerCheckpoint: {} })]);
    const r = await observe(root, "T-4");
    expect(r.status).toEqual({ resolved: true, status: "checkpoint" });
    expect(r.blocked).toBe(true);
  });

  it("an ordinary complete target still releases, and an open one blocks", async () => {
    const root = await nodeWith([delivered("T-4"), ticket("T-5", { status: "inprogress" })]);
    expect(await observe(root, "T-4")).toEqual({ status: { resolved: true, status: "complete" }, blocked: false });
    expect(await observe(root, "T-5")).toEqual({ status: { resolved: true, status: "inprogress" }, blocked: true });
  });
});
