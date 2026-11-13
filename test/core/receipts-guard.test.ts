import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { assertPreparedWritesCurrent, prepareIssueWrite, prepareIssueWriteSeams, prepareTicketWrite, prepareTicketWriteSeams, resolutionWriteContextFor, withConflictResolutionLock, runTransactionUnlocked, withProjectLock, writeIssueUnlocked, writeTicketUnlocked } from "../../src/core/project-loader.js";
import { handleResolve } from "../../src/cli/commands/conflicts.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { LANDING_APPEND_AUTHORITY, RECEIPT_APPEND_AUTHORITY } from "../../src/core/receipts-guard.js";
import { MERGE_RESOLUTION_AUTHORITY, resolveReceiptConflict } from "../../src/core/receipt-resolve.js";
import { resolutionEntryId } from "../../src/core/append-only-merge.js";
import { appendReceipt } from "../../src/core/receipt-append.js";
import { restoreRecord, RestoreUnsafe } from "../../src/core/ledger-restore.js";
import { capabilityCatalog } from "../../src/cli/commands/capability.js";
import { applyRepairPatches } from "../../src/cli/commands/repair.js";
import { handleReconcile } from "../../src/cli/commands/reconcile.js";
import { appendIssueLanding } from "../../src/cli/commands/issue.js";
import { appendTicketLanding } from "../../src/cli/commands/ticket.js";
import { handleTicketMetaSet, handleTicketMetaUnset, handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { handleIssueMetaSet, handleIssueUpdate } from "../../src/cli/commands/issue.js";
import { cleanupTempDirs, isolateGit, tempDir } from "../mcp/board-git-fixtures.js";
import { receipt, BOARD } from "./receipt-fixture.js";
import { receiptsNamingBoard } from "../../src/core/board-id.js";

/** C-v4.1 3.4 (commit 2): the receipts guard, through the real writers. */

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

type Json = Record<string, unknown>;
const A = receipt({ id: "rc-aaaaaaaaaaaaaaaa" });
const B = receipt({ id: "rc-bbbbbbbbbbbbbbbb" });
const NO_ID = { kind: "test", note: "no id" };
const FUTURE = { id: "rc-ffffffffffffffff", v: 2, shape: "new" };
const MALFORMED = { id: "rc-eeeeeeeeeeeeeeee", v: 1 };
const MIXED = [A, NO_ID, FUTURE, MALFORMED];

const TICKET: Json = {
  id: "T-001", title: "Ticket", description: "", type: "task", status: "open", phase: "p0", order: 10,
  createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
};
const ISSUE: Json = {
  id: "ISS-001", title: "Issue", status: "open", severity: "low", components: [], impact: "i", resolution: null,
  location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
};

async function project(extraT: Json = {}, extraI: Json = {}): Promise<string> {
  const root = tempDir("rguard");
  await initProject(root, { name: "g" });
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({ ...TICKET, ...extraT }, null, 2) + "\n");
  writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({ ...ISSUE, ...extraI }, null, 2) + "\n");
  return root;
}
const read = (root: string, rel: string) => JSON.parse(readFileSync(join(root, ".story", rel), "utf-8")) as Json;
const raw = (root: string, rel: string) => readFileSync(join(root, ".story", rel), "utf-8");

describe("writers keep receipts equal in canonical content", () => {
  it("ticket update passes every receipt through, malformed, id-less and future ones included", async () => {
    const root = await project({ receipts: MIXED });
    await handleTicketUpdate("T-001", { title: "Renamed" } as never, "json", root);
    expect(read(root, "tickets/T-001.json")).toMatchObject({ title: "Renamed", receipts: MIXED });
  });

  it("issue update passes every receipt through", async () => {
    const root = await project({}, { receipts: MIXED });
    await handleIssueUpdate("ISS-001", { title: "Renamed" } as never, "json", root);
    expect(read(root, "issues/ISS-001.json")).toMatchObject({ title: "Renamed", receipts: MIXED });
  });

  it("a record with no receipts is never given the field", async () => {
    const root = await project();
    await handleTicketUpdate("T-001", { title: "Renamed" } as never, "json", root);
    expect(Object.prototype.hasOwnProperty.call(read(root, "tickets/T-001.json"), "receipts")).toBe(false);
  });

  it("a present non-array receipts value is preserved by an unrelated update, never read as empty", async () => {
    const root = await project({ receipts: { not: "an array" } });
    await handleTicketUpdate("T-001", { title: "Renamed" } as never, "json", root);
    const t = read(root, "tickets/T-001.json");
    expect(t.title).toBe("Renamed");
    expect(t.receipts).toEqual({ not: "an array" });
  });
});

