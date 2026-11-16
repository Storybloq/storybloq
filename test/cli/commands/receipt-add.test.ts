import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import yargs from "yargs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerReceiptCommand } from "../../../src/cli/register.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { join } from "node:path";
import { handleReceiptAddCommand, handleReceiptsCommand } from "../../../src/cli/commands/receipt.js";
import type { CommandContext } from "../../../src/cli/types.js";
import { mintBoardId } from "../../../src/core/board-id.js";
import { formatTicket } from "../../../src/core/output-formatter.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { receiptAddSeams } from "../../../src/core/receipt-add.js";
import { captureTools, cleanupTempDirs, git, headSha, isolateGit, makeFederation, makeProjectRepo, tempDir } from "../../mcp/board-git-fixtures.js";

/** C-v4.1 commit 3: `storybloq receipt add` and `storybloq_receipt_add`, one handler, every 3.1 rule on both clients. */

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

type Json = Record<string, unknown>;
const TICKET: Json = {
  id: "T-001", title: "Ticket", description: "", type: "task", status: "open", phase: "p0", order: 10,
  createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
};

/** A project on main whose config (with its board id) is on origin/main, the default branch. */
async function landed(): Promise<{ root: string; sha: string }> {
  const { root } = await makeProjectRepo();
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify(TICKET, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "t");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { root, sha: headSha(root) };
}

const ticket = (root: string) => JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8")) as Json;
const raw = (root: string) => readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8");
const writeTicket = (root: string, t: Json) => writeFileSync(join(root, ".story", "tickets", `${String(t.id)}.json`), JSON.stringify(t, null, 2) + "\n");
/** Commits the working tree and moves origin/main to it, so the clean-tree observation holds. */
const land = (root: string) => { git(root, "add", "-A"); git(root, "commit", "-q", "-m", "x"); git(root, "update-ref", "refs/remotes/origin/main", "HEAD"); return headSha(root); };

/** One caller input in the MCP shape; the CLI client maps it onto its flags. */
type Input = Json;
const base = (sha: string): Input => ({
  target: "T-001", kind: "test", sha, result: "pass", command: "npm test",
  attestation: { builtFromSha: sha, builtClean: true }, data: { passed: 3, failed: 0 },
});

const seams = { ...receiptAddSeams };
beforeAll(() => {
  receiptAddSeams.mintId = () => "rc-aaaaaaaaaaaaaaaa";
  receiptAddSeams.now = () => "2026-01-01T00:00:00.000Z";
  receiptAddSeams.recordedBy = () => "tester";
});
afterAll(() => Object.assign(receiptAddSeams, seams));
async function withId<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prior = receiptAddSeams.mintId;
  receiptAddSeams.mintId = () => id;
  try { return await fn(); } finally { receiptAddSeams.mintId = prior; }
}

type Reply = { ok: boolean; text: string };
const clients: Record<string, (root: string, input: Input) => Promise<Reply>> = {
  cli: async (root, input) => {
    const { target, attestation, ...rest } = input as Json & { attestation?: { builtFromSha: string; builtClean: boolean } };
    const flags: Json = { ...rest };
    if (attestation) {
      flags.builtFrom = attestation.builtFromSha;
      flags[attestation.builtClean ? "builtClean" : "builtDirty"] = true;
    }
    if (flags.unitRef !== undefined) { flags.unit = flags.unitRef; delete flags.unitRef; }
    if (flags.data !== undefined) flags.data = JSON.stringify(flags.data);
    const r = await handleReceiptAddCommand(root, String(target), flags, "json");
    return { ok: !r.exitCode, text: r.output };
  },
  mcp: async (root, input) => {
    const r = await captureTools(root).call("storybloq_receipt_add", input);
    return { ok: !r.isError, text: r.text };
  },
};
const CLIENTS = Object.keys(clients);

