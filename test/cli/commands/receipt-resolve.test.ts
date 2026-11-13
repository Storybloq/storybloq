import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleConflictsList, handleConflictsShow, handleResolve } from "../../../src/cli/commands/conflicts.js";
import { threeWayMerge } from "../../../src/core/merge-driver.js";
import { readReceipts } from "../../../src/core/receipts.js";
import { receipt } from "../../core/receipt-fixture.js";

/** C-v4.1 3.6 (B2): `conflicts` lists receipt conflicts and `resolve --receipt/--receipt-conflict --keep` clears them. */

type Json = Record<string, unknown>;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "receipt-resolve-"));
  made.push(dir);
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) mkdirSync(join(dir, ".story", sub), { recursive: true });
  writeFileSync(join(dir, ".story", "config.json"), JSON.stringify({
    version: 2, project: "test", type: "npm", language: "ts",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }, null, 2) + "\n");
  writeFileSync(join(dir, ".story", "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-01-01", phases: [{ id: "p1", label: "P1", name: "Alpha", description: "First." }], blockers: [],
  }, null, 2) + "\n");
  return dir;
}

const T: Json = {
  id: "T-001", title: "Ticket", description: "", type: "task", status: "open", phase: "p1", order: 10,
  createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
};

/** Runs the real merge over three receipt arrays and stores the merged ticket. */
function mergedTicket(dir: string, base: unknown[], ours: unknown[], theirs: unknown[], extra: Json = {}): Json {
  const m = threeWayMerge({ ...T, receipts: base }, { ...T, receipts: ours, ...extra }, { ...T, receipts: theirs }, "ticket");
  writeFileSync(join(dir, ".story", "tickets", "T-001.json"), JSON.stringify(m.merged, null, 2) + "\n");
  return m.merged as Json;
}

const readTicket = (dir: string): Json => JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8")) as Json;
const conflictsOf = (t: Json) => ((t._conflicts as Json[] | undefined) ?? []);

const A = receipt({ id: "rc-aaaaaaaaaaaaaaaa" });
const A2 = receipt({ id: "rc-aaaaaaaaaaaaaaaa", result: "fail", data: { passed: 1, failed: 1 } });
const B = receipt({ id: "rc-bbbbbbbbbbbbbbbb" });
const NO_ID = { kind: "test", note: "no id here" };

describe("conflicts lists receipt conflicts", () => {
  it("counts receipt and receipt-opaque entries on the record, and show names the receipt resolve", async () => {
    const dir = makeProject();
    mergedTicket(dir, [NO_ID], [A], [A2, NO_ID]);
    const list = await handleConflictsList(dir, "json");
    const items = (JSON.parse(list.output) as { data: { items: Json[] } }).data.items;
    expect(items).toEqual([expect.objectContaining({ type: "ticket", id: "T-001", conflictCount: 2 })]);
    const show = await handleConflictsShow("T-001", dir, "md");
    expect(show.output).toContain("[receipt]");
    expect(show.output).toContain("[receipt-opaque]");
    expect(show.output).toContain("storybloq resolve T-001 --receipt rc-aaaaaaaaaaaaaaaa --keep ours|theirs|both");
    expect(show.output).toMatch(/storybloq resolve T-001 --receipt-conflict oc-[0-9a-f]{16} --keep ours\|theirs\|both/);
  });
});

describe("resolve --receipt <id> --keep", () => {
  it("ours leaves exactly the ours body, which reads ok again, and keeps a history entry with both bodies", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A], [A2]);
    const result = await handleResolve("T-001", dir, { receipt: A.id as string, keep: "ours", actor: "tester" });
    expect(result.exitCode ?? 0).toBe(0);
    const t = readTicket(dir);
    expect(t.receipts).toEqual([A]);
    expect(conflictsOf(t)).toEqual([]);
    const read = readReceipts(t);
    expect(read.state === "ok" && read.entries.map((e) => e.state)).toEqual(["ok"]);
    const [h] = t.receiptResolutions as Json[];
    expect(h).toMatchObject({ kind: "receipt", field: "receipts", conflictId: A.id, keep: "ours", by: "tester" });
    expect(h!.id).toMatch(/^rr-[0-9a-f]{16}$/);
    expect(h!.bodies).toEqual({ base: [], ours: [A], theirs: [A2] });
    expect(typeof h!.at).toBe("string");
  });

  it("theirs leaves exactly the theirs body", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A], [A2]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "theirs" });
    const t = readTicket(dir);
    expect(t.receipts).toEqual([A2]);
    const read = readReceipts(t);
    expect(read.state === "ok" && read.entries.map((e) => e.state)).toEqual(["ok"]);
  });

  it("both keeps both bodies, and the id stays ineligible as conflicted-kept", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A, B], [A2, B]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "both" });
    const t = readTicket(dir);
    expect(t.receipts).toEqual([A, A2, B]);
    expect(conflictsOf(t)).toEqual([]);
    const read = readReceipts(t);
    expect(read.state === "ok" && read.entries.map((e) => e.state)).toEqual(["conflicted-kept", "conflicted-kept", "ok"]);
    expect((t.receiptResolutions as Json[])[0]).toMatchObject({ keep: "both" });
  });

  it("refuses a side that holds no body for the id, since a receipt is never removed", async () => {
    const dir = makeProject();
    mergedTicket(dir, [A, B], [A], [A, B]);
    await expect(handleResolve("T-001", dir, { receipt: B.id as string, keep: "ours" })).rejects.toThrow(/ours holds no body for rc-bbbbbbbbbbbbbbbb/);
    expect(conflictsOf(readTicket(dir))).toHaveLength(1);
    await handleResolve("T-001", dir, { receipt: B.id as string, keep: "theirs" });
    const t = readTicket(dir);
    expect(t.receipts).toEqual([A, B]);
    expect(conflictsOf(t)).toEqual([]);
  });

  it("names a receipt id with no open conflict", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A], [A2]);
    await expect(handleResolve("T-001", dir, { receipt: B.id as string, keep: "ours" })).rejects.toThrow(/No receipt conflict for "rc-bbbbbbbbbbbbbbbb" on T-001/);
  });

  it("refuses --keep outside ours, theirs and both", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A], [A2]);
    await expect(handleResolve("T-001", dir, { receipt: A.id as string, keep: "mine" })).rejects.toThrow(/--keep takes ours, theirs or both/);
  });

  it("leaves the other conflicts open", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A, B], [A2, receipt({ id: "rc-bbbbbbbbbbbbbbbb", result: "error" })]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "ours" });
    const t = readTicket(dir);
    expect(conflictsOf(t).map((c) => c.id)).toEqual([B.id]);
  });
});