describe("metadata set and unset never touch the append-only fields", () => {
  it.each(["receipts", "landings", "receiptResolutions"])("ticket meta set and unset on %s are refused", async (key) => {
    const root = await project({ receipts: [A] });
    const before = raw(root, "tickets/T-001.json");
    await expect(handleTicketMetaSet("T-001", key, [], "json", root)).rejects.toThrow();
    await expect(handleTicketMetaUnset("T-001", key, "json", root)).rejects.toThrow();
    expect(raw(root, "tickets/T-001.json")).toBe(before);
  });

  it("issue meta set on receipts is refused", async () => {
    const root = await project({}, { receipts: [A] });
    const before = raw(root, "issues/ISS-001.json");
    await expect(handleIssueMetaSet("ISS-001", "receipts", [], "json", root)).rejects.toThrow();
    expect(raw(root, "issues/ISS-001.json")).toBe(before);
  });
});

describe("the guard at preparation: the unlocked writers", () => {
  const writeT = (root: string, t: Json, authority?: symbol) =>
    withProjectLock(root, { strict: false }, async () => {
      await writeTicketUnlocked(t as never, root, { touch: false, ...(authority ? { receiptsAuthority: authority } : {}) } as never);
    });

  it.each([
    ["a removal", [A]],
    ["an alteration", [{ ...A, result: "fail" }, B]],
    ["a reorder", [B, A]],
    ["an append without authority", [A, B, receipt({ id: "rc-cccccccccccccccc" })]],
    ["a replacement by a non-array", { a: 1 }],
  ])("refuses %s on a ticket and writes nothing", async (_l, receipts) => {
    const root = await project({ receipts: [A, B] });
    const before = raw(root, "tickets/T-001.json");
    await expect(writeT(root, { ...TICKET, receipts })).rejects.toThrow(/receipts_immutable/);
    expect(raw(root, "tickets/T-001.json")).toBe(before);
  });

  it("refuses removing the field", async () => {
    const root = await project({ receipts: [A] });
    await expect(writeT(root, { ...TICKET })).rejects.toThrow(/receipts_immutable/);
  });

  it("refuses adding an empty receipts field to a record that had none", async () => {
    const root = await project();
    await expect(writeT(root, { ...TICKET, receipts: [] })).rejects.toThrow(/receipts_immutable/);
  });

  it("an authorised append of one well-formed receipt passes, and of a malformed one is refused", async () => {
    const root = await project({ receipts: MIXED });
    await expect(writeT(root, { ...TICKET, receipts: [...MIXED, { id: "rc-dddddddddddddddd" }] }, RECEIPT_APPEND_AUTHORITY)).rejects.toThrow(/receipts_immutable/);
    await writeT(root, { ...TICKET, receipts: [...MIXED, B] }, RECEIPT_APPEND_AUTHORITY);
    expect(read(root, "tickets/T-001.json").receipts).toEqual([...MIXED, B]);
  });

  it("refuses an issue write that drops landings or history", async () => {
    const L = { sha: "a".repeat(40), branch: "main", landedAt: "2026-01-01T00:00:00Z" };
    const root = await project({}, { landings: [L], receiptResolutions: [{ id: "rr-0000000000000000" }] });
    const write = (i: Json) => withProjectLock(root, { strict: false }, async () => { await writeIssueUnlocked(i as never, root, { touch: false }); });
    await expect(write({ ...ISSUE, receiptResolutions: [{ id: "rr-0000000000000000" }] })).rejects.toThrow(/receipts_immutable/);
    await expect(write({ ...ISSUE, landings: [L] })).rejects.toThrow(/receipts_immutable/);
  });

  it("refuses a value with no canonical form instead of writing it changed", async () => {
    const root = await project();
    writeFileSync(join(root, ".story", "tickets", "T-001.json"), `${JSON.stringify(TICKET).slice(0, -1)},"receipts":[{"kind":"test","n":1e999}]}\n`);
    const before = raw(root, "tickets/T-001.json");
    await expect(writeT(root, { ...TICKET, title: "x", receipts: [{ kind: "test", n: Number.POSITIVE_INFINITY }] })).rejects.toThrow(/receipts_unpreservable/);
    expect(raw(root, "tickets/T-001.json")).toBe(before);
  });
});