describe.each(CLIENTS)("receipt add through the %s client", (client) => {
  const add = (root: string, input: Input) => clients[client]!(root, input);

  it("appends one complete v1 receipt", async () => {
    const { root, sha } = await landed();
    const r = await add(root, base(sha));
    expect(r.ok, r.text).toBe(true);
    const [rc] = ticket(root).receipts as Json[];
    expect(rc!.repo).toMatch(/^b-[0-9A-Z]{16}$/i);
    const ref = `${rc!.repo as string}:T-001`;
    expect(rc).toMatchObject({ id: "rc-aaaaaaaaaaaaaaaa", v: 1, kind: "test", target: ref, sha, result: "pass", recordedAt: "2026-01-01T00:00:00.000Z", recordedBy: "tester" });
    expect(rc!.observation).toMatchObject({ head: sha, headMatchesSha: true, worktree: { staged: 0, unstaged: 0, untracked: 0, submodule: 0 } });
    // Plan 3.7 and 5.5 read `revisions.unit`: with no unitRef, the unit projection is the target record's.
    expect(Object.keys(rc!.revisions as Json)).toEqual(["unit"]);
    expect((rc!.revisions as Json).unit).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["the landing kind", (s: string) => ({ ...base(s), kind: "landing" }), /landing_refused/],
    ["an unknown result", (s: string) => ({ ...base(s), result: "maybe" }), /result/],
    ["a command over 1,000 bytes", (s: string) => ({ ...base(s), command: "x".repeat(1001) }), /command/],
    ["a command holding a home path", (s: string) => ({ ...base(s), command: "cd /Users/someone && npm test" }), /home path/],
    ["a command holding a private address", (s: string) => ({ ...base(s), command: "curl 10.0.0.1" }), /private IPv4/],
    ["a command holding a socket path", (s: string) => ({ ...base(s), command: "x --sock /tmp/a.sock" }), /socket path/],
    ["an unknown data key", (s: string) => ({ ...base(s), data: { passed: 1, flavour: "x" } }), /data/],
    ["a passing test with failures", (s: string) => ({ ...base(s), data: { passed: 1, failed: 1 } }), /fail/],
    ["an abbreviated sha", (s: string) => ({ ...base(s), sha: s.slice(0, 12), attestation: { builtFromSha: s, builtClean: true } }), /sha/],
    ["a sha that is not a commit here", (s: string) => ({ ...base(s), sha: "f".repeat(40), attestation: { builtFromSha: "f".repeat(40), builtClean: true } }), /sha/],
    ["a test receipt with no attestation", (s: string) => { const { attestation: _a, ...rest } = base(s); return rest; }, /attestation/],
    ["a review whose base is not an ancestor", (s: string) => ({ target: "T-001", kind: "review", sha: s, base: "e".repeat(40), result: "fail", command: "review", data: { verdict: "request_changes" } }), /base/],
    ["an evidence path leaving the repo", (s: string) => ({ ...base(s), evidence: "../outside.txt" }), /evidence/],
    ["an evidence path that is not normalised", (s: string) => ({ ...base(s), evidence: "./a//b.txt" }), /evidence.*normalised/],
    ["evidence over 512 bytes", (s: string) => ({ ...base(s), evidence: "a/".repeat(300) }), /evidence/],
    ["a device unit that does not resolve", (s: string) => ({ ...base(s), kind: "device", unitRef: "T-999", data: { deviceClass: "real" } }), /T-999/],
    ["a supersedes id not on the record", (s: string) => ({ ...base(s), supersedes: ["rc-bbbbbbbbbbbbbbbb"] }), /supersedes_unknown.*rc-bbbbbbbbbbbbbbbb.*not found/],
    ["more than 32 supersedes ids", (s: string) => ({ ...base(s), supersedes: Array.from({ length: 33 }, (_v, i) => `rc-${String(i).padStart(16, "0")}`) }), /supersedes/],
    ["a duplicated supersedes id", (s: string) => ({ ...base(s), supersedes: ["rc-bbbbbbbbbbbbbbbb", "rc-bbbbbbbbbbbbbbbb"] }), /supersedes names rc-bbbbbbbbbbbbbbbb twice/],
  ])("refuses %s and writes nothing", async (_l, make, pattern) => {
    const { root, sha } = await landed();
    const before = raw(root);
    const r = await add(root, make(sha));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(pattern);
    expect(raw(root)).toBe(before);
  });

  it("refuses a supersedes id found with another kind, naming why", async () => {
    const { root, sha } = await landed();
    expect((await add(root, base(sha))).ok).toBe(true);
    const before = raw(root);
    const r = await withId("rc-cccccccccccccccc", () => add(root, { target: "T-001", kind: "mutant", sha, result: "pass", command: "m", data: { applied: 1, killed: 1 }, supersedes: ["rc-aaaaaaaaaaaaaaaa"] }));
    expect(r.text).toMatch(/supersedes_unknown.*rc-aaaaaaaaaaaaaaaa.*kind/);
    expect(raw(root)).toBe(before);
  });

  it("refuses when the default branch does not resolve, by name", async () => {
    const { root } = await makeProjectRepo();
    const r = await add(root, base(headSha(root)));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/default branch/);
  });

  it("refuses when the board id is not on the default branch", async () => {
    const { root, sha } = await landed();
    const cfg = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")) as Json;
    writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ ...cfg, boardId: "b-0000000000000000" }, null, 2) + "\n");
    const r = await add(root, base(sha));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/board_id_/);
  });

  it("finds a supersedes id another writer appended between the caller's read and the lock", async () => {
    const { root, sha } = await landed();
    const mutant = { target: "T-001", kind: "mutant", sha, result: "pass", command: "m", data: { applied: 1, killed: 1 } };
    receiptAddSeams.beforeLock = async () => {
      receiptAddSeams.beforeLock = async () => {};
      expect((await withId("rc-dddddddddddddddd", () => add(root, mutant))).ok).toBe(true);
    };
    try {
      const r = await add(root, { ...mutant, supersedes: ["rc-dddddddddddddddd"] });
      expect(r.ok, r.text).toBe(true);
    } finally { receiptAddSeams.beforeLock = async () => {}; }
    const ids = (ticket(root).receipts as Json[]).map((e) => [e.id, e.supersedes]);
    expect(ids).toEqual([["rc-dddddddddddddddd", undefined], ["rc-aaaaaaaaaaaaaaaa", ["rc-dddddddddddddddd"]]]);
  });

  it("refuses a review whose base is a commit that is not an ancestor", async () => {
    const { root, sha: first } = await landed();
    writeTicket(root, { ...TICKET, id: "T-002", title: "Later" });
    const later = land(root);
    git(root, "checkout", "-q", "-b", "older", first);
    const before = raw(root);
    const r = await add(root, { target: "T-001", kind: "review", sha: first, base: later, result: "fail", command: "review", data: { verdict: "request_changes" } });
    expect(r.text).toMatch(/invalid_base: .*not an ancestor/);
    expect(raw(root)).toBe(before);
  });

  it("refuses a supersedes list naming the id being added", async () => {
    const { root, sha } = await landed();
    const before = raw(root);
    const r = await withId("rc-eeeeeeeeeeeeeeee", () => add(root, { ...base(sha), supersedes: ["rc-eeeeeeeeeeeeeeee"] }));
    expect(r.text).toMatch(/supersedes_unknown: rc-eeeeeeeeeeeeeeee is the id of the receipt being added/);
    expect(raw(root)).toBe(before);
  });

  it("refuses a supersedes id that exists only on a different record", async () => {
    const { root } = await landed();
    writeTicket(root, { ...TICKET, id: "T-002", title: "Other" });
    const sha = land(root);
    expect((await withId("rc-dddddddddddddddd", () => add(root, { ...base(sha), target: "T-002" }))).ok).toBe(true);
    const sha2 = land(root);
    const before = raw(root);
    const r = await add(root, { ...base(sha2), supersedes: ["rc-dddddddddddddddd"] });
    expect(r.text).toMatch(/supersedes_unknown.*rc-dddddddddddddddd.*not found/);
    expect(raw(root)).toBe(before);
  });

  it("names journeys when a unit does not resolve to an item (T-572 not landed)", async () => {
    const { root, sha } = await landed();
    const r = await add(root, { ...base(sha), kind: "device", unitRef: "J-001", data: { deviceClass: "real" } });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/unit_unresolved: J-001.*[Jj]ourney.*T-572/);
  });

  it("records a device receipt's unit and covered children, each with its revision", async () => {
    const { root } = await landed();
    writeTicket(root, { ...TICKET, id: "T-002", title: "Child", parentTicket: "T-001" });
    const sha = land(root);
    const r = await add(root, { ...base(sha), kind: "device", unitRef: "T-001", covers: ["T-002"], data: { deviceClass: "real" } });
    expect(r.ok, r.text).toBe(true);
    const rc = (ticket(root).receipts as Json[])[0]!;
    const repo = rc.repo as string;
    expect(rc).toMatchObject({ unitRef: `${repo}:T-001`, covers: [`${repo}:T-002`] });
    // The unit under the literal key `unit`, each covered child under its canonical ref.
    expect(Object.keys(rc.revisions as Json).sort()).toEqual([`${repo}:T-002`, "unit"].sort());
    expect((rc.revisions as Json).unit).not.toBe((rc.revisions as Json)[`${repo}:T-002`]);
  });

  it("refuses a covered child that does not resolve", async () => {
    const { root, sha } = await landed();
    const before = raw(root);
    const r = await add(root, { ...base(sha), kind: "device", unitRef: "T-001", covers: ["T-404"], data: { deviceClass: "real" } });
    expect(r.text).toMatch(/covers_unresolved: T-404/);
    expect(raw(root)).toBe(before);
  });

  it("refuses an evidence symlink that resolves outside the repo, and accepts one inside", async () => {
    const { root, sha } = await landed();
    const outside = tempDir("outside");
    writeFileSync(join(outside, "e.txt"), "e\n");
    mkdirSync(join(root, "ev"));
    symlinkSync(join(outside, "e.txt"), join(root, "ev", "out.txt"));
    writeFileSync(join(root, "ev", "in.txt"), "e\n");
    symlinkSync(join(root, "ev", "in.txt"), join(root, "ev", "link.txt"));
    const before = raw(root);
    const bad = await add(root, { ...base(sha), evidence: "ev/out.txt" });
    expect(bad.text).toMatch(/evidence.*outside/);
    expect(raw(root)).toBe(before);
    expect((await add(root, { ...base(sha), evidence: "ev/link.txt" })).ok).toBe(true);
  });

  it.each([["an existing file", "e.txt"], ["a missing file", "missing.txt"]])(
    "refuses evidence under a symlinked directory that points outside the repo, for %s", async (_l, leaf) => {
      const { root, sha } = await landed();
      const outside = tempDir("outside");
      writeFileSync(join(outside, "e.txt"), "e\n");
      symlinkSync(outside, join(root, "artifacts"));
      const before = raw(root);
      const r = await add(root, { ...base(sha), evidence: `artifacts/${leaf}` });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/invalid_evidence: evidence artifacts\/.* resolves outside the repository/);
      expect(raw(root)).toBe(before);
    });

  it("accepts a missing evidence file under a directory inside the repo", async () => {
    const { root, sha } = await landed();
    mkdirSync(join(root, "ev"));
    writeFileSync(join(root, "ev", "keep.txt"), "k\n");
    const r = await add(root, { ...base(sha), evidence: "ev/later.txt" });
    expect(r.ok, r.text).toBe(true);
  });

  it("refuses evidence it cannot check (EACCES), never reading the error as absent", async () => {
    const { root, sha } = await landed();
    mkdirSync(join(root, "locked"));
    chmodSync(join(root, "locked"), 0o000);
    try {
      const before = raw(root);
      const r = await add(root, { ...base(sha), evidence: "locked/x.txt" });
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/invalid_evidence: evidence locked\/x\.txt could not be checked \(EACCES\)/);
      expect(raw(root)).toBe(before);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });
});

