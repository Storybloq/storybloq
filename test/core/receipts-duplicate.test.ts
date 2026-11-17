/**
 * C-v4.1 commit 7, ISS-1435 (pen ruling on duplicate receipt ids): a raw
 * duplicate (two or more bodies under one id, with no keep-both resolution
 * recorded) is a duplicate_id contradiction. Every copy is distrusted, proof and
 * landing readiness hold, and the hold names its repair: a later receipt whose
 * supersedes names the id supersedes every copy and lifts it. A keep-both
 * duplicate (receipt resolve --keep both) keeps its shipped behaviour. The
 * merge driver already marks same-id conflicts through _conflicts; this covers
 * a union made without the driver, or by hand.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { landingReady } from "../../src/core/landing-ready.js";
import { duplicateReceiptHolds } from "../../src/core/receipts.js";
import { recordRevision } from "../../src/core/record-revision.js";
import { receiptAddSeams } from "../../src/core/receipt-add.js";
import { captureTools, cleanupTempDirs, git, headSha, isolateGit, makeProjectRepo } from "../mcp/board-git-fixtures.js";

vi.setConfig({ testTimeout: 60_000 });
let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

type Json = Record<string, unknown>;
const DUP = "rc-00000000000000dd";
const OBS = (sha: string) => ({ head: sha, headMatchesSha: true, worktree: { staged: 0, unstaged: 0, untracked: 0, submodule: 0 } });

interface Board { root: string; file: string; rec: Json; board: string; prior: string; head: string }

/** T-001 with a passing real-device receipt, and a passing test and review for prior..head. */
async function board(): Promise<Board> {
  const { root } = await makeProjectRepo();
  const board = String((JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf8")) as Json).boardId);
  const file = join(root, ".story", "tickets", "T-001.json");
  const rec: Json = { id: "T-001", title: "Ticket", description: "", type: "task", status: "open", phase: "p0", order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null };
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ledger");
  const prior = headSha(root);
  writeFileSync(join(root, "code.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "T-001 code");
  const head = headSha(root);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const common = { v: 1, target: `${board}:T-001`, repo: board, sha: head, observation: OBS(head), result: "pass", recordedAt: "2026-11-16T00:00:00Z", recordedBy: "test" };
  rec.receipts = [
    { ...common, id: "rc-0000000000000001", kind: "device", unitRef: `${board}:T-001`, revisions: { unit: recordRevision(rec, "ticket") }, attestation: { builtFromSha: head, builtClean: true }, data: { deviceClass: "real" } },
    { ...common, id: "rc-0000000000000002", kind: "test", revisions: {}, attestation: { builtFromSha: head, builtClean: true }, data: {} },
    { ...common, id: "rc-0000000000000003", kind: "review", base: prior, revisions: {}, data: { verdict: "approve" } },
  ];
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "receipts");
  return { root, file, rec, board, prior, head };
}

/** `copies` bodies under DUP, written by hand (a union made without the merge driver). */
function addRawDuplicate(b: Board, extra: Json = {}, copies = 2): void {
  const rs = b.rec.receipts as Json[];
  const bodies = Array.from({ length: copies }, (_v, i) => ({ ...rs[1]!, id: DUP, recordedBy: `copy-${i}` }));
  b.rec = { ...b.rec, receipts: [...rs, ...bodies], ...extra };
  writeFileSync(b.file, JSON.stringify(b.rec, null, 2) + "\n");
  git(b.root, "add", "-A");
  git(b.root, "commit", "-q", "-m", "union by hand");
}

function addSuperseder(b: Board, id: string, supersedes: string[]): void {
  const rs = b.rec.receipts as Json[];
  b.rec = { ...b.rec, receipts: [...rs, { ...rs[1]!, id, supersedes }] };
  writeFileSync(b.file, JSON.stringify(b.rec, null, 2) + "\n");
  git(b.root, "add", "-A");
  git(b.root, "commit", "-q", "-m", "superseder");
}

const readiness = (b: Board) => landingReady(b.root, "T-001", { base: b.prior, head: b.head });
async function proof(b: Board): Promise<Json> {
  const r = await captureTools(b.root).call("storybloq_ticket_get", { id: "T-001", format: "json", proofPage: 1 });
  return (JSON.parse(r.text) as { data: { proof: Json } }).data.proof;
}

describe("duplicate receipt ids (ISS-1435, pen ruling)", () => {
  it("the board starts proven and ready", async () => {
    const b = await board();
    expect(await proof(b)).toMatchObject({ outcome: "proven" });
    expect(await readiness(b)).toMatchObject({ ready: true });
  });

  it("a raw duplicate is held by proof and by readiness, and the hold names its repair", async () => {
    const b = await board();
    addRawDuplicate(b);
    expect(duplicateReceiptHolds(b.rec)).toEqual([DUP]);
    const p = await proof(b);
    expect(p.outcome).toBe("unproven");
    expect(JSON.stringify(p)).toContain(`duplicate receipt id ${DUP}: add a new receipt that supersedes ${DUP}`);
    const r = await readiness(b);
    expect(r).toMatchObject({ ready: false, duplicates: [DUP] });
    const { formatLandingReady } = await import("../../src/core/landing-ready.js");
    expect(formatLandingReady(r)).toContain(`duplicate receipt id ${DUP}: add a new receipt that supersedes ${DUP}`);
    // Get shows it in the receipts summary, JSON and text.
    const tools = captureTools(b.root);
    const json = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json" })).text) as { data: { receipts: { summary: Json } } };
    expect(json.data.receipts.summary).toMatchObject({ duplicates: [DUP], states: { "conflicted-kept": 2 } });
    expect((await tools.call("storybloq_ticket_get", { id: "T-001" })).text).toContain(`Receipts held: duplicate receipt id ${DUP}: add a new receipt that supersedes ${DUP}`);
  });

  it("the next append still works on a record holding a raw duplicate", async () => {
    const b = await board();
    addRawDuplicate(b);
    const prior = { ...receiptAddSeams };
    receiptAddSeams.mintId = () => "rc-00000000000000ee";
    try {
      const r = await captureTools(b.root).call("storybloq_receipt_add", {
        target: "T-001", kind: "test", sha: b.head, result: "pass", command: "npm test",
        attestation: { builtFromSha: b.head, builtClean: true }, data: { passed: 1, failed: 0 },
      });
      expect(r.isError, r.text).toBe(false);
    } finally { Object.assign(receiptAddSeams, prior); }
    const ids = ((JSON.parse(readFileSync(b.file, "utf8")) as Json).receipts as Json[]).map((x) => x.id);
    expect(ids.filter((i) => i === DUP)).toHaveLength(2);
    expect(ids).toContain("rc-00000000000000ee");
  });

  it("a superseder naming the raw duplicate supersedes every copy and lifts the hold", async () => {
    const b = await board();
    addRawDuplicate(b, {}, 3);
    expect(duplicateReceiptHolds(b.rec)).toEqual([DUP]);
    addSuperseder(b, "rc-00000000000000ff", [DUP]);
    expect(duplicateReceiptHolds(b.rec)).toEqual([]);
    expect(await proof(b)).toMatchObject({ outcome: "proven" });
    expect(await readiness(b)).toMatchObject({ ready: true, duplicates: [] });
    const summary = (JSON.parse((await captureTools(b.root).call("storybloq_ticket_get", { id: "T-001", format: "json" })).text) as { data: { receipts: { summary: Json } } }).data.receipts.summary;
    expect(summary).not.toHaveProperty("duplicates");
  });

  it("keep-both (a recorded resolution) is not held and is superseded as resolve promises", async () => {
    const b = await board();
    addRawDuplicate(b, { receiptResolutions: [{ id: "rr-0000000000000001", kind: "receipt", field: "receipts", conflictId: DUP, keep: "both", bodies: {}, by: "owner", at: "2026-11-16T00:00:00Z" }] });
    expect(duplicateReceiptHolds(b.rec)).toEqual([]);
    expect(await readiness(b)).toMatchObject({ ready: true, duplicates: [] });
    expect(await proof(b)).toMatchObject({ outcome: "proven" });
    addSuperseder(b, "rc-00000000000000ff", [DUP]);
    expect(await readiness(b)).toMatchObject({ ready: true });
  });
});