describe("repair and reconcile preserve the append-only fields", () => {
  it("a repair patch keeps every receipt, landing and history entry, and a patch that touches one is refused", async () => {
    const L = { sha: "a".repeat(40), branch: "main", landedAt: "2026-01-01T00:00:00Z" };
    const root = await project({ receipts: MIXED, landings: [L] });
    await withProjectLock(root, { strict: false }, async () => {
      await applyRepairPatches(root, [{ id: "T-001", type: "ticket", set: { blockedBy: [] }, unset: [] }]);
    });
    expect(read(root, "tickets/T-001.json")).toMatchObject({ receipts: MIXED, landings: [L] });
    const before = raw(root, "tickets/T-001.json");
    await expect(withProjectLock(root, { strict: false }, async () => {
      await applyRepairPatches(root, [{ id: "T-001", type: "ticket", set: { receipts: [] }, unset: [] }]);
    })).rejects.toThrow(/receipts_immutable/);
    expect(raw(root, "tickets/T-001.json")).toBe(before);
  });

  it("a reconcile rank rebalance keeps every receipt", async () => {
    const root = await project({ receipts: MIXED, rank: "V".repeat(20) });
    writeFileSync(join(root, ".story", "tickets", "T-002.json"), JSON.stringify({ ...TICKET, id: "T-002", order: 20, rank: "A" }, null, 2) + "\n");
    const result = await handleReconcile(root, { dryRun: false, ci: false, format: "md", rebalanceRanks: true });
    expect(result.output).toContain("Rebalanced");
    const t = read(root, "tickets/T-001.json");
    expect((t.rank as string).length).toBeLessThan(20);
    expect(t.receipts).toEqual(MIXED);
  });
});

describe("land appends one landing under its own authority", () => {
  const L = (n: string) => ({ sha: n.repeat(40), branch: "main", landedAt: "2026-01-01T00:00:00Z" });
  it("appends to a ticket and an issue, keeping every prior landing and receipt", async () => {
    const root = await project({ receipts: MIXED, landings: [L("a")] }, { landings: [L("a")] });
    await appendTicketLanding(root, { id: "T-001", displayId: "T-001", path: join(root, ".story", "tickets", "T-001.json") }, L("b"));
    await appendIssueLanding(root, { id: "ISS-001", displayId: "ISS-001", path: join(root, ".story", "issues", "ISS-001.json") }, L("b"));
    expect(read(root, "tickets/T-001.json")).toMatchObject({ receipts: MIXED, landings: [L("a"), L("b")] });
    expect(read(root, "issues/ISS-001.json").landings).toEqual([L("a"), L("b")]);
  });

  it("refuses a present landings value that is not an array, and writes nothing", async () => {
    const root = await project({ landings: "x" });
    const before = raw(root, "tickets/T-001.json");
    await expect(appendTicketLanding(root, { id: "T-001", displayId: "T-001", path: join(root, ".story", "tickets", "T-001.json") }, L("b"))).rejects.toThrow(/existing landings is not an array/);
    expect(raw(root, "tickets/T-001.json")).toBe(before);
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({ ...ISSUE, landings: "x" }, null, 2) + "\n");
    const issueBefore = raw(root, "issues/ISS-001.json");
    await expect(appendIssueLanding(root, { id: "ISS-001", displayId: "ISS-001", path: join(root, ".story", "issues", "ISS-001.json") }, L("b"))).rejects.toThrow(/existing landings is not an array/);
    expect(raw(root, "issues/ISS-001.json")).toBe(issueBefore);
  });

  it("the landing authority never appends a receipt", async () => {
    const root = await project({ receipts: [A] });
    await expect(withProjectLock(root, { strict: false }, async () => {
      await writeTicketUnlocked({ ...TICKET, receipts: [A, B] } as never, root, { touch: false, receiptsAuthority: LANDING_APPEND_AUTHORITY });
    })).rejects.toThrow(/receipts_immutable/);
  });
});