describe("tool fields and the repo alias", () => {
  it("refuses a tool field by name through both clients", async () => {
    const { root, sha } = await landed();
    const before = raw(root);
    const m = await clients.mcp!(root, { ...base(sha), recordedBy: "me" });
    expect(m.ok).toBe(false);
    expect(m.text).toMatch(/recordedBy/);
    const { addReceipt } = await import("../../../src/core/receipt-add.js");
    await expect(addReceipt(root, { ...base(sha), revisions: {} })).rejects.toThrow(/tool_field: revisions/);
    await expect(addReceipt(root, { ...base(sha), colour: "red" })).rejects.toThrow(/unknown_field: colour/);
    expect(raw(root)).toBe(before);
  });

  it("records the repo a registry alias names, and refuses a covered child outside it", async () => {
    const { orch, node } = await makeFederation();
    const cfg = JSON.parse(readFileSync(join(orch, ".story", "config.json"), "utf-8")) as Json;
    writeFileSync(join(orch, ".story", "config.json"), JSON.stringify({ ...cfg, boardId: mintBoardId() }, null, 2) + "\n");
    writeTicket(orch, TICKET);
    land(orch);
    git(orch, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeTicket(node, { ...TICKET, title: "Node child" });
    const nodeSha = land(node);
    git(node, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const device = { target: "T-001", kind: "device", sha: nodeSha, result: "pass", repo: "api", unitRef: "T-001", attestation: { builtFromSha: nodeSha, builtClean: true }, data: { deviceClass: "real" } };
    const before = raw(orch);
    const other = await clients.mcp!(orch, { ...device, covers: ["T-001"] });
    expect(other.text).toMatch(/covers_other_repo/);
    expect(raw(orch)).toBe(before);
    const ok = await clients.mcp!(orch, { ...device, covers: ["api:T-001"] });
    expect(ok.ok, ok.text).toBe(true);
    const rc = (ticket(orch).receipts as Json[])[0]!;
    const nodeBoard = (JSON.parse(readFileSync(join(node, ".story", "config.json"), "utf-8")) as Json).boardId as string;
    const orchBoard = (JSON.parse(readFileSync(join(orch, ".story", "config.json"), "utf-8")) as Json).boardId as string;
    expect(rc).toMatchObject({ repo: nodeBoard, target: `${orchBoard}:T-001`, unitRef: `${orchBoard}:T-001`, covers: [`${nodeBoard}:T-001`] });
    expect(rc.observation).toMatchObject({ head: nodeSha, headMatchesSha: true });
  });
});

describe("receipts paging (Q6)", () => {
  const ctxOf = async (root: string, format: "md" | "json"): Promise<CommandContext> => {
    const { state, warnings } = await loadProject(root);
    return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format };
  };
  const withReceipts = (n: number): Json => ({
    ...TICKET,
    receipts: Array.from({ length: n }, (_v, i) => ({ id: `rc-${String(i).padStart(16, "0")}`, v: 1, kind: "test", result: "pass" })),
  });

  it("ticket_get carries the summary only without receiptsPage, and one page with it", async () => {
    const { root } = await makeProjectRepo();
    writeTicket(root, withReceipts(21));
    const tools = captureTools(root);
    const plain = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json" })).text) as { data: Json };
    expect(plain.data.receipts).toEqual({ summary: { total: 21, states: { malformed: 21 } } });
    const p2 = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json", receiptsPage: 2 })).text) as { data: { receipts: Json } };
    expect(p2.data.receipts).toMatchObject({ pageNumber: 2, totalPages: 2 });
    expect((p2.data.receipts.page as Json[]).map((e) => e.index)).toEqual([20]);
    const p1 = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json", receiptsPage: 1 })).text) as { data: { receipts: Json } };
    expect((p1.data.receipts.page as Json[]).map((e) => e.index)).toEqual(Array.from({ length: 20 }, (_v, i) => i));
  });

  it.each([[3], [0], [-1], [1.5]])("refuses page %s, naming totalPages", async (page) => {
    const { root } = await makeProjectRepo();
    writeTicket(root, withReceipts(21));
    const r = await captureTools(root).call("storybloq_ticket_get", { id: "T-001", format: "json", receiptsPage: page });
    // Read tools return a user error as an error envelope, not isError (as for a missing ticket).
    expect(r.text).toMatch(/invalid_input/);
    expect(r.text).toMatch(/totalPages 2/);
    expect(r.text).not.toMatch(/"receipts"/);
  });

  it("page 1 of a record with no receipts is empty; page 2 is refused", async () => {
    const { root } = await makeProjectRepo();
    writeTicket(root, TICKET);
    const tools = captureTools(root);
    const p1 = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json", receiptsPage: 1 })).text) as { data: { receipts: Json } };
    expect(p1.data.receipts).toEqual({ summary: { total: 0, states: {} }, page: [], pageNumber: 1, totalPages: 1 });
    const p2 = await tools.call("storybloq_ticket_get", { id: "T-001", format: "json", receiptsPage: 2 });
    expect(p2.text).toMatch(/totalPages 1/);
  });

  it("text output of an item without receipts prints what it printed before receipts existed", async () => {
    const { root } = await makeProjectRepo();
    writeTicket(root, TICKET);
    const { state } = await loadProject(root);
    const expected = formatTicket(state.ticketByID("T-001")!, state, "md");
    const r = await captureTools(root).call("storybloq_ticket_get", { id: "T-001" });
    expect(r.text).toBe(expected);
    expect(r.text).not.toMatch(/Receipts/);
  });

  it("text output of an item with receipts adds the receipts line", async () => {
    const { root } = await makeProjectRepo();
    writeTicket(root, withReceipts(2));
    const r = await captureTools(root).call("storybloq_ticket_get", { id: "T-001" });
    expect(r.text).toMatch(/\nReceipts: 2 \(malformed 2\)$/);
  });

  it("issue_get carries the same receipts view", async () => {
    const { root } = await makeProjectRepo();
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: "I", status: "open", severity: "low", components: [], impact: "x", resolution: null,
      location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [], order: 10, phase: null,
      receipts: withReceipts(1).receipts,
    }, null, 2) + "\n");
    const r = JSON.parse((await captureTools(root).call("storybloq_issue_get", { id: "ISS-001", format: "json", receiptsPage: 1 })).text) as { data: { receipts: Json } };
    expect(r.data.receipts).toMatchObject({ summary: { total: 1 }, pageNumber: 1, totalPages: 1 });
  });

  it("storybloq receipts <id> --page pages the same way", async () => {
    const { root } = await makeProjectRepo();
    writeTicket(root, withReceipts(21));
    const ok = handleReceiptsCommand("T-001", 2, await ctxOf(root, "json"));
    expect((JSON.parse(ok.output) as { data: { entries: Json[] } }).data.entries.map((e) => e.index)).toEqual([20]);
    const bad = handleReceiptsCommand("T-001", 3, await ctxOf(root, "md"));
    expect(bad.exitCode).toBeTruthy();
    expect(bad.output).toMatch(/totalPages 2/);
  });
});