describe("resolve --receipt-conflict <oc-id> --keep", () => {
  it("clears the opaque conflict, never deletes the element, and records the choice", async () => {
    for (const keep of ["ours", "theirs", "both"] as const) {
      const dir = makeProject();
      const merged = mergedTicket(dir, [NO_ID, A], [A], [NO_ID, A]);
      const oc = String(conflictsOf(merged)[0]!.id);
      await handleResolve("T-001", dir, { receiptConflict: oc, keep });
      const t = readTicket(dir);
      expect(t.receipts).toEqual([A, NO_ID]);
      expect(conflictsOf(t)).toEqual([]);
      expect((t.receiptResolutions as Json[])[0]).toMatchObject({ kind: "receipt-opaque", conflictId: oc, keep, bodies: { base: [NO_ID], ours: [], theirs: [NO_ID] } });
    }
  });
});

describe("the generic resolve paths never treat a receipt conflict as a field", () => {
  it("--field receipts is refused and names --receipt", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A], [A2]);
    await expect(handleResolve("T-001", dir, { field: "receipts", use: "ours" })).rejects.toThrow(/--receipt <id> --keep ours\|theirs\|both/);
    expect(readTicket(dir).receipts).toEqual([A, A2]);
  });

  it("blanket --use leaves receipt conflicts open and the receipts untouched", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A], [A2]);
    const t0 = readTicket(dir);
    t0._conflicts = [...conflictsOf(t0), { fieldPath: "/title", field: "title", kind: "field", base: "Old", ours: "Ours", theirs: "Theirs" }];
    writeFileSync(join(dir, ".story", "tickets", "T-001.json"), JSON.stringify(t0, null, 2) + "\n");
    const result = await handleResolve("T-001", dir, { use: "theirs" });
    expect(result.output).toContain("--receipt");
    const t = readTicket(dir);
    expect(t.title).toBe("Theirs");
    expect(t.receipts).toEqual([A, A2]);
    expect(conflictsOf(t).map((c) => c.kind)).toEqual(["receipt"]);
  });
});

describe("supersedes after resolution (reader level; the scope rule is 3.7, commit 5)", () => {
  it("a supersedes entry naming a resolved id keeps naming the one surviving body", async () => {
    const dir = makeProject();
    const C = receipt({ id: "rc-cccccccccccccccc", supersedes: [A.id as string] });
    mergedTicket(dir, [C], [A, C], [A2, C]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "theirs" });
    const t = readTicket(dir);
    const read = readReceipts(t);
    expect(read.state === "ok" && read.entries.map((e) => [e.state, (e as { receipt?: Json }).receipt?.id])).toEqual([
      ["ok", A.id], ["ok", C.id],
    ]);
    expect((t.receipts as Json[]).filter((r) => r.id === A.id)).toEqual([A2]);
  });

  it("a supersedes entry naming a both-kept id still names an id that never counts", async () => {
    const dir = makeProject();
    const C = receipt({ id: "rc-cccccccccccccccc", supersedes: [A.id as string] });
    mergedTicket(dir, [C], [A, C], [A2, C]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "both" });
    const read = readReceipts(readTicket(dir));
    expect(read.state === "ok" && read.entries.filter((e) => e.state === "ok").map((e) => (e as { receipt: Json }).receipt.id)).toEqual([C.id]);
  });
});