describe("byte authorisation re-runs the guard against the bytes on disk", () => {
  it("refuses an authorised append when the record changed under it after preparation", async () => {
    const root = await project({ receipts: [A] });
    const file = join(root, ".story", "tickets", "T-001.json");
    await withProjectLock(root, { strict: false }, async () => {
      const prepared = await prepareTicketWrite({ ...TICKET, receipts: [A, B] } as never, root, { receiptsAuthority: RECEIPT_APPEND_AUTHORITY, touch: false });
      // Prepared bytes against an unchanged file are current.
      expect(() => assertPreparedWritesCurrent(root, [prepared])).not.toThrow();
      // A concurrent writer that bypassed the lock appends another receipt.
      const X = receipt({ id: "rc-xxxxxxxxxxxxxxxx".replace(/x/g, "9") });
      writeFileSync(file, JSON.stringify({ ...TICKET, receipts: [A, X] }, null, 2) + "\n");
      expect(() => assertPreparedWritesCurrent(root, [prepared])).toThrow(/receipts_immutable/);
    });
    expect((read(root, "tickets/T-001.json").receipts as Json[]).map((r) => r.id)).toEqual([A.id, "rc-9999999999999999"]);
  });

  it("the transaction refuses prepared bytes when a receipt was appended after preparation, and the receipt survives", async () => {
    const root = await project({ receipts: [A] });
    const file = join(root, ".story", "tickets", "T-001.json");
    const X = receipt({ id: "rc-9999999999999999" });
    await withProjectLock(root, { strict: false }, async () => {
      const prepared = await prepareTicketWrite({ ...TICKET, title: "Renamed", receipts: [A] } as never, root, { touch: false });
      writeFileSync(file, JSON.stringify({ ...TICKET, receipts: [A, X] }, null, 2) + "\n");
      await expect(runTransactionUnlocked(root, [{ op: "write", ...prepared }])).rejects.toThrow(/receipts_immutable/);
    });
    expect(read(root, "tickets/T-001.json")).toMatchObject({ title: "Ticket", receipts: [A, X] });
  });
});

describe("prepared receipt authorities live only as long as their lock", () => {
  it("repeated appends and a failed preparation leave no authority once the lock scope ends", async () => {
    const root = await project({ receipts: [A] });
    const C = receipt({ id: "rc-cccccccccccccccc" });
    let ctx: ReturnType<typeof resolutionWriteContextFor> | undefined;
    await withProjectLock(root, { strict: false }, async () => {
      ctx = resolutionWriteContextFor(root);
      await writeTicketUnlocked({ ...TICKET, receipts: [A, B] } as never, root, { touch: false, receiptsAuthority: RECEIPT_APPEND_AUTHORITY });
      await writeTicketUnlocked({ ...TICKET, receipts: [A, B, C] } as never, root, { touch: false, receiptsAuthority: RECEIPT_APPEND_AUTHORITY });
      const held = ctx.receiptsAuthorities();
      expect(held).toBeGreaterThan(0);
      await expect(prepareTicketWrite({ ...TICKET, receipts: [A] } as never, root, { touch: false, receiptsAuthority: RECEIPT_APPEND_AUTHORITY })).rejects.toThrow(/receipts_immutable/);
      expect(ctx.receiptsAuthorities()).toBe(held);
    });
    expect(ctx!.released).toBe(true);
    expect(ctx!.receiptsAuthorities()).toBe(0);
  });
});