describe("one handler", () => {
  it("storybloq_receipt_add and `receipt add` both call handleReceiptAdd from commands/receipt.ts", () => {
    const src = (p: string) => readFileSync(join(__dirname, "..", "..", "..", "src", p), "utf-8");
    const tools = src("mcp/tools.ts");
    expect(tools).toMatch(/import \{ handleReceiptAdd \} from "\.\.\/cli\/commands\/receipt\.js";/);
    const reg = tools.slice(tools.indexOf('registerWriteTool(server, "storybloq_receipt_add"'));
    expect(reg.slice(0, reg.indexOf("\n\n"))).toMatch(/=> handleReceiptAdd\(root, args as Record<string, unknown>, format\)\)\);$/);
    const cli = src("cli/commands/receipt.ts");
    const command = cli.slice(cli.indexOf("export async function handleReceiptAddCommand"));
    expect(command.slice(0, command.indexOf("\n}\n"))).toMatch(/return handleReceiptAdd\(root, input, format\);$/);
    expect(cli.match(/addReceipt\(/g)).toHaveLength(1);
  });
});

describe("both clients store the same record", () => {
  it("the CLI and MCP write byte-identical receipts for the same input", async () => {
    const a = await landed();
    const b = await landed();
    expect((await clients.cli!(a.root, base(a.sha))).ok).toBe(true);
    expect((await clients.mcp!(b.root, base(b.sha))).ok).toBe(true);
    const ra = (ticket(a.root).receipts as Json[])[0]!;
    const rb = (ticket(b.root).receipts as Json[])[0]!;
    const norm = (r: Json, sha: string, repo: unknown) => JSON.stringify(r).split(sha).join("SHA").split(String(repo)).join("REPO");
    expect(norm(ra, a.sha, ra.repo)).toBe(norm(rb, b.sha, rb.repo));
  });
});

