/**
 * C-v4.1 commit 6, ISS-1433 (4) with pen ruling Q2: the opt-in completion
 * check on ticket update, from the CLI handler and the MCP tool.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleTicketUpdate } from "../../../src/cli/commands/ticket.js";
import { captureTools, cleanupTempDirs, git, isolateGit, makeProjectRepo } from "../../mcp/board-git-fixtures.js";

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

type Json = Record<string, unknown>;

async function boardWith(gitState: Json | undefined, extra: Json = {}): Promise<{ root: string; board: string }> {
  const { root } = await makeProjectRepo();
  const cfgPath = join(root, ".story", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Json;
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, ...(gitState !== undefined ? { gitState } : {}), ...extra }, null, 2) + "\n");
  const rec: Json = { id: "T-001", title: "Ticket", description: "", type: "task", status: "inprogress", phase: "p0", order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null };
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify(rec, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ledger");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { root, board: String(cfg.boardId) };
}

const status = (root: string): string => (JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf8")) as Json).status as string;
const complete = (root: string, noGitCheck?: boolean) => handleTicketUpdate("T-001", { status: "complete", ...(noGitCheck ? { noGitCheck } : {}) }, "md", root);

describe("the opt-in completion check (ISS-1433 (4), pen ruling Q2)", () => {
  it("is off by default: completing with no commit naming the ticket goes ahead", async () => {
    const { root } = await boardWith(undefined);
    await complete(root);
    expect(status(root)).toBe("complete");
  });

  it("on: refuses at none, naming the escape and the key; --no-git-check completes", async () => {
    const { root } = await boardWith({ requireCommitOnComplete: true });
    await expect(complete(root)).rejects.toThrow(/git_check: no commit names T-001.*--no-git-check.*gitState\.requireCommitOnComplete/s);
    expect(status(root)).toBe("inprogress");
    await complete(root, true);
    expect(status(root)).toBe("complete");
  });

  it("on: a commit naming the ticket (built) lets it complete", async () => {
    const { root } = await boardWith({ requireCommitOnComplete: true });
    writeFileSync(join(root, "code.txt"), "x\n");
    git(root, "add", "code.txt");
    git(root, "commit", "-q", "-m", "T-001 the code");
    await complete(root);
    expect(status(root)).toBe("complete");
  });

  it("on: unknown git facts fail closed with the reason", async () => {
    const { root } = await boardWith({ requireCommitOnComplete: true, maxGraphCommits: 0 });
    await expect(complete(root)).rejects.toThrow(/git_check: git cannot say whether a commit names T-001 \(/);
    expect(status(root)).toBe("inprogress");
  });

  it("on: an item on proof.nonCodeItems is exempt", async () => {
    const { root, board } = await boardWith({ requireCommitOnComplete: true });
    const cfgPath = join(root, ".story", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Json;
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, proof: { nonCodeItems: [{ ref: `${board}:T-001`, reason: "docs" }] } }, null, 2) + "\n");
    await complete(root);
    expect(status(root)).toBe("complete");
  });

  it("only a literal true turns it on", async () => {
    const { root } = await boardWith({ requireCommitOnComplete: "yes" });
    await complete(root);
    expect(status(root)).toBe("complete");
  });

  it("MCP ticket_update refuses the same way and takes noGitCheck", async () => {
    const { root } = await boardWith({ requireCommitOnComplete: true });
    const tools = captureTools(root);
    const refused = await tools.call("storybloq_ticket_update", { id: "T-001", status: "complete" });
    expect(refused.text).toContain("git_check: no commit names T-001");
    expect(status(root)).toBe("inprogress");
    await tools.call("storybloq_ticket_update", { id: "T-001", status: "complete", noGitCheck: true });
    expect(status(root)).toBe("complete");
  });
});