describe("the append path", () => {
  const body = (id: string) => receipt({ id });
  it("appends one receipt with a minted id, keeping every element before it", async () => {
    const root = await project({ receipts: MIXED });
    const added = await appendReceipt(root, { kind: "ticket", id: "T-001" }, body);
    expect(added.id).toMatch(/^rc-[0-9a-hjkmnp-tv-z]{16}$/i);
    expect(read(root, "tickets/T-001.json").receipts).toEqual([...MIXED, added]);
  });

  it("an id already on the record is regenerated, and after three retries refused", async () => {
    const root = await project({}, { receipts: [A, B] });
    const seq: string[] = [A.id as string, B.id as string, "rc-cccccccccccccccc"];
    const added = await appendReceipt(root, { kind: "issue", id: "ISS-001" }, body, { mintId: () => seq.shift()! });
    expect(added.id).toBe("rc-cccccccccccccccc");
    const before = raw(root, "issues/ISS-001.json");
    let calls = 0;
    await expect(appendReceipt(root, { kind: "issue", id: "ISS-001" }, body, { mintId: () => { calls++; return A.id as string; } })).rejects.toThrow(/id_collision/);
    expect(calls).toBe(4);
    expect(raw(root, "issues/ISS-001.json")).toBe(before);
  });

  it("refuses a present receipts value that is not an array, never reading it as empty", async () => {
    const root = await project({ receipts: { not: "an array" } });
    const before = raw(root, "tickets/T-001.json");
    await expect(appendReceipt(root, { kind: "ticket", id: "T-001" }, body)).rejects.toThrow(/receipts_malformed/);
    expect(raw(root, "tickets/T-001.json")).toBe(before);
  });
});

describe("restore never drops a receipt", () => {
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, env: ENV, encoding: "utf-8" });
  const commit = (root: string) => {
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-q", "--no-gpg-sign", "-m", "c"]);
    return git(root, ["rev-parse", "HEAD"]).trim();
  };
  const path = ".story/issues/ISS-001.json";

  it("refuses a restore whose source lacks a current receipt, naming its id, and writes nothing", async () => {
    const root = await project();
    git(root, ["init", "-q", "-b", "main"]);
    const from = commit(root);
    writeFileSync(join(root, path), JSON.stringify({ ...ISSUE, title: "Now", receipts: [A, B] }, null, 2) + "\n");
    const expectOid = commit(root);
    const before = raw(root, "issues/ISS-001.json");
    const err = await restoreRecord(root, { kind: "record", path }, from, expectOid, { capabilityCatalog }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreUnsafe);
    expect((err as RestoreUnsafe).invariant).toBe("restore_would_drop_receipts");
    expect((err as Error).message).toContain(`receipts:${A.id as string}`);
    expect((err as Error).message).toContain(`receipts:${B.id as string}`);
    expect(raw(root, "issues/ISS-001.json")).toBe(before);
  });

  it("restores a field outside the append-only set when every receipt is kept", async () => {
    const root = await project({}, { receipts: [A] });
    git(root, ["init", "-q", "-b", "main"]);
    const from = commit(root);
    writeFileSync(join(root, path), JSON.stringify({ ...ISSUE, title: "Now", receipts: [A] }, null, 2) + "\n");
    const expectOid = commit(root);
    const result = await restoreRecord(root, { kind: "record", path }, from, expectOid, { capabilityCatalog });
    expect(result.outcome).toBe("restored");
    expect(read(root, "issues/ISS-001.json")).toMatchObject({ title: "Issue", receipts: [A] });
  });
});

describe("readers never read a present non-array value as empty", () => {
  it("receiptsNamingBoard refuses a receipts value that is not an array", () => {
    expect(() => receiptsNamingBoard([{ id: "T-001", receipts: { a: 1 } }], BOARD)).toThrow(/not an array/);
    expect(receiptsNamingBoard([{ id: "T-001" }], BOARD)).toEqual([]);
  });
});