// --- Commit 3 review fixups (pen verdict, Codex session 01a1d19f) ---------------------------------------

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8")) as Json;
const boardOf = (root: string) => readJson(join(root, ".story", "config.json")).boardId as string;
const setBoard = (root: string, boardId: string) => {
  const p = join(root, ".story", "config.json");
  writeFileSync(p, JSON.stringify({ ...readJson(p), boardId }, null, 2) + "\n");
};

/** An orchestrator (own board, T-001) and node `api` (T-001), each landed on origin/main; the node has a commit the orchestrator lacks. */
async function federation(): Promise<{ orch: string; node: string; orchSha: string; nodeSha: string }> {
  const { orch, node } = await makeFederation();
  setBoard(orch, mintBoardId());
  writeTicket(orch, TICKET);
  const orchSha = land(orch);
  git(orch, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  writeTicket(node, { ...TICKET, title: "Node child" });
  const nodeSha = land(node);
  git(node, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { orch, node, orchSha, nodeSha };
}

/** Registers a second node alias `web` at a board carrying `boardId` (a copied .story/). */
function registerCopy(orch: string, boardId: string): string {
  const web = tempDir("web");
  git(web, "init", "-q", "-b", "main");
  mkdirSync(join(web, ".story"), { recursive: true });
  writeFileSync(join(web, ".story", "config.json"), JSON.stringify({ version: 2, schemaVersion: 2, project: "web", type: "project", language: "typescript", boardId }, null, 2) + "\n");
  const p = join(orch, ".story", "config.json");
  const cfg = readJson(p);
  const nodes = cfg.nodes as Json;
  writeFileSync(p, JSON.stringify({ ...cfg, nodes: { ...nodes, web: { ...(nodes.api as Json), path: web } } }, null, 2) + "\n");
  land(orch);
  return web;
}

/** `storybloq receipt add` through the registered yargs command, in process, on the board STORYBLOQ_PROJECT_ROOT names. */
async function registeredCli(root: string, args: string[]): Promise<Reply> {
  const output: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { output.push(String(s)); return true; }) as never);
  vi.stubEnv("STORYBLOQ_PROJECT_ROOT", root);
  const prior = process.exitCode;
  process.exitCode = 0;
  try {
    await registerReceiptCommand(yargs().exitProcess(false)).parseAsync(["receipt", "add", ...args, "--format", "json"]);
    return { ok: (process.exitCode ?? 0) === 0, text: output.join("") };
  } finally {
    process.exitCode = prior;
    out.mockRestore();
    vi.unstubAllEnvs();
  }
}