describe("review fixes: resolution history, exact bodies, entity-level replacement", () => {
  const writeTicket = (dir: string, t: Json) => writeFileSync(join(dir, ".story", "tickets", "T-001.json"), JSON.stringify(t, null, 2) + "\n");

  it("keeping one side removes only the keyed bodies the conflict named; a future-version element sharing the id survives", async () => {
    const dir = makeProject();
    const FUTURE_A = { ...A, v: 2, shape: "new" };
    const MALFORMED_A = { id: A.id, kind: "test" };
    mergedTicket(dir, [], [A, FUTURE_A, MALFORMED_A], [A2]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "theirs" });
    const t = readTicket(dir);
    expect(t.receipts).toEqual([A2, FUTURE_A, MALFORMED_A]);
  });

  it("history entries carry stable ids, and concurrent resolutions on two clones merge to both entries with every body", async () => {
    const dir = makeProject();
    const B2 = receipt({ id: "rc-bbbbbbbbbbbbbbbb", result: "error" });
    const base = mergedTicket(dir, [], [A, B], [A2, B2]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "ours", actor: "one" });
    const ours = readTicket(dir);
    writeTicket(dir, base);
    await handleResolve("T-001", dir, { receipt: B.id as string, keep: "theirs", actor: "two" });
    const theirs = readTicket(dir);
    for (const t of [ours, theirs]) expect((t.receiptResolutions as Json[])[0]!.id).toMatch(/^rr-[0-9a-f]{16}$/);
    const m = threeWayMerge(base, ours, theirs, "ticket");
    const history = m.merged.receiptResolutions as Json[];
    expect(history.map((h) => h.by)).toEqual(["one", "two"]);
    expect(history[0]!.bodies).toEqual({ base: [], ours: [A], theirs: [A2] });
    expect(history[1]!.bodies).toEqual({ base: [], ours: [B], theirs: [B2] });
    expect(((m.merged._conflicts as Json[] | undefined) ?? []).filter((c) => c.field === "receiptResolutions")).toEqual([]);
  });

  it("the same conflict resolved on both clones keeps both history entries", async () => {
    const dir = makeProject();
    const base = mergedTicket(dir, [], [A], [A2]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "ours", actor: "one" });
    const ours = readTicket(dir);
    writeTicket(dir, base);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "theirs", actor: "two" });
    const theirs = readTicket(dir);
    const m = threeWayMerge(base, ours, theirs, "ticket");
    expect((m.merged.receiptResolutions as Json[]).map((h) => [h.by, h.keep])).toEqual([["one", "ours"], ["two", "theirs"]]);
  });

  it("generic --field and blanket --use never replace or delete the resolution history", async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A], [A2]);
    await handleResolve("T-001", dir, { receipt: A.id as string, keep: "ours" });
    const t0 = readTicket(dir);
    const history = t0.receiptResolutions;
    t0._conflicts = [{ fieldPath: "/receiptResolutions", field: "receiptResolutions", kind: "field", base: [], ours: [], theirs: [] }];
    writeTicket(dir, t0);
    await expect(handleResolve("T-001", dir, { field: "receiptResolutions", use: "theirs" })).rejects.toThrow(/receiptResolutions/);
    await handleResolve("T-001", dir, { use: "theirs" });
    const t = readTicket(dir);
    expect(t.receiptResolutions).toEqual(history);
    expect(conflictsOf(t).map((c) => c.field)).toEqual(["receiptResolutions"]);
  });

  const entityCase = async () => {
    const dir = makeProject();
    mergedTicket(dir, [], [A, B], [A2, receipt({ id: "rc-bbbbbbbbbbbbbbbb", result: "error" })]);
    await handleResolve("T-001", dir, { receipt: B.id as string, keep: "ours" });
    const t0 = readTicket(dir);
    const snapshot = { ...T, title: "Theirs whole" };
    t0._conflicts = [...conflictsOf(t0), { fieldPath: "", field: "_entity", kind: "delete-edit", base: null, ours: { ...T }, theirs: snapshot }];
    writeTicket(dir, t0);
    return { dir, receipts: t0.receipts, history: t0.receiptResolutions };
  };

  it("blanket --use with an entity-level conflict keeps every receipt and the history while receipt conflicts stay open", async () => {
    const { dir, receipts, history } = await entityCase();
    await handleResolve("T-001", dir, { use: "theirs" });
    const t = readTicket(dir);
    expect(t.title).toBe("Theirs whole");
    expect(t.receipts).toEqual(receipts);
    expect(t.receiptResolutions).toEqual(history);
    expect(conflictsOf(t).map((c) => c.kind)).toEqual(["receipt"]);
  });

  it("--field _entity keeps every receipt and the history", async () => {
    const { dir, receipts, history } = await entityCase();
    await handleResolve("T-001", dir, { field: "_entity", use: "theirs" });
    const t = readTicket(dir);
    expect(t.title).toBe("Theirs whole");
    expect(t.receipts).toEqual(receipts);
    expect(t.receiptResolutions).toEqual(history);
  });
});