describe("each guard site refuses on its own", () => {
  it("preparation refuses before any byte check, for tickets and issues", async () => {
    const root = await project({ receipts: [A] }, { receipts: [A] });
    await withProjectLock(root, { strict: false }, async () => {
      await expect(prepareTicketWrite({ ...TICKET, receipts: [] } as never, root, { touch: false })).rejects.toThrow(/receipts_immutable/);
      await expect(prepareIssueWrite({ ...ISSUE, receipts: [] } as never, root, { touch: false })).rejects.toThrow(/receipts_immutable/);
    });
  });

  it("a receipt the serialiser cannot keep (an own __proto__ key) is refused as unpreservable", async () => {
    const root = await project();
    writeFileSync(join(root, ".story", "tickets", "T-001.json"), `${JSON.stringify(TICKET).slice(0, -1)},"receipts":[{"kind":"test","__proto__":{"x":1}}]}\n`);
    const before = raw(root, "tickets/T-001.json");
    await expect(handleTicketUpdate("T-001", { title: "Renamed" } as never, "json", root)).rejects.toThrow(/receipts_unpreservable/);
    expect(raw(root, "tickets/T-001.json")).toBe(before);
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), `${JSON.stringify(ISSUE).slice(0, -1)},"receipts":[{"kind":"test","__proto__":{"x":1}}]}\n`);
    const issueBefore = raw(root, "issues/ISS-001.json");
    await expect(handleIssueUpdate("ISS-001", { title: "Renamed" } as never, "json", root)).rejects.toThrow(/receipts_unpreservable/);
    expect(raw(root, "issues/ISS-001.json")).toBe(issueBefore);
  });

  it("an issue prior that does not parse and names an append-only field is never overwritten", async () => {
    // The misnamed-file scan refuses an unreadable file it sees first; this
    // is the read that follows it (a file torn between the scan and the read).
    const root = await project({}, { receipts: [A] });
    const file = join(root, ".story", "issues", "ISS-001.json");
    const before = readFileSync(file, "utf-8");
    const read = prepareIssueWriteSeams.readPrior;
    try {
      prepareIssueWriteSeams.readPrior = async () => before.slice(0, before.indexOf("receipts") + 20);
      await expect(withProjectLock(root, { strict: false }, async () => {
        await writeIssueUnlocked(ISSUE as never, root, { touch: false });
      })).rejects.toThrow(/receipts_unpreservable/);
    } finally {
      prepareIssueWriteSeams.readPrior = read;
    }
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("an issue prior that does not parse is never overwritten, even when its receipts key is escaped", async () => {
    const root = await project({}, { receipts: [A] });
    const file = join(root, ".story", "issues", "ISS-001.json");
    const before = readFileSync(file, "utf-8");
    const escaped = before.replace('"receipts"', '"\\u0072eceipts"');
    expect(escaped).not.toContain('"receipts"');
    const torn = escaped.slice(0, -4);
    const read = prepareIssueWriteSeams.readPrior;
    try {
      // The file is torn after the misnamed-file scan and before the read.
      prepareIssueWriteSeams.readPrior = async () => {
        writeFileSync(file, torn);
        return torn;
      };
      await expect(withProjectLock(root, { strict: false }, async () => {
        await writeIssueUnlocked(ISSUE as never, root, { touch: false });
      })).rejects.toThrow(/receipts_unpreservable/);
    } finally {
      prepareIssueWriteSeams.readPrior = read;
    }
    expect(readFileSync(file, "utf-8")).toBe(torn);
  });
});