describe("--repo through the registered CLI (fixup 1)", () => {
  const deviceArgs = (sha: string) => ["T-001", "--kind", "device", "--sha", sha, "--result", "pass", "--unit", "T-001", "--covers", "api:T-001", "--built-from", sha, "--built-clean", "--data", '{"deviceClass":"real"}'];

  it("records a sha the cwd repo does not have against the alias's repo; the CLI and MCP store the same receipt", async () => {
    const a = await federation();
    expect(() => git(a.orch, "cat-file", "-e", a.nodeSha), "the orchestrator repo must lack the node commit").toThrow();
    const cli = await registeredCli(a.orch, [...deviceArgs(a.nodeSha), "--repo", "api"]);
    expect(cli.ok, cli.text).toBe(true);
    const b = await federation();
    const mcp = await clients.mcp!(b.orch, { target: "T-001", kind: "device", sha: b.nodeSha, result: "pass", repo: "api", unitRef: "T-001", covers: ["api:T-001"], attestation: { builtFromSha: b.nodeSha, builtClean: true }, data: { deviceClass: "real" } });
    expect(mcp.ok, mcp.text).toBe(true);
    const ra = (ticket(a.orch).receipts as Json[])[0]!;
    const rb = (ticket(b.orch).receipts as Json[])[0]!;
    expect(ra.repo).toBe(boardOf(a.node));
    expect(ra.observation).toMatchObject({ head: a.nodeSha, headMatchesSha: true });
    const norm = (r: Json, f: { orch: string; node: string; nodeSha: string }) =>
      JSON.stringify(r).split(f.nodeSha).join("SHA").split(boardOf(f.node)).join("NODE").split(boardOf(f.orch)).join("ORCH");
    expect(norm(ra, a)).toBe(norm(rb, b));
  });

  it("refuses an unknown alias on both clients and writes nothing", async () => {
    const f = await federation();
    const before = raw(f.orch);
    const cli = await registeredCli(f.orch, [...deviceArgs(f.nodeSha), "--repo", "nope"]);
    expect(cli.ok).toBe(false);
    expect(cli.text).toMatch(/repo_unresolved: nope/);
    const mcp = await clients.mcp!(f.orch, { target: "T-001", kind: "device", sha: f.nodeSha, result: "pass", repo: "nope", unitRef: "T-001", attestation: { builtFromSha: f.nodeSha, builtClean: true }, data: { deviceClass: "real" } });
    expect(mcp.ok).toBe(false);
    expect(mcp.text).toMatch(/repo_unresolved: nope/);
    expect(raw(f.orch)).toBe(before);
  });
});

