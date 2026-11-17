/**
 * C-v4.1 commit 5 (pen rulings Q1 and Q4): proofPage on both get tools,
 * `storybloq proof`, and the CLI-only non-code list.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleNonCodeAdd, handleNonCodeList, handleNonCodeRemove, handleProofCommand, nonCodeSeams } from "../../../src/cli/commands/proof.js";
import { recordRevision } from "../../../src/core/record-revision.js";
import { captureTools, cleanupTempDirs, git, headSha, isolateGit, makeProjectRepo } from "../../mcp/board-git-fixtures.js";

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => {
  nonCodeSeams.beforeLock = async () => {};
  cleanupTempDirs();
});

type Json = Record<string, unknown>;
let BOARD = "";

async function provenBoard(): Promise<{ root: string; file: string }> {
  const { root } = await makeProjectRepo();
  const cfgPath = join(root, ".story", "config.json");
  BOARD = String((JSON.parse(readFileSync(cfgPath, "utf8")) as Json).boardId);
  expect(BOARD).toMatch(/^b-/);
  const file = join(root, ".story", "tickets", "T-001.json");
  const rec: Json = { id: "T-001", title: "Ticket", description: "", type: "task", status: "open", phase: "p0", order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null };
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  writeFileSync(join(root, ".story", "tickets", "T-002.json"), JSON.stringify({ ...rec, id: "T-002" }, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ledger");
  writeFileSync(join(root, "code.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "T-001 code");
  const sha = headSha(root);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  rec.receipts = [{
    id: "rc-0000000000000001", v: 1, kind: "device", target: `${BOARD}:T-001`, unitRef: `${BOARD}:T-001`, repo: BOARD, sha,
    revisions: { unit: recordRevision(rec, "ticket") },
    observation: { head: sha, headMatchesSha: true, worktree: { staged: 0, unstaged: 0, untracked: 0, submodule: 0 } },
    attestation: { builtFromSha: sha, builtClean: true }, result: "pass", data: { deviceClass: "real" },
    recordedAt: "2026-11-16T00:00:00Z", recordedBy: "test",
  }];
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  return { root, file };
}

describe("proof on the surfaces (Q1)", () => {
  it("ticket_get carries proof only when proofPage is passed", async () => {
    const { root } = await provenBoard();
    const tools = captureTools(root);
    const without = (JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json" })).text) as { data: Json }).data;
    expect(without).not.toHaveProperty("proof");
    const withProof = (JSON.parse((await tools.call("storybloq_ticket_get", { id: "T-001", format: "json", proofPage: 1 })).text) as { data: Json }).data;
    expect(withProof.proof).toMatchObject({ outcome: "proven", evidenceTotal: 1, verifiedAt: "2026-11-16T00:00:00Z" });
    const md = (await tools.call("storybloq_ticket_get", { id: "T-001", proofPage: 1 })).text;
    expect(md).toContain("Proof: proven, verified 2026-11-16T00:00:00Z");
  });

  it("issue_get takes proofPage too, and an unproven item says why", async () => {
    const { root } = await provenBoard();
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({ id: "ISS-001", title: "I", status: "open", severity: "low", components: [], impact: "x", resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [] }, null, 2) + "\n");
    const r = await captureTools(root).call("storybloq_issue_get", { id: "ISS-001", format: "json", proofPage: 1 });
    expect((JSON.parse(r.text) as { data: Json }).data.proof).toMatchObject({ outcome: "unproven", reason: "no current attempt" });
  });

  it("storybloq proof prints the same view", async () => {
    const { root } = await provenBoard();
    const j = JSON.parse((await handleProofCommand(root, "T-001", undefined, "json")).output) as { data: Json };
    expect(j.data).toMatchObject({ outcome: "proven", unit: `${BOARD}:T-001` });
    expect((await handleProofCommand(root, "T-404", undefined, "md")).output).toContain("Proof: unproven (proof_unresolved");
  });
});

describe("proof non-code add, remove, list (Q4)", () => {
  it("adds by canonical ref with a reason, lists, refuses a repeat, removes", async () => {
    const { root } = await provenBoard();
    const add = await handleNonCodeAdd(root, "T-002", "docs only", false, "json");
    expect(add.exitCode).toBeUndefined();
    const cfg = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf8")) as Json;
    expect(cfg.proof).toEqual({ nonCodeItems: [{ ref: `${BOARD}:T-002`, reason: "docs only" }] });
    expect(handleNonCodeList(root, "md").output).toBe(`- ${BOARD}:T-002: docs only`);
    expect((await handleNonCodeAdd(root, `${BOARD}:T-002`, "again", false, "md")).output).toContain("already_listed");
    await handleNonCodeRemove(root, "T-002", false, "md");
    expect((JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf8")) as Json).proof).toBeUndefined();
    expect((await handleNonCodeRemove(root, "T-002", false, "md")).output).toContain("not_listed");
  });

  it("refuses a missing or long reason, an unknown ref, a deleted one and another board's", async () => {
    const { root } = await provenBoard();
    expect((await handleNonCodeAdd(root, "T-002", undefined, false, "md")).output).toContain("invalid_reason");
    expect((await handleNonCodeAdd(root, "T-002", "x".repeat(201), false, "md")).output).toContain("at most 200 bytes");
    expect((await handleNonCodeAdd(root, "T-404", "r", false, "md")).output).toContain("not a ticket or issue");
    expect((await handleNonCodeAdd(root, "b-zzzzzzzzzzzzzzzz:T-002", "r", false, "md")).output).toContain("not on this board");
    const f = join(root, ".story", "tickets", "T-002.json");
    writeFileSync(f, JSON.stringify({ ...(JSON.parse(readFileSync(f, "utf8")) as Json), deletedAt: "2026-11-16" }, null, 2) + "\n");
    expect((await handleNonCodeAdd(root, "T-002", "r", false, "md")).output).toContain("is deleted");
    expect((JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf8")) as Json).proof).toBeUndefined();
  });

  it("resolves and checks the ref under the lock: a target deleted after invocation is refused (Codex F1)", async () => {
    const { root } = await provenBoard();
    const f = join(root, ".story", "tickets", "T-002.json");
    nonCodeSeams.beforeLock = async () => {
      writeFileSync(f, JSON.stringify({ ...(JSON.parse(readFileSync(f, "utf8")) as Json), deletedAt: "2026-11-16" }, null, 2) + "\n");
    };
    expect((await handleNonCodeAdd(root, "T-002", "docs only", false, "md")).output).toContain("is deleted");
    expect((JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf8")) as Json).proof).toBeUndefined();
  });
});