describe("the merge-resolution authority admits one resolution transition only", () => {
  const writeM = (root: string, receipts: unknown) => withProjectLock(root, { strict: false }, async () => {
    await writeTicketUnlocked({ ...TICKET, receipts } as never, root, { touch: false, receiptsAuthority: MERGE_RESOLUTION_AUTHORITY });
  });
  const A2 = receipt({ id: "rc-aaaaaaaaaaaaaaaa", result: "fail", data: { passed: 1, failed: 1 } });
  /** The real merge over three receipt arrays, stored as the ticket. */
  const merged = (root: string, base: unknown[], ours: unknown[], theirs: unknown[]) => {
    const m = threeWayMerge({ ...TICKET, receipts: base }, { ...TICKET, receipts: ours }, { ...TICKET, receipts: theirs }, "ticket");
    writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify(m.merged, null, 2) + "\n");
  };

  it("refuses a removal, a reorder or an addition when no receipt conflict is cleared, and writes nothing", async () => {
    const C = receipt({ id: "rc-cccccccccccccccc" });
    const root = await project({ receipts: [A, B, C] });
    const before = raw(root, "tickets/T-001.json");
    await expect(writeM(root, [B, A, C])).rejects.toThrow(/receipts_immutable/);
    await expect(writeM(root, [A, B, C, receipt({ id: "rc-dddddddddddddddd" })])).rejects.toThrow(/receipts_immutable/);
    await expect(writeM(root, [A, C])).rejects.toThrow(/receipts_immutable/);
    expect(raw(root, "tickets/T-001.json")).toBe(before);
  });

  it("resolve --receipt removes only the conflict's other body, keeps it in history, and keeps every unrelated receipt", async () => {
    const root = await project();
    merged(root, [B], [B, A], [B, A2]);
    const result = await handleResolve("T-001", root, { receipt: A.id as string, keep: "ours", actor: "tester" });
    expect(result.exitCode ?? 0).toBe(0);
    const t = read(root, "tickets/T-001.json");
    expect(t.receipts).toEqual([B, A]);
    expect(t._conflicts).toBeUndefined();
    const [h] = t.receiptResolutions as Json[];
    expect(h).toMatchObject({ kind: "receipt", conflictId: A.id, keep: "ours", bodies: { ours: [A], theirs: [A2] } });
  });

  it("refuses a resolution that would drop a receipt appended after the resolver read the record, and the receipt survives", async () => {
    const root = await project();
    merged(root, [B], [B, A], [B, A2]);
    const file = join(root, ".story", "tickets", "T-001.json");
    const X = receipt({ id: "rc-9999999999999999" });
    const readPrior = prepareTicketWriteSeams.readPrior;
    try {
      prepareTicketWriteSeams.readPrior = async (path) => {
        // Another writer appends X between the resolver's load and its write.
        const now = JSON.parse(readFileSync(file, "utf-8")) as Json;
        writeFileSync(file, JSON.stringify({ ...now, receipts: [...(now.receipts as Json[]), X] }, null, 2) + "\n");
        return readPrior(path);
      };
      const out = await handleResolve("T-001", root, { receipt: A.id as string, keep: "ours", actor: "tester" }).catch((e: unknown) => e);
      expect(out instanceof Error ? out.message : JSON.stringify(out)).toMatch(/receipts_immutable/);
    } finally {
      prepareTicketWriteSeams.readPrior = readPrior;
    }
    const t = read(root, "tickets/T-001.json");
    expect(t.receipts).toEqual([B, A, A2, X]);
    expect(t.receiptResolutions).toBeUndefined();
  });

  describe("each rule of the transition refuses on its own", () => {
    /** The real resolution of A (keep ours) on base [B], ours [B, A], theirs [B, A2], then tampered. */
    const tampered = async (tamper: (next: Json, entry: Json) => void) => {
      const root = await project();
      merged(root, [B], [B, A], [B, A2]);
      const next = structuredClone(read(root, "tickets/T-001.json"));
      resolveReceiptConflict(next, { receipt: A.id as string, keep: "ours", label: "T-001", actor: "t", now: () => "2026-01-01T00:00:00Z" }, MERGE_RESOLUTION_AUTHORITY);
      const history = next.receiptResolutions as Json[];
      const entry = history[history.length - 1]!;
      tamper(next, entry);
      const { id: _old, ...rest } = entry;
      history[history.length - 1] = { id: resolutionEntryId(rest), ...rest };
      const before = raw(root, "tickets/T-001.json");
      // The lock resolve itself writes under (a record with conflicts blocks every other lock).
      const out = await withConflictResolutionLock(root, async () => {
        await writeTicketUnlocked(next as never, root, { touch: false, receiptsAuthority: MERGE_RESOLUTION_AUTHORITY });
      }).then(() => "written", (e: unknown) => (e as Error).message);
      return { out, unchanged: raw(root, "tickets/T-001.json") === before };
    };

    it("the untampered resolution is written", async () => {
      expect((await tampered(() => undefined)).out).toBe("written");
    });

    it.each([
      ["removes an element the conflict does not name, even one the history keeps", (n: Json, e: Json) => {
        n.receipts = (n.receipts as Json[]).filter((r) => r.id !== B.id);
        (e.bodies as Json).base = [B];
      }],
      ["removes a named body the history does not keep", (_n: Json, e: Json) => {
        (e.bodies as Json).theirs = [];
      }],
      ["removes the kept side's body too", (n: Json) => {
        n.receipts = (n.receipts as Json[]).filter((r) => r.id !== A.id);
      }],
      ["appends a history entry for another conflict", (_n: Json, e: Json) => {
        e.conflictId = B.id;
      }],
    ])("refuses a resolution that %s, and writes nothing", async (_l, tamper) => {
      const { out, unchanged } = await tampered(tamper as (n: Json, e: Json) => void);
      expect(out).toMatch(/receipts_immutable/);
      expect(unchanged).toBe(true);
    });
  });
});