describe.each(CLIENTS)("duplicate board ids are refused (fixup 6, %s)", (client) => {
  const add = (root: string, input: Input) => clients[client]!(root, input);

  it("this board's own id carried by a registered node", async () => {
    const f = await federation();
    setBoard(f.node, boardOf(f.orch));
    const before = raw(f.orch);
    const r = await add(f.orch, base(f.orchSha));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(new RegExp(`board_id_duplicate: this board names board ${boardOf(f.orch)}, which .* and .* both carry`));
    expect(r.text).toContain(f.node);
    expect(raw(f.orch)).toBe(before);
  });

  it("an alias in a unit ref whose id another registered board carries", async () => {
    const f = await federation();
    const web = registerCopy(f.orch, boardOf(f.node));
    const sha = headSha(f.orch);
    const before = raw(f.orch);
    const r = await add(f.orch, { ...base(sha), kind: "device", unitRef: "api:T-001", data: { deviceClass: "real" } });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/board_id_duplicate: unit api:T-001/);
    expect(r.text).toContain(web);
    expect(raw(f.orch)).toBe(before);
  });

  it("the --repo alias whose id another registered board carries", async () => {
    const f = await federation();
    const web = registerCopy(f.orch, boardOf(f.node));
    const before = raw(f.orch);
    const r = await add(f.orch, { target: "T-001", kind: "device", sha: f.nodeSha, result: "pass", repo: "api", unitRef: "T-001", attestation: { builtFromSha: f.nodeSha, builtClean: true }, data: { deviceClass: "real" } });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/board_id_duplicate: repo api/);
    expect(r.text).toContain(web);
    expect(raw(f.orch)).toBe(before);
  });
});

describe("identities are re-read under the lock (fixup 7)", () => {
  it("a board id that changes between the caller's reads and the lock is refused and nothing is appended", async () => {
    const { root, sha } = await landed();
    const prior = receiptAddSeams.beforeLock;
    receiptAddSeams.beforeLock = async () => { setBoard(root, mintBoardId()); land(root); };
    try {
      const r = await clients.mcp!(root, base(sha));
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/board_id_changed/);
      expect(ticket(root).receipts).toBeUndefined();
    } finally {
      receiptAddSeams.beforeLock = prior;
    }
  });
});

describe("attestation is strict through the real MCP schema (fixup 9)", () => {
  it("an extra attestation key is refused and nothing is written", async () => {
    const { root, sha } = await landed();
    const server = new McpServer({ name: "storybloq", version: "0.0.0" });
    registerAllTools(server, root);
    const client = new Client({ name: "receipt-test", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const before = raw(root);
      const r = await client.callTool({ name: "storybloq_receipt_add", arguments: { ...base(sha), attestation: { builtFromSha: sha, builtClean: true, signedBy: "x" } } })
        .then((x) => ({ isError: x.isError === true, text: JSON.stringify(x.content) }), (e: unknown) => ({ isError: true, text: String(e) }));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/signedBy|[Uu]nrecognized/);
      expect(raw(root)).toBe(before);
      const ok = await client.callTool({ name: "storybloq_receipt_add", arguments: base(sha) });
      expect(ok.isError, JSON.stringify(ok.content)).not.toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("legacy records keep main's get JSON (fixups 2 and 3)", () => {
  it("a ticket with no receipts field, read without receiptsPage, has no receipts key and equals main's output", async () => {
    const { root } = await makeProjectRepo();
    writeTicket(root, TICKET);
    const { state } = await loadProject(root);
    const expected = formatTicket(state.ticketByID("T-001")!, state, "json");
    const r = await captureTools(root).call("storybloq_ticket_get", { id: "T-001", format: "json" });
    expect(r.text).toBe(expected);
    expect((JSON.parse(r.text) as { data: Json }).data).not.toHaveProperty("receipts");
  });

  it("an issue with no receipts field, read without receiptsPage, has no receipts key and equals main's output", async () => {
    const { root } = await makeProjectRepo();
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: "I", status: "open", severity: "low", components: [], impact: "x", resolution: null,
      location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [], order: 10, phase: null,
    }, null, 2) + "\n");
    const { state } = await loadProject(root);
    const { formatIssue } = await import("../../../src/core/output-formatter.js");
    const expected = formatIssue(state.issueByID("ISS-001")!, "json", state);
    const r = await captureTools(root).call("storybloq_issue_get", { id: "ISS-001", format: "json" });
    expect(r.text).toBe(expected);
    expect((JSON.parse(r.text) as { data: Json }).data).not.toHaveProperty("receipts");
  });

  it("an empty receipts field, or a receiptsPage on a legacy record, still carries the key", async () => {
    const { root } = await makeProjectRepo();
    writeTicket(root, { ...TICKET, receipts: [] });
    writeTicket(root, { ...TICKET, id: "T-002" });
    const tools = captureTools(root);
    const empty = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json" })).text) as { data: Json };
    expect(empty.data.receipts).toEqual({ summary: { total: 0, states: {} } });
    const asked = JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-002", format: "json", receiptsPage: 1 })).text) as { data: Json };
    expect(asked.data.receipts).toMatchObject({ pageNumber: 1, totalPages: 1 });
  });
});
